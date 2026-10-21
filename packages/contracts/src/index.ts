export const TASK_STATUSES = [
  'queued',
  'running',
  'waiting_human',
  'paused',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const DELIVERY_STATUSES = ['pending', 'accepted', 'returned'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export type TaskEngine = 'fake' | 'claude';

/** Public instance configuration; credentials and permission modes do not belong here. */
export interface InstanceSettings {
  defaultEngine: TaskEngine;
  agentRunTimeoutMs: number;
  verificationTimeoutMs: number;
  updatedAt: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  role: AgentRole;
  model?: string;
  instructions: string;
  updatedAt: string;
}

/** A running task retains its selected configuration when the instance is edited. */
export interface TaskConfigurationSnapshot {
  settings: InstanceSettings;
  profiles: Record<AgentRole, AgentProfile>;
}

export interface TaskInstruction {
  id: string;
  commandId: string;
  requirements: string;
  createdAt: string;
}

/** Completed-stage evidence is retained when a fresh attempt resumes a task. */
export interface PipelineCheckpoint {
  nextStage: StageName | 'delivery';
  iteration: number;
  analyses?: { planner: string; reviewer: string };
  verificationIds?: string[];
  verifiedPatchSha256?: string;
  review?: ReviewResult;
  outcome?: { status: 'completed' | 'waiting_human'; reason?: string };
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

/** The Runtime invokes an executable and arguments directly, without a shell. */
export interface VerificationCommand {
  command: string;
  args: string[];
}

export interface Task {
  id: string;
  commandId: string;
  goal: string;
  status: TaskStatus;
  deliveryStatus: DeliveryStatus;
  pauseRequested: boolean;
  activeAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Omitted by persisted phase one tasks; treat it as fake. */
  engine?: TaskEngine;
  workspaceId?: string;
  baselineSha?: string;
  worktreePath?: string;
  branchName?: string;
  verificationCommands?: VerificationCommand[];
  instructions?: TaskInstruction[];
  checkpoint?: PipelineCheckpoint;
  configSnapshot?: TaskConfigurationSnapshot;
}

interface CreateTaskCommandBase {
  commandId: string;
  goal: string;
  profileIds?: Partial<Record<AgentRole, string>>;
}

export type CreateTaskCommand = CreateTaskCommandBase & (
  | {
      engine?: 'fake';
      workspaceId?: string;
      verificationCommands?: VerificationCommand[];
    }
  | {
      engine: 'claude';
      workspaceId: string;
      verificationCommands: VerificationCommand[];
    }
);

export type StageName = 'analysis' | 'development' | 'verification' | 'review' | 'summary';
export type StageStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface StageRecord {
  id: string;
  taskId: string;
  attemptId: string;
  name: StageName;
  iteration: number;
  status: StageStatus;
  startedAt: string;
  endedAt: string | null;
}

export type AgentRole = 'planner' | 'developer' | 'reviewer';
export type AgentRunStatus = StageStatus | 'waiting_human';

export interface AgentRunRecord {
  id: string;
  taskId: string;
  attemptId: string;
  stageId: string;
  role: AgentRole;
  mode: 'plan' | 'default';
  status: AgentRunStatus;
  startedAt: string;
  endedAt: string | null;
}

export interface VerificationResult {
  id: string;
  taskId: string;
  attemptId: string;
  stageId: string;
  command: VerificationCommand;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  startedAt: string;
  endedAt: string;
}

export interface ReviewResult {
  verdict: 'pass' | 'rework';
  blockers: string[];
  evidence: string[];
}

export interface ApprovalRecord {
  id: string;
  taskId: string;
  attemptId: string;
  runId: string;
  title: string;
  /** Preserve ACP evidence for human inspection without narrowing dynamic payloads. */
  toolCall?: {
    kind?: string;
    rawInput?: unknown;
    content?: unknown[];
    locations?: unknown[];
  };
  options: Array<{ optionId: string; name: string; kind: string }>;
  status: 'pending' | 'resolved' | 'expired';
  createdAt: string;
  resolvedAt: string | null;
  selectedOptionId: string | null;
}

export class ReviewResultError extends Error {
  readonly code = 'INVALID_REVIEW_RESULT';

  constructor(message: string) {
    super(message);
    this.name = 'ReviewResultError';
  }
}

/** The current review turn may contain progress prose before its one final payload. */
function reviewJsonPayload(text: string): string {
  let json = text.trim();
  // Do not search for a *valid* object: the first structural candidate must be
  // the only complete result, extending to the end of this review response.
  // Earlier objects, arrays, unsupported fences and truncated candidates can
  // never be skipped in favor of a later passing verdict.
  const start = json.search(/[{}\[\]]|```/u);
  if (start > 0) {
    const prefix = json.slice(0, start).trim();
    // A structural token inside an open string is not a payload boundary.
    // Reject truncated string wrappers rather than treating failed JSON as prose.
    let quoted = false, escaped = false;
    for (const character of prefix) {
      if (escaped) { escaped = false; continue; }
      if (quoted && character === '\\') { escaped = true; continue; }
      if (character === '"') quoted = !quoted;
    }
    if (prefix.startsWith('"') || quoted) {
      throw new ReviewResultError('Review contains an incomplete or wrapped result.');
    }
    let structuredPrefix = false;
    for (const line of prefix.split(/\r?\n/u)) {
      try { JSON.parse(line.trim()); structuredPrefix = true; break; } catch { /* plain progress prose */ }
    }
    if (structuredPrefix) throw new ReviewResultError('Review contains more than one structured result.');
    json = json.slice(start);
  }
  if (json.startsWith('```')) {
    const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/u.exec(json);
    if (!fenced) {
      throw new ReviewResultError('Review must end with one complete JSON object or a single JSON code fence.');
    }
    json = fenced[1];
  }
  return json;
}

/** JSON.parse overwrites duplicate keys; review fields must have one meaning. */
function assertUniqueReviewFields(json: string): void {
  const fields = new Set<string>();
  let depth = 0, stringStart = -1, escaped = false;
  // Called only after JSON.parse succeeds. Track strings and nesting so braces
  // and field-like text inside evidence cannot change the top-level boundary.
  for (let index = 0; index < json.length; index++) {
    const character = json[index];
    if (stringStart !== -1) {
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') {
        const start = stringStart;
        stringStart = -1;
        if (depth === 1) {
          let next = index + 1;
          while (next < json.length && /\s/u.test(json[next])) next++;
          if (json[next] === ':') {
            const key = JSON.parse(json.slice(start, index + 1)) as string;
            if (fields.has(key)) throw new ReviewResultError('Review contains duplicate fields.');
            fields.add(key);
          }
        }
      }
    } else if (character === '"') stringStart = index;
    else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') depth--;
  }
}

/** Prose is not a verdict; validate the one final payload without weakening its schema. */
export function parseReviewResult(text: string): ReviewResult {
  const json = reviewJsonPayload(text);

  let result: unknown;
  try {
    result = JSON.parse(json);
  } catch {
    throw new ReviewResultError('Review is not valid JSON.');
  }

  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new ReviewResultError('Review must be a JSON object.');
  }
  assertUniqueReviewFields(json);
  const record = result as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys.join(',') !== 'blockers,evidence,verdict') {
    throw new ReviewResultError('Review must include only verdict, blockers, and evidence.');
  }
  if (record.verdict !== 'pass' && record.verdict !== 'rework') {
    throw new ReviewResultError('Review verdict must be pass or rework.');
  }
  const isTextList = (value: unknown): value is string[] => Array.isArray(value)
    && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0);
  if (!isTextList(record.blockers) || !isTextList(record.evidence)) {
    throw new ReviewResultError('Review blockers and evidence must be arrays of nonempty strings.');
  }
  if (record.verdict === 'pass' && record.blockers.length !== 0) {
    throw new ReviewResultError('A passing review cannot contain blockers.');
  }
  if (record.verdict === 'rework' && record.blockers.length === 0) {
    throw new ReviewResultError('A rework review must identify a blocker.');
  }
  return { verdict: record.verdict, blockers: record.blockers, evidence: record.evidence };
}

