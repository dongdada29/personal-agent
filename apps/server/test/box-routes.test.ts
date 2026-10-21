import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { BoxAction, BoxMemoryPressure } from '@personal-agent/contracts';
import { buildApp, type AppOptions } from '../src/app.js';
import type { BoxSnapshot, DesktopOp, HostAdapter } from '../src/box/host-adapter.js';
import { BoxError } from '../src/box/host-adapter.js';
import { completeBrowserRfbNone, fakeVncAuthGate, mintDesktopTicket, onceMessage, openTicketedVnc } from './fixtures/rfb.js';

class FakeAdapter implements HostAdapter {
  readonly id = 'colima' as const;
  readonly kind = 'local' as const;
  running = new Set<string>();
  tokens = new Map<string, string>();
  passwords = new Map<string, string>();
  ops: { op: DesktopOp; desktopId: string; tokenOnStdin: boolean; passwordOnStdin: boolean }[] = [];
  memoryPressure: BoxMemoryPressure = 'normal';
  constructor(private readonly gatePort: () => number) {}
  async status(): Promise<BoxSnapshot> {
    return { host: { state: 'running', profile: 'pa-box' }, gateReady: true, memoryPressure: this.memoryPressure,
      container: { state: 'running', name: 'pa-box', memoryUsedBytes: 400 * 1024 ** 2, memoryLimitBytes: 3.5 * 1024 ** 3 },
      desktops: ['d1', 'd2', 'd3'].map(id => ({ id, running: this.running.has(id) })) };
  }
  actions(): BoxAction[] { return ['stop_vm', 'stop_container']; }
  async perform(): Promise<void> {}
  async desktop(op: DesktopOp, desktopId: string, token?: string, password?: string): Promise<void> {
    this.ops.push({ op, desktopId, tokenOnStdin: !!token, passwordOnStdin: !!password });
    if (op === 'start') {
      const already = this.running.has(desktopId);
      this.running.add(desktopId);
      this.tokens.set(desktopId, token!);
      if (password && !already) this.passwords.set(desktopId, password);
    } else {
      this.running.delete(desktopId);
      this.tokens.delete(desktopId);
      this.passwords.delete(desktopId);
    }
  }
  openGate() {
    return new Promise<import('node:stream').Duplex>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: this.gatePort() }, () => resolve(socket));
      socket.once('error', () => reject(new BoxError('BOX_DESKTOP_UNREACHABLE', 'unreachable', 502)));
    });
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: Partial<AppOptions> = {}, clock?: { now: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-box-routes-'));
  const adapter = new FakeAdapter(() => gate.port);
  const gate = await fakeVncAuthGate(adapter.tokens, adapter.passwords);
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); });
  cleanups.push(() => new Promise<void>(resolve => gate.server.close(() => resolve())));
  const now = clock ? () => clock.now : options.now;
  const result = await buildApp({ dataDir: join(dir, 'data'), autoRun: false, webRoot: false, now,
    box: { localAdapter: adapter, sweepIntervalMs: 0, cacheMs: 0, ...(now ? { now } : {}) }, ...options });
  cleanups.push(() => result.app.close());
  return { ...result, adapter, gate, dir };
}

const json = { 'content-type': 'application/json' };
const commandId = () => `cmd-${Math.random().toString(36).slice(2)}`;

async function listen(app: Awaited<ReturnType<typeof buildApp>>['app']): Promise<number> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  return (app.server.address() as AddressInfo).port;
}

async function openDesktop(app: { inject: Function }, port: number, desktopId: string, headers: Record<string, string> = {}) {
  const ticket = await mintDesktopTicket(app, desktopId, headers);
  const ws = await openTicketedVnc(port, desktopId, ticket, headers);
  await completeBrowserRfbNone(ws);
  return { ws, ticket };
}

