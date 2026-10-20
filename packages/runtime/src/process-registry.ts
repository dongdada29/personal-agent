import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EngineError } from './engine.js';
import { terminateEngineProcessTree } from './engine-process.js';
import { processAlive, processGroupAlive } from './process-state.js';
import { queryWindowsProcesses, taskkillTree, terminateWindowsIdentities, windowsOwnerCommandMatches,
  type TaskkillRunner, type WindowsProcessIdentity, type WindowsProcessRow, type WindowsQuery } from './process-windows.js';

export interface OwnedProcessRecord {
  /** UUID also appears in the owner's argv; never derived from a task ID. */
  id: string;
  taskId?: string;
  attemptId?: string;
  runId?: string;
  pid: number;
  pgid: number;
  wrapperPath: string;
  startedAt: string;
  status: 'active' | 'closed';
  kind: 'engine' | 'verification';
  /**
   * 仅 Windows：owner 进程的 WMI 创建时间（ISO，100ns 精度）。Windows 没有进程组且 PID 复用很快，
   * 恢复时必须用 PID + 创建时间 + 命令行三者共同确认归属；缺失即视为不可验证。
   */
  created?: string;
}

export interface ProcessLifecycleHooks {
  onProcessStart?(record: OwnedProcessRecord): void | Promise<void>;
  onProcessEnd?(record: OwnedProcessRecord): void | Promise<void>;
}
export type ProcessContext = Pick<OwnedProcessRecord, 'taskId' | 'attemptId' | 'runId'>;
export interface OwnedProcessExit { exitCode: number | null; signal: NodeJS.Signals | null; spawnError?: string }
export const processOwnerWrapperPath = fileURLToPath(new URL('./process-owner.mjs', import.meta.url));
const execFileAsync = promisify(execFile);
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const supported = () => process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32';
const isWindows = () => process.platform === 'win32';

/**
 * POSIX：detached 进程组 + fd 3 匿名管道作启动闸门。
 * Windows：不能依赖进程组；detached:true 还会让额外 stdio 句柄无法继承，
 * net.Socket({ fd: 3 }) 永远等不到 READY。改用 Node IPC（同样不占用 stdout/stderr）。
 */
export function ownedProcessSpawnOptions(platform: NodeJS.Platform = process.platform): {
  detached: boolean; windowsHide: boolean; stdio: ['pipe', 'pipe', 'pipe', 'pipe' | 'ipc']; serialization?: 'json';
} {
  if (platform === 'win32') {
    return { detached: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], serialization: 'json' };
  }
  return { detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] };
}

/** Windows 查询与结束进程的实现；测试可替换为假的进程表。 */
export const windowsProcessOps: { query: WindowsQuery; kill: TaskkillRunner } = { query: queryWindowsProcesses, kill: taskkillTree };

/**
 * Windows 归属判定（纯函数，便于测试）：
 * - 进程表里存在 PID + 创建时间都相同的行：命令行完全匹配 => owned，否则 => unsafe（不碰它）；
 * - 不存在 => gone（PID 可能已被复用给无关进程，按创建时间区分，绝不把它当作 owner）。
 */
export function classifyWindowsOwner(record: OwnedProcessRecord, rows: WindowsProcessRow[], execPath = process.execPath): 'owned' | 'gone' | 'unsafe' {
  if (!record.created || Number.isNaN(Date.parse(record.created))) return 'unsafe';
  const row = rows.find(item => item.pid === record.pid && item.created === record.created);
  if (!row) return 'gone';
  return windowsOwnerCommandMatches(row.commandLine, execPath, record.wrapperPath, record.id) ? 'owned' : 'unsafe';
}
function bounded<T>(promise: Promise<T>, ms: number, error: EngineError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, cause => { clearTimeout(timer); reject(cause); });
  });
}

