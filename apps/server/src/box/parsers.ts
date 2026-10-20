/**
 * colima / docker / podman / wsl.exe 输出解析。
 *
 * 全部是纯函数：输入命令 stdout 文本，输出结构化结果；任何无法确认的字段一律
 * 丢弃，而不是猜测。单元测试直接喂录制下来的样例输出。
 */
import type { BoxContainerState, BoxHostState, BoxMemoryPressure } from '@personal-agent/contracts';

/** box 镜像约定：容器内唯一的 TCP 监听是网关 pa-box-gate（6080）；桌面只走 unix socket。 */
export const BOX_GATE_CONTAINER_PORT = 6080;
/** 镜像预置的桌面用户 bot1..bot3，即桌面硬上限（L0：3 个重负载桌面时 VM used 1.9GB）。 */
export const BOX_MAX_DESKTOPS = 3;

export interface ColimaProfile {
  name: string;
  state: BoxHostState;
  arch?: string;
  cpus?: number;
  memoryBytes?: number;
  diskBytes?: number;
  runtime?: string;
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const shortString = (value: unknown, max = 200): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : undefined;

/** `colima version` 的第一行形如 "colima version 0.8.1"（也可能带 v 前缀）。 */
export function parseColimaVersion(stdout: string): string | undefined {
  return /colima version v?(\d+\.\d+(?:\.\d+)?[\w.-]*)/i.exec(stdout)?.[1];
}

function colimaState(status: unknown): BoxHostState {
  const value = typeof status === 'string' ? status.toLowerCase() : '';
  if (value === 'running') return 'running';
  if (value === 'stopped') return 'stopped';
  if (value === 'starting' || value === 'broken') return value === 'starting' ? 'starting' : 'error';
  return 'unknown';
}

/**
 * `colima list --json` 每行一个 JSON 对象（不同版本也可能输出一个数组）。
 * memory / disk 新版本是字节数，旧版本是 GiB 数字，按数量级换算。
 */
export function parseColimaList(stdout: string): ColimaProfile[] {
  const text = stdout.trim();
  if (!text) return [];
  let rows: unknown[] = [];
  if (text.startsWith('[')) {
    try { const parsed = JSON.parse(text); rows = Array.isArray(parsed) ? parsed : []; } catch { return []; }
  } else {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* 跳过非 JSON 行（例如警告） */ }
    }
  }
  const gib = (value: unknown) => {
    const number = finiteNumber(value);
    if (number === undefined) return undefined;
    return number < 4096 ? Math.round(number * 1024 ** 3) : number;
  };
  return rows.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const value = row as Record<string, unknown>;
    const name = shortString(value.name, 64);
    if (!name) return [];
    return [{ name, state: colimaState(value.status), arch: shortString(value.arch, 32), cpus: finiteNumber(value.cpus),
      memoryBytes: gib(value.memory), diskBytes: gib(value.disk), runtime: shortString(value.runtime, 32) }];
  });
}

/** docker stats 的大小：B / kB / KiB / MB / MiB / GB / GiB / TB / TiB。 */
export function parseSize(text: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kKMGT]?i?B)\s*$/.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2];
  const binary = unit.includes('i');
  const prefix = unit[0].toUpperCase();
  const power = ({ B: 0, K: 1, M: 2, G: 3, T: 4 } as Record<string, number>)[unit === 'B' ? 'B' : prefix];
  if (power === undefined || !Number.isFinite(value)) return undefined;
  return Math.round(value * (binary ? 1024 : 1000) ** power);
}

export interface ContainerStats { cpuPercent?: number; memoryUsedBytes?: number; memoryLimitBytes?: number }