export interface TaskEvent {
  /** Persisted, increasing sequence number within this task. */
  seq: number;
  taskId: string;
  attemptId: string | null;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export type ArtifactKind = 'markdown' | 'text' | 'diff' | 'json';

export interface Artifact {
  id: string;
  taskId: string;
  attemptId: string;
  kind: ArtifactKind;
  name: string;
  content: string;
  createdAt: string;
}

export interface TaskSnapshot {
  task: Task;
  events: TaskEvent[];
  artifacts: Artifact[];
  /** Highest persisted task sequence, including events omitted by a cursor. */
  cursor: number;
  stages?: StageRecord[];
  runs?: AgentRunRecord[];
  verifications?: VerificationResult[];
  approvals?: ApprovalRecord[];
}

export interface TaskList {
  tasks: Task[];
}

export type TaskControlCommand =
  | { commandId: string; action: 'feedback'; requirements: string }
  | { commandId: string; action: 'return'; requirements: string }
  | { commandId: string; action: 'takeover'; requirements?: string }
  | {
      commandId: string;
      action: 'pause' | 'resume' | 'retry' | 'cancel' | 'accept';
    };

export type TaskStateErrorCode =
  | 'COMMAND_CONFLICT'
  | 'INVALID_TASK_TRANSITION'
  | 'INVALID_DELIVERY_TRANSITION'
  | 'ACTIVE_ATTEMPT_EXISTS'
  | 'ATTEMPT_REQUIRED'
  | 'INVALID_ATTEMPT_ID'
  | 'STALE_ATTEMPT'
  | 'PAUSE_REQUESTED'
  | 'PAUSE_NOT_AVAILABLE';

export class TaskStateError extends Error {
  readonly statusCode = 409;

