import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ failure: undefined as unknown,
  atListen: false, cleanupFailure: false,
  close: vi.fn(async () => {}), listen: vi.fn(async () => {}) }));
vi.mock('../src/app.js', () => ({ buildApp: vi.fn(async () => {
  if (!fixture.atListen) throw fixture.failure;
  return { app: { listen: fixture.listen, close: fixture.close } };
}) }));
vi.mock('../src/access-control.js', () => ({ securityConfigFromEnv: vi.fn(() => undefined) }));

const signals = ['SIGINT', 'SIGTERM'] as const;
let originalListeners: Map<typeof signals[number], NodeJS.SignalsListener[]>;
let originalExitCode: typeof process.exitCode;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  fixture.atListen = false; fixture.cleanupFailure = false;
  fixture.close.mockReset(); fixture.listen.mockReset();
  fixture.close.mockImplementation(async () => { if (fixture.cleanupFailure) throw new Error('PRIVATE_CLEANUP_SECRET'); });
  fixture.listen.mockImplementation(async () => { throw fixture.failure; });
  originalExitCode = process.exitCode;
  originalListeners = new Map(signals.map(signal => [signal, process.listeners(signal)]));
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const signal of signals) for (const listener of process.listeners(signal)) {
    if (!originalListeners.get(signal)?.includes(listener)) process.removeListener(signal, listener);
  }
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('safe service startup diagnostics', () => {
  it.each([
    ['CLEANUP_FAILED', 'CLEANUP_FAILED', 'preserve'],
    ['EVENT_FAILURE', 'EVENT_FAILURE', 'persist'],
    ['PROCESS_UNSUPPORTED', 'PROCESS_UNSUPPORTED', 'macOS or Linux'],
    ['SECURITY_CONFIG_INVALID', 'SECURITY_CONFIG_INVALID', 'HTTPS origin'],
    ['SECURITY_POLICY_CONFLICT', 'SECURITY_POLICY_CONFLICT', 'HTTPS origin'],
    ['INSTANCE_LOCKED', 'INSTANCE_LOCKED', 'do not delete locks'],
    ['EADDRINUSE', 'EADDRINUSE', 'Port 47801'],
    ['EACCES', 'EACCES', 'permissions'],
    ['EPERM', 'EPERM', 'permissions'],
    ['ENOSPC', 'ENOSPC', 'Storage is full'],
    ['SQLITE_FULL', 'ENOSPC', 'Storage is full'],
    ['EROFS', 'EROFS', 'read-only'],
    ['ERR_SQLITE_ERROR', 'DATABASE_STARTUP_FAILED', 'matching source/backup'],
    ['SQLITE_CANTOPEN', 'DATABASE_STARTUP_FAILED', 'matching source/backup'],
    ['SQLITE_CORRUPT', 'DATABASE_STARTUP_FAILED', 'matching source/backup'],
    ['SQLITE_NOTADB', 'DATABASE_STARTUP_FAILED', 'matching source/backup'],
    ['PRIVATE_UNKNOWN_CODE', 'STARTUP_FAILED', 'source dependencies'],
  ])('gives an actionable %s failure without exposing the original error', async (input, output, action) => {
    fixture.failure = Object.assign(new Error('PRIVATE_STARTUP_SECRET /private/user/data'), { code: input });
    await import('../src/main.js');
    expect(process.exitCode).toBe(1);
    expect(errors).toHaveBeenCalledOnce();
    const diagnostic = String(errors.mock.calls[0][0]);
    expect(diagnostic).toContain(`[${output}]`);
    expect(diagnostic).toContain(action);
    expect(diagnostic).not.toMatch(/PRIVATE_|\/private\/user/);
    expect(fixture.listen).not.toHaveBeenCalled();
  });

  it('preserves the startup cause when listening fails and cleanup also rejects', async () => {
    fixture.atListen = true; fixture.cleanupFailure = true;
    fixture.failure = Object.assign(new Error('PRIVATE_LISTEN_SECRET'), { code: 'EADDRINUSE' });
    await import('../src/main.js');
    expect(process.exitCode).toBe(1);
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(errors.mock.calls.map(call => call[0])).toEqual([
      expect.stringContaining('[EADDRINUSE]'), expect.stringContaining('[SHUTDOWN_CLEANUP_FAILED]'),
    ]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('PRIVATE_');
  });
});
