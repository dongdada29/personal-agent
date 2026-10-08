import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type WorkspaceErrorCode = 'WORKSPACE_INVALID' | 'BASELINE_INVALID' | 'WORKTREE_CONFLICT' | 'PATCH_UNSUPPORTED' | 'PATCH_TOO_LARGE';

/** Diagnostics never include Git output, repository configuration or environment. */
export class WorkspaceError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export interface WorkspaceInspection { path: string; headSha: string }
export interface TaskWorktree { worktreePath: string; branch: string; baselineSha: string; reused: boolean }
export interface CreateTaskWorktreeOptions { workspacePath: string; baselineSha: string; taskId: string; dataDir: string }
interface WorktreeOwnership { version: 1; taskId: string; workspacePath: string; worktreePath: string; baselineSha: string; branch: string; commonDir: string }

const SHA = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;
const MAX_PATCH_BYTES = 1024 * 1024;
const outputPath = (value: string) => value.endsWith('\n') ? value.slice(0, -1) : value;

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(GIT_|LD_|DYLD_|NODE_OPTIONS$)|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH|COOKIE|SESSION|PRIVATE_?KEY/i.test(key)) delete env[key];
  }
  // Clearing inherited GIT_* alone lets Git fall back to the user's global
  // configuration. Runtime inspection and patch output must use a predictable
  // configuration without ambient hooks, signing, filters or diff overrides.
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

/** Every Git invocation uses an argument array and bounded output, with external diff disabled by callers. */
async function git(cwd: string, args: string[], options: { limit?: number; allowDifference?: boolean; hooksPath?: string } = {}): Promise<string> {
  const limit = options.limit ?? MAX_PATCH_BYTES;
  return new Promise((done, reject) => {
    const child = spawn('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=true', '-c', 'color.ui=false',
      ...(options.hooksPath ? ['-c', `core.hooksPath=${options.hooksPath}`] : []), ...args],
    { cwd, env: gitEnvironment(), shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { overflow = true; child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new WorkspaceError('WORKSPACE_INVALID', 'Git operation could not be started.'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (overflow) reject(new WorkspaceError('PATCH_TOO_LARGE', 'Git output exceeds the bounded patch limit.'));
      else if (code !== 0 && !(options.allowDifference && code === 1)) reject(new WorkspaceError('WORKSPACE_INVALID', 'Git operation did not complete successfully.'));
      else {
        try { done(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { reject(new WorkspaceError('PATCH_UNSUPPORTED', 'Git output contains bytes that cannot be represented as a UTF-8 textual patch.')); }
      }
    });
  });
}

function validatePath(path: string): void {
  if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) {
    throw new WorkspaceError('WORKSPACE_INVALID', 'An absolute Git repository root path is required.');
  }
}

async function canonical(path: string): Promise<string> {
  validatePath(path);
  try { return await realpath(path); }
  catch { throw new WorkspaceError('WORKSPACE_INVALID', 'The workspace path does not exist or cannot be read.'); }
}

export async function inspectWorkspace(path: string): Promise<WorkspaceInspection> {
  const root = await canonical(path);
  if ((await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') {
    throw new WorkspaceError('WORKSPACE_INVALID', 'The workspace must be a non-bare Git repository.');
  }
  const topLevel = await canonical(outputPath(await git(root, ['rev-parse', '--show-toplevel'])));
  if (topLevel !== root) throw new WorkspaceError('WORKSPACE_INVALID', 'Register the Git repository root, rather than a subdirectory.');
  const headSha = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (!SHA.test(headSha)) throw new WorkspaceError('WORKSPACE_INVALID', 'The workspace requires an existing HEAD commit.');
  return { path: root, headSha };
}

async function verifyBaseline(root: string, baselineSha: string): Promise<string> {
  if (!SHA.test(baselineSha)) throw new WorkspaceError('BASELINE_INVALID', 'The task baseline must be a complete commit SHA.');
  try {
    const resolved = (await git(root, ['rev-parse', '--verify', `${baselineSha}^{commit}`])).trim();
    if (resolved.toLowerCase() !== baselineSha.toLowerCase()) throw new Error('not exact');
    return resolved;
  } catch { throw new WorkspaceError('BASELINE_INVALID', 'The recorded baseline commit is unavailable in this workspace.'); }
}

async function commonGitDir(root: string): Promise<string> {
  return canonical(resolve(root, outputPath(await git(root, ['rev-parse', '--git-common-dir']))));
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new WorkspaceError('WORKTREE_CONFLICT', 'Task worktree ownership cannot be inspected.');
  }
}

async function ownedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  if (await realpath(path) !== path) throw new WorkspaceError('WORKTREE_CONFLICT', 'Task directories must not redirect through symbolic links.');
}

async function prospectiveDirectory(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) {
      throw new WorkspaceError('WORKTREE_CONFLICT', 'The task data directory cannot be resolved safely.');
    }
    return join(await prospectiveDirectory(dirname(path)), basename(path));
  }
}

