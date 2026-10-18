import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type AppOptions } from '../src/app.js';
import { demoConfigFromEnv, rejectDemoEnvForPersistentServer, validateDemoConfig } from '../src/demo-mode.js';

const publicOrigin = 'https://demo.example.test';
const publicHost = 'demo.example.test';
const fixtures: { app: Awaited<ReturnType<typeof buildApp>>['app']; dir: string }[] = [];

async function fixture(options: Partial<AppOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-demo-mode-'));
  const result = await buildApp({ dataDir: join(dir, 'data'), autoRun: false, webRoot: join(dir, 'no-web-build'), ...options });
  fixtures.push({ app: result.app, dir });
  return { ...result, dir };
}
const demoFixture = (demo: AppOptions['demo'] = { mode: 'fake', publicOrigin }, options: Partial<AppOptions> = {}) => fixture({ demo, ...options });

/** 审计 PoC 用到的临时 Git 仓库：若守卫失效，worktree 会建在这里，验证命令会创建 marker。 */
function harmlessRepository(dir: string) {
  const repository = join(dir, 'visitor-repository');
  mkdirSync(repository);
  writeFileSync(join(repository, 'answer.txt'), 'before');
  execFileSync('git', ['init', '--quiet', repository]);
  execFileSync('git', ['-C', repository, 'add', 'answer.txt']);
  execFileSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Baseline']);
  return repository;
}

