import type {
  ApprovalRecord,
  AgentProfile,
  AgentRole,
  AuthSession,
  ClientDevice,
  CreateTaskCommand,
  Device,
  DesktopStreamTicket,
  DeviceRole,
  InstanceSettings,
  PairingTicket,
  BoxAction,
  BoxDeployment,
  BoxDeploymentList,
  BoxOperation,
  BoxRegistrationTicket,
  CreateCloudBoxCommand,
  Task,
  TaskControlCommand,
  TaskList,
  TaskSnapshot,
  Workspace,
} from '@personal-agent/contracts';
import { DELIVERY_STATUSES, TASK_STATUSES } from '@personal-agent/contracts';
import { authSession, notifyAuthRequired } from './auth-session';
import { boxErrorMessages } from './box-display';
import { deviceAuthHeaders } from './device-identity';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = 'ApiError'; }
}

const requestTimeoutMs = 30_000;

/** A connection outage does not prove that a previously confirmed session expired. */
export function isTemporaryConnectionFailure(error: unknown): boolean {
  return error instanceof ApiError && error.code !== 'INVALID_RESPONSE'
    && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500);
}

const errorMessages: Record<string, string> = {
  ...boxErrorMessages,
  LOCAL_ONLY: '当前实例仅接受本机访问，请使用启动终端显示的 http://127.0.0.1 工作台地址。',
  HOST_REJECTED: '当前地址与实例配置不符，请使用配置的工作台地址。',
  ORIGIN_REJECTED: '当前页面来源与实例配置不符，请从工作台原地址重新打开。',
  CSRF_REJECTED: '会话校验未通过，请刷新当前设备访问后重试。',
  DEMO_FAKE_ONLY: '此公开演示只运行 fake 引擎，不注册仓库、不执行验证命令。真实开发任务请在自己的持久实例中创建。',
  DEMO_TASK_LIMIT: '演示实例的任务数已达上限，请稍后再来（演示重启后数据会重置）。',
  DEMO_PROFILE_LIMIT: '演示实例的 Agent 配置数已达上限。',
  DEMO_RATE_LIMIT: '公开演示当前请求较多，请约一分钟后重试。',
  PAIRING_REQUIRED: '这台设备还在等待批准，请在已信任的客户端里批准后重试。',
  PAIRING_REJECTED: '这台设备的访问申请已被拒绝。',
  PERMISSION_DENIED: '当前设备是只读权限，不能执行该操作。',
  DESKTOP_TICKET_REQUIRED: '打开桌面需要一张有效的一次性桌面票，请重新打开。',
  RUNNER_BLOCKED: '执行器暂停调度，需要在服务主机检查进程清理或持久化记录。任务记录已保留。',
  SERVER_CLOSING: '服务正在停止，请等待重新启动后重试。',
  REAL_TASK_INPUT: 'Claude 任务需要选择 Git 工作区，并填写验证程序和参数。',
  WORKSPACE_REQUIRED: '请先登记并选择 Git 工作区。',
  WORKSPACE_INVALID: '无法使用该工作区。请确认填写仓库根目录的绝对路径、已有 Git 提交，并且服务用户能够读取。',
  DESKTOP_TOKEN_REQUIRED: '当前实例只接受来自其桌面客户端的请求。',
  INVALID_TASK_TRANSITION: '任务状态已变化，当前操作无法执行。请刷新任务后再选择操作。',
  STALE_ATTEMPT: '该执行或审批已结束，请刷新任务查看当前待处理项。',
  TASK_NOT_FOUND: '任务记录不存在，请刷新任务列表。',
};

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  if (!url.startsWith('/api/')) throw new ApiError('请求地址必须属于当前工作台。', 400, 'INVALID_API_URL');
  const generation = authSession.generation;
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(deviceAuthHeaders())) headers.set(name, value);
  if (url === '/api/pair') headers.delete('X-CSRF-Token');
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes((init?.method ?? 'GET').toUpperCase());
  if (unsafe && url !== '/api/pair') {
    const session = authSession.session;
    if (!session || (session.mode === 'paired' && !session.csrfToken)) {
      notifyAuthRequired();
      throw new ApiError('当前访问已失效，请重新配对。', 401, 'AUTH_REQUIRED');
    }
    if (session.mode === 'paired') headers.set('X-CSRF-Token', session.csrfToken!);
    else headers.delete('X-CSRF-Token');
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (init?.signal?.aborted) cancel();
  else init?.signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal, headers, credentials: 'same-origin', redirect: 'error' });
    } catch (cause) {
      if (generation !== authSession.generation) throw new ApiError('该请求属于已结束的会话。', 409, 'SESSION_CHANGED');
      if (init?.signal?.aborted) throw cause;
      if (timedOut) throw new ApiError('等待服务响应超时。请求结果尚未确认，请恢复连接后重试。', 408, 'REQUEST_TIMEOUT');
      throw new ApiError('暂时无法连接服务。请确认服务已启动和网络可用，再重试；已提交的任务会继续执行。', 0, 'NETWORK_UNAVAILABLE');
    }
    if (generation !== authSession.generation) {
      throw new ApiError('该请求属于已结束的会话。', 409, 'SESSION_CHANGED');
    }
    if (init?.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    if (response.status === 401) {
      notifyAuthRequired();
      throw new ApiError('当前访问已失效，请重新配对。', 401, 'AUTH_REQUIRED');
    }
    const body: unknown = await response.json().catch(() => null);

    if (generation !== authSession.generation) {
      throw new ApiError('该请求属于已结束的会话。', 409, 'SESSION_CHANGED');
    }
    if (init?.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    if (timedOut) throw new ApiError('等待服务响应超时。请求结果尚未确认，请恢复连接后重试。', 408, 'REQUEST_TIMEOUT');

    if (!response.ok) {
      const message =
        body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
          ? body.message
          : `请求失败（${response.status}）`;
      const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : undefined;
      throw new ApiError((code && errorMessages[code]) ?? message, response.status, code);
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError('服务返回了无法确认的响应。请确认访问正确的工作台地址，再重试原请求。', 502, 'INVALID_RESPONSE');
    }
    return body as T;
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener('abort', cancel);
  }
}

