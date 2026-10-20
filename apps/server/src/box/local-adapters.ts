/**
 * 本地宿主适配器：
 * - macOS：Colima 独立 profile `pa-box`（vz），docker 命令一律显式 `--context colima-pa-box`；
 *   启动一律 `--activate=false --mount none`：从不切换默认 docker 上下文（L0 那台 Mac 的默认上下文是
 *   orbstack，必须保持），从不挂载宿主目录，从不操作 default profile。
 * - Windows：专用 WSL2 发行版 `pa-box`，用 `wsl.exe -l -v` 检测，发行版内 docker 管理容器（实验性）。
 * - Linux：rootless Podman（优先）或 Docker（实验性，只管理 pa-box 容器）。
 */
import { readFile } from 'node:fs/promises';
import type { BoxAction, BoxHostStatus, BoxMemoryPressure } from '@personal-agent/contracts';
import type { CommandRunner } from './command.js';
import { BOX_REMOTE_SECCOMP_PATH, BOX_SECCOMP_FILE, resolveBoxAsset } from './assets.js';
import {
  BOX_NAMES, BOX_QUOTA, BoxError, DockerBox, connectLoopback, containerActions,
  type BoxSnapshot, type DesktopOp, type HostAdapter,
} from './host-adapter.js';
import {
  loopbackListenAddress, parseColimaList, parseColimaVersion, parseLinuxMemoryPressure, parseLsofListenAddresses,
  parseMacMemoryPressure, parseSingleVersion, parseWslList,
} from './parsers.js';

const unavailable = (host: BoxHostStatus, memoryPressure: BoxMemoryPressure = 'unknown'): BoxSnapshot =>
  ({ host, container: { state: 'unknown', name: BOX_NAMES.container }, desktops: [], gateReady: false, memoryPressure });

export interface ColimaAdapterOptions {
  run: CommandRunner;
  /** Node 的 process.arch；决定 `--arch aarch64 | x86_64`。 */
  arch?: string;
  /** 测试注入；默认解析仓库 / 安装包里的 deploy/box/pa-box-seccomp.json。 */
  seccompProfile?: () => string;
  now?: () => number;
}

const colimaArch = (arch: string) => arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined;

/**
 * Colima 启动参数（与 L0 实测命令一致）：
 *   colima start pa-box --vm-type vz --runtime docker --cpus 2 --memory 4 --disk 40 --arch aarch64 --activate=false --mount none
 * 已存在的 profile 只追加 --activate=false --mount none（配额沿用创建时的设置）。
 */
export function colimaStartArgs(exists: boolean, arch: string = process.arch): string[] {
  const always = ['--activate=false', '--mount', 'none'];
  if (exists) return ['start', BOX_NAMES.profile, ...always];
  const vmArch = colimaArch(arch);
  return ['start', BOX_NAMES.profile, '--vm-type', 'vz', '--runtime', 'docker',
    '--cpus', String(BOX_QUOTA.vmCpus), '--memory', String(BOX_QUOTA.vmMemoryGiB), '--disk', String(BOX_QUOTA.vmDiskGiB),
    ...(vmArch ? ['--arch', vmArch] : []), ...always];
}

export class ColimaAdapter implements HostAdapter {
  readonly id = 'colima' as const;
  readonly kind = 'local' as const;
  private readonly docker: DockerBox;
  private readonly now: () => number;
  private listenerCheckedAt = 0;

  constructor(private readonly options: ColimaAdapterOptions) {
    this.now = options.now ?? Date.now;
    this.docker = new DockerBox(options.run, args => ['docker', ['--context', BOX_NAMES.dockerContext, ...args]],
      { seccompProfile: options.seccompProfile ?? (() => resolveBoxAsset(BOX_SECCOMP_FILE)) });
  }