  constructor(
    readonly code: TaskStateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TaskStateError';
  }
}

const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['running', 'paused', 'cancelled'],
  running: ['waiting_human', 'paused', 'interrupted', 'completed', 'failed', 'cancelled'],
  waiting_human: ['running', 'paused', 'interrupted', 'failed', 'cancelled'],
  paused: ['queued', 'running', 'cancelled'],
  interrupted: ['queued', 'running', 'paused', 'cancelled'],
  completed: ['queued', 'running'],
  failed: ['queued', 'running', 'cancelled'],
  cancelled: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return status === 'running' || status === 'waiting_human';
}

/** Fence every engine callback or permission response before persisting effects. */
export function assertCurrentAttempt(task: Task, attemptId: string): void {
  if (!attemptId || task.activeAttemptId !== attemptId || !isActiveTaskStatus(task.status)) {
    throw new TaskStateError('STALE_ATTEMPT', 'The attempt is no longer active for this task.');
  }
}

export interface TaskTransitionOptions {
  now?: string;
  /** Set for a change originating from an engine attempt. */
  attemptId?: string;
}

/** Pure state change; persistence and its event must share a store transaction. */
export function transitionTask(
  task: Task,
  nextStatus: TaskStatus,
  options: TaskTransitionOptions = {},
): Task {
  if (options.attemptId !== undefined) {
    assertCurrentAttempt(task, options.attemptId);
  }
  if (!canTransitionTask(task.status, nextStatus)) {
    throw new TaskStateError(
      'INVALID_TASK_TRANSITION',
      `Cannot transition task from ${task.status} to ${nextStatus}.`,
    );
  }
  if (task.status === 'completed' && task.deliveryStatus !== 'returned') {
    throw new TaskStateError(
      'INVALID_TASK_TRANSITION',
      'A completed task must be returned before starting another attempt.',
    );
  }
  if (isActiveTaskStatus(nextStatus) && task.activeAttemptId === null) {
    throw new TaskStateError('ATTEMPT_REQUIRED', 'Start an attempt before entering an active state.');
  }

  return {
    ...task,
    status: nextStatus,
    deliveryStatus: nextStatus === 'queued' || nextStatus === 'running' ? 'pending' : task.deliveryStatus,
    activeAttemptId: isActiveTaskStatus(nextStatus) ? task.activeAttemptId : null,
    pauseRequested: isActiveTaskStatus(nextStatus) ? task.pauseRequested : false,
    updatedAt: options.now ?? new Date().toISOString(),
  };
}

/** Scheduling decides when a queued or resumable task may consume a worker slot. */
export function beginTaskAttempt(task: Task, attemptId: string, now?: string): Task {
  if (!attemptId.trim()) {
    throw new TaskStateError('INVALID_ATTEMPT_ID', 'An attempt ID must be nonempty.');
  }
  if (task.activeAttemptId !== null) {
    throw new TaskStateError('ACTIVE_ATTEMPT_EXISTS', 'This task already has an active attempt.');
  }
  if (!canTransitionTask(task.status, 'running')) {
    throw new TaskStateError(
      'INVALID_TASK_TRANSITION',
      `Cannot start an attempt for a ${task.status} task.`,
    );
  }

  return transitionTask({ ...task, activeAttemptId: attemptId, pauseRequested: false }, 'running', { now });
}

/** Resume/retry/return can use this before FIFO dispatch to a new attempt. */
export function requeueTask(task: Task, now?: string): Task {
  return transitionTask(task, 'queued', { now });
}

