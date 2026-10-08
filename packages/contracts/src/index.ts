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

/** Model prose is not a verdict. Accept only the agreed, complete JSON structure. */
export function parseReviewResult(text: string): ReviewResult {
  let json = text.trim();
  if (json.startsWith('```')) {
    const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/u.exec(json);
    if (!fenced) {
      throw new ReviewResultError('Review must contain only JSON or a single JSON code fence.');
    }
    json = fenced[1];
  }

  let result: unknown;
  try {
    result = JSON.parse(json);
  } catch {
    throw new ReviewResultError('Review is not valid JSON.');
  }

  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new ReviewResultError('Review must be a JSON object.');
  }
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

/** Public device metadata; session and CSRF hashes remain server-side. */
export interface Device {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface AuthSession {
  mode: 'loopback' | 'paired';
  device?: Device;
  csrfToken?: string;
}

/** The plaintext ticket is returned only by its initial issuance. */
export interface PairingTicket {
  id: string;
  ticket: string | null;
  expiresAt: string;
}
