import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { assertLoopbackAddress, startDesktopServer } from '../src/desktop.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-desktop-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const newToken = () => randomBytes(32).toString('base64url');

/** 原始 HTTP 请求：可以发送重复的 Authorization 头（inject 会合并它们）。 */
function rawGet(port: number, path: string, headers: [string, string][] = []): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // 以扁平数组形式传头时 Node 不会自动补 Host，这里显式补上（除非用例要测试别的 Host）。
    const flat = (headers.some(([name]) => name === 'host') ? headers : [['host', `127.0.0.1:${port}`], ...headers]).flat();
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: flat.length ? flat as unknown as Record<string, string> : undefined }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    req.once('error', reject);
    req.end();
  });
}

describe('desktop token mode', () => {
  it('binds only to 127.0.0.1 on a random port and requires the per-launch bearer token', async () => {
    const token = newToken();
    const server = await startDesktopServer({ dataDir: join(tempDir(), 'data'), token, autoRun: false, box: false });
    cleanups.push(() => server.close());
    const address = server.app.server.address();
    expect(address).toMatchObject({ address: '127.0.0.1', family: 'IPv4', port: server.port });
    expect(server.port).not.toBe(47801);

    expect((await rawGet(server.port, '/api/health')).status).toBe(401);
    expect((await rawGet(server.port, '/api/health', [['authorization', `Bearer ${newToken()}`]])).status).toBe(401);
    expect((await rawGet(server.port, '/api/health', [['authorization', `bearer ${token}`]])).status).toBe(401);
    expect((await rawGet(server.port, '/api/health', [['authorization', `Bearer ${token}`], ['authorization', `Bearer ${token}`]])).status).toBe(401);
    const ok = await rawGet(server.port, '/api/health', [['authorization', `Bearer ${token}`]]);
    expect(ok.status).toBe(200);
    // 401 响应体只给错误码，绝不回显令牌。
    const denied = await rawGet(server.port, '/api/session', [['authorization', `Bearer ${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`]]);
    expect(denied.body).toContain('DESKTOP_TOKEN_REQUIRED');
    expect(denied.body).not.toContain(token.slice(0, 20));
    const session = await rawGet(server.port, '/api/session', [['authorization', `Bearer ${token}`]]);
    expect(JSON.parse(session.body)).toEqual({ mode: 'loopback', desktop: true });
    // 非回环 Host 仍被拒绝：令牌不会放宽 loopback 边界（防 DNS rebinding）。
    expect((await rawGet(server.port, '/api/health', [['authorization', `Bearer ${token}`], ['host', 'evil.example']])).status).toBe(403);
    // 不托管静态页面。
    expect((await rawGet(server.port, '/', [['authorization', `Bearer ${token}`]])).status).toBe(404);
  });

  it('enables box routes in managed mode and still requires the launch token', async () => {
    const token = newToken();
    const server = await startDesktopServer({ dataDir: join(tempDir(), 'data'), token, autoRun: false });
    cleanups.push(() => server.close());
    expect((await rawGet(server.port, '/api/box/deployments')).status).toBe(401);
    expect((await rawGet(server.port, '/api/box/deployments', [['authorization', `Bearer ${token}`]])).status).toBe(200);
    const agent = await server.app.inject({ method: 'POST', url: '/api/box/agent/register', payload: { ticket: 'A'.repeat(43) } });
    expect(agent.statusCode).not.toBe(404);
  });

  it('does not mount /api/box when box is explicitly disabled', async () => {
    const token = newToken();
    const server = await startDesktopServer({ dataDir: join(tempDir(), 'data'), token, autoRun: false, box: false });
    cleanups.push(() => server.close());
    expect((await rawGet(server.port, '/api/box/deployments', [['authorization', `Bearer ${token}`]])).status).toBe(404);
    expect((await server.app.inject({ method: 'POST', url: '/api/box/agent/register', payload: { ticket: 'A'.repeat(43) } })).statusCode).toBe(404);
  });

  it('rejects malformed tokens and refuses to combine with paired access or demo mode', async () => {
    await expect(startDesktopServer({ dataDir: join(tempDir(), 'data'), token: 'short', autoRun: false, box: false }))
      .rejects.toMatchObject({ code: 'DESKTOP_CONFIG_INVALID' });
    const pairedDir = join(tempDir(), 'data');
    const paired = await buildApp({ dataDir: pairedDir, autoRun: false, box: false, webRoot: false,
      security: { mode: 'paired', publicOrigin: 'https://agent.example.test' } });
    await paired.app.close();
    await expect(startDesktopServer({ dataDir: pairedDir, token: newToken(), autoRun: false, box: false }))
      .rejects.toMatchObject({ code: 'DESKTOP_CONFIG_INVALID' });
    await expect(buildApp({ dataDir: join(tempDir(), 'data'), autoRun: false, box: false, webRoot: false, desktop: { token: newToken() },
      demo: { mode: 'fake', publicOrigin: 'https://demo.example.test' } as never })).rejects.toBeTruthy();
  });

  it('only accepts IPv4 loopback listener addresses', () => {
    expect(assertLoopbackAddress({ address: '127.0.0.1', family: 'IPv4', port: 5000 })).toBe(5000);
    for (const bad of [null, '/tmp/sock', { address: '0.0.0.0', family: 'IPv4', port: 1 }, { address: '::1', family: 'IPv6', port: 1 },
      { address: '::', family: 'IPv6', port: 1 }, { address: '127.0.0.1', family: 'IPv4', port: 0 }]) {
      expect(() => assertLoopbackAddress(bad as never)).toThrow(expect.objectContaining({ code: 'DESKTOP_BIND_UNSAFE' }));
    }
  });
});

