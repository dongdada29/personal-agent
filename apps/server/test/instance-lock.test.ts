import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireInstanceLock } from '../src/instance-lock.js';

const state = vi.hoisted(() => ({ inspect: vi.fn<(pid: number) => boolean>() }));
vi.mock('@personal-agent/runtime', () => ({ processAlive: state.inspect }));
const roots: string[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'personal-agent-zombie-lock-')); roots.push(root);
  const path = join(root, 'service.lock');
  const previous = JSON.stringify({ pid: 12345, id: 'previous-service' });
  writeFileSync(path, previous);
  return { root, path, previous };
}
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.restoreAllMocks(); state.inspect.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('reclaims a confirmed non-executing zombie service using the existing recovery guard', () => {
  const { root, path } = fixture();
  state.inspect.mockReturnValue(false);
  const release = acquireInstanceLock(root);
  expect(state.inspect.mock.calls).toEqual([[12345], [12345]]);
  expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid);
  expect(existsSync(join(root, 'recovery.lock'))).toBe(false);
  release();
  expect(existsSync(path)).toBe(false);
});

it('preserves the original service lock when the process state is live or unknown', () => {
  const { root, path, previous } = fixture();
  state.inspect.mockReturnValue(true);
  expect(() => acquireInstanceLock(root)).toThrowError(expect.objectContaining({ code: 'INSTANCE_LOCKED' }));
  expect(readFileSync(path, 'utf8')).toBe(previous);
  expect(existsSync(join(root, 'recovery.lock'))).toBe(false);
});

it('refuses reclamation if a PID becomes active or uninspectable during the guarded recheck', () => {
  const { root, path, previous } = fixture();
  state.inspect.mockReturnValueOnce(false).mockReturnValueOnce(true);
  expect(() => acquireInstanceLock(root)).toThrowError(expect.objectContaining({ code: 'INSTANCE_LOCKED' }));
  expect(state.inspect.mock.calls).toEqual([[12345], [12345]]);
  expect(readFileSync(path, 'utf8')).toBe(previous);
  expect(existsSync(join(root, 'recovery.lock'))).toBe(false);
});

it.each(['EPERM', 'EINVAL', 'ERR_OUT_OF_RANGE'])('keeps non-Linux locks blocked on %s rather than treating ambiguity as absence', code => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const { root, path, previous } = fixture();
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Fixture inspection failed'), { code }); });
  expect(() => acquireInstanceLock(root)).toThrowError(expect.objectContaining({ code: 'INSTANCE_LOCKED' }));
  expect(readFileSync(path, 'utf8')).toBe(previous);
  expect(state.inspect).not.toHaveBeenCalled();
});

it('preserves a non-Linux lock with a safe integer PID outside the signal API range', () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const { root, path } = fixture();
  const previous = JSON.stringify({ pid: Number.MAX_SAFE_INTEGER });
  writeFileSync(path, previous);
  expect(() => acquireInstanceLock(root)).toThrowError(expect.objectContaining({ code: 'INSTANCE_LOCKED' }));
  expect(readFileSync(path, 'utf8')).toBe(previous);
  expect(state.inspect).not.toHaveBeenCalled();
});

it('retains non-Linux reclamation when both guarded inspections confirm ESRCH', () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const { root, path } = fixture();
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Fixture process is gone'), { code: 'ESRCH' }); });
  const release = acquireInstanceLock(root);
  expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid);
  expect(state.inspect).not.toHaveBeenCalled();
  release(); expect(existsSync(path)).toBe(false);
});