/** Recovery never trusts a saved PID alone, and never returns argv or env. */
export async function verifyProcessOwner(record: OwnedProcessRecord): Promise<'owned' | 'gone' | 'unsafe'> {
  if (!supported() || !UUID.test(record.id) || !Number.isSafeInteger(record.pid) || record.pid < 1 ||
    record.pgid !== record.pid || record.wrapperPath !== processOwnerWrapperPath ||
    !['engine', 'verification'].includes(record.kind)) return 'unsafe';
  if (isWindows()) {
    try { return classifyWindowsOwner(record, await windowsProcessOps.query([record.pid])); }
    catch { return 'unsafe'; }
  }
  const pidAlive = processAlive(record.pid), groupAlive = processGroupAlive(record.pgid);
  if (!pidAlive) return groupAlive ? 'unsafe' : 'gone';
  if (!groupAlive) return 'unsafe';
  try {
    const { stdout } = await execFileAsync('ps', ['-ww', '-p', String(record.pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'command='],
      { encoding: 'utf8', timeout: 1_000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin' } });
    const parsed = /^\s*(\d+)\s+(\d+)\s+([^\r\n]+)\s*$/u.exec(stdout);
    if (!parsed) return !processAlive(record.pid) && !processGroupAlive(record.pgid) ? 'gone' : 'unsafe';
    return Number(parsed[1]) === record.pid && Number(parsed[2]) === record.pgid &&
      parsed[3].trim() === `${process.execPath} ${record.wrapperPath} --personal-agent-owner=${record.id}` ? 'owned' : 'unsafe';
  } catch (error) {
    // Permission denial is an unsafe inspection even when the process exits
    // concurrently; never turn a refused read into an ownership conclusion.
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'unsafe';
    return !processAlive(record.pid) && !processGroupAlive(record.pgid) ? 'gone' : 'unsafe';
  }
}

/** Called before scheduling or retiring attempts. Only verified owners are signalled. */
export async function recoverOwnedProcesses(records: OwnedProcessRecord[], onClosed: (record: OwnedProcessRecord) => void | Promise<void>,
  options: { termGraceMs?: number; killVerifyMs?: number } = {}): Promise<void> {
  const termGraceMs = options.termGraceMs ?? 800, killVerifyMs = options.killVerifyMs ?? 1_000;
  if (!supported()) throw new EngineError('PROCESS_UNSUPPORTED', 'Persistent process recovery currently supports macOS, Linux and Windows owners only.');
  if (!Number.isSafeInteger(termGraceMs) || termGraceMs < 0 || termGraceMs > 5_000 ||
    !Number.isSafeInteger(killVerifyMs) || killVerifyMs < 1 || killVerifyMs > 5_000) throw new EngineError('CLEANUP_FAILED', 'Process recovery deadlines are invalid.');
  const active = records.filter(record => record.status === 'active');
  if (new Set(active.map(record => record.id)).size !== active.length || new Set(active.map(record => record.pid)).size !== active.length) {
    throw new EngineError('CLEANUP_FAILED', 'Conflicting process ownership records require inspection.');
  }
  // Validate every owner before affecting any process; one mismatched record
  // prevents partial cleanup based on potentially corrupt persisted metadata.
  const owners = await Promise.all(active.map(async record => ({ record, status: await verifyProcessOwner(record) })));
  if (owners.some(owner => owner.status === 'unsafe')) throw new EngineError('CLEANUP_FAILED', 'A saved process owner cannot be verified; scheduling must remain stopped.');
  for (const { record, status } of owners) {
    if (isWindows()) {
      // 无论 owner 是否还活着都要处理：它的孤儿子孙仍保留 ParentProcessId，并且创建时间不早于 owner。
      // terminateWindowsIdentities 只结束“PID + 创建时间”与记录一致的进程及其子孙，PID 复用不会误杀。
      let stopped = false;
      try {
        stopped = await terminateWindowsIdentities([{ pid: record.pid, created: record.created! }],
          { query: windowsProcessOps.query, kill: windowsProcessOps.kill, verifyMs: killVerifyMs + termGraceMs });
      } catch { stopped = false; }
      if (!stopped) throw new EngineError('CLEANUP_FAILED', 'A recovered Windows process tree remains alive after its cleanup deadline.');
    } else if (status === 'owned') {
      const signal = async (name: NodeJS.Signals) => {
        const current = await verifyProcessOwner(record);
        if (current === 'gone') return;
        if (current !== 'owned') throw new EngineError('CLEANUP_FAILED', 'Process ownership changed during recovery; no further signals were sent.');
        try { process.kill(-record.pgid, name); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new EngineError('CLEANUP_FAILED', 'The verified process group could not be stopped.'); }
      };
      const gone = async (ms: number) => {
        const until = Date.now() + ms;
        while (processGroupAlive(record.pgid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
        return !processAlive(record.pid) && !processGroupAlive(record.pgid);
      };
      await signal('SIGTERM');
      if (!(await gone(termGraceMs))) {
        await signal('SIGKILL');
        if (!(await gone(killVerifyMs))) throw new EngineError('CLEANUP_FAILED', 'A recovered process group remains alive after its cleanup deadline.');
      }
    }
    try { await onClosed({ ...record, status: 'closed' }); }
    catch { throw new EngineError('EVENT_FAILURE', 'Recovered process closure could not be persisted.'); }
  }
}

/** Child execution is gated until onProcessStart has durably registered the owner. */
export function spawnOwnedProcess(options: {
  command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv; kind: OwnedProcessRecord['kind']; context?: ProcessContext;
}): { process: ChildProcessWithoutNullStreams; record: OwnedProcessRecord; exit: Promise<OwnedProcessExit>;
  start(hooks?: ProcessLifecycleHooks, signal?: AbortSignal): Promise<void>; close(): Promise<void> } {
  if (!supported()) throw new EngineError('PROCESS_UNSUPPORTED', 'Owned task processes currently support macOS, Linux and Windows hosts only.');
  const id = randomUUID();
  const env = { ...options.env };
  // The gate must run before any executable startup override could preload
  // code. Native engine authentication remains in its ordinary inherited env.
  for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|LD_|DYLD_)/i.test(key)) delete env[key];
  // Electron 托管模式下 process.execPath 是 Electron 本体：owner 必须以 Node 方式运行，
  // 否则会拉起一个新的 GUI 实例。owner 再决定子进程是否保留该开关（见 process-owner.mjs）。
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const windows = isWindows();
  const spawnOptions = ownedProcessSpawnOptions();
  // 显式开关，避免从 vitest/Electron 继承到的 process.send 被误当成闸门。
  if (spawnOptions.stdio[3] === 'ipc') env.PERSONAL_AGENT_OWNER_IPC = '1';
  const child = spawn(process.execPath, [processOwnerWrapperPath, `--personal-agent-owner=${id}`], {
    cwd: options.cwd, env, shell: false, ...spawnOptions,
  }) as unknown as ChildProcessWithoutNullStreams;
  const gate = windows ? undefined : child.stdio[3] as Duplex;
  const record: OwnedProcessRecord = { id, ...options.context, pid: child.pid ?? -1, pgid: child.pid ?? -1,
    wrapperPath: processOwnerWrapperPath, startedAt: new Date().toISOString(), status: 'active', kind: options.kind };
  let control = '', closing = false, readyResolved = false, released = false;
  let childIdentity: Promise<WindowsProcessIdentity | undefined> | undefined;
  let resolveReady!: () => void, rejectReady!: (cause: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  let resolveExit!: (value: OwnedProcessExit) => void;
  const exited = new Promise<OwnedProcessExit>(resolve => { resolveExit = resolve; });
  let exitReported = false;
  const destroyGate = () => {
    if (windows) {
      try { if (child.connected) child.disconnect(); } catch { /* already disconnected */ }
      return;
    }
    gate!.destroy();
  };
  const acceptControl = (value: unknown) => {
    if (typeof value !== 'object' || value === null) return;
    const event = value as Record<string, unknown>;
    if (event.type === 'READY') { readyResolved = true; resolveReady(); }
    if (event.type === 'CHILD' && windows && Number.isSafeInteger(event.pid) && (event.pid as number) > 0 && !childIdentity) {
      // 立即记录直接子进程的创建时间：它退出后其孤儿子孙仍以它的 PID 为 ParentProcessId。
      const pid = event.pid as number;
      childIdentity = windowsProcessOps.query([pid]).then(rows => {
        const row = rows.find(item => item.pid === pid && item.ppid === record.pid && item.created !== null);
        return row ? { pid, created: row.created! } : undefined;
      }, () => undefined);
    }
    if (event.type === 'EXIT' && (event.exitCode === null || Number.isInteger(event.exitCode)) && (event.signal === null || typeof event.signal === 'string')) {
      exitReported = true;
      resolveExit({ exitCode: event.exitCode as number | null, signal: event.signal as NodeJS.Signals | null,
        ...(typeof event.spawnError === 'string' ? { spawnError: event.spawnError } : {}) });
    }
  };
  if (windows) {
    child.on('message', acceptControl);
  } else {
    gate!.on('error', () => { /* startup or child exit reports a fixed failure */ });
    gate!.on('data', (chunk: Buffer) => {
      control += chunk.toString('utf8');
      if (control.length > 8192) { rejectReady(new EngineError('ENGINE_FAILED', 'Process owner emitted invalid control data.')); destroyGate(); return; }
      let newline: number;
      while ((newline = control.indexOf('\n')) >= 0) {
        const line = control.slice(0, newline); control = control.slice(newline + 1);
        let value: unknown;
        try { value = JSON.parse(line); } catch { rejectReady(new EngineError('ENGINE_FAILED', 'Process owner control data is invalid.')); continue; }
        acceptControl(value);
      }
    });
  }
  child.once('error', () => { rejectReady(new EngineError('ENGINE_FAILED', 'Process owner could not start.')); resolveExit({ exitCode: null, signal: null, spawnError: 'SPAWN_ERROR' }); });
  child.once('exit', (code, signal) => {
    if (!readyResolved) rejectReady(new EngineError('ENGINE_FAILED', 'Process owner exited before startup.'));
    if (!exitReported) resolveExit({ exitCode: signal ? null : code, signal });
  });
  let lifecycleHooks: ProcessLifecycleHooks = {}, registered = false;
  let startPromise: Promise<void> | undefined, closePromise: Promise<void> | undefined, endPromise: Promise<void> | undefined;
  let confirmGone!: () => void, rejectGone!: (cause: unknown) => void;
  const treeGone = new Promise<void>((resolve, reject) => { confirmGone = resolve; rejectGone = reject; });
  void treeGone.catch(() => {});
  /**
   * Windows 收尾：owner 可能已正常退出（子进程结束后它会立即退出），此时不能像 POSIX 那样检查进程组，
   * 而是按“owner + 直接子进程”的身份（PID + 创建时间）找出全部仍存活的子孙并 taskkill /T /F，再复查。
   * owner 身份未知（尚未登记）时只能结束仍由本进程持有句柄的 owner 本身。
   */
  const closeWindowsTree = async (): Promise<void> => {
    const roots: WindowsProcessIdentity[] = [];
    if (record.created) roots.push({ pid: record.pid, created: record.created });
    const direct = await childIdentity;
    if (direct) roots.push(direct);
    if (!roots.length) {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        const exitedNow = new Promise<void>(done => child.once('exit', () => done()));
        await windowsProcessOps.kill(child.pid);
        await bounded(exitedNow, 3_000, new EngineError('CLEANUP_FAILED', 'Windows process owner did not exit after termination.'));
      }
      return;
    }
    let stopped = false;
    try { stopped = await terminateWindowsIdentities(roots, { query: windowsProcessOps.query, kill: windowsProcessOps.kill }); }
    catch { stopped = false; }
    if (!stopped) throw new EngineError('CLEANUP_FAILED', 'Windows process tree termination could not be confirmed.');
  };
  const reportEnd = (): Promise<void> => endPromise ??= Promise.resolve().then(async () => {
    await treeGone;
    try { await lifecycleHooks.onProcessEnd?.({ ...record, status: 'closed' }); }
    catch { throw new EngineError('EVENT_FAILURE', 'Process closure could not be persisted.'); }
  });
  return {
    process: child, record, exit: exited,
    start(hooks = {}, signal) {
      if (!startPromise) lifecycleHooks = hooks;
      startPromise ??= (async () => {
        await bounded(ready, 3_000, new EngineError('ENGINE_FAILED', 'Process owner startup exceeded its deadline.'));
        if (closing || signal?.aborted) throw new EngineError('ABORTED', 'Process startup was cancelled.');
        if (windows) {
          // 登记前先取得 owner 的创建时间并核对命令行；取不到就不放行命令（之后无法安全恢复）。
          let rows: WindowsProcessRow[] = [];
          try { rows = await bounded(windowsProcessOps.query([record.pid]), 10_000, new EngineError('ENGINE_FAILED', 'Process owner identity query timed out.')); } catch { /* 下方统一报错 */ }
          const row = rows.find(item => item.pid === record.pid && item.created !== null &&
            windowsOwnerCommandMatches(item.commandLine, process.execPath, processOwnerWrapperPath, id));
          if (!row) throw new EngineError('ENGINE_FAILED', 'Process owner identity could not be verified.');
          record.created = row.created!;
          if (closing || signal?.aborted) throw new EngineError('ABORTED', 'Process startup was cancelled.');
        }
        try { await hooks.onProcessStart?.(record); registered = true; }
        catch { throw new EngineError('EVENT_FAILURE', 'Process ownership could not be persisted; command was not started.'); }
        if (closing || signal?.aborted) {
          if (closing) await reportEnd();
          throw new EngineError('ABORTED', 'Process startup was cancelled.');
        }
        released = true;
        await new Promise<void>((resolve, reject) => {
          const fail = () => reject(new EngineError('ENGINE_FAILED', 'Process startup gate could not be released.'));
          const payload = { type: 'START', command: options.command, args: options.args };
          if (windows) {
            try { child.send(payload, error => error ? fail() : resolve()); }
            catch { fail(); }
            return;
          }
          gate!.write(JSON.stringify(payload) + '\n', error => error ? fail() : resolve());
        });
      })();
      return startPromise;
    },
    close() {
      closePromise ??= (async () => {
        closing = true;
        if (!released) destroyGate();
        try { await (windows ? closeWindowsTree() : terminateEngineProcessTree(child)); confirmGone(); }
        catch (error) { rejectGone(error); throw error; }
        finally { destroyGate(); }
        if (registered) await bounded(reportEnd(), 500, new EngineError('EVENT_FAILURE', 'Process closure persistence exceeded its deadline.'));
      })();
      return closePromise;
    },
  };
}
