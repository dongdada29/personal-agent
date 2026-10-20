/**
 * 云端 box 适配器。
 *
 * agent：云端主机上的 pa-box-hostd 守护进程用一次性票据注册，之后主动外连 server：
 *   - 心跳（宿主 / 容器 / 桌面 / 内存压力快照）；
 *   - 长轮询领取命令（启停容器、启停桌面、打开网关隧道）；
 *   - 打开桌面时，守护进程向 server 发起 `Upgrade: pa-box-tunnel` 的反向隧道，隧道另一端是
 *     云端 127.0.0.1:47830 上的 box 网关；server 在隧道里发送每桌面令牌前导，再把 RFB 字节
 *     与浏览器的 WebSocket 对接。云端主机不需要开放任何入站端口。
 *   桌面令牌经已鉴权的长轮询通道下发给守护进程，守护进程用 `docker exec -i` 的 stdin 交给 pa-box-ctl。
 *
 * ssh：server 用用户自己的 ssh 配置（BatchMode，不保存任何密码 / 私钥）执行 docker 命令，
 *   桌面令牌经 ssh 的 stdin 传给远端 `docker exec -i`，网关连接走 `ssh -W 127.0.0.1:47830`。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Duplex } from 'node:stream';
import type { BoxAction, BoxHostStatus, BoxMemoryPressure } from '@personal-agent/contracts';
import type { CommandRunner } from './command.js';
import { findExecutable, commandEnvironment } from './command.js';
import { BOX_REMOTE_SECCOMP_PATH } from './assets.js';
import type { BoxStore, CloudDeploymentRecord } from './box-store.js';
import { BOX_NAMES, BOX_QUOTA, BoxError, DockerBox, containerActions, type BoxNames, type BoxSnapshot, type DesktopOp, type HostAdapter } from './host-adapter.js';
import { parseLinuxMemoryPressure, parseSingleVersion } from './parsers.js';

/** 心跳超过该时长视为离线。守护进程默认每 15 秒一次。 */
export const AGENT_OFFLINE_AFTER_MS = 45_000;

export type AgentCommand =
  | { id: string; type: 'action'; action: 'start_container' | 'stop_container' }
  | { id: string; type: 'desktop'; op: DesktopOp; desktopId: string; token?: string; password?: string }
  | { id: string; type: 'tunnel'; streamId: string };

type AgentRequest =
  | { type: 'action'; action: 'start_container' | 'stop_container' }
  | { type: 'desktop'; op: DesktopOp; desktopId: string; token?: string; password?: string };

export interface AgentResult { id: string; ok: boolean; errorCode?: string }

interface PendingStream { deploymentId: string; resolve: (socket: Duplex) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface PendingResult { deploymentId: string; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

/** 守护进程命令队列、长轮询与反向隧道配对。全部在内存中：server 重启后守护进程会自动重新轮询。 */
export class AgentBroker {
  private readonly queues = new Map<string, AgentCommand[]>();
  private readonly waiters = new Map<string, (commands: AgentCommand[]) => void>();
  private readonly streams = new Map<string, PendingStream>();
  private readonly results = new Map<string, PendingResult>();
  private closed = false;

  constructor(private readonly options: { tunnelTimeoutMs?: number; actionTimeoutMs?: number } = {}) {}

  /** 长轮询：有命令立即返回，否则最多等 timeoutMs。同一部署只保留最新的一个等待者。 */
  poll(deploymentId: string, timeoutMs = 25_000): Promise<AgentCommand[]> {
    if (this.closed) return Promise.resolve([]);
    const queued = this.queues.get(deploymentId);
    if (queued?.length) { this.queues.delete(deploymentId); return Promise.resolve(queued); }
    this.waiters.get(deploymentId)?.([]);
    return new Promise(resolve => {
      const timer = setTimeout(() => { if (this.waiters.get(deploymentId) === done) this.waiters.delete(deploymentId); resolve([]); }, timeoutMs);
      timer.unref();
      const done = (commands: AgentCommand[]) => { clearTimeout(timer); if (this.waiters.get(deploymentId) === done) this.waiters.delete(deploymentId); resolve(commands); };
      this.waiters.set(deploymentId, done);
    });
  }

