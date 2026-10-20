import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateDeviceKeyPair, signDeviceProof, type DeviceKeyPair } from '@personal-agent/runtime';
import { buildApp } from '../src/app.js';
import { BoxError, type BoxSnapshot, type DesktopOp, type HostAdapter } from '../src/box/host-adapter.js';
import type { BoxAction, BoxMemoryPressure } from '@personal-agent/contracts';
import { completeBrowserRfbNone, fakeVncAuthGate, mintDesktopTicket, onceMessage, openTicketedVnc } from './fixtures/rfb.js';

class FakeAdapter implements HostAdapter {
  readonly id = 'colima' as const;
  readonly kind = 'local' as const;
  running = new Set<string>();
  tokens = new Map<string, string>();
  passwords = new Map<string, string>();
  starts = 0;
  received: Buffer[] = [];
  memoryPressure: BoxMemoryPressure = 'normal';
  constructor(private readonly gatePort: () => number) {}
  async status(): Promise<BoxSnapshot> {
    return { host: { state: 'running', profile: 'pa-box' }, gateReady: true, memoryPressure: this.memoryPressure,
      container: { state: 'running', name: 'pa-box', memoryUsedBytes: 400 * 1024 ** 2, memoryLimitBytes: 3.5 * 1024 ** 3 },
      desktops: ['d1', 'd2', 'd3'].map(id => ({ id, running: this.running.has(id) })) };
  }
  actions(): BoxAction[] { return []; }
  async perform(): Promise<void> {}
  async desktop(op: DesktopOp, desktopId: string, token?: string, password?: string): Promise<void> {
    if (op === 'start') {
      const already = this.running.has(desktopId);
      this.running.add(desktopId);
      this.starts += 1;
      if (token) this.tokens.set(desktopId, token);
      // 已在运行的桌面保留原 rfbauth，和真实 pa-box-ctl 一样。
      if (password && !already) this.passwords.set(desktopId, password);
    } else {
      this.running.delete(desktopId);
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

async function fixture(options: { now?: () => number; desktop?: { token: string } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-four-layer-'));
  const adapter = new FakeAdapter(() => gate.port);
  const gate = await fakeVncAuthGate(adapter.tokens, adapter.passwords);
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); });
  cleanups.push(() => new Promise<void>(resolve => gate.server.close(() => resolve())));
  const result = await buildApp({
    dataDir: join(dir, 'data'), autoRun: false, webRoot: false, now: options.now,
    desktop: options.desktop, box: { localAdapter: adapter, sweepIntervalMs: 0, cacheMs: 0, now: options.now },
  });
  cleanups.push(() => result.app.close());
  await result.app.listen({ host: '127.0.0.1', port: 0 });
  return { ...result, adapter, gate, dir, port: (result.app.server.address() as AddressInfo).port };
}

const host = { host: '127.0.0.1:47801' };
const json = { ...host, 'content-type': 'application/json' };

async function connectDevice(
  app: { inject: Function },
  name: string,
  kind: 'desktop' | 'browser',
  extra: Record<string, string> = {},
  keys: DeviceKeyPair = generateDeviceKeyPair(),
  signedAt = Date.now(),
) {
  const challenge = (await app.inject({ method: 'GET', url: '/api/device/challenge', headers: { ...host, ...extra } })).json().challenge as string;
  const signature = signDeviceProof(keys.privateKey, { challenge, signedAt, publicKey: keys.publicKey, kind, name });
  const response = await app.inject({
    method: 'POST', url: '/api/device/connect', headers: { ...json, ...extra },
    payload: { publicKey: keys.publicKey, name, kind, challenge, signedAt, signature },
  });
  return { keys, response };
}

describe('four-layer gateway auth', () => {
  it('accepts the launch token and rejects a wrong token', async () => {
    const token = 'A'.repeat(43);
    const { app } = await fixture({ desktop: { token } });
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: host })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: { ...host, authorization: `Bearer ${'B'.repeat(43)}` } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/api/health', headers: { ...host, authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toContain(token);
  });

  it('rejects an expired desktop ticket using a fake clock', async () => {
    let now = Date.parse('2026-10-20T12:00:00Z');
    const { app, port } = await fixture({ now: () => now });
    const ticket = await mintDesktopTicket(app, 'd1');
    now += 61_000;
    await expect(openTicketedVnc(port, 'd1', ticket)).rejects.toMatchObject({ status: 401 });
  });

  it('allows a desktop ticket to be used only once', async () => {
    const { app, port } = await fixture();
    const ticket = await mintDesktopTicket(app, 'd1');
    const first = await openTicketedVnc(port, 'd1', ticket);
    await completeBrowserRfbNone(first);
    first.close();
    await expect(openTicketedVnc(port, 'd1', ticket)).rejects.toMatchObject({ status: 401 });
  });

