import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentProfile, ApprovalRecord, InstanceSettings, Task, TaskControlCommand, TaskSnapshot, Workspace } from '@personal-agent/contracts';
import { EngineError, type EngineAdapter, type EngineRunContext, type EngineSession } from '@personal-agent/runtime';
import { buildApp } from '../src/app.js';

type Server = Awaited<ReturnType<typeof buildApp>>;
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** No native model: every edit and verification belongs to a new disposable Git fixture. */
function controlledEngine(options: { holdAnalysis?: boolean; firstDeveloperPermission?: boolean; holdFirstDeveloperClose?: boolean } = {}) {
  const analysis = gate(), close = gate(), closing = gate();
  if (!options.holdAnalysis) analysis.release();
  if (!options.holdFirstDeveloperClose) close.release();
  const prompts: Array<{ context: EngineRunContext; stage: string; role: string; input: string }> = [];
  const decisions: Array<{ id: string; optionId: string }> = [];
  const contexts: EngineRunContext[] = [];
  let active = 0, developerRuns = 0;
  const adapter: EngineAdapter = {
    probe: async () => ({ protocolReady: true, sessionReady: true, planModeSupported: true, authenticatedPrompt: 'not_checked' }),
    async open(context, hooks) {
      contexts.push(context); active++;
      let closed = false, developerNumber = 0;
      let rejectPrompt: ((error: unknown) => void) | undefined;
      let permissionId: string | undefined, permissionDecision: ReturnType<typeof gate> | undefined;
      const stop = () => rejectPrompt?.(new EngineError('ABORTED', 'Stopped disposable fixture run'));
      const session: EngineSession = {
        sessionId: context.runId, processId: undefined, availableModes: ['plan', 'default'],
        async prompt(input, signal) {
          const stage = /\n\nStage: (\w+)/u.exec(input)![1];
          const role = /^Personal Agent role: (\w+)/u.exec(input)![1];
          prompts.push({ context, stage, role, input });
          const interruption = new Promise<never>((_, reject) => { rejectPrompt = reject; });
          const abort = () => stop();
          signal?.addEventListener('abort', abort, { once: true });
          const assertActive = () => { if (closed || signal?.aborted) throw new EngineError('ABORTED', 'Stopped fixture prompt'); };
          try {
            const operation = (async () => {
              assertActive();
              if (stage === 'analysis') { await analysis.promise; assertActive(); }
              if (role === 'developer') {
                developerNumber = ++developerRuns;
                if (options.firstDeveloperPermission && developerNumber === 1) {
                  permissionId = `fixture-permission-${randomUUID()}`;
                  permissionDecision = gate();
                  await hooks.onPermission?.({ id: permissionId, sessionId: context.runId, toolCallId: 'fixture-edit', title: 'Edit disposable feature.txt',
                    options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny once', kind: 'reject_once' }],
                    toolCall: { kind: 'edit', rawInput: { file_path: join(context.cwd, 'feature.txt'), old_string: 'before\n', new_string: 'after\n' } } });
                  await permissionDecision.promise; assertActive();
                }
                writeFileSync(join(context.cwd, 'feature.txt'), 'after\n');
              }
              const text = stage === 'review' ? '{"verdict":"pass","blockers":[],"evidence":["Disposable fixture verification record"]}' : `${role} ${stage} fixture response`;
              await hooks.onEvent({ type: 'message', text });
              assertActive();
              return { stopReason: 'end_turn', text, artifacts: [] };
            })();
            return await Promise.race([operation, interruption]);
          } finally { signal?.removeEventListener('abort', abort); rejectPrompt = undefined; }
        },
        async resolvePermission(id, optionId) {
          if (id !== permissionId || closed) throw new EngineError('PERMISSION_UNKNOWN', 'Fixture approval expired');
          decisions.push({ id, optionId });
          permissionDecision?.release();
        },
        async cancel() { stop(); },
        async close() {
          if (closed) return;
          closed = true; stop();
          if (developerNumber === 1 && options.holdFirstDeveloperClose) { closing.release(); await close.promise; }
          active--;
        },
      };
      return session;
    },
  };
  return { adapter, contexts, prompts, decisions, releaseAnalysis: analysis.release, releaseClose: close.release,
    closeStarted: closing.promise, releaseAll() { analysis.release(); close.release(); }, get active() { return active; } };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(options: { autoRun?: boolean; engine?: ReturnType<typeof controlledEngine> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-reliability-api-')));
  const repository = join(root, 'repository'); const hooks = join(root, 'empty-hooks');
  mkdirSync(repository); mkdirSync(hooks);
  writeFileSync(join(repository, 'feature.txt'), 'before\n');
  const git = (args: string[]) => execFileSync('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgSign=false', '-C', repository, ...args], { encoding: 'utf8' });
  git(['init', '--quiet']); git(['add', 'feature.txt']);
  git(['-c', 'user.name=Reliability fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Disposable fixture']);
  const dataDir = join(root, 'data'); const engine = options.engine ?? controlledEngine();
  const server = await buildApp({ dataDir, autoRun: options.autoRun ?? false, realAdapter: engine.adapter, webRoot: join(root, 'absent-web') });
  cleanups.push(async () => { engine.releaseAll(); try { await server.app.close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  return { ...server, root, repository, dataDir, engine };
}

async function createFake(server: Server, commandId = 'create-fake'): Promise<Task> {
  const response = await server.app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId, goal: 'Disposable API fixture', engine: 'fake' } });
  expect(response.statusCode).toBe(201); return response.json<Task>();
}

async function createDevelopment(server: Server, repository: string): Promise<Task> {
  const registration = await server.app.inject({ method: 'POST', url: '/api/workspaces', payload: { commandId: 'register-repository', name: 'Disposable repository', path: repository } });
  expect(registration.statusCode).toBe(201);
  const response = await server.app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: 'create-development', engine: 'claude',
    workspaceId: registration.json<Workspace>().id, goal: 'Set fixture feature.txt to after', verificationCommands: [{ command: process.execPath,
      args: ['-e', 'const fs=require("node:fs");if(fs.readFileSync("feature.txt","utf8")!=="after\\n")process.exit(9);console.log("fixture passed");'] }] } });
  expect(response.statusCode).toBe(201); return response.json<Task>();
}

