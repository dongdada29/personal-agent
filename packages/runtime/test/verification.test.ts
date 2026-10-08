import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedProcessRecord } from '../src/process-registry.js';
import { runVerification, verificationEnvironment } from '../src/verification.js';

let directory: string;

const command = (script: string, args: string[] = []) => ({ command: process.execPath, args: ['-e', script, ...args] });

beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'personal-agent-verification-test-'))); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8'); }
    catch { await new Promise((done) => setTimeout(done, 10)); }
  }
  throw new Error('Fixture output did not arrive.');
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function settleWithin<T>(operation: Promise<T>, ms = 2_500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Verification lifecycle did not settle within its deadline.')), ms);
    operation.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

describe('Runtime verification execution', () => {
  it('records real passing output, cwd, timestamps and exit status', async () => {
    const result = await runVerification({ worktreePath: directory, command: command('console.log(process.cwd());console.error("stderr fixture")') });
    expect(result).toMatchObject({ exitCode: 0, signal: null, stdout: directory + '\n', stderr: 'stderr fixture\n', timedOut: false, cancelled: false, stdoutTruncated: false, stderrTruncated: false });
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps actual non-zero results and stderr as test evidence', async () => {
    const result = await runVerification({ worktreePath: directory, command: command('console.log("assertion input");console.error("assertion failed");process.exitCode=7') });
    expect(result).toMatchObject({ exitCode: 7, stdout: 'assertion input\n', stderr: 'assertion failed\n', timedOut: false, cancelled: false });
  });

  it('returns a clear failed spawn result without raw configuration or environment', async () => {
    const result = await runVerification({ worktreePath: directory, command: { command: join(directory, 'missing-executable'), args: ['PRIVATE ARGUMENT'] } });
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toBe('Verification command could not be started (ENOENT).\n');
    expect(result.stderr).not.toContain('PRIVATE ARGUMENT');
  });

  it('passes shell metacharacters literally and does not evaluate substitutions', async () => {
    const argument = '$(touch SHELL_EXECUTED); quoted "value"';
    const result = await runVerification({ worktreePath: directory, command: command('console.log(process.argv[1])', [argument]) });
    expect(result.stdout).toBe(argument + '\n');
    await expect(readFile(join(directory, 'SHELL_EXECUTED'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('withholds credential environment and startup overrides from verification children', async () => {
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GH_TOKEN', 'CUSTOM_PASSWORD', 'NODE_OPTIONS', 'GIT_CONFIG_COUNT']) vi.stubEnv(key, 'PRIVATE FIXTURE VALUE');
    vi.stubEnv('PERSONAL_AGENT_TEST_VALUE', 'fixture-value');
    const result = await runVerification({ worktreePath: directory, command: command('console.log(JSON.stringify({secret:process.env.ANTHROPIC_AUTH_TOKEN,node:process.env.NODE_OPTIONS,safe:process.env.PERSONAL_AGENT_TEST_VALUE}))') });
    expect(result.stdout).toBe('{"safe":"fixture-value"}\n');
    expect(Object.values(verificationEnvironment())).not.toContain('PRIVATE FIXTURE VALUE');
  });

  it('caps each output stream and explicitly records truncation', async () => {
    const result = await runVerification({ worktreePath: directory, command: command('process.stdout.write("x".repeat(2048));process.stderr.write("y".repeat(2048))'), maxOutputBytes: 64 });
    expect(result.stdout).toBe('x'.repeat(64) + '\n[stdout truncated after 64 bytes]\n');
    expect(result.stderr).toBe('y'.repeat(64) + '\n[stderr truncated after 64 bytes]\n');
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  it('stops a command that ignores SIGTERM after a bounded timeout', async () => {
    const pidFile = join(directory, 'pid');
    const start = Date.now();
    const result = await runVerification({ worktreePath: directory, command: command('require("fs").writeFileSync(process.argv[1],String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)', [pidFile]), timeoutMs: 300 });
    expect(result).toMatchObject({ exitCode: null, signal: 'SIGKILL', timedOut: true, cancelled: false });
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(alive(Number(await readFile(pidFile, 'utf8')))).toBe(false);
  });

  it('cancels on request and confirms the process is gone before returning', async () => {
    const controller = new AbortController();
    const pidFile = join(directory, 'pid');
    const running = runVerification({ worktreePath: directory, command: command('require("fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)', [pidFile]), signal: controller.signal });
    const pid = Number(await waitForFile(pidFile));
    expect(alive(pid)).toBe(true);
    controller.abort();
    expect(await running).toMatchObject({ exitCode: null, cancelled: true, timedOut: false });
    expect(alive(pid)).toBe(false);
  });

  it('does not start a command when the signal is already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    const marker = join(directory, 'must-not-run');
    const result = await runVerification({ worktreePath: directory, command: command('require("fs").writeFileSync(process.argv[1],"ran")', [marker]), signal: controller.signal });
    expect(result).toMatchObject({ exitCode: null, cancelled: true, stdout: '', stderr: '' });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('registers the contextual owner before releasing the command and closes the same record after cleanup', async () => {
    const marker = join(directory, 'registered-command');
    const context = { taskId: 'verification-task', attemptId: 'verification-attempt', runId: 'verification-run' };
    const registered = deferred<OwnedProcessRecord>();
    const release = deferred<void>();
    const onProcessStart = vi.fn((record: OwnedProcessRecord) => { registered.resolve(record); return release.promise; });
    const onProcessEnd = vi.fn();
    const running = runVerification({
      worktreePath: directory, context,
      command: command('require("fs").writeFileSync(process.argv[1],"ran");console.log("registered fixture")', [marker]),
      hooks: { onProcessStart, onProcessEnd },
    });
    try {
      const record = await settleWithin(registered.promise);
      expect(record).toMatchObject({ ...context, kind: 'verification', status: 'active' });
      expect(record.pid).toBeGreaterThan(0);
      expect(record.pgid).toBe(record.pid);
      expect(alive(record.pid)).toBe(true);
      // Give a wrongly released fixture time to create its marker while registration is held.
      await new Promise((done) => setTimeout(done, 75));
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(onProcessEnd).not.toHaveBeenCalled();
      release.resolve();
      expect(await settleWithin(running)).toMatchObject({ exitCode: 0, stdout: 'registered fixture\n', cancelled: false });
      expect(await readFile(marker, 'utf8')).toBe('ran');
      expect(onProcessStart).toHaveBeenCalledTimes(1);
      expect(onProcessEnd).toHaveBeenCalledTimes(1);
      expect(onProcessEnd).toHaveBeenCalledWith({ ...record, status: 'closed' });
      expect(alive(record.pid)).toBe(false);
      expect(alive(-record.pgid)).toBe(false);
    } finally {
      release.resolve();
      await running.catch(() => {});
    }
  });

  it('fails closed when owner registration cannot be persisted', async () => {
    const marker = join(directory, 'failed-registration-command');
    const onProcessStart = vi.fn((_record: OwnedProcessRecord) => { throw new Error('PRIVATE persistence detail'); });
    const onProcessEnd = vi.fn();
    const running = runVerification({
      worktreePath: directory,
      context: { taskId: 'registration-task', attemptId: 'registration-attempt', runId: 'registration-run' },
      command: command('require("fs").writeFileSync(process.argv[1],"ran")', [marker]),
      hooks: { onProcessStart, onProcessEnd },
    });
    await expect(settleWithin(running)).rejects.toMatchObject({ code: 'EVENT_FAILURE' });
    expect(onProcessStart).toHaveBeenCalledTimes(1);
    const record = onProcessStart.mock.calls[0][0];
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(alive(record.pid)).toBe(false);
    expect(alive(-record.pgid)).toBe(false);
    expect(onProcessEnd).not.toHaveBeenCalled();
  });

  it('reports closure persistence failure only after the owned process group is gone', async () => {
    const marker = join(directory, 'closure-command');
    const onProcessStart = vi.fn((_record: OwnedProcessRecord) => {});
    const processStateAtEnd: boolean[] = [];
    const onProcessEnd = vi.fn((record: OwnedProcessRecord) => {
      processStateAtEnd.push(alive(record.pid), alive(-record.pgid));
      throw new Error('PRIVATE closure detail');
    });
    const running = runVerification({
      worktreePath: directory,
      context: { taskId: 'closure-task', attemptId: 'closure-attempt', runId: 'closure-run' },
      command: command('require("fs").writeFileSync(process.argv[1],"ran")', [marker]),
      hooks: { onProcessStart, onProcessEnd },
    });
    await expect(settleWithin(running)).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    expect(await readFile(marker, 'utf8')).toBe('ran');
    expect(onProcessStart).toHaveBeenCalledTimes(1);
    const record = onProcessStart.mock.calls[0][0];
    expect(onProcessEnd).toHaveBeenCalledTimes(1);
    expect(onProcessEnd).toHaveBeenCalledWith({ ...record, status: 'closed' });
    expect(processStateAtEnd).toEqual([false, false]);
    expect(alive(record.pid)).toBe(false);
    expect(alive(-record.pgid)).toBe(false);
  });

  it('cancels promptly during held registration and eventually closes the registered record once', async () => {
    const controller = new AbortController();
    const marker = join(directory, 'cancelled-registration-command');
    const registered = deferred<OwnedProcessRecord>();
    const release = deferred<void>();
    const closed = deferred<OwnedProcessRecord>();
    const onProcessStart = vi.fn((record: OwnedProcessRecord) => { registered.resolve(record); return release.promise; });
    const onProcessEnd = vi.fn((record: OwnedProcessRecord) => { closed.resolve(record); });
    const running = runVerification({
      worktreePath: directory, signal: controller.signal,
      context: { taskId: 'cancel-task', attemptId: 'cancel-attempt', runId: 'cancel-run' },
      command: command('require("fs").writeFileSync(process.argv[1],"ran")', [marker]),
      hooks: { onProcessStart, onProcessEnd },
    });
    try {
      const record = await settleWithin(registered.promise);
      controller.abort();
      expect(await settleWithin(running)).toMatchObject({ exitCode: null, cancelled: true, timedOut: false, stdout: '', stderr: '' });
      expect(alive(record.pid)).toBe(false);
      expect(alive(-record.pgid)).toBe(false);
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(onProcessEnd).not.toHaveBeenCalled();
      release.resolve();
      expect(await settleWithin(closed.promise)).toEqual({ ...record, status: 'closed' });
      await new Promise((done) => setTimeout(done, 30));
      expect(onProcessStart).toHaveBeenCalledTimes(1);
      expect(onProcessEnd).toHaveBeenCalledTimes(1);
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      controller.abort();
      release.resolve();
      await running.catch(() => {});
    }
  });

  it.skipIf(process.platform === 'win32')('kills stubborn descendants even when their parent exits successfully', async () => {
    const pidFile = join(directory, 'child-pid');
    const childScript = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
    const parentScript = 'const child=require("child_process").spawn(process.execPath,["-e",process.argv[2]],{stdio:"ignore"});require("fs").writeFileSync(process.argv[1],String(child.pid));child.unref()';
    const result = await runVerification({ worktreePath: directory, command: command(parentScript, [pidFile, childScript]) });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(alive(Number(await readFile(pidFile, 'utf8')))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('cancels an entire active process group including a grandchild', async () => {
    const controller = new AbortController();
    const pidFile = join(directory, 'child-pid');
    const childScript = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
    const parentScript = 'const child=require("child_process").spawn(process.execPath,["-e",process.argv[2]],{stdio:"ignore"});require("fs").writeFileSync(process.argv[1],String(child.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
    const running = runVerification({ worktreePath: directory, command: command(parentScript, [pidFile, childScript]), signal: controller.signal });
    const pid = Number(await waitForFile(pidFile));
    controller.abort();
    expect(await running).toMatchObject({ cancelled: true, timedOut: false });
    expect(alive(pid)).toBe(false);
  });

  it('rejects malformed command/path/limits before any process executes', async () => {
    await expect(runVerification({ worktreePath: 'relative', command: command('') })).rejects.toMatchObject({ code: 'VERIFICATION_INVALID' });
    await expect(runVerification({ worktreePath: directory, command: { command: '\0', args: [] } })).rejects.toMatchObject({ code: 'VERIFICATION_INVALID' });
    await expect(runVerification({ worktreePath: directory, command: command(''), timeoutMs: 0 })).rejects.toMatchObject({ code: 'VERIFICATION_INVALID' });
    await expect(runVerification({ worktreePath: directory, command: command(''), maxOutputBytes: 0 })).rejects.toMatchObject({ code: 'VERIFICATION_INVALID' });
  });
});