afterEach(async () => {
  for (const { app, dir } of fixtures.splice(0)) { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

describe('fake-only demo mode is enforced on routed handlers, not URL strings', () => {
  const claudeTask = (commandId: string, marker: string) => ({ commandId, goal: 'Must not execute', engine: 'claude', workspaceId: 'any',
    verificationCommands: [{ command: '/usr/bin/touch', args: [marker] }] });

  it.each(['/api/tasks', '/api/%74asks', '/api/%74%61%73%6B%73', '/api/t%61sks?probe=1', '/%61pi/tasks'])('rejects a claude task at %s', async url => {
    const { app, store, dir } = await demoFixture();
    const marker = join(dir, 'marker');
    const response = await app.inject({ method: 'POST', url, payload: claudeTask('encoded-claude', marker) });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('DEMO_FAKE_ONLY');
    expect(store.list()).toHaveLength(0);
    expect(existsSync(marker)).toBe(false);
  });

  it.each(['//api/tasks', '/api/tasks/', '/API/tasks', '/api/tasks%2f', '/api/tasks/../tasks', '/api/./tasks'])('never creates a task through the unrouted or normalized variant %s', async url => {
    const { app, store, dir } = await demoFixture();
    const response = await app.inject({ method: 'POST', url, payload: claudeTask('variant-claude', join(dir, 'marker')) });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(store.list()).toHaveLength(0);
  });

  it('never runs visitor verification commands or creates worktrees, even with a real Git repository', async () => {
    const { app, store, runner, dir } = await demoFixture(undefined, { autoRun: true });
    const repository = harmlessRepository(dir);
    const marker = join(dir, 'pa-demo-poc-marker');
    for (const url of ['/api/workspaces', '/api/%77orkspaces', '/api/w%6Frkspaces']) {
      const registered = await app.inject({ method: 'POST', url, payload: { commandId: `register-${url.length}`, name: 'Visitor', path: repository } });
      expect(registered.statusCode).toBe(403);
      expect(registered.json().code).toBe('DEMO_FAKE_ONLY');
    }
    expect(store.workspaces()).toHaveLength(0);
    for (const payload of [claudeTask('claude-poc', marker), { ...claudeTask('fake-with-commands', marker), engine: 'fake', workspaceId: undefined },
      { commandId: 'default-with-commands', goal: 'x', verificationCommands: [{ command: '/usr/bin/touch', args: [marker] }] },
      { commandId: 'workspace-only', goal: 'x', workspaceId: 'any' }]) {
      const response = await app.inject({ method: 'POST', url: '/api/%74asks', payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(403);
    }
    await runner.idle();
    expect(store.list()).toHaveLength(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(dir, 'data', 'tasks')) ? readdirSync(join(dir, 'data', 'tasks')) : []).toEqual([]);
    expect(execFileSync('git', ['-C', repository, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).match(/^worktree /gm)).toHaveLength(1);
    expect(runner.isFakeOnly).toBe(true);
  });

  it.each(['/api/settings', '/api/%73ettings', '/api/s%65ttings'])('keeps the default engine fake at %s', async url => {
    const { app, store } = await demoFixture();
    const response = await app.inject({ method: 'PATCH', url, payload: { commandId: `settings-${url.length}`, defaultEngine: 'claude' } });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('DEMO_FAKE_ONLY');
    expect(store.settings().defaultEngine).toBe('fake');
    const harmless = await app.inject({ method: 'PATCH', url, payload: { commandId: `timeout-${url.length}`, agentRunTimeoutMs: 60_000 } });
    expect(harmless.statusCode).toBe(200);
  });

  it('still runs fake tasks end to end and retries them only with the fake engine', async () => {
    const { app, store, runner } = await demoFixture(undefined, { autoRun: true });
    const created = await app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: 'fake-ok', goal: 'fake:error fail first' } });
    expect(created.statusCode).toBe(201);
    await runner.idle();
    expect(store.require(created.json().id).status).toBe('failed');
    const retry = await app.inject({ method: 'POST', url: `/api/tasks/${created.json().id}/control`, payload: { commandId: 'retry-fake', action: 'retry' } });
    expect(retry.statusCode).toBe(200);
    await runner.idle();
    expect(store.require(created.json().id).engine).toBe('fake');
    const health = (await app.inject('/api/health')).json();
    expect(health).toMatchObject({ engines: ['fake'], demo: 'fake' });
  });
});

describe('public demo origin admission', () => {
  it('accepts the exact public Host and Origin and advertises the fake-only session', async () => {
    const { app, store } = await demoFixture();
    const session = await app.inject({ url: '/api/session', headers: { host: publicHost } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ mode: 'loopback', demo: 'fake' });
    expect(session.headers['x-frame-options']).toBe('DENY');
    const created = await app.inject({ method: 'POST', url: '/api/tasks', headers: { host: publicHost, origin: publicOrigin, 'sec-fetch-site': 'same-origin' },
      payload: { commandId: 'public-fake', goal: 'Public fake task' } });
    expect(created.statusCode).toBe(201);
    expect(store.list()).toHaveLength(1);
  });

  it.each([
    [{ origin: 'https://evil.example' }, 'ORIGIN_REJECTED'],
    [{ origin: 'http://demo.example.test' }, 'ORIGIN_REJECTED'],
    [{ origin: 'https://demo.example.test.evil.example' }, 'ORIGIN_REJECTED'],
    [{ origin: 'null' }, 'ORIGIN_REJECTED'],
    [{ origin: 'http://127.0.0.1:47801' }, 'ORIGIN_REJECTED'],
    [{}, 'ORIGIN_REQUIRED'],
    [{ origin: publicOrigin, 'sec-fetch-site': 'cross-site' }, 'ORIGIN_REJECTED'],
  ] as const)('rejects public mutations with %j', async (headers, code) => {
    const { app, store } = await demoFixture();
    const response = await app.inject({ method: 'POST', url: '/api/tasks', headers: { host: publicHost, ...headers }, payload: { commandId: 'foreign', goal: 'x' } });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe(code);
    expect(store.list()).toHaveLength(0);
  });

  it('requires JSON for public mutations so simple cross-site forms cannot submit', async () => {
    const { app, store } = await demoFixture();
    const response = await app.inject({ method: 'POST', url: '/api/tasks', headers: { host: publicHost, origin: publicOrigin, 'content-type': 'text/plain' },
      payload: JSON.stringify({ commandId: 'plain', goal: 'x' }) });
    expect(response.statusCode).toBe(415);
    expect(store.list()).toHaveLength(0);
  });

  it.each(['evil.example', 'demo.example.test:8443', 'sub.demo.example.test', '127.0.0.1.demo.example.test'])('rejects the foreign Host %s', async host => {
    const { app } = await demoFixture();
    const response = await app.inject({ url: '/api/session', headers: { host } });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('LOCAL_ONLY');
  });

  it('keeps loopback access working without a public origin', async () => {
    const { app } = await demoFixture({ mode: 'fake' });
    expect((await app.inject({ url: '/api/session', headers: { host: publicHost } })).json().code).toBe('LOCAL_ONLY');
    expect((await app.inject('/api/session')).json()).toEqual({ mode: 'loopback', demo: 'fake' });
    expect((await app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: 'local', goal: 'x' } })).statusCode).toBe(201);
  });
});