  private enqueue(deploymentId: string, command: AgentCommand): void {
    const waiter = this.waiters.get(deploymentId);
    if (waiter) { waiter([command]); return; }
    const queue = this.queues.get(deploymentId) ?? [];
    // 防止离线主机堆积命令：最多保留 16 条。
    this.queues.set(deploymentId, [...queue, command].slice(-16));
  }

  /** 下发一条需要确认的命令（容器 / 桌面启停），等守护进程在心跳里回报结果。 */
  request(deploymentId: string, request: AgentRequest): Promise<void> {
    const id = randomBytes(12).toString('base64url');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.results.delete(id); reject(new BoxError('BOX_AGENT_TIMEOUT', '云端主机未在限定时间内确认操作。', 504)); }, this.options.actionTimeoutMs ?? 120_000);
      timer.unref();
      this.results.set(id, { deploymentId, resolve, reject, timer });
      this.enqueue(deploymentId, { id, ...request } as AgentCommand);
    });
  }

  reportResults(deploymentId: string, results: AgentResult[]): void {
    for (const result of results) {
      const pending = this.results.get(result.id);
      if (!pending || pending.deploymentId !== deploymentId) continue;
      clearTimeout(pending.timer);
      this.results.delete(result.id);
      if (result.ok) pending.resolve();
      else pending.reject(new BoxError(typeof result.errorCode === 'string' && /^[A-Z_]{1,64}$/.test(result.errorCode) ? result.errorCode : 'BOX_AGENT_ACTION_FAILED', '云端主机执行操作失败。'));
    }
  }

  /** 请求守护进程建立一条到云端 box 网关的反向隧道。 */
  openTunnel(deploymentId: string): Promise<Duplex> {
    if (this.closed) return Promise.reject(new BoxError('SERVER_CLOSING', '服务正在停止。', 503));
    const streamId = randomBytes(18).toString('base64url');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.streams.delete(streamId); reject(new BoxError('BOX_AGENT_TIMEOUT', '云端主机未在限定时间内建立桌面隧道。', 504)); }, this.options.tunnelTimeoutMs ?? 15_000);
      timer.unref();
      this.streams.set(streamId, { deploymentId, resolve, reject, timer });
      this.enqueue(deploymentId, { id: streamId, type: 'tunnel', streamId });
    });
  }

  /** 守护进程的隧道连接到达：只接受属于同一部署、尚未配对的 streamId。 */
  acceptTunnel(deploymentId: string, streamId: string, socket: Duplex): boolean {
    const pending = this.streams.get(streamId);
    if (!pending || pending.deploymentId !== deploymentId) return false;
    clearTimeout(pending.timer);
    this.streams.delete(streamId);
    pending.resolve(socket);
    return true;
  }

  forget(deploymentId: string): void {
    this.queues.delete(deploymentId);
    this.waiters.get(deploymentId)?.([]);
    for (const [id, pending] of this.streams) if (pending.deploymentId === deploymentId) { clearTimeout(pending.timer); this.streams.delete(id); pending.reject(new BoxError('BOX_DEPLOYMENT_NOT_FOUND', '部署已移除。', 404)); }
    for (const [id, pending] of this.results) if (pending.deploymentId === deploymentId) { clearTimeout(pending.timer); this.results.delete(id); pending.reject(new BoxError('BOX_DEPLOYMENT_NOT_FOUND', '部署已移除。', 404)); }
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.values()) waiter([]);
    this.waiters.clear();
    for (const pending of this.streams.values()) { clearTimeout(pending.timer); pending.reject(new BoxError('SERVER_CLOSING', '服务正在停止。', 503)); }
    this.streams.clear();
    for (const pending of this.results.values()) { clearTimeout(pending.timer); pending.reject(new BoxError('SERVER_CLOSING', '服务正在停止。', 503)); }
    this.results.clear();
  }
}

