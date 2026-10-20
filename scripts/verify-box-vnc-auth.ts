/**
 * Linux CI 冒烟：对刚构建的 personal-agent/pa-box:0.1 启动真实 Xvnc，
 * 用服务端 authenticateRfb 完成 VncAuth；口令错误必须失败。
 *
 *   docker build -t personal-agent/pa-box:0.1 deploy/box
 *   node --import tsx scripts/verify-box-vnc-auth.ts
 *
 * 不切换 docker context，容器名带 pid，不碰 pa-box-desktop / 47801 / 47811。
 */
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import { BOX_CTL, BOX_NAMES, BOX_QUOTA, boxRunArgs } from '../apps/server/src/box/host-adapter.js';
import { BOX_GATE_CONTAINER_PORT } from '../apps/server/src/box/parsers.js';
import { gateHandshake, newDesktopToken } from '../apps/server/src/box/gate.js';
import { authenticateRfb, RfbAuthError } from '../apps/server/src/rfb-preauth.js';

const container = `pa-box-ci-${process.pid}`;
const volume = `${container}-home`;
const gateHostPort = 47839;
const seccomp = join(process.cwd(), 'deploy', 'box', 'pa-box-seccomp.json');
const password = 'correct8';
const wrong = 'wrongpas';

function docker(args: string[], options: { input?: string; timeoutMs?: number } = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeoutMs ?? 60_000,
  });
  return result;
}

const fail = (label: string, detail: string): never => {
  console.error(`FAIL ${label}: ${detail}`);
  process.exitCode = 1;
  throw new Error(detail);
};

const inspect = docker(['image', 'inspect', BOX_NAMES.image, '--format', '{{.Id}}']);
if (inspect.status !== 0) fail('image', `build ${BOX_NAMES.image} first`);

const present = docker(['exec', container, 'true']);
if (present.status === 0) docker(['rm', '-f', container]);

const args = boxRunArgs({
  seccompProfile: seccomp,
  names: { ...BOX_NAMES, container, volume },
}).map(item => item === `127.0.0.1:${BOX_QUOTA.gateHostPort}:${BOX_GATE_CONTAINER_PORT}`
  ? `127.0.0.1:${gateHostPort}:${BOX_GATE_CONTAINER_PORT}` : item);
const created = docker(args);
if (created.status !== 0) fail('run', created.stderr || created.stdout || 'docker run failed');

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const probe = docker(['exec', container, 'python3', '-I', '-c', 'import socket; socket.create_connection(("127.0.0.1", 6080), 2).close()']);
    if (probe.status === 0) { ready = true; break; }
    spawnSync('sleep', ['0.25']);
  }
  if (!ready) fail('gate', 'pa-box-gate did not listen on 6080');

  const hasPasswd = docker(['exec', container, 'test', '-x', '/usr/bin/vncpasswd']);
  if (hasPasswd.status !== 0) fail('vncpasswd', '/usr/bin/vncpasswd missing; image needs tigervnc-tools');

  const start = (token: string, secret: string) => {
    const result = docker(['exec', '-i', container, BOX_CTL, 'start', 'd1'], { input: `${token}\n${secret}\n`, timeoutMs: 45_000 });
    if (result.status !== 0) fail('start', result.stderr || result.stdout || `pa-box-ctl exit ${result.status}`);
  };

  const openGate = () => new Promise<import('node:stream').Duplex>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: gateHostPort }, () => resolve(socket));
    socket.once('error', reject);
  });

  const goodToken = newDesktopToken();
  start(goodToken, password);
  const good = await authenticateRfb(await gateHandshake(await openGate(), 'd1', goodToken), password);
  good.destroy();
  console.log('PASS vncauth-ok');

  const badToken = newDesktopToken();
  start(badToken, password);
  try {
    await authenticateRfb(await gateHandshake(await openGate(), 'd1', badToken), wrong);
    fail('vncauth-deny', 'wrong password was accepted');
  } catch (error) {
    if (!(error instanceof RfbAuthError)) throw error;
  }
  console.log('PASS vncauth-deny');
  console.log('PASS box-image VncAuth');
} finally {
  docker(['rm', '-f', container]);
  docker(['volume', 'rm', '-f', volume]);
}