describe('desktop-main IPC entry', () => {
  const entryPath = join(import.meta.dirname, '..', 'src', 'desktop-main.ts');
  const entry = process.platform === 'win32' ? pathToFileURL(entryPath).href : entryPath;
  const tsx = createRequire(import.meta.url).resolve('tsx');
  function launch() {
    const child = fork(entry, [], { execArgv: ['--import', tsx], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, PERSONAL_AGENT_DATA_DIR: '' } });
    let output = '';
    child.stdout!.on('data', chunk => { output += chunk; });
    child.stderr!.on('data', chunk => { output += chunk; });
    const messages: any[] = [];
    child.on('message', message => messages.push(message));
    const next = (type: string) => new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}: ${output}`)), 20_000);
      const check = () => {
        const found = messages.find(message => message.type === type);
        if (found) { clearTimeout(timer); child.off('message', check); resolve(found); }
      };
      child.on('message', check); check();
    });
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    cleanups.push(async () => { if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } });
    return { child, next, exited, output: () => output };
  }

  it('receives the token over IPC, reports only the port and shuts down cleanly', async () => {
    const token = newToken();
    const dataDir = join(tempDir(), 'data');
    const { child, next, exited, output } = launch();
    child.send({ type: 'start', token, dataDir });
    const ready = await next('ready');
    expect(Object.keys(ready).sort()).toEqual(['port', 'type']);
    expect((await rawGet(ready.port, '/api/health')).status).toBe(401);
    expect((await rawGet(ready.port, '/api/health', [['authorization', `Bearer ${token}`]])).status).toBe(200);
    // 令牌从不出现在 argv、env 或任何输出中。
    expect(child.spawnargs.join(' ')).not.toContain(token);
    child.send({ type: 'shutdown' });
    expect(await next('stopped')).toMatchObject({ exitCode: 0 });
    expect(await exited).toBe(0);
    expect(output()).not.toContain(token);
    await expect(rawGet(ready.port, '/api/health')).rejects.toBeTruthy();
  }, 40_000);

  it('reports a fixed error code for invalid start messages and exits non-zero', async () => {
    const { child, next, exited } = launch();
    child.send({ type: 'start', token: 'not-a-token' });
    expect(await next('error')).toEqual({ type: 'error', code: 'DESKTOP_CONFIG_INVALID' });
    expect(await exited).toBe(1);
  }, 40_000);

  it('shuts down when the parent IPC channel disconnects', async () => {
    const { child, next, exited } = launch();
    child.send({ type: 'start', token: newToken(), dataDir: join(tempDir(), 'data') });
    await next('ready');
    child.disconnect();
    expect(await exited).toBe(0);
  }, 40_000);
});