/** Running stages finish before the caller applies the requested pause. */
export function requestTaskPause(task: Task, now?: string): Task {
  if (task.status === 'queued') {
    return transitionTask(task, 'paused', { now });
  }
  if (!isActiveTaskStatus(task.status)) {
    throw new TaskStateError('PAUSE_NOT_AVAILABLE', `Cannot request pause for a ${task.status} task.`);
  }
  return { ...task, pauseRequested: true, updatedAt: now ?? new Date().toISOString() };
}

/** Receipt of a delivery never changes its completed execution status. */
export function updateTaskDelivery(task: Task, nextStatus: DeliveryStatus, now?: string): Task {
  if (
    task.status !== 'completed' ||
    task.deliveryStatus !== 'pending' ||
    nextStatus === 'pending'
  ) {
    throw new TaskStateError(
      'INVALID_DELIVERY_TRANSITION',
      `Cannot change delivery from ${task.deliveryStatus} to ${nextStatus} for a ${task.status} task.`,
    );
  }
  return { ...task, deliveryStatus: nextStatus, updatedAt: now ?? new Date().toISOString() };
}

/** Persistent public policy; credentials never belong in this configuration. */
export interface AuthSecurityConfig {
  mode: 'paired';
  publicOrigin: string;
  allowInsecureLocalhost?: boolean;
}

/** 设备权限：operator 可写可控制桌面；observer 只读、桌面只能看。 */
export type DeviceRole = 'operator' | 'observer';
/** Ed25519 客户端设备的生命周期。Cookie 配对设备只有 approved / revoked。 */
export type DeviceStatus = 'pending' | 'approved' | 'rejected' | 'revoked';
/** 设备被批准的原因：托管桌面、本机回环浏览器，或操作员手动批准。 */
export type DeviceTrust = 'desktop' | 'loopback' | 'manual';
export type DeviceKind = 'desktop' | 'browser';

/** Public device metadata; session and CSRF hashes remain server-side. */
export interface Device {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  role?: DeviceRole;
  status?: DeviceStatus;
}

/**
 * Ed25519 客户端设备（桌面客户端 / 第二个客户端 / 经 Tunnel 的浏览器）。
 * 公钥只用于校验签名，列表接口会返回以便操作员核对指纹。
 */
export interface ClientDevice {
  id: string;
  name: string;
  publicKey: string;
  role: DeviceRole;
  status: DeviceStatus;
  trust: DeviceTrust;
  kind: DeviceKind;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
  lastSeenAt: string | null;
}

export interface DeviceChallenge {
  challenge: string;
  expiresAt: string;
}

export interface DeviceConnectRequest {
  publicKey: string;
  name: string;
  kind: DeviceKind;
  challenge: string;
  signedAt: number;
  signature: string;
}

export interface DeviceConnectResult {
  device: ClientDevice;
  deviceSession: string;
  role: DeviceRole;
}

export interface DesktopStreamTicket {
  ticket: string;
  expiresAt: string;
  control: boolean;
  deploymentId: string;
  desktopId: string;
}

export interface AuthSession {
  mode: 'loopback' | 'paired';
  device?: Device;
  csrfToken?: string;
  /** Present only on a server-enforced fake-only demo instance. */
  demo?: 'fake';
  /**
   * Present only when the server runs as the Electron client's managed child
   * (per-launch token mode). The token itself is never exposed to the renderer.
   */
  desktop?: true;
  /** 当前连接的权限；隐式回环操作员为 operator。 */
  role?: DeviceRole;
  /** 已识别的 Ed25519 客户端设备（已批准后出现）。 */
  clientDevice?: ClientDevice;
}

// ---------------------------------------------------------------------------
// Linux 云电脑 / 远程电脑（Box）
// ---------------------------------------------------------------------------

/** local = 本机宿主适配层（Colima / WSL2 / Podman）；cloud = 远端 Linux 服务器。 */
export type BoxDeploymentKind = 'local' | 'cloud';
/** 宿主适配器标识。fake 只在 demo 实例出现。 */
export type BoxAdapterId = 'colima' | 'wsl2' | 'podman' | 'docker' | 'cloud-agent' | 'cloud-ssh' | 'fake';
/** 云端主机的连接方式：agent = 主机守护进程主动外连；ssh = server 经用户 ssh 配置访问。 */
export type BoxCloudConnection = 'agent' | 'ssh';
export type BoxHostState =
  | 'not_installed' | 'not_configured' | 'stopped' | 'starting' | 'running'
  | 'pending_registration' | 'offline' | 'not_implemented' | 'error' | 'unknown';
