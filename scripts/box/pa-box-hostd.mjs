#!/usr/bin/env node
/**
 * pa-box-hostd：运行在云端 Linux 主机上的 box 守护进程（无第三方依赖，Node >= 22）。
 *
 * 它只主动外连 personal-agent server，不监听任何端口：
 *   register  用一次性注册票据换取 machine 凭据（凭据文件 0600，只保存在主机上）
 *   run       每 15 秒心跳（宿主 / 容器 / 桌面 / 内存压力快照，并回报命令结果）；
 *             长轮询领取命令：启停 box 容器、启停桌面、打开桌面隧道；
 *             隧道：向 server 发起 `Upgrade: pa-box-tunnel`，另一端连本机 127.0.0.1:47830（box 网关）。
 *
 * 容器参数与安全校验与 server 侧（apps/server/src/box/host-adapter.ts、parsers.ts）保持同一套规则，
 * 由仓库里的单元测试比对。桌面令牌只经 `docker exec -i` 的 stdin 交给 pa-box-ctl，从不写日志。
 *
 * 配置文件（默认 /etc/pa-box/hostd.json，可用 PA_BOX_HOSTD_CONFIG 覆盖）：
 *   { "server": "https://agent.example.com", "engine": "docker", "credentialFile": "/var/lib/pa-box/credential",
 *     "seccompProfile": "/etc/pa-box/seccomp.json", "container": "pa-box-desktop" }
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { arch, cpus, totalmem } from 'node:os';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const AGENT_VERSION = '0.1.0';
export const NAMES = { container: 'pa-box-desktop', image: 'personal-agent/pa-box:0.1', volume: 'pa-box-home', volumeDestination: '/home' };
export const GATE_CONTAINER_PORT = 6080;
export const GATE_HOST_PORT = 47830;
export const CTL = '/usr/local/sbin/pa-box-ctl';
const HEARTBEAT_MS = 15_000;

/** 与 server 的 boxRunArgs 完全一致（单元测试比对）。 */
export function boxRunArgs(seccompProfile) {
  if (!seccompProfile || /[\r\n]/.test(seccompProfile)) throw new Error('seccomp profile path is required');
  return ['run', '-d', '--name', NAMES.container, '--hostname', NAMES.container, '--restart', 'unless-stopped',
    '--memory', '3.5g', '--memory-swap', '3.5g', '--cpus', '2', '--shm-size', '1g',
    '--security-opt', `seccomp=${seccompProfile}`, '--security-opt', 'no-new-privileges',
    '--label', 'io.personal-agent.box=1',
    '-e', 'PA_BOX_MAX_DESKTOPS=3',
    '-p', `127.0.0.1:${GATE_HOST_PORT}:${GATE_CONTAINER_PORT}`,
    '-v', `${NAMES.volume}:${NAMES.volumeDestination}`,
    NAMES.image];
}

/** 与 server 的 boxSafetyIssues 同一规则：返回问题列表，空数组表示通过。 */
export function safetyIssues(row) {
  const issues = new Set();
  const host = row?.HostConfig ?? {};
  const bindings = [];
  for (const [key, list] of Object.entries(host.PortBindings ?? {})) {
    const port = /^(\d+)\/(tcp|udp|sctp)$/.exec(key);
    for (const binding of Array.isArray(list) ? list : []) {
      bindings.push({ containerPort: port && port[2] === 'tcp' ? Number(port[1]) : -1, hostIp: typeof binding?.HostIp === 'string' ? binding.HostIp : '', hostPort: Number(binding?.HostPort) || 0 });
    }
  }
  if (!bindings.some(binding => binding.containerPort === GATE_CONTAINER_PORT)) issues.add('GATE_PORT_MISSING');
  for (const binding of bindings) {
    if (binding.containerPort !== GATE_CONTAINER_PORT || binding.hostPort !== GATE_HOST_PORT) issues.add('UNEXPECTED_PORT');
    if (binding.hostIp !== '127.0.0.1') issues.add('PORT_NOT_LOOPBACK');
  }
  if (host.Privileged === true) issues.add('PRIVILEGED');
  if (Array.isArray(host.CapAdd) && host.CapAdd.length) issues.add('CAP_ADD');
  const securityOpt = Array.isArray(host.SecurityOpt) ? host.SecurityOpt.filter(item => typeof item === 'string') : [];
  const seccomp = securityOpt.find(option => /^seccomp[=:]/.test(option));
  const seccompOk = seccomp ? !/^seccomp[=:]unconfined$/.test(seccomp) : typeof row?.SeccompProfilePath === 'string' && row.SeccompProfilePath !== '' && row.SeccompProfilePath !== 'unconfined';
  if (!seccompOk) issues.add('NO_SECCOMP');
  if (!securityOpt.some(option => /^no-new-privileges(?:[=:]true)?$/.test(option))) issues.add('NO_NEW_PRIVILEGES_MISSING');
  if ([host.NetworkMode, host.PidMode, host.IpcMode].includes('host')) issues.add('HOST_NAMESPACE');
  for (const mount of Array.isArray(row?.Mounts) ? row.Mounts : []) {
    if (mount?.Type !== 'volume' || mount?.Name !== NAMES.volume || mount?.Destination !== NAMES.volumeDestination) issues.add('UNEXPECTED_MOUNT');
  }
  return [...issues];
}