/** `docker stats --no-stream --format '{{json .}}' <name>`（podman 字段名相同或为小写）。 */
export function parseDockerStats(stdout: string): ContainerStats | undefined {
  const line = stdout.trim().split(/\r?\n/).find(item => item.trim().startsWith('{'));
  if (!line) return undefined;
  let row: Record<string, unknown>;
  try { row = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  const cpuText = String(row.CPUPerc ?? row.cpu_percent ?? row.CPU ?? '');
  const memText = String(row.MemUsage ?? row.mem_usage ?? '');
  const cpu = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(cpuText);
  const [used, limit] = memText.split('/').map(part => parseSize(part));
  const result: ContainerStats = {};
  if (cpu) result.cpuPercent = Number(cpu[1]);
  if (used !== undefined) result.memoryUsedBytes = used;
  if (limit !== undefined) result.memoryLimitBytes = limit;
  return Object.keys(result).length ? result : undefined;
}

export interface PortBinding { containerPort: number; hostIp: string; hostPort: number }

export interface ContainerMount { type: string; name?: string; destination: string }

export interface ContainerInspection {
  state: BoxContainerState;
  image?: string;
  statusText?: string;
  memoryLimitBytes?: number;
  bindings: PortBinding[];
  /** 安全校验需要的字段（docker / podman 的 inspect 输出均有）。 */
  privileged: boolean;
  capAdd: string[];
  securityOpt: string[];
  seccompProfilePath?: string;
  networkMode?: string;
  pidMode?: string;
  ipcMode?: string;
  mounts: ContainerMount[];
}

const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * `docker inspect <name> --format '{{json .}}'`（podman 可能返回数组）。
 * 端口取 HostConfig.PortBindings（请求的发布方式，容器停止时也存在）。
 */
export function parseDockerInspect(stdout: string): ContainerInspection | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim()); } catch { return undefined; }
  const row = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, any> | undefined;
  if (!row || typeof row !== 'object') return undefined;
  const status = String(row.State?.Status ?? '').toLowerCase();
  const state: BoxContainerState = row.State?.Running === true || status === 'running' ? 'running'
    : ['exited', 'created', 'paused', 'stopped', 'configured', 'dead'].includes(status) ? 'stopped' : 'unknown';
  const bindings: PortBinding[] = [];
  const portBindings = row.HostConfig?.PortBindings;
  if (portBindings && typeof portBindings === 'object') {
    for (const [key, list] of Object.entries(portBindings as Record<string, unknown>)) {
      const port = /^(\d+)\/(tcp|udp|sctp)$/.exec(key);
      if (!port || !Array.isArray(list)) continue;
      for (const binding of list as Array<Record<string, unknown>>) {
        const hostPort = Number(binding?.HostPort);
        // HostPort 为空表示随机端口：同样记录下来（hostPort=0），交给安全校验判为异常。
        bindings.push({ containerPort: port[2] === 'tcp' ? Number(port[1]) : -1, hostIp: typeof binding?.HostIp === 'string' ? binding.HostIp : '',
          hostPort: Number.isSafeInteger(hostPort) && hostPort >= 1 && hostPort <= 65_535 ? hostPort : 0 });
      }
    }
  }
  const mounts: ContainerMount[] = Array.isArray(row.Mounts) ? row.Mounts.flatMap((mount: any) => mount && typeof mount === 'object'
    ? [{ type: String(mount.Type ?? ''), ...(typeof mount.Name === 'string' ? { name: mount.Name } : {}), destination: String(mount.Destination ?? '') }] : []) : [];
  const memory = finiteNumber(row.HostConfig?.Memory);
  return { state, image: shortString(row.Config?.Image), statusText: shortString(row.State?.Status, 64),
    ...(memory ? { memoryLimitBytes: memory } : {}), bindings,
    privileged: row.HostConfig?.Privileged === true,
    capAdd: stringList(row.HostConfig?.CapAdd),
    securityOpt: stringList(row.HostConfig?.SecurityOpt),
    ...(typeof row.SeccompProfilePath === 'string' ? { seccompProfilePath: row.SeccompProfilePath } : {}),
    ...(typeof row.HostConfig?.NetworkMode === 'string' ? { networkMode: row.HostConfig.NetworkMode } : {}),
    ...(typeof row.HostConfig?.PidMode === 'string' ? { pidMode: row.HostConfig.PidMode } : {}),
    ...(typeof row.HostConfig?.IpcMode === 'string' ? { ipcMode: row.HostConfig.IpcMode } : {}),
    mounts };
}