  /** macOS 的系统内存压力等级（与 `memory_pressure` 命令同源）。 */
  async memoryPressure(): Promise<BoxMemoryPressure> {
    const result = await this.options.run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeoutMs: 5_000 });
    return result.code === 0 ? parseMacMemoryPressure(result.stdout) : 'unknown';
  }

  async status(): Promise<BoxSnapshot> {
    const version = await this.options.run('colima', ['version'], { timeoutMs: 10_000 });
    if (version.notFound) {
      return unavailable({ state: 'not_installed', detail: '未安装 Colima。', installHint: 'brew install colima docker' });
    }
    const memoryPressure = await this.memoryPressure();
    const listed = await this.options.run('colima', ['list', '--json'], { timeoutMs: 15_000 });
    if (listed.code !== 0) {
      return unavailable({ state: 'error', version: parseColimaVersion(version.stdout), detail: listed.timedOut ? '查询 Colima 超时。' : '无法读取 Colima profile 列表。' }, memoryPressure);
    }
    const profile = parseColimaList(listed.stdout).find(item => item.name === BOX_NAMES.profile);
    const base = { version: parseColimaVersion(version.stdout), profile: BOX_NAMES.profile };
    if (!profile) {
      return unavailable({ ...base, state: 'not_configured', detail: `尚未创建 Colima profile ${BOX_NAMES.profile}。`,
        installHint: `点击“启动 VM”会以 ${BOX_QUOTA.vmCpus} vCPU / ${BOX_QUOTA.vmMemoryGiB}GiB / ${BOX_QUOTA.vmDiskGiB}GiB、无宿主挂载、不切换默认 docker 上下文创建该 profile。` }, memoryPressure);
    }
    const host: BoxHostStatus = { ...base, state: profile.state, arch: profile.arch, runtime: profile.runtime,
      resources: { cpus: profile.cpus, memoryBytes: profile.memoryBytes, diskBytes: profile.diskBytes } };
    if (profile.state !== 'running') {
      return { host, container: { state: 'unknown', name: BOX_NAMES.container, detail: 'VM 未运行。' }, desktops: [], gateReady: false, memoryPressure };
    }
    const { container, desktops, gateReady } = await this.docker.inspect();
    return { host, container, desktops, gateReady, memoryPressure };
  }

  actions(snapshot: BoxSnapshot): BoxAction[] {
    if (snapshot.host.state === 'not_installed' || snapshot.host.state === 'error') return [];
    if (snapshot.host.state !== 'running') return ['start_vm'];
    return ['stop_vm', ...containerActions(snapshot)];
  }

  async perform(action: BoxAction): Promise<void> {
    if (action === 'start_vm') return this.startVm();
    if (action === 'stop_vm') {
      const result = await this.options.run('colima', ['stop', BOX_NAMES.profile], { timeoutMs: 180_000 });
      if (result.notFound) throw new BoxError('BOX_RUNTIME_NOT_INSTALLED', '未安装 Colima。');
      if (result.code !== 0) throw new BoxError('BOX_VM_STOP_FAILED', '停止 Colima profile 失败。');
      return;
    }
    if (action === 'start_container') {
      await this.docker.start();
      await this.verifyHostListener(true);
      return;
    }
    if (action === 'stop_container') return this.docker.stop();
    throw new BoxError('BOX_ACTION_UNSUPPORTED', '不支持的操作。', 400);
  }

  desktop(op: DesktopOp, desktopId: string, token?: string): Promise<void> {
    return this.docker.desktop(op, desktopId, token);
  }

  async openGate() {
    await this.verifyHostListener(false);
    return connectLoopback(BOX_QUOTA.gateHostPort);
  }

  /**
   * 宿主侧复核：Colima（lima）把客体端口经 ssh 转发到宿主；客体若绑在 0.0.0.0，宿主会监听所有网卡。
   * docker inspect 只能看到“请求的”发布方式，这里再用 lsof 看宿主上实际的监听地址。
   * 发现非 loopback 监听时停止容器并拒绝串流。lsof 不可用时跳过（docker inspect 校验仍然生效）。
   */
  private async verifyHostListener(force: boolean): Promise<void> {
    if (!force && this.now() - this.listenerCheckedAt < 30_000) return;
    const result = await this.options.run('/usr/sbin/lsof', ['-nP', `-iTCP:${BOX_QUOTA.gateHostPort}`, '-sTCP:LISTEN', '-Fn'], { timeoutMs: 10_000 });
    if (result.notFound || (result.code !== 0 && result.code !== 1)) return;
    const addresses = parseLsofListenAddresses(result.stdout, BOX_QUOTA.gateHostPort);
    if (addresses.some(address => !loopbackListenAddress(address))) {
      this.listenerCheckedAt = 0;
      await this.docker.stop().catch(() => undefined);
      throw new BoxError('BOX_PORT_EXPOSED', `宿主上 ${BOX_QUOTA.gateHostPort} 端口监听在非 127.0.0.1 地址，已停止 box 容器。请检查 Colima 的端口转发配置。`);
    }
    this.listenerCheckedAt = this.now();
  }

  /** 记录启动前的 docker 当前上下文；启动后若被改掉则改回去（兜底，正常情况下 --activate=false 不会改）。 */
  private async currentDockerContext(): Promise<string | undefined> {
    const result = await this.options.run('docker', ['context', 'show'], { timeoutMs: 10_000 });
    const name = result.code === 0 ? result.stdout.trim() : '';
    return /^[A-Za-z0-9._-]{1,128}$/.test(name) ? name : undefined;
  }

  private async startVm(): Promise<void> {
    const before = await this.currentDockerContext();
    const listed = await this.options.run('colima', ['list', '--json'], { timeoutMs: 15_000 });
    if (listed.notFound) throw new BoxError('BOX_RUNTIME_NOT_INSTALLED', '未安装 Colima。');
    const exists = parseColimaList(listed.stdout).some(item => item.name === BOX_NAMES.profile);
    const result = await this.options.run('colima', colimaStartArgs(exists, this.options.arch), { timeoutMs: 20 * 60_000 });
    const after = await this.currentDockerContext();
    if (before && after && before !== after) {
      await this.options.run('docker', ['context', 'use', before], { timeoutMs: 10_000 });
    }
    if (result.code !== 0 && /unknown flag.*activate/i.test(result.stderr)) {
      // 不支持 --activate 的旧版本会切换默认上下文，这里拒绝而不是退回不带该参数的启动。
      throw new BoxError('BOX_COLIMA_TOO_OLD', 'Colima 版本过旧（不支持 --activate=false）。请先 `brew upgrade colima`（L0 实测 0.10.3 可用）。');
    }
    if (result.code !== 0) throw new BoxError('BOX_VM_START_FAILED', result.timedOut ? '启动 Colima profile 超时。' : '启动 Colima profile 失败。可在终端运行 `colima start pa-box --activate=false --mount none` 查看原因。');
  }
}

