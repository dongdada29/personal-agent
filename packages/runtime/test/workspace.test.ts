import { execFile, type SpawnOptions } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectTaskPatch, createTaskWorktree, inspectWorkspace } from '../src/workspace.js';

// Simulate default user/system configuration discovery without editing HOME or
// the host's Git files. Explicit child configuration takes precedence.
const ambient = vi.hoisted(() => ({ globalPath: undefined as string | undefined,
  systemPath: undefined as string | undefined, childEnvironments: [] as NodeJS.ProcessEnv[] }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn(command: string, args: string[], options: SpawnOptions) {
    if (command !== 'git' || !ambient.globalPath) return actual.spawn(command, args, options);
    const env = { ...options.env };
    ambient.childEnvironments.push(env);
    env.GIT_CONFIG_GLOBAL ??= ambient.globalPath;
    env.GIT_CONFIG_SYSTEM ??= ambient.systemPath;
    return actual.spawn(command, args, { ...options, env });
  } };
});

const execute = promisify(execFile);
let directory: string;
let source: string;
let dataDir: string;
let baselineSha: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return stdout;
}

async function prepare(taskId = 'fixture-task') {
  return createTaskWorktree({ workspacePath: source, baselineSha, taskId, dataDir });
}

beforeEach(async () => {
  ambient.globalPath = undefined; ambient.systemPath = undefined; ambient.childEnvironments = [];
  directory = await realpath(await mkdtemp(join(tmpdir(), 'personal-agent-workspace-test-')));
  source = join(directory, 'source');
  dataDir = join(directory, 'data');
  await mkdir(join(source, 'src'), { recursive: true });
  await git(source, 'init', '-q');
  await writeFile(join(source, 'src/greet.txt'), 'Hello, baseline\n');
  await writeFile(join(source, '.gitignore'), '*.ignored\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-qm', 'Fixture baseline');
  baselineSha = (await git(source, 'rev-parse', 'HEAD')).trim();
});

afterEach(async () => {
  ambient.globalPath = undefined; ambient.systemPath = undefined; ambient.childEnvironments = [];
  await rm(directory, { recursive: true, force: true });
});