  it('blocks an unpaired second desktop client from protected APIs', async () => {
    const { app } = await fixture();
    const pending = await connectDevice(app, 'Second desktop', 'desktop');
    expect(pending.response.statusCode).toBe(403);
    expect(pending.response.json().code).toBe('PAIRING_REQUIRED');
    const deviceId = pending.response.json().deviceId as string;
    const blocked = await app.inject({
      method: 'GET', url: '/api/tasks',
      headers: { ...host, 'x-pa-device-id': deviceId, 'x-pa-device-session': 'S'.repeat(43) },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('PAIRING_REQUIRED');
  });

  it('lets an implicit operator approve a pending device as observer, then drops desktop input', async () => {
    const { app, port } = await fixture();
    const pending = await connectDevice(app, 'LAN browser', 'desktop');
    const deviceId = pending.response.json().deviceId as string;
    const approved = await app.inject({
      method: 'POST', url: `/api/client-devices/${deviceId}/approve`,
      headers: json, payload: { commandId: 'approve-observer', role: 'observer' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'approved', role: 'observer' });

    const connected = await connectDevice(app, 'LAN browser', 'desktop', {}, pending.keys);
    expect(connected.response.statusCode).toBe(200);
    const session = connected.response.json().deviceSession as string;
    const observer = { ...json, 'x-pa-device-id': connected.keys.id, 'x-pa-device-session': session };

    const write = await app.inject({
      method: 'POST', url: '/api/box/deployments/local/desktops/d1/start',
      headers: observer, payload: { commandId: 'observer-start' },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().code).toBe('PERMISSION_DENIED');

    const stoppedTicket = await mintDesktopTicket(app, 'd1', observer);
    await expect(openTicketedVnc(port, 'd1', stoppedTicket, observer)).rejects.toMatchObject({ status: 403 });

    expect((await app.inject({
      method: 'POST', url: '/api/box/deployments/local/desktops/d1/start',
      headers: json, payload: { commandId: 'operator-start' },
    })).statusCode).toBe(200);

    const ticket = await mintDesktopTicket(app, 'd1', observer);
    const ticketBody = (await app.inject({
      method: 'POST', url: '/api/box/deployments/local/desktops/d1/tickets', headers: observer,
    })).body;
    expect(ticketBody).not.toMatch(/password|rfbauth|vncpasswd/i);

    const ws = await openTicketedVnc(port, 'd1', ticket, observer);
    await completeBrowserRfbNone(ws);
    // 只读：KeyEvent 在服务端丢弃，FramebufferUpdateRequest 仍然转发并被假桌面回显。
    ws.send(Buffer.from([4, 1, 0, 0, 0, 0, 0xff, 0x0d]));
    ws.send(Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    const echoed = await onceMessage(ws);
    expect([...echoed]).toEqual([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...echoed]).not.toContain(4);
    ws.close();
  });

  it('never returns the VNC password in API or ticket responses', async () => {
    const { app, dir } = await fixture();
    const started = await app.inject({
      method: 'POST', url: '/api/box/deployments/local/desktops/d1/start',
      headers: json, payload: { commandId: 'start-d1' },
    });
    expect(started.statusCode).toBe(200);
    const secrets = JSON.parse(readFileSync(join(dir, 'data', 'box-vnc-secrets.json'), 'utf8')) as Record<string, string>;
    const password = secrets['local/d1'];
    expect(password.length).toBeGreaterThanOrEqual(8);
    const listed = await app.inject({ method: 'GET', url: '/api/box/deployments', headers: host });
    const minted = await app.inject({ method: 'POST', url: '/api/box/deployments/local/desktops/d1/tickets', headers: host });
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: host });
    for (const body of [started.body, listed.body, minted.body, session.body]) {
      expect(body).not.toContain(password);
      expect(body).not.toMatch(/rfbauth|vncpasswd/i);
    }
    expect(minted.json()).toMatchObject({ control: true, desktopId: 'd1' });
    expect(minted.json().ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('regenerates the VNC password and restarts when the secrets file is gone', async () => {
    const first = await fixture();
    expect((await first.app.inject({
      method: 'POST', url: '/api/box/deployments/local/desktops/d1/start',
      headers: json, payload: { commandId: 'start-d1' },
    })).statusCode).toBe(200);
    const old = first.adapter.passwords.get('d1');
    expect(old).toHaveLength(8);
    await first.app.close();

    const dir = mkdtempSync(join(tmpdir(), 'personal-agent-four-layer-'));
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); });
    const second = await buildApp({
      dataDir: join(dir, 'data'), autoRun: false, webRoot: false,
      box: { localAdapter: first.adapter, sweepIntervalMs: 0, cacheMs: 0 },
    });
    cleanups.push(() => second.app.close());
    await second.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (second.app.server.address() as AddressInfo).port;
    const ticket = await mintDesktopTicket(second.app, 'd1');
    const ws = await openTicketedVnc(port, 'd1', ticket);
    await completeBrowserRfbNone(ws);
    expect(first.adapter.passwords.get('d1')).toBeDefined();
    expect(first.adapter.passwords.get('d1')).not.toBe(old);
    expect(first.adapter.starts).toBeGreaterThanOrEqual(2);
    ws.close();
  });
});