export class CloudAgentAdapter implements HostAdapter {
  readonly id = 'cloud-agent' as const;
  readonly kind = 'cloud' as const;
  constructor(private readonly deploymentId: string, private readonly store: BoxStore, private readonly broker: AgentBroker,
    private readonly now: () => number = Date.now, private readonly names: BoxNames = BOX_NAMES) {}

  private record(): CloudDeploymentRecord {
    const record = this.store.get(this.deploymentId);
    if (!record) throw new BoxError('BOX_DEPLOYMENT_NOT_FOUND', '部署不存在。', 404);
    return record;
  }

  online(record = this.record()): boolean {
    return !!record.lastHeartbeatAt && this.now() - Date.parse(record.lastHeartbeatAt) < AGENT_OFFLINE_AFTER_MS;
  }

  async status(): Promise<BoxSnapshot> {
    const record = this.record();
    const name = this.names.container;
    const blank = { container: { state: 'unknown' as const, name }, desktops: [], gateReady: false, memoryPressure: 'unknown' as const };
    if (!record.registeredAt) {
      return { ...blank, host: { state: 'pending_registration', detail: '等待主机守护进程使用一次性票据注册。', installHint: 'scripts/box/install-cloud-host.sh --server <URL> --ticket-file <文件>' } };
    }
    const heartbeat = record.heartbeat;
    if (!heartbeat || !this.online(record)) {
      return { ...blank, host: { state: 'offline', detail: heartbeat ? '超过 45 秒未收到心跳。' : '已注册，尚未收到心跳。' } };
    }
    const host: BoxHostStatus = { state: heartbeat.host.state, version: heartbeat.host.version, arch: heartbeat.host.arch, runtime: heartbeat.host.runtime,
      resources: { cpus: heartbeat.host.cpus, memoryBytes: heartbeat.host.memoryBytes, diskBytes: heartbeat.host.diskBytes } };
    const running = heartbeat.container.state === 'running';
    const safe = heartbeat.container.safe === true;
    return { host,
      container: { name, ...heartbeat.container, ...(running && !safe ? { detail: '云端 box 容器未通过守护进程的安全校验，已拒绝串流。' } : {}) },
      desktops: running ? heartbeat.desktops.map(desktop => ({ id: desktop.id, running: desktop.state === 'running' })) : [],
      gateReady: running && safe && heartbeat.gateReady === true,
      memoryPressure: heartbeat.memoryPressure ?? 'unknown' };
  }

  actions(snapshot: BoxSnapshot): BoxAction[] {
    if (snapshot.host.state === 'pending_registration' || snapshot.host.state === 'offline') return [];
    return containerActions(snapshot);
  }

  async perform(action: BoxAction): Promise<void> {
    if (action !== 'start_container' && action !== 'stop_container') throw new BoxError('BOX_ACTION_UNSUPPORTED', '云端主机由服务商管理 VM，这里只能启停 box 容器。', 400);
    if (!this.online()) throw new BoxError('BOX_AGENT_OFFLINE', '云端主机当前离线。');
    await this.broker.request(this.deploymentId, { type: 'action', action });
  }

  async desktop(op: DesktopOp, desktopId: string, token?: string, password?: string): Promise<void> {
    if (!this.online()) throw new BoxError('BOX_AGENT_OFFLINE', '云端主机当前离线。');
    await this.broker.request(this.deploymentId, { type: 'desktop', op, desktopId, ...(token ? { token } : {}), ...(password ? { password } : {}) });
  }

  openGate(): Promise<Duplex> {
    if (!this.online()) return Promise.reject(new BoxError('BOX_AGENT_OFFLINE', '云端主机当前离线。'));
    return this.broker.openTunnel(this.deploymentId);
  }
}

