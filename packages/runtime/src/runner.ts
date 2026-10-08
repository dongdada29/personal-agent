import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore } from './store.js';
import { createFakeEngineAdapter } from './engine-fake.js';
import type { EngineAdapter, EngineSession } from './engine.js';
import { EngineError } from './engine.js';
import { createClaudeTaskAdapter } from './engine-claude-task.js';
import { executeDevelopmentTask } from './pipeline.js';
import type { PipelinePermissionContext } from './pipeline.js';
import type { EnginePermission } from './engine.js';

/** One task at a time; the real analysis stage owns at most two engine processes. */
export class TaskRunner {
  private queue: string[] = [];
  private pumping?: Promise<void>;
  private stopped = false;
  private blocked = false;
  private session?: EngineSession;
  private abort?: AbortController;
  private currentTaskId?: string;
  private currentCompletion?: Promise<void>;
  private finishCurrent?: () => void;
  private stopDisposition?: 'cancelled' | 'paused';
  private readonly pendingPermissions = new Map<string, PipelinePermissionContext>();

  constructor(private store: TaskStore, private dataDir: string, private adapter: EngineAdapter = createFakeEngineAdapter(),
    private realAdapter: EngineAdapter = createClaudeTaskAdapter()) {}

  get isBlocked(): boolean { return this.blocked; }

  enqueue(id: string): void {
    if (this.stopped) return;
    if (!this.queue.includes(id)) this.queue.push(id);
    this.ensurePump();
  }

  private ensurePump(): void {
    if (!this.stopped && this.queue.length && !this.pumping) {
      this.pumping = this.pump().catch(() => {
        // A persistence failure must not become an unhandled background rejection.
        this.blocked = true;
        this.stopped = true;
      }).finally(() => {
        this.pumping = undefined;
        // An enqueue can race the last pump iteration and its Promise settlement.
        this.ensurePump();
      });
    }
  }

  private async pump(): Promise<void> {
    while (!this.stopped && this.queue.length) {
      const id = this.queue.shift()!;
      if (this.store.get(id)?.status !== 'queued') continue;
      let attemptId: string | undefined;
      let outcome: 'completed' | 'failed' | 'waiting_human' | 'paused' = 'failed';
      let reason: string | undefined;
      let acceptingFakeEvents = false;
      let removeFakeAbort = () => {};
      try {
        this.currentTaskId = id; this.stopDisposition = undefined;
        this.currentCompletion = new Promise<void>(resolve => { this.finishCurrent = resolve; });
        const task = this.store.start(id, this.store.require(id).engine ?? 'fake');
        attemptId = task.activeAttemptId!;
        const currentAttempt = attemptId;
        if (task.engine !== 'claude' && task.checkpoint?.nextStage === 'delivery' && task.checkpoint.outcome?.status === 'completed') {
          outcome = 'completed';
          continue;
        }
        const cwd = join(this.dataDir, 'tasks', id, currentAttempt);
        mkdirSync(cwd, { recursive: true });
        this.abort = new AbortController();
        const attemptSignal = this.abort.signal;
        if (task.engine === 'claude') {
          const result = await executeDevelopmentTask({ task, attemptId: currentAttempt, store: this.store,
            adapter: this.realAdapter, dataDir: this.dataDir, signal: this.abort.signal,
            hooks: { onPermission: (request, context) => this.onPermission(request, context),
              onProcessStart: record => this.store.registerProcess(record), onProcessEnd: record => this.store.closeProcess(record) },
          });
          outcome = result.status; reason = result.reason;
          continue;
        }
        acceptingFakeEvents = true;
        this.session = await this.adapter.open({ taskId: id, attemptId: currentAttempt, runId: currentAttempt, cwd, mode: 'plan', signal: attemptSignal,
          configSnapshot: task.configSnapshot }, {
          onProcessStart: record => this.store.registerProcess(record),
          onProcessEnd: record => this.store.closeProcess(record),
          onEvent: async (event) => {
            if (!acceptingFakeEvents || this.stopped || attemptSignal.aborted) return;
            try {
              if (event.type === 'artifact') {
                this.store.addArtifact(id, currentAttempt, { kind: event.kind, name: event.title, content: event.content });
              } else this.store.append(id, currentAttempt, `engine.${event.type}`, { ...event });
            } catch { throw new EngineError('EVENT_FAILURE', 'Fake task event could not be persisted.'); }
          },
          onPermission: async (request) => {
            if (!acceptingFakeEvents || this.stopped || attemptSignal.aborted) throw new EngineError('ABORTED', 'Permission belongs to a stopped fake attempt');
            try { this.store.append(id, currentAttempt, 'engine.permission_denied', { requestId: request.id }); }
            catch { throw new EngineError('EVENT_FAILURE', 'Fake permission event could not be persisted.'); }
            // No permission approval API until the persisted-approval phase exists.
            const reject = request.options.find(option => option.kind === 'reject_once' || option.kind === 'reject_always');
            if (reject) await this.session?.resolvePermission(request.id, reject.optionId);
            else await this.session?.cancel();
          },
        });
        if (this.stopped) { await this.session.close(); break; }
        const latestRequirements = this.store.require(id).instructions ?? [];
        const input = latestRequirements.length ? `${task.goal}\n\nAdditional requirements:\n${JSON.stringify(latestRequirements)}` : task.goal;
        const aborted = new Promise<never>((_, reject) => {
          const abort = () => reject(new EngineError('ABORTED', 'Fake task execution was stopped.'));
          removeFakeAbort = () => attemptSignal.removeEventListener('abort', abort);
          if (attemptSignal.aborted) abort();
          else attemptSignal.addEventListener('abort', abort, { once: true });
        });
        void aborted.catch(() => {});
        const result = await Promise.race([this.session.prompt(input, attemptSignal), aborted]);
        if (this.stopped) break;
        if (result.stopReason !== 'end_turn') throw new Error('ENGINE_STOPPED');
        if (!this.store.artifacts(id).some(artifact => artifact.attemptId === currentAttempt)) throw new Error('ENGINE_NO_ARTIFACT');
        outcome = 'completed';
      } catch (error) {
        // Engine errors may contain credentials or tool output; persist a stable code only.
        outcome = 'failed';
        if (!attemptId) { this.blocked = true; this.stopped = true; }
        if (error instanceof EngineError && ['CLEANUP_FAILED', 'EVENT_FAILURE'].includes(error.code)) { this.blocked = true; this.stopped = true; }
        reason = error instanceof EngineError && (this.store.get(id)?.engine === 'claude' || error.code === 'EVENT_FAILURE') ? error.code : 'engine_execution_failed';
      } finally {
        acceptingFakeEvents = false;
        removeFakeAbort();
        try { await this.session?.close(); }
        catch {
          // Never dispatch a second process when the previous tree's exit is unconfirmed.
          this.blocked = true;
          this.stopped = true;
        }
        this.session = undefined;
        this.abort = undefined;
        try {
          if (attemptId && this.store.get(id)?.activeAttemptId === attemptId) {
            const current = this.store.require(id);
            if (current.engine !== 'claude' && outcome === 'completed' && !this.blocked && !this.stopped && !this.stopDisposition
              && current.checkpoint?.nextStage !== 'delivery') {
              // Fake has one complete prompt stage; persist only after close.
              this.store.saveCheckpoint(id, attemptId, { nextStage: 'delivery', iteration: 0, outcome: { status: 'completed' } });
            }
            const gracefulPause = current.pauseRequested && (outcome === 'completed' || outcome === 'waiting_human');
            const status = this.blocked || this.stopped ? 'interrupted' : this.stopDisposition ?? (gracefulPause ? 'paused' : outcome);
            // Permissions can already have put the task in waiting_human.
            if (status !== this.store.get(id)?.status) this.store.transition(id, status, attemptId,
              this.blocked ? { reason: reason === 'EVENT_FAILURE' ? 'event_persistence_failed' : 'engine_cleanup_failed' } : this.stopped ? { reason: 'service_stop' }
                : this.stopDisposition === 'paused' ? { reason: 'user_takeover' }
                : this.stopDisposition === 'cancelled' ? { reason: 'user_cancel' }
                : gracefulPause ? { reason: 'pause_requested' }
                : reason ? { reason } : outcome === 'failed' ? { reason: 'engine_execution_failed' } : {});
          }
        } catch {
          // Cancel must settle even when persisting the final state fails.
          this.blocked = true;
          this.stopped = true;
        } finally {
          for (const [permissionId, context] of this.pendingPermissions) if (context.taskId === id) this.pendingPermissions.delete(permissionId);
          this.currentTaskId = undefined;
          this.stopDisposition = undefined;
          this.finishCurrent?.(); this.finishCurrent = undefined; this.currentCompletion = undefined;
        }
      }
    }
  }