export function linuxPressure(text) {
  const match = /^some\s+avg10=(\d+(?:\.\d+)?)/m.exec(text);
  if (!match) return 'unknown';
  const value = Number(match[1]);
  return value >= 40 ? 'critical' : value >= 10 ? 'warn' : 'normal';
}

const log = message => process.stderr.write(`pa-box-hostd: ${message}\n`);

function run(file, args, { input, timeoutMs = 30_000 } = {}) {
  return new Promise(resolve => {
    const child = execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: process.env.HOME ?? '/', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '' } },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout: String(stdout), stderr: String(stderr) }));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input ?? '');
  });
}

function applyContainerName(value) {
  if (typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,62}$/.test(value)) NAMES.container = value;
}

function loadConfig(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const server = new URL(config.server);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname);
  if (server.protocol !== 'https:' && !(server.protocol === 'http:' && loopback)) throw new Error('server must be an https:// URL');
  if (!['docker', 'podman'].includes(config.engine ?? 'docker')) throw new Error('engine must be docker or podman');
  applyContainerName(config.container ?? process.env.PA_BOX_CONTAINER);
  return { server: server.origin, engine: config.engine ?? 'docker', credentialFile: config.credentialFile ?? '/var/lib/pa-box/credential',
    seccompProfile: config.seccompProfile ?? '/etc/pa-box/seccomp.json' };
}

function writePrivate(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}

