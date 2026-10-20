import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gateHandshake, newDesktopToken } from '../src/box/gate.js';

const root = join(import.meta.dirname, '..', '..', '..');
const boxLib = join(root, 'deploy', 'box', 'rootfs', 'usr', 'local', 'lib', 'pa-box');
const ctl = join(root, 'deploy', 'box', 'rootfs', 'usr', 'local', 'sbin', 'pa-box-ctl');
const python = process.platform === 'win32' ? undefined : ['python3'].find(name => spawnSync(name, ['--version']).status === 0);
const bash = process.platform === 'win32' ? undefined : spawnSync('bash', ['--version']).status === 0 ? 'bash' : undefined;

describe.skipIf(!python)('pa-box-gate (real Python gate, temp run dir, loopback port)', () => {
  let dir: string;
  let gate: ChildProcess;
  let port: number;
  let vnc: Server;

  const connectGate = () => new Promise<import('node:net').Socket>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => resolve(socket));
    socket.once('error', reject);
  });
  const writeToken = (desktop: string, value: string) => writeFileSync(join(dir, 'gate', `${desktop}.token`), value, { mode: 0o640 });

  beforeAll(async () => {
    // unix socket 路径有长度限制（macOS 104 字节），用短的临时目录。
    dir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'pa-gate-'));
    for (const name of ['gate', 'd1', 'd2']) mkdirSync(join(dir, name));
    // 假的 Xvnc：只在 d1 的 unix socket 上提供 RFB 版本串并回显。
    vnc = createServer(socket => { socket.write('RFB 003.008\n'); socket.pipe(socket); });
    await new Promise<void>(resolve => vnc.listen(join(dir, 'd1', 'vnc.sock'), resolve));
    gate = spawn(python!, ['-I', join(boxLib, 'pa-box-gate.py')], {
      env: { PATH: process.env.PATH, PA_BOX_RUN_DIR: dir, PA_BOX_GATE_HOST: '127.0.0.1', PA_BOX_GATE_PORT: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    port = await new Promise<number>((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error(`gate did not start: ${text}`)), 10_000);
      gate.stderr!.on('data', (chunk: Buffer) => {
        text += chunk.toString();
        const match = /listening on (\d+)/.exec(text);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
  }, 20_000);

  afterAll(async () => {
    gate?.kill();
    await new Promise<void>(resolve => (vnc ? vnc.close(() => resolve()) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens the desktop unix socket only with that desktop\'s fresh token', async () => {
    const token = newDesktopToken();
    writeToken('d1', token);
    const stream = await gateHandshake(await connectGate(), 'd1', token);
    const banner = await new Promise<string>(resolve => { stream.once('data', (chunk: Buffer) => resolve(chunk.toString())); stream.resume(); });
    expect(banner).toBe('RFB 003.008\n');
    stream.destroy();
  });

  it('rejects a wrong token, and a desktop-1 token cannot open desktop 2', async () => {
    const token = newDesktopToken();
    writeToken('d1', token);
    writeToken('d2', newDesktopToken());
    await expect(gateHandshake(await connectGate(), 'd1', newDesktopToken())).rejects.toMatchObject({ code: 'BOX_DESKTOP_TOKEN_REJECTED' });
    await expect(gateHandshake(await connectGate(), 'd2', token)).rejects.toMatchObject({ code: 'BOX_DESKTOP_TOKEN_REJECTED' });
  });

  it('rejects tokens older than 60 seconds', async () => {
    const token = newDesktopToken();
    writeToken('d1', token);
    const old = (Date.now() - 61_000) / 1000;
    utimesSync(join(dir, 'gate', 'd1.token'), old, old);
    await expect(gateHandshake(await connectGate(), 'd1', token)).rejects.toMatchObject({ code: 'BOX_DESKTOP_TOKEN_REJECTED' });
  });

  it('accepts a fresh token only once', async () => {
    const token = newDesktopToken();
    writeToken('d1', token);
    const first = await gateHandshake(await connectGate(), 'd1', token);
    first.destroy();
    await expect(gateHandshake(await connectGate(), 'd1', token)).rejects.toMatchObject({ code: 'BOX_DESKTOP_TOKEN_REJECTED' });
  });

  it('reports a stopped desktop and rejects malformed preambles', async () => {
    const token = newDesktopToken();
    writeToken('d2', token);
    await expect(gateHandshake(await connectGate(), 'd2', token)).rejects.toMatchObject({ code: 'BOX_DESKTOP_NOT_RUNNING' });
    const raw = await connectGate();
    const reply = await new Promise<string>(resolve => { raw.once('data', (chunk: Buffer) => resolve(chunk.toString())); raw.write('GET / HTTP/1.1\r\n\r\n'); });
    expect(reply).toBe('ERR BAD_PREAMBLE\n');
    raw.destroy();
  });
});

describe.skipIf(!python || !bash)('box image scripts', () => {
  it('are syntactically valid bash and python', () => {
    const hostScripts = ['colima-pa-box.sh', 'install-cloud-host.sh'].map(name => join(root, 'scripts', 'box', name));
    for (const script of [ctl, join(boxLib, 'entrypoint.sh'), join(boxLib, 'start-desktop.sh'), ...hostScripts]) execFileSync(bash!, ['--noprofile', '--norc', '-n', script]);
    for (const script of ['pa-box-gate.py', 'no-tcp-listen.py']) {
      execFileSync(python!, ['-I', '-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', join(boxLib, script)]);
    }
  });

  it('pa-box-ctl rejects bad desktop ids before touching anything', () => {
    const result = spawnSync(bash!, ['--noprofile', '--norc', ctl, 'start', 'd9'], { env: { PATH: '/usr/bin:/bin', PA_BOX_MAX_DESKTOPS: '3' }, input: '' });
    expect(result.status).toBe(64);
    expect(spawnSync(bash!, ['--noprofile', '--norc', ctl, 'bogus'], { env: { PATH: '/usr/bin:/bin' } }).status).toBe(64);
  });

  it('desktops never pass --no-sandbox and Xvnc never listens on TCP', async () => {
    const { readFileSync } = await import('node:fs');
    const desktop = readFileSync(join(boxLib, 'start-desktop.sh'), 'utf8');
    expect(desktop).not.toMatch(/^\s*--no-sandbox/m);
    expect(desktop).toMatch(/-rfbport -1/);
    expect(desktop).toMatch(/-rfbunixpath "\$socket"/);
    expect(desktop).toMatch(/-rfbunixmode 0660/);
    expect(desktop).toMatch(/-SecurityTypes VncAuth/);
    expect(desktop).toMatch(/-rfbauth/);
    expect(desktop).not.toMatch(/SecurityTypes None/);
    expect(desktop).toMatch(/MIT-MAGIC-COOKIE-1/);
    const control = readFileSync(ctl, 'utf8');
    // 令牌与 VNC 口令只从 stdin 两行读取。
    expect(control).toMatch(/IFS= read -r -t 5 token/);
    expect(control).toMatch(/IFS= read -r -t 5 password/);
    expect(control).toMatch(/vncpasswd -f/);
  });

  it('no-tcp-listen.py flags a process that listens on TCP', async () => {
    if (process.platform !== 'linux') return;
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    try {
      const flagged = spawnSync(python!, ['-I', join(boxLib, 'no-tcp-listen.py'), String(process.pid)]);
      expect(flagged.status).toBe(1);
    } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
    const sleeper = spawn('sleep', ['5']);
    try { expect(spawnSync(python!, ['-I', join(boxLib, 'no-tcp-listen.py'), String(sleeper.pid)]).status).toBe(0); }
    finally { sleeper.kill(); }
  });
});
