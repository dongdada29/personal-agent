import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCurrentAttempt, TaskStateError, type AgentRunRecord, type Artifact, type StageRecord,
  type PipelineCheckpoint, type Task, type TaskConfigurationSnapshot, type VerificationResult, type Workspace,
} from '@personal-agent/contracts';
import { EngineError, type EngineAdapter, type EngineHooks, type EngineRunContext, type EngineSession } from '../src/engine.js';
import { executeDevelopmentTask, type PipelinePersistence } from '../src/pipeline.js';
import { TaskStore } from '../src/store.js';
import { collectTaskPatch } from '../src/workspace.js';
import type { OwnedProcessRecord } from '../src/process-registry.js';

const directories: string[] = [];
const persistentStores: TaskStore[] = [];
afterEach(() => {
  for (const store of persistentStores.splice(0)) { try { store.close(); } catch { /* reopen tests close the old store */ } }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class MemoryPersistence implements PipelinePersistence {
  stages = new Map<string, StageRecord>();
  runs = new Map<string, AgentRunRecord>();
  verificationRecords: VerificationResult[] = [];
  artifactRecords: Artifact[] = [];
  events: Array<{ type: string; data: Record<string, unknown> }> = [];
  constructor(public task: Task, readonly registeredWorkspace: Workspace) {}
  get(id: string) { return id === this.task.id ? this.task : undefined; }
  workspace(id: string) { return id === this.registeredWorkspace.id ? this.registeredWorkspace : undefined; }
  private fence(taskId: string, attemptId: string) {
    expect(taskId).toBe(this.task.id);
    assertCurrentAttempt(this.task, attemptId);
  }
  append(taskId: string, attemptId: string, type: string, data: Record<string, unknown>) {
    this.fence(taskId, attemptId); this.events.push({ type, data });
  }
  addArtifact(taskId: string, attemptId: string, artifact: Pick<Artifact, 'kind' | 'name' | 'content'>) {
    this.fence(taskId, attemptId); this.artifactRecords.push({ ...artifact, id: randomUUID(), taskId, attemptId, createdAt: new Date().toISOString() });
  }
  bindWorktree(taskId: string, attemptId: string, value: { worktreePath: string; branchName: string }) {
    this.fence(taskId, attemptId); Object.assign(this.task, value);
  }
  recordStage(stage: StageRecord) {
    this.fence(stage.taskId, stage.attemptId);
    if (stage.status === 'running' && this.task.pauseRequested) throw new TaskStateError('PAUSE_REQUESTED', 'Pause requested');
    this.stages.set(stage.id, { ...stage });
  }
  saveCheckpoint(taskId: string, attemptId: string, checkpoint: PipelineCheckpoint) {
    this.fence(taskId, attemptId); this.task.checkpoint = structuredClone(checkpoint);
  }
  completeStage(stage: StageRecord, checkpoint: PipelineCheckpoint) {
    this.fence(stage.taskId, stage.attemptId);
    expect(stage.status).toBe('completed');
    this.stages.set(stage.id, { ...stage });
    this.task.checkpoint = structuredClone(checkpoint);
  }
  verifications(taskId: string) { expect(taskId).toBe(this.task.id); return this.verificationRecords; }
  artifacts(taskId: string) { expect(taskId).toBe(this.task.id); return this.artifactRecords; }
  recordAgentRun(run: AgentRunRecord) {
    this.fence(run.taskId, run.attemptId); this.runs.set(run.id, { ...run });
  }
  recordVerification(result: VerificationResult) {
    this.fence(result.taskId, result.attemptId); this.verificationRecords.push({ ...result });
  }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-pipeline-'));
  directories.push(dir);
  const repository = join(dir, 'fixture-repository');
  mkdirSync(repository);
  writeFileSync(join(repository, 'feature.txt'), 'before\n');
  execFileSync('git', ['init', '--quiet', repository]);
  execFileSync('git', ['-C', repository, 'add', 'feature.txt']);
  execFileSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Fixture baseline']);
  const baselineSha = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const attemptId = randomUUID();
  const task: Task = { id: randomUUID(), commandId: randomUUID(), goal: 'Change feature.txt to after and add details.txt',
    status: 'running', deliveryStatus: 'pending', pauseRequested: false, activeAttemptId: attemptId,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), engine: 'claude', workspaceId: 'fixture', baselineSha,
    verificationCommands: [{ command: process.execPath, args: ['-e',
      'const fs=require("node:fs");if(fs.readFileSync("feature.txt","utf8")!=="after\\n")process.exit(7);if(!fs.existsSync("details.txt"))process.exit(8);console.log("actual fixture verification passed");'] }] };
  const store = new MemoryPersistence(task, { id: 'fixture', name: 'No sensitive fixture', path: repository, createdAt: task.createdAt });
  return { dir, repository, task, attemptId, store, dataDir: join(dir, 'runtime-data') };
}

function configurationSnapshot(): TaskConfigurationSnapshot {
  const updatedAt = new Date().toISOString();
  return { settings: { defaultEngine: 'claude', agentRunTimeoutMs: 30_000, verificationTimeoutMs: 5_000, updatedAt },
    profiles: {
      planner: { id: 'planner', name: 'Fixture planner', role: 'planner', instructions: 'Planner fixture instructions', updatedAt },
      developer: { id: 'developer', name: 'Fixture developer', role: 'developer', instructions: 'Developer fixture instructions', updatedAt },
      reviewer: { id: 'reviewer', name: 'Fixture reviewer', role: 'reviewer', instructions: 'Reviewer fixture instructions', updatedAt },
    } };
}

interface MockOptions {
  develop?: (context: EngineRunContext, iteration: number) => void | Promise<void>;
  review?: string[];
  prompt?: (context: EngineRunContext, input: string, hooks: EngineHooks) => Promise<string | undefined>;
  close?: (context: EngineRunContext) => Promise<void>;
  permission?: boolean;
}

function mockAdapter(options: MockOptions = {}) {
  let active = 0, maximum = 0, reviewIndex = 0;
  const opens: Array<{ context: EngineRunContext; input?: string }> = [];
  const closes: string[] = [], cancels: string[] = [];
  const hooksByRun = new Map<string, EngineHooks>();
  const adapter: EngineAdapter = {
    probe: async () => ({ protocolReady: true, sessionReady: true, planModeSupported: true, authenticatedPrompt: 'not_checked' }),
    open: async (context, hooks) => {
      maximum = Math.max(maximum, ++active);
      const item: { context: EngineRunContext; input?: string } = { context }; opens.push(item);
      hooksByRun.set(context.runId, hooks);
      await hooks.onEvent({ type: 'mode', modeId: context.mode });
      let closed = false;
      const session: EngineSession = {
        sessionId: context.runId, processId: undefined, availableModes: ['plan', 'default'],
        async prompt(input) {
          item.input = input;
          let text = await options.prompt?.(context, input, hooks);
          const role = /^Personal Agent role: (\w+)/u.exec(input)![1];
          const stage = /\n\nStage: (\w+)/u.exec(input)![1];
          const iteration = Number(/\n\nIteration: (\d+)/u.exec(input)![1]);
          if (role === 'developer') {
            if (options.permission) await hooks.onPermission?.({ id: 'request', sessionId: context.runId, toolCallId: 'tool',
              title: 'Harmless fixture edit', options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }] });
            if (options.develop) await options.develop(context, iteration);
            else { writeFileSync(join(context.cwd, 'feature.txt'), 'after\n'); writeFileSync(join(context.cwd, 'details.txt'), 'new file\n'); }
          }
          text ??= stage === 'review'
            ? options.review?.[reviewIndex++] ?? '{"verdict":"pass","blockers":[],"evidence":["Actual Runtime verification passed"]}'
            : `${role} ${stage} fixture response`;
          await hooks.onEvent({ type: 'message', text });
          return { stopReason: 'end_turn', text, artifacts: [] };
        },
        resolvePermission: async () => {},
        cancel: async () => { cancels.push(context.runId); },
        close: async () => {
          if (closed) return;
          await options.close?.(context);
          closed = true; active--; closes.push(context.runId);
        },
      };
      return session;
    },
  };
  return { adapter, opens, closes, cancels, hooksByRun, get active() { return active; }, get maximum() { return maximum; } };
}

