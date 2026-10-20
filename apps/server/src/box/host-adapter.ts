/**
 * 宿主适配层（machine-host provider）的统一接口与公共实现。
 *
 * 一个适配器负责“怎么拿到一个隔离的 Linux 运行环境，并在里面跑 pa-box 容器”。
 * 所有适配器产出同一种东西：宿主状态 + 容器状态 + 桌面列表 + 一条连到 box 网关的字节流。
 * server 侧的路由、鉴权、桌面并发策略、空闲停机、WebSocket 代理与宿主无关。
 *
 * 桌面访问链路（L0 实测后的固定做法）：
 *   浏览器 ⇄ server（Cookie / 桌面令牌鉴权，WebSocket 由 server 终结）
 *          ⇄ 宿主 127.0.0.1:47830（或 ssh -W / 反向隧道）
 *          ⇄ 容器内 pa-box-gate:6080（每桌面、60 秒一次性令牌）
 *          ⇄ /run/pa-box/dN/vnc.sock（0660，只有网关用户可连）⇄ Xvnc
 * 桌面从不监听 TCP，box 内的其他 bot 无法绕过网关连到别人的桌面。
 */
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import type {
  BoxAction, BoxAdapterId, BoxContainerStatus, BoxDeploymentKind, BoxHostStatus, BoxMemoryPressure,
} from '@personal-agent/contracts';
import type { CommandRunner } from './command.js';
import {
  BOX_GATE_CONTAINER_PORT, BOX_MAX_DESKTOPS, boxSafetyIssues, parseCtlStatus, parseDockerInspect, parseDockerStats,
  type BoxSafetyIssue, type CtlDesktop,
} from './parsers.js';

/** 固定错误码 + 固定中文说明；从不携带命令输出（可能含路径、主机名等）。 */
export class BoxError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) {
    super(message);
    this.name = 'BoxError';
  }
}

export interface BoxSnapshot {
  host: BoxHostStatus;
  container: BoxContainerStatus;
  /** 来自 box 内 `pa-box-ctl status`；容器未运行时为空。 */
  desktops: CtlDesktop[];
  /** 容器在运行且通过安全校验，网关可用。 */
  gateReady: boolean;
  memoryPressure: BoxMemoryPressure;
}

export type DesktopOp = 'start' | 'stop';

export interface HostAdapter {
  readonly id: BoxAdapterId;
  readonly kind: BoxDeploymentKind;
  /** 只读探测；任何失败都折算成状态，不抛异常。 */
  status(): Promise<BoxSnapshot>;
  /** 当前状态下可用的 VM / 容器管理动作。 */
  actions(snapshot: BoxSnapshot): BoxAction[];
  perform(action: BoxAction): Promise<void>;
  /**
   * 启动桌面（已运行时只轮换令牌）或停止桌面。token 与 VNC 口令只经 stdin 交给 box 内的 pa-box-ctl。
   * 并发上限、内存压力等准入检查由 BoxService 在调用前完成。
   */
  desktop(op: DesktopOp, desktopId: string, token?: string, password?: string): Promise<void>;
  /** 一条连到 box 网关（容器 6080）的原始字节流；调用方负责发送令牌前导。 */
  openGate(): Promise<Duplex>;
}

export interface BoxNames {
  profile: string;
  dockerContext: string;
  container: string;
  image: string;
  volume: string;
  volumeDestination: string;
  wslDistro: string;
}

/**
 * box 的默认命名。Colima profile / docker context / WSL 发行版仍用 `pa-box`；
 * **容器名**默认 `pa-box-desktop`，避免本机已有无关的 `pa-box` 容器挡住 verify/start。
 * 用 `PA_BOX_CONTAINER` 覆盖（见 resolveBoxNames）。
 */
export const BOX_NAMES: BoxNames = {
  profile: 'pa-box',
  dockerContext: 'colima-pa-box',
  container: 'pa-box-desktop',
  image: 'personal-agent/pa-box:0.1',
  volume: 'pa-box-home',
  volumeDestination: '/home',
  wslDistro: 'pa-box',
};

/** Docker 容器名：字母开头，最长 63，只含字母数字、点、下划线、短横线。 */
export const BOX_CONTAINER_NAME = /^[a-zA-Z][a-zA-Z0-9_.-]{0,62}$/;