export interface WslAdapterOptions { run: CommandRunner }

/**
 * Windows 宿主：专用 WSL2 发行版 pa-box（需在 /etc/wsl.conf 关闭 automount 与 interop，见 docs/windows-gaps.md）。
 * 检测与容器状态是真实实现；创建发行版（导入 rootfs）尚未实现，只给出指引。
 * seccomp 配置由 docker CLI 在发行版内读取，所以使用发行版内的 /etc/pa-box/seccomp.json。
 */
export class Wsl2Adapter implements HostAdapter {
  readonly id = 'wsl2' as const;
  readonly kind = 'local' as const;
  private readonly docker: DockerBox;
  constructor(private readonly options: WslAdapterOptions) {
    this.docker = new DockerBox(options.run, args => ['wsl.exe', ['-d', BOX_NAMES.wslDistro, '--exec', 'docker', ...args]],
      { seccompProfile: () => BOX_REMOTE_SECCOMP_PATH });
  }

  private async memoryPressure(): Promise<BoxMemoryPressure> {
    const result = await this.options.run('wsl.exe', ['-d', BOX_NAMES.wslDistro, '--exec', 'cat', '/proc/pressure/memory'], { timeoutMs: 10_000, encoding: 'auto' });
    return result.code === 0 ? parseLinuxMemoryPressure(result.stdout) : 'unknown';
  }

  async status(): Promise<BoxSnapshot> {
    const listed = await this.options.run('wsl.exe', ['-l', '-v'], { timeoutMs: 15_000, encoding: 'auto' });
    const hint = '创建发行版尚未自动化，请按 docs/windows-gaps.md 的步骤导入。';
    if (listed.notFound) return unavailable({ state: 'not_installed', detail: '未检测到 WSL。', installHint: '以管理员身份运行 `wsl --install --no-distribution`，重启后再回来。' });
    // 已安装 WSL 但没有任何发行版时，wsl -l -v 返回非 0。
    if (listed.code !== 0) return unavailable({ state: 'not_configured', detail: '尚未创建 WSL2 发行版 pa-box。', installHint: hint });
    const distro = parseWslList(listed.stdout).find(item => item.name.toLowerCase() === BOX_NAMES.wslDistro);
    if (!distro) return unavailable({ state: 'not_configured', detail: '尚未创建 WSL2 发行版 pa-box。', installHint: hint });
    if (distro.version !== 2) return unavailable({ state: 'error', profile: distro.name, detail: 'pa-box 发行版不是 WSL2，box 需要 WSL2。' });
    const host: BoxHostStatus = { state: distro.state === 'running' ? 'running' : 'stopped', profile: distro.name, runtime: 'docker (WSL2)' };
    if (host.state !== 'running') return { host, container: { state: 'unknown', name: BOX_NAMES.container, detail: '发行版未运行。' }, desktops: [], gateReady: false, memoryPressure: 'unknown' };
    const [{ container, desktops, gateReady }, memoryPressure] = await Promise.all([this.docker.inspect(), this.memoryPressure()]);
    return { host, container, desktops, gateReady, memoryPressure };
  }

  actions(snapshot: BoxSnapshot): BoxAction[] {
    if (!['running', 'stopped'].includes(snapshot.host.state)) return [];
    if (snapshot.host.state === 'stopped') return ['start_vm'];
    return ['stop_vm', ...containerActions(snapshot)];
  }

