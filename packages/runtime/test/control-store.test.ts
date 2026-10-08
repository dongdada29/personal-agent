import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunRecord, ApprovalRecord, PipelineCheckpoint, StageRecord, TaskControlCommand } from '@personal-agent/contracts';
import { TaskStore } from '../src/store.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const stores: TaskStore[] = [];
const directories: string[] = [];
const timestamp = '2026-10-02T00:00:00.000Z';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'personal-agent-control-store-'));
  directories.push(directory);
  const filename = join(directory, 'tasks.sqlite');
  const store = new TaskStore(filename); stores.push(store);
  const task = store.create({ commandId: 'create-task', goal: 'Safe local test task' }).task;
  return { store, filename, task };
}

function activeStage(store: TaskStore, taskId: string) {
  const task = store.start(taskId);
  const stage: StageRecord = { id: 'stage-analysis', taskId, attemptId: task.activeAttemptId!, name: 'analysis',
    iteration: 0, status: 'running', startedAt: timestamp, endedAt: null };
  store.recordStage(stage);
  return { task, stage };
}

function pendingApproval(store: TaskStore, stage: StageRecord): ApprovalRecord {
  const run: AgentRunRecord = { id: 'run-developer', taskId: stage.taskId, attemptId: stage.attemptId,
    stageId: stage.id, role: 'developer', mode: 'default', status: 'running', startedAt: timestamp, endedAt: null };
  store.recordAgentRun(run);
  const approval: ApprovalRecord = { id: 'fixture-edit', taskId: stage.taskId, attemptId: stage.attemptId,
    runId: run.id, title: 'Edit only this test fixture', options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny once', kind: 'reject_once' },
    ], status: 'pending', createdAt: timestamp, resolvedAt: null, selectedOptionId: null };
  store.addApproval(approval);
  return approval;
}

afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* a reopen test already closed it */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('persistent controls and stage checkpoints', () => {
  it('commits completion and checkpoint before publishing either event', () => {
    const { store, task } = fixture();
    const { stage } = activeStage(store, task.id);
    const observed: Array<{ type: string; stageStatus: unknown; nextStage: unknown }> = [];
    store.subscribe(event => {
      if (!['stage.updated', 'pipeline.checkpoint'].includes(event.type)) return;
      const snapshot = store.snapshot(task.id);
      const db = new DatabaseSync(store.filename);
      const row = db.prepare('SELECT payload_json FROM stages WHERE id=?').get(stage.id);
      db.close();
      observed.push({ type: event.type, stageStatus: JSON.parse(String(row?.payload_json)).status,
        nextStage: snapshot.task.checkpoint?.nextStage });
    });
    const checkpoint: PipelineCheckpoint = { nextStage: 'development', iteration: 0,
      analyses: { planner: 'plan retained', reviewer: 'checks retained' } };
    store.completeStage({ ...stage, status: 'completed', endedAt: timestamp }, checkpoint);
    expect(observed).toEqual([
      { type: 'stage.updated', stageStatus: 'completed', nextStage: 'development' },
      { type: 'pipeline.checkpoint', stageStatus: 'completed', nextStage: 'development' },
    ]);
    expect(store.require(task.id).checkpoint).toEqual(checkpoint);
  });

  it('rolls back stage, checkpoint and observer delivery when the checkpoint event fails', () => {
    const { store, filename, task } = fixture();
    const { stage } = activeStage(store, task.id);
    const before = store.snapshot(task.id);
    const published: unknown[] = [];
    store.subscribe(event => published.push(event));
    const db = new DatabaseSync(filename);
    try {
      db.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON task_events WHEN NEW.type='pipeline.checkpoint' BEGIN SELECT RAISE(ABORT,'checkpoint failure'); END;");
      expect(() => store.completeStage({ ...stage, status: 'completed', endedAt: timestamp },
        { nextStage: 'development', iteration: 0 })).toThrow('checkpoint failure');
      expect(store.snapshot(task.id)).toEqual(before);
      expect(JSON.parse(String(db.prepare('SELECT payload_json FROM stages WHERE id=?').get(stage.id)?.payload_json)).status).toBe('running');
      expect(published).toEqual([]);
    } finally { db.close(); }
  });

  it('isolates observer failures and preserves increasing delivery under reentrant writes', () => {
    const { store, task } = fixture();
    const running = store.start(task.id);
    const delivered: number[] = [];
    store.subscribe(() => { throw new Error('disconnected browser'); });
    let wrote = false;
    store.subscribe(event => {
      if (!wrote && event.type === 'first') { wrote = true; store.append(task.id, running.activeAttemptId!, 'second', {}); }
    });
    store.subscribe(event => delivered.push(event.seq));
    expect(() => store.append(task.id, running.activeAttemptId!, 'first', {})).not.toThrow();
    expect(store.events(task.id).slice(-2).map(event => event.type)).toEqual(['first', 'second']);
    expect(delivered).toEqual(store.events(task.id).slice(-2).map(event => event.seq));
    expect(new Set(delivered).size).toBe(2);
  });

  it('persists a boundary pause without retiring the current attempt or entering another stage', () => {
    const { store, task } = fixture();
    const { task: running, stage } = activeStage(store, task.id);
    const command: TaskControlCommand = { commandId: 'pause-boundary', action: 'pause' };
    const requested = store.beginControl(task.id, command);
    expect(requested).toMatchObject({ status: 'running', pauseRequested: true, activeAttemptId: running.activeAttemptId });
    store.completeStage({ ...stage, status: 'completed', endedAt: timestamp }, { nextStage: 'development', iteration: 0 });
    expect(() => store.recordStage({ ...stage, id: 'next-stage', name: 'development' })).toThrow(expect.objectContaining({ code: 'PAUSE_REQUESTED' }));
    expect(store.finishControl(task.id, command).task.pauseRequested).toBe(true);
    const paused = store.transition(task.id, 'paused', running.activeAttemptId!);
    expect(paused).toMatchObject({ status: 'paused', pauseRequested: false, activeAttemptId: null,
      checkpoint: { nextStage: 'development' } });
  });

  it('stores feedback once and returns its original command result after task progress', () => {
    const { store, task } = fixture();
    const command: TaskControlCommand = { commandId: 'feedback-once', action: 'feedback', requirements: 'Keep the public signature stable.' };
    const first = store.finishControl(task.id, command);
    const afterFeedback = store.snapshot(task.id);
    store.start(task.id);
    const progressed = store.snapshot(task.id);
    expect(store.finishControl(task.id, command)).toEqual({ task: first.task, created: false });
    expect(store.snapshot(task.id)).toEqual(progressed);
    expect(afterFeedback.task.instructions).toHaveLength(1);
    expect(afterFeedback.events.filter(event => event.type === 'task.instruction_added')).toHaveLength(1);
    expect(() => store.finishControl(task.id, { ...command, requirements: 'A different instruction' })).toThrow(expect.objectContaining({ code: 'COMMAND_CONFLICT' }));
    expect(() => store.finishControl(task.id, { commandId: command.commandId, action: 'cancel' })).toThrow(expect.objectContaining({ code: 'COMMAND_CONFLICT' }));
  });

  it('retains a pending takeover and its instruction across restart without duplicating either', () => {
    const { store, filename, task } = fixture();
    const { stage } = activeStage(store, task.id);
    const checkpoint: PipelineCheckpoint = { nextStage: 'development', iteration: 0,
      analyses: { planner: 'finished plan', reviewer: 'finished checks' } };
    store.saveCheckpoint(task.id, stage.attemptId, checkpoint);
    const command: TaskControlCommand = { commandId: 'pending-takeover', action: 'takeover', requirements: 'Handle blank input too.' };
    store.beginControl(task.id, command);
    const persisted = store.snapshot(task.id);
    expect(store.replayControl(task.id, command)).toBeUndefined();
    expect(store.beginControl(task.id, command)).toEqual(persisted.task);
    expect(store.snapshot(task.id)).toEqual(persisted);
    store.close();
    const reopened = new TaskStore(filename); stores.push(reopened);
    reopened.interruptActive();
    expect(reopened.require(task.id).status).toBe('interrupted');
    const finished = reopened.finishControl(task.id, command);
    expect(finished.task).toMatchObject({ status: 'paused', activeAttemptId: null, checkpoint });
    expect(finished.task.instructions).toHaveLength(1);
    expect(reopened.finishControl(task.id, command)).toEqual({ task: finished.task, created: false });
    reopened.finishControl(task.id, { commandId: 'explicit-resume', action: 'resume' });
    const resumed = reopened.start(task.id);
    expect(resumed.activeAttemptId).not.toBe(stage.attemptId);
    expect(resumed.checkpoint).toEqual(checkpoint);
    expect(reopened.require(task.id).instructions).toHaveLength(1);
  });

  it('rolls back instruction and stop intent when recording the command fails', () => {
    const { store, filename, task } = fixture();
    store.start(task.id);
    const before = store.snapshot(task.id);
    const db = new DatabaseSync(filename);
    try {
      db.exec("CREATE TRIGGER fail_control BEFORE INSERT ON task_events WHEN NEW.type='task.control_requested' BEGIN SELECT RAISE(ABORT,'control failure'); END;");
      expect(() => store.beginControl(task.id, { commandId: 'atomic-takeover', action: 'takeover', requirements: 'Safe test instruction' })).toThrow('control failure');
      expect(store.snapshot(task.id)).toEqual(before);
      expect(db.prepare('SELECT COUNT(*) AS count FROM command_intents').get()?.count).toBe(0);
    } finally { db.close(); }
  });

  it('expires an old approval on takeover and fences all old-attempt callbacks after resume', () => {
    const { store, task } = fixture();
    const { stage } = activeStage(store, task.id);
    const approval = pendingApproval(store, stage);
    store.finishControl(task.id, { commandId: 'takeover-approval', action: 'takeover' });
    expect(store.approval(approval.id)).toMatchObject({ status: 'expired', selectedOptionId: null });
    store.finishControl(task.id, { commandId: 'resume-approval', action: 'resume' });
    const fresh = store.start(task.id);
    const before = store.snapshot(task.id);
    expect(fresh.activeAttemptId).not.toBe(stage.attemptId);
    const staleCallbacks = [
      () => store.append(task.id, stage.attemptId, 'late', {}),
      () => store.addArtifact(task.id, stage.attemptId, { kind: 'text', name: 'Late', content: 'old' }),
      () => store.recordStage({ ...stage, status: 'completed', endedAt: timestamp }),
      () => store.completeStage({ ...stage, status: 'completed', endedAt: timestamp }, { nextStage: 'summary', iteration: 0 }),
      () => store.resolveApproval(approval.id, 'late-approval', 'allow'),
    ];
    for (const callback of staleCallbacks) expect(callback).toThrow(expect.objectContaining({ code: 'STALE_ATTEMPT' }));
    expect(store.snapshot(task.id)).toEqual(before);
  });

  it('does not retry through a pending approval and keeps the task unchanged', () => {
    const { store, task } = fixture();
    const { stage } = activeStage(store, task.id);
    pendingApproval(store, stage);
    const before = store.snapshot(task.id);
    expect(() => store.finishControl(task.id, { commandId: 'retry-pending', action: 'retry' })).toThrow(expect.objectContaining({ code: 'INVALID_TASK_TRANSITION' }));
    expect(store.snapshot(task.id)).toEqual(before);
  });

  it('accepts only a pending completed delivery and never starts another attempt', () => {
    const { store, task } = fixture();
    const running = store.start(task.id);
    store.addArtifact(task.id, running.activeAttemptId!, { kind: 'diff', name: 'Result', content: 'safe fixture patch' });
    store.transition(task.id, 'completed', running.activeAttemptId!);
    const command: TaskControlCommand = { commandId: 'accept-delivery', action: 'accept' };
    const accepted = store.finishControl(task.id, command);
    expect(accepted.task).toMatchObject({ status: 'completed', deliveryStatus: 'accepted', activeAttemptId: null });
    expect(store.artifacts(task.id)).toHaveLength(1);
    expect(store.finishControl(task.id, command)).toEqual({ task: accepted.task, created: false });
    expect(() => store.finishControl(task.id, { commandId: 'accept-twice', action: 'accept' })).toThrow();
    expect(() => store.finishControl(task.id, { commandId: 'return-accepted', action: 'return', requirements: 'Another edit' })).toThrow();
    expect(store.events(task.id).filter(event => event.type === 'delivery.accepted')).toHaveLength(1);
  });

  it('returns delivery from development while retaining prior evidence and worktree', () => {
    const { store, task } = fixture();
    const running = store.start(task.id);
    store.bindWorktree(task.id, running.activeAttemptId!, { worktreePath: '/safe/test/worktree', branchName: 'test-branch' });
    store.saveCheckpoint(task.id, running.activeAttemptId!, { nextStage: 'delivery', iteration: 1,
      analyses: { planner: 'original plan', reviewer: 'original checks' }, review: { verdict: 'pass', blockers: [], evidence: ['fixture'] } });
    const oldArtifact = store.addArtifact(task.id, running.activeAttemptId!, { kind: 'text', name: 'Prior result', content: 'retained' });
    store.transition(task.id, 'completed', running.activeAttemptId!);
    const returned = store.finishControl(task.id, { commandId: 'return-delivery', action: 'return', requirements: 'Cover empty names.' }).task;
    expect(returned).toMatchObject({ status: 'queued', activeAttemptId: null, worktreePath: '/safe/test/worktree', branchName: 'test-branch',
      checkpoint: { nextStage: 'development', iteration: 0, analyses: { planner: 'original plan', reviewer: 'original checks' } } });
    expect(returned.checkpoint?.review).toBeUndefined();
    expect(returned.instructions?.at(-1)?.requirements).toBe('Cover empty names.');
    expect(store.artifacts(task.id)).toEqual([oldArtifact]);
    const fresh = store.start(task.id);
    expect(fresh.activeAttemptId).not.toBe(running.activeAttemptId);
    expect(store.events(task.id).filter(event => event.type === 'delivery.returned')).toHaveLength(1);
  });

  it.each(['feedback', 'return'] as const)('rejects empty %s requirements without side effects', action => {
    const { store, task } = fixture();
    if (action === 'return') {
      const running = store.start(task.id); store.transition(task.id, 'completed', running.activeAttemptId!);
    }
    const before = store.snapshot(task.id);
    expect(() => store.finishControl(task.id, { commandId: 'empty-requirements', action, requirements: ' \n ' })).toThrow();
    expect(store.snapshot(task.id)).toEqual(before);
  });
});

