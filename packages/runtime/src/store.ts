import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  assertCurrentAttempt, beginTaskAttempt, transitionTask, requestTaskPause, updateTaskDelivery, TaskStateError,
  type Artifact, type CreateTaskCommand, type Task, type TaskEvent,
  type TaskSnapshot, type TaskStatus, type Workspace, type StageRecord, type AgentRunRecord,
  type VerificationResult, type ApprovalRecord, type TaskControlCommand, type PipelineCheckpoint,
  type InstanceSettings, type AgentProfile, type AgentRole, type TaskConfigurationSnapshot,
} from '@personal-agent/contracts';
import { migrations } from './migrations.js';
import type { OwnedProcessRecord } from './process-registry.js';

// Vite 5's builtin list predates node:sqlite. Resolve this prefix-only builtin
// through Node itself; the application remains ESM and uses the native module.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

/** Compare command payloads structurally, including pre-migration fingerprints. */
function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, normalize(value)])) : item;
  return JSON.stringify(normalize(value));
}
function sameRequest(left: unknown, right: string): boolean {
  return left === right || (typeof left === 'string' && canonical(JSON.parse(left)) === canonical(JSON.parse(right)));
}

function taskFrom(row: Row): Task {
  return {
    ...JSON.parse(String(row.execution_json ?? '{}')),
    id: String(row.id), commandId: String(row.command_id), goal: String(row.goal),
    status: row.status as Task['status'], deliveryStatus: row.delivery_status as Task['deliveryStatus'],
    pauseRequested: row.pause_requested === 1,
    activeAttemptId: row.active_attempt_id as string | null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
function eventFrom(row: Row): TaskEvent {
  return { seq: Number(row.seq), taskId: String(row.task_id), attemptId: row.attempt_id as string | null,
    type: String(row.type), data: JSON.parse(String(row.data_json)), createdAt: String(row.created_at) };
}
function artifactFrom(row: Row): Artifact {
  return { id: String(row.id), taskId: String(row.task_id), attemptId: String(row.attempt_id),
    kind: row.kind as Artifact['kind'], name: String(row.name), content: String(row.content), createdAt: String(row.created_at) };
}

export class TaskStore {
  private readonly db: import('node:sqlite').DatabaseSync;
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private transactionEvents: TaskEvent[] | undefined;
  private readonly committedEvents: TaskEvent[] = [];
  private publishing = false;

  constructor(public readonly filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
      this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      const version = Number((this.db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get() as Row).version);
      if (version > migrations.at(-1)!.version) {
        throw new Error('Database schema is newer than this application');
      }
      for (const migration of migrations) {
        if (migration.version > version) this.transaction(() => {
          this.db.exec(migration.sql);
          this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(migration.version, now());
        });
      }
      this.seedConfiguration();
    } catch (error) { this.db.close(); throw error; }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    const pending: TaskEvent[] = [];
    this.transactionEvents = pending;
    let result: T;
    try { result = fn(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionEvents = undefined; }
    this.committedEvents.push(...pending);
    // A subscriber can write another transaction. Queue that batch behind all
    // events already committed, and never turn an observer error into rollback.
    if (!this.publishing) {
      this.publishing = true;
      try {
        while (this.committedEvents.length) {
          const event = this.committedEvents.shift()!;
          for (const listener of [...this.listeners]) {
            try { listener(structuredClone(event)); } catch { /* DB is authoritative */ }
          }
        }
      } finally { this.publishing = false; }
    }
    return result;
  }

  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private writeExecution(id: string, patch: Partial<Task>): void {
    const row = this.db.prepare('SELECT execution_json FROM tasks WHERE id=?').get(id) as Row;
    this.db.prepare('UPDATE tasks SET execution_json=?,updated_at=? WHERE id=?')
      .run(JSON.stringify({ ...JSON.parse(String(row.execution_json)), ...patch }), now(), id);
  }

  private writeTask(task: Task): void {
    this.db.prepare(`UPDATE tasks SET status=?,delivery_status=?,pause_requested=?,active_attempt_id=?,updated_at=? WHERE id=?`)
      .run(task.status, task.deliveryStatus, Number(task.pauseRequested), task.activeAttemptId, task.updatedAt, task.id);
  }

  private insertEvent(taskId: string, attemptId: string | null, type: string, data: Record<string, unknown>): TaskEvent {
    const createdAt = now();
    const dataJson = JSON.stringify(data);
    const result = this.db.prepare('INSERT INTO task_events(task_id,attempt_id,type,data_json,created_at) VALUES (?,?,?,?,?)')
      .run(taskId, attemptId, type, dataJson, createdAt);
    const event = { seq: Number(result.lastInsertRowid), taskId, attemptId, type, data: JSON.parse(dataJson) as Record<string, unknown>, createdAt };
    this.transactionEvents?.push(event);
    return event;
  }

  create(command: CreateTaskCommand, baselineSha?: string): { task: Task; created: boolean } {
    return this.transaction(() => {
      const request = this.creationRequest(command);
      const previous = this.replayCommand<Task>(command.commandId, request);
      if (previous) return { task: previous, created: false };
      const timestamp = now();
      const task: Task = { id: randomUUID(), commandId: command.commandId, goal: command.goal, status: 'queued',
        deliveryStatus: 'pending', pauseRequested: false, activeAttemptId: null, createdAt: timestamp, updatedAt: timestamp,
        engine: command.engine ?? 'fake', configSnapshot: this.configurationSnapshot(command.profileIds), instructions: [], ...(command.engine === 'claude' ? {
          workspaceId: command.workspaceId, verificationCommands: command.verificationCommands, baselineSha,
        } : {}),
      };
      if (task.engine === 'claude' && (!baselineSha || !this.workspace(task.workspaceId!))) throw new Error('Real task requires a registered workspace and baseline');
      this.db.prepare('INSERT INTO tasks(id,command_id,goal,status,delivery_status,pause_requested,active_attempt_id,created_at,updated_at,execution_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(task.id, task.commandId, task.goal, task.status, task.deliveryStatus, 0, null, timestamp, timestamp, JSON.stringify({
          engine: task.engine, workspaceId: task.workspaceId, baselineSha, verificationCommands: task.verificationCommands,
          configSnapshot: task.configSnapshot, instructions: task.instructions,
        }));
      this.insertEvent(task.id, null, 'task.created', { status: 'queued', engine: task.engine, baselineSha: baselineSha ?? null });
      this.db.prepare('INSERT INTO commands VALUES (?,?,?,?)').run(command.commandId, request, JSON.stringify(task), timestamp);
      return { task, created: true };
    });
  }

  private creationRequest(command: CreateTaskCommand): string {
    const request = command.engine === 'claude' ? { goal: command.goal, engine: 'claude', workspaceId: command.workspaceId,
      verificationCommands: command.verificationCommands } : { goal: command.goal };
    return JSON.stringify({ ...request, ...(command.profileIds ? { profileIds: command.profileIds } : {}) });
  }

  replayCreation(command: CreateTaskCommand): Task | undefined {
    return this.replayCommand(command.commandId, this.creationRequest(command));
  }

  private replayCommand<T = Task>(commandId: string, request: string): T | undefined {
    const row = this.db.prepare('SELECT * FROM commands WHERE command_id=?').get(commandId) as Row | undefined;
    const intent = this.db.prepare('SELECT request_json FROM command_intents WHERE command_id=?').get(commandId) as Row | undefined;
    if (intent && !sameRequest(intent.request_json, request)) throw new TaskStateError('COMMAND_CONFLICT', 'commandId was already used with a different request');
    if (!row) return;
    if (!sameRequest(row.request_json, request)) throw new TaskStateError('COMMAND_CONFLICT', 'commandId was already used with a different request');
    return JSON.parse(String(row.result_json)) as T;
  }

  replayWorkspaceRegistration(command: { commandId: string; name: string; path: string }): Workspace | undefined {
    return this.replayCommand<Workspace>(command.commandId, JSON.stringify({ action: 'register_workspace', name: command.name, path: command.path }));
  }

  registerWorkspace(path: string, name: string, commandId?: string, requestedPath = path): Workspace {
    return this.transaction(() => {
      const request = JSON.stringify({ action: 'register_workspace', name, path: requestedPath });
      if (commandId) {
        const replay = this.replayCommand<Workspace>(commandId, request);
        if (replay) return replay;
      }
      const existing = this.db.prepare('SELECT * FROM workspaces WHERE path=?').get(path) as Row | undefined;
      const workspace: Workspace = existing
        ? { id: String(existing.id), path: String(existing.path), name: String(existing.name), createdAt: String(existing.created_at) }
        : { id: randomUUID(), path, name, createdAt: now() };
      if (!existing) this.db.prepare('INSERT INTO workspaces VALUES (?,?,?,?)').run(workspace.id, path, name, workspace.createdAt);
      if (commandId) this.db.prepare('INSERT INTO commands VALUES (?,?,?,?)').run(commandId, request, JSON.stringify(workspace), now());
      return workspace;
    });
  }

  workspaces(): Workspace[] {
    return (this.db.prepare('SELECT * FROM workspaces ORDER BY created_at,rowid').all() as Row[])
      .map(row => ({ id: String(row.id), path: String(row.path), name: String(row.name), createdAt: String(row.created_at) }));
  }

  workspace(id: string): Workspace | undefined { return this.workspaces().find(item => item.id === id); }

  bindWorktree(id: string, attemptId: string, value: { worktreePath: string; branchName: string }): void {
    this.transaction(() => {
      const task = this.require(id); assertCurrentAttempt(task, attemptId);
      const previous = JSON.parse(String((this.db.prepare('SELECT execution_json FROM tasks WHERE id=?').get(id) as Row).execution_json));
      this.db.prepare('UPDATE tasks SET execution_json=?,updated_at=? WHERE id=?').run(JSON.stringify({ ...previous, ...value }), now(), id);
      this.insertEvent(id, attemptId, 'workspace.ready', value);
    });
  }

  get(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Row | undefined;
    return row ? taskFrom(row) : undefined;
  }

  require(id: string): Task {
    const task = this.get(id);
    if (!task) throw Object.assign(new Error('Task not found'), { statusCode: 404, code: 'TASK_NOT_FOUND' });
    return task;
  }

  list(): Task[] {
    return (this.db.prepare('SELECT * FROM tasks ORDER BY created_at, rowid').all() as Row[]).map(taskFrom);
  }

  events(id: string, after = 0, limit?: number): TaskEvent[] {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new RangeError('Invalid event limit');
    const query = 'SELECT * FROM task_events WHERE task_id=? AND seq>? ORDER BY seq';
    const rows = limit === undefined ? this.db.prepare(query).all(id, after)
      : this.db.prepare(query + ' LIMIT ?').all(id, after, limit);
    return (rows as Row[]).map(eventFrom);
  }

  latestEventSeq(id: string): number {
    return Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM task_events WHERE task_id=?').get(id) as Row).seq);
  }

  artifacts(id: string): Artifact[] {
    return (this.db.prepare('SELECT * FROM artifacts WHERE task_id=? ORDER BY created_at, rowid').all(id) as Row[]).map(artifactFrom);
  }

  snapshot(id: string): TaskSnapshot {
    return this.transaction(() => {
      const task = this.require(id);
      const events = this.events(id);
      return { task, events, artifacts: this.artifacts(id), cursor: events.at(-1)?.seq ?? 0,
        ...(task.engine === 'claude' ? { stages: this.records<StageRecord>('stages', id), runs: this.records<AgentRunRecord>('agent_runs', id),
          verifications: this.records<VerificationResult>('verifications', id), approvals: this.approvals(id) } : {}),
      };
    });
  }

  start(id: string, engine = 'fake'): Task {
    return this.transaction(() => {
      const attemptId = randomUUID();
      let task = beginTaskAttempt(this.require(id), attemptId);
      if (!task.configSnapshot) {
        task = { ...task, configSnapshot: this.configurationSnapshot() };
        this.writeExecution(id, { configSnapshot: task.configSnapshot });
      }
      this.db.prepare('INSERT INTO attempts VALUES (?,?,?,?,?,?)').run(attemptId, id, engine, task.updatedAt, null, 'running');
      this.writeTask(task);
      this.insertEvent(id, attemptId, 'task.status_changed', { status: task.status });
      return task;
    });
  }

  transition(id: string, status: TaskStatus, attemptId?: string, data: Record<string, unknown> = {}): Task {
    return this.transaction(() => {
      const previous = this.require(id);
      const task = transitionTask(previous, status, { attemptId });
      this.writeTask(task);
      if (previous.activeAttemptId && !task.activeAttemptId) {
        this.db.prepare('UPDATE attempts SET ended_at=?,status=? WHERE id=?').run(task.updatedAt, status, previous.activeAttemptId);
        this.expireApprovals(id, previous.activeAttemptId);
      }
      this.insertEvent(id, previous.activeAttemptId, 'task.status_changed', { ...data, status });
      return task;
    });
  }

  private records<T>(table: 'stages' | 'agent_runs' | 'verifications', id: string): T[] {
    return (this.db.prepare(`SELECT payload_json FROM ${table} WHERE task_id=? ORDER BY rowid`).all(id) as Row[]).map(row => JSON.parse(String(row.payload_json)) as T);
  }

  recordStage(stage: StageRecord): void {
    this.transaction(() => {
      const task = this.require(stage.taskId);
      assertCurrentAttempt(task, stage.attemptId);
      if (stage.status === 'running' && task.pauseRequested) throw new TaskStateError('PAUSE_REQUESTED', 'Pause prevents entering another stage');
      this.db.prepare('INSERT INTO stages VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json')
        .run(stage.id, stage.taskId, stage.attemptId, JSON.stringify(stage));
      this.insertEvent(stage.taskId, stage.attemptId, 'stage.updated', { stageId: stage.id, name: stage.name, status: stage.status, iteration: stage.iteration });
    });
  }

  saveCheckpoint(id: string, attemptId: string, checkpoint: PipelineCheckpoint): void {
    this.transaction(() => {
      assertCurrentAttempt(this.require(id), attemptId);
      this.writeExecution(id, { checkpoint });
      this.insertEvent(id, attemptId, 'pipeline.checkpoint', { nextStage: checkpoint.nextStage, iteration: checkpoint.iteration });
    });
  }

  /** Stage completion, evidence cursor, and both events commit together. */
  completeStage(stage: StageRecord, checkpoint: PipelineCheckpoint): void {
    this.transaction(() => {
      assertCurrentAttempt(this.require(stage.taskId), stage.attemptId);
      if (stage.status !== 'completed') throw new Error('A completed checkpoint requires a completed stage');
      this.db.prepare('INSERT INTO stages VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json')
        .run(stage.id, stage.taskId, stage.attemptId, JSON.stringify(stage));
      this.writeExecution(stage.taskId, { checkpoint });
      this.insertEvent(stage.taskId, stage.attemptId, 'stage.updated', { stageId: stage.id, name: stage.name, status: stage.status, iteration: stage.iteration });
      this.insertEvent(stage.taskId, stage.attemptId, 'pipeline.checkpoint', { nextStage: checkpoint.nextStage, iteration: checkpoint.iteration });
    });
  }

  verifications(id: string): VerificationResult[] { return this.records<VerificationResult>('verifications', id); }

  registerProcess(record: OwnedProcessRecord): void {
    this.transaction(() => {
      if (record.status !== 'active' || !record.taskId || !record.attemptId) throw new Error('Task process requires active ownership context');
      assertCurrentAttempt(this.require(record.taskId), record.attemptId);
      this.db.prepare('INSERT INTO owned_processes VALUES (?,?,?,?,?)')
        .run(record.id, record.taskId, record.attemptId, record.status, JSON.stringify(record));
      this.insertEvent(record.taskId, record.attemptId, 'process.started', { processId: record.id, kind: record.kind, runId: record.runId ?? null });
    });
  }

  closeProcess(record: OwnedProcessRecord): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT payload_json FROM owned_processes WHERE id=?').get(record.id) as Row | undefined;
      if (!row) throw new Error('Process owner was never registered');
      const previous = JSON.parse(String(row.payload_json)) as OwnedProcessRecord;
      if (JSON.stringify({ ...previous, status: 'closed' }) !== JSON.stringify(record)) throw new Error('Process ownership changed');
      if (previous.status === 'closed') return;
      this.db.prepare("UPDATE owned_processes SET status='closed',payload_json=? WHERE id=?").run(JSON.stringify(record), record.id);
      if (record.taskId) this.insertEvent(record.taskId, record.attemptId ?? null, 'process.closed', { processId: record.id, kind: record.kind });
    });
  }

  processes(activeOnly = true): OwnedProcessRecord[] {
    return (this.db.prepare('SELECT payload_json FROM owned_processes' + (activeOnly ? " WHERE status='active'" : '') + ' ORDER BY rowid').all() as Row[])
      .map(row => JSON.parse(String(row.payload_json)) as OwnedProcessRecord);
  }

  recordAgentRun(run: AgentRunRecord): void {
    this.transaction(() => {
      assertCurrentAttempt(this.require(run.taskId), run.attemptId);
      this.db.prepare('INSERT INTO agent_runs VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json')
        .run(run.id, run.taskId, run.attemptId, run.stageId, JSON.stringify(run));
      this.insertEvent(run.taskId, run.attemptId, 'agent_run.updated', { runId: run.id, role: run.role, mode: run.mode, status: run.status });
    });
  }

  recordVerification(result: VerificationResult): void {
    this.transaction(() => {
      assertCurrentAttempt(this.require(result.taskId), result.attemptId);
      this.db.prepare('INSERT INTO verifications VALUES (?,?,?,?,?)').run(result.id, result.taskId, result.attemptId, result.stageId, JSON.stringify(result));
      this.insertEvent(result.taskId, result.attemptId, 'verification.completed', { verificationId: result.id, exitCode: result.exitCode,
        timedOut: result.timedOut, cancelled: result.cancelled });
    });
  }

  addApproval(approval: ApprovalRecord): void {
    this.transaction(() => {
      const previous = this.require(approval.taskId); assertCurrentAttempt(previous, approval.attemptId);
      this.db.prepare('INSERT INTO approvals VALUES (?,?,?,?,?,?)').run(approval.id, approval.taskId, approval.attemptId, approval.runId, approval.status, JSON.stringify(approval));
      if (previous.status === 'running') this.writeTask(transitionTask(previous, 'waiting_human', { attemptId: approval.attemptId }));
      this.updateApprovalRun(approval, 'waiting_human');
      this.insertEvent(approval.taskId, approval.attemptId, 'approval.requested', { approvalId: approval.id, runId: approval.runId });
    });
  }

  approvals(taskId?: string): ApprovalRecord[] {
    const rows = taskId ? this.db.prepare('SELECT payload_json FROM approvals WHERE task_id=? ORDER BY rowid').all(taskId)
      : this.db.prepare("SELECT payload_json FROM approvals WHERE status='pending' ORDER BY rowid").all();
    return (rows as Row[]).map(row => JSON.parse(String(row.payload_json)) as ApprovalRecord);
  }

  approval(id: string): ApprovalRecord | undefined {
    const row = this.db.prepare('SELECT payload_json FROM approvals WHERE id=?').get(id) as Row | undefined;
    return row ? JSON.parse(String(row.payload_json)) as ApprovalRecord : undefined;
  }

  resolveApproval(id: string, commandId: string, optionId: string): ApprovalRecord {
    return this.transaction(() => {
      const request = JSON.stringify({ action: 'resolve_approval', id, optionId });
      const previousCommand = this.replayCommand<ApprovalRecord>(commandId, request);
      if (previousCommand) return previousCommand;
      const approval = this.approval(id);
      if (!approval) throw Object.assign(new Error('Approval not found'), { statusCode: 404, code: 'APPROVAL_NOT_FOUND' });
      assertCurrentAttempt(this.require(approval.taskId), approval.attemptId);
      if (approval.status !== 'pending' || !approval.options.some(option => option.optionId === optionId)) throw new TaskStateError('STALE_ATTEMPT', 'Approval is not pending or option is unavailable');
      const resolved: ApprovalRecord = { ...approval, status: 'resolved', selectedOptionId: optionId, resolvedAt: now() };
      this.db.prepare('UPDATE approvals SET status=?,payload_json=? WHERE id=?').run('resolved', JSON.stringify(resolved), id);
      if (!this.approvals(approval.taskId).some(item => item.status === 'pending' && item.runId === approval.runId)) this.updateApprovalRun(approval, 'running');
      if (!this.approvals(approval.taskId).some(item => item.status === 'pending')) {
        const task = this.require(approval.taskId);
        if (task.status === 'waiting_human') this.writeTask(transitionTask(task, 'running', { attemptId: approval.attemptId }));
      }
      this.insertEvent(approval.taskId, approval.attemptId, 'approval.resolved', { approvalId: id, optionId });
      this.db.prepare('INSERT INTO commands VALUES (?,?,?,?)').run(commandId, request, JSON.stringify(resolved), now());
      return resolved;
    });
  }

  private expireApprovals(id: string, attemptId: string): void {
    for (const item of this.approvals(id)) if (item.attemptId === attemptId && item.status === 'pending') {
      const expired = { ...item, status: 'expired', resolvedAt: now() };
      this.db.prepare('UPDATE approvals SET status=?,payload_json=? WHERE id=?').run('expired', JSON.stringify(expired), item.id);
    }
  }

  private updateApprovalRun(approval: ApprovalRecord, status: 'running' | 'waiting_human'): void {
    const row = this.db.prepare('SELECT payload_json FROM agent_runs WHERE id=? AND task_id=? AND attempt_id=?')
      .get(approval.runId, approval.taskId, approval.attemptId) as Row | undefined;
    if (!row) throw new TaskStateError('STALE_ATTEMPT', 'Approval does not belong to an active agent run');
    const run = JSON.parse(String(row.payload_json)) as AgentRunRecord;
    if (!['running', 'waiting_human'].includes(run.status)) throw new TaskStateError('STALE_ATTEMPT', 'Agent run is no longer active');
    const updated = { ...run, status };
    this.db.prepare('UPDATE agent_runs SET payload_json=? WHERE id=?').run(JSON.stringify(updated), run.id);
    this.insertEvent(approval.taskId, approval.attemptId, 'agent_run.updated', { runId: run.id, role: run.role, mode: run.mode, status });
  }

  private controlRequest(id: string, command: TaskControlCommand): string {
    return JSON.stringify({ id, action: command.action, ...('requirements' in command && command.requirements !== undefined ? { requirements: command.requirements } : {}) });
  }

  replayControl(id: string, command: TaskControlCommand): Task | undefined {
    return this.replayCommand(command.commandId, this.controlRequest(id, command));
  }

  private validateControl(task: Task, command: TaskControlCommand): void {
    const invalid = (message: string): never => { throw new TaskStateError('INVALID_TASK_TRANSITION', message); };
    if (['feedback', 'return'].includes(command.action) && (!('requirements' in command) || !command.requirements?.trim())) invalid('Requirements are required');
    switch (command.action) {
      case 'feedback': if (['completed', 'cancelled'].includes(task.status)) invalid('Task no longer accepts instructions'); break;
      case 'pause': if (!['queued', 'running', 'waiting_human'].includes(task.status)) invalid('Task cannot pause'); break;
      case 'takeover': if (!['queued', 'running', 'waiting_human'].includes(task.status)) invalid('Task cannot be taken over'); break;
      case 'cancel': if (['completed', 'cancelled'].includes(task.status)) invalid('Task is already terminal'); break;
      case 'resume': if (!['paused', 'interrupted'].includes(task.status)) invalid('Only paused or interrupted tasks resume'); break;
      case 'retry':
        if (!['failed', 'interrupted', 'waiting_human'].includes(task.status)) invalid('Only failed, interrupted or review waits retry');
        if (task.status === 'waiting_human' && this.approvals(task.id).some(item => item.status === 'pending')) invalid('Resolve or take over pending permissions before retrying');
        break;
      case 'accept': case 'return':
        if (task.status !== 'completed' || task.deliveryStatus !== 'pending') invalid('Only a pending completed delivery can be received'); break;
    }
  }

  private beginControlInTransaction(id: string, command: TaskControlCommand): Task {
    const request = this.controlRequest(id, command);
    const replay = this.replayCommand(command.commandId, request);
    if (replay) return replay;
    const pending = this.db.prepare('SELECT command_id FROM command_intents WHERE command_id=?').get(command.commandId);
    if (pending) return this.require(id);
    let task = this.require(id);
    this.validateControl(task, command);
    this.db.prepare('INSERT INTO command_intents VALUES (?,?,?,?)').run(command.commandId, id, request, now());
    if ('requirements' in command && command.requirements?.trim()) {
      const instruction = { id: randomUUID(), commandId: command.commandId, requirements: command.requirements, createdAt: now() };
      this.writeExecution(id, { instructions: [...(task.instructions ?? []), instruction] });
      this.insertEvent(id, task.activeAttemptId, 'task.instruction_added', { instructionId: instruction.id, commandId: command.commandId, requirements: instruction.requirements });
      task = this.require(id);
    }
    // Persist the stop intent before aborting an engine. A crash cannot lose the
    // instruction or let a just-finished stage start more tools.
    if (['pause', 'takeover', 'cancel'].includes(command.action) && ['running', 'waiting_human'].includes(task.status)) {
      task = requestTaskPause(task);
      this.writeTask(task);
    }
    this.insertEvent(id, task.activeAttemptId, 'task.control_requested', { action: command.action, commandId: command.commandId });
    return task;
  }

  beginControl(id: string, command: TaskControlCommand): Task {
    return this.transaction(() => this.beginControlInTransaction(id, command));
  }

  finishControl(id: string, command: TaskControlCommand): { task: Task; created: boolean } {
    return this.transaction(() => {
      const request = this.controlRequest(id, command);
      const old = this.replayCommand<Task>(command.commandId, request);
      if (old) return { task: old, created: false };
      const previous = this.beginControlInTransaction(id, command);
      let task = previous;
      switch (command.action) {
        case 'feedback': break;
        case 'pause': if (task.status === 'queued' || task.status === 'waiting_human') task = transitionTask(task, 'paused'); break;
        case 'takeover': if (task.status !== 'paused') task = transitionTask(task, 'paused'); break;
        case 'cancel': if (task.status !== 'cancelled') task = transitionTask(task, 'cancelled'); break;
        case 'resume': task = transitionTask(task, 'queued'); break;
        case 'retry':
          if (task.status === 'waiting_human') {
            task = transitionTask(task, 'failed');
            this.writeExecution(id, { checkpoint: { nextStage: 'development', iteration: 0, analyses: task.checkpoint?.analyses } });
            this.insertEvent(id, previous.activeAttemptId, 'task.status_changed', { status: 'failed', reason: 'manual_retry' });
          }
          task = transitionTask(task, 'queued'); break;
        case 'accept':
          task = updateTaskDelivery(task, 'accepted');
          this.insertEvent(id, null, 'delivery.accepted', { commandId: command.commandId }); break;
        case 'return':
          task = updateTaskDelivery(task, 'returned');
          this.insertEvent(id, null, 'delivery.returned', { commandId: command.commandId });
          this.writeExecution(id, { checkpoint: { nextStage: 'development', iteration: 0, analyses: task.checkpoint?.analyses } });
          task = transitionTask(task, 'queued'); break;
      }
      this.writeTask(task);
      if (previous.activeAttemptId && !task.activeAttemptId) {
        this.db.prepare('UPDATE attempts SET ended_at=?,status=? WHERE id=?').run(task.updatedAt, command.action === 'retry' ? 'failed' : task.status, previous.activeAttemptId);
        this.expireApprovals(id, previous.activeAttemptId);
      }
      if (task.status !== previous.status) this.insertEvent(id, previous.activeAttemptId, 'task.status_changed', { status: task.status });
      this.insertEvent(id, task.activeAttemptId, 'task.control_applied', { action: command.action, commandId: command.commandId });
      task = this.require(id);
      this.db.prepare('INSERT INTO commands VALUES (?,?,?,?)').run(command.commandId, request, JSON.stringify(task), now());
      this.db.prepare('DELETE FROM command_intents WHERE command_id=?').run(command.commandId);
      return { task, created: true };
    });
  }

  append(id: string, attemptId: string, type: string, data: Record<string, unknown>): TaskEvent {
    return this.transaction(() => {
      assertCurrentAttempt(this.require(id), attemptId);
      return this.insertEvent(id, attemptId, type, data);
    });
  }

  addArtifact(id: string, attemptId: string, artifact: Pick<Artifact, 'kind' | 'name' | 'content'>): Artifact {
    return this.transaction(() => {
      assertCurrentAttempt(this.require(id), attemptId);
      const item: Artifact = { ...artifact, id: randomUUID(), taskId: id, attemptId, createdAt: now() };
      this.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,?,?)').run(item.id, id, attemptId, item.kind, item.name, item.content, item.createdAt);
      this.insertEvent(id, attemptId, 'artifact.created', { artifactId: item.id, kind: item.kind, name: item.name });
      return item;
    });
  }

  /** Call only after verified process recovery; never replay active tools. */
  interruptActive(): void {
    for (const task of this.list()) if (task.status === 'running' || task.status === 'waiting_human') {
      this.transaction(() => {
        for (const table of ['stages', 'agent_runs'] as const) {
          for (const record of this.records<StageRecord | AgentRunRecord>(table, task.id)) {
            if (record.attemptId === task.activeAttemptId && ['running', 'waiting_human'].includes(record.status)) {
              const retired = { ...record, status: 'cancelled', endedAt: now() };
              this.db.prepare(`UPDATE ${table} SET payload_json=? WHERE id=?`).run(JSON.stringify(retired), record.id);
              this.insertEvent(task.id, task.activeAttemptId, table === 'stages' ? 'stage.updated' : 'agent_run.updated',
                { ...retired, reason: 'service_restart' });
            }
          }
        }
        const interrupted = transitionTask(task, 'interrupted', { attemptId: task.activeAttemptId ?? undefined });
        this.writeTask(interrupted);
        if (task.activeAttemptId) {
          this.db.prepare('UPDATE attempts SET ended_at=?,status=? WHERE id=?').run(interrupted.updatedAt, 'interrupted', task.activeAttemptId);
          this.expireApprovals(task.id, task.activeAttemptId);
        }
        this.insertEvent(task.id, task.activeAttemptId, 'task.status_changed', { status: 'interrupted', reason: 'service_restart' });
      });
    }
  }

  private seedConfiguration(): void {
    const timestamp = now();
    this.db.prepare('INSERT OR IGNORE INTO instance_settings VALUES (1,?)').run(JSON.stringify({ defaultEngine: 'fake', agentRunTimeoutMs: 1_800_000, verificationTimeoutMs: 300_000, updatedAt: timestamp }));
    for (const role of ['planner', 'developer', 'reviewer'] as const) {
      const profile: AgentProfile = { id: `default-${role}`, role, name: role, instructions: '', updatedAt: timestamp };
      this.db.prepare('INSERT OR IGNORE INTO agent_profiles VALUES (?,?,?)').run(profile.id, role, JSON.stringify(profile));
    }
  }

  settings(): InstanceSettings { return JSON.parse(String((this.db.prepare('SELECT payload_json FROM instance_settings WHERE id=1').get() as Row).payload_json)) as InstanceSettings; }

  profiles(): AgentProfile[] { return (this.db.prepare('SELECT payload_json FROM agent_profiles ORDER BY rowid').all() as Row[]).map(row => JSON.parse(String(row.payload_json)) as AgentProfile); }

  private configurationSnapshot(ids?: Partial<Record<AgentRole, string>>): TaskConfigurationSnapshot {
    const profiles = {} as Record<AgentRole, AgentProfile>;
    for (const role of ['planner', 'developer', 'reviewer'] as const) {
      const profile = this.profiles().find(item => item.id === (ids?.[role] ?? `default-${role}`));
      if (!profile || profile.role !== role) throw Object.assign(new Error('Selected agent profile does not match its role'), { statusCode: 400, code: 'PROFILE_ROLE_MISMATCH' });
      profiles[role] = profile;
    }
    return { settings: this.settings(), profiles };
  }

  private audit(type: string, data: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO audit_events(type,data_json,created_at) VALUES (?,?,?)').run(type, JSON.stringify(data), now());
  }

  updateSettings(command: { commandId: string; defaultEngine?: InstanceSettings['defaultEngine']; agentRunTimeoutMs?: number; verificationTimeoutMs?: number }): InstanceSettings {
    return this.transaction(() => {
      const { commandId, ...patch } = command;
      const request = JSON.stringify({ action: 'settings', ...patch });
      const replay = this.replayCommand<InstanceSettings>(commandId, request);
      if (replay) return replay;
      const settings = { ...this.settings(), ...patch, updatedAt: now() };
      this.db.prepare('UPDATE instance_settings SET payload_json=? WHERE id=1').run(JSON.stringify(settings));
      this.audit('settings.updated', { commandId, ...patch });
      this.db.prepare('INSERT INTO commands VALUES (?,?,?,?)').run(commandId, request, JSON.stringify(settings), now());
      return settings;
    });
  }

  saveProfile(command: { commandId: string; name?: string; role?: AgentRole; model?: string; instructions?: string }, id?: string): AgentProfile {
    return this.transaction(() => {
      const { commandId, ...patch } = command;
      const request = JSON.stringify({ action: id ? 'update_profile' : 'create_profile', id, ...patch });
      const replay = this.replayCommand<AgentProfile>(commandId, request);
      if (replay) return replay;
      const existing = id ? this.profiles().find(item => item.id === id) : undefined;
      if (id && !existing) throw Object.assign(new Error('Agent profile not found'), { statusCode: 404, code: 'PROFILE_NOT_FOUND' });
      const profile = { ...existing, ...patch, id: id ?? randomUUID(), updatedAt: now() } as AgentProfile;
      if (!profile.model) delete profile.model;
      this.db.prepare('INSERT INTO agent_profiles VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json')
        .run(profile.id, profile.role, JSON.stringify(profile));
      this.audit('profile.saved', { commandId, profileId: profile.id, role: profile.role });
      this.db.prepare('INSERT INTO commands VALUES (?,?,?,?)').run(commandId, request, JSON.stringify(profile), now());
      return profile;
    });
  }

  close(): void { this.listeners.clear(); this.db.close(); }
}
