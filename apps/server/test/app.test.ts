import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { EngineError, type EngineAdapter } from '@personal-agent/runtime';

const fixtures: { app: Awaited<ReturnType<typeof buildApp>>['app']; dir: string }[] = [];
async function fixture(autoRun = false) {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-api-'));
  const result = await buildApp({ dataDir: dir, autoRun, webRoot: join(dir, 'no-web-build') });
  fixtures.push({ app: result.app, dir });
  return { ...result, dir };
}
afterEach(async () => {
  for (const { app, dir } of fixtures.splice(0)) {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('local phase 1 task API', () => {
  it('creates and reads a persisted task, with original idempotent response and 409 conflict', async () => {
    const { app, store } = await fixture();
    const command = { commandId: 'api-one', goal: 'Demo goal' };
    const response = await app.inject({ method: 'POST', url: '/api/tasks', payload: command });
    expect(response.statusCode).toBe(201);
    const task = response.json();
    expect(store.get(task.id)?.goal).toBe(command.goal);
    const detail = await app.inject(`/api/tasks/${task.id}`);
    expect(detail.json().events[0].type).toBe('task.created');
    expect(detail.json().cursor).toBeGreaterThan(0);
    const repeat = await app.inject({ method: 'POST', url: '/api/tasks', payload: command });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual(task);
    expect(store.list()).toHaveLength(1);
    const conflict = await app.inject({ method: 'POST', url: '/api/tasks', payload: { ...command, goal: 'Other goal' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('COMMAND_CONFLICT');
    expect((await app.inject('/api/tasks/missing')).statusCode).toBe(404);
  });

  it('rejects malformed commands, foreign hosts and origins', async () => {
    const { app, store } = await fixture();
    for (const payload of [{ goal: 'x' }, { commandId: 'x', goal: '  ' }, { commandId: 'x', goal: 42 }, { commandId: 'x', goal: 'x', engine: 'claude' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/tasks', payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: 'x', goal: 'x' },
      headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/health', headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect(store.list()).toHaveLength(0);
    expect((await app.inject('/api/tasks/missing/events?after=-1')).statusCode).toBe(400);
  });

  it('runs an actual stdio fake ACP task through event, artifact, completion and reopening', async () => {
    const { app, runner, dir, store } = await fixture(true);
    const response = await app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: 'fake-real-stdio', goal: 'Create a local demo' } });
    const task = response.json();
    await runner.idle();
    const detail = (await app.inject(`/api/tasks/${task.id}`)).json();
    expect(detail.task.status).toBe('completed');
    expect(detail.task.deliveryStatus).toBe('pending');
    expect(detail.events.some((e: { type: string }) => e.type === 'engine.message')).toBe(true);
    expect(detail.artifacts.length).toBeGreaterThan(0);
    expect(detail.artifacts[0].content).toMatch(/fake/i);
    const replay = (await app.inject(`/api/tasks/${task.id}/events?after=${detail.events[0].seq}`)).json();
    expect(replay.events).toEqual(detail.events.slice(1));
    expect(store.snapshot(task.id)).toEqual(detail);
    await app.close();
    const reopened = await buildApp({ dataDir: dir, autoRun: false });
    try { expect((await reopened.app.inject(`/api/tasks/${task.id}`)).json()).toEqual(detail); }
    finally { await reopened.app.close(); }
  });

  it('refuses a second data directory owner before it can interrupt the first attempt', async () => {
    const { dir, store, app } = await fixture();
    const task = store.create({ commandId: 'owner', goal: 'Active' }).task;
    store.start(task.id);
    const before = store.snapshot(task.id);
    await expect(buildApp({ dataDir: dir, autoRun: false })).rejects.toMatchObject({ code: 'INSTANCE_LOCKED' });
    expect(store.snapshot(task.id)).toEqual(before);
    await app.close();
    const next = await buildApp({ dataDir: dir, autoRun: false });
    try { expect(next.store.get(task.id)?.status).toBe('interrupted'); }
    finally { await next.app.close(); }
  });

  it('reports blocked health and rejects new tasks if engine cleanup is unconfirmed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'personal-agent-blocked-'));
    const adapter: EngineAdapter = {
      probe: async () => ({ protocolReady: false, sessionReady: false, planModeSupported: false, authenticatedPrompt: 'not_checked' }),
      open: async () => { throw new EngineError('CLEANUP_FAILED', 'Fixed diagnostic'); },
    };
    const { app, runner } = await buildApp({ dataDir: dir, adapter });
    fixtures.push({ app, dir });
    const first = await app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: 'block', goal: 'One' } });
    expect(first.statusCode).toBe(201);
    await runner.idle();
    expect((await app.inject('/api/health')).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: 'next', goal: 'Two' } })).statusCode).toBe(503);
  });
});
