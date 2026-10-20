import { fork, type ForkOptions } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSettings, normalizeSettings, saveSettings } from '../src/config.js';
import { parseConnectUrl, probeInstance } from '../src/connect-mode.js';
import { newLaunchToken, serverEnvironment, ServerSupervisor } from '../src/server-supervisor.js';

const fixture = join(import.meta.dirname, 'fixtures', 'fake-server.mjs');
const supervisors: ServerSupervisor[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map(supervisor => supervisor.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise(done => server.close(done))));
});

function supervisor(behavior: string, options: Partial<ConstructorParameters<typeof ServerSupervisor>[0]> = {}) {
  // execPath 默认是当前 Node（测试里没有 Electron；ELECTRON_RUN_AS_NODE 对普通 Node 无影响）。
  // fake-server 通过 argv[2] 选择行为；生产调用不传任何 argv。
  const forkImpl = ((entry: string, _args: readonly string[], forkOptions: ForkOptions) => fork(entry, [behavior], forkOptions)) as typeof fork;
  const instance = new ServerSupervisor({ entry: fixture, dataDir: '/unused', execArgv: [], forkImpl, ...options });
  supervisors.push(instance);
  return instance;
}

const get = (port: number, token?: string) => fetch(`http://127.0.0.1:${port}/`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('managed server supervisor', () => {
  it('generates a 43-char base64url token per launch', () => {
    const a = newLaunchToken(), b = newLaunchToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(a).not.toBe(b);
  });

  it('sends the token over IPC only and reports the port', async () => {
    const instance = supervisor('echo-env');
    const port = await instance.start();
    expect(instance.state).toBe('running');
    const body = await (await get(port, instance.token)).json();
    expect(JSON.stringify(body.env)).not.toContain(instance.token);
    expect(body.argv.join(' ')).not.toContain(instance.token);
    expect(body.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(body.env.NODE_OPTIONS).toBeUndefined();
    expect(await instance.stop()).toBe('clean');
    expect(instance.state).toBe('stopped');
  });

  it('surfaces fixed startup error codes, timeouts and unexpected exits', async () => {
    await expect(supervisor('error').start()).rejects.toMatchObject({ code: 'INSTANCE_LOCKED' });
    await expect(supervisor('hang', { startTimeoutMs: 300 }).start()).rejects.toMatchObject({ code: 'DESKTOP_SERVER_TIMEOUT' });
    const crashing = supervisor('crash-after-ready');
    const exited = new Promise(resolve => crashing.once('unexpected-exit', resolve));
    await crashing.start();
    expect(await exited).toBe(3);
    expect(crashing.state).toBe('failed');
  });

  it('kills a server that ignores shutdown after the stop timeout', async () => {
    const instance = supervisor('ignore-shutdown', { stopTimeoutMs: 300 });
    await instance.start();
    expect(await instance.stop()).toBe('killed');
    expect(await instance.stop()).toBe('not-running');
  });

  it('removes Node startup overrides and demo variables from the server environment', () => {
    const env = serverEnvironment({ PATH: '/bin', NODE_OPTIONS: '--require evil', ELECTRON_RUN_AS_NODE: '0', PERSONAL_AGENT_DEMO_PUBLIC_ORIGIN: 'x', HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', ELECTRON_RUN_AS_NODE: '1' });
  });
});

describe('connect mode and settings', () => {
  it('only accepts plain loopback http URLs', () => {
    expect(parseConnectUrl('http://127.0.0.1:47801')).toEqual({ port: 47801, url: 'http://127.0.0.1:47801' });
    expect(parseConnectUrl('http://localhost:5000/')).toEqual({ port: 5000, url: 'http://127.0.0.1:5000' });
    for (const bad of ['https://127.0.0.1:47801', 'http://0.0.0.0:47801', 'http://192.0.2.1:47801', 'http://a:b@127.0.0.1:1', 'http://127.0.0.1:1/x', 'nope']) {
      expect(parseConnectUrl(bad), bad).toBeUndefined();
    }
  });

  it('probes for a loopback Personal Agent instance', async () => {
    const answers: Record<string, [number, string]> = {};
    const server = createServer((request, response) => {
      const [status, body] = answers.current;
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(body);
    });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    answers.current = [200, '{"mode":"loopback"}'];
    expect(await probeInstance(port)).toEqual({ ok: true });
    answers.current = [200, '{"mode":"paired","device":{}}'];
    expect(await probeInstance(port)).toEqual({ ok: false, code: 'NOT_LOOPBACK' });
    answers.current = [401, '{"code":"DESKTOP_TOKEN_REQUIRED"}'];
    expect(await probeInstance(port)).toEqual({ ok: false, code: 'DESKTOP_INSTANCE' });
    answers.current = [200, '<html>'];
    expect(await probeInstance(port)).toEqual({ ok: false, code: 'NOT_PERSONAL_AGENT' });
    await new Promise(done => servers.pop()!.close(done));
    expect(await probeInstance(port)).toEqual({ ok: false, code: 'UNREACHABLE' });
  });

  it('persists settings atomically and normalizes invalid values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-desktop-settings-'));
    try {
      const file = join(dir, 'nested', 'desktop-settings.json');
      expect(loadSettings(file)).toEqual({ mode: 'managed', connectUrl: 'http://127.0.0.1:47801' });
      saveSettings(file, { mode: 'connect', connectUrl: 'http://localhost:5000' });
      expect(loadSettings(file)).toEqual({ mode: 'connect', connectUrl: 'http://127.0.0.1:5000' });
      expect(normalizeSettings({ mode: 'evil', connectUrl: 'http://192.0.2.1:1', token: 'x' })).toEqual({ mode: 'managed', connectUrl: 'http://127.0.0.1:47801' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