const control = (server: Server, id: string, command: TaskControlCommand) => server.app.inject({ method: 'POST', url: `/api/tasks/${id}/control`, payload: command });
const resolveApproval = (server: Server, id: string, commandId = 'resolve-old') => server.app.inject({ method: 'POST', url: `/api/approvals/${id}/resolve`, payload: { commandId, optionId: 'allow' } });
const snapshot = async (server: Server, id: string) => (await server.app.inject(`/api/tasks/${id}`)).json<TaskSnapshot>();
async function approvalFor(server: Server, id: string) {
  let approval: ApprovalRecord | undefined;
  await expect.poll(async () => { approval = server.store.approvals(id).find(item => item.status === 'pending'); return approval?.status; }, { timeout: 5000 }).toBe('pending');
  return approval!;
}

describe('local reliability API controls', () => {
  it('replays simultaneous pause and feedback commands without duplicate effects or lost requirements', async () => {
    const server = await fixture(); const task = await createFake(server);
    const pause: TaskControlCommand = { commandId: 'pause-once', action: 'pause' };
    const responses = await Promise.all([control(server, task.id, pause), control(server, task.id, pause)]);
    expect(responses.every(response => response.statusCode === 200)).toBe(true);
    expect(responses[0].json()).toEqual(responses[1].json());
    expect(responses[0].json()).toMatchObject({ status: 'paused', activeAttemptId: null });
    const feedback: TaskControlCommand = { commandId: 'feedback-once', action: 'feedback', requirements: 'Keep fixture output stable.' };
    await Promise.all([control(server, task.id, feedback), control(server, task.id, feedback)]);
    expect(server.store.require(task.id).instructions).toHaveLength(1);
    const resume = await control(server, task.id, { commandId: 'resume-once', action: 'resume' });
    expect(resume.json()).toMatchObject({ status: 'queued', activeAttemptId: null });
    expect((await control(server, task.id, pause)).json()).toEqual(responses[0].json());
    expect(server.store.require(task.id).status).toBe('queued');
    expect(server.engine.contexts).toEqual([]);
    expect((await control(server, task.id, { commandId: feedback.commandId, action: 'cancel' })).statusCode).toBe(409);
    expect((await control(server, task.id, { ...feedback, requirements: 'Changed instruction' })).json()).toMatchObject({ code: 'COMMAND_CONFLICT' });
  });

  it('validates control requirements and rejects extra permission or credential fields', async () => {
    const server = await fixture(); const task = await createFake(server); const before = await snapshot(server, task.id);
    const invalid = [
      { commandId: 'bad-feedback', action: 'feedback' }, { commandId: 'bad-return', action: 'return' },
      { commandId: 'blank-feedback', action: 'feedback', requirements: ' \n ' },
      { commandId: 'extra-pause', action: 'pause', requirements: 'Unexpected field' },
      { commandId: 'bypass', action: 'takeover', bypassPermissions: true }, { commandId: 'unknown', action: 'merge' },
    ];
    for (const payload of invalid) expect((await server.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/control`, payload })).statusCode).toBe(400);
    expect(await snapshot(server, task.id)).toEqual(before);
  });

  it('accepts a completed delivery once and returns a separate delivery for a fresh development attempt', async () => {
    const server = await fixture(); const acceptedTask = await createFake(server, 'delivery-accept');
    const returnedTask = await createFake(server, 'delivery-return');
    for (const task of [acceptedTask, returnedTask]) {
      const running = server.store.start(task.id);
      server.store.addArtifact(task.id, running.activeAttemptId!, { kind: 'text', name: 'Result', content: 'fixture evidence' });
      server.store.saveCheckpoint(task.id, running.activeAttemptId!, { nextStage: 'delivery', iteration: 0, analyses: { planner: 'retained plan', reviewer: 'retained checks' } });
      server.store.transition(task.id, 'completed', running.activeAttemptId!);
    }
    const accept: TaskControlCommand = { commandId: 'accept-once', action: 'accept' };
    const accepted = await control(server, acceptedTask.id, accept);
    expect(accepted.json()).toMatchObject({ status: 'completed', deliveryStatus: 'accepted', activeAttemptId: null });
    expect((await control(server, acceptedTask.id, accept)).json()).toEqual(accepted.json());
    expect((await control(server, acceptedTask.id, { commandId: 'return-accepted', action: 'return', requirements: 'Another edit' })).statusCode).toBe(409);
    const command: TaskControlCommand = { commandId: 'return-once', action: 'return', requirements: 'Add empty-input coverage.' };
    const returned = await Promise.all([control(server, returnedTask.id, command), control(server, returnedTask.id, command)]);
    expect(returned[0].json()).toEqual(returned[1].json());
    expect(returned[0].json()).toMatchObject({ status: 'queued', checkpoint: { nextStage: 'development', iteration: 0 } });
    const detail = await snapshot(server, returnedTask.id);
    expect(detail.task.instructions).toHaveLength(1); expect(detail.artifacts).toHaveLength(1);
    expect(detail.events.filter(event => event.type === 'delivery.returned')).toHaveLength(1);
    expect(server.engine.contexts).toEqual([]);
  });

  it('preserves a pending stop command across reopening and requires explicit resume', async () => {
    const server = await fixture(); const task = await createFake(server);
    const running = server.store.start(task.id);
    server.store.saveCheckpoint(task.id, running.activeAttemptId!, { nextStage: 'development', iteration: 0 });
    const command: TaskControlCommand = { commandId: 'pending-takeover', action: 'takeover', requirements: 'Persisted before shutdown.' };
    server.store.beginControl(task.id, command);
    await server.app.close();
    const reopened = await buildApp({ dataDir: server.dataDir, autoRun: false, realAdapter: server.engine.adapter, webRoot: join(server.root, 'absent-web') });
    try {
      expect(reopened.store.require(task.id)).toMatchObject({ status: 'interrupted', activeAttemptId: null });
      expect(server.engine.contexts).toEqual([]);
      const finished = await control(reopened, task.id, command);
      expect(finished.statusCode).toBe(200);
      expect(finished.json()).toMatchObject({ status: 'paused', checkpoint: { nextStage: 'development' } });
      expect(reopened.store.require(task.id).instructions).toHaveLength(1);
      expect((await control(reopened, task.id, command)).json()).toEqual(finished.json());
      expect((await control(reopened, task.id, { commandId: 'explicit-resume', action: 'resume' })).json()).toMatchObject({ status: 'queued' });
    } finally { await reopened.app.close(); }
  });

  it('finishes both analysis runs before boundary pause and applies feedback only to the next stage', async () => {
    const engine = controlledEngine({ holdAnalysis: true }); const server = await fixture({ autoRun: true, engine });
    const task = await createDevelopment(server, server.repository);
    await expect.poll(() => engine.prompts.filter(prompt => prompt.stage === 'analysis').length).toBe(2);
    const oldAttempt = server.store.require(task.id).activeAttemptId;
    const feedback = await control(server, task.id, { commandId: 'analysis-feedback', action: 'feedback', requirements: 'Add blank-input coverage in the next stage.' });
    expect(feedback.statusCode).toBe(200);
    const requested = await control(server, task.id, { commandId: 'analysis-pause', action: 'pause' });
    expect(requested.json()).toMatchObject({ status: 'running', pauseRequested: true });
    engine.releaseAnalysis(); await server.runner.idle();
    const paused = await snapshot(server, task.id);
    expect(paused.task).toMatchObject({ status: 'paused', activeAttemptId: null, checkpoint: { nextStage: 'development' } });
    expect(paused.stages).toHaveLength(1); expect(paused.stages?.[0].status).toBe('completed');
    expect(paused.runs?.every(run => run.status === 'completed')).toBe(true); expect(engine.active).toBe(0);
    const resume: TaskControlCommand = { commandId: 'resume-boundary', action: 'resume' };
    const responses = await Promise.all([control(server, task.id, resume), control(server, task.id, resume)]);
    expect(responses[0].json()).toEqual(responses[1].json());
    await server.runner.idle();
    const detail = await snapshot(server, task.id);
    expect(detail.task.status).toBe('completed'); expect(detail.verifications?.[0].exitCode).toBe(0);
    expect(engine.prompts.filter(prompt => prompt.stage === 'analysis')).toHaveLength(2);
    expect(engine.prompts.filter(prompt => prompt.stage === 'analysis').every(prompt => !prompt.input.includes('Add blank-input coverage'))).toBe(true);
    const developer = engine.prompts.find(prompt => prompt.role === 'developer')!;
    expect(developer.input).toContain('Add blank-input coverage'); expect(developer.context.attemptId).not.toBe(oldAttempt);
  });

  it('pauses a waiting permission by cleanup without approving and resumes development in a new attempt', async () => {
    const engine = controlledEngine({ firstDeveloperPermission: true }); const server = await fixture({ autoRun: true, engine });
    const task = await createDevelopment(server, server.repository); const approval = await approvalFor(server, task.id);
    const paused = await control(server, task.id, { commandId: 'pause-permission', action: 'pause' });
    expect(paused.statusCode).toBe(200); expect(paused.json()).toMatchObject({ status: 'paused', activeAttemptId: null });
    expect(engine.active).toBe(0); expect(engine.decisions).toEqual([]);
    expect(server.store.approval(approval.id)).toMatchObject({ status: 'expired', selectedOptionId: null });
    expect((await resolveApproval(server, approval.id)).statusCode).toBe(409);
    await control(server, task.id, { commandId: 'resume-permission', action: 'resume' }); await server.runner.idle();
    const detail = await snapshot(server, task.id);
    expect(detail.task.status).toBe('completed'); expect(detail.verifications?.[0].exitCode).toBe(0);
    const developers = engine.prompts.filter(prompt => prompt.role === 'developer');
    expect(developers).toHaveLength(2); expect(developers[1].context.attemptId).not.toBe(approval.attemptId);
    expect(engine.prompts.filter(prompt => prompt.stage === 'analysis')).toHaveLength(2);
    expect(engine.decisions).toEqual([]);
  });

  it('serializes takeover with a queued old approval response and waits for close before publishing paused', async () => {
    const engine = controlledEngine({ firstDeveloperPermission: true, holdFirstDeveloperClose: true });
    const server = await fixture({ autoRun: true, engine }); const task = await createDevelopment(server, server.repository);
    const approval = await approvalFor(server, task.id);
    const takeover: TaskControlCommand = { commandId: 'takeover-with-feedback', action: 'takeover', requirements: 'Apply this requirement on resume.' };
    const stopping = control(server, task.id, takeover);
    await engine.closeStarted;
    expect(server.store.require(task.id)).toMatchObject({ status: 'waiting_human', pauseRequested: true, activeAttemptId: approval.attemptId });
    const oldDecision = resolveApproval(server, approval.id);
    engine.releaseClose();
    const stopped = await stopping; const stale = await oldDecision;
    expect(stopped.statusCode).toBe(200); expect(stopped.json()).toMatchObject({ status: 'paused', activeAttemptId: null });
    expect(stale.statusCode).toBe(409); expect(engine.decisions).toEqual([]); expect(engine.active).toBe(0);
    expect(server.store.require(task.id).instructions).toHaveLength(1);
    expect((await control(server, task.id, takeover)).json()).toEqual(stopped.json());
    const before = await snapshot(server, task.id);
    expect((await control(server, task.id, { ...takeover, requirements: 'Conflicting new text' })).json()).toMatchObject({ code: 'COMMAND_CONFLICT' });
    expect(await snapshot(server, task.id)).toEqual(before);
    await control(server, task.id, { commandId: 'resume-takeover', action: 'resume' }); await server.runner.idle();
    expect(server.store.require(task.id).status).toBe('completed');
    expect(engine.prompts.filter(prompt => prompt.role === 'developer').at(-1)?.input).toContain('Apply this requirement on resume.');
    expect(readFileSync(join(server.repository, 'feature.txt'), 'utf8')).toBe('before\n');
  });

  it('retires a stage whose completion checkpoint rolls back instead of exposing it as running forever', async () => {
    const server = await fixture(); const task = await createDevelopment(server, server.repository);
    const db = new DatabaseSync(server.store.filename);
    try {
      db.exec("CREATE TRIGGER fail_finished_checkpoint BEFORE INSERT ON task_events WHEN NEW.type='pipeline.checkpoint' AND EXISTS(SELECT 1 FROM stages WHERE task_id=NEW.task_id AND json_extract(payload_json,'$.status')='completed') BEGIN SELECT RAISE(ABORT,'finished checkpoint failure'); END;");
      server.runner.enqueue(task.id); await server.runner.idle();
      const detail = await snapshot(server, task.id);
      expect(detail.task).toMatchObject({ status: 'failed', activeAttemptId: null, checkpoint: { nextStage: 'analysis' } });
      expect(detail.stages).toHaveLength(1);
      expect(detail.stages?.[0]).toMatchObject({ status: 'failed' });
      expect(detail.stages?.[0].endedAt).not.toBeNull();
      expect(server.engine.active).toBe(0);
    } finally { db.close(); }
  });
});

describe('public configuration API and immutable task selection', () => {
  it('stores only public fields, validates roles and snapshots later profile edits away from existing tasks', async () => {
    const server = await fixture();
    const initialSettings = (await server.app.inject('/api/settings')).json<InstanceSettings>();
    expect(Object.keys(initialSettings).sort()).toEqual(['agentRunTimeoutMs', 'defaultEngine', 'updatedAt', 'verificationTimeoutMs']);
    const profile = await server.app.inject({ method: 'POST', url: '/api/agents', payload: { commandId: 'create-profile', name: 'Fixture planner', role: 'planner', instructions: 'Initial planning requirements' } });
    expect(profile.statusCode).toBe(201); const planner = profile.json<AgentProfile>();
    const creation = { commandId: 'with-profile', goal: 'Fixture task', engine: 'fake', profileIds: { planner: planner.id } };
    const created = await server.app.inject({ method: 'POST', url: '/api/tasks', payload: creation }); expect(created.statusCode).toBe(201);
    const task = created.json<Task>(); const original = structuredClone(task.configSnapshot);
    expect((await server.app.inject({ method: 'PATCH', url: '/api/settings', payload: { commandId: 'edit-settings', agentRunTimeoutMs: 30_000 } })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'PATCH', url: `/api/agents/${planner.id}`, payload: { commandId: 'edit-profile', instructions: 'Changed future guidance' } })).statusCode).toBe(200);
    expect((await snapshot(server, task.id)).task.configSnapshot).toEqual(original);
    const future = await server.app.inject({ method: 'POST', url: '/api/tasks', payload: { ...creation, commandId: 'future-task' } });
    expect(future.json<Task>().configSnapshot?.profiles.planner.instructions).toBe('Changed future guidance');
    expect(future.json<Task>().configSnapshot?.settings.agentRunTimeoutMs).toBe(30_000);
    expect((await server.app.inject({ method: 'POST', url: '/api/tasks', payload: { ...creation, commandId: 'wrong-role', profileIds: { developer: planner.id } } })).json()).toMatchObject({ code: 'PROFILE_ROLE_MISMATCH' });
    expect((await server.app.inject({ method: 'PATCH', url: `/api/agents/${planner.id}`, payload: { commandId: 'change-role', role: 'developer' } })).statusCode).toBe(400);
    expect((await server.app.inject({ method: 'POST', url: '/api/agents', payload: { commandId: 'bad-role', name: 'bad', role: 'operator', instructions: '' } })).statusCode).toBe(400);
  });

  it('rejects forbidden configuration and unsafe timeout values without mutating settings', async () => {
    const server = await fixture(); const initial = (await server.app.inject('/api/settings')).json();
    const invalid = [ { commandId: 'empty-settings' }, { commandId: 'short-timeout', agentRunTimeoutMs: 999 },
      { commandId: 'long-timeout', verificationTimeoutMs: 1_800_001 }, { commandId: 'coerced', agentRunTimeoutMs: '1000' },
      { commandId: 'secret', apiKey: 'test-value' }, { commandId: 'permission-mode', bypassPermissions: true },
      { commandId: 'remote-host', host: '0.0.0.0' } ];
    for (const payload of invalid) expect((await server.app.inject({ method: 'PATCH', url: '/api/settings', payload })).statusCode).toBe(400);
    expect((await server.app.inject('/api/settings')).json()).toEqual(initial);
    expect((await server.app.inject({ method: 'POST', url: '/api/agents', payload: { commandId: 'profile-secret', name: 'fixture', role: 'developer', instructions: '', token: 'test-value' } })).statusCode).toBe(400);
  });

  it('reserves pending control command IDs across creation, settings and profile endpoints', async () => {
    const server = await fixture(); const task = await createFake(server);
    server.store.beginControl(task.id, { commandId: 'reserved-command', action: 'takeover', requirements: 'Pending instruction' });
    const before = await snapshot(server, task.id);
    const requests = [
      { method: 'POST' as const, url: '/api/tasks', payload: { commandId: 'reserved-command', goal: 'Other task' } },
      { method: 'PATCH' as const, url: '/api/settings', payload: { commandId: 'reserved-command', agentRunTimeoutMs: 1000 } },
      { method: 'POST' as const, url: '/api/agents', payload: { commandId: 'reserved-command', name: 'Other profile', role: 'planner', instructions: '' } },
    ];
    for (const request of requests) {
      const response = await server.app.inject(request); expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ code: 'COMMAND_CONFLICT' });
    }
    expect(await snapshot(server, task.id)).toEqual(before); expect(server.store.list()).toHaveLength(1);
  });
});
