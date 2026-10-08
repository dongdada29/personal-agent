import type { ChildProcess } from 'node:child_process';

/** Preserve a scenario failure even when inspecting its cleanup also fails. */
export async function withFixtureCleanup<T>(run: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let result!: T, failure: unknown, failed = false;
  try { result = await run(); } catch (error) { failed = true; failure = error; }
  try { await cleanup(); }
  catch (error) {
    if (failed) throw new AggregateError([failure, error], 'Fixture scenario and cleanup both failed', { cause: failure });
    throw error;
  }
  if (failed) throw failure;
  return result;
}

/** Test-only IPC requests; disconnecting a channel does not prove the child exited. */
export function createFixtureIpc(child: ChildProcess, budgets: { startupMs?: number; requestMs?: number; exitMs?: number } = {}) {
  const { startupMs = 15_000, requestMs = 8_000, exitMs = 8_000 } = budgets;
  let nextId = 0, exited = child.exitCode !== null || child.signalCode !== null;
  const waiting = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Launching a child can fail before the scenario reaches its first await.
  void ready.catch(() => {});
  const startupTimer = setTimeout(() => readyReject(new Error('Fixture startup deadline exceeded')), startupMs);
  const failStartup = (error: Error) => { clearTimeout(startupTimer); readyReject(error); };
  const settle = (id: number, error?: Error, value?: any) => {
    const pending = waiting.get(id); if (!pending) return;
    waiting.delete(id); clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(value);
  };
  const failPending = (error: Error) => { for (const id of waiting.keys()) settle(id, error); };
  let exitResolve!: () => void;
  const exitEvent = new Promise<void>(resolve => { exitResolve = resolve; });
  const markExited = () => {
    exited = true;
    const error = new Error('Fixture service exited');
    failStartup(error); failPending(error); exitResolve();
  };
  if (exited) markExited();
  child.once('exit', markExited);
  child.once('close', markExited); // Failed spawns emit close without exit.
  child.on('error', error => { failStartup(error); failPending(error); });
  child.on('disconnect', () => {
    const error = new Error('Fixture IPC channel disconnected');
    failStartup(error); failPending(error);
  });
  child.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null) return;
    const value = message as Record<string, unknown>;
    if (value.ready) { clearTimeout(startupTimer); readyResolve(); }
    if (value.startupError) failStartup(Object.assign(new Error('Fixture startup blocked'), { code: value.startupError }));
    if (typeof value.id === 'number') settle(value.id, value.error ? new Error(String(value.error)) : undefined, value.result);
  });
  const waitForExit = (): Promise<void> => {
    if (exited) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture exit deadline exceeded')), exitMs);
      exitEvent.then(() => { clearTimeout(timer); resolve(); });
    });
  };
  const request = (value: Record<string, unknown>): Promise<any> => new Promise((resolve, reject) => {
    if (exited || child.exitCode !== null || child.signalCode !== null) { reject(new Error('Fixture service exited')); return; }
    if (!child.connected) { reject(new Error('Fixture IPC channel disconnected')); return; }
    const id = ++nextId;
    const timer = setTimeout(() => settle(id, new Error('Fixture IPC deadline exceeded')), requestMs);
    waiting.set(id, { resolve, reject, timer });
    try { child.send({ ...value, id }, error => { if (error) settle(id, error); }); }
    catch (error) { settle(id, error instanceof Error ? error : new Error('Fixture IPC send failed')); }
  });
  let closing: Promise<void> | undefined;
  return { child, ready, get exit() { return waitForExit(); }, request, close(): Promise<void> {
    closing ??= (async () => {
      if (exited) return;
      if (!child.connected) { await waitForExit(); return; }
      await withFixtureCleanup(async () => { await request({ op: 'close' }); }, waitForExit);
    })();
    return closing;
  } };
}
