import { readFileSync, readdirSync, readlinkSync } from 'node:fs';

type SignalState = 'present' | 'gone' | 'unknown';
type LinuxProcessState = { kind: 'present'; state: string; pgid: number; startTime: string; threads: number }
  | { kind: 'gone' | 'unknown' };

const positiveId = (id: number) => Number.isSafeInteger(id) && id > 0;
const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;

function signalState(pid: number): SignalState {
  try { process.kill(pid, 0); return 'present'; }
  catch (error) { return errorCode(error) === 'ESRCH' ? 'gone' : 'unknown'; }
}

function portableAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) === 'EPERM'; }
}

function sameLinuxPidNamespace(): boolean {
  try { return readlinkSync('/proc/self') === String(process.pid); }
  catch { return false; }
}

/** Filtered procfs can hide a live member even when its zombie owner is visible. */
function completeLinuxProcView(): boolean {
  if (!sameLinuxPidNamespace()) return false;
  try {
    const mountinfo = readFileSync('/proc/self/mountinfo', 'utf8').trim();
    if (!mountinfo) return false;
    let procMounts = 0;
    for (const line of mountinfo.split('\n')) {
      const parts = line.split(' - ');
      if (parts.length !== 2) return false;
      const before = parts[0].split(' '), after = parts[1].split(' ');
      if (before.length < 6 || after.length !== 3 || [...before, ...after].some(field => !field) ||
        !/^\d+$/u.test(before[0]) || !/^\d+$/u.test(before[1]) || !/^\d+:\d+$/u.test(before[2]) ||
        !before[3].startsWith('/') || !before[4].startsWith('/')) return false;
      // mountinfo escapes whitespace and backslashes in paths; unknown escapes
      // cannot establish which mount covers /proc or a process directory.
      if ([before[3], before[4]].some(path => /\\(?!040|011|012|134)/u.test(path))) return false;
      const point = before[4].replace(/\\(040|011|012|134)/gu, (_, code: string) =>
        String.fromCharCode(Number.parseInt(code, 8)));
      if (/^\/proc\/(?:\d+|self|thread-self)(?:\/|$)/u.test(point)) return false;
      if (point !== '/proc') continue;
      if (++procMounts !== 1 || before[3] !== '/' || after[0] !== 'proc') return false;
      const options = [...before[5].split(','), ...after[2].split(',')];
      if (options.some(option => !option || option === 'hidepid' ||
        option.startsWith('hidepid=') && !/^hidepid=(?:0|off)$/u.test(option))) return false;
    }
    return procMounts === 1;
  } catch { return false; }
}

/** Only /proc/<pid>/stat is read; comm may itself contain spaces, newlines and parentheses. */
function readLinuxState(pid: number): LinuxProcessState {
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) {
    // A disappearing directory is safe to ignore only after confirming ESRCH.
    return errorCode(error) === 'ENOENT' && signalState(pid) === 'gone' ? { kind: 'gone' } : { kind: 'unknown' };
  }
  const prefix = /^([1-9]\d*) \(/u.exec(stat);
  const close = stat.lastIndexOf(')');
  if (!prefix || Number(prefix[1]) !== pid || close < prefix[0].length) return { kind: 'unknown' };
  const fields = stat.slice(close + 1).trim().split(/\s+/u);
  // Require the complete fixed prefix through starttime (field 22), rather
  // than treating a truncated "pid (comm) Z ppid pgrp" row as proof of death.
  if (fields.length < 20 || !/^[A-Za-z]$/u.test(fields[0]) || fields.slice(1).some(field => !/^-?\d+$/u.test(field))) {
    return { kind: 'unknown' };
  }
  const ppid = Number(fields[1]), pgid = Number(fields[2]), threads = Number(fields[17]);
  if (!Number.isSafeInteger(ppid) || ppid < 0 || !Number.isSafeInteger(pgid) || pgid < 0 ||
    !positiveId(threads) || !/^\d+$/u.test(fields[19])) {
    return { kind: 'unknown' };
  }
  return { kind: 'present', state: fields[0], pgid, startTime: fields[19], threads };
}

function linuxPids(): number[] | undefined {
  try {
    const entries = readdirSync('/proc');
    const numeric = entries.filter(entry => /^\d+$/u.test(entry)).map(Number);
    return numeric.every(positiveId) ? numeric : undefined;
  } catch { return undefined; }
}

/** Linux true includes unknown; other platforms retain their existing signal-zero behavior. */
export function processAlive(pid: number): boolean {
  if (!positiveId(pid)) return true;
  if (process.platform !== 'linux') return portableAlive(pid);
  const signal = signalState(pid);
  if (signal !== 'present') return signal !== 'gone';
  if (!completeLinuxProcView()) return true;
  const observed = readLinuxState(pid);
  // A zombie thread-group leader can still have running sibling threads.
  if (observed.kind !== 'present') return observed.kind === 'unknown';
  if (observed.state !== 'Z' || observed.threads !== 1) return true;
  return !completeLinuxProcView();
}

/** A zombie owner alone says nothing about the other members of its process group. */
export function processGroupAlive(pgid: number): boolean {
  if (!positiveId(pgid)) return true;
  if (process.platform !== 'linux') return portableAlive(-pgid);
  const signal = signalState(-pgid);
  if (signal !== 'present') return signal !== 'gone';
  if (!completeLinuxProcView()) return true;
  let pids = linuxPids();
  if (!pids) return true;
  let previous: Map<number, LinuxProcessState> | undefined;
  let matchingZombies = 0;
  // Reinspect a stable PID snapshot. An active member could fork and disappear
  // during enumeration; a newly listed PID or a reused PID makes this unknown.
  for (let pass = 0; pass < 2; pass++) {
    const observed = new Map<number, LinuxProcessState>();
    matchingZombies = 0;
    for (const pid of pids) {
      const state = readLinuxState(pid);
      if (state.kind === 'unknown') return true;
      const earlier = previous?.get(pid);
      if (earlier && state.kind === 'present' && (earlier.kind === 'gone' ||
        earlier.kind === 'present' && earlier.startTime !== state.startTime)) return true;
      observed.set(pid, state);
      if (state.kind === 'present' && state.pgid === pgid) {
        if (state.state !== 'Z' || state.threads !== 1) return true;
        matchingZombies++;
      }
    }
    const next = linuxPids();
    if (!next || next.some(pid => !observed.has(pid))) return true;
    pids = next;
    previous = observed;
  }
  // An inaccessible or racing /proc view can omit the whole group. kill(0)
  // still succeeding without a matching member is not proof that it is gone.
  if (!completeLinuxProcView()) return true;
  return matchingZombies === 0 && signalState(-pgid) !== 'gone';
}