function rejectUpgrade(port: number, desktopId: string, headers: Record<string, string> = {}, protocols: string[] = ['binary']): Promise<never> {
  return new Promise((_, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/box/deployments/local/desktops/${desktopId}/vnc`, protocols, { headers });
    ws.once('unexpected-response', (_request, response) => reject(Object.assign(new Error(`HTTP ${response.statusCode}`), { status: response.statusCode })));
    ws.once('error', reject);
  });
}

describe('box deployments API', () => {
  it('lists the local deployment with the L0 desktop policy', async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: 'GET', url: '/api/box/deployments', headers: { host: '127.0.0.1:47801' } });
    expect(response.statusCode).toBe(200);
    const local = response.json().deployments[0];
    expect(local).toMatchObject({ id: 'local', kind: 'local', memoryPressure: 'normal',
      desktopPolicy: { concurrent: 2, max: 3, budgetBytesPerDesktop: Math.round(0.7 * 1024 ** 3), idleStopMinutes: 15 } });
    expect(local.desktops.map((item: any) => [item.id, item.state, item.streamable])).toEqual([['d1', 'stopped', true], ['d2', 'stopped', true], ['d3', 'stopped', true]]);
  });

  it('starts desktops up to the concurrency limit, then refuses; refuses at memory pressure warn', async () => {
    const { app, adapter } = await fixture();
    const start = (desktop: string) => app.inject({ method: 'POST', url: `/api/box/deployments/local/desktops/${desktop}/start`, headers: { host: '127.0.0.1:47801', ...json }, payload: { commandId: commandId() } });
    expect((await start('d1')).statusCode).toBe(200);
    expect((await start('d2')).statusCode).toBe(200);
    const third = await start('d3');
    expect(third.statusCode).toBe(409);
    expect(third.json().code).toBe('BOX_DESKTOP_LIMIT');
    expect(adapter.ops.every(op => op.tokenOnStdin)).toBe(true);
    const stop = await app.inject({ method: 'POST', url: '/api/box/deployments/local/desktops/d2/stop', headers: { host: '127.0.0.1:47801', ...json }, payload: { commandId: commandId() } });
    expect(stop.statusCode).toBe(200);
    adapter.memoryPressure = 'warn';
    const refused = await start('d3');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('BOX_MEMORY_PRESSURE');
    expect((await start('d4')).statusCode).toBe(400);
  });

  it('streams a desktop over an authenticated WebSocket through the gate with a fresh per-open token', async () => {
    const { app, adapter, gate } = await fixture();
    const port = await listen(app);
    const first = await openDesktop(app, port, 'd1', { origin: 'http://127.0.0.1:47801' });
    expect(first.ws.protocol).toBe('binary');
    const marker = Buffer.from([9, 8, 7, 6]);
    first.ws.send(marker);
    const echoed = await onceMessage(first.ws);
    expect([...echoed]).toEqual([9, 8, 7, 6]);

    const listed = await app.inject({ method: 'GET', url: '/api/box/deployments', headers: { host: '127.0.0.1:47801' } });
    expect(listed.json().deployments[0].desktops[0]).toMatchObject({ id: 'd1', state: 'running', viewers: 1 });

    // 第二次打开会轮换网关令牌；令牌与 VNC 口令从不出现在 HTTP 响应中。
    const second = await openDesktop(app, port, 'd1', { origin: 'http://127.0.0.1:47801' });
    expect(new Set(gate.preambles.map(line => line.split(' ')[3])).size).toBe(2);
    expect(listed.body).not.toContain(adapter.tokens.get('d1')!);
    expect(adapter.ops.filter(op => op.op === 'start').every(op => op.passwordOnStdin)).toBe(true);
    first.ws.close();
    second.ws.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    const after = await app.inject({ method: 'GET', url: '/api/box/deployments', headers: { host: '127.0.0.1:47801' } });
    expect(after.json().deployments[0].desktops[0]).toMatchObject({ viewers: 0 });
    expect(after.json().deployments[0].desktops[0].idleStopAt).toEqual(expect.any(String));
  });

  it('rejects a WebSocket without a desktop ticket after the connection token is accepted', async () => {
    const { app } = await fixture();
    const port = await listen(app);
    await expect(rejectUpgrade(port, 'd1', { origin: 'http://127.0.0.1:47801' })).rejects.toMatchObject({ status: 401 });
  });

  it('rejects cross-origin WebSocket upgrades and non-WebSocket upgrades', async () => {
    const { app, adapter } = await fixture();
    const port = await listen(app);
    await expect(rejectUpgrade(port, 'd1', { origin: 'https://evil.example' })).rejects.toMatchObject({ status: 403 });
    await expect(rejectUpgrade(port, 'd9')).rejects.toMatchObject({ status: 404 });
    expect(adapter.ops).toEqual([]);
  });

  it('refuses to open a stopped desktop when at the concurrency limit, with an HTTP status before upgrading', async () => {
    const { app, adapter } = await fixture();
    adapter.running.add('d1');
    adapter.running.add('d2');
    const port = await listen(app);
    const ticket = await mintDesktopTicket(app, 'd3');
    await expect(openTicketedVnc(port, 'd3', ticket)).rejects.toMatchObject({ status: 409 });
  });

  it('stops desktops nobody has viewed for idleStopMinutes', async () => {
    const clock = { now: Date.parse('2026-10-20T00:00:00Z') };
    const { app, adapter, box } = await fixture({}, clock);
    const port = await listen(app);
    const viewer = await openDesktop(app, port, 'd1');
    clock.now += 60 * 60_000;
    // 有人在看：不停。
    expect(await box!.sweepIdleDesktops()).toEqual([]);
    viewer.ws.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    clock.now += 14 * 60_000;
    expect(await box!.sweepIdleDesktops()).toEqual([]);
    clock.now += 2 * 60_000;
    expect(await box!.sweepIdleDesktops()).toEqual(['local/d1']);
    expect(adapter.running.has('d1')).toBe(false);
    expect(adapter.ops.at(-1)).toMatchObject({ op: 'stop', desktopId: 'd1' });
  });
});

describe('desktop-token mode (Electron managed server)', () => {
  const token = 'T'.repeat(43);

  it('requires the per-launch bearer token on API requests and VNC upgrades', async () => {
    const { app } = await fixture({ desktop: { token } });
    const missing = await app.inject({ method: 'GET', url: '/api/box/deployments', headers: { host: '127.0.0.1:47801' } });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().code).toBe('DESKTOP_TOKEN_REQUIRED');
    const wrong = await app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:47801', authorization: `Bearer ${'X'.repeat(43)}` } });
    expect(wrong.statusCode).toBe(401);
    const good = await app.inject({ method: 'GET', url: '/api/box/deployments', headers: { host: '127.0.0.1:47801', authorization: `Bearer ${token}` } });
    expect(good.statusCode).toBe(200);
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: { host: '127.0.0.1:47801', authorization: `Bearer ${token}` } });
    expect(session.json()).toMatchObject({ mode: 'loopback', desktop: true });
    expect(session.body).not.toContain(token);

    const port = await listen(app);
    await expect(rejectUpgrade(port, 'd1')).rejects.toMatchObject({ status: 401 });
    const viewer = await openDesktop(app, port, 'd1', { authorization: `Bearer ${token}` });
    expect(viewer.ws.protocol).toBe('binary');
    viewer.ws.close();
  });

  it('rejects duplicated authorization headers and cannot be combined with demo mode', async () => {
    const { app } = await fixture({ desktop: { token } });
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:47801', authorization: [`Bearer ${token}`, `Bearer ${token}`] as unknown as string } });
    expect(response.statusCode).toBe(401);
    await expect(fixture({ desktop: { token }, demo: { mode: 'fake', publicOrigin: 'https://demo.example.test' } })).rejects.toMatchObject({ code: 'DESKTOP_CONFIG_INVALID' });
    await expect(fixture({ desktop: { token: 'short' } })).rejects.toMatchObject({ code: 'DESKTOP_CONFIG_INVALID' });
  });
});

describe('demo instance box surface stays fake-only', () => {
  it('serves fake deployments and refuses every write and upgrade', async () => {
    const { app, adapter } = await fixture({ demo: { mode: 'fake', publicOrigin: 'https://demo.example.test' } });
    const headers = { host: 'demo.example.test' };
    const list = await app.inject({ method: 'GET', url: '/api/box/deployments', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().deployments.every((item: any) => item.fake === true && item.desktops.every((desktop: any) => !desktop.streamable))).toBe(true);
    for (const url of ['/api/box/deployments/local/desktops/d1/start', '/api/box/deployments/local/actions', '/api/box/deployments/local/tickets', '/api/box/deployments']) {
      const payload = url.endsWith('actions') ? { commandId: commandId(), action: 'start_container' } : url.endsWith('deployments') ? { commandId: commandId(), name: 'x', connection: 'agent' } : { commandId: commandId() };
      const response = await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://demo.example.test', ...json }, payload });
      expect(response.statusCode, url).toBe(403);
      expect(response.json().code).toBe('DEMO_FAKE_ONLY');
    }
    const port = await listen(app);
    await expect(rejectUpgrade(port, 'd1', { host: 'demo.example.test', origin: 'https://demo.example.test' })).rejects.toMatchObject({ status: 403 });
    expect(adapter.ops).toEqual([]);
  });
});
