import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeTaskRunner } from '../src/runner.js';
import { TaskStore } from '../src/store.js';
import { createFakeEngineAdapter } from '../src/engine-fake.js';
import type { EngineAdapter, EngineHooks, EngineRunContext, EngineSession } from '../src/engine.js';
import { EngineError } from '../src/engine.js';

const cleanups: Array<() => Promise<void>> = [];
function fixture(adapter?: EngineAdapter, realAdapter?: EngineAdapter) {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-runner-'));
  const store = new TaskStore(join(dir, 'tasks.sqlite'));
  const runner = new FakeTaskRunner(store, dir, adapter, realAdapter);
  cleanups.push(async () => { await runner.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, runner };
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function controlledAdapter(close: () => Promise<void> = async () => {}): EngineAdapter {
  return {
    probe: async () => ({ protocolReady: true, sessionReady: true, planModeSupported: true, authenticatedPrompt: 'not_checked' }),
    open: async (_context, hooks: EngineHooks): Promise<EngineSession> => ({
      sessionId: 'controlled', processId: undefined, availableModes: ['plan'],
      prompt: async () => {
        await hooks.onEvent({ type: 'artifact', kind: 'markdown', title: 'Result', content: 'fake controlled' });
        return { stopReason: 'end_turn', text: 'fake controlled', artifacts: [] };
      },
      resolvePermission: async () => {}, cancel: async () => {}, close,
    }),
  };
}

function realFixture(adapter: EngineAdapter) {
  const context = fixture(undefined, adapter);
  const repository = join(context.dir, 'harmless-repository');
  mkdirSync(repository);
  writeFileSync(join(repository, 'answer.txt'), 'before');
  execFileSync('git', ['init', '--quiet', repository]);
  execFileSync('git', ['-C', repository, 'add', 'answer.txt']);
  execFileSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Harmless baseline']);
  const baseline = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const workspace = context.store.registerWorkspace(repository, 'Harmless fixture');
  const task = context.store.create({ commandId: 'real-control-fixture', goal: 'Change answer.txt to after', engine: 'claude',
    workspaceId: workspace.id, verificationCommands: [{ command: process.execPath, args: ['-e',
      'if(require("node:fs").readFileSync("answer.txt","utf8")!=="after")process.exit(9);console.log("actual control fixture passed")'] }] }, baseline).task;
  return { ...context, repository, task };
}

function workflowAdapter(options: {
  onPrompt?(context: EngineRunContext, input: string, hooks: EngineHooks): Promise<void>;
  onClose?(context: EngineRunContext): Promise<void>;
} = {}): EngineAdapter {
  return {
    probe: async () => ({ protocolReady: true, sessionReady: true, planModeSupported: true, authenticatedPrompt: 'not_checked' }),
    open: async (context, hooks) => ({
      sessionId: context.runId, processId: undefined, availableModes: ['plan', 'default'],
      prompt: async (input) => {
        await options.onPrompt?.(context, input, hooks);
        if (context.role === 'developer') writeFileSync(join(context.cwd, 'answer.txt'), 'after');
        const text = input.includes('Stage: review') ? '{"verdict":"pass","blockers":[],"evidence":["Actual verification record"]}' : `${context.role} response`;
        return { stopReason: 'end_turn', text, artifacts: [] };
      },
      resolvePermission: async () => {}, cancel: async () => {}, close: async () => { await options.onClose?.(context); },
    }),
  };
}

describe('development runner checkpoints with the persistent task store', () => {
  it('blocks dispatch when a failed completion cannot persist retirement', async () => {
    const { store, runner, task } = realFixture(workflowAdapter());
    const second = store.create({ commandId: 'after-persistence-failure', goal: 'Queued fake task' }).task;
    const recordStage = store.recordStage.bind(store);
    vi.spyOn(store, 'completeStage').mockImplementation(() => { throw new Error('Completion rollback'); });
    const stage = vi.spyOn(store, 'recordStage').mockImplementation(record => {
      if (record.status === 'failed') throw new Error('Failed retirement rollback');
      recordStage(record);
    });
    try {
      runner.enqueue(task.id); runner.enqueue(second.id);
      await runner.idle();
      expect(runner.isBlocked).toBe(true);
      expect(store.require(task.id).status).toBe('interrupted');
      expect(store.events(task.id).at(-1)?.data.reason).toBe('event_persistence_failed');
      expect(store.require(task.id).checkpoint?.nextStage).toBe('analysis');
      expect(store.require(second.id).status).toBe('queued');
    } finally { stage.mockRestore(); }
  });

  it('persists a graceful analysis pause and resumes only the unfinished development with actual verification', async () => {
    let both!: () => void, releaseAnalysis!: () => void;
    const bothStarted = new Promise<void>(resolve => { both = resolve; });
    const analysisGate = new Promise<void>(resolve => { releaseAnalysis = resolve; });
    let analyses = 0;
    const adapter = workflowAdapter({ onPrompt: async (_context, input) => {
      if (input.includes('Stage: analysis')) {
        if (++analyses === 2) both();
        await analysisGate;
      }
    } });
    const { store, runner, task, repository } = realFixture(adapter);
    runner.enqueue(task.id);
    await bothStarted;
    const pause = { commandId: 'analysis-phase-pause', action: 'pause' as const };
    expect(store.beginControl(task.id, pause).pauseRequested).toBe(true);
    releaseAnalysis();
    await runner.idle();
    expect(store.require(task.id).status).toBe('paused');
    expect(store.require(task.id).checkpoint?.nextStage).toBe('development');
    expect(store.snapshot(task.id).stages?.map(stage => [stage.name, stage.status])).toEqual([['analysis', 'completed']]);
    store.finishControl(task.id, pause);
    store.finishControl(task.id, { commandId: 'resume-analysis-fixture', action: 'resume' });
    runner.enqueue(task.id);
    await runner.idle();
    const snapshot = store.snapshot(task.id);
    expect(snapshot.task.status).toBe('completed');
    expect(analyses).toBe(2);
    expect(snapshot.verifications?.[0]).toMatchObject({ exitCode: 0, stdout: 'actual control fixture passed\n' });
    expect(store.processes()).toHaveLength(0);
    expect(store.processes(false)).toHaveLength(1);
    expect(readFileSync(join(repository, 'answer.txt'), 'utf8')).toBe('before');
  });

  it('takes over a persisted permission wait without approval, confirms cleanup, expires the old request and resumes development', async () => {
    let permission!: () => void, closing!: () => void, releaseClose!: () => void;
    const permissionStarted = new Promise<void>(resolve => { permission = resolve; });
    const closeStarted = new Promise<void>(resolve => { closing = resolve; });
    const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
    let developers = 0, firstDeveloper: string | undefined;
    const adapter = workflowAdapter({ onPrompt: async (context, _input, hooks) => {
      if (context.role === 'developer' && ++developers === 1) {
        firstDeveloper = context.runId;
        await hooks.onPermission?.({ id: 'retained-fixture-permission', sessionId: context.runId, toolCallId: 'fixture-edit',
          title: 'Edit harmless fixture', options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }] });
        permission();
        await new Promise<never>(() => {});
      }
    }, onClose: async context => {
      if (context.runId === firstDeveloper) { closing(); await closeGate; }
    } });
    const { store, runner, task } = realFixture(adapter);
    runner.enqueue(task.id);
    await permissionStarted;
    expect(store.require(task.id).status).toBe('waiting_human');
    const pause = { commandId: 'pause-permission-fixture', action: 'pause' as const };
    store.beginControl(task.id, pause);
    const stopping = runner.takeover(task.id);
    await closeStarted;
    expect(store.require(task.id).status).toBe('waiting_human');
    releaseClose();
    await stopping;
    expect(store.require(task.id).status).toBe('paused');
    expect(store.require(task.id).checkpoint?.nextStage).toBe('development');
    expect(store.approval('retained-fixture-permission')?.status).toBe('expired');
    expect(runner.canResolvePermission('retained-fixture-permission')).toBe(false);
    expect(() => store.resolveApproval('retained-fixture-permission', 'stale-option', 'allow-once')).toThrow();
    store.finishControl(task.id, pause);
    store.finishControl(task.id, { commandId: 'resume-permission-fixture', action: 'resume' });
    runner.enqueue(task.id);
    await runner.idle();
    const snapshot = store.snapshot(task.id);
    expect(snapshot.task.status).toBe('completed');
    expect(snapshot.stages?.filter(stage => stage.name === 'analysis')).toHaveLength(1);
    expect(snapshot.runs?.filter(run => run.role === 'developer').map(run => run.status)).toEqual(['cancelled', 'completed']);
    expect(snapshot.verifications?.[0].exitCode).toBe(0);
  });
});

