/**
 * 四层鉴权的本机实弹检查。默认监听 127.0.0.1:47991（避开正式 47801 与 demo 47811），
 * 使用临时数据目录和假 box 适配器，不启动 Colima / Docker，也不切换 docker context。
 *
 *   PERSONAL_AGENT_VERIFY_PORT=47991 node --import tsx scripts/verify-four-layer-auth.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDeviceKeyPair, signDeviceProof } from '@personal-agent/runtime';
import { buildApp } from '../apps/server/src/app.js';
import { BoxError, type BoxSnapshot, type DesktopOp, type HostAdapter } from '../apps/server/src/box/host-adapter.js';
import { fakeVncAuthGate } from '../apps/server/test/fixtures/rfb.js';

const port = Number(process.env.PERSONAL_AGENT_VERIFY_PORT ?? 47991);
if (!Number.isInteger(port) || port < 1024 || port === 47801 || port === 47811) {
  console.error('PERSONAL_AGENT_VERIFY_PORT must be an unused loopback port other than 47801/47811');
  process.exit(1);
}

class FakeAdapter implements HostAdapter {
  readonly id = 'colima' as const;
  readonly kind = 'local' as const;
  running = new Set<string>(['d1']);
  tokens = new Map<string, string>([['d1', 'T'.repeat(43)]]);
  passwords = new Map<string, string>();
  constructor(private readonly gatePort: () => number) {}
  async status(): Promise<BoxSnapshot> {
    return {
      host: { state: 'running', profile: 'pa-box' }, gateReady: true, memoryPressure: 'normal',
      container: { state: 'running', name: 'pa-box', memoryUsedBytes: 400 * 1024 ** 2, memoryLimitBytes: 3.5 * 1024 ** 3 },
      desktops: [{ id: 'd1', running: true }, { id: 'd2', running: false }, { id: 'd3', running: false }],
    };
  }
  actions() { return []; }
  async perform(): Promise<void> {}
  async desktop(op: DesktopOp, desktopId: string, token?: string, password?: string): Promise<void> {
    if (op === 'start') {
      const already = this.running.has(desktopId);
      this.running.add(desktopId);
      if (token) this.tokens.set(desktopId, token);
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

const dir = mkdtempSync(join(tmpdir(), 'personal-agent-verify-auth-'));
const token = 'A'.repeat(43);
let clock = Date.parse('2026-10-20T12:00:00Z');
const adapter = new FakeAdapter(() => gate.port);
const gate = await fakeVncAuthGate(adapter.tokens, adapter.passwords);
const { app } = await buildApp({
  dataDir: join(dir, 'data'), autoRun: false, webRoot: false, now: () => clock,
  desktop: { token }, box: { localAdapter: adapter, sweepIntervalMs: 0, cacheMs: 0, now: () => clock },
});

const fail = (label: string, detail: string): never => {
  console.error(`FAIL ${label}: ${detail}`);
  process.exitCode = 1;
  throw new Error(detail);
};

try {
  await app.listen({ host: '127.0.0.1', port });
  const origin = `http://127.0.0.1:${port}`;
  console.log(`verify listener ${origin} (data ${dir})`);

  const call = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('host')) headers.set('host', `127.0.0.1:${port}`);
    return fetch(`${origin}${path}`, { ...init, headers });
  };

  const good = await call('/api/health', { headers: { authorization: `Bearer ${token}` } });
  if (good.status !== 200) fail('token-ok', `expected 200 got ${good.status}`);
  console.log('PASS token-ok');

  const bad = await call('/api/health', { headers: { authorization: `Bearer ${'B'.repeat(43)}` } });
  if (bad.status !== 401) fail('token-deny', `expected 401 got ${bad.status}`);
  console.log('PASS token-deny');

  const mint = async () => {
    const minted = await call('/api/box/deployments/local/desktops/d1/tickets', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
    });
    if (minted.status !== 200) fail('ticket-mint', `expected 200 got ${minted.status}`);
    return (await minted.json() as { ticket: string }).ticket;
  };
  const upgrade = (ticket: string) => new Promise<number>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write([
        `GET /api/box/deployments/local/desktops/d1/vnc HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Protocol: binary, pa-dt.' + ticket,
        `Authorization: Bearer ${token}`,
        '',
        '',
      ].join('\r\n'));
    });
    socket.once('data', chunk => {
      const match = /^HTTP\/1\.\d (\d+)/.exec(chunk.toString('latin1'));
      socket.destroy();
      if (!match) reject(new Error('no HTTP status'));
      else resolve(Number(match[1]));
    });
    socket.once('error', reject);
  });

  const fresh = await mint();
  const usable = await upgrade(fresh);
  if (usable !== 101) fail('ticket-usable', `expected 101 got ${usable}`);
  console.log('PASS ticket-usable');
  const reused = await upgrade(fresh);
  if (reused !== 401) fail('ticket-one-use', `expected 401 got ${reused}`);
  console.log('PASS ticket-one-use');

  const expiredTicket = await mint();
  clock += 61_000;
  const expired = await upgrade(expiredTicket);
  if (expired !== 401) fail('ticket-expired', `expected 401 got ${expired}`);
  console.log('PASS ticket-expired');

  // 局域网浏览器即使带了启动令牌也必须等待批准（只有托管桌面本身会自动批准）。
  const keys = generateDeviceKeyPair();
  const challenge = await (await call('/api/device/challenge', { headers: { authorization: `Bearer ${token}` } })).json() as { challenge: string };
  const signedAt = clock;
  const signature = signDeviceProof(keys.privateKey, {
    challenge: challenge.challenge, signedAt, publicKey: keys.publicKey, kind: 'browser', name: 'LAN browser',
  });
  const pending = await call('/api/device/connect', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ publicKey: keys.publicKey, name: 'LAN browser', kind: 'browser', challenge: challenge.challenge, signedAt, signature }),
  });
  const pendingBody = await pending.json() as { code?: string };
  if (pending.status !== 403 || pendingBody.code !== 'PAIRING_REQUIRED') {
    fail('unpaired-blocked', `expected 403 PAIRING_REQUIRED got ${pending.status} ${JSON.stringify(pendingBody)}`);
  }
  console.log('PASS unpaired-blocked');
  console.log('PASS four-layer-auth verify');
} finally {
  await app.close();
  await new Promise<void>(resolve => gate.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
}