function assertOutsideHost(source: string, dataDir: string): void {
  const withinSource = relative(source, dataDir);
  if (withinSource === '' || (withinSource !== '..' && !withinSource.startsWith(`..${sep}`) && !isAbsolute(withinSource))) {
    throw new WorkspaceError('WORKTREE_CONFLICT', 'Task data directories must be outside the registered host repository.');
  }
}

export async function createTaskWorktree(options: CreateTaskWorktreeOptions): Promise<TaskWorktree> {
  const { workspacePath, taskId } = options;
  if (!/^[a-zA-Z\d_-]{1,80}$/.test(taskId)) throw new WorkspaceError('WORKTREE_CONFLICT', 'The task ID is not safe for a worktree directory or branch.');
  const source = await inspectWorkspace(workspacePath);
  const baselineSha = await verifyBaseline(source.path, options.baselineSha);
  validatePath(options.dataDir);
  assertOutsideHost(source.path, await prospectiveDirectory(resolve(options.dataDir)));
  await mkdir(options.dataDir, { recursive: true });
  const dataDir = await realpath(options.dataDir);
  assertOutsideHost(source.path, dataDir);
  const tasksDir = join(dataDir, 'tasks');
  await ownedDirectory(tasksDir);
  const taskDir = join(tasksDir, taskId);
  await ownedDirectory(taskDir);
  const worktreePath = join(taskDir, 'workspace');
  const branch = `personal-agent/task-${taskId}`;
  const markerPath = join(taskDir, '.personal-agent-worktree.json');
  const lockPath = join(taskDir, '.personal-agent-worktree.lock');
  const ownership: WorktreeOwnership = { version: 1, taskId, workspacePath: source.path, worktreePath, baselineSha, branch, commonDir: await commonGitDir(source.path) };
  try { await writeFile(lockPath, '', { flag: 'wx', mode: 0o600 }); }
  catch { throw new WorkspaceError('WORKTREE_CONFLICT', 'This task worktree is already being prepared or requires ownership inspection.'); }
  try {
    if (await exists(markerPath)) {
      let stored: WorktreeOwnership;
      try {
        const marker = await lstat(markerPath);
        if (!marker.isFile() || marker.size > 8192) throw new Error('invalid marker');
        stored = JSON.parse(await readFile(markerPath, 'utf8')) as WorktreeOwnership;
      } catch { throw new WorkspaceError('WORKTREE_CONFLICT', 'The saved task worktree ownership record is invalid.'); }
      for (const key of Object.keys(ownership) as Array<keyof WorktreeOwnership>) {
        if (stored[key] !== ownership[key]) throw new WorkspaceError('WORKTREE_CONFLICT', 'The task worktree belongs to a different task, repository or baseline.');
      }
      const current = await inspectWorkspace(worktreePath);
      const actualBranch = (await git(current.path, ['branch', '--show-current'])).trim();
      if (current.path !== worktreePath || current.headSha !== baselineSha || actualBranch !== branch || await commonGitDir(current.path) !== ownership.commonDir) {
        throw new WorkspaceError('WORKTREE_CONFLICT', 'The task worktree path, branch or baseline has changed; automatic reuse is unsafe.');
      }
      const registered = (await git(source.path, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0').some((record) => {
        const fields = record.split('\0');
        return fields.includes(`worktree ${worktreePath}`) && fields.includes(`branch refs/heads/${branch}`) && fields.includes(`HEAD ${baselineSha}`);
      });
      if (!registered) throw new WorkspaceError('WORKTREE_CONFLICT', 'Git no longer registers this task worktree with its recorded owner.');
      return { worktreePath, baselineSha, branch, reused: true };
    }
    if (await exists(worktreePath)) throw new WorkspaceError('WORKTREE_CONFLICT', 'An unowned task worktree directory already exists.');
    const hooksPath = join(taskDir, '.empty-git-hooks');
    await ownedDirectory(hooksPath);
    if ((await readdir(hooksPath)).length) throw new WorkspaceError('WORKTREE_CONFLICT', 'The task Git hooks directory is not empty.');
    try {
      await git(source.path, ['worktree', 'add', '-b', branch, '--', worktreePath, baselineSha], { hooksPath });
    } catch { throw new WorkspaceError('WORKTREE_CONFLICT', 'A task worktree could not be created; existing branches and directories have been retained.'); }
    await writeFile(markerPath, JSON.stringify(ownership), { flag: 'wx', mode: 0o600 });
    return { worktreePath, baselineSha, branch, reused: false };
  } finally { await unlink(lockPath); }
}

