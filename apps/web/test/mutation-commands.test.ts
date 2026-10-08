import { describe, expect, it } from 'vitest';
import type { Task } from '@personal-agent/contracts';
import { availableTaskActions, controlCommand, MutationCommands, MutationFlight, TaskMutationCommands, taskVersion } from '../src/mutation-commands';

const task: Task = { id: 'task', commandId: 'create', goal: 'Goal', status: 'failed', deliveryStatus: 'pending', pauseRequested: false, activeAttemptId: null, createdAt: 't1', updatedAt: 't2' };

describe('browser mutation commands', () => {
  it('replays an unacknowledged feedback after SSE updates, but isolates a new attempt and changed requirements', () => {
    let number = 0;
    const cache = new TaskMutationCommands(() => `command-${++number}`);
    const before = { ...task, status: 'running' as const, activeAttemptId: 'attempt-1' };
    const payload = { action: 'feedback', requirements: 'Keep this requirement once' };
    const key = cache.taskKey(before, payload);
    const commandId = cache.id(key);
    cache.unacknowledged(before, payload, key);
    const streamed = { ...before, updatedAt: 't3', status: 'paused' as const };
    expect(cache.id(cache.taskKey(streamed, payload))).toBe(commandId);
    expect(cache.id(cache.taskKey({ ...streamed, activeAttemptId: 'attempt-2' }, payload))).not.toBe(commandId);
    expect(cache.id(cache.taskKey(streamed, { ...payload, requirements: 'Changed request' }))).not.toBe(commandId);
    cache.acknowledged(before, payload, key);
    expect(cache.id(cache.taskKey(streamed, payload))).not.toBe(commandId);
  });
  it('reuses a failed request command and gives the next attempt or changed requirements a new id', () => {
    let number = 0;
    const cache = new MutationCommands(() => `command-${++number}`);
    const key = cache.key('task:task', { action: 'retry' }, taskVersion(task));
    expect(cache.id(key)).toBe(cache.id(key));
    expect(cache.id(cache.key('task:task', { action: 'retry' }, taskVersion({ ...task, updatedAt: 't3' })))).not.toBe(cache.id(key));
    expect(cache.id(cache.key('task:task', { action: 'return', requirements: 'A' }, taskVersion(task)))).not.toBe(cache.id(cache.key('task:task', { action: 'return', requirements: 'B' }, taskVersion(task))));
    cache.complete(key);
    expect(cache.id(key)).toBe('command-5');
  });

  it('starts only one mutation when handlers fire before a React rerender and releases on rejection', async () => {
    const flight = new MutationFlight();
    let release!: () => void;
    let calls = 0;
    const first = flight.run(async () => { calls++; await new Promise<void>((resolve) => { release = resolve; }); });
    expect(flight.isRunning).toBe(true);
    await flight.run(async () => { calls++; });
    expect(calls).toBe(1);
    release();
    await first;
    await expect(flight.run(async () => { throw new Error('network'); })).rejects.toThrow('network');
    expect(flight.isRunning).toBe(false);
  });
});

describe('task controls', () => {
  it('requires return feedback, trims requirements, and omits forbidden fields from other controls', () => {
    expect(() => controlCommand('return', 'c1', ' ')).toThrow();
    expect(() => controlCommand('feedback', 'c1')).toThrow();
    expect(controlCommand('return', 'c1', ' 修复验证 ')).toEqual({ commandId: 'c1', action: 'return', requirements: '修复验证' });
    expect(controlCommand('takeover', 'c2', ' ')).toEqual({ commandId: 'c2', action: 'takeover' });
    expect(controlCommand('takeover', 'c3', ' 保留已有修改 ')).toEqual({ commandId: 'c3', action: 'takeover', requirements: '保留已有修改' });
    for (const action of ['pause', 'resume', 'retry', 'cancel', 'accept'] as const) {
      expect(controlCommand(action, 'c4', 'unused draft')).toEqual({ commandId: 'c4', action });
    }
  });
  it('allows waiting approval to be interrupted but never retries the permission request', () => {
    expect(availableTaskActions({ ...task, status: 'waiting_human', activeAttemptId: 'attempt' }, true)).toEqual(['feedback', 'pause', 'takeover', 'cancel']);
    expect(availableTaskActions({ ...task, status: 'waiting_human' }, false)).toContain('retry');
  });

  it('allows receipts only for pending completed deliveries and keeps execution completed after acceptance', () => {
    expect(availableTaskActions({ ...task, status: 'completed' }, false)).toEqual(['accept', 'return']);
    expect(availableTaskActions({ ...task, status: 'completed', deliveryStatus: 'accepted' }, false)).toEqual([]);
    expect(availableTaskActions({ ...task, status: 'cancelled' }, false)).toEqual([]);
  });

  it('offers explicit resume for paused and interrupted tasks and does not repeat pause intents', () => {
    expect(availableTaskActions({ ...task, status: 'paused' }, false)).toContain('resume');
    expect(availableTaskActions({ ...task, status: 'interrupted' }, false)).toEqual(['feedback', 'resume', 'retry', 'cancel']);
    expect(availableTaskActions({ ...task, status: 'running', pauseRequested: true }, false)).not.toContain('pause');
  });
});
