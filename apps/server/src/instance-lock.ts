import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const locked = () => Object.assign(new Error('Data directory owner or recovery lock needs inspection'), { code: 'INSTANCE_LOCKED' });
function isDefinitelyGone(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) < 1) return false;
  try { process.kill(Number(pid), 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** Ownership precedes recovery. Live, reused, malformed, or ambiguous PIDs block. */
export function acquireInstanceLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'service.lock');
  let descriptor: number;
  try { descriptor = openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let previous: string;
    try {
      previous = readFileSync(path, 'utf8');
      if (!isDefinitelyGone((JSON.parse(previous) as { pid?: unknown }).pid)) throw locked();
    } catch { throw locked(); }
    // Exactly one starter may reclaim a confirmed-dead service. If this short
    // critical section itself crashes, preserve its guard for manual inspection.
    const guard = join(dataDir, 'recovery.lock');
    let recovery: number;
    try { recovery = openSync(guard, 'wx', 0o600); }
    catch { throw locked(); }
    try {
      writeFileSync(recovery, JSON.stringify({ pid: process.pid, id: randomUUID() }));
      if (readFileSync(path, 'utf8') !== previous || !isDefinitelyGone((JSON.parse(previous) as { pid: number }).pid)) throw locked();
      unlinkSync(path);
      descriptor = openSync(path, 'wx', 0o600);
    } finally { closeSync(recovery); unlinkSync(guard); }
  }
  const owner = JSON.stringify({ pid: process.pid, id: randomUUID(), startedAt: new Date().toISOString() });
  try { writeFileSync(descriptor, owner); }
  catch (error) { closeSync(descriptor); unlinkSync(path); throw error; }
  closeSync(descriptor);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { if (readFileSync(path, 'utf8') === owner) unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
}