describe('fake runtime failure and FIFO behavior', () => {
  it('blocks dispatch after startup returns EVENT_FAILURE without a session to close', async () => {
    const adapter = controlledAdapter();
    adapter.open = vi.fn(async () => { throw new EngineError('EVENT_FAILURE', 'Process end registration failed after startup cleanup'); });
    const { store, runner } = fixture(adapter);
    const first = store.create({ commandId: 'startup-event-failure', goal: 'One' }).task;
    const second = store.create({ commandId: 'after-startup-event-failure', goal: 'Two' }).task;
    runner.enqueue(first.id); runner.enqueue(second.id);
    await runner.idle();
    expect(runner.isBlocked).toBe(true);
    expect(store.require(first.id).status).toBe('interrupted');
    expect(store.events(first.id).at(-1)?.data.reason).toBe('event_persistence_failed');
    expect(store.require(second.id).status).toBe('queued');
    expect(adapter.open).toHaveBeenCalledTimes(1);
  });

  it('blocks a direct fake adapter callback when its artifact cannot be persisted', async () => {
    const { store, runner } = fixture(controlledAdapter());
    const first = store.create({ commandId: 'fake-callback-persistence-failure', goal: 'One' }).task;
    const second = store.create({ commandId: 'after-fake-callback-persistence-failure', goal: 'Two' }).task;
    vi.spyOn(store, 'addArtifact').mockImplementation(() => { throw new Error('Raw artifact failure'); });
    runner.enqueue(first.id); runner.enqueue(second.id);
    await runner.idle();
    expect(runner.isBlocked).toBe(true);
    expect(store.require(first.id).status).toBe('interrupted');
    expect(store.require(second.id).status).toBe('queued');
    expect(store.events(first.id).at(-1)?.data.reason).toBe('event_persistence_failed');
  });

  it('takes over a fake prompt that ignores AbortSignal and ignores late old-attempt output after resuming', async () => {
    let started!: () => void;
    const promptStarted = new Promise<void>(resolve => { started = resolve; });
    const adapter = controlledAdapter();
    const original = adapter.open;
    let opens = 0;
    let oldHooks: EngineHooks | undefined;
    adapter.open = async (context, hooks) => {
      const session = await original(context, hooks);
      if (++opens > 1) return session;
      oldHooks = hooks;
      return { ...session, prompt: async () => { started(); return new Promise<never>(() => {}); } };
    };
    const { store, runner } = fixture(adapter);
    const task = store.create({ commandId: 'fake-ignores-abort', goal: 'One' }).task;
    runner.enqueue(task.id);
    await promptStarted;
    await runner.takeover(task.id);
    expect(store.require(task.id).status).toBe('paused');
    store.transition(task.id, 'queued');
    runner.enqueue(task.id);
    await runner.idle();
    const cursor = store.snapshot(task.id).cursor;
    await oldHooks!.onEvent({ type: 'artifact', kind: 'markdown', title: 'Late old output', content: 'Must not be persisted' });
    expect(store.require(task.id).status).toBe('completed');
    expect(store.snapshot(task.id).cursor).toBe(cursor);
    expect(store.artifacts(task.id)).toHaveLength(1);
  });

  it('takes over a fake prompt only after close and resumes it in a fresh attempt while retaining partial artifacts', async () => {
    let started!: () => void, closing!: () => void, releaseClose!: () => void;
    const promptStarted = new Promise<void>(resolve => { started = resolve; });
    const closeStarted = new Promise<void>(resolve => { closing = resolve; });
    const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
    const adapter = controlledAdapter();
    const original = adapter.open;
    let count = 0;
    adapter.open = async (context, hooks) => {
      const session = await original(context, hooks);
      if (++count > 1) return session;
      return { ...session,
        prompt: async (_goal, signal) => {
          await hooks.onEvent({ type: 'artifact', kind: 'markdown', title: 'Partial', content: 'Retained before takeover' });
          started();
          await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
          throw new EngineError('ABORTED', 'Takeover');
        },
        close: async () => { closing(); await closeGate; },
      };
    };
    const { store, runner } = fixture(adapter);
    const task = store.create({ commandId: 'takeover-fake', goal: 'One' }).task;
    runner.enqueue(task.id);
    await promptStarted;
    const firstAttempt = store.require(task.id).activeAttemptId;
    const takeover = runner.takeover(task.id);
    await closeStarted;
    expect(store.require(task.id).status).toBe('running');
    releaseClose();
    await takeover;
    expect(store.require(task.id).status).toBe('paused');
    expect(store.require(task.id).activeAttemptId).toBeNull();
    expect(store.events(task.id).at(-1)?.data.reason).toBe('user_takeover');
    store.transition(task.id, 'queued');
    runner.enqueue(task.id);
    await runner.idle();
    expect(store.require(task.id).status).toBe('completed');
    expect(store.artifacts(task.id)).toHaveLength(2);
    expect(store.artifacts(task.id)[0].attemptId).toBe(firstAttempt);
    expect(store.artifacts(task.id)[1].attemptId).not.toBe(firstAttempt);
  });

  it('applies a graceful fake pause after the complete prompt and confirmed close', async () => {
    let closing!: () => void, releaseClose!: () => void;
    const closeStarted = new Promise<void>(resolve => { closing = resolve; });
    const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
    const { store, runner } = fixture(controlledAdapter(async () => { closing(); await closeGate; }));
    const task = store.create({ commandId: 'pause-fake', goal: 'One' }).task;
    const get = store.get.bind(store);
    let pauseRequested = false;
    vi.spyOn(store, 'get').mockImplementation(id => {
      const record = get(id);
      return record && id === task.id && record.status === 'running' && pauseRequested ? { ...record, pauseRequested: true } : record;
    });
    runner.enqueue(task.id);
    await closeStarted;
    pauseRequested = true;
    expect(store.require(task.id).status).toBe('running');
    releaseClose();
    await runner.idle();
    expect(store.require(task.id).status).toBe('paused');
    expect(store.events(task.id).at(-1)?.data.reason).toBe('pause_requested');
    expect(store.artifacts(task.id)).toHaveLength(1);
    expect(store.require(task.id).checkpoint).toEqual({ nextStage: 'delivery', iteration: 0, outcome: { status: 'completed' } });
    pauseRequested = false;
    store.finishControl(task.id, { commandId: 'resume-complete-fake', action: 'resume' });
    runner.enqueue(task.id);
    await runner.idle();
    expect(store.require(task.id).status).toBe('completed');
    expect(store.artifacts(task.id)).toHaveLength(1);
  });

  it('runs a returned fake delivery again with its added requirements and a fresh artifact', async () => {
    const adapter = controlledAdapter();
    const original = adapter.open;
    const inputs: string[] = [];
    adapter.open = async (context, hooks) => {
      const session = await original(context, hooks);
      return { ...session, prompt: async (input, signal) => { inputs.push(input); return session.prompt(input, signal); } };
    };
    const { store, runner } = fixture(adapter);
    const task = store.create({ commandId: 'return-fake', goal: 'One' }).task;
    runner.enqueue(task.id);
    await runner.idle();
    expect(store.require(task.id).checkpoint?.nextStage).toBe('delivery');
    const firstAttempt = store.artifacts(task.id)[0].attemptId;
    store.finishControl(task.id, { commandId: 'return-fake-requirements', action: 'return', requirements: 'Add the requested detail' });
    expect(store.require(task.id).checkpoint?.nextStage).toBe('development');
    runner.enqueue(task.id);
    await runner.idle();
    expect(store.require(task.id).status).toBe('completed');
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain('Add the requested detail');
    expect(store.artifacts(task.id)).toHaveLength(2);
    expect(store.artifacts(task.id)[1].attemptId).not.toBe(firstAttempt);
  });

  it('lets a terminal cancellation supersede a pending takeover before cleanup settles', async () => {
    let started!: () => void, closing!: () => void, releaseClose!: () => void;
    const promptStarted = new Promise<void>(resolve => { started = resolve; });
    const closeStarted = new Promise<void>(resolve => { closing = resolve; });
    const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
    const adapter = controlledAdapter();
    const original = adapter.open;
    adapter.open = async (context, hooks) => ({ ...await original(context, hooks),
      prompt: async (_goal, signal) => {
        started();
        await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
        throw new EngineError('ABORTED', 'Stopped');
      },
      close: async () => { closing(); await closeGate; },
    });
    const { store, runner } = fixture(adapter);
    const task = store.create({ commandId: 'takeover-then-cancel', goal: 'One' }).task;
    runner.enqueue(task.id);
    await promptStarted;
    const takeover = runner.takeover(task.id);
    await closeStarted;
    const cancellation = runner.cancel(task.id);
    releaseClose();
    await Promise.all([takeover, cancellation]);
    expect(store.require(task.id).status).toBe('cancelled');
    expect(store.events(task.id).at(-1)?.data.reason).toBe('user_cancel');
  });

  it('blocks the FIFO when takeover cannot confirm fake process cleanup', async () => {
    let started!: () => void;
    const promptStarted = new Promise<void>(resolve => { started = resolve; });
    const adapter = controlledAdapter(async () => { throw new Error('Unconfirmed close'); });
    const original = adapter.open;
    adapter.open = async (context, hooks) => ({ ...await original(context, hooks),
      prompt: async (_goal, signal) => {
        started();
        await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
        throw new EngineError('ABORTED', 'Stopped');
      },
    });
    const { store, runner } = fixture(adapter);
    const first = store.create({ commandId: 'takeover-close-error', goal: 'One' }).task;
    const second = store.create({ commandId: 'after-takeover-close-error', goal: 'Two' }).task;
    runner.enqueue(first.id); runner.enqueue(second.id);
    await promptStarted;
    await runner.takeover(first.id);
    await runner.idle();
    expect(runner.isBlocked).toBe(true);
    expect(store.require(first.id).status).toBe('interrupted');
    expect(store.require(second.id).status).toBe('queued');
  });

  it('persists a crashed ACP task as failed, retains redaction and then runs the next task', async () => {
    const { store, runner } = fixture(createFakeEngineAdapter());
    const failed = store.create({ commandId: 'fail', goal: 'fake:error' }).task;
    const good = store.create({ commandId: 'good', goal: 'Next task' }).task;
    runner.enqueue(failed.id); runner.enqueue(good.id);
    await runner.idle();
    expect(store.get(failed.id)?.status).toBe('failed');
    expect(store.get(good.id)?.status).toBe('completed');
    expect(JSON.stringify(store.snapshot(failed.id))).not.toContain('SECRET_TEST_TOKEN');
    expect(store.snapshot(failed.id).events.at(-1)?.data.reason).toBe('engine_execution_failed');
  });

  it('denies fake permission requests without a subscriber and records failure', async () => {
    const { store, runner } = fixture(createFakeEngineAdapter());
    const task = store.create({ commandId: 'deny', goal: 'fake:permission' }).task;
    runner.enqueue(task.id);
    await runner.idle();
    expect(store.get(task.id)?.status).toBe('failed');
    expect(store.events(task.id).some(e => e.type === 'engine.permission_denied')).toBe(true);
  });

  it('records work directory failure and allows the FIFO to finish without a background rejection', async () => {
    const { dir, store, runner } = fixture(controlledAdapter());
    writeFileSync(join(dir, 'tasks'), 'directory collision');
    const task = store.create({ commandId: 'directory', goal: 'Demo' }).task;
    runner.enqueue(task.id);
    await runner.idle();
    expect(store.get(task.id)?.status).toBe('failed');
    expect(store.get(task.id)?.activeAttemptId).toBeNull();
  });

  it('halts scheduling if cleanup is unconfirmed and preserves queued work', async () => {
    const { store, runner } = fixture(controlledAdapter(async () => { throw new Error('sensitive raw diagnostics'); }));
    const first = store.create({ commandId: 'cleanup-first', goal: 'Demo' }).task;
    const second = store.create({ commandId: 'cleanup-second', goal: 'Demo' }).task;
    runner.enqueue(first.id); runner.enqueue(second.id);
    await runner.idle();
    expect(runner.isBlocked).toBe(true);
    expect(store.get(first.id)?.status).toBe('interrupted');
    expect(store.events(first.id).at(-1)?.data.reason).toBe('engine_cleanup_failed');
    expect(store.get(second.id)?.status).toBe('queued');
    expect(JSON.stringify(store.snapshot(first.id))).not.toContain('sensitive raw');
  });

  it('dispatches a task enqueued during pump final settlement', async () => {
    let schedule: (() => void) | undefined;
    const { store, runner } = fixture(controlledAdapter(async () => { queueMicrotask(() => queueMicrotask(() => schedule?.())); }));
    const first = store.create({ commandId: 'settle-first', goal: 'One' }).task;
    const second = store.create({ commandId: 'settle-second', goal: 'Two' }).task;
    schedule = () => { schedule = undefined; runner.enqueue(second.id); };
    runner.enqueue(first.id);
    await runner.idle();
    expect(store.get(first.id)?.status).toBe('completed');
    expect(store.get(second.id)?.status).toBe('completed');
  });

  it('blocks a failed dispatch transaction and retains the queued task for recovery', async () => {
    const { store, runner } = fixture(controlledAdapter());
    const task = store.create({ commandId: 'start-fails', goal: 'One' }).task;
    vi.spyOn(store, 'start').mockImplementation(() => { throw new Error('simulated database failure'); });
    runner.enqueue(task.id);
    await runner.idle();
    expect(runner.isBlocked).toBe(true);
    expect(store.get(task.id)?.status).toBe('queued');
  });

  it('settles cancellation and blocks the queue when final persistence fails', async () => {
    let started!: () => void;
    const promptStarted = new Promise<void>(resolve => { started = resolve; });
    const adapter = controlledAdapter();
    const original = adapter.open;
    adapter.open = async (context, hooks) => ({ ...await original(context, hooks),
      prompt: async (_goal, signal) => {
        started();
        await new Promise<void>(resolve => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new EngineError('ABORTED', 'Cancelled');
      },
    });
    const { store, runner } = fixture(adapter);
    const first = store.create({ commandId: 'cancel-persistence', goal: 'One' }).task;
    const second = store.create({ commandId: 'cancel-queued', goal: 'Two' }).task;
    runner.enqueue(first.id); runner.enqueue(second.id);
    await promptStarted;
    const transition = vi.spyOn(store, 'transition').mockImplementation(() => { throw new Error('simulated persistence failure'); });
    try {
      await runner.cancel(first.id);
      await runner.idle();
      expect(runner.isBlocked).toBe(true);
      expect(store.get(second.id)?.status).toBe('queued');
    } finally { transition.mockRestore(); }
  });

  it('removes a queued cancellation before the preceding task finishes closing', async () => {
    let releaseClose!: () => void, closing!: () => void;
    const closeStarted = new Promise<void>(resolve => { closing = resolve; });
    const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
    const adapter = controlledAdapter(async () => { closing(); await closeGate; });
    const opened = vi.spyOn(adapter, 'open');
    const { store, runner } = fixture(adapter);
    const first = store.create({ commandId: 'first-close-gate', goal: 'One' }).task;
    const second = store.create({ commandId: 'queued-cancel', goal: 'Two' }).task;
    runner.enqueue(first.id); runner.enqueue(second.id);
    await closeStarted;
    const cancelled = runner.cancel(second.id);
    releaseClose();
    await cancelled;
    store.finishControl(second.id, { commandId: 'queued-cancel-control', action: 'cancel' });
    await runner.idle();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(store.get(first.id)?.status).toBe('completed');
    expect(store.get(second.id)?.status).toBe('cancelled');
  });

  it('keeps artifacts from a failed attempt without treating them as a new attempt delivery', async () => {
    const adapter = controlledAdapter();
    const { store, runner } = fixture(adapter);
    const task = store.create({ commandId: 'old-artifact', goal: 'One' }).task;
    const firstRun = store.start(task.id);
    store.addArtifact(task.id, firstRun.activeAttemptId!, { kind: 'markdown', name: 'Partial', content: 'old result' });
    store.transition(task.id, 'failed', firstRun.activeAttemptId!);
    store.transition(task.id, 'queued');
    const open = adapter.open;
    adapter.open = async (context, hooks) => ({ ...await open(context, hooks),
      prompt: async () => ({ stopReason: 'end_turn', text: '', artifacts: [] }),
    });
    runner.enqueue(task.id);
    await runner.idle();
    expect(store.get(task.id)?.status).toBe('failed');
    expect(store.artifacts(task.id)).toHaveLength(1);
    expect(store.artifacts(task.id)[0].attemptId).toBe(firstRun.activeAttemptId);
  });

  it('halts dispatch after startup reports unconfirmed process cleanup', async () => {
    const adapter = controlledAdapter();
    const open = vi.fn(async () => { throw new EngineError('CLEANUP_FAILED', 'Fixed diagnostic'); });
    adapter.open = open;
    const { store, runner } = fixture(adapter);
    const first = store.create({ commandId: 'startup-cleanup', goal: 'One' }).task;
    const second = store.create({ commandId: 'startup-queued', goal: 'Two' }).task;
    runner.enqueue(first.id); runner.enqueue(second.id);
    await runner.idle();
    expect(runner.isBlocked).toBe(true);
    expect(store.get(first.id)?.status).toBe('interrupted');
    expect(store.get(second.id)?.status).toBe('queued');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('runs FIFO with a maximum of one open session and only completes after close', async () => {
    const adapter = controlledAdapter();
    const original = adapter.open;
    let active = 0, maximum = 0;
    const order: string[] = [];
    adapter.open = async (context, hooks) => {
      order.push(context.taskId); maximum = Math.max(maximum, ++active);
      return { ...await original(context, hooks), close: async () => { active--; } };
    };
    const { store, runner } = fixture(adapter);
    const ids = ['one', 'two', 'three'].map(commandId => store.create({ commandId, goal: commandId }).task.id);
    ids.forEach(id => runner.enqueue(id));
    await runner.idle();
    expect(order).toEqual(ids);
    expect(maximum).toBe(1);
    expect(active).toBe(0);
    expect(ids.map(id => store.get(id)?.status)).toEqual(['completed', 'completed', 'completed']);
  });
});