  async perform(action: BoxAction): Promise<void> {
    if (action === 'start_vm') {
      // 启动发行版；其中的 dockerd 由发行版内 systemd 或 wsl.conf 的 boot 命令拉起。
      const result = await this.options.run('wsl.exe', ['-d', BOX_NAMES.wslDistro, '--exec', 'true'], { timeoutMs: 120_000, encoding: 'auto' });
      if (result.code !== 0) throw new BoxError('BOX_VM_START_FAILED', '启动 WSL2 发行版 pa-box 失败。');
      return;
    }
    if (action === 'stop_vm') {
      const result = await this.options.run('wsl.exe', ['--terminate', BOX_NAMES.wslDistro], { timeoutMs: 60_000, encoding: 'auto' });
      if (result.code !== 0) throw new BoxError('BOX_VM_STOP_FAILED', '停止 WSL2 发行版 pa-box 失败。');
      return;
    }
    if (action === 'start_container') return this.docker.start();
    if (action === 'stop_container') return this.docker.stop();
    throw new BoxError('BOX_ACTION_UNSUPPORTED', '不支持的操作。', 400);
  }

  desktop(op: DesktopOp, desktopId: string, token?: string): Promise<void> {
    return this.docker.desktop(op, desktopId, token);
  }

  openGate() {
    // WSL2 默认（NAT + localhostForwarding）把发行版内 127.0.0.1 端口转发到 Windows 的 127.0.0.1。
    return connectLoopback(BOX_QUOTA.gateHostPort);
  }
}

export interface LinuxAdapterOptions {
  run: CommandRunner;
  seccompProfile?: () => string;
  readPressure?: () => Promise<string>;
}

/**
 * Linux 宿主：rootless Podman 优先，其次 Docker。没有 VM 层（共享宿主内核，隔离弱于 mac/Windows）。
 * 只管理名为 pa-box 的容器；rootless 检测、gVisor 等加固尚未实现。
 */
export class LinuxContainerAdapter implements HostAdapter {
  readonly kind = 'local' as const;
  id: 'podman' | 'docker' = 'podman';
  private engine: 'podman' | 'docker' | undefined;
  constructor(private readonly options: LinuxAdapterOptions) {}

  private box(): DockerBox {
    const engine = this.engine ?? 'podman';
    return new DockerBox(this.options.run, args => [engine, args], { seccompProfile: this.options.seccompProfile ?? (() => resolveBoxAsset(BOX_SECCOMP_FILE)) });
  }

  private async memoryPressure(): Promise<BoxMemoryPressure> {
    try { return parseLinuxMemoryPressure(await (this.options.readPressure ?? (() => readFile('/proc/pressure/memory', 'utf8')))()); }
    catch { return 'unknown'; }
  }

  async status(): Promise<BoxSnapshot> {
    for (const engine of ['podman', 'docker'] as const) {
      const version = await this.options.run(engine, ['version', '--format', engine === 'podman' ? '{{.Client.Version}}' : '{{.Server.Version}}'], { timeoutMs: 10_000 });
      if (version.notFound) continue;
      this.engine = engine;
      this.id = engine;
      const memoryPressure = await this.memoryPressure();
      if (version.code !== 0) return unavailable({ state: 'stopped', runtime: engine, detail: `${engine} 已安装，但守护进程 / 服务未运行。` }, memoryPressure);
      const host: BoxHostStatus = { state: 'running', runtime: engine, version: parseSingleVersion(version.stdout),
        detail: '共享宿主内核（无 VM 边界），建议 rootless 运行。' };
      const { container, desktops, gateReady } = await this.box().inspect();
      return { host, container, desktops, gateReady, memoryPressure };
    }
    return unavailable({ state: 'not_installed', detail: '未检测到 Podman 或 Docker。', installHint: 'sudo apt install podman（推荐 rootless）' });
  }

  actions(snapshot: BoxSnapshot): BoxAction[] {
    return snapshot.host.state === 'running' ? containerActions(snapshot) : [];
  }

  async perform(action: BoxAction): Promise<void> {
    if (!this.engine) await this.status();
    if (action === 'start_container') return this.box().start();
    if (action === 'stop_container') return this.box().stop();
    throw new BoxError('BOX_ACTION_NOT_IMPLEMENTED', 'Linux 宿主没有 VM 层，不支持启停 VM。', 400);
  }

  async desktop(op: DesktopOp, desktopId: string, token?: string): Promise<void> {
    if (!this.engine) await this.status();
    return this.box().desktop(op, desktopId, token);
  }

  openGate() {
    return connectLoopback(BOX_QUOTA.gateHostPort);
  }
}

/** 选出本机平台对应的本地适配器。 */
export function localAdapterFor(platform: NodeJS.Platform, run: CommandRunner): HostAdapter | undefined {
  if (platform === 'darwin') return new ColimaAdapter({ run });
  if (platform === 'win32') return new Wsl2Adapter({ run });
  if (platform === 'linux') return new LinuxContainerAdapter({ run });
  return undefined;
}