function api(config, path, body, credential, timeoutMs = 40_000) {
  const url = new URL(path, config.server);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = JSON.stringify(body ?? {});
  return new Promise((resolve, reject) => {
    const req = send(url, { method: 'POST', timeout: timeoutMs, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
      ...(credential ? { authorization: `Bearer ${credential}` } : {}) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 200 && response.statusCode < 300) { try { resolve(JSON.parse(text)); } catch { resolve({}); } }
        else reject(Object.assign(new Error(`HTTP ${response.statusCode}`), { status: response.statusCode }));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

export class HostDaemon {
  constructor(config, credential) {
    this.config = config;
    this.credential = credential;
    this.results = [];
    this.stopped = false;
    // 只有测试会覆盖；生产固定连本机 127.0.0.1:47830。
    this.gatePort = config.gatePort ?? GATE_HOST_PORT;
  }

  docker(args, options) { return run(this.config.engine, args, options); }

  async inspect() {
    const result = await this.docker(['inspect', NAMES.container, '--format', '{{json .}}'], { timeoutMs: 10_000 });
    if (result.code !== 0) return /no such|no container/i.test(result.stderr) ? { state: 'missing' } : { state: 'unknown' };
    let row;
    try { const parsed = JSON.parse(result.stdout.trim()); row = Array.isArray(parsed) ? parsed[0] : parsed; } catch { return { state: 'unknown' }; }
    const running = row?.State?.Running === true;
    return { state: running ? 'running' : 'stopped', image: typeof row?.Config?.Image === 'string' ? row.Config.Image.slice(0, 128) : undefined, issues: safetyIssues(row) };
  }

  async snapshot() {
    const version = await this.docker(['version', '--format', this.config.engine === 'podman' ? '{{.Client.Version}}' : '{{.Server.Version}}'], { timeoutMs: 10_000 });
    const host = { state: version.code === 0 ? 'running' : 'stopped', runtime: this.config.engine, arch: arch(), cpus: cpus().length, memoryBytes: totalmem(),
      ...(version.code === 0 && /^v?\d+\.\d+[\w.+-]*$/.test(version.stdout.trim()) ? { version: version.stdout.trim().replace(/^v/, '') } : {}) };
    let memoryPressure = 'unknown';
    try { memoryPressure = linuxPressure(readFileSync('/proc/pressure/memory', 'utf8')); } catch { /* 内核未启用 PSI */ }
    const inspected = await this.inspect();
    const container = { state: inspected.state, ...(inspected.image ? { image: inspected.image } : {}), safe: inspected.issues ? inspected.issues.length === 0 : false };
    let desktops = [];
    let gateReady = false;
    if (inspected.state === 'running') {
      const stats = await this.docker(['stats', '--no-stream', '--format', '{{json .}}', NAMES.container], { timeoutMs: 10_000 });
      try {
        const row = JSON.parse(stats.stdout.trim().split('\n')[0]);
        const cpu = /^(\d+(?:\.\d+)?)%$/.exec(String(row.CPUPerc ?? '').trim());
        if (cpu) container.cpuPercent = Number(cpu[1]);
      } catch { /* stats 不可用时只报状态 */ }
      if (container.safe) {
        const ctl = await this.docker(['exec', NAMES.container, CTL, 'status'], { timeoutMs: 10_000 });
        try {
          const status = JSON.parse(ctl.stdout.trim());
          if (status?.v === 1 && Array.isArray(status.desktops)) {
            desktops = status.desktops.filter(item => /^d[1-3]$/.test(item?.id)).map(item => ({ id: item.id, state: item.running === true ? 'running' : 'stopped' }));
            gateReady = true;
          }
        } catch { /* 镜像过旧 */ }
      }
    }
    return { host, container, desktops, gateReady, memoryPressure, agentVersion: AGENT_VERSION };
  }

  async startContainer() {
    const current = await this.inspect();
    if (current.issues?.length) throw Object.assign(new Error('unsafe'), { code: 'BOX_CONTAINER_UNSAFE' });
    if (current.state === 'running') return;
    if (current.state === 'missing') {
      const created = await this.docker(boxRunArgs(this.config.seccompProfile), { timeoutMs: 120_000 });
      if (created.code !== 0) throw Object.assign(new Error('create failed'), { code: 'BOX_CONTAINER_CREATE_FAILED' });
      const verified = await this.inspect();
      if (verified.state === 'missing' || verified.state === 'unknown' || verified.issues?.length) {
        await this.docker(['rm', '-f', NAMES.container], { timeoutMs: 60_000 });
        throw Object.assign(new Error('unsafe'), { code: 'BOX_CONTAINER_UNSAFE' });
      }
      return;
    }
    const started = await this.docker(['start', NAMES.container], { timeoutMs: 60_000 });
    if (started.code !== 0) throw Object.assign(new Error('start failed'), { code: 'BOX_CONTAINER_START_FAILED' });
  }

  async handle(command) {
    if (command.type === 'action') {
      if (command.action === 'start_container') await this.startContainer();
      else if (command.action === 'stop_container') {
        const stopped = await this.docker(['stop', '--time', '20', NAMES.container], { timeoutMs: 60_000 });
        if (stopped.code !== 0) throw Object.assign(new Error('stop failed'), { code: 'BOX_CONTAINER_STOP_FAILED' });
      } else throw Object.assign(new Error('unsupported'), { code: 'BOX_ACTION_UNSUPPORTED' });
      return;
    }
    if (command.type === 'desktop') {
      if (!/^d[1-3]$/.test(command.desktopId) || !['start', 'stop'].includes(command.op)) throw Object.assign(new Error('bad desktop'), { code: 'BOX_INPUT_INVALID' });
      if (command.op === 'start' && !/^[A-Za-z0-9_-]{43}$/.test(command.token ?? '')) throw Object.assign(new Error('bad token'), { code: 'BOX_INPUT_INVALID' });
      if (command.op === 'start' && (typeof command.password !== 'string' || command.password.length < 8 || command.password.includes('\n'))) {
        throw Object.assign(new Error('bad password'), { code: 'BOX_INPUT_INVALID' });
      }
      const result = await this.docker(['exec', ...(command.op === 'start' ? ['-i'] : []), NAMES.container, CTL, command.op, command.desktopId],
        { timeoutMs: 45_000, ...(command.op === 'start' ? { input: `${command.token}\n${command.password}\n` } : {}) });
      if (result.code === 66) throw Object.assign(new Error('limit'), { code: 'BOX_DESKTOP_LIMIT' });
      if (result.code === 71) throw Object.assign(new Error('unsafe desktop'), { code: 'BOX_DESKTOP_UNSAFE' });
      if (result.code !== 0) throw Object.assign(new Error('desktop failed'), { code: command.op === 'start' ? 'BOX_DESKTOP_START_FAILED' : 'BOX_DESKTOP_STOP_FAILED' });
      return;
    }
    if (command.type === 'tunnel') return this.tunnel(command.streamId);
    throw Object.assign(new Error('unknown command'), { code: 'BOX_ACTION_UNSUPPORTED' });
  }

  /** 反向隧道：server ⇄ 本机网关 127.0.0.1:47830。不经过任何入站端口。 */
  tunnel(streamId) {
    if (!/^[A-Za-z0-9_-]{24}$/.test(streamId)) return Promise.resolve();
    const url = new URL(`/api/box/agent/tunnel/${streamId}`, this.config.server);
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = send(url, { method: 'GET', headers: { connection: 'Upgrade', upgrade: 'pa-box-tunnel', authorization: `Bearer ${this.credential}` } });
      req.on('upgrade', (_response, remote, head) => {
        const local = connect({ host: '127.0.0.1', port: this.gatePort });
        local.once('connect', () => {
          if (head.length) local.write(head);
          remote.pipe(local);
          local.pipe(remote);
          resolve();
        });
        const close = () => { remote.destroy(); local.destroy(); };
        local.once('error', () => { close(); reject(Object.assign(new Error('gate unreachable'), { code: 'BOX_DESKTOP_UNREACHABLE' })); });
        remote.once('error', close);
        remote.once('close', close);
        local.once('close', close);
      });
      req.on('response', () => reject(Object.assign(new Error('tunnel refused'), { code: 'BOX_AGENT_TUNNEL_REFUSED' })));
      req.on('error', () => reject(Object.assign(new Error('tunnel failed'), { code: 'BOX_AGENT_TUNNEL_REFUSED' })));
      req.end();
    });
  }

  async heartbeat() {
    const results = this.results.splice(0, 32);
    try { await api(this.config, '/api/box/agent/heartbeat', { snapshot: await this.snapshot(), ...(results.length ? { results } : {}) }, this.credential, 20_000); }
    catch (error) { this.results.unshift(...results); if (error.status === 401) throw error; log(`heartbeat failed (${error.status ?? 'network'})`); }
  }

  async pollLoop() {
    while (!this.stopped) {
      let commands = [];
      try { commands = (await api(this.config, '/api/box/agent/poll', {}, this.credential, 40_000)).commands ?? []; }
      catch (error) { if (error.status === 401) throw error; await new Promise(resolve => setTimeout(resolve, 5_000)); continue; }
      for (const command of commands.slice(0, 16)) {
        // 隧道不需要回报结果；其余命令完成后立即发一次心跳，让 server 尽快看到新状态。
        this.handle(command).then(
          () => { if (command.type !== 'tunnel') this.results.push({ id: command.id, ok: true }); },
          error => { if (command.type !== 'tunnel') this.results.push({ id: command.id, ok: false, errorCode: /^[A-Z_]{1,64}$/.test(error.code ?? '') ? error.code : 'BOX_AGENT_ACTION_FAILED' }); },
        ).finally(() => { if (command.type !== 'tunnel') void this.heartbeat().catch(() => undefined); });
      }
    }
  }

  async run() {
    await this.heartbeat();
    const timer = setInterval(() => { this.heartbeat().catch(error => { log(`credential rejected (${error.status}); stopping`); process.exit(78); }); }, HEARTBEAT_MS);
    try { await this.pollLoop(); }
    catch (error) { log(`credential rejected (${error.status}); stopping`); process.exit(78); }
    finally { clearInterval(timer); }
  }
}

async function main(argv) {
  const configPath = process.env.PA_BOX_HOSTD_CONFIG ?? '/etc/pa-box/hostd.json';
  const config = loadConfig(configPath);
  const [command, ...rest] = argv;
  if (command === 'register') {
    const ticketFile = rest[rest.indexOf('--ticket-file') + 1];
    if (!rest.includes('--ticket-file') || !ticketFile) throw new Error('usage: pa-box-hostd register --ticket-file <file>');
    const ticket = readFileSync(ticketFile, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error('ticket file does not contain a valid ticket');
    const response = await api(config, '/api/box/agent/register', { ticket, agentVersion: AGENT_VERSION });
    if (!/^[A-Za-z0-9_-]{43}$/.test(response.credential ?? '')) throw new Error('server returned no credential');
    writePrivate(config.credentialFile, `${response.credential}\n`);
    log(`registered deployment ${response.deploymentId}`);
    return;
  }
  if (command === 'run') {
    const credential = readFileSync(config.credentialFile, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error('credential file is missing or invalid; run register first');
    const daemon = new HostDaemon(config, credential);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { daemon.stopped = true; process.exit(0); });
    await daemon.run();
    return;
  }
  throw new Error('usage: pa-box-hostd register --ticket-file <file> | run');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { log(error.message); process.exit(1); });
}