describe('public demo abuse limits', () => {
  it('caps stored tasks and agent profiles', async () => {
    const { app } = await demoFixture({ mode: 'fake', maxTasks: 2, maxProfiles: 4 });
    for (const id of ['a', 'b']) expect((await app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: id, goal: 'x' } })).statusCode).toBe(201);
    const third = await app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: 'c', goal: 'x' } });
    expect(third.statusCode).toBe(429);
    expect(third.json().code).toBe('DEMO_TASK_LIMIT');
    expect((await app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: 'a', goal: 'x' } })).statusCode).toBe(200);
    const profile = (commandId: string) => app.inject({ method: 'POST', url: '/api/agents', payload: { commandId, name: 'p', role: 'planner', instructions: '' } });
    expect((await profile('p1')).statusCode).toBe(201);
    expect((await profile('p2')).json().code).toBe('DEMO_PROFILE_LIMIT');
  });

  it('rate limits mutations instance-wide without limiting reads', async () => {
    const { app } = await demoFixture({ mode: 'fake', mutationsPerMinute: 2 });
    for (const id of ['a', 'b']) expect((await app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: id, goal: 'x' } })).statusCode).toBe(201);
    const limited = await app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: 'c', goal: 'x' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('DEMO_RATE_LIMIT');
    expect((await app.inject('/api/tasks')).statusCode).toBe(200);
  });

  it('refuses a data directory that already holds real workspaces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'personal-agent-demo-reuse-'));
    try {
      const normal = await buildApp({ dataDir: dir, autoRun: false, webRoot: join(dir, 'none') });
      normal.store.registerWorkspace(harmlessRepository(dir), 'Real');
      await normal.app.close();
      await expect(buildApp({ dataDir: dir, autoRun: false, demo: { mode: 'fake' } })).rejects.toMatchObject({ code: 'DEMO_CONFIG_INVALID' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('non-demo modes are unchanged', () => {
  it('loopback mode still rejects the public host and origin and keeps real-task routes', async () => {
    const { app, store, dir } = await fixture();
    expect((await app.inject({ url: '/api/session', headers: { host: publicHost } })).json().code).toBe('LOCAL_ONLY');
    expect((await app.inject({ method: 'POST', url: '/api/tasks', headers: { origin: publicOrigin }, payload: { commandId: 'x', goal: 'x' } })).json().code).toBe('ORIGIN_REJECTED');
    expect((await app.inject('/api/session')).json()).toEqual({ mode: 'loopback' });
    expect((await app.inject('/api/health')).json().engines).toEqual(['fake', 'claude']);
    const registered = await app.inject({ method: 'POST', url: '/api/workspaces', payload: { commandId: 'reg', name: 'Repo', path: harmlessRepository(dir) } });
    expect(registered.statusCode).toBe(201);
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', payload: { commandId: 's', defaultEngine: 'claude' } })).statusCode).toBe(200);
    expect(store.settings().defaultEngine).toBe('claude');
  });

  it('paired mode cannot be combined with demo mode and still rejects the demo origin', async () => {
    await expect(fixture({ demo: { mode: 'fake', publicOrigin }, security: { mode: 'paired', publicOrigin: 'https://agent.example' } }))
      .rejects.toMatchObject({ code: 'DEMO_CONFIG_INVALID' });
    const { app } = await fixture({ security: { mode: 'paired', publicOrigin: 'https://agent.example' } });
    expect((await app.inject({ url: '/api/session', headers: { host: publicHost } })).json().code).toBe('HOST_REJECTED');
  });
});

describe('demo configuration', () => {
  it.each(['http://demo.example.test', 'https://demo.example.test/', 'https://demo.example.test/path', 'https://u:p@demo.example.test',
    'https://demo.example.test?x=1', 'https://demo.example.test#x', 'https://DEMO.example.test', 'not a url'])('rejects the unsafe public origin %s', value => {
    expect(() => validateDemoConfig({ mode: 'fake', publicOrigin: value })).toThrow(expect.objectContaining({ code: 'DEMO_CONFIG_INVALID' }));
  });

  it('parses environment variables and rejects unsupported modes and limits', () => {
    expect(demoConfigFromEnv({ PERSONAL_AGENT_DEMO_PUBLIC_ORIGIN: publicOrigin, PERSONAL_AGENT_DEMO_MAX_TASKS: '50' }))
      .toEqual({ mode: 'fake', publicOrigin, maxTasks: 50, maxProfiles: 20, mutationsPerMinute: 120 });
    expect(demoConfigFromEnv({}).publicOrigin).toBeUndefined();
    for (const env of [{ PERSONAL_AGENT_DEMO_MODE: 'claude' }, { PERSONAL_AGENT_DEMO_MAX_TASKS: '0' }, { PERSONAL_AGENT_DEMO_MUTATIONS_PER_MINUTE: '1e3' }]) {
      expect(() => demoConfigFromEnv(env)).toThrow(expect.objectContaining({ code: 'DEMO_CONFIG_INVALID' }));
    }
  });

  it('keeps the persistent server out of demo mode', () => {
    expect(() => rejectDemoEnvForPersistentServer({})).not.toThrow();
    expect(() => rejectDemoEnvForPersistentServer({ PERSONAL_AGENT_DEMO_PUBLIC_ORIGIN: publicOrigin })).toThrow(expect.objectContaining({ code: 'DEMO_CONFIG_INVALID' }));
  });
});
