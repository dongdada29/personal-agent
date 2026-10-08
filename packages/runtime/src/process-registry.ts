import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EngineError } from './engine.js';
import { terminateEngineProcessTree } from './engine-process.js';

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
const supported = () => process.platform === 'darwin' || process.platform === 'linux';
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};
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
  const pidAlive = alive(record.pid), groupAlive = alive(-record.pgid);
  if (!pidAlive) return groupAlive ? 'unsafe' : 'gone';
  if (!groupAlive) return 'unsafe';
  try {
    const { stdout } = await execFileAsync('ps', ['-ww', '-p', String(record.pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'command='],
      { encoding: 'utf8', timeout: 1_000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin' } });
    const parsed = /^\s*(\d+)\s+(\d+)\s+([^\r\n]+)\s*$/u.exec(stdout);
    if (!parsed) return !alive(record.pid) && !alive(-record.pgid) ? 'gone' : 'unsafe';
    return Number(parsed[1]) === record.pid && Number(parsed[2]) === record.pgid &&
      parsed[3].trim() === `${process.execPath} ${record.wrapperPath} --personal-agent-owner=${record.id}` ? 'owned' : 'unsafe';
  } catch (error) {
    // Permission denial is an unsafe inspection even when the process exits
    // concurrently; never turn a refused read into an ownership conclusion.
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'unsafe';
    return !alive(record.pid) && !alive(-record.pgid) ? 'gone' : 'unsafe';
  }
}

/** Called before scheduling or retiring attempts. Only verified owners are signalled. */
export async function recoverOwnedProcesses(records: OwnedProcessRecord[], onClosed: (record: OwnedProcessRecord) => void | Promise<void>,
  options: { termGraceMs?: number; killVerifyMs?: number } = {}): Promise<void> {
  const termGraceMs = options.termGraceMs ?? 800, killVerifyMs = options.killVerifyMs ?? 1_000;
  if (!supported()) throw new EngineError('PROCESS_UNSUPPORTED', 'Persistent process recovery currently supports macOS and Linux POSIX owners only.');
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
    if (status === 'owned') {
      const signal = async (name: NodeJS.Signals) => {
        const current = await verifyProcessOwner(record);
        if (current === 'gone') return;
        if (current !== 'owned') throw new EngineError('CLEANUP_FAILED', 'Process ownership changed during recovery; no further signals were sent.');
        try { process.kill(-record.pgid, name); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new EngineError('CLEANUP_FAILED', 'The verified process group could not be stopped.'); }
      };
      const gone = async (ms: number) => {
        const until = Date.now() + ms;
        while (alive(-record.pgid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
        return !alive(record.pid) && !alive(-record.pgid);
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
  if (!supported()) throw new EngineError('PROCESS_UNSUPPORTED', 'Owned task processes currently support macOS and Linux POSIX hosts only.');
  const id = randomUUID();
  const env = { ...options.env };
  // The gate must run before any executable startup override could preload
  // code. Native engine authentication remains in its ordinary inherited env.
  for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|LD_|DYLD_)/i.test(key)) delete env[key];
  const child = spawn(process.execPath, [processOwnerWrapperPath, `--personal-agent-owner=${id}`], {
    cwd: options.cwd, env, shell: false, detached: true, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams;
  const gate = child.stdio[3] as Duplex;
  const record: OwnedProcessRecord = { id, ...options.context, pid: child.pid ?? -1, pgid: child.pid ?? -1,
    wrapperPath: processOwnerWrapperPath, startedAt: new Date().toISOString(), status: 'active', kind: options.kind };
  let control = '', closing = false, readyResolved = false, released = false;
  let resolveReady!: () => void, rejectReady!: (cause: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  let resolveExit!: (value: OwnedProcessExit) => void;
  const exited = new Promise<OwnedProcessExit>(resolve => { resolveExit = resolve; });
  let exitReported = false;
  gate.on('error', () => { /* startup or child exit reports a fixed failure */ });
  gate.on('data', (chunk: Buffer) => {
    control += chunk.toString('utf8');
    if (control.length > 8192) { rejectReady(new EngineError('ENGINE_FAILED', 'Process owner emitted invalid control data.')); gate.destroy(); return; }
    let newline: number;
    while ((newline = control.indexOf('\n')) >= 0) {
      const line = control.slice(0, newline); control = control.slice(newline + 1);
      let value: unknown;
      try { value = JSON.parse(line); } catch { rejectReady(new EngineError('ENGINE_FAILED', 'Process owner control data is invalid.')); continue; }
      if (typeof value !== 'object' || value === null) continue;
      const event = value as Record<string, unknown>;
      if (event.type === 'READY') { readyResolved = true; resolveReady(); }
      if (event.type === 'EXIT' && (event.exitCode === null || Number.isInteger(event.exitCode)) && (event.signal === null || typeof event.signal === 'string')) {
        exitReported = true;
        resolveExit({ exitCode: event.exitCode as number | null, signal: event.signal as NodeJS.Signals | null,
          ...(typeof event.spawnError === 'string' ? { spawnError: event.spawnError } : {}) });
      }
    }
  });
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
        try { await hooks.onProcessStart?.(record); registered = true; }
        catch { throw new EngineError('EVENT_FAILURE', 'Process ownership could not be persisted; command was not started.'); }
        if (closing || signal?.aborted) {
          if (closing) await reportEnd();
          throw new EngineError('ABORTED', 'Process startup was cancelled.');
        }
        released = true;
        await new Promise<void>((resolve, reject) => gate.write(JSON.stringify({ type: 'START', command: options.command, args: options.args }) + '\n',
          error => error ? reject(new EngineError('ENGINE_FAILED', 'Process startup gate could not be released.')) : resolve()));
      })();
      return startPromise;
    },
    close() {
      closePromise ??= (async () => {
        closing = true;
        if (!released) gate.destroy();
        try { await terminateEngineProcessTree(child); confirmGone(); }
        catch (error) { rejectGone(error); throw error; }
        finally { gate.destroy(); }
        if (registered) await bounded(reportEnd(), 500, new EngineError('EVENT_FAILURE', 'Process closure persistence exceeded its deadline.'));
      })();
      return closePromise;
    },
  };
}