/** Includes baseline-to-worktree tracked changes and every non-ignored new file, without changing the Git index. */
export async function collectTaskPatch(options: { worktreePath: string; baselineSha: string; maxBytes?: number }): Promise<string> {
  const { path: root } = await inspectWorkspace(options.worktreePath);
  const baseline = await verifyBaseline(root, options.baselineSha);
  const maxBytes = options.maxBytes ?? MAX_PATCH_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * MAX_PATCH_BYTES) throw new WorkspaceError('PATCH_TOO_LARGE', 'The patch byte limit must be between 1 byte and 16 MiB.');
  const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-renames'];
  const stat = await git(root, ['diff', ...diffOptions, '--numstat', '-z', baseline, '--'], { limit: maxBytes });
  if (stat.split('\0').some((record) => record.startsWith('-\t-\t'))) throw new WorkspaceError('PATCH_UNSUPPORTED', 'Binary changes cannot be represented as a textual task patch.');
  const patches = [await git(root, ['diff', ...diffOptions, baseline, '--'], { limit: maxBytes })];
  if (patches[0].includes('\0')) throw new WorkspaceError('PATCH_UNSUPPORTED', 'Binary changes cannot be represented as a textual task patch.');
  let size = Buffer.byteLength(patches[0]);
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], { limit: maxBytes })).split('\0').filter(Boolean);
  for (const file of untracked) {
    const metadata = await lstat(join(root, file));
    if (!metadata.isFile() && !metadata.isSymbolicLink()) throw new WorkspaceError('PATCH_UNSUPPORTED', 'An untracked directory or special file cannot be represented as a task patch.');
    const patch = await git(root, ['diff', '--no-index', ...diffOptions, '--', '/dev/null', file], { limit: maxBytes - size, allowDifference: true });
    if (patch.includes('\0') || /^Binary files .* differ$/m.test(patch)) throw new WorkspaceError('PATCH_UNSUPPORTED', 'Binary new files cannot be represented as a textual task patch.');
    size += Buffer.byteLength(patch);
    if (size > maxBytes) throw new WorkspaceError('PATCH_TOO_LARGE', 'The task patch exceeds its byte limit.');
    patches.push(patch);
  }
  return patches.join('');
}