export function resolveBoxNames(env: NodeJS.ProcessEnv = process.env, overrides?: Partial<BoxNames>): BoxNames {
  const raw = (overrides?.container ?? env.PA_BOX_CONTAINER ?? env.PERSONAL_AGENT_BOX_CONTAINER ?? BOX_NAMES.container).trim();
  if (!BOX_CONTAINER_NAME.test(raw)) throw new BoxError('BOX_INPUT_INVALID', 'PA_BOX_CONTAINER 不是合法的 Docker 容器名。', 400);
  return { ...BOX_NAMES, ...overrides, container: raw };
}

/**
 * 资源配额（L0 实测，M1 Mac mini 16GB）：
 * - VM 2 vCPU / 4GiB / 40GiB：VZ 不归还内存，4GiB 按常驻占用计算，不升到 6GiB；
 * - 容器 --memory 3.5g --memory-swap 3.5g（不使用 swap）--cpus 2 --shm-size 1g：
 *   3 个重负载桌面实测 1.47GiB，留有余量；
 * - 宿主侧网关端口固定 127.0.0.1:47830。
 */
export const BOX_QUOTA = {
  vmCpus: 2, vmMemoryGiB: 4, vmDiskGiB: 40,
  containerMemory: '3.5g', containerMemorySwap: '3.5g', containerCpus: '2', containerShm: '1g',
  maxDesktops: BOX_MAX_DESKTOPS, gateHostPort: 47830,
} as const;

/** box 内 pa-box-ctl 的固定路径。 */
export const BOX_CTL = '/usr/local/sbin/pa-box-ctl';

export interface BoxRunOptions {
  /** 由 docker CLI 读取的 seccomp 配置文件路径（CLI 所在机器上的路径）。 */
  seccompProfile: string;
  names?: BoxNames;
  quota?: typeof BOX_QUOTA;
}

/**
 * 创建 box 容器的参数。任何改动都要同步 boxSafetyIssues 的校验与 docs/desktop.md。
 * - 只发布网关端口，且永远写明 127.0.0.1（Colima 会把客体 0.0.0.0 的端口转发到宿主所有网卡）；
 * - 自定义 seccomp（moby 默认 + clone/unshare/setns，供 Chromium 沙箱使用）+ no-new-privileges；
 * - 不挂宿主目录、不挂 docker.sock、不共享宿主命名空间、不加 capability、不使用 --privileged。
 */
export function boxRunArgs(options: BoxRunOptions): string[] {
  const names = options.names ?? BOX_NAMES;
  const quota = options.quota ?? BOX_QUOTA;
  if (!options.seccompProfile || /[\r\n]/.test(options.seccompProfile)) throw new BoxError('BOX_SECCOMP_MISSING', '缺少 box 的 seccomp 配置文件。');
  return ['run', '-d', '--name', names.container, '--hostname', names.container, '--restart', 'unless-stopped',
    '--memory', quota.containerMemory, '--memory-swap', quota.containerMemorySwap, '--cpus', quota.containerCpus, '--shm-size', quota.containerShm,
    '--security-opt', `seccomp=${options.seccompProfile}`, '--security-opt', 'no-new-privileges',
    '--label', 'io.personal-agent.box=1',
    '-e', `PA_BOX_MAX_DESKTOPS=${quota.maxDesktops}`,
    '-p', `127.0.0.1:${quota.gateHostPort}:${BOX_GATE_CONTAINER_PORT}`,
    '-v', `${names.volume}:${names.volumeDestination}`,
    names.image];
}

const SAFETY_TEXT: Record<BoxSafetyIssue, string> = {
  GATE_PORT_MISSING: '未发布网关端口',
  PORT_NOT_LOOPBACK: '有端口发布到了非 127.0.0.1 地址',
  UNEXPECTED_PORT: '发布了网关以外的端口',
  PRIVILEGED: '容器是特权容器',
  CAP_ADD: '容器添加了额外 capability',
  NO_SECCOMP: '未使用自定义 seccomp 配置',
  NO_NEW_PRIVILEGES_MISSING: '未设置 no-new-privileges',
  HOST_NAMESPACE: '共享了宿主的命名空间',
  UNEXPECTED_MOUNT: '挂载了 pa-box-home 以外的目录或卷',
};

export function describeSafetyIssues(issues: BoxSafetyIssue[]): string {
  return `box 容器未通过安全校验（${issues.map(issue => SAFETY_TEXT[issue]).join('、')}），已拒绝启动与串流。请删除该容器后由本页重新创建。`;
}

export type DockerInvocation = (args: string[]) => [file: string, args: string[]];

export interface DockerBoxOptions {
  /** 由调用时解析：本地是仓库 / 安装包里的文件，WSL2 与云端是主机上的固定路径。 */
  seccompProfile: () => string;
  names?: BoxNames;
}