describe('registered Git workspaces and task worktrees', () => {
  it('inspects the actual repository root and an existing commit', async () => {
    expect(await inspectWorkspace(source)).toEqual({ path: source, headSha: baselineSha });
    await expect(inspectWorkspace(join(source, 'src'))).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });
    await expect(inspectWorkspace('relative')).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });
    await expect(inspectWorkspace(join(directory, 'missing'))).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });
  });

  it('canonicalizes a symlink alias to the actual registered root', async () => {
    const alias = join(directory, 'alias');
    await symlink(source, alias, 'dir');
    expect((await inspectWorkspace(alias)).path).toBe(source);
  });

  it('rejects a bare repository and one with no HEAD commit', async () => {
    const bare = join(directory, 'bare');
    const unborn = join(directory, 'unborn');
    await mkdir(bare); await mkdir(unborn);
    await git(bare, 'init', '--bare', '-q');
    await git(unborn, 'init', '-q');
    await expect(inspectWorkspace(bare)).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });
    await expect(inspectWorkspace(unborn)).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });
  });

  it('creates a dedicated branch from the pinned baseline while preserving host WIP', async () => {
    await writeFile(join(source, 'src/greet.txt'), 'HOST WIP\n');
    await writeFile(join(source, 'host-only.txt'), 'HOST UNTRACKED\n');
    const hostStatus = await git(source, 'status', '--porcelain');
    const result = await prepare();
    expect(result).toEqual({ worktreePath: join(dataDir, 'tasks', 'fixture-task', 'workspace'), branch: 'personal-agent/task-fixture-task', baselineSha, reused: false });
    expect(await readFile(join(result.worktreePath, 'src/greet.txt'), 'utf8')).toBe('Hello, baseline\n');
    expect((await git(result.worktreePath, 'branch', '--show-current')).trim()).toBe(result.branch);
    expect(await git(source, 'status', '--porcelain')).toBe(hostStatus);
    expect(await readFile(join(source, 'src/greet.txt'), 'utf8')).toBe('HOST WIP\n');
  });

  it('uses the exact recorded commit even when the host branch has advanced', async () => {
    await writeFile(join(source, 'src/greet.txt'), 'Later host commit\n');
    await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'Later fixture commit');
    const result = await prepare();
    expect((await inspectWorkspace(result.worktreePath)).headSha).toBe(baselineSha);
    expect(await readFile(join(result.worktreePath, 'src/greet.txt'), 'utf8')).toBe('Hello, baseline\n');
  });

  it('reuses only the recorded owned worktree and retains previous attempt modifications', async () => {
    const first = await prepare();
    await writeFile(join(first.worktreePath, 'src/greet.txt'), 'Previous attempt\n');
    await writeFile(join(first.worktreePath, 'new.txt'), 'Previous new file\n');
    expect(await prepare()).toEqual({ ...first, reused: true });
    expect(await readFile(join(first.worktreePath, 'new.txt'), 'utf8')).toBe('Previous new file\n');
  });

  it('rejects traversal task IDs, symbolic task directories and invalid baselines', async () => {
    await expect(prepare('../escape')).rejects.toMatchObject({ code: 'WORKTREE_CONFLICT' });
    await expect(createTaskWorktree({ workspacePath: source, baselineSha: 'HEAD', taskId: 'ref', dataDir })).rejects.toMatchObject({ code: 'BASELINE_INVALID' });
    await expect(createTaskWorktree({ workspacePath: source, baselineSha: '0'.repeat(40), taskId: 'missing', dataDir })).rejects.toMatchObject({ code: 'BASELINE_INVALID' });
    await mkdir(join(dataDir, 'tasks'), { recursive: true });
    await symlink(source, join(dataDir, 'tasks', 'redirect'), 'dir');
    await expect(prepare('redirect')).rejects.toMatchObject({ code: 'WORKTREE_CONFLICT' });
  });

  it('retains conflicting branches and unowned destinations rather than deleting them', async () => {
    await git(source, 'branch', 'personal-agent/task-branch-conflict');
    await expect(prepare('branch-conflict')).rejects.toMatchObject({ code: 'WORKTREE_CONFLICT' });
    expect(await git(source, 'branch', '--list', 'personal-agent/task-branch-conflict')).toContain('personal-agent/task-branch-conflict');
    const destination = join(dataDir, 'tasks', 'path-conflict', 'workspace');
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'keep.txt'), 'Keep\n');
    await expect(prepare('path-conflict')).rejects.toMatchObject({ code: 'WORKTREE_CONFLICT' });
    expect(await readFile(join(destination, 'keep.txt'), 'utf8')).toBe('Keep\n');
  });

  it('rejects task data within the host repository and retained ownership locks', async () => {
    await expect(createTaskWorktree({ workspacePath: source, baselineSha, taskId: 'nested', dataDir: source })).rejects.toMatchObject({ code: 'WORKTREE_CONFLICT' });
    const nested = join(source, '..looks-external');
    await expect(createTaskWorktree({ workspacePath: source, baselineSha, taskId: 'nested', dataDir: nested })).rejects.toMatchObject({ code: 'WORKTREE_CONFLICT' });
    await expect(readFile(nested)).rejects.toMatchObject({ code: 'ENOENT' });
    const taskDir = join(dataDir, 'tasks', 'locked');
    await mkdir(taskDir, { recursive: true });
    const lock = join(taskDir, '.personal-agent-worktree.lock');
    await writeFile(lock, 'Retained ownership lock');
    await expect(prepare('locked')).rejects.toMatchObject({ code: 'WORKTREE_CONFLICT' });
    expect(await readFile(lock, 'utf8')).toBe('Retained ownership lock');
  });

  it('rejects a redirected ownership marker and unexpected Git hooks without executing them', async () => {
    const taskDir = join(dataDir, 'tasks', 'hook-conflict');
    const hooks = join(taskDir, '.empty-git-hooks');
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, 'post-checkout'), '#!/bin/sh\nexit 0\n');
    await expect(prepare('hook-conflict')).rejects.toMatchObject({ code: 'WORKTREE_CONFLICT' });
    const result = await prepare('marker-conflict');
    const marker = join(result.worktreePath, '..', '.personal-agent-worktree.json');
    const redirected = join(directory, 'marker-copy');
    await writeFile(redirected, await readFile(marker));
    await rm(marker);
    await symlink(redirected, marker);
    await expect(prepare('marker-conflict')).rejects.toMatchObject({ code: 'WORKTREE_CONFLICT' });
  });

  it('refuses reuse after the branch or HEAD has been changed', async () => {
    const result = await prepare();
    await git(result.worktreePath, 'checkout', '--detach', '-q');
    await expect(prepare()).rejects.toMatchObject({ code: 'WORKTREE_CONFLICT' });
    await git(result.worktreePath, 'checkout', '-q', result.branch);
    await writeFile(join(result.worktreePath, 'new-commit.txt'), 'Changed HEAD\n');
    await git(result.worktreePath, 'add', '.'); await git(result.worktreePath, 'commit', '-qm', 'Fixture task commit');
    await expect(prepare()).rejects.toMatchObject({ code: 'WORKTREE_CONFLICT' });
  });

  it('does not run repository checkout hooks when preparing task directories', async () => {
    const marker = join(directory, 'hook-ran');
    await writeFile(join(source, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\nprintf unsafe > '${marker}'\n`, { mode: 0o755 });
    await prepare();
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('isolates default global hooks, signing and diff configuration while producing an applicable patch', async () => {
    const hooks = join(directory, 'ambient-hooks');
    const marker = join(directory, 'ambient-hook-ran');
    await mkdir(hooks);
    await writeFile(join(hooks, 'post-checkout'), `#!/bin/sh\nprintf unsafe > '${marker}'\n`, { mode: 0o755 });
    const globalPath = join(directory, 'ambient-global.gitconfig');
    const systemPath = join(directory, 'ambient-system.gitconfig');
    await writeFile(globalPath, `[core]\n\thooksPath = ${hooks}\n[commit]\n\tgpgSign = true\n[diff]\n\tnoprefix = true\n`);
    await writeFile(systemPath, '[commit]\n\tgpgSign = true\n');
    const controlEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalPath, GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    for (const [key, value] of [['core.hooksPath', hooks], ['commit.gpgSign', 'true'], ['diff.noprefix', 'true']]) {
      const { stdout } = await execute('git', ['config', '--get', key], { cwd: source, env: controlEnv });
      expect(stdout.trim()).toBe(value);
    }
    ambient.globalPath = globalPath; ambient.systemPath = systemPath;
    const { worktreePath } = await prepare('ambient-config');
    await writeFile(join(worktreePath, 'src/greet.txt'), 'Hello, isolated\n');
    const patch = await collectTaskPatch({ worktreePath, baselineSha });
    expect(patch).toContain('diff --git a/src/greet.txt b/src/greet.txt');
    const check = await prepare('ambient-patch-check');
    const patchFile = join(directory, 'ambient.patch');
    await writeFile(patchFile, patch);
    await git(check.worktreePath, 'apply', '--check', patchFile);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ambient.childEnvironments.length).toBeGreaterThan(0);
    for (const env of ambient.childEnvironments) {
      expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null');
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    }
  });

  it('supports repository root paths with spaces and trailing newlines', async () => {
    const unusual = join(directory, 'with spaces\n');
    await git(source, 'worktree', 'add', '-q', '-b', 'unusual-root', unusual, baselineSha);
    expect((await inspectWorkspace(unusual)).path).toBe(unusual);
  });
});

