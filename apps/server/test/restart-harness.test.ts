import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { createFixtureIpc, withFixtureCleanup } from './fixtures/fixture-ipc.js';

const fixtures: ReturnType<typeof createFixtureIpc>[] = [];
function launch(script: string, budgets: Parameters<typeof createFixtureIpc>[1] = {}, command = process.execPath) {
  const child = spawn(command, ['-e', script], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const fixture = createFixtureIpc(child, { startupMs: 2_000, requestMs: 2_000, exitMs: 2_000, ...budgets });
  fixtures.push(fixture); return fixture;
}
const echo = `process.on('message', value => {
  process.send({ id: value.id, result: value.op === 'close' ? { closed: true } : value.payload },
    () => { if (value.op === 'close') process.disconnect(); });
}); process.send({ ready: true });`;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill('SIGKILL');
    await fixture.exit;
  }
});

it('preserves a blocked startup and waits for the child to exit after IPC disconnects', async () => {
  const fixture = launch(`process.send({ startupError: 'CLEANUP_FAILED' }, () => {
    process.disconnect(); setTimeout(() => process.exit(0), 100);
  });`);
  const disconnected = once(fixture.child, 'disconnect');
  await expect(fixture.ready).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
  await disconnected;
  await fixture.close();
  expect(fixture.child.exitCode).toBe(0);
});

it('rejects pending requests on disconnect and rejects new requests after exit', async () => {
  const fixture = launch(`process.on('message', () => process.disconnect()); process.send({ ready: true });`);
  await fixture.ready;
  await expect(fixture.request({ op: 'disconnect' })).rejects.toThrow(/Fixture (?:IPC channel disconnected|service exited)/);
  await fixture.close();
  await expect(fixture.request({ op: 'too-late' })).rejects.toThrow('Fixture service exited');
});

it('handles a send callback failure without breaking later IPC requests or graceful close', async () => {
  const fixture = launch(echo); await fixture.ready;
  const failure = Object.assign(new Error('Fixture transport closed'), { code: 'EPIPE' });
  vi.spyOn(fixture.child, 'send').mockImplementationOnce((...args) => {
    const callback = args.find(value => typeof value === 'function') as (error: Error | null) => void;
    queueMicrotask(() => callback(failure)); return false;
  });
  await expect(fixture.request({ payload: 'not-sent' })).rejects.toBe(failure);
  await expect(fixture.request({ payload: 'still-connected' })).resolves.toBe('still-connected');
  await fixture.close(); expect(fixture.child.exitCode).toBe(0);
});

it('settles a synchronous serialization failure without leaking a pending IPC request', async () => {
  const fixture = launch(echo); await fixture.ready;
  const circular: Record<string, unknown> = {}; circular.self = circular;
  await expect(fixture.request({ payload: circular })).rejects.toThrow(/circular/i);
  await expect(fixture.request({ payload: 'valid' })).resolves.toBe('valid');
  await fixture.close(); expect(fixture.child.exitCode).toBe(0);
});

it('rejects a failed spawn and resolves its exit wait even though no exit event is emitted', async () => {
  const fixture = launch('', {}, '/nonexistent-personal-agent-fixture/node');
  await expect(fixture.ready).rejects.toMatchObject({ code: 'ENOENT' });
  await fixture.exit;
  await fixture.close();
});

it('keeps a failed close visible and bounds waiting for a child that remains alive', async () => {
  const fixture = launch(`setInterval(() => {}, 1000);
    process.on('message', value => process.send({ id: value.id, error: 'FIXTURE_REQUEST_FAILED' }));
    process.send({ ready: true });`, { exitMs: 200 });
  await fixture.ready;
  const failure = await fixture.close().catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors.map((error: Error) => error.message)).toEqual(['FIXTURE_REQUEST_FAILED', 'Fixture exit deadline exceeded']);
  expect(fixture.child.exitCode).toBeNull();
});

it('preserves the scenario and cleanup errors, and leaves a single failure unchanged', async () => {
  const primary = Object.assign(new Error('Fixture startup blocked'), { code: 'CLEANUP_FAILED' });
  const cleanup = new Error('Saved owner could not be verified');
  const failure = await withFixtureCleanup(async () => { throw primary; }, async () => { throw cleanup; }).catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toEqual([primary, cleanup]); expect(failure.cause).toBe(primary);
  await expect(withFixtureCleanup(async () => { throw primary; }, async () => {})).rejects.toBe(primary);
  await expect(withFixtureCleanup(async () => 'successful scenario', async () => { throw cleanup; })).rejects.toBe(cleanup);
});
