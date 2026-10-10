import { createHash, randomUUID } from 'node:crypto';
import {
  assertCurrentAttempt, parseReviewResult, ReviewResultError, TaskStateError,
  type AgentRole, type AgentRunRecord, type Artifact, type ReviewResult,
  type PipelineCheckpoint, type StageName, type StageRecord, type Task, type TaskInstruction,
  type VerificationResult, type Workspace,
} from '@personal-agent/contracts';
import {
  EngineError, safeEngineError, type EngineAdapter, type EngineEvent,
  type EngineHooks, type EnginePermission, type EnginePromptResult, type EngineSession,
} from './engine.js';
import { collectTaskPatch, createTaskWorktree } from './workspace.js';
import { runVerification } from './verification.js';

type Persisted = unknown | Promise<unknown>;

/** Implementations must fence every mutation against the active attempt. */
export interface PipelinePersistence {
  get(taskId: string): Task | undefined;
  workspace(workspaceId: string): Workspace | undefined;
  append(taskId: string, attemptId: string, type: string, data: Record<string, unknown>): Persisted;
  addArtifact(taskId: string, attemptId: string, artifact: Pick<Artifact, 'kind' | 'name' | 'content'>): Persisted;
  bindWorktree(taskId: string, attemptId: string, value: { worktreePath: string; branchName: string }): Persisted;
  recordStage(stage: StageRecord): Persisted;
  recordAgentRun(run: AgentRunRecord): Persisted;
  recordVerification(result: VerificationResult): Persisted;
  saveCheckpoint(taskId: string, attemptId: string, checkpoint: PipelineCheckpoint): Persisted;
  completeStage(stage: StageRecord, checkpoint: PipelineCheckpoint): Persisted;
  verifications(taskId: string): VerificationResult[];
  artifacts(taskId: string): Artifact[];
}

export interface PipelinePermissionContext {
  taskId: string;
  attemptId: string;
  runId: string;
  role: AgentRole;
  session: EngineSession;
}

export interface PipelineHooks extends Pick<EngineHooks, 'onProcessStart' | 'onProcessEnd'> {
  /** The caller persists approvals and supplies their eventual resolution. */
  onPermission?(request: EnginePermission, context: PipelinePermissionContext): void | Promise<void>;
  onStageEnd?(stage: StageRecord): void | Promise<void>;
}

export interface DevelopmentTaskOptions {
  task: Task;
  attemptId: string;
  store: PipelinePersistence;
  adapter: EngineAdapter;
  dataDir: string;
  signal?: AbortSignal;
  hooks?: PipelineHooks;
}

export interface DevelopmentTaskOutcome {
  status: 'completed' | 'waiting_human' | 'paused';
  reason?: string;
  review?: ReviewResult;
}

const now = () => new Date().toISOString();

/** Storage failures are not engine verdicts and must stop further dispatch. */
async function persist(operation: () => Persisted): Promise<void> {
  try { await operation(); }
  catch (error) {
    if (error instanceof TaskStateError && ['PAUSE_REQUESTED', 'STALE_ATTEMPT'].includes(error.code)) throw error;
    throw new EngineError('EVENT_FAILURE', 'Task execution state could not be persisted.');
  }
}

