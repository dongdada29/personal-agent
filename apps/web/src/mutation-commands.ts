import type { Task, TaskControlCommand } from '@personal-agent/contracts';

export class MutationCommands {
  private readonly commands = new Map<string, string>();

  constructor(private readonly newId: () => string = () => crypto.randomUUID()) {}

  key(scope: string, payload: unknown, version?: unknown): string {
    return JSON.stringify([scope, version, payload]);
  }

  id(key: string): string {
    const existing = this.commands.get(key);
    if (existing) return existing;
    const id = this.newId();
    this.commands.set(key, id);
    return id;
  }

  complete(key: string): void { this.commands.delete(key); }
}

/** The lock is synchronous, so two click handlers in one render cannot duplicate a mutation. */
export class MutationFlight {
  private active = false;
  get isRunning(): boolean { return this.active; }

  async run<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (this.active) return undefined;
    this.active = true;
    try { return await work(); }
    finally { this.active = false; }
  }
}

export type ControlAction = TaskControlCommand['action'];

export function controlCommand(action: ControlAction, commandId: string, requirements?: string): TaskControlCommand {
  const trimmed = requirements?.trim() ?? '';
  if (action === 'feedback' || action === 'return') {
    if (!trimmed) throw new Error('请先填写补充或退回要求。');
    return { commandId, action, requirements: trimmed };
  }
  if (action === 'takeover' && trimmed) return { commandId, action, requirements: trimmed };
  return { commandId, action };
}

export function taskVersion(task: Task): unknown[] {
  return [task.id, task.status, task.activeAttemptId, task.updatedAt];
}

/** Keep an unacknowledged request tied to its original version across SSE updates. */
export class TaskMutationCommands extends MutationCommands {
  private readonly uncertain = new Map<string, string>();
  private identity(task: Task, payload: unknown): string {
    return JSON.stringify([task.id, task.activeAttemptId, payload]);
  }
  taskKey(task: Task, payload: unknown): string {
    return this.uncertain.get(this.identity(task, payload)) ?? this.key(`task:${task.id}`, payload, taskVersion(task));
  }
  unacknowledged(task: Task, payload: unknown, key: string): void {
    this.uncertain.set(this.identity(task, payload), key);
  }
  acknowledged(task: Task, payload: unknown, key: string): void {
    this.complete(key);
    this.uncertain.delete(this.identity(task, payload));
  }
}

export function availableTaskActions(task: Task, hasPendingApproval: boolean): ControlAction[] {
  const actions: ControlAction[] = [];
  if (['queued', 'running', 'waiting_human', 'paused', 'interrupted', 'failed'].includes(task.status)) actions.push('feedback');
  if (['queued', 'running', 'waiting_human'].includes(task.status) && !task.pauseRequested) actions.push('pause');
  if (['queued', 'running', 'waiting_human'].includes(task.status)) actions.push('takeover');
  if (['paused', 'interrupted'].includes(task.status)) actions.push('resume');
  if (['failed', 'interrupted'].includes(task.status) || (task.status === 'waiting_human' && !hasPendingApproval)) actions.push('retry');
  if (['queued', 'running', 'waiting_human', 'paused', 'interrupted', 'failed'].includes(task.status)) actions.push('cancel');
  if (task.status === 'completed' && task.deliveryStatus === 'pending') actions.push('accept', 'return');
  return actions;
}
