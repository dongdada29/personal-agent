/**
 * 第三层：按路由强制区分只读 / 操作权限。
 *
 * observer（只读）可以看状态、任务、桌面画面，可以申请只能观看的桌面票。
 * operator（操作）才能改配置、启停容器、控制桌面键鼠、批准设备。
 * 隐式回环（未出示设备身份的本机请求）视为 operator，以便 npm run dev 与既有测试继续工作。
 */
export type Permission = 'read' | 'write' | 'pair';

const PAIR_PATHS = new Set([
  '/api/devices',
  '/api/pair-tickets',
]);

export function classifyPath(method: string, path: string): Permission {
  const normalized = path.split('?', 1)[0];
  if (normalized === '/api/devices' && method === 'GET') return 'read';
  if (normalized.startsWith('/api/devices/') || normalized.startsWith('/api/client-devices/') || PAIR_PATHS.has(normalized)) return 'pair';
  if (normalized === '/api/device/connect' || normalized === '/api/device/challenge' || normalized === '/api/device/status') return 'read';
  if (normalized === '/api/pair') return 'read';
  if (/^\/api\/box\/deployments\/[^/]+\/desktops\/d[1-3]\/tickets$/.test(normalized) && method === 'POST') return 'read';
  if (['GET', 'HEAD'].includes(method)) return 'read';
  return 'write';
}

export function allowsPermission(role: 'operator' | 'observer' | undefined, needed: Permission): boolean {
  if (needed === 'read') return true;
  return role !== 'observer';
}
