import { describe, expect, it } from 'vitest';
import {
  TASK_STATUSES,
  TaskStateError,
  assertCurrentAttempt,
  beginTaskAttempt,
  canTransitionTask,
  isActiveTaskStatus,
  requeueTask,
  requestTaskPause,
  transitionTask,
  updateTaskDelivery,
  type Task,
  type TaskStateErrorCode,
  type TaskStatus,
  type PipelineCheckpoint,
  type TaskConfigurationSnapshot,
} from '../src/index.js';

const CREATED = '2026-10-02T12:00:00.000Z';
const UPDATED = '2026-10-02T12:01:00.000Z';

function task(status: TaskStatus = 'queued', overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    commandId: 'command-1',
    goal: 'Verify the phase one fake engine flow',
    status,
    deliveryStatus: 'pending',
    pauseRequested: false,
    activeAttemptId: isActiveTaskStatus(status) ? 'attempt-1' : null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function expectConflict(action: () => unknown, code: TaskStateErrorCode): void {
  try {
    action();
    throw new Error('Expected a state conflict.');
  } catch (error) {
    expect(error).toBeInstanceOf(TaskStateError);
    expect(error).toMatchObject({ code, statusCode: 409 });
  }
}

describe('task transition matrix', () => {
  const allowed: Record<TaskStatus, TaskStatus[]> = {
    queued: ['running', 'paused', 'cancelled'],
    running: ['waiting_human', 'paused', 'interrupted', 'completed', 'failed', 'cancelled'],
    waiting_human: ['running', 'paused', 'interrupted', 'failed', 'cancelled'],
    paused: ['queued', 'running', 'cancelled'],
    interrupted: ['queued', 'running', 'paused', 'cancelled'],
    completed: ['queued', 'running'],
    failed: ['queued', 'running', 'cancelled'],
    cancelled: [],
  };

  for (const from of TASK_STATUSES) {
    for (const to of TASK_STATUSES) {
      it(`${from} → ${to} is ${allowed[from].includes(to) ? 'allowed' : 'rejected'}`, () => {
        expect(canTransitionTask(from, to)).toBe(allowed[from].includes(to));
        if (!allowed[from].includes(to)) {
          expectConflict(() => transitionTask(task(from), to), 'INVALID_TASK_TRANSITION');
        } else {
          const original = task(from, { deliveryStatus: from === 'completed' ? 'returned' : 'pending' });
          const snapshot = { ...original };
          const changed = to === 'running' && original.activeAttemptId === null
            ? beginTaskAttempt(original, 'attempt-2', UPDATED)
            : transitionTask(original, to, { now: UPDATED });
          expect(changed.status).toBe(to);
          expect(changed.updatedAt).toBe(UPDATED);
          expect(original).toEqual(snapshot);
        }
      });
    }
  }
});

describe('attempt lifecycle', () => {
  it('starts a queued task with exactly one active attempt without mutating the input', () => {
    const original = task();
    const started = beginTaskAttempt(original, 'attempt-1', UPDATED);
    expect(started).toMatchObject({
      status: 'running', activeAttemptId: 'attempt-1', updatedAt: UPDATED, createdAt: CREATED,
    });
    expect(original).toEqual(task());
    expectConflict(() => beginTaskAttempt(started, 'attempt-2'), 'ACTIVE_ATTEMPT_EXISTS');
  });

  it('cannot enter an active state without an attempt', () => {
    expectConflict(() => transitionTask(task(), 'running'), 'ATTEMPT_REQUIRED');
    expectConflict(() => beginTaskAttempt(task(), '  '), 'INVALID_ATTEMPT_ID');
  });

  it('retains the same attempt while waiting for a human and then continuing', () => {
    const waiting = transitionTask(task('running'), 'waiting_human', {
      attemptId: 'attempt-1', now: UPDATED,
    });
    expect(waiting.activeAttemptId).toBe('attempt-1');
    expect(transitionTask(waiting, 'running', { attemptId: 'attempt-1' }).activeAttemptId).toBe('attempt-1');
  });

  it.each(['paused', 'interrupted', 'completed', 'failed', 'cancelled'] as const)(
    '%s clears the active attempt and rejects late output',
    (status) => {
      const finished = transitionTask(task('running', { pauseRequested: true }), status, {
        attemptId: 'attempt-1', now: UPDATED,
      });
      expect(finished).toMatchObject({ status, activeAttemptId: null, pauseRequested: false, updatedAt: UPDATED });
      expectConflict(() => assertCurrentAttempt(finished, 'attempt-1'), 'STALE_ATTEMPT');
    },
  );

  it.each(['running', 'waiting_human'] as const)('stale attempt cannot change a %s task', (status) => {
    const original = task(status, { activeAttemptId: 'attempt-2' });
    expectConflict(() => transitionTask(original, 'failed', { attemptId: 'attempt-1' }), 'STALE_ATTEMPT');
    expect(original.status).toBe(status);
    assertCurrentAttempt(original, 'attempt-2');
    expectConflict(() => assertCurrentAttempt(original, ''), 'STALE_ATTEMPT');
  });

  it.each(['paused', 'interrupted', 'failed'] as const)('requeues %s without replaying its old attempt', (status) => {
    const queued = requeueTask(task(status), UPDATED);
    expect(queued).toMatchObject({ status: 'queued', activeAttemptId: null, updatedAt: UPDATED });
    const started = beginTaskAttempt(queued, 'attempt-2');
    expect(started.activeAttemptId).toBe('attempt-2');
    expectConflict(() => assertCurrentAttempt(started, 'attempt-1'), 'STALE_ATTEMPT');
  });

  it('interrupts both execution and approval waiting on restart', () => {
    for (const status of ['running', 'waiting_human'] as const) {
      const interrupted = transitionTask(task(status), 'interrupted');
      expect(interrupted).toMatchObject({ status: 'interrupted', activeAttemptId: null });
      expectConflict(() => assertCurrentAttempt(interrupted, 'attempt-1'), 'STALE_ATTEMPT');
    }
  });

  it('can finish an explicitly requested takeover after restart without creating an attempt', () => {
    const checkpoint: PipelineCheckpoint = {
      nextStage: 'verification', iteration: 0,
      analyses: { planner: 'Plan retained.', reviewer: 'Analysis retained.' },
    };
    const instructions = [{ id: 'instruction-1', commandId: 'feedback-1',
      requirements: 'Include one more fixture case.', createdAt: UPDATED }];
    const interrupted = task('interrupted', { checkpoint, instructions });
    const paused = transitionTask(interrupted, 'paused', { now: UPDATED });
    expect(paused).toMatchObject({ status: 'paused', activeAttemptId: null, pauseRequested: false,
      checkpoint, instructions });
    expect(interrupted.status).toBe('interrupted');
    expectConflict(() => assertCurrentAttempt(paused, 'attempt-1'), 'STALE_ATTEMPT');
    const resumed = beginTaskAttempt(paused, 'attempt-2');
    expect(resumed).toMatchObject({ status: 'running', activeAttemptId: 'attempt-2', checkpoint, instructions });
  });

  it('retains stage evidence, requirements, and task configuration across interruption and a fresh attempt', () => {
    const checkpoint: PipelineCheckpoint = {
      nextStage: 'review', iteration: 1,
      analyses: { planner: 'Planning artifact.', reviewer: 'Checking artifact.' },
      verificationIds: ['verification-1'],
      review: { verdict: 'rework', blockers: ['Existing test failed.'], evidence: ['Exit code 1.'] },
    };
    const configSnapshot: TaskConfigurationSnapshot = {
      settings: { defaultEngine: 'claude', agentRunTimeoutMs: 1_800_000, verificationTimeoutMs: 120_000,
        updatedAt: CREATED },
      profiles: {
        planner: { id: 'planner', name: 'Planner', role: 'planner', instructions: 'Write a plan.', updatedAt: CREATED },
        developer: { id: 'developer', name: 'Developer', role: 'developer', model: 'reported-model',
          instructions: 'Implement the plan.', updatedAt: CREATED },
        reviewer: { id: 'reviewer', name: 'Reviewer', role: 'reviewer', instructions: 'Review actual evidence.', updatedAt: CREATED },
      },
    };
    const instructions = [{ id: 'instruction-1', commandId: 'feedback-1',
      requirements: 'Preserve existing APIs.', createdAt: UPDATED }];
    const running = task('running', { checkpoint, instructions, configSnapshot, worktreePath: '/fixture/task-worktree' });
    const interrupted = transitionTask(running, 'interrupted', { attemptId: 'attempt-1' });
    const resumed = beginTaskAttempt(interrupted, 'attempt-2', UPDATED);
    expect(resumed).toMatchObject({ checkpoint, instructions, configSnapshot, worktreePath: '/fixture/task-worktree' });
    expectConflict(() => assertCurrentAttempt(resumed, 'attempt-1'), 'STALE_ATTEMPT');
  });

  it('cancelled tasks cannot restart or requeue', () => {
    expectConflict(() => beginTaskAttempt(task('cancelled'), 'attempt-2'), 'INVALID_TASK_TRANSITION');
    expectConflict(() => requeueTask(task('cancelled')), 'INVALID_TASK_TRANSITION');
  });
});

describe('pause requests', () => {
  it.each(['running', 'waiting_human'] as const)('requesting pause preserves %s until the stage stops', (status) => {
    const requested = requestTaskPause(task(status), UPDATED);
    expect(requested).toMatchObject({ status, pauseRequested: true, activeAttemptId: 'attempt-1' });
    const paused = transitionTask(requested, 'paused', { attemptId: 'attempt-1' });
    expect(paused).toMatchObject({ status: 'paused', pauseRequested: false, activeAttemptId: null });
  });

  it('pauses a queued task immediately because no engine is active', () => {
    expect(requestTaskPause(task(), UPDATED)).toMatchObject({
      status: 'paused', pauseRequested: false, activeAttemptId: null, updatedAt: UPDATED,
    });
  });

  it('keeps a deferred pause requested while the same stage waits for approval', () => {
    const requested = requestTaskPause(task('running'));
    const waiting = transitionTask(requested, 'waiting_human', { attemptId: 'attempt-1' });
    expect(waiting.pauseRequested).toBe(true);
    const running = transitionTask(waiting, 'running', { attemptId: 'attempt-1' });
    expect(running.pauseRequested).toBe(true);
    expect(transitionTask(running, 'paused').pauseRequested).toBe(false);
  });

  it.each(['paused', 'interrupted', 'completed', 'failed', 'cancelled'] as const)(
    'rejects a pause request for %s',
    (status) => expectConflict(() => requestTaskPause(task(status)), 'PAUSE_NOT_AVAILABLE'),
  );
});

describe('delivery is separate from execution', () => {
  it('completion creates a pending delivery, and accepting leaves execution completed', () => {
    const completed = transitionTask(task('running'), 'completed');
    expect(completed.deliveryStatus).toBe('pending');
    const accepted = updateTaskDelivery(completed, 'accepted', UPDATED);
    expect(accepted).toMatchObject({ status: 'completed', deliveryStatus: 'accepted', updatedAt: UPDATED });
    expectConflict(() => beginTaskAttempt(accepted, 'attempt-2'), 'INVALID_TASK_TRANSITION');
    expectConflict(() => updateTaskDelivery(accepted, 'returned'), 'INVALID_DELIVERY_TRANSITION');
  });

  it('requires the user to return completed work before creating a new attempt', () => {
    const completed = task('completed');
    expectConflict(() => beginTaskAttempt(completed, 'attempt-2'), 'INVALID_TASK_TRANSITION');
    expectConflict(() => requeueTask(completed), 'INVALID_TASK_TRANSITION');
    const returned = updateTaskDelivery(completed, 'returned');
    expect(returned).toMatchObject({ status: 'completed', deliveryStatus: 'returned' });
    const queued = requeueTask(returned, UPDATED);
    expect(queued).toMatchObject({ status: 'queued', deliveryStatus: 'pending', activeAttemptId: null });
    expect(beginTaskAttempt(queued, 'attempt-2').deliveryStatus).toBe('pending');
  });

  it('can dispatch a returned task directly when scheduling has already granted a slot', () => {
    const started = beginTaskAttempt(task('completed', { deliveryStatus: 'returned' }), 'attempt-2', UPDATED);
    expect(started).toMatchObject({ status: 'running', deliveryStatus: 'pending', activeAttemptId: 'attempt-2' });
  });

  it.each(TASK_STATUSES.filter((status) => status !== 'completed'))(
    'cannot accept or return a %s task',
    (status) => {
      for (const deliveryStatus of ['accepted', 'returned'] as const) {
        expectConflict(() => updateTaskDelivery(task(status), deliveryStatus), 'INVALID_DELIVERY_TRANSITION');
      }
    },
  );

  it('rejects pending-to-pending and repeated delivery actions', () => {
    expectConflict(() => updateTaskDelivery(task('completed'), 'pending'), 'INVALID_DELIVERY_TRANSITION');
    expectConflict(
      () => updateTaskDelivery(task('completed', { deliveryStatus: 'returned' }), 'returned'),
      'INVALID_DELIVERY_TRANSITION',
    );
  });
});