/** POSIX shell 单引号转义：ssh 会把远端命令交给远端 shell 解析。 */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2'];

export function sshInvocation(target: string, remote: string[]): [string, string[]] {
  return ['ssh', [...SSH_OPTIONS, '--', target, remote.map(shellQuote).join(' ')]];
}

export class CloudSshAdapter implements HostAdapter {
  readonly id = 'cloud-ssh' as const;
  readonly kind = 'cloud' as const;
  private readonly docker: DockerBox;
  constructor(private readonly target: string, private readonly run: CommandRunner, private readonly names: BoxNames = BOX_NAMES) {
    // 远端 docker CLI 读取远端主机上的 seccomp 文件（由 install-cloud-host.sh 安装）。
    this.docker = new DockerBox(run, args => sshInvocation(target, ['docker', ...args]), { seccompProfile: () => BOX_REMOTE_SECCOMP_PATH, names });
  }

  private async memoryPressure(): Promise<BoxMemoryPressure> {
    const [file, args] = sshInvocation(this.target, ['cat', '/proc/pressure/memory']);
    const result = await this.run(file, args, { timeoutMs: 15_000 });
    return result.code === 0 ? parseLinuxMemoryPressure(result.stdout) : 'unknown';
  }

  async status(): Promise<BoxSnapshot> {
    const [file, args] = sshInvocation(this.target, ['docker', 'version', '--format', '{{.Server.Version}}']);
    const version = await this.run(file, args, { timeoutMs: 20_000 });
    const name = this.names.container;
    const blank = { container: { state: 'unknown' as const, name }, desktops: [], gateReady: false, memoryPressure: 'unknown' as const };
    if (version.notFound) return { ...blank, host: { state: 'not_installed', detail: '本机未找到 ssh 客户端。' } };
    if (version.code === 255 || version.timedOut) return { ...blank, host: { state: 'offline', detail: 'ssh 连接失败（检查 ssh 配置中的 Host 别名与密钥，需免交互登录）。' } };
    if (version.code !== 0) return { ...blank, host: { state: 'error', detail: '远端 docker 不可用。' } };
    const host: BoxHostStatus = { state: 'running', runtime: 'docker', version: parseSingleVersion(version.stdout) };
    const [{ container, desktops, gateReady }, memoryPressure] = await Promise.all([this.docker.inspect(), this.memoryPressure()]);
    return { host, container, desktops, gateReady, memoryPressure };
  }

  actions(snapshot: BoxSnapshot): BoxAction[] {
    return snapshot.host.state === 'running' ? containerActions(snapshot) : [];
  }

  async perform(action: BoxAction): Promise<void> {
    if (action === 'start_container') return this.docker.start();
    if (action === 'stop_container') return this.docker.stop();
    throw new BoxError('BOX_ACTION_UNSUPPORTED', '云端主机由服务商管理 VM，这里只能启停 box 容器。', 400);
  }

  desktop(op: DesktopOp, desktopId: string, token?: string, password?: string): Promise<void> {
    return this.docker.desktop(op, desktopId, token, password);
  }

  async openGate(): Promise<Duplex> {
    // 远端网关同样只绑远端 127.0.0.1，经 ssh -W 转发，不在远端开放端口。
    const ssh = findExecutable('ssh');
    if (!ssh) throw new BoxError('BOX_RUNTIME_NOT_INSTALLED', '本机未找到 ssh 客户端。');
    const child = spawn(ssh, [...SSH_OPTIONS, '-W', `127.0.0.1:${BOX_QUOTA.gateHostPort}`, '--', this.target], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: commandEnvironment() });
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    const stop = () => { if (child.exitCode === null) child.kill(); };
    stream.once('close', stop);
    stream.once('error', stop);
    child.once('exit', () => stream.destroy());
    return stream;
  }
}