export type BoxContainerState = 'running' | 'stopped' | 'missing' | 'unknown' | 'not_implemented';
export type BoxAction = 'start_vm' | 'stop_vm' | 'start_container' | 'stop_container';

export interface BoxResources {
  cpus?: number;
  memoryBytes?: number;
  diskBytes?: number;
}

/** 宿主 / VM 层状态。detail 与 installHint 只含固定说明文本，不含命令输出。 */
export interface BoxHostStatus {
  state: BoxHostState;
  detail?: string;
  installHint?: string;
  version?: string;
  runtime?: string;
  arch?: string;
  profile?: string;
  resources?: BoxResources;
}

export interface BoxContainerStatus {
  state: BoxContainerState;
  name: string;
  image?: string;
  statusText?: string;
  cpuPercent?: number;
  memoryUsedBytes?: number;
  memoryLimitBytes?: number;
  detail?: string;
}

export interface BoxDesktop {
  id: string;
  label: string;
  display?: string;
  state: 'running' | 'stopped';
  /**
   * 桌面可以经 server 的鉴权代理打开：容器在运行、box 网关端口只绑定 127.0.0.1
   * 且通过了安全校验。桌面本身从不监听 TCP，只能经网关 + 每桌面令牌访问。
   */
  streamable: boolean;
  /** 当前经 server 代理连着的查看者数量（只统计本 server 的连接）。 */
  viewers?: number;
  /** 无人查看时预计自动停止的时间（空闲停机）。 */
  idleStopAt?: string;
}

/**
 * 宿主内存压力（macOS 取 kern.memorystatus_vm_pressure_level，Linux 取 /proc/pressure/memory）。
 * warn 及以上时拒绝启动新桌面。unknown 表示该宿主无法测量，只按容器内存预算判断。
 */
export type BoxMemoryPressure = 'normal' | 'warn' | 'critical' | 'unknown';

/** 桌面并发策略（来自 M1 16GB 的 L0 实测：每桌面按 0.7GB 规划，默认 2 个并发、硬上限 3 个）。 */
export interface BoxDesktopPolicy {
  /** 同时运行的桌面数上限（默认 2，可配置为 1..max）。 */
  concurrent: number;
  /** 镜像里预置的桌面用户数，也是硬上限（3）。 */
  max: number;
  /** 规划用的每桌面内存预算。 */
  budgetBytesPerDesktop: number;
  /** 无人查看多少分钟后自动停止桌面。 */
  idleStopMinutes: number;
}

export type BoxDesktopAction = 'start' | 'stop';

export interface BoxOperation {
  action: BoxAction;
  startedAt: string;
  finishedAt?: string;
  ok?: boolean;
  /** 固定错误码，不含命令输出。 */
  errorCode?: string;
}

export interface BoxDeployment {
  id: string;
  kind: BoxDeploymentKind;
  adapter: BoxAdapterId;
  name: string;
  /** 云端：用户填写的服务商标签，例如 "Hetzner CAX21"；只用于展示。 */
  providerLabel?: string;
  /** 云端 ssh：ssh 配置中的 Host 别名；agent：可选的展示用地址。 */
  endpoint?: string;
  /** 凭据引用（例如 ssh-config:pa-box），从不保存凭据本身。 */
  authRef?: string;
  connection?: BoxCloudConnection;
  createdAt?: string;
  registered?: boolean;
  lastHeartbeatAt?: string | null;
  host: BoxHostStatus;
  container: BoxContainerStatus;
  desktops: BoxDesktop[];
  desktopPolicy: BoxDesktopPolicy;
  memoryPressure: BoxMemoryPressure;
  actions: BoxAction[];
  operation?: BoxOperation;
  checkedAt: string;
  /** demo 实例返回的 fake 部署。 */
  fake?: true;
}

export interface BoxDeploymentList {
  platform: string;
  deployments: BoxDeployment[];
}

export interface CreateCloudBoxCommand {
  commandId: string;
  name: string;
  providerLabel?: string;
  connection: BoxCloudConnection;
  endpoint?: string;
  authRef?: string;
}

/** 一次性注册票据；明文只在签发时返回一次。 */
export interface BoxRegistrationTicket {
  deploymentId: string;
  ticket: string;
  expiresAt: string;
}

/** The plaintext ticket is returned only by its initial issuance. */
export interface PairingTicket {
  id: string;
  ticket: string | null;
  expiresAt: string;
}