/** A fixed, local development workflow. The scheduler owns task transitions. */
export async function executeDevelopmentTask(options: DevelopmentTaskOptions): Promise<DevelopmentTaskOutcome> {
  const { task, attemptId, store, adapter, dataDir, signal, hooks } = options;
  const assertActive = (currentSignal = signal): void => {
    if (currentSignal?.aborted) throw new EngineError('ABORTED', 'Task execution was cancelled.');
    const current = store.get(task.id);
    if (!current) throw new EngineError('ENGINE_FAILED', 'Task is no longer available.');
    assertCurrentAttempt(current, attemptId);
  };
  assertActive();
  const workspace = task.workspaceId ? store.workspace(task.workspaceId) : undefined;
  if (!workspace || !task.baselineSha || !task.verificationCommands?.length) {
    throw new EngineError('ENGINE_FAILED', 'Development tasks require a registered workspace, baseline and verification commands.');
  }
  const worktree = await createTaskWorktree({ workspacePath: workspace.path, baselineSha: task.baselineSha, taskId: task.id, dataDir });
  assertActive();
  await persist(() => store.bindWorktree(task.id, attemptId, { worktreePath: worktree.worktreePath, branchName: worktree.branch }));

  const artifact = async (kind: Artifact['kind'], name: string, content: string): Promise<void> => {
    assertActive();
    await persist(() => store.addArtifact(task.id, attemptId, { kind, name, content }));
  };
  const append = async (type: string, data: Record<string, unknown>): Promise<void> => {
    assertActive();
    await persist(() => store.append(task.id, attemptId, type, data));
  };

  async function stage<T>(name: StageName, iteration: number, operation: (record: StageRecord) => Promise<T>): Promise<{ result: T; record: StageRecord }> {
    assertActive();
    const record: StageRecord = { id: randomUUID(), taskId: task.id, attemptId, name, iteration,
      status: 'running', startedAt: now(), endedAt: null };
    await persist(() => store.recordStage(record));
    try {
      const result = await operation(record);
      assertActive();
      record.status = 'completed';
      record.endedAt = now();
      return { result, record };
    } catch (error) {
      // Only the scheduler may retire this attempt, after cleanup settles.
      record.status = signal?.aborted || (error instanceof EngineError && error.code === 'ABORTED') ? 'cancelled' : 'failed';
      record.endedAt = now();
      await persist(() => store.recordStage(record));
      throw error;
    }
  }

  async function agentRun(record: StageRecord, role: AgentRole, input: string, runSignal = signal): Promise<EnginePromptResult> {
    assertActive(runSignal);
    const run: AgentRunRecord = { id: randomUUID(), taskId: task.id, attemptId, stageId: record.id, role,
      mode: role === 'developer' ? 'default' : 'plan', status: 'running', startedAt: now(), endedAt: null };
    await persist(() => store.recordAgentRun(run));
    let session: EngineSession | undefined;
    let acceptingEvents = true;
    let receivedArtifact = false;
    let cancelling: Promise<void> | undefined;
    const cancel = () => {
      if (session) cancelling ??= session.cancel().catch(() => { /* close below confirms process exit */ });
    };
    let removeAbortListener: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const abort = () => { cancel(); reject(new EngineError('ABORTED', 'Agent execution was cancelled.')); };
      runSignal?.addEventListener('abort', abort, { once: true });
      // Remove this listener after the open/prompt lifecycle, including failure.
      removeAbortListener = () => runSignal?.removeEventListener('abort', abort);
    });
    // The rejection is consumed even when abort arrives during adapter startup.
    void aborted.catch(() => {});
    const onEvent = async (event: EngineEvent): Promise<void> => {
      if (!acceptingEvents || runSignal?.aborted) return;
      assertActive(runSignal);
      if (event.type === 'artifact') {
        receivedArtifact = true;
        await artifact(event.kind, `${role} · ${record.name} ${record.iteration + 1} · ${event.title}`, event.content);
      } else {
        await append(`engine.${event.type}`, { ...event, runId: run.id, stageId: record.id, role });
      }
    };
    let result: EnginePromptResult | undefined;
    let failure: unknown;
    let failed = false;
    try {
      session = await adapter.open({ taskId: task.id, attemptId, runId: run.id, cwd: worktree.worktreePath, mode: run.mode, signal: runSignal,
        role, configSnapshot: task.configSnapshot }, {
        onEvent,
        onProcessStart: hooks?.onProcessStart,
        onProcessEnd: hooks?.onProcessEnd,
        onPermission: async (request) => {
          assertActive(runSignal);
          if (!acceptingEvents || !session || !hooks?.onPermission) {
            throw new EngineError('EVENT_FAILURE', 'A permission request cannot be handled without its active session and approval handler.');
          }
          await hooks.onPermission(request, { taskId: task.id, attemptId, runId: run.id, role, session });
        },
      });
      assertActive(runSignal);
      result = await Promise.race([session.prompt(input, runSignal), aborted]);
      assertActive(runSignal);
      if (result.stopReason !== 'end_turn' || !result.text.trim()) {
        throw new EngineError('ENGINE_FAILED', 'Agent did not produce a completed response.');
      }
      if (!receivedArtifact) await artifact('markdown', `${role} · ${record.name} ${record.iteration + 1} · Agent response`, result.text);
    } catch (error) {
      failure = error;
      failed = true;
    } finally {
      acceptingEvents = false;
      removeAbortListener();
      if (runSignal?.aborted) cancel();
      await cancelling;
      try { await session?.close(); }
      catch { failed = true; failure = new EngineError('CLEANUP_FAILED', 'Agent process exit could not be confirmed.'); }
      run.status = failed ? (runSignal?.aborted && !(failure instanceof EngineError && failure.code === 'CLEANUP_FAILED') ? 'cancelled' : 'failed') : 'completed';
      run.endedAt = now();
      await persist(() => store.recordAgentRun(run));
    }
    if (failed) throw failure instanceof EngineError ? failure : safeEngineError(failure);
    return result!;
  }

  function prompt(role: AgentRole, name: StageName, iteration: number, instruction: string, evidence: unknown = {}, requirements: TaskInstruction[] = []): string {
    return [
      `Personal Agent role: ${role}`, `Stage: ${name}`, `Iteration: ${iteration}`,
      'Operate only inside the assigned task worktree. Do not merge, push, publish, create credentials, alter authentication, or enable permission bypass.',
      'Leave changes uncommitted for the Runtime patch. Do not commit, reset, checkout, rebase, or alter Git worktrees, branches, or repository configuration.',
      instruction,
      `Task context:\n${JSON.stringify({ goal: task.goal, baselineSha: task.baselineSha, verificationCommands: task.verificationCommands, requirements, evidence }, null, 2)}`,
    ].join('\n\n');
  }

  let checkpoint: PipelineCheckpoint = structuredClone(store.get(task.id)?.checkpoint ?? { nextStage: 'analysis', iteration: 0 });
  const paused = (): DevelopmentTaskOutcome => ({ status: 'paused', reason: 'pause_requested' });
  const instructions = (): TaskInstruction[] => structuredClone(store.get(task.id)?.instructions ?? []);
  const verificationEvidence = (): VerificationResult[] => {
    const ids = checkpoint.verificationIds ?? [];
    const records = store.verifications(task.id);
    const selected = ids.map(id => records.find(record => record.id === id));
    if (ids.length !== task.verificationCommands!.length || selected.some(record => !record)) {
      throw new EngineError('ENGINE_FAILED', 'Saved verification evidence is incomplete.');
    }
    return selected as VerificationResult[];
  };
  const advance = async (next: PipelineCheckpoint, record?: StageRecord): Promise<boolean> => {
    if (signal?.aborted && record) {
      await persist(() => store.recordStage({ ...record, status: 'cancelled' }));
    }
    assertActive();
    // The visible completed stage and its resume cursor have one commit point.
    if (record) {
      try { await store.completeStage(record, next); }
      catch {
        // completeStage rolls its transaction back. Retire the visible old
        // running stage without advancing the last durable resume cursor.
        try { await store.recordStage({ ...record, status: 'failed', endedAt: now() }); }
        catch { throw new EngineError('EVENT_FAILURE', 'The failed stage could not be persisted; scheduling must stop.'); }
        throw new EngineError('ENGINE_FAILED', 'The stage checkpoint could not be committed; the stage is recorded as failed.');
      }
    } else await persist(() => store.saveCheckpoint(task.id, attemptId, next));
    checkpoint = structuredClone(next);
    // A pause requested by the end hook sees the already durable next stage.
    if (record) await hooks?.onStageEnd?.(record);
    assertActive();
    return store.get(task.id)?.pauseRequested === true;
  };
  const deliveryArtifact = async (kind: Artifact['kind'], name: string, content: string): Promise<void> => {
    // Resuming after summary must not produce duplicate delivery artifacts.
    if (!store.artifacts(task.id).some(item => item.kind === kind && item.name === name && item.content === content)) {
      await artifact(kind, name, content);
    }
  };
  const collectPatch = (): Promise<string> => collectTaskPatch({ worktreePath: worktree.worktreePath, baselineSha: task.baselineSha! });
  const patchSha256 = (patch: string): string => createHash('sha256').update(patch, 'utf8').digest('hex');
  const checkVerifiedPatch = async (record?: StageRecord, patch?: string): Promise<
    { valid: true; patch: string } | { valid: false; paused: boolean }
  > => {
    // Evidence must be recoverable before trusting its association with a patch.
    verificationEvidence();
    const currentPatch = patch ?? await collectPatch();
    assertActive();
    if (checkpoint.verifiedPatchSha256 && checkpoint.verifiedPatchSha256 === patchSha256(currentPatch)) {
      return { valid: true, patch: currentPatch };
    }
    await append('verification.invalidated', { iteration: checkpoint.iteration,
      reason: checkpoint.verifiedPatchSha256 ? 'patch_changed' : 'patch_fingerprint_missing' });
    // Human edits invalidate validation, review and outcome, not successful
    // analysis/development. Completed readonly stages remain in their history.
    const wasPaused = await advance({ nextStage: 'verification', iteration: checkpoint.iteration,
      analyses: checkpoint.analyses }, record);
    return { valid: false, paused: wasPaused };
  };

  try {
    // Persist the unfinished stage before its first side effect; takeover keeps it.
    await persist(() => store.saveCheckpoint(task.id, attemptId, checkpoint));
    for (;;) {
      assertActive();
      if (store.get(task.id)?.pauseRequested) return paused();
      const iteration = checkpoint.iteration;
      const requirements = instructions();
      if (checkpoint.nextStage === 'analysis') {
        const completed = await stage('analysis', iteration, async (record) => {
          const group = new AbortController();
          const abortGroup = () => group.abort();
          signal?.addEventListener('abort', abortGroup, { once: true });
          if (signal?.aborted) group.abort();
          try {
            const run = (role: 'planner' | 'reviewer') => agentRun(record, role,
              prompt(role, 'analysis', iteration, role === 'planner'
                ? 'Analyze the goal and baseline in plan mode. Produce a concise implementation plan and risks; do not modify files.'
                : 'Independently analyze the goal and baseline in plan mode. Identify acceptance checks, edge cases and likely defects; do not modify files.', {}, requirements), group.signal)
              .catch((error: unknown) => { group.abort(); throw error; });
            const results = await Promise.allSettled([run('planner'), run('reviewer')]);
            const failures = results.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
            if (failures.length) {
              const cause = failures.find(item => item.reason instanceof EngineError && item.reason.code === 'CLEANUP_FAILED')
                ?? failures.find(item => !(item.reason instanceof EngineError && item.reason.code === 'ABORTED')) ?? failures[0];
              throw cause.reason;
            }
            const values = results.map(item => (item as PromiseFulfilledResult<EnginePromptResult>).value.text);
            return { planner: values[0], reviewer: values[1] };
          } finally { signal?.removeEventListener('abort', abortGroup); }
        });
        if (await advance({ nextStage: 'development', iteration: 0, analyses: completed.result }, completed.record)) return paused();
        continue;
      }

      if (!checkpoint.analyses) throw new EngineError('ENGINE_FAILED', 'Saved analysis evidence is unavailable.');
      if (checkpoint.nextStage === 'development') {
        const previousResults = checkpoint.verificationIds?.length ? verificationEvidence() : [];
        const completed = await stage('development', iteration, record => agentRun(record, 'developer',
          prompt('developer', 'development', iteration,
            'Implement the requested change in this task worktree using default permission mode. Preserve unrelated files. Runtime will run the selected verification commands after you finish. Explain the files changed and any remaining concerns.',
            { analyses: checkpoint.analyses, review: checkpoint.review, verificationResults: previousResults,
              runtimeBlockers: previousResults.some(result => result.exitCode !== 0 || result.timedOut || result.cancelled)
                ? ['One or more selected Runtime verification commands failed. A model pass cannot override this result.'] : [] }, requirements)));
        if (await advance({ nextStage: 'verification', iteration, analyses: checkpoint.analyses }, completed.record)) return paused();
        continue;
      }

      if (checkpoint.nextStage === 'verification') {
        const completed = await stage('verification', iteration, async (record) => {
          const results: VerificationResult[] = [];
          for (const command of task.verificationCommands!) {
            assertActive();
            const verificationId = randomUUID();
            let executed: Awaited<ReturnType<typeof runVerification>>;
            try {
              executed = await runVerification({ worktreePath: worktree.worktreePath, command, signal,
                timeoutMs: task.configSnapshot?.settings.verificationTimeoutMs,
                context: { taskId: task.id, attemptId, runId: verificationId },
                hooks: { onProcessStart: hooks?.onProcessStart, onProcessEnd: hooks?.onProcessEnd } });
            } catch (error) {
              if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'CLEANUP_FAILED') {
                throw new EngineError('CLEANUP_FAILED', 'Verification process exit could not be confirmed.');
              }
              throw error;
            }
            const result: VerificationResult = { id: verificationId, taskId: task.id, attemptId, stageId: record.id,
              command, exitCode: executed.exitCode, stdout: executed.stdout, stderr: executed.stderr,
              timedOut: executed.timedOut, cancelled: executed.cancelled, startedAt: executed.startedAt, endedAt: executed.finishedAt };
            await persist(() => store.recordVerification(result));
            results.push(result);
            await persist(() => store.append(task.id, attemptId, 'verification.output_metadata', { verificationId: result.id,
              stdoutTruncated: executed.stdoutTruncated, stderrTruncated: executed.stderrTruncated, signal: executed.signal, durationMs: executed.durationMs }));
            if (executed.cancelled || signal?.aborted) throw new EngineError('ABORTED', 'Verification was cancelled after its process exited.');
          }
          const patch = await collectPatch();
          return { results, verifiedPatchSha256: patchSha256(patch) };
        });
        if (await advance({ nextStage: 'review', iteration, analyses: checkpoint.analyses,
          verificationIds: completed.result.results.map(result => result.id),
          verifiedPatchSha256: completed.result.verifiedPatchSha256 }, completed.record)) return paused();
        continue;
      }

      let verifiedPatch: string | undefined;
      if (['review', 'summary', 'delivery'].includes(checkpoint.nextStage)) {
        const checked = await checkVerifiedPatch();
        if (!checked.valid) {
          if (checked.paused) return paused();
          continue;
        }
        verifiedPatch = checked.patch;
      }

      if (checkpoint.nextStage === 'review') {
        const iterationResults = verificationEvidence();
        const verificationPassed = iterationResults.every(result => result.exitCode === 0 && !result.timedOut && !result.cancelled);
        let completed: { result: { review: ReviewResult; patch: string }; record: StageRecord };
        try {
          completed = await stage('review', iteration, async (record) => {
            const result = await agentRun(record, 'reviewer', prompt('reviewer', 'review', iteration,
              'Review the changed code in plan mode against the goal and the actual Runtime verification records below. Do not modify files. End your response with exactly one JSON object in a single json code fence, with exactly: {"verdict":"pass"|"rework","blockers":string[],"evidence":string[]}. Any progress commentary must come before the result and contain no other JSON objects, arrays or code fences. Do not append text after the final result. A pass requires no blockers and all selected verification commands passing. A rework requires at least one blocker. Cite file locations or actual verification records as evidence.',
              { analyses: checkpoint.analyses, verificationPassed, verificationResults: iterationResults }, requirements));
            const patch = await collectPatch();
            return { review: parseReviewResult(result.text), patch };
          });
        } catch (error) {
          if (!(error instanceof ReviewResultError)) throw error;
          const checked = await checkVerifiedPatch();
          if (!checked.valid) {
            if (checked.paused) return paused();
            continue;
          }
          await append('review.invalid', { iteration, reason: 'review_invalid' });
          if (await advance({ ...checkpoint, nextStage: 'delivery', review: undefined,
            outcome: { status: 'waiting_human', reason: 'review_invalid' } })) return paused();
          continue;
        }
        const checked = await checkVerifiedPatch(completed.record, completed.result.patch);
        if (!checked.valid) {
          if (checked.paused) return paused();
          continue;
        }
        const review = completed.result.review;
        const effectivePass = review.verdict === 'pass' && verificationPassed;
        await append('review.completed', { iteration, modelVerdict: review.verdict, effectiveVerdict: effectivePass ? 'pass' : 'rework', verificationPassed,
          blockers: review.blockers, evidence: review.evidence });
        const outcome: PipelineCheckpoint['outcome'] = effectivePass ? { status: 'completed' }
          : { status: 'waiting_human', reason: verificationPassed ? 'review_requires_human' : 'verification_failed' };
        if (!effectivePass && iteration === 0) {
          await append('task.rework_started', { iteration: 1, reason: outcome.reason });
          if (await advance({ ...checkpoint, nextStage: 'development', iteration: 1, review,
            verifiedPatchSha256: undefined, outcome: undefined }, completed.record)) return paused();
        } else if (await advance({ ...checkpoint, nextStage: 'summary', review, outcome }, completed.record)) return paused();
        continue;
      }

      if (checkpoint.nextStage === 'summary') {
        if (!checkpoint.outcome) throw new EngineError('ENGINE_FAILED', 'Saved review outcome is unavailable.');
        const patch = verifiedPatch!;
        const completed = await stage('summary', iteration, async record => {
          await agentRun(record, 'planner', prompt('planner', 'summary', iteration,
            'Summarize the delivery in plan mode: changed files, actual validation results, review blockers, and any remaining work. The Runtime outcome below is authoritative. Do not modify files, commit, merge or push.',
            { outcome: checkpoint.outcome, review: checkpoint.review, verificationResults: verificationEvidence(), patch }, requirements));
          return collectPatch();
        });
        const checked = await checkVerifiedPatch(completed.record, completed.result);
        if (!checked.valid) {
          if (checked.paused) return paused();
          continue;
        }
        if (await advance({ ...checkpoint, nextStage: 'delivery' }, completed.record)) return paused();
        continue;
      }

      if (checkpoint.nextStage === 'delivery') {
        if (!checkpoint.outcome) throw new EngineError('ENGINE_FAILED', 'Saved delivery outcome is unavailable.');
        const validations = store.verifications(task.id);
        const patch = verifiedPatch!;
        await deliveryArtifact('diff', 'Code patch', patch);
        await deliveryArtifact('json', 'Actual verification results', JSON.stringify(validations, null, 2));
        await deliveryArtifact('markdown', 'Delivery summary', [
          `# Development task ${checkpoint.outcome.status === 'completed' ? 'completed' : 'requires human review'}`,
          `Runtime outcome: ${checkpoint.outcome.status}${checkpoint.outcome.reason ? ` (${checkpoint.outcome.reason})` : ''}.`,
          `Baseline: ${task.baselineSha}`, `Task branch: ${worktree.branch}`,
          `Verified patch SHA-256: ${checkpoint.verifiedPatchSha256}`,
          `Actual verification runs: ${validations.length}.`,
          ...validations.map(result => `- ${JSON.stringify(result.command)}: exitCode=${result.exitCode}, timedOut=${result.timedOut}, cancelled=${result.cancelled}`),
          checkpoint.review ? `Review: ${JSON.stringify(checkpoint.review)}` : 'Review: invalid structured response; human action required.',
          'Code patch and actual verification records are preserved as separate artifacts. The task worktree is retained for inspection.',
        ].join('\n\n'));
        const delivered = await checkVerifiedPatch();
        if (!delivered.valid) {
          if (delivered.paused) return paused();
          continue;
        }
        return { ...checkpoint.outcome, ...(checkpoint.review ? { review: checkpoint.review } : {}) };
      }
      throw new EngineError('ENGINE_FAILED', 'Saved workflow stage is unavailable.');
    }
  } catch (error) {
    if (error instanceof TaskStateError && error.code === 'PAUSE_REQUESTED') return paused();
    throw error;
  }
}