export const api = {
  getSession: (signal?: AbortSignal) => request<AuthSession>('/api/session', { signal }),
  pairDevice: (ticket: string, name: string) => request<AuthSession>('/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket, name }),
  }),
  listDevices: (signal?: AbortSignal) => request<{ devices: Device[]; clientDevices?: ClientDevice[] }>('/api/devices', { signal }),
  approveClientDevice: (id: string, command: { commandId: string; role: DeviceRole }) =>
    request<ClientDevice>(`/api/client-devices/${encodeURIComponent(id)}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    }),
  rejectClientDevice: (id: string, command: { commandId: string }) =>
    request<ClientDevice>(`/api/client-devices/${encodeURIComponent(id)}/reject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    }),
  revokeClientDevice: (id: string, command: { commandId: string }) =>
    request<ClientDevice>(`/api/client-devices/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    }),
  mintDesktopTicket: (deploymentId: string, desktopId: string) =>
    request<DesktopStreamTicket>(`/api/box/deployments/${encodeURIComponent(deploymentId)}/desktops/${encodeURIComponent(desktopId)}/tickets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }),
  createPairTicket: (command: { commandId: string }) => request<PairingTicket>('/api/pair-tickets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
  }),
  revokeDevice: (id: string, command: { commandId: string }) => request<Device>(`/api/devices/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
  }),
  listTasks: (signal?: AbortSignal) => request<TaskList>('/api/tasks', { signal }),
  getTask: (id: string, signal?: AbortSignal) => request<TaskSnapshot>(`/api/tasks/${encodeURIComponent(id)}`, { signal }),
  createTask: async (command: CreateTaskCommand) => {
    const task = await request<Task>('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    // Confirm the creation before the workbench clears its draft and retry ID.
    // Check only identity and fields immediately used to render the new task.
    if (typeof task.id !== 'string' || !task.id.trim()
      || task.commandId !== command.commandId
      || typeof task.goal !== 'string' || !task.goal.trim() || task.goal !== command.goal
      || !TASK_STATUSES.includes(task.status) || !DELIVERY_STATUSES.includes(task.deliveryStatus)
      || [task.createdAt, task.updatedAt].some((time) => typeof time !== 'string' || !Number.isFinite(Date.parse(time)))) {
      throw new ApiError('任务创建回执尚未确认。目标已保留，请恢复连接后重试原请求。', 502, 'INVALID_RESPONSE');
    }
    return task;
  },
  listWorkspaces: (signal?: AbortSignal) => request<{ workspaces: Workspace[] }>('/api/workspaces', { signal }),
  registerWorkspace: (name: string, path: string, commandId: string) =>
    request<Workspace>('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path, commandId }),
    }),
  controlTask: (id: string, command: TaskControlCommand) =>
    request<Task>(`/api/tasks/${encodeURIComponent(id)}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    }),
  listApprovals: (signal?: AbortSignal) => request<{ approvals: ApprovalRecord[] }>('/api/approvals', { signal }),
  resolveApproval: (id: string, optionId: string, commandId: string) =>
    request<unknown>(`/api/approvals/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionId, commandId }),
    }),
  getSettings: (signal?: AbortSignal) => request<InstanceSettings>('/api/settings', { signal }),
  updateSettings: (command: { commandId: string } & Partial<Pick<InstanceSettings, 'defaultEngine' | 'agentRunTimeoutMs' | 'verificationTimeoutMs'>>) =>
    request<InstanceSettings>('/api/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    }),
  listAgents: (signal?: AbortSignal) => request<{ agents: AgentProfile[] }>('/api/agents', { signal }),
  createAgent: (command: { commandId: string; name: string; role: AgentRole; model?: string; instructions: string }) =>
    request<AgentProfile>('/api/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    }),
  updateAgent: (id: string, command: { commandId: string; name?: string; model?: string; instructions?: string }) =>
    request<AgentProfile>(`/api/agents/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    }),
  listBoxDeployments: (signal?: AbortSignal) => request<BoxDeploymentList>('/api/box/deployments', { signal }),
  createCloudBox: (command: CreateCloudBoxCommand) =>
    request<BoxDeployment>('/api/box/deployments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    }),
  removeCloudBox: (id: string, command: { commandId: string }) =>
    request<{ id: string; removed: true }>(`/api/box/deployments/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    }),
  boxAction: (id: string, command: { commandId: string; action: BoxAction }) =>
    request<{ id: string; operation: BoxOperation }>(`/api/box/deployments/${encodeURIComponent(id)}/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    }),
  issueBoxTicket: (id: string, command: { commandId: string }) =>
    request<BoxRegistrationTicket>(`/api/box/deployments/${encodeURIComponent(id)}/tickets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    }),
  startBoxDesktop: (id: string, desktopId: string, command: { commandId: string }) =>
    request<BoxDeployment>(`/api/box/deployments/${encodeURIComponent(id)}/desktops/${encodeURIComponent(desktopId)}/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    }),
  stopBoxDesktop: (id: string, desktopId: string, command: { commandId: string }) =>
    request<BoxDeployment>(`/api/box/deployments/${encodeURIComponent(id)}/desktops/${encodeURIComponent(desktopId)}/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    }),
};