describe('development pipeline with independent fixture worktrees and actual verification', () => {
  it('retires a stage after atomic completion rollback while keeping the last durable cursor', async () => {
    const context = fixture();
    context.store.completeStage = () => { throw new Error('Raw checkpoint transaction failure'); };
    const engine = mockAdapter();
    await expect(executeDevelopmentTask({ ...context, adapter: engine.adapter })).rejects.toMatchObject({ code: 'ENGINE_FAILED' });
    expect(context.task.checkpoint).toEqual({ nextStage: 'analysis', iteration: 0 });
    expect([...context.store.stages.values()]).toHaveLength(1);
    expect([...context.store.stages.values()][0]).toMatchObject({ name: 'analysis', status: 'failed' });
    expect([...context.store.stages.values()][0].endedAt).not.toBeNull();
    expect(engine.active).toBe(0);
    expect(engine.opens).toHaveLength(2);
  });

  it('reports EVENT_FAILURE if a rolled back stage cannot even persist its failed retirement', async () => {
    const context = fixture();
    context.store.completeStage = () => { throw new Error('Raw checkpoint transaction failure'); };
    const recordStage = context.store.recordStage.bind(context.store);
    context.store.recordStage = record => {
      if (record.status === 'failed') throw new Error('Raw failed retirement transaction failure');
      recordStage(record);
    };
    const engine = mockAdapter();
    await expect(executeDevelopmentTask({ ...context, adapter: engine.adapter })).rejects.toMatchObject({ code: 'EVENT_FAILURE' });
    expect(context.task.checkpoint).toEqual({ nextStage: 'analysis', iteration: 0 });
    expect([...context.store.stages.values()][0].status).toBe('running');
    expect(engine.active).toBe(0);
    expect(engine.opens).toHaveLength(2);
  });

  it('forwards task configuration and ownership hooks to agents and records actual verification lifecycle context', async () => {
    const context = fixture();
    context.task.configSnapshot = configurationSnapshot();
    const starts: OwnedProcessRecord[] = [], ends: OwnedProcessRecord[] = [];
    const onProcessStart = async (record: OwnedProcessRecord) => { starts.push({ ...record }); };
    const onProcessEnd = async (record: OwnedProcessRecord) => { ends.push({ ...record }); };
    const engine = mockAdapter();
    const open = engine.adapter.open.bind(engine.adapter);
    engine.adapter.open = async (run, hooks) => {
      expect(run.role).toMatch(/planner|reviewer|developer/u);
      expect(run.configSnapshot).toEqual(context.task.configSnapshot);
      expect(hooks.onProcessStart).toBe(onProcessStart);
      expect(hooks.onProcessEnd).toBe(onProcessEnd);
      return open(run, hooks);
    };
    expect(await executeDevelopmentTask({ ...context, adapter: engine.adapter, hooks: { onProcessStart, onProcessEnd } })).toMatchObject({ status: 'completed' });
    expect(starts).toHaveLength(1); expect(ends).toHaveLength(1);
    expect(starts[0]).toMatchObject({ taskId: context.task.id, attemptId: context.attemptId,
      runId: context.store.verificationRecords[0].id, kind: 'verification', status: 'active' });
    expect(ends[0]).toEqual({ ...starts[0], status: 'closed' });
  });

  it('uses the snapshotted verification timeout and cannot deliver a model pass over timed out commands', async () => {
    const context = fixture();
    context.task.configSnapshot = configurationSnapshot();
    context.task.configSnapshot.settings.verificationTimeoutMs = 50;
    context.task.verificationCommands = [{ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }];
    expect(await executeDevelopmentTask({ ...context, adapter: mockAdapter().adapter })).toMatchObject({ status: 'waiting_human', reason: 'verification_failed' });
    expect(context.store.verificationRecords).toHaveLength(2);
    expect(context.store.verificationRecords.every(result => result.timedOut && !result.cancelled)).toBe(true);
  });

  it('fails closed when the verification process end cannot be durably acknowledged', async () => {
    const context = fixture();
    await expect(executeDevelopmentTask({ ...context, adapter: mockAdapter().adapter, hooks: {
      onProcessEnd: async () => { throw new Error('Failed lifecycle persistence'); },
    } })).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    expect(context.store.verificationRecords).toHaveLength(0);
    expect([...context.store.stages.values()].find(stage => stage.name === 'verification')?.status).toBe('failed');
  });

  it.each([
    ['analysis', 'development'], ['development', 'verification'], ['verification', 'review'],
    ['review', 'summary'], ['summary', 'delivery'],
  ] as const)('pauses after %s with a durable %s cursor and resumes without repeating completed stages', async (boundary, nextStage) => {
    const context = fixture();
    const engine = mockAdapter();
    const first = await executeDevelopmentTask({ ...context, adapter: engine.adapter, hooks: {
      onStageEnd: record => {
        expect(context.task.checkpoint).toBeDefined();
        expect(context.store.stages.get(record.id)?.status).toBe('completed');
        if (record.name === boundary) {
          expect(context.task.checkpoint?.nextStage).toBe(nextStage);
          context.task.pauseRequested = true;
        }
      },
    } });
    expect(first).toEqual({ status: 'paused', reason: 'pause_requested' });
    expect(engine.active).toBe(0);
    const completedStages = [...context.store.stages.values()].map(stage => ({ ...stage }));
    const analysisRuns = [...context.store.runs.values()].filter(run => run.stageId === completedStages.find(stage => stage.name === 'analysis')?.id);
    expect(analysisRuns).toHaveLength(2);
    const newAttempt = randomUUID();
    context.task.activeAttemptId = newAttempt;
    context.task.pauseRequested = false;
    const resumed = mockAdapter();
    expect(await executeDevelopmentTask({ ...context, attemptId: newAttempt, adapter: resumed.adapter })).toMatchObject({ status: 'completed' });
    for (const stage of completedStages) expect(context.store.stages.get(stage.id)).toEqual(stage);
    expect([...context.store.stages.values()].map(stage => stage.name)).toEqual(['analysis', 'development', 'verification', 'review', 'summary']);
    expect(resumed.opens.every(item => !item.input?.includes('Stage: analysis'))).toBe(true);
    if (boundary === 'summary') expect(resumed.opens).toHaveLength(0);
    expect(context.store.artifactRecords.filter(item => ['Code patch', 'Actual verification results', 'Delivery summary'].includes(item.name))).toHaveLength(3);
    // A delivery-only resume does not duplicate the summary or runtime artifacts.
    const deliveryAttempt = randomUUID();
    context.task.activeAttemptId = deliveryAttempt;
    const delivery = mockAdapter();
    expect(await executeDevelopmentTask({ ...context, attemptId: deliveryAttempt, adapter: delivery.adapter })).toMatchObject({ status: 'completed' });
    expect(delivery.opens).toHaveLength(0);
    expect(context.store.artifactRecords.filter(item => ['Code patch', 'Actual verification results', 'Delivery summary'].includes(item.name))).toHaveLength(3);
  });

  it.each(['verification', 'review', 'summary'] as const)('reopens SQLite after a %s pause and revalidates human edits before delivery', async boundary => {
    const context = fixture();
    const filename = join(context.dir, 'tasks.sqlite');
    const store = new TaskStore(filename); persistentStores.push(store);
    const workspace = store.registerWorkspace(context.repository, 'Disposable verification fingerprint fixture');
    const created = store.create({ commandId: randomUUID(), goal: context.task.goal, engine: 'claude', workspaceId: workspace.id,
      verificationCommands: context.task.verificationCommands! }, context.task.baselineSha).task;
    const task = store.start(created.id, 'claude');
    const initial = mockAdapter();
    expect(await executeDevelopmentTask({ ...context, task, attemptId: task.activeAttemptId!, store, adapter: initial.adapter, hooks: {
      onStageEnd: record => {
        if (record.name === boundary) store.beginControl(task.id, { commandId: randomUUID(), action: 'pause' });
      },
    } })).toMatchObject({ status: 'paused' });
    store.transition(task.id, 'paused', task.activeAttemptId!);
    const before = store.snapshot(task.id);
    expect(before.task.checkpoint?.verifiedPatchSha256).toMatch(/^[a-f0-9]{64}$/u);
    store.close();

    // An untracked file is part of the full patch and must invalidate old tests.
    writeFileSync(join(before.task.worktreePath!, 'human-addition.txt'), 'Human change after the saved test pass\n');
    const reopened = new TaskStore(filename); persistentStores.push(reopened);
    expect(reopened.require(task.id).checkpoint).toEqual(before.task.checkpoint);
    reopened.finishControl(task.id, { commandId: randomUUID(), action: 'resume' });
    const resumedTask = reopened.start(task.id, 'claude');
    const resumed = mockAdapter();
    expect(await executeDevelopmentTask({ ...context, task: resumedTask, attemptId: resumedTask.activeAttemptId!,
      store: reopened, adapter: resumed.adapter })).toMatchObject({ status: 'completed' });
    const after = reopened.snapshot(task.id);
    expect(after.verifications).toHaveLength(2);
    expect(after.verifications!.map(result => [result.attemptId, result.exitCode])).toEqual([
      [task.activeAttemptId, 0], [resumedTask.activeAttemptId, 0],
    ]);
    expect(resumed.opens.map(item => /Stage: (\w+)/u.exec(item.input!)![1])).toEqual(['review', 'summary']);
    for (const stage of before.stages!) expect(after.stages!.find(item => item.id === stage.id)).toEqual(stage);
    expect(after.task.checkpoint?.verifiedPatchSha256).not.toBe(before.task.checkpoint?.verifiedPatchSha256);
    expect(after.events.filter(event => event.type === 'verification.invalidated')).toHaveLength(1);
    expect(after.artifacts.find(item => item.name === 'Code patch')?.content).toContain('human-addition.txt');
    const patch = await collectTaskPatch({ worktreePath: after.task.worktreePath!, baselineSha: after.task.baselineSha! });
    expect(after.task.checkpoint?.verifiedPatchSha256).toBe(createHash('sha256').update(patch, 'utf8').digest('hex'));
    expect(initial.active).toBe(0); expect(resumed.active).toBe(0);
  });

  it.each(['review', 'summary', 'delivery'] as const)('reverifies a legacy %s checkpoint without a patch fingerprint', async nextStage => {
    const context = fixture();
    const initial = mockAdapter();
    const boundary = nextStage === 'review' ? 'verification' : nextStage === 'summary' ? 'review' : 'summary';
    expect(await executeDevelopmentTask({ ...context, adapter: initial.adapter, hooks: {
      onStageEnd: record => { if (record.name === boundary) context.task.pauseRequested = true; },
    } })).toMatchObject({ status: 'paused' });
    delete context.task.checkpoint!.verifiedPatchSha256;
    const newAttempt = randomUUID();
    context.task.activeAttemptId = newAttempt; context.task.pauseRequested = false;
    const resumed = mockAdapter();
    expect(await executeDevelopmentTask({ ...context, attemptId: newAttempt, adapter: resumed.adapter })).toMatchObject({ status: 'completed' });
    expect(context.store.verificationRecords).toHaveLength(2);
    expect(resumed.opens.map(item => /Stage: (\w+)/u.exec(item.input!)![1])).toEqual(['review', 'summary']);
    expect(context.store.events.find(event => event.type === 'verification.invalidated')?.data.reason).toBe('patch_fingerprint_missing');
  });

  it('cannot reuse an old passing verification after human edits break the selected actual test', async () => {
    const context = fixture();
    expect(await executeDevelopmentTask({ ...context, adapter: mockAdapter().adapter, hooks: {
      onStageEnd: record => { if (record.name === 'verification') context.task.pauseRequested = true; },
    } })).toMatchObject({ status: 'paused' });
    const oldDigest = context.task.checkpoint!.verifiedPatchSha256;
    writeFileSync(join(context.task.worktreePath!, 'feature.txt'), 'Human edit that fails the selected verification\n');
    const newAttempt = randomUUID();
    context.task.activeAttemptId = newAttempt; context.task.pauseRequested = false;
    // The already authorized single rework is allowed; this mock leaves the
    // failed human edit in place, and both model reviews still claim pass.
    const resumed = mockAdapter({ develop: () => {} });
    expect(await executeDevelopmentTask({ ...context, attemptId: newAttempt, adapter: resumed.adapter })).toMatchObject({
      status: 'waiting_human', reason: 'verification_failed',
    });
    expect(context.store.verificationRecords.map(record => record.exitCode)).toEqual([0, 7, 7]);
    expect(resumed.opens.map(item => /Stage: (\w+)/u.exec(item.input!)![1])).toEqual(['review', 'development', 'review', 'summary']);
    expect(context.task.checkpoint!.verifiedPatchSha256).not.toBe(oldDigest);
    expect(context.store.events.filter(event => event.type === 'review.completed').map(event => event.data.effectiveVerdict)).toEqual(['rework', 'rework']);
  });

  it.each(['review', 'summary'] as const)('does not reuse a pass after the readonly %s agent changes the patch', async changedStage => {
    const context = fixture();
    let changed = false;
    const engine = mockAdapter({ prompt: async (run, input) => {
      if (!changed && input.includes(`Stage: ${changedStage}`)) {
        changed = true;
        writeFileSync(join(run.cwd, 'details.txt'), 'Unexpected edit during readonly stage\n');
      }
      return undefined;
    } });
    expect(await executeDevelopmentTask({ ...context, adapter: engine.adapter })).toMatchObject({ status: 'completed' });
    expect(context.store.verificationRecords).toHaveLength(2);
    expect([...context.store.stages.values()].filter(stage => stage.name === changedStage && stage.status === 'completed')).toHaveLength(2);
    expect(engine.opens.filter(item => item.input?.includes('Stage: development'))).toHaveLength(1);
    expect(context.store.events.filter(event => event.type === 'verification.invalidated')).toHaveLength(1);
    expect(context.store.artifactRecords.find(item => item.name === 'Code patch')?.content).toContain('Unexpected edit during readonly stage');
    expect(engine.active).toBe(0);
  });

  it('reverifies changes during delivery artifact persistence instead of returning an old pass', async () => {
    const context = fixture();
    const addArtifact = context.store.addArtifact.bind(context.store);
    let edited = false;
    context.store.addArtifact = (taskId, attemptId, artifact) => {
      addArtifact(taskId, attemptId, artifact);
      if (artifact.name === 'Code patch' && !edited) {
        edited = true;
        writeFileSync(join(context.task.worktreePath!, 'details.txt'), 'Late delivery change\n');
      }
    };
    const engine = mockAdapter();
    expect(await executeDevelopmentTask({ ...context, adapter: engine.adapter })).toMatchObject({ status: 'completed' });
    expect(context.store.verificationRecords).toHaveLength(2);
    expect(engine.opens.filter(item => item.input?.includes('Stage: development'))).toHaveLength(1);
    expect(context.store.events.filter(event => event.type === 'verification.invalidated')).toHaveLength(1);
    expect(context.store.artifactRecords.filter(item => item.name === 'Code patch').at(-1)?.content).toContain('Late delivery change');
  });

  it('clears the fingerprint before automatic developer rework starts', async () => {
    const context = fixture();
    const engine = mockAdapter({ review: [
      '{"verdict":"rework","blockers":["One fixture improvement"],"evidence":["details.txt"]}',
      '{"verdict":"pass","blockers":[],"evidence":["Actual Runtime records"]}',
    ], prompt: async (_run, input) => {
      if (input.includes('Stage: development') && input.includes('Iteration: 1')) {
        expect(context.task.checkpoint?.verifiedPatchSha256).toBeUndefined();
        expect(context.task.checkpoint?.outcome).toBeUndefined();
      }
      return undefined;
    } });
    expect(await executeDevelopmentTask({ ...context, adapter: engine.adapter })).toMatchObject({ status: 'completed' });
    expect(context.store.verificationRecords).toHaveLength(2);
    expect(context.task.checkpoint?.verifiedPatchSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('shares one instruction snapshot across both analyses and applies feedback at the next stage', async () => {
    const context = fixture();
    context.task.instructions = [{ id: 'initial', commandId: 'initial', requirements: 'Initial requirement', createdAt: new Date().toISOString() }];
    const both = deferred();
    let analysisCount = 0;
    const engine = mockAdapter({ prompt: async (_run, input) => {
      if (input.includes('Stage: analysis')) {
        if (++analysisCount === 1) context.task.instructions!.push({ id: 'feedback', commandId: 'feedback', requirements: 'Late feedback requirement', createdAt: new Date().toISOString() });
        if (analysisCount === 2) both.resolve();
        await both.promise;
      }
      return undefined;
    } });
    expect(await executeDevelopmentTask({ ...context, adapter: engine.adapter })).toMatchObject({ status: 'completed' });
    const analyses = engine.opens.filter(item => item.input?.includes('Stage: analysis'));
    expect(analyses).toHaveLength(2);
    expect(analyses.every(item => item.input!.includes('Initial requirement') && !item.input!.includes('Late feedback requirement'))).toBe(true);
    expect(engine.opens.find(item => item.input?.includes('Stage: development'))?.input).toContain('Late feedback requirement');
  });

  it('honors a pause racing the next stage insert without opening the next developer', async () => {
    const context = fixture();
    const recordStage = context.store.recordStage.bind(context.store);
    context.store.recordStage = record => {
      if (record.name === 'development' && record.status === 'running') context.task.pauseRequested = true;
      recordStage(record);
    };
    const engine = mockAdapter();
    expect(await executeDevelopmentTask({ ...context, adapter: engine.adapter })).toMatchObject({ status: 'paused' });
    expect(context.task.checkpoint?.nextStage).toBe('development');
    expect(engine.opens).toHaveLength(2);
    expect([...context.store.stages.values()].map(stage => [stage.name, stage.status])).toEqual([['analysis', 'completed']]);
  });

  it('preserves a completed checkpoint when takeover arrives in the end hook', async () => {
    const context = fixture();
    const controller = new AbortController();
    const engine = mockAdapter();
    await expect(executeDevelopmentTask({ ...context, adapter: engine.adapter, signal: controller.signal, hooks: {
      onStageEnd: record => { if (record.name === 'analysis') controller.abort(); },
    } })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(context.task.checkpoint?.nextStage).toBe('development');
    expect([...context.store.stages.values()].map(stage => [stage.name, stage.status])).toEqual([['analysis', 'completed']]);
    expect(engine.active).toBe(0);
  });

  it('resumes an interrupted developer without repeating analysis and retains its partial edits', async () => {
    const context = fixture();
    const controller = new AbortController(), developerStarted = deferred();
    const engine = mockAdapter({ prompt: async (run, input) => {
      if (input.includes('Stage: development')) {
        writeFileSync(join(run.cwd, 'human-note.txt'), 'partial retained work\n');
        developerStarted.resolve();
        return new Promise<never>(() => {});
      }
      return undefined;
    } });
    const execution = executeDevelopmentTask({ ...context, adapter: engine.adapter, signal: controller.signal });
    await developerStarted.promise;
    controller.abort();
    await expect(execution).rejects.toMatchObject({ code: 'ABORTED' });
    expect(context.task.checkpoint?.nextStage).toBe('development');
    expect(context.task.checkpoint?.analyses).toBeDefined();
    const newAttempt = randomUUID();
    context.task.activeAttemptId = newAttempt;
    const resumed = mockAdapter();
    expect(await executeDevelopmentTask({ ...context, attemptId: newAttempt, adapter: resumed.adapter })).toMatchObject({ status: 'completed' });
    expect(resumed.opens.map(item => /Stage: (\w+)/u.exec(item.input!)![1])).toEqual(['development', 'review', 'summary']);
    expect(readFileSync(join(context.task.worktreePath!, 'human-note.txt'), 'utf8')).toBe('partial retained work\n');
    expect(context.store.artifactRecords.find(item => item.name === 'Code patch')?.content).toContain('human-note.txt');
    expect([...context.store.stages.values()].filter(stage => stage.name === 'analysis')).toHaveLength(1);
  });

  it('resumes cancelled verification from the verification boundary and preserves both process results', async () => {
    const context = fixture();
    context.task.verificationCommands = [{ command: process.execPath, args: ['-e',
      'if(!require("node:fs").existsSync("resume.marker"))setInterval(()=>{},1000);else console.log("resumed verification passed")'] }];
    const controller = new AbortController();
    const recordStage = context.store.recordStage.bind(context.store);
    context.store.recordStage = record => {
      recordStage(record);
      if (record.name === 'verification' && record.status === 'running') setTimeout(() => controller.abort(), 50);
    };
    await expect(executeDevelopmentTask({ ...context, adapter: mockAdapter().adapter, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(context.task.checkpoint?.nextStage).toBe('verification');
    expect(context.store.verificationRecords[0].cancelled).toBe(true);
    context.store.recordStage = recordStage;
    writeFileSync(join(context.task.worktreePath!, 'resume.marker'), 'human correction\n');
    const newAttempt = randomUUID();
    context.task.activeAttemptId = newAttempt;
    const resumed = mockAdapter();
    expect(await executeDevelopmentTask({ ...context, attemptId: newAttempt, adapter: resumed.adapter })).toMatchObject({ status: 'completed' });
    expect(resumed.opens.map(item => /Stage: (\w+)/u.exec(item.input!)![1])).toEqual(['review', 'summary']);
    expect(context.store.verificationRecords.map(record => [record.cancelled, record.exitCode])).toEqual([[true, null], [false, 0]]);
    expect(context.store.artifactRecords.find(item => item.name === 'Actual verification results')?.content).toContain('resumed verification passed');
    expect(context.store.verificationRecords[0].attemptId).not.toBe(context.store.verificationRecords[1].attemptId);
  });

  it('stops before model review if checkpoint verification records cannot be recovered', async () => {
    const context = fixture();
    context.task.checkpoint = { nextStage: 'review', iteration: 0, analyses: { planner: 'Saved plan', reviewer: 'Saved checks' }, verificationIds: ['missing'] };
    const engine = mockAdapter();
    await expect(executeDevelopmentTask({ ...context, adapter: engine.adapter })).rejects.toMatchObject({ code: 'ENGINE_FAILED' });
    expect(engine.opens).toHaveLength(0);
  });

  it('runs both analyses concurrently, caps sessions at two, preserves user WIP and delivers a patch including new files', async () => {
    const context = fixture();
    writeFileSync(join(context.repository, 'feature.txt'), 'uncommitted user WIP\n');
    const bothAnalysisPrompts = deferred();
    let analysisCount = 0;
    const engine = mockAdapter({ prompt: async (_context, input) => {
      if (input.includes('Stage: analysis')) {
        if (++analysisCount === 2) bothAnalysisPrompts.resolve();
        await bothAnalysisPrompts.promise;
      }
      return undefined;
    } });
    const result = await executeDevelopmentTask({ ...context, adapter: engine.adapter });
    expect(result.status).toBe('completed');
    expect(engine.maximum).toBe(2);
    expect(engine.active).toBe(0);
    expect(engine.opens.map(item => item.context.mode)).toEqual(['plan', 'plan', 'default', 'plan', 'plan']);
    expect(context.store.stages.size).toBe(5);
    expect([...context.store.stages.values()].every(stage => stage.status === 'completed')).toBe(true);
    expect([...context.store.runs.values()].every(run => run.status === 'completed')).toBe(true);
    expect(readFileSync(join(context.repository, 'feature.txt'), 'utf8')).toBe('uncommitted user WIP\n');
    expect(context.store.verificationRecords).toHaveLength(1);
    expect(context.store.verificationRecords[0]).toMatchObject({ exitCode: 0, stdout: 'actual fixture verification passed\n', timedOut: false, cancelled: false });
    const patch = context.store.artifactRecords.find(artifact => artifact.kind === 'diff')!.content;
    expect(patch).toContain('+after'); expect(patch).toContain('details.txt'); expect(patch).toContain('+new file');
    expect(patch).not.toContain('uncommitted user WIP');
    expect(context.store.artifactRecords.filter(artifact => artifact.name.endsWith('Agent response'))).toHaveLength(5);
    expect(context.store.artifactRecords.find(artifact => artifact.name === 'Actual verification results')?.content).toContain('actual fixture verification passed');
  });

  it('runs selected commands sequentially and records actual command failure even when the model claims pass', async () => {
    const context = fixture();
    context.task.verificationCommands!.push({ command: process.execPath, args: ['-e', 'process.stdout.write("second selected command");process.exit(12)'] });
    const engine = mockAdapter();
    const result = await executeDevelopmentTask({ ...context, adapter: engine.adapter });
    expect(result).toMatchObject({ status: 'waiting_human', reason: 'verification_failed' });
    expect(context.store.verificationRecords.map(item => item.exitCode)).toEqual([0, 12, 0, 12]);
    for (let index = 1; index < context.store.verificationRecords.length; index++) {
      expect(Date.parse(context.store.verificationRecords[index].startedAt)).toBeGreaterThanOrEqual(Date.parse(context.store.verificationRecords[index - 1].endedAt));
    }
    expect(engine.opens.filter(item => item.input?.startsWith('Personal Agent role: developer'))).toHaveLength(2);
    expect(context.store.events.filter(item => item.type === 'task.rework_started')).toHaveLength(1);
    expect(context.store.events.filter(item => item.type === 'review.completed').map(item => item.data.effectiveVerdict)).toEqual(['rework', 'rework']);
    expect(context.store.artifactRecords.find(artifact => artifact.name === 'Delivery summary')?.content).toContain('exitCode=12');
  });

  it('performs exactly one automatic rework and succeeds only after actual verification passes', async () => {
    const context = fixture();
    const engine = mockAdapter({ develop: (run, iteration) => {
      writeFileSync(join(run.cwd, 'feature.txt'), iteration === 0 ? 'broken\n' : 'after\n');
      writeFileSync(join(run.cwd, 'details.txt'), 'new file\n');
    } });
    const result = await executeDevelopmentTask({ ...context, adapter: engine.adapter });
    expect(result.status).toBe('completed');
    expect(context.store.verificationRecords.map(item => item.exitCode)).toEqual([7, 0]);
    expect(context.store.events.filter(item => item.type === 'review.completed').map(item => item.data.effectiveVerdict)).toEqual(['rework', 'pass']);
    expect([...context.store.stages.values()].filter(stage => stage.name === 'development').map(stage => stage.iteration)).toEqual([0, 1]);
    expect(engine.opens.find(item => item.input?.includes('Stage: development') && item.input.includes('Iteration: 1'))?.input).toContain('A model pass cannot override');
  });

  it('honors structured rework even when tests pass and waits for a human after the second review rejects', async () => {
    const context = fixture();
    const engine = mockAdapter({ review: [
      '{"verdict":"rework","blockers":["Missing goal edge case"],"evidence":["feature.txt:1"]}',
      '{"verdict":"rework","blockers":["Still missing edge case"],"evidence":["feature.txt:1"]}',
    ] });
    const result = await executeDevelopmentTask({ ...context, adapter: engine.adapter });
    expect(result).toMatchObject({ status: 'waiting_human', reason: 'review_requires_human' });
    expect(context.store.verificationRecords.map(item => item.exitCode)).toEqual([0, 0]);
    expect(engine.opens.filter(item => item.input?.includes('Stage: development'))).toHaveLength(2);
    expect(context.store.artifactRecords.find(artifact => artifact.name === 'Delivery summary')?.content).toContain('Still missing edge case');
  });

  it('retains malformed review evidence, enters waiting_human and does not automatically rework or reinterpret prose', async () => {
    const context = fixture();
    const engine = mockAdapter({ review: ['Everything looks good!'] });
    const result = await executeDevelopmentTask({ ...context, adapter: engine.adapter });
    expect(result).toEqual({ status: 'waiting_human', reason: 'review_invalid' });
    expect(context.store.events.some(item => item.type === 'review.invalid')).toBe(true);
    expect([...context.store.stages.values()].find(stage => stage.name === 'review')?.status).toBe('failed');
    expect(engine.opens.filter(item => item.input?.includes('Stage: development'))).toHaveLength(1);
    expect(engine.opens.filter(item => item.input?.includes('Stage: summary'))).toHaveLength(0);
    expect(context.store.artifactRecords.some(artifact => artifact.content === 'Everything looks good!')).toBe(true);
    expect(context.store.artifactRecords.some(artifact => artifact.name === 'Code patch')).toBe(true);
    expect(context.store.artifactRecords.some(artifact => artifact.name === 'Actual verification results')).toBe(true);
  });

  it('does not present a previous valid review as the verdict when the rework review is malformed', async () => {
    const context = fixture();
    const engine = mockAdapter({ review: [
      '{"verdict":"rework","blockers":["Previous blocker"],"evidence":["feature.txt:1"]}',
      'Second review is malformed',
    ] });
    expect(await executeDevelopmentTask({ ...context, adapter: engine.adapter })).toEqual({ status: 'waiting_human', reason: 'review_invalid' });
    const delivery = context.store.artifactRecords.find(artifact => artifact.name === 'Delivery summary')!.content;
    expect(delivery).toContain('invalid structured response');
    expect(delivery).not.toContain('Previous blocker');
    expect(context.store.artifactRecords.some(artifact => artifact.content === 'Second review is malformed')).toBe(true);
  });

  it('cancels the peer after an analysis failure and waits for confirmed peer close before rejecting', async () => {
    const context = fixture();
    const both = deferred(), cleanup = deferred(), peerClosing = deferred();
    let analyses = 0;
    const engine = mockAdapter({ prompt: async (_run, input) => {
      if (input.includes('Stage: analysis')) {
        if (++analyses === 2) both.resolve();
        await both.promise;
        if (input.startsWith('Personal Agent role: planner')) throw new EngineError('ENGINE_FAILED', 'Controlled failure');
        return new Promise<never>(() => {});
      }
      return undefined;
    }, close: async (run) => {
      if (engine.opens.find(item => item.context.runId === run.runId)?.input?.startsWith('Personal Agent role: reviewer')) {
        peerClosing.resolve(); await cleanup.promise;
      }
    } });
    let settled = false;
    const execution = executeDevelopmentTask({ ...context, adapter: engine.adapter });
    const observed = execution.then(() => { settled = true; }, () => { settled = true; });
    await peerClosing.promise;
    expect(settled).toBe(false);
    expect(engine.cancels).toHaveLength(1);
    cleanup.resolve();
    await expect(execution).rejects.toMatchObject({ code: 'ENGINE_FAILED' });
    await observed;
    expect(engine.active).toBe(0);
    expect(engine.opens).toHaveLength(2);
    expect([...context.store.stages.values()][0].status).toBe('failed');
  });

  it('returns CLEANUP_FAILED rather than a terminal outcome when process exit is unconfirmed', async () => {
    const context = fixture();
    const engine = mockAdapter({ close: async () => { throw new Error('raw sensitive cleanup details'); } });
    await expect(executeDevelopmentTask({ ...context, adapter: engine.adapter })).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    expect(engine.opens).toHaveLength(2);
    expect(JSON.stringify(context.store.events)).not.toContain('raw sensitive');
    expect([...context.store.runs.values()].every(run => run.status === 'failed')).toBe(true);
  });

  it('propagates peer cancellation through adapter startup and waits for its cleanup before the analysis failure settles', async () => {
    const context = fixture();
    const startup = deferred(), startupAborted = deferred(), cleanup = deferred();
    const engine = mockAdapter({ prompt: async () => { await startup.promise; throw new EngineError('ENGINE_FAILED', 'Planner failed'); } });
    const firstOpen = engine.adapter.open.bind(engine.adapter);
    let opens = 0, settled = false, startupCleaned = false;
    engine.adapter.open = async (run, hooks) => {
      if (++opens === 1) return firstOpen(run, hooks);
      expect(run.signal).toBeDefined();
      startup.resolve();
      await new Promise<void>(resolve => run.signal!.addEventListener('abort', () => { startupAborted.resolve(); resolve(); }, { once: true }));
      await cleanup.promise;
      startupCleaned = true;
      throw new EngineError('ABORTED', 'Startup cancelled after process cleanup');
    };
    const execution = executeDevelopmentTask({ ...context, adapter: engine.adapter });
    const observed = execution.then(() => { settled = true; }, () => { settled = true; });
    await startupAborted.promise;
    expect(settled).toBe(false);
    expect(startupCleaned).toBe(false);
    cleanup.resolve();
    await expect(execution).rejects.toMatchObject({ code: 'ENGINE_FAILED' });
    await observed;
    expect(startupCleaned).toBe(true);
    expect(engine.active).toBe(0);
    expect([...context.store.runs.values()].find(run => run.role === 'reviewer')?.status).toBe('cancelled');
  });

  it('cancels all analysis sessions even if their mock prompts ignore AbortSignal, then fences late events', async () => {
    const context = fixture();
    const controller = new AbortController(), both = deferred();
    let count = 0;
    const engine = mockAdapter({ prompt: async () => {
      if (++count === 2) both.resolve();
      return new Promise<never>(() => {});
    } });
    const execution = executeDevelopmentTask({ ...context, adapter: engine.adapter, signal: controller.signal });
    await both.promise;
    controller.abort();
    await expect(execution).rejects.toMatchObject({ code: 'ABORTED' });
    expect(engine.active).toBe(0);
    expect(engine.cancels).toHaveLength(2);
    expect([...context.store.runs.values()].every(run => run.status === 'cancelled')).toBe(true);
    const eventCount = context.store.events.length;
    context.task.activeAttemptId = randomUUID();
    for (const hooks of engine.hooksByRun.values()) await hooks.onEvent({ type: 'message', text: 'late old attempt' });
    expect(context.store.events).toHaveLength(eventCount);
  });

  it('cancels a real verification process and persists its cancelled evidence before rejecting', async () => {
    const context = fixture();
    context.task.verificationCommands = [{ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }];
    const controller = new AbortController();
    const engine = mockAdapter();
    let cancelled = false;
    const recordStage = context.store.recordStage.bind(context.store);
    context.store.recordStage = (stage) => {
      recordStage(stage);
      if (stage.name === 'verification' && stage.status === 'running' && !cancelled) {
        cancelled = true; setTimeout(() => controller.abort(), 50);
      }
    };
    await expect(executeDevelopmentTask({ ...context, adapter: engine.adapter, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(context.store.verificationRecords).toHaveLength(1);
    expect(context.store.verificationRecords[0].cancelled).toBe(true);
    expect([...context.store.stages.values()].find(stage => stage.name === 'verification')?.status).toBe('cancelled');
    expect(engine.active).toBe(0);
    expect(engine.opens).toHaveLength(3);
  });

  it('delegates engine permissions to the supplied hook with the current session without granting options itself', async () => {
    const context = fixture();
    const engine = mockAdapter({ permission: true });
    const permissions: Array<{ role: string; runId: string; sessionId: string }> = [];
    await executeDevelopmentTask({ ...context, adapter: engine.adapter, hooks: {
      onPermission: async (request, permissionContext) => {
        permissions.push({ role: permissionContext.role, runId: permissionContext.runId, sessionId: permissionContext.session.sessionId });
        expect(request.id).toBe('request');
      },
    } });
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toEqual({ role: 'developer', runId: permissions[0].sessionId, sessionId: permissions[0].sessionId });
  });

  it('fails safely and closes the developer when no persisted approval handler is supplied', async () => {
    const context = fixture();
    const engine = mockAdapter({ permission: true });
    await expect(executeDevelopmentTask({ ...context, adapter: engine.adapter })).rejects.toMatchObject({ code: 'EVENT_FAILURE' });
    expect(engine.active).toBe(0);
    expect(engine.opens).toHaveLength(3);
    expect(context.store.verificationRecords).toHaveLength(0);
    expect([...context.store.runs.values()].find(run => run.role === 'developer')?.status).toBe('failed');
  });

  it('retries with a new attempt in the retained worktree while preserving the previous attempt records', async () => {
    const context = fixture();
    const firstEngine = mockAdapter({ review: ['Invalid first review'] });
    expect(await executeDevelopmentTask({ ...context, adapter: firstEngine.adapter })).toMatchObject({ status: 'waiting_human' });
    const firstWorktree = context.task.worktreePath;
    const priorRuns = [...context.store.runs.values()].map(run => ({ ...run }));
    const priorStages = [...context.store.stages.values()].map(stage => ({ ...stage }));
    const newAttempt = randomUUID();
    context.task.activeAttemptId = newAttempt;
    context.task.checkpoint = { nextStage: 'development', iteration: 0, analyses: context.task.checkpoint!.analyses };
    const retryEngine = mockAdapter();
    expect(await executeDevelopmentTask({ ...context, attemptId: newAttempt, adapter: retryEngine.adapter })).toMatchObject({ status: 'completed' });
    expect(context.task.worktreePath).toBe(firstWorktree);
    for (const run of priorRuns) expect(context.store.runs.get(run.id)).toEqual(run);
    for (const stage of priorStages) expect(context.store.stages.get(stage.id)).toEqual(stage);
    expect(context.store.verificationRecords.map(result => result.attemptId)).toEqual([context.attemptId, newAttempt]);
    expect(context.store.artifactRecords.some(artifact => artifact.content === 'Invalid first review')).toBe(true);
    expect(retryEngine.opens.every(item => item.context.attemptId === newAttempt && item.context.cwd === firstWorktree)).toBe(true);
  });

  it('rejects an old attempt before worktree creation or any engine invocation', async () => {
    const context = fixture();
    const engine = mockAdapter();
    await expect(executeDevelopmentTask({ ...context, attemptId: 'stale', adapter: engine.adapter })).rejects.toMatchObject({ code: 'STALE_ATTEMPT' });
    expect(engine.opens).toHaveLength(0);
    expect(context.store.stages.size).toBe(0);
    expect(context.task.worktreePath).toBeUndefined();
  });
});
