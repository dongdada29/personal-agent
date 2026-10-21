import type { BoxAction, BoxContainerState, BoxDeployment, BoxDesktop, BoxHostState, BoxMemoryPressure } from '@personal-agent/contracts';

/** Linux 云电脑页面的纯展示逻辑（不依赖 React，便于测试）。 */

export const hostStateLabels: Record<BoxHostState, { text: string; color: string }> = {
  running: { text: '运行中', color: 'green' },
  starting: { text: '启动中', color: 'blue' },
  stopped: { text: '已停止', color: 'default' },
  not_installed: { text: '未安装', color: 'orange' },
  not_configured: { text: '未配置', color: 'orange' },
  pending_registration: { text: '等待注册', color: 'gold' },
  offline: { text: '离线', color: 'red' },
  not_implemented: { text: '暂不支持', color: 'default' },
  error: { text: '异常', color: 'red' },
  unknown: { text: '未知', color: 'default' },
};

export const containerStateLabels: Record<BoxContainerState, { text: string; color: string }> = {
  running: { text: '运行中', color: 'green' },
  stopped: { text: '已停止', color: 'default' },
  missing: { text: '未创建', color: 'orange' },
  unknown: { text: '未知', color: 'default' },
  not_implemented: { text: '暂不支持', color: 'default' },
};

export const pressureLabels: Record<BoxMemoryPressure, { text: string; color: string }> = {
  normal: { text: '内存正常', color: 'green' },
  warn: { text: '内存紧张', color: 'orange' },
  critical: { text: '内存严重不足', color: 'red' },
  unknown: { text: '内存压力未知', color: 'default' },
};

export const actionLabels: Record<BoxAction, string> = {
  start_vm: '启动 VM', stop_vm: '停止 VM', start_container: '启动容器', stop_container: '停止容器',
};

export const adapterLabels: Record<BoxDeployment['adapter'], string> = {
  colima: 'Colima（macOS · vz）', wsl2: 'WSL2', podman: 'Podman（rootless）', docker: 'Docker', 'cloud-agent': '主机守护进程', 'cloud-ssh': 'SSH', fake: '演示',
};

/** 服务端错误码 → 可操作的中文提示。 */
export const boxErrorMessages: Record<string, string> = {
  BOX_DESKTOP_LIMIT: '已达到同时运行的桌面数上限，请先停止一个桌面。',
  BOX_MEMORY_PRESSURE: '宿主内存紧张，暂不启动新桌面。请关闭其它程序或停止已有桌面后再试。',
  BOX_MEMORY_BUDGET: '容器内存预算不足以再启动一个桌面（每个桌面按 0.7GB 规划）。',
  BOX_DESKTOP_UNAVAILABLE: '容器尚未就绪或未通过安全校验，暂时无法打开桌面。',
  BOX_DESKTOP_NOT_RUNNING: '桌面未在运行，请先启动桌面。',
  BOX_DESKTOP_UNREACHABLE: '无法连接 box 网关，请确认容器正在运行。',
  BOX_CONTAINER_UNSAFE: '容器配置未通过安全校验（端口必须只绑定 127.0.0.1、需要 seccomp 与 no-new-privileges），已拒绝使用。',
  BOX_PORT_EXPOSED: '检测到 box 网关端口暴露在非回环地址上，已停止容器。',
  BOX_RUNTIME_NOT_INSTALLED: '本机未安装所需的容器运行时，请按页面提示安装。',
  BOX_IMAGE_MISSING: '本机还没有 box 镜像，请先按文档构建 personal-agent/pa-box 镜像。',
  BOX_COLIMA_TOO_OLD: 'Colima 版本过旧（不支持 --activate=false），请升级 Colima。',
  BOX_SECCOMP_MISSING: '找不到 box 的 seccomp 配置文件。',
  BOX_AGENT_OFFLINE: '云端主机守护进程离线。',
  BOX_AGENT_TIMEOUT: '等待云端主机响应超时。',
  BOX_OPERATION_RUNNING: '该部署已有操作在执行，请稍候。',
  BOX_ACTION_UNAVAILABLE: '当前状态下不能执行该操作。',
  DEMO_FAKE_ONLY: '公开演示只展示示例数据，不能操作真实的云电脑。',
};

export function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value, unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  const shown = size >= 10 || unit === 0 ? String(Math.round(size)) : size.toFixed(1).replace(/\.0$/u, '');
  return `${shown} ${units[unit]}`;
}

export function formatRelative(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '从未';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '—';
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 0) return `${Math.ceil(-seconds / 60)} 分钟后`;
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}

/** 内存使用：已用 / 上限（百分比）。 */
export function memoryUsage(used?: number, limit?: number): string {
  if (used === undefined) return '—';
  if (!limit) return formatBytes(used);
  return `${formatBytes(used)} / ${formatBytes(limit)}（${Math.round((used / limit) * 100)}%）`;
}

export type DesktopStartCheck = { ok: true } | { ok: false; reason: string };

/**
 * 前端预判“启动桌面”按钮是否可用（服务端仍会做权威准入）：
 * 容器就绪、未达并发上限、内存压力不在 warn/critical。
 */
export function canStartDesktop(deployment: BoxDeployment, desktop: BoxDesktop): DesktopStartCheck {
  if (deployment.fake) return { ok: false, reason: '演示数据' };
  if (desktop.state === 'running') return { ok: false, reason: '已在运行' };
  if (deployment.container.state !== 'running') return { ok: false, reason: '容器未运行' };
  if (!desktop.streamable) return { ok: false, reason: '容器未就绪或未通过安全校验' };
  const running = deployment.desktops.filter(item => item.state === 'running').length;
  if (running >= deployment.desktopPolicy.concurrent) return { ok: false, reason: `已达并发上限（${deployment.desktopPolicy.concurrent} 个）` };
  if (deployment.memoryPressure === 'warn' || deployment.memoryPressure === 'critical') return { ok: false, reason: pressureLabels[deployment.memoryPressure].text };
  return { ok: true };
}

/** 本机部署在前，云端按名称排序。 */
export function orderDeployments(deployments: BoxDeployment[]): { local: BoxDeployment[]; cloud: BoxDeployment[] } {
  return {
    local: deployments.filter(item => item.kind === 'local'),
    cloud: deployments.filter(item => item.kind === 'cloud').sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
  };
}

const TICKET = /^[A-Za-z0-9_-]{43}$/u;
const HTTPS_ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/u;

/** 安装脚本只接受 https 源；本机 http / app:// 不能让云端主机回连。 */
export function publicInstallOrigin(location: { protocol: string; origin: string }): string | undefined {
  return location.protocol === 'https:' && HTTPS_ORIGIN.test(location.origin.replace(/\/$/u, ''))
    ? location.origin.replace(/\/$/u, '') : undefined;
}

/** 云端主机安装命令（票据写入文件后由脚本读取，不出现在命令行参数里）。 */
export function installCommand(serverOrigin: string, ticket: string): string {
  if (!HTTPS_ORIGIN.test(serverOrigin) || !TICKET.test(ticket)) throw new Error('invalid install command');
  return [
    `printf '%s' '${ticket}' | sudo tee /root/pa-box.ticket >/dev/null`,
    `sudo bash --noprofile --norc scripts/box/install-cloud-host.sh --server ${serverOrigin} --ticket-file /root/pa-box.ticket`,
  ].join('\n');
}