export interface DockerBoxInspection {
  container: BoxContainerStatus;
  desktops: CtlDesktop[];
  gateReady: boolean;
  issues: BoxSafetyIssue[];
}

/**
 * 对“某个 docker 兼容 CLI”上的 pa-box 容器做查询、启停、安全校验与桌面控制。
 * 由 invocation 决定命令前缀：colima 用 `docker --context colima-pa-box`，
 * WSL2 用 `wsl.exe -d pa-box --exec docker`，Linux 用 `podman` / `docker`，ssh 用 `ssh <alias> -- docker`。
 */
export class DockerBox {
  private readonly names: BoxNames;
  constructor(private readonly run: CommandRunner, private readonly invoke: DockerInvocation, private readonly options: DockerBoxOptions) {
    this.names = options.names ?? BOX_NAMES;
  }

  private safetyOf(stdout: string) {
    const inspected = parseDockerInspect(stdout);
    if (!inspected) return undefined;
    return { inspected, issues: boxSafetyIssues(inspected, { gateHostPort: BOX_QUOTA.gateHostPort, volume: this.names.volume, volumeDestination: this.names.volumeDestination }) };
  }

  async inspect(): Promise<DockerBoxInspection> {
    const [file, args] = this.invoke(['inspect', this.names.container, '--format', '{{json .}}']);
    const result = await this.run(file, args, { timeoutMs: 10_000 });
    const name = this.names.container;
    const empty = { desktops: [], gateReady: false, issues: [] };
    if (result.notFound) return { ...empty, container: { state: 'unknown', name, detail: '未找到 docker 兼容的命令行工具。' } };
    if (result.code !== 0) {
      if (/no such (object|container)|no container with name/i.test(result.stderr)) {
        return { ...empty, container: { state: 'missing', name, detail: '尚未创建 box 容器。' } };
      }
      return { ...empty, container: { state: 'unknown', name, detail: result.timedOut ? '查询容器超时。' : '无法查询容器状态（运行时可能未启动）。' } };
    }
    const safety = this.safetyOf(result.stdout);
    if (!safety) return { ...empty, container: { state: 'unknown', name, detail: '容器信息无法解析。' } };
    const { inspected, issues } = safety;
    const running = inspected.state === 'running';
    const container: BoxContainerStatus = { state: inspected.state, name, image: inspected.image, statusText: inspected.statusText,
      ...(inspected.memoryLimitBytes ? { memoryLimitBytes: inspected.memoryLimitBytes } : {}),
      ...(issues.length ? { detail: describeSafetyIssues(issues) } : {}) };
    if (!running) return { container, desktops: [], gateReady: false, issues };
    const [statsFile, statsArgs] = this.invoke(['stats', '--no-stream', '--format', '{{json .}}', name]);
    const stats = await this.run(statsFile, statsArgs, { timeoutMs: 10_000 });
    const parsed = stats.code === 0 ? parseDockerStats(stats.stdout) : undefined;
    if (parsed) Object.assign(container, parsed);
    if (issues.length) return { container, desktops: [], gateReady: false, issues };
    const [ctlFile, ctlArgs] = this.invoke(['exec', name, BOX_CTL, 'status']);
    const ctl = await this.run(ctlFile, ctlArgs, { timeoutMs: 10_000 });
    const status = ctl.code === 0 ? parseCtlStatus(ctl.stdout) : undefined;
    if (!status) {
      container.detail = '容器在运行，但无法读取桌面状态（镜像版本可能过旧，请按 docs/desktop.md 重建镜像）。';
      return { container, desktops: [], gateReady: false, issues };
    }
    return { container, desktops: status.desktops, gateReady: true, issues };
  }

  async start(): Promise<void> {
    const current = await this.inspect();
    if (current.issues.length) throw new BoxError('BOX_CONTAINER_UNSAFE', describeSafetyIssues(current.issues));
    if (current.container.state === 'running') return;
    if (current.container.state === 'missing') {
      const [imageFile, imageArgs] = this.invoke(['image', 'inspect', this.names.image, '--format', '{{.Id}}']);
      const image = await this.run(imageFile, imageArgs, { timeoutMs: 10_000 });
      if (image.code !== 0) throw new BoxError('BOX_IMAGE_MISSING', `尚未构建 box 镜像 ${this.names.image}。请先按 docs/desktop.md 构建镜像。`);
      await this.expect(boxRunArgs({ seccompProfile: this.options.seccompProfile(), names: this.names }), 'BOX_CONTAINER_CREATE_FAILED', '创建 box 容器失败。', 120_000);
      // 创建后立即复核实际生效的配置；不符合就删除，绝不让暴露的容器继续运行。
      const created = await this.inspect();
      if (created.issues.length || created.container.state === 'unknown' || created.container.state === 'missing') {
        await this.remove();
        throw new BoxError('BOX_CONTAINER_UNSAFE', created.issues.length ? describeSafetyIssues(created.issues) : '新建的 box 容器无法校验，已删除。');
      }
      return;
    }
    await this.expect(['start', this.names.container], 'BOX_CONTAINER_START_FAILED', '启动 box 容器失败。', 60_000);
  }

