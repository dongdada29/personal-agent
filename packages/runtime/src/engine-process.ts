// Adapted from nuwax-ai/nuwa-cli src/core/processes/killTree.ts at
// 39cc8a50b81763297573bdba65fd606262253f76 (Apache-2.0).
// Source: https://github.com/nuwax-ai/nuwa-cli
// Changes: bounded asynchronous Windows cleanup, shorter stage-one deadlines,
// explicit failure reporting, Linux zombie-aware group verification,
// no logging of process arguments or stderr.
import { spawn, type ChildProcess } from 'node:child_process';
import { EngineError } from './engine.js';
import { processAlive, processGroupAlive } from './process-state.js';

export interface EngineTeardownOptions {
  naturalExitMs?: number;
  termEscalateMs?: number;
  killVerifyMs?: number;
}

async function waitForGone(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
  return !check();
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw new EngineError('CLEANUP_FAILED', 'Engine process group could not be stopped.');
    }
  }
}

/** Call only for a child spawned by this runtime with its own POSIX group. */
export async function terminateEngineProcessTree(proc: ChildProcess, options: EngineTeardownOptions = {}): Promise<void> {
  const pid = proc.pid;
  if (pid === undefined) return;
  const { naturalExitMs = 150, termEscalateMs = 800, killVerifyMs = 500 } = options;
  const treeAlive = () => process.platform === 'win32' ? processAlive(pid) : processGroupAlive(pid);
  if (process.platform === 'win32') {
    // Windows cannot inspect an already-orphaned process tree by parent PID.
    // Run taskkill while the parent still exists, without an EOF grace window;
    // fail closed if that ownership link disappeared instead of claiming that
    // checking the parent's PID proves every descendant is gone.
    if (!treeAlive()) throw new EngineError('CLEANUP_FAILED', 'Windows engine descendants cannot be verified after the parent has exited.');
    const killed = await new Promise<boolean>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { killer.kill(); resolve(false); }, 1500);
      killer.once('error', () => { clearTimeout(timer); resolve(false); });
      killer.once('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
    });
    if (!killed) throw new EngineError('CLEANUP_FAILED', 'Windows engine process tree termination could not be confirmed.');
  } else {
    try { proc.stdin?.end(); } catch { /* already closed */ }
    if (await waitForGone(treeAlive, naturalExitMs)) return;
    signalGroup(pid, 'SIGTERM');
    if (await waitForGone(treeAlive, termEscalateMs)) return;
    signalGroup(pid, 'SIGKILL');
  }
  if (!(await waitForGone(treeAlive, killVerifyMs))) {
    throw new EngineError('CLEANUP_FAILED', 'Engine process tree remains alive after the cleanup deadline.');
  }
}