/** 只有绑定到 127.0.0.1 的端口才允许；0.0.0.0 / 空 HostIp / ::  都视为暴露。 */
export function loopbackBinding(binding: PortBinding): boolean {
  return binding.hostIp === '127.0.0.1';
}

export type BoxSafetyIssue =
  | 'GATE_PORT_MISSING' | 'PORT_NOT_LOOPBACK' | 'UNEXPECTED_PORT' | 'PRIVILEGED' | 'CAP_ADD'
  | 'NO_SECCOMP' | 'NO_NEW_PRIVILEGES_MISSING' | 'HOST_NAMESPACE' | 'UNEXPECTED_MOUNT';

export interface BoxSafetyExpectation { gateHostPort: number; volume: string; volumeDestination: string }

/**
 * 对已创建的 pa-box 容器做安全校验（L0 实测的隔离要求）：
 * - 只发布网关端口，且只发布到 127.0.0.1（Colima 会把客体 0.0.0.0 端口转发到宿主所有网卡）；
 * - 非特权、无额外 capability、自定义 seccomp（不是 unconfined）、no-new-privileges；
 * - 不共享宿主的 network / pid / ipc 命名空间；
 * - 只挂载命名卷 pa-box-home → /home（没有 bind mount、没有 docker.sock）。
 * 返回空数组表示通过。任何问题都会让桌面不可串流、并拒绝启动该容器。
 */
export function boxSafetyIssues(inspection: ContainerInspection, expected: BoxSafetyExpectation): BoxSafetyIssue[] {
  const issues = new Set<BoxSafetyIssue>();
  const gate = inspection.bindings.filter(binding => binding.containerPort === BOX_GATE_CONTAINER_PORT);
  if (!gate.length) issues.add('GATE_PORT_MISSING');
  for (const binding of inspection.bindings) {
    if (binding.containerPort !== BOX_GATE_CONTAINER_PORT || binding.hostPort !== expected.gateHostPort) issues.add('UNEXPECTED_PORT');
    if (!loopbackBinding(binding)) issues.add('PORT_NOT_LOOPBACK');
  }
  if (inspection.privileged) issues.add('PRIVILEGED');
  if (inspection.capAdd.length) issues.add('CAP_ADD');
  const seccompOpt = inspection.securityOpt.find(option => /^seccomp[=:]/.test(option));
  const seccompOk = seccompOpt ? !/^seccomp[=:]unconfined$/.test(seccompOpt)
    : !!inspection.seccompProfilePath && inspection.seccompProfilePath !== 'unconfined';
  if (!seccompOk) issues.add('NO_SECCOMP');
  if (!inspection.securityOpt.some(option => /^no-new-privileges(?:[=:]true)?$/.test(option))) issues.add('NO_NEW_PRIVILEGES_MISSING');
  if ([inspection.networkMode, inspection.pidMode, inspection.ipcMode].some(mode => mode === 'host')) issues.add('HOST_NAMESPACE');
  for (const mount of inspection.mounts) {
    if (mount.type !== 'volume' || mount.name !== expected.volume || mount.destination !== expected.volumeDestination) issues.add('UNEXPECTED_MOUNT');
  }
  return [...issues];
}

export interface CtlDesktop { id: string; running: boolean }
export interface CtlStatus { max: number; desktops: CtlDesktop[] }

