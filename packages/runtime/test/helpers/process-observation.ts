import { execFileSync } from 'node:child_process';

/** Independent test observation: ps states, rather than the runtime's /proc parser. */
export function processRunning(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
  if (process.platform !== 'linux') return true;
  if (pid < 0) {
    const rows = execFileSync('ps', ['-e', '-o', 'pgid=', '-o', 'stat=', '-o', 'nlwp='], { encoding: 'utf8', timeout: 5_000 });
    return rows.trim().split('\n').some(row => {
      const match = /^\s*(\d+)\s+(\S+)\s+(\d+)\s*$/.exec(row);
      if (!match) throw new Error('Fixture ps returned an invalid process state.');
      return Number(match[1]) === -pid && (!match[2].startsWith('Z') || Number(match[3]) !== 1);
    });
  }
  try {
    const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'nlwp='], { encoding: 'utf8', timeout: 5_000 }).trim();
    const match = /^(\S+)\s+(\d+)$/.exec(state);
    if (!match) throw new Error('Fixture ps returned an invalid process state.');
    return !match[1].startsWith('Z') || Number(match[2]) !== 1;
  } catch (error) {
    // A process can disappear between kill(0) and ps. Permission/parse failures
    // remain test failures, rather than assertions that cleanup succeeded.
    try { process.kill(pid, 0); }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') return false; }
    throw error;
  }
}