  async stop(): Promise<void> {
    await this.expect(['stop', '--time', '20', this.names.container], 'BOX_CONTAINER_STOP_FAILED', '停止 box 容器失败。', 60_000);
  }

  /** 只删除当前配置的 box 容器本身；不删除卷与镜像。 */
  async remove(): Promise<void> {
    const [file, args] = this.invoke(['rm', '-f', this.names.container]);
    await this.run(file, args, { timeoutMs: 60_000 });
  }

  async desktop(op: DesktopOp, desktopId: string, token?: string, password?: string): Promise<void> {
    if (!/^d[1-9]$/.test(desktopId) || Number(desktopId.slice(1)) > BOX_QUOTA.maxDesktops) throw new BoxError('BOX_DESKTOP_NOT_FOUND', '桌面不存在。', 404);
    if (op === 'start' && (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))) throw new BoxError('BOX_INPUT_INVALID', '桌面令牌无效。', 400);
    if (op === 'start' && (!password || password.length < 8 || password.includes('\n') || password.includes('\0'))) {
      throw new BoxError('BOX_INPUT_INVALID', '桌面 VNC 口令无效。', 400);
    }
    // `exec -i`：令牌与 VNC 口令经 stdin 传入，不出现在任何进程的命令行里。
    const [file, args] = this.invoke(['exec', ...(op === 'start' ? ['-i'] : []), this.names.container, BOX_CTL, op, desktopId]);
    const result = await this.run(file, args, { timeoutMs: op === 'start' ? 45_000 : 30_000, ...(op === 'start' ? { input: `${token}\n${password}\n` } : {}) });
    if (result.notFound) throw new BoxError('BOX_RUNTIME_NOT_INSTALLED', '未找到容器运行时命令行工具。');
    if (result.code === 0) return;
    if (result.code === 66) throw new BoxError('BOX_DESKTOP_LIMIT', `box 内已达到桌面硬上限（${BOX_QUOTA.maxDesktops} 个），请先停止一个空闲桌面。`);
    if (result.code === 71) throw new BoxError('BOX_DESKTOP_UNSAFE', '桌面进程监听了 TCP 端口，已被停止。请检查镜像版本。');
    throw new BoxError(op === 'start' ? 'BOX_DESKTOP_START_FAILED' : 'BOX_DESKTOP_STOP_FAILED', op === 'start' ? (result.timedOut ? '启动桌面超时。' : '启动桌面失败。') : '停止桌面失败。');
  }

  private async expect(args: string[], code: string, message: string, timeoutMs: number): Promise<void> {
    const [file, invocation] = this.invoke(args);
    const result = await this.run(file, invocation, { timeoutMs });
    if (result.notFound) throw new BoxError('BOX_RUNTIME_NOT_INSTALLED', '未找到容器运行时命令行工具。');
    if (result.code !== 0) throw new BoxError(code, result.timedOut ? `${message}（超时）` : message);
  }
}

/** 本地 / WSL2 / Linux 的通用 actions：只有 VM 层存在时才提供启停 VM。 */
export function containerActions(snapshot: BoxSnapshot): BoxAction[] {
  if (snapshot.container.state === 'running') return ['stop_container'];
  return snapshot.container.state === 'stopped' || snapshot.container.state === 'missing' ? ['start_container'] : [];
}

/** 连到本机 127.0.0.1 上的网关端口（Colima / WSL2 的 localhost 转发都落在这里）。 */
export function connectLoopback(port: number, timeoutMs = 5_000): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => { socket.destroy(); reject(new BoxError('BOX_DESKTOP_UNREACHABLE', 'box 网关端口无法连接。', 502)); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', () => { clearTimeout(timer); reject(new BoxError('BOX_DESKTOP_UNREACHABLE', 'box 网关端口无法连接。', 502)); });
  });
}