/** `pa-box-ctl status` 的一行 JSON；版本或字段不符一律视为无法解析。 */
export function parseCtlStatus(stdout: string): CtlStatus | undefined {
  const line = stdout.trim().split(/\r?\n/).find(item => item.startsWith('{'));
  if (!line) return undefined;
  let row: any;
  try { row = JSON.parse(line); } catch { return undefined; }
  if (!row || row.v !== 1 || !Number.isSafeInteger(row.max) || row.max < 1 || row.max > BOX_MAX_DESKTOPS || !Array.isArray(row.desktops)) return undefined;
  const desktops: CtlDesktop[] = [];
  for (const item of row.desktops.slice(0, BOX_MAX_DESKTOPS)) {
    if (!item || typeof item.id !== 'string' || !/^d[1-9]$/.test(item.id) || Number(item.id.slice(1)) > row.max || typeof item.running !== 'boolean') return undefined;
    desktops.push({ id: item.id, running: item.running });
  }
  return { max: row.max, desktops };
}

/** macOS `sysctl -n kern.memorystatus_vm_pressure_level`：1 normal、2 warn、4 critical。 */
export function parseMacMemoryPressure(stdout: string): BoxMemoryPressure {
  const value = stdout.trim();
  return value === '1' ? 'normal' : value === '2' ? 'warn' : value === '4' ? 'critical' : 'unknown';
}

/**
 * Linux PSI（/proc/pressure/memory）：用 `some avg10`（过去 10 秒有任务因内存而停顿的时间占比）。
 * ≥ 10% 视为 warn，≥ 40% 视为 critical；这是经验阈值，对应 macOS 的 warn / critical 语义。
 */
export function parseLinuxMemoryPressure(text: string): BoxMemoryPressure {
  const match = /^some\s+avg10=(\d+(?:\.\d+)?)/m.exec(text);
  if (!match) return 'unknown';
  const value = Number(match[1]);
  return value >= 40 ? 'critical' : value >= 10 ? 'warn' : 'normal';
}

/**
 * `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fn` 的输出：以 n 开头的行是监听地址，例如
 * `n127.0.0.1:47830`、`n*:47830`、`n[::1]:47830`。返回所有监听地址（不含端口）。
 */
export function parseLsofListenAddresses(stdout: string, port: number): string[] {
  const addresses: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('n')) continue;
    const match = /^n(.+):(\d+)$/.exec(line);
    if (match && Number(match[2]) === port) addresses.push(match[1]);
  }
  return addresses;
}

/** 监听地址只允许 IPv4 / IPv6 loopback。 */
export function loopbackListenAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '[::1]' || address === 'localhost';
}

export interface WslDistribution { name: string; state: 'running' | 'stopped' | 'other'; version: number | undefined; isDefault: boolean }

/**
 * `wsl.exe -l -v` 的输出（已解码为文本）：
 *
 *     NAME      STATE           VERSION
 *   * Ubuntu    Running         2
 *     pa-box    Stopped         2
 *
 * 表头是本地化的（中文系统为“名称 状态 版本”），所以按列位置解析而不是按表头文字。
 */
export function parseWslList(stdout: string): WslDistribution[] {
  const lines = stdout.replace(/\u0000/g, '').split(/\r?\n/).map(line => line.replace(/\s+$/, '')).filter(Boolean);
  if (lines.length < 2) return [];
  return lines.slice(1).flatMap(line => {
    const match = /^\s*(\*)?\s*(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
    if (!match) return [];
    const state = match[3].toLowerCase();
    return [{ name: match[2], isDefault: match[1] === '*', version: Number(match[4]),
      state: state === 'running' ? 'running' : state === 'stopped' ? 'stopped' : 'other' } as WslDistribution];
  });
}

/** 用于 `docker version --format '{{.Server.Version}}'` 等单行版本输出。 */
export function parseSingleVersion(stdout: string): string | undefined {
  const value = stdout.trim().split(/\r?\n/)[0]?.trim();
  return value && /^v?\d+\.\d+[\w.+-]*$/.test(value) ? value.replace(/^v/, '') : undefined;
}