  async idle(): Promise<void> { while (this.pumping) await this.pumping; }

  private async onPermission(request: EnginePermission, context: PipelinePermissionContext): Promise<void> {
    if (this.abort?.signal.aborted || this.stopped) throw new EngineError('ABORTED', 'Permission belongs to a cancelled task');
    this.pendingPermissions.set(request.id, context);
    try {
      this.store.addApproval({ id: request.id, taskId: context.taskId, attemptId: context.attemptId, runId: context.runId,
        title: request.title, options: request.options, ...(request.toolCall ? { toolCall: request.toolCall } : {}),
        status: 'pending', createdAt: new Date().toISOString(), resolvedAt: null, selectedOptionId: null });
    } catch {
      this.pendingPermissions.delete(request.id);
      throw new EngineError('EVENT_FAILURE', 'Engine permission request could not be persisted.');
    }
  }

  canResolvePermission(id: string): boolean { return this.pendingPermissions.has(id) && !this.abort?.signal.aborted && !this.stopped; }

  async resolvePermission(id: string, optionId: string): Promise<void> {
    const context = this.pendingPermissions.get(id);
    if (!context) return; // Idempotent acknowledgement after an already delivered decision.
    if (this.abort?.signal.aborted || this.stopped) throw new EngineError('ABORTED', 'Permission belongs to a cancelled task');
    await context.session.resolvePermission(id, optionId);
    this.pendingPermissions.delete(id);
  }

  async cancel(id: string): Promise<void> {
    return this.stopCurrent(id, 'cancelled');
  }

  async takeover(id: string): Promise<void> {
    return this.stopCurrent(id, 'paused');
  }

  async stopCurrent(id: string, disposition: 'cancelled' | 'paused'): Promise<void> {
    // Remove queued work before yielding to a concurrently finishing task.
    this.queue = this.queue.filter(queuedId => queuedId !== id);
    if (this.currentTaskId !== id) return;
    const active = this.currentCompletion;
    // A terminal cancellation wins over a concurrent request to pause.
    this.stopDisposition = this.stopDisposition === 'cancelled' ? 'cancelled' : disposition;
    this.abort?.abort();
    try { await this.session?.cancel(); } catch { this.blocked = true; this.stopped = true; }
    await active;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    try { await this.session?.cancel(); await this.session?.close(); }
    catch { this.blocked = true; }
    await this.pumping;
    this.store.interruptActive();
  }
}

/** Compatibility for phase one consumers; default tasks still use fake ACP. */
export { TaskRunner as FakeTaskRunner };