describe('complete bounded textual patches', () => {
  it('includes staged and unstaged tracked changes, deletions and new files without changing the index', async () => {
    const { worktreePath } = await prepare();
    await writeFile(join(worktreePath, 'src/greet.txt'), 'Hello, changed\n');
    await git(worktreePath, 'add', 'src/greet.txt');
    await writeFile(join(worktreePath, 'src/greet.txt'), 'Hello, final\n');
    await rm(join(worktreePath, '.gitignore'));
    await writeFile(join(worktreePath, 'new file.txt'), 'New content\n');
    const before = await git(worktreePath, 'status', '--porcelain');
    const patch = await collectTaskPatch({ worktreePath, baselineSha });
    expect(patch).toContain('-Hello, baseline');
    expect(patch).toContain('+Hello, final');
    expect(patch).toContain('deleted file mode');
    expect(patch).toContain('new file mode');
    expect(patch).toContain('+New content');
    expect(await git(worktreePath, 'status', '--porcelain')).toBe(before);
    const check = await prepare('patch-check');
    const patchFile = join(directory, 'complete.patch');
    await writeFile(patchFile, patch);
    await git(check.worktreePath, 'apply', '--check', patchFile);
  });

  it('respects ignore rules and handles quoted, newline and shell metacharacter filenames', async () => {
    const { worktreePath } = await prepare();
    await writeFile(join(worktreePath, 'excluded.ignored'), 'IGNORED\n');
    await writeFile(join(worktreePath, '-$(touch nope) "quoted"\nfile.txt'), 'Safe new file\n');
    const patch = await collectTaskPatch({ worktreePath, baselineSha });
    expect(patch).not.toContain('IGNORED');
    expect(patch).toContain('+Safe new file');
    const check = await prepare('weird-patch-check');
    const patchFile = join(directory, 'weird.patch');
    await writeFile(patchFile, patch);
    await git(check.worktreePath, 'apply', '--check', patchFile);
    await expect(readFile(join(worktreePath, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('represents an untracked symlink target without reading the file outside the worktree', async () => {
    const { worktreePath } = await prepare();
    await writeFile(join(directory, 'outside.txt'), 'SENSITIVE OUTSIDE CONTENT\n');
    await symlink(join(directory, 'outside.txt'), join(worktreePath, 'link.txt'));
    const patch = await collectTaskPatch({ worktreePath, baselineSha });
    expect(patch).toContain('new file mode 120000');
    expect(patch).not.toContain('SENSITIVE OUTSIDE CONTENT');
  });

  it('rejects binary tracked changes and binary new files instead of silently omitting contents', async () => {
    const { worktreePath } = await prepare();
    await writeFile(join(worktreePath, 'src/greet.txt'), Buffer.from([0, 1, 2, 3]));
    await expect(collectTaskPatch({ worktreePath, baselineSha })).rejects.toMatchObject({ code: 'PATCH_UNSUPPORTED' });
    await writeFile(join(worktreePath, 'src/greet.txt'), 'Hello, baseline\n');
    await writeFile(join(worktreePath, 'new.bin'), Buffer.from([0, 1, 2, 3]));
    await expect(collectTaskPatch({ worktreePath, baselineSha })).rejects.toMatchObject({ code: 'PATCH_UNSUPPORTED' });
  });

  it('rejects invalid UTF-8 content rather than producing a lossy patch', async () => {
    const { worktreePath } = await prepare();
    await writeFile(join(worktreePath, 'new.txt'), Buffer.from([0xff, 0x61, 0x0a]));
    await expect(collectTaskPatch({ worktreePath, baselineSha })).rejects.toMatchObject({ code: 'PATCH_UNSUPPORTED' });
  });

  it('fails explicitly when patch output exceeds the bound and returns empty for no changes', async () => {
    const { worktreePath } = await prepare();
    expect(await collectTaskPatch({ worktreePath, baselineSha })).toBe('');
    await writeFile(join(worktreePath, 'large.txt'), 'Lots of text\n'.repeat(100));
    await expect(collectTaskPatch({ worktreePath, baselineSha, maxBytes: 100 })).rejects.toMatchObject({ code: 'PATCH_TOO_LARGE' });
  });
});
