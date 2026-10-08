import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalRecord, CreateTaskCommand, Task, TaskSnapshot, VerificationCommand, Workspace } from '@personal-agent/contracts';
import { EngineError, type EngineAdapter, type EngineRunContext, type EngineSession } from '@personal-agent/runtime';
import { buildApp } from '../src/app.js';

type Server = Awaited<ReturnType<typeof buildApp>>;
const fixtures: Array<{ app: Server['app']; root: string }> = [];

afterEach(async () => {
  for (const { app, root } of fixtures.splice(0)) {
    try { await app.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** A controllable engine; all files and subprocesses belong to this test fixture. */
function fixtureEngine(options: { permissions?: boolean; failAnalysisOnce?: boolean; resolveDelayMs?: number } = {}) {
  let active = 0, maximum = 0, failedAnalysis = false, analysisCount = 0;
  const analyses = deferred<void>();
  const contexts: EngineRunContext[] = [];
  const decisions: Array<{ id: string; optionId: string }> = [];
  const permissions = new Map<string, ReturnType<typeof deferred<string>>>();
  const baselineReads: string[] = [];
  const adapter: EngineAdapter = {
    probe: async () => ({ protocolReady: true, sessionReady: true, planModeSupported: true, authenticatedPrompt: 'not_checked' }),
    async open(context, hooks) {
      contexts.push(context);
      maximum = Math.max(maximum, ++active);
      await hooks.onEvent({ type: 'mode', modeId: context.mode });
      let closed = false;
      let rejectPrompt: ((reason: unknown) => void) | undefined;
      let pendingPermission: string | undefined;
      const stop = () => {
        rejectPrompt?.(new EngineError('ABORTED', 'Fixture run cancelled'));
        if (pendingPermission) {
          permissions.get(pendingPermission)?.reject(new EngineError('ABORTED', 'Fixture approval cancelled'));
          permissions.delete(pendingPermission);
        }
      };
      const session: EngineSession = {
        sessionId: context.runId, processId: undefined, availableModes: ['plan', 'default'],
        async prompt(input, signal) {
          const interruption = new Promise<never>((_, reject) => { rejectPrompt = reject; });
          const abort = () => stop();
          signal?.addEventListener('abort', abort, { once: true });
          try {
            const operation = (async () => {
              if (closed || signal?.aborted) throw new EngineError('ABORTED', 'Fixture run cancelled');
              const role = /^Personal Agent role: (\w+)/u.exec(input)![1];
              const stage = /\n\nStage: (\w+)/u.exec(input)![1];
              if (stage === 'analysis') {
                baselineReads.push(readFileSync(join(context.cwd, 'feature.txt'), 'utf8'));
                if (++analysisCount === 2) analyses.resolve();
                await analyses.promise;
                if (options.failAnalysisOnce && role === 'planner' && !failedAnalysis) {
                  failedAnalysis = true;
                  throw new EngineError('ENGINE_FAILED', 'Untrusted engine diagnostic must not become a task reason');
                }
              }
              if (role === 'developer') {
                if (options.permissions) {
                  pendingPermission = `fixture-permission-${randomUUID()}`;
                  const decision = deferred<string>();
                  permissions.set(pendingPermission, decision);
                  await hooks.onPermission?.({ id: pendingPermission, sessionId: context.runId, toolCallId: 'fixture-edit',
                    title: 'Edit fixture feature.txt', options: [
                      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
                      { optionId: 'reject', name: 'Deny once', kind: 'reject_once' },
                    ], toolCall: { kind: 'edit',
                      rawInput: { file_path: join(context.cwd, 'feature.txt'), old_string: 'before\n', new_string: 'after\n' },
                      locations: [{ path: join(context.cwd, 'feature.txt') }],
                      content: [{ type: 'diff', path: join(context.cwd, 'feature.txt'), oldText: 'before\n', newText: 'after\n' }],
                    } });
                  const option = await decision.promise;
                  pendingPermission = undefined;
                  if (option === 'reject') return { stopReason: 'refusal', text: 'Fixture edit was denied', artifacts: [] };
                }
                writeFileSync(join(context.cwd, 'feature.txt'), 'after\n');
                writeFileSync(join(context.cwd, 'details.txt'), 'new fixture file\n');
              }
              const text = stage === 'review'
                ? '{"verdict":"pass","blockers":[],"evidence":["Reviewed the supplied Runtime verification records"]}'
                : `${role} ${stage} fixture response`;
              await hooks.onEvent({ type: 'message', text });
              return { stopReason: 'end_turn', text, artifacts: [] };
            })();
            return await Promise.race([operation, interruption]);
          } finally {
            rejectPrompt = undefined;
            signal?.removeEventListener('abort', abort);
          }
        },
        async resolvePermission(id, optionId) {
          const decision = permissions.get(id);
          if (!decision) throw new EngineError('PERMISSION_UNKNOWN', 'Fixture approval is stale');
          if (options.resolveDelayMs) await new Promise(resolve => setTimeout(resolve, options.resolveDelayMs));
          decisions.push({ id, optionId });
          permissions.delete(id);
          decision.resolve(optionId);
        },
        async cancel() { stop(); },
        async close() {
          if (closed) return;
          closed = true;
          stop();
          active--;
        },
      };
      return session;
    },
  };
  return { adapter, contexts, decisions, baselineReads, get active() { return active; }, get maximum() { return maximum; } };
}

async function fixture(options: { autoRun?: boolean; engine?: ReturnType<typeof fixtureEngine> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-phase2-api-')));
  const repository = join(root, 'repository');
  const hooks = join(root, 'empty-git-hooks');
  mkdirSync(repository); mkdirSync(hooks);
  writeFileSync(join(repository, 'feature.txt'), 'before\n');
  const git = (args: string[]) => execFileSync('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgSign=false', '-C', repository, ...args], { encoding: 'utf8' });
  git(['init', '--quiet']); git(['add', 'feature.txt']);
  git(['-c', 'user.name=API fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Safe fixture baseline']);
  const baselineSha = git(['rev-parse', 'HEAD']).trim();
  const dataDir = join(root, 'data');
  const engine = options.engine ?? fixtureEngine();
  const server = await buildApp({ dataDir, autoRun: options.autoRun ?? true, realAdapter: engine.adapter, webRoot: join(root, 'no-web-build') });
  fixtures.push({ app: server.app, root });
  return { ...server, root, repository, baselineSha, dataDir, engine, git };
}

const verification: VerificationCommand = { command: process.execPath, args: ['-e', [
  'const fs=require("node:fs");',
  'if(fs.readFileSync("feature.txt","utf8")!=="after\\n")process.exit(7);',
  'if(fs.readFileSync("details.txt","utf8")!=="new fixture file\\n")process.exit(8);',
  'if(fs.existsSync("host-only.txt"))process.exit(9);',
  'process.stdout.write("actual API fixture verification passed\\n");',
  'process.stderr.write("actual API fixture stderr\\n");',
].join('')] };

async function register(server: Server, repository: string, commandId = 'register-fixture'): Promise<Workspace> {
  const response = await server.app.inject({ method: 'POST', url: '/api/workspaces', payload: {
    commandId, name: 'Safe API fixture', path: repository,
  } });
  expect(response.statusCode).toBe(201);
  return response.json<Workspace>();
}

function taskCommand(workspaceId: string, commandId = 'create-real-fixture', commands = [verification]): CreateTaskCommand {
  return { commandId, engine: 'claude', workspaceId, goal: 'Change feature.txt to after and add details.txt', verificationCommands: commands };
}

async function create(server: Server, command: CreateTaskCommand): Promise<Task> {
  const response = await server.app.inject({ method: 'POST', url: '/api/tasks', payload: command });
  expect(response.statusCode).toBe(201);
  return response.json<Task>();
}

async function snapshot(server: Server, id: string): Promise<TaskSnapshot> {
  const response = await server.app.inject(`/api/tasks/${id}`);
  expect(response.statusCode).toBe(200);
  return response.json<TaskSnapshot>();
}

async function pendingApproval(server: Server, id: string): Promise<ApprovalRecord> {
  let approval: ApprovalRecord | undefined;
  await expect.poll(async () => {
    const response = await server.app.inject('/api/approvals');
    approval = response.json<{ approvals: ApprovalRecord[] }>().approvals.find(item => item.taskId === id);
    return approval?.status;
  }, { timeout: 5_000 }).toBe('pending');
  return approval!;
}

const control = (server: Server, id: string, commandId: string, action: 'retry' | 'cancel') => server.app.inject({
  method: 'POST', url: `/api/tasks/${id}/control`, payload: { commandId, action },
});
const resolveApproval = (server: Server, id: string, commandId: string, optionId: string) => server.app.inject({
  method: 'POST', url: `/api/approvals/${id}/resolve`, payload: { commandId, optionId },
});

describe('phase 2 local development task API', () => {
  it('requires a registered Git workspace and explicit verification for real execution', async () => {
    const server = await fixture({ autoRun: false });
    expect((await server.app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: 'missing-input', goal: 'x', engine: 'claude' } })).json()).toMatchObject({ code: 'REAL_TASK_INPUT' });
    expect((await server.app.inject({ method: 'POST', url: '/api/tasks', payload: taskCommand('missing-workspace') })).json()).toMatchObject({ code: 'WORKSPACE_REQUIRED' });
    expect((await server.app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: 'fake-with-repository', goal: 'x', engine: 'fake', workspaceId: 'x' } })).json()).toMatchObject({ code: 'FAKE_TASK_INPUT' });
    const notGit = join(server.root, 'not-git'); mkdirSync(notGit);
    const invalid = await server.app.inject({ method: 'POST', url: '/api/workspaces', payload: { commandId: 'not-git', name: 'Not Git', path: notGit } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'WORKSPACE_INVALID' });
    expect(server.store.list()).toEqual([]);
    expect(server.engine.contexts).toEqual([]);
  });

  it('isolates host WIP at the registered HEAD and exposes persisted patch, review and actual verification through the API', async () => {
    const server = await fixture();
    const workspace = await register(server, server.repository);
    writeFileSync(join(server.repository, 'feature.txt'), 'user uncommitted WIP\n');
    writeFileSync(join(server.repository, 'host-only.txt'), 'user untracked WIP\n');
    const hostStatus = server.git(['status', '--porcelain']);
    const command = taskCommand(workspace.id);
    const original = await create(server, command);
    expect(original).toMatchObject({ engine: 'claude', baselineSha: server.baselineSha, workspaceId: workspace.id, status: 'queued' });
    await server.runner.idle();
    const detail = await snapshot(server, original.id);
    expect(detail.task).toMatchObject({ status: 'completed', activeAttemptId: null, deliveryStatus: 'pending', baselineSha: server.baselineSha });
    expect(detail.task.worktreePath).not.toBe(server.repository);
    expect(server.engine.maximum).toBe(2);
    expect(server.engine.active).toBe(0);
    expect(server.engine.baselineReads).toEqual(['before\n', 'before\n']);
    expect(server.engine.contexts.map(item => item.mode)).toEqual(['plan', 'plan', 'default', 'plan', 'plan']);
    expect(detail.stages?.map(item => item.name)).toEqual(['analysis', 'development', 'verification', 'review', 'summary']);
    expect(detail.stages?.every(item => item.status === 'completed')).toBe(true);
    expect(detail.runs?.every(item => item.status === 'completed')).toBe(true);
    expect(detail.verifications).toHaveLength(1);
    expect(detail.verifications?.[0]).toMatchObject({ command: verification, exitCode: 0, timedOut: false, cancelled: false,
      stdout: 'actual API fixture verification passed\n', stderr: 'actual API fixture stderr\n' });
    expect(detail.events.find(item => item.type === 'review.completed')?.data).toMatchObject({ modelVerdict: 'pass', effectiveVerdict: 'pass', verificationPassed: true });
    const patch = detail.artifacts.find(item => item.kind === 'diff')!;
    expect(patch.content).toContain('+after'); expect(patch.content).toContain('details.txt');
    expect(patch.content).toContain('+new fixture file');
    expect(patch.content).not.toContain('user uncommitted WIP'); expect(patch.content).not.toContain('host-only.txt');
    expect(detail.artifacts.find(item => item.name === 'Actual verification results')?.content).toContain('actual API fixture verification passed');
    expect((await server.app.inject(`/api/tasks/${original.id}/artifacts`)).json().artifacts).toEqual(detail.artifacts);
    expect((await server.app.inject(`/api/tasks/${original.id}/events?after=${detail.events[0].seq}`)).json().events).toEqual(detail.events.slice(1));
    expect(detail.cursor).toBe(detail.events.at(-1)!.seq);
    expect(readFileSync(join(server.repository, 'feature.txt'), 'utf8')).toBe('user uncommitted WIP\n');
    expect(server.git(['status', '--porcelain'])).toBe(hostStatus);
    expect(server.git(['rev-parse', 'HEAD']).trim()).toBe(server.baselineSha);
    const replay = await server.app.inject({ method: 'POST', url: '/api/tasks', payload: command });
    expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(original);
    expect(server.engine.contexts).toHaveLength(5);
    await server.app.close();
    const reopened = await buildApp({ dataDir: server.dataDir, autoRun: false, realAdapter: server.engine.adapter, webRoot: join(server.root, 'no-web-build') });
    try { expect(await snapshot(reopened, original.id)).toEqual(detail); }
    finally { await reopened.app.close(); }
  });

  it('replays original workspace and task responses even after the repository disappears, and rejects changed commands', async () => {
    const server = await fixture({ autoRun: false });
    const registration = { commandId: 'register-once', name: 'Safe API fixture', path: server.repository };
    const workspace = await register(server, server.repository, registration.commandId);
    const command = taskCommand(workspace.id);
    const task = await create(server, command);
    rmSync(server.repository, { recursive: true });
    const workspaceReplay = await server.app.inject({ method: 'POST', url: '/api/workspaces', payload: registration });
    expect(workspaceReplay.statusCode).toBe(200); expect(workspaceReplay.json()).toEqual(workspace);
    const taskReplay = await server.app.inject({ method: 'POST', url: '/api/tasks', payload: command });
    expect(taskReplay.statusCode).toBe(200); expect(taskReplay.json()).toEqual(task);
    for (const payload of [{ ...registration, name: 'Changed name' }, { ...registration, path: `${server.repository}-other` }]) {
      const conflict = await server.app.inject({ method: 'POST', url: '/api/workspaces', payload });
      expect(conflict.statusCode).toBe(409); expect(conflict.json().code).toBe('COMMAND_CONFLICT');
    }
    const changedGoal = await server.app.inject({ method: 'POST', url: '/api/tasks', payload: { ...command, goal: 'Different goal' } });
    expect(changedGoal.statusCode).toBe(409); expect(changedGoal.json().code).toBe('COMMAND_CONFLICT');
    const changedCommands = await server.app.inject({ method: 'POST', url: '/api/tasks', payload: { ...command, verificationCommands: [{ command: process.execPath, args: ['-e', 'process.exit(1)'] }] } });
    expect(changedCommands.statusCode).toBe(409); expect(changedCommands.json().code).toBe('COMMAND_CONFLICT');
    const crossKind = await server.app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: registration.commandId, goal: 'Conflicts with workspace registration' } });
    expect(crossKind.statusCode).toBe(409); expect(crossKind.json().code).toBe('COMMAND_CONFLICT');
    expect((await server.app.inject('/api/workspaces')).json().workspaces).toEqual([workspace]);
    expect((await server.app.inject('/api/tasks')).json().tasks).toEqual([task]);
  });

  it('persists an analysis failure and retries once into a fresh attempt without replaying an idempotent retry', async () => {
    const engine = fixtureEngine({ failAnalysisOnce: true });
    const server = await fixture({ engine });
    const workspace = await register(server, server.repository);
    const task = await create(server, taskCommand(workspace.id));
    await server.runner.idle();
    const failed = await snapshot(server, task.id);
    expect(failed.task).toMatchObject({ status: 'failed', activeAttemptId: null });
    expect(failed.events.at(-1)?.data).toMatchObject({ status: 'failed', reason: 'ENGINE_FAILED' });
    expect(JSON.stringify(failed)).not.toContain('Untrusted engine diagnostic');
    expect(failed.stages).toHaveLength(1);
    expect(failed.verifications).toEqual([]);
    const oldAttempt = failed.runs![0].attemptId;
    const retry = await control(server, task.id, 'retry-failed', 'retry');
    expect(retry.statusCode).toBe(200);
    const retryResponse = retry.json<Task>();
    expect(retryResponse.status).toBe('queued');
    await server.runner.idle();
    const completed = await snapshot(server, task.id);
    expect(completed.task.status).toBe('completed');
    expect(completed.task.worktreePath).toBe(failed.task.worktreePath);
    expect(new Set(completed.runs!.map(item => item.attemptId)).size).toBe(2);
    expect(completed.verifications![0].attemptId).not.toBe(oldAttempt);
    const opens = engine.contexts.length;
    const replay = await control(server, task.id, 'retry-failed', 'retry');
    expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(retryResponse);
    await server.runner.idle(); expect(engine.contexts).toHaveLength(opens);
    const conflict = await control(server, task.id, 'retry-failed', 'cancel');
    expect(conflict.statusCode).toBe(409); expect(conflict.json().code).toBe('COMMAND_CONFLICT');
    expect((await control(server, task.id, 'retry-completed', 'retry')).statusCode).toBe(409);
  });

  it('keeps actual failed commands authoritative over model pass and permits explicit retry of the completed review wait', async () => {
    const server = await fixture();
    const workspace = await register(server, server.repository);
    const command = { command: process.execPath, args: ['-e', 'process.stdout.write("real failing output\\n");process.stderr.write("real failing stderr\\n");process.exit(23);'] };
    const task = await create(server, taskCommand(workspace.id, 'verification-failure', [command]));
    await server.runner.idle();
    const detail = await snapshot(server, task.id);
    expect(detail.task.status).toBe('waiting_human');
    expect(detail.verifications).toHaveLength(2);
    expect(detail.verifications?.every(result => result.exitCode === 23 && result.stdout === 'real failing output\n' && result.stderr === 'real failing stderr\n')).toBe(true);
    expect(detail.events.filter(item => item.type === 'review.completed').every(item => item.data.modelVerdict === 'pass' && item.data.effectiveVerdict === 'rework' && item.data.verificationPassed === false)).toBe(true);
    expect(detail.events.at(-1)?.data).toMatchObject({ reason: 'verification_failed', status: 'waiting_human' });
    expect(detail.artifacts.find(item => item.name === 'Delivery summary')?.content).toContain('verification_failed');
    expect(detail.approvals).toEqual([]);
    const retry = await control(server, task.id, 'retry-review-wait', 'retry');
    expect(retry.statusCode).toBe(200);
    await server.runner.idle();
    const retried = await snapshot(server, task.id);
    expect(retried.task.status).toBe('waiting_human');
    expect(retried.verifications).toHaveLength(4);
    expect(new Set(retried.verifications!.map(item => item.attemptId)).size).toBe(2);
    expect((await control(server, task.id, 'cancel-review-wait', 'cancel')).json().status).toBe('cancelled');
  });

  it('persists approvals until explicit API resolution, rejects invalid decisions, and replays the original decision only once', async () => {
    const engine = fixtureEngine({ permissions: true });
    const server = await fixture({ engine });
    const workspace = await register(server, server.repository);
    const task = await create(server, taskCommand(workspace.id));
    const approval = await pendingApproval(server, task.id);
    const waiting = await snapshot(server, task.id);
    expect(waiting.task).toMatchObject({ status: 'waiting_human', activeAttemptId: approval.attemptId });
    expect(waiting.approvals).toEqual([approval]);
    expect(approval.toolCall).toEqual({ kind: 'edit',
      rawInput: { file_path: join(waiting.task.worktreePath!, 'feature.txt'), old_string: 'before\n', new_string: 'after\n' },
      locations: [{ path: join(waiting.task.worktreePath!, 'feature.txt') }],
      content: [{ type: 'diff', path: join(waiting.task.worktreePath!, 'feature.txt'), oldText: 'before\n', newText: 'after\n' }],
    });
    expect(waiting.events.some(item => item.type === 'approval.requested' && item.data.approvalId === approval.id)).toBe(true);
    expect(readFileSync(join(waiting.task.worktreePath!, 'feature.txt'), 'utf8')).toBe('before\n');
    expect(existsSync(join(waiting.task.worktreePath!, 'details.txt'))).toBe(false);
    const invalid = await resolveApproval(server, approval.id, 'invalid-option', 'invented');
    expect(invalid.statusCode).toBe(409);
    expect((await pendingApproval(server, task.id)).id).toBe(approval.id);
    expect(engine.decisions).toEqual([]);
    expect((await control(server, task.id, 'retry-pending-approval', 'retry')).statusCode).toBe(409);
    const decision = await resolveApproval(server, approval.id, 'approve-fixture-edit', 'allow');
    expect(decision.statusCode).toBe(200);
    expect(decision.json()).toMatchObject({ status: 'resolved', selectedOptionId: 'allow', attemptId: approval.attemptId });
    await server.runner.idle();
    const completed = await snapshot(server, task.id);
    expect(completed.task.status).toBe('completed');
    expect(completed.approvals).toEqual([decision.json()]);
    expect(engine.decisions).toEqual([{ id: approval.id, optionId: 'allow' }]);
    expect((await server.app.inject('/api/approvals')).json().approvals).toEqual([]);
    const replay = await resolveApproval(server, approval.id, 'approve-fixture-edit', 'allow');
    expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(decision.json());
    expect(engine.decisions).toHaveLength(1);
    const conflict = await resolveApproval(server, approval.id, 'approve-fixture-edit', 'reject');
    expect(conflict.statusCode).toBe(409); expect(conflict.json().code).toBe('COMMAND_CONFLICT');
  });

  it('denies a requested edit, fences its old approval after retry, and cancels a new pending approval without approving it', async () => {
    const engine = fixtureEngine({ permissions: true });
    const server = await fixture({ engine });
    const workspace = await register(server, server.repository);
    const task = await create(server, taskCommand(workspace.id));
    const oldApproval = await pendingApproval(server, task.id);
    expect((await resolveApproval(server, oldApproval.id, 'deny-edit', 'reject')).statusCode).toBe(200);
    await server.runner.idle();
    const failed = await snapshot(server, task.id);
    expect(failed.task.status).toBe('failed'); expect(failed.verifications).toEqual([]);
    expect(readFileSync(join(failed.task.worktreePath!, 'feature.txt'), 'utf8')).toBe('before\n');
    expect((await control(server, task.id, 'retry-denied', 'retry')).statusCode).toBe(200);
    const currentApproval = await pendingApproval(server, task.id);
    expect(currentApproval.attemptId).not.toBe(oldApproval.attemptId);
    const stale = await resolveApproval(server, oldApproval.id, 'old-attempt-approval', 'allow');
    expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe('STALE_ATTEMPT');
    expect((await snapshot(server, task.id)).task.activeAttemptId).toBe(currentApproval.attemptId);
    const cancelled = await control(server, task.id, 'cancel-pending', 'cancel');
    expect(cancelled.statusCode).toBe(200); expect(cancelled.json().status).toBe('cancelled');
    await server.runner.idle();
    const detail = await snapshot(server, task.id);
    expect(detail.task).toMatchObject({ status: 'cancelled', activeAttemptId: null });
    expect(detail.approvals?.find(item => item.id === currentApproval.id)?.status).toBe('expired');
    expect(detail.runs?.filter(item => item.attemptId === currentApproval.attemptId).some(item => item.status === 'cancelled')).toBe(true);
    expect(engine.decisions).toEqual([{ id: oldApproval.id, optionId: 'reject' }]);
    expect(engine.active).toBe(0);
    expect((await server.app.inject('/api/approvals')).json().approvals).toEqual([]);
    expect((await resolveApproval(server, currentApproval.id, 'expired-after-cancel', 'allow')).statusCode).toBe(409);
    const replay = await control(server, task.id, 'cancel-pending', 'cancel');
    expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(cancelled.json());
    expect((await control(server, task.id, 'retry-cancelled', 'retry')).statusCode).toBe(409);
  });

  it('serializes concurrent identical approval commands and delivers the engine decision exactly once', async () => {
    const engine = fixtureEngine({ permissions: true, resolveDelayMs: 20 });
    const server = await fixture({ engine });
    const workspace = await register(server, server.repository);
    const task = await create(server, taskCommand(workspace.id));
    const approval = await pendingApproval(server, task.id);
    const [first, second] = await Promise.all([
      resolveApproval(server, approval.id, 'same-concurrent-decision', 'allow'),
      resolveApproval(server, approval.id, 'same-concurrent-decision', 'allow'),
    ]);
    expect(first.statusCode).toBe(200); expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    await server.runner.idle();
    expect(engine.decisions).toEqual([{ id: approval.id, optionId: 'allow' }]);
    const detail = await snapshot(server, task.id);
    expect(detail.task.status).toBe('completed');
    expect(detail.events.filter(item => item.type === 'approval.resolved')).toHaveLength(1);
  });

  it('restores interrupted approval evidence from SQLite without replay and creates a fresh permission only after explicit retry', async () => {
    const engine = fixtureEngine({ permissions: true });
    const server = await fixture({ engine });
    const workspace = await register(server, server.repository);
    const task = await create(server, taskCommand(workspace.id));
    const oldApproval = await pendingApproval(server, task.id);
    const oldAttempt = oldApproval.attemptId;
    await server.app.close();
    const opensBeforeRestart = engine.contexts.length;
    const reopened = await buildApp({ dataDir: server.dataDir, realAdapter: engine.adapter, webRoot: join(server.root, 'no-web-build') });
    try {
      await reopened.runner.idle();
      const restored = await snapshot(reopened, task.id);
      expect(restored.task).toMatchObject({ status: 'interrupted', activeAttemptId: null });
      expect(restored.approvals?.find(item => item.id === oldApproval.id)).toMatchObject({ status: 'expired', attemptId: oldAttempt });
      expect(engine.contexts).toHaveLength(opensBeforeRestart);
      expect((await reopened.app.inject('/api/approvals')).json().approvals).toEqual([]);
      const stale = await resolveApproval(reopened, oldApproval.id, 'stale-after-restart', 'allow');
      expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe('STALE_ATTEMPT');
      expect((await control(reopened, task.id, 'explicit-restart-retry', 'retry')).statusCode).toBe(200);
      const currentApproval = await pendingApproval(reopened, task.id);
      expect(currentApproval.attemptId).not.toBe(oldAttempt);
      expect((await snapshot(reopened, task.id)).task.worktreePath).toBe(restored.task.worktreePath);
      expect((await control(reopened, task.id, 'cancel-restarted-permission', 'cancel')).json().status).toBe('cancelled');
      expect(engine.decisions).toEqual([]);
      expect(engine.active).toBe(0);
    } finally { await reopened.app.close(); }
  });
});
