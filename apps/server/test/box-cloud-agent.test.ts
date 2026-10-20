import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { boxRunArgs } from '../src/box/host-adapter.js';
import { boxSafetyIssues, parseDockerInspect, type ContainerInspection } from '../src/box/parsers.js';
import { safeInspect } from './fixtures/box.js';

const hostdPath = join(import.meta.dirname, '..', '..', '..', 'scripts', 'box', 'pa-box-hostd.mjs');
// 守护进程是独立的无依赖脚本（部署到云主机），这里动态导入，避免把 .mjs 纳入类型检查。
const loadHostd = (): Promise<any> => import(pathToFileURL(hostdPath).href);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('pa-box-hostd parity with the server', () => {
  it('creates the container with exactly the same arguments', async () => {
    const hostd = await loadHostd();
    expect(hostd.boxRunArgs('/etc/pa-box/seccomp.json')).toEqual(boxRunArgs({ seccompProfile: '/etc/pa-box/seccomp.json' }));
  });

  it('applies the same safety rules', async () => {
    const hostd = await loadHostd();
    const variants = [
      safeInspect(),
      safeInspect({}, { PortBindings: { '6080/tcp': [{ HostIp: '0.0.0.0', HostPort: '47830' }] } }),
      safeInspect({}, { PortBindings: { '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '47830' }], '6081/tcp': [{ HostIp: '127.0.0.1', HostPort: '6081' }] } }),
      safeInspect({}, { Privileged: true, CapAdd: ['NET_ADMIN'] }),
      safeInspect({}, { SecurityOpt: ['seccomp=unconfined'] }),
      safeInspect({ Mounts: [{ Type: 'bind', Source: '/', Destination: '/host' }] }, { NetworkMode: 'host' }),
      safeInspect({ SeccompProfilePath: '/etc/pa-box/seccomp.json' }, { SecurityOpt: ['no-new-privileges'] }),
    ];
    for (const variant of variants) {
      const server = boxSafetyIssues(parseDockerInspect(variant) as ContainerInspection, { gateHostPort: 47830, volume: 'pa-box-home', volumeDestination: '/home' });
      expect(hostd.safetyIssues(JSON.parse(variant)).sort()).toEqual([...server].sort());
    }
  });
});

describe('cloud agent end to end: ticket registration, heartbeat, long-poll desktop start, reverse tunnel', () => {
  it('streams a cloud desktop with no inbound port on the cloud host', async () => {
    const hostd = await loadHostd();
    const dir = mkdtempSync(join(tmpdir(), 'personal-agent-box-agent-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { app } = await buildApp({ dataDir: join(dir, 'data'), autoRun: false, webRoot: false, box: { localAdapter: null, sweepIntervalMs: 0, cacheMs: 0 } });
    cleanups.push(() => app.close());
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const headers = { host: '127.0.0.1:47801', 'content-type': 'application/json' };

    const created = await app.inject({ method: 'POST', url: '/api/box/deployments', headers, payload: { commandId: 'add-cloud-1', name: 'Cloud box', providerLabel: 'Example CAX21', connection: 'agent' } });
    expect(created.statusCode).toBe(201);
    const deploymentId = created.json().id as string;
    expect(created.json().host.state).toBe('pending_registration');
    const ticket = (await app.inject({ method: 'POST', url: `/api/box/deployments/${deploymentId}/tickets`, headers, payload: { commandId: 'ticket-1' } })).json().ticket as string;
    const registered = await app.inject({ method: 'POST', url: '/api/box/agent/register', headers, payload: { ticket } });
    expect(registered.statusCode).toBe(201);
    const credential = registered.json().credential as string;
    // 票据只能用一次。
    expect((await app.inject({ method: 'POST', url: '/api/box/agent/register', headers, payload: { ticket } })).statusCode).toBeGreaterThanOrEqual(400);

    // 云主机上的假网关：只认 pa-box-ctl 收到的那个令牌。
    const tokens = new Map<string, string>();
    const preambles: string[] = [];
    const gate: Server = createServer(socket => {
      socket.once('data', (chunk: Buffer) => {
        const line = chunk.toString('latin1').split('\n', 1)[0];
        preambles.push(line);
        const [, , desktopId, token] = line.split(' ');
        if (tokens.get(desktopId) !== token) { socket.end('ERR UNAUTHORIZED\n'); return; }
        socket.write('OK\nRFB 003.008\n');
        socket.pipe(socket);
      });
    });
    await new Promise<void>(resolve => gate.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>(resolve => gate.close(() => resolve())));

    const running = new Set<string>();
    const dockerCalls: { args: string[]; input?: string }[] = [];
    class FakeDockerDaemon extends hostd.HostDaemon {
      async docker(args: string[], options: { input?: string } = {}) {
        dockerCalls.push({ args, input: options.input });
        const line = args.join(' ');
        if (args[0] === 'version') return { code: 0, stdout: '27.5.1\n', stderr: '' };
        if (args[0] === 'inspect') return { code: 0, stdout: safeInspect(), stderr: '' };
        if (args[0] === 'stats') return { code: 0, stdout: '{"CPUPerc":"2.0%","MemUsage":"500MiB / 3.5GiB"}', stderr: '' };
        if (line === 'exec pa-box /usr/local/sbin/pa-box-ctl status') {
          return { code: 0, stdout: JSON.stringify({ v: 1, max: 3, desktops: ['d1', 'd2', 'd3'].map(id => ({ id, running: running.has(id) })) }), stderr: '' };
        }
        if (line.startsWith('exec -i pa-box /usr/local/sbin/pa-box-ctl start')) {
          tokens.set(args.at(-1)!, options.input!.trim());
          running.add(args.at(-1)!);
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: 'unexpected' };
      }
    }
    const daemon = new FakeDockerDaemon({ server: `http://127.0.0.1:${port}`, engine: 'docker', credentialFile: '/nonexistent', seccompProfile: '/etc/pa-box/seccomp.json', gatePort: (gate.address() as AddressInfo).port }, credential);
    await daemon.heartbeat();
    const polling = daemon.pollLoop().catch(() => undefined);
    cleanups.push(async () => { daemon.stopped = true; await app.close(); await polling; });

    const listed = (await app.inject({ method: 'GET', url: '/api/box/deployments', headers: { host: '127.0.0.1:47801' } })).json();
    const cloud = listed.deployments.find((item: any) => item.id === deploymentId);
    expect(cloud).toMatchObject({ kind: 'cloud', adapter: 'cloud-agent', registered: true, providerLabel: 'Example CAX21', host: { state: 'running' }, container: { state: 'running', safe: true } });
    expect(cloud.desktops.map((item: any) => item.streamable)).toEqual([true, true, true]);
    expect(cloud.lastHeartbeatAt).toEqual(expect.any(String));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/box/deployments/${deploymentId}/desktops/d1/vnc`, ['binary']);
    const first = await new Promise<Buffer>((resolve, reject) => { ws.once('message', (data: Buffer) => resolve(data)); ws.once('unexpected-response', (_q, r) => reject(new Error(`HTTP ${r.statusCode}`))); ws.once('error', reject); });
    expect(first.toString()).toBe('RFB 003.008\n');
    const echoed = await new Promise<Buffer>(resolve => { ws.once('message', (data: Buffer) => resolve(data)); ws.send(Buffer.from('ping')); });
    expect(echoed.toString()).toBe('ping');
    // 令牌经长轮询下发、经 stdin 交给 pa-box-ctl；网关收到的前导与之一致，令牌从不出现在 docker 参数里。
    const startCall = dockerCalls.find(call => call.args.includes('start') && call.args.includes('d1'))!;
    expect(startCall.args).toEqual(['exec', '-i', 'pa-box', '/usr/local/sbin/pa-box-ctl', 'start', 'd1']);
    expect(preambles[0]).toBe(`PA-BOX-GATE 1 d1 ${startCall.input!.trim()}`);
    expect(dockerCalls.some(call => call.args.some(arg => arg.includes(startCall.input!.trim())))).toBe(false);
    ws.close();

    // 未注册凭据不能打开隧道。
    const forged = await fetch(`http://127.0.0.1:${port}/api/box/agent/poll`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${'Z'.repeat(43)}` }, body: '{}' });
    expect(forged.status).toBe(401);
  }, 30_000);
});