describe('configuration snapshots and shared command namespace', () => {
  it('retains selected profiles and settings despite later configuration edits and caller mutation', () => {
    const { store, task } = fixture();
    const original = structuredClone(task.configSnapshot);
    store.updateSettings({ commandId: 'new-settings', agentRunTimeoutMs: 60_000, verificationTimeoutMs: 30_000 });
    store.saveProfile({ commandId: 'rename-planner', name: 'Renamed planner', instructions: 'New planning guidance' }, 'default-planner');
    const next = store.create({ commandId: 'new-task', goal: 'Next safe test' }).task;
    expect(next.configSnapshot?.settings.agentRunTimeoutMs).toBe(60_000);
    expect(next.configSnapshot?.profiles.planner.instructions).toBe('New planning guidance');
    expect(store.require(task.id).configSnapshot).toEqual(original);
    task.configSnapshot!.profiles.planner.name = 'mutated by caller';
    const fetched = store.require(task.id); fetched.configSnapshot!.settings.agentRunTimeoutMs = 1;
    expect(store.require(task.id).configSnapshot).toEqual(original);
  });

  it('rejects a selected profile for the wrong role without creating a task or command', () => {
    const { store } = fixture();
    const count = store.list().length;
    expect(() => store.create({ commandId: 'wrong-role', goal: 'A task', profileIds: { planner: 'default-developer' } }))
      .toThrow(expect.objectContaining({ code: 'PROFILE_ROLE_MISMATCH' }));
    expect(store.list()).toHaveLength(count);
    expect(store.replayCreation({ commandId: 'wrong-role', goal: 'A task', profileIds: { planner: 'default-developer' } })).toBeUndefined();
  });

  it('replays original profile and settings results after newer updates and reopen', () => {
    const { store, filename } = fixture();
    const settingsCommand = { commandId: 'settings-original', agentRunTimeoutMs: 120_000 };
    const firstSettings = store.updateSettings(settingsCommand);
    const profileCommand = { commandId: 'profile-original', name: 'Fixture developer', role: 'developer' as const, instructions: 'Initial guidance' };
    const firstProfile = store.saveProfile(profileCommand);
    store.updateSettings({ commandId: 'settings-later', agentRunTimeoutMs: 240_000 });
    store.saveProfile({ commandId: 'profile-later', instructions: 'Later guidance' }, firstProfile.id);
    store.close();
    const reopened = new TaskStore(filename); stores.push(reopened);
    expect(reopened.updateSettings(settingsCommand)).toEqual(firstSettings);
    expect(reopened.saveProfile(profileCommand)).toEqual(firstProfile);
    expect(reopened.settings().agentRunTimeoutMs).toBe(240_000);
    expect(reopened.profiles().find(profile => profile.id === firstProfile.id)?.instructions).toBe('Later guidance');
  });

  it('reserves a pending command ID across controls, configuration and task creation', () => {
    const { store, task } = fixture();
    const command: TaskControlCommand = { commandId: 'reserved-control', action: 'takeover' };
    store.beginControl(task.id, command);
    const before = store.snapshot(task.id);
    expect(() => store.beginControl(task.id, { commandId: command.commandId, action: 'cancel' })).toThrow(expect.objectContaining({ code: 'COMMAND_CONFLICT' }));
    expect(() => store.updateSettings({ commandId: command.commandId, agentRunTimeoutMs: 1000 })).toThrow(expect.objectContaining({ code: 'COMMAND_CONFLICT' }));
    expect(() => store.saveProfile({ commandId: command.commandId, role: 'developer', name: 'Wrong reuse' })).toThrow(expect.objectContaining({ code: 'COMMAND_CONFLICT' }));
    expect(() => store.create({ commandId: command.commandId, goal: 'Wrong reuse' })).toThrow(expect.objectContaining({ code: 'COMMAND_CONFLICT' }));
    expect(store.snapshot(task.id)).toEqual(before);
    expect(store.list()).toHaveLength(1);
  });
});
