import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskEvent, TaskSnapshot } from '@personal-agent/contracts';
import {
  createTaskFeed,
  type EventSourceLike,
  type TaskFeed,
  type TaskFeedConnectionState,
} from '../src/task-feed';

const taskId = 'task /1';

function event(seq: number, id = taskId): TaskEvent {
  return {
    seq,
    taskId: id,
    attemptId: 'attempt-1',
    type: 'engine.message',
    data: { text: `event ${seq}` },
    createdAt: '2026-10-02T00:00:00.000Z',
  };
}

function snapshot(cursor = 1, status: TaskSnapshot['task']['status'] = 'running'): TaskSnapshot {
  return {
    task: {
      id: taskId,
      commandId: 'create-1',
      goal: 'Read-only feed test',
      status,
      deliveryStatus: 'pending',
      pauseRequested: false,
      activeAttemptId: status === 'running' ? 'attempt-1' : null,
      createdAt: '2026-10-02T00:00:00.000Z',
      updatedAt: `2026-10-02T00:00:${String(cursor).padStart(2, '0')}.000Z`,
    },
    cursor,
    events: cursor > 0 ? [event(cursor)] : [],
    artifacts: [],
    approvals: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeSource implements EventSourceLike {
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  readonly close = vi.fn();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data?: unknown): void {
    const incoming = data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(incoming);
  }

  emitRaw(data: string): void {
    for (const listener of this.listeners.get('task_event') ?? []) listener(new MessageEvent('task_event', { data }));
  }
}

const feeds: TaskFeed[] = [];

function setup(fetchSnapshot = vi.fn<(signal: AbortSignal) => Promise<TaskSnapshot>>().mockResolvedValue(snapshot())) {
  const sources: FakeSource[] = [];
  const snapshots: TaskSnapshot[] = [];
  const states: TaskFeedConnectionState[] = [];
  const errors: unknown[] = [];
  const feed = createTaskFeed({
    taskId,
    fetchSnapshot,
    onSnapshot: (value) => snapshots.push(value),
    onConnectionState: (value) => states.push(value),
    onError: (value) => errors.push(value),
    eventSourceFactory: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
  });
  feeds.push(feed);
  return { feed, fetchSnapshot, sources, snapshots, states, errors };
}

async function settle(): Promise<void> {
  // Flush the fetch, its single-flight finalizer, and any queued follow-up.
  for (let count = 0; count < 8; count += 1) await Promise.resolve();
}

describe('task snapshot and SSE feed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const feed of feeds.splice(0)) feed.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reads the initial snapshot before subscribing from its persisted cursor', async () => {
    const initial = deferred<TaskSnapshot>();
    const context = setup(vi.fn().mockReturnValue(initial.promise));
    expect(context.sources).toHaveLength(0);
    expect(context.states).toEqual(['connecting']);
    initial.resolve(snapshot(3));
    await settle();
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].url).toBe('/api/tasks/task%20%2F1/events?stream=1&after=3');
    expect(context.snapshots[0].cursor).toBe(3);
    context.sources[0].emit('open');
    expect(context.states).toEqual(['connecting', 'live']);
  });

  it('batches and deduplicates persisted events, retaining them through a lagging snapshot', async () => {
    const context = setup(vi.fn().mockResolvedValue(snapshot(3)));
    await settle();
    const source = context.sources[0];
    source.emit('open');
    source.emit('task_event', event(6));
    source.emit('task_event', event(4));
    source.emit('task_event', { ...event(6), data: { text: 'duplicate' } });
    expect(context.snapshots).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(150);
    const latest = context.snapshots.at(-1)!;
    expect(latest.events.map((value) => value.seq)).toEqual([3, 4, 6]);
    expect(latest.events.at(-1)!.data.text).toBe('event 6');
    expect(latest.cursor).toBe(6);
    expect(context.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(context.errors).toEqual([]);
  });

  it('bounds batching latency during a continuous event stream', async () => {
    const context = setup();
    await settle();
    context.sources[0].emit('open');
    context.sources[0].emit('task_event', event(2));
    await vi.advanceTimersByTimeAsync(100);
    context.sources[0].emit('task_event', event(3));
    await vi.advanceTimersByTimeAsync(50);
    expect(context.snapshots.at(-1)!.events.map((value) => value.seq)).toEqual([1, 2, 3]);
  });

  it('rejects foreign or malformed stream records without advancing the cursor', async () => {
    const context = setup();
    await settle();
    context.sources[0].emit('task_event', event(2, 'foreign-task'));
    context.sources[0].emit('task_event', event(0));
    context.sources[0].emit('task_event', { ...event(2), data: null });
    context.sources[0].emitRaw('{not-json');
    await vi.advanceTimersByTimeAsync(150);
    expect(context.errors).toHaveLength(4);
    expect(context.snapshots).toHaveLength(1);
    context.sources[0].emit('error');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(context.sources.at(-1)!.url).toContain('after=1');
  });

  it('never rolls task or approval state back to a snapshot with an older cursor', async () => {
    const current = snapshot(5, 'waiting_human');
    current.approvals = [{
      id: 'approval', taskId, attemptId: 'attempt-1', runId: 'run-1', title: 'Edit file',
      options: [], status: 'pending', createdAt: current.task.updatedAt, resolvedAt: null, selectedOptionId: null,
    }];
    const fetchSnapshot = vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(snapshot(3, 'failed'));
    const context = setup(fetchSnapshot);
    await settle();
    await context.feed.refresh();
    expect(context.snapshots.at(-1)!.task.status).toBe('waiting_human');
    expect(context.snapshots.at(-1)!.approvals).toEqual(current.approvals);
    expect(context.snapshots.at(-1)!.cursor).toBe(5);
    expect(context.snapshots.at(-1)!.events.map((value) => value.seq)).toEqual([3, 5]);
  });

  it('rejects snapshots for another task and inconsistent event cursors', async () => {
    const foreign = snapshot(2);
    foreign.task.id = 'foreign';
    const inconsistent = snapshot(1);
    inconsistent.events = [event(3)];
    const fetchSnapshot = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(foreign).mockResolvedValueOnce(inconsistent);
    const context = setup(fetchSnapshot);
    await settle();
    await context.feed.refresh();
    await context.feed.refresh();
    expect(context.snapshots).toHaveLength(1);
    expect(context.errors).toHaveLength(2);
    expect(context.snapshots[0].task.id).toBe(taskId);
  });

  it('coalesces overlapping refreshes into one dirty follow-up without concurrent fetches', async () => {
    const first = deferred<TaskSnapshot>();
    const second = deferred<TaskSnapshot>();
    const fetchSnapshot = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const context = setup(fetchSnapshot);
    const refreshA = context.feed.refresh();
    const refreshB = context.feed.refresh();
    expect(refreshA).toBe(refreshB);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    first.resolve(snapshot(1));
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    second.resolve(snapshot(2));
    await refreshA;
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(context.snapshots.at(-1)!.cursor).toBe(2);
  });

  it('retains events received during an outstanding snapshot and runs one follow-up', async () => {
    const pending = deferred<TaskSnapshot>();
    const fetchSnapshot = vi.fn()
      .mockResolvedValueOnce(snapshot(1))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(snapshot(3));
    const context = setup(fetchSnapshot);
    await settle();
    context.sources[0].emit('open');
    const refreshing = context.feed.refresh();
    context.sources[0].emit('task_event', event(5));
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(context.snapshots.at(-1)!.cursor).toBe(5);
    pending.resolve(snapshot(2));
    await refreshing;
    expect(fetchSnapshot).toHaveBeenCalledTimes(3);
    expect(context.snapshots.at(-1)!.events.map((value) => value.seq)).toEqual([1, 2, 3, 5]);
    expect(context.snapshots.slice(1).every((value) => value.cursor === 5)).toBe(true);
  });

  it('does not lose a refresh queued between snapshot publication and promise settlement', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(snapshot());
    let publishes = 0;
    let feed!: TaskFeed;
    feed = createTaskFeed({
      taskId,
      fetchSnapshot,
      onSnapshot: () => {
        publishes += 1;
        if (publishes === 2) queueMicrotask(() => { void feed.refresh(); });
      },
      eventSourceFactory: (url) => new FakeSource(url),
    });
    feeds.push(feed);
    await settle();
    await feed.refresh();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledTimes(3);
  });

  it('uses polling while reconnecting, then stops polling as soon as the new stream opens', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValueOnce(snapshot(1)).mockResolvedValue(snapshot(4));
    const context = setup(fetchSnapshot);
    await settle();
    const first = context.sources[0];
    first.emit('open');
    first.emit('task_event', event(3));
    first.emit('error');
    await settle();
    expect(first.close).toHaveBeenCalledOnce();
    expect(context.snapshots.at(-1)!.cursor).toBe(4);
    expect(context.states).toEqual(['connecting', 'live', 'polling']);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(context.sources).toHaveLength(2);
    expect(context.sources[1].url).toContain('after=4');
    expect(context.states.at(-1)).toBe('reconnecting');
    context.sources[1].emit('open');
    const fetchCount = fetchSnapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fetchSnapshot).toHaveBeenCalledTimes(fetchCount);
    expect(context.states.at(-1)).toBe('live');
  });

  it('flushes buffered events on disconnect and reconnects from the last seen sequence', async () => {
    const context = setup();
    await settle();
    context.sources[0].emit('open');
    context.sources[0].emit('task_event', event(7));
    context.sources[0].emit('error');
    await settle();
    expect(context.snapshots.at(-1)!.cursor).toBe(7);
    expect(context.snapshots.at(-1)!.events.map((value) => value.seq)).toEqual([1, 7]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(context.sources.at(-1)!.url).toContain('after=7');
  });

  it('leaves a waiting task and its pending approval unchanged across disconnect and disposal', async () => {
    const waiting = snapshot(3, 'waiting_human');
    waiting.task.activeAttemptId = 'attempt-1';
    waiting.approvals = [{
      id: 'approval', taskId, attemptId: 'attempt-1', runId: 'run-1', title: 'Edit fixture',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      status: 'pending', createdAt: waiting.task.updatedAt, resolvedAt: null, selectedOptionId: null,
    }];
    const original = JSON.stringify(waiting);
    const context = setup(vi.fn().mockResolvedValue(waiting));
    await settle();
    context.sources[0].emit('open');
    context.sources[0].emit('error');
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    context.feed.close();
    expect(context.snapshots.every((value) => value.task.status === 'waiting_human')).toBe(true);
    expect(context.snapshots.every((value) => value.approvals![0].status === 'pending')).toBe(true);
    expect(JSON.stringify(waiting)).toBe(original);
  });

  it('keeps polling and reconnecting after repeated stream failures', async () => {
    const context = setup();
    await settle();
    context.sources[0].emit('error');
    await vi.advanceTimersByTimeAsync(3_000);
    context.sources[1].emit('error');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(context.sources).toHaveLength(3);
    expect(context.fetchSnapshot.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(context.sources[0].close).toHaveBeenCalledOnce();
    expect(context.sources[1].close).toHaveBeenCalledOnce();
  });

  it('recovers an initial fetch failure before creating a stream', async () => {
    const context = setup(vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(snapshot(2)));
    await settle();
    expect(context.sources).toHaveLength(0);
    expect(context.states).toEqual(['connecting', 'polling']);
    expect(context.errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(context.snapshots.at(-1)!.cursor).toBe(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(context.sources.at(-1)!.url).toContain('after=2');
  });

  it('falls back to polling when EventSource is unavailable', async () => {
    vi.stubGlobal('EventSource', undefined);
    const fetchSnapshot = vi.fn().mockResolvedValue(snapshot());
    const snapshots: TaskSnapshot[] = [];
    const states: TaskFeedConnectionState[] = [];
    const feed = createTaskFeed({ taskId, fetchSnapshot, onSnapshot: (value) => snapshots.push(value), onConnectionState: (value) => states.push(value) });
    feeds.push(feed);
    await settle();
    expect(states).toEqual(['connecting', 'polling']);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(snapshots).toHaveLength(2);
  });

  it('recovers when construction of an event source fails', async () => {
    const sources: FakeSource[] = [];
    const factory = vi.fn((url: string) => {
      if (factory.mock.calls.length === 1) throw new Error('transport failed');
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    });
    const errors: unknown[] = [];
    const feed = createTaskFeed({ taskId, fetchSnapshot: vi.fn().mockResolvedValue(snapshot()), onSnapshot: () => undefined, eventSourceFactory: factory, onError: (error) => errors.push(error) });
    feeds.push(feed);
    await settle();
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toContain('after=1');
  });

  it('aborts and fences an old task request when a new feed replaces it', async () => {
    const old = deferred<TaskSnapshot>();
    const context = setup(vi.fn().mockReturnValue(old.promise));
    const signal = context.fetchSnapshot.mock.calls[0][0];
    context.feed.close();
    expect(signal.aborted).toBe(true);
    const next = setup(vi.fn().mockResolvedValue(snapshot(4)));
    await settle();
    old.resolve(snapshot(9, 'failed'));
    await settle();
    expect(context.snapshots).toEqual([]);
    expect(context.sources).toEqual([]);
    expect(context.errors).toEqual([]);
    expect(next.snapshots.at(-1)!.cursor).toBe(4);
  });

  it('removes listeners and timers and ignores late callbacks after close', async () => {
    const context = setup();
    await settle();
    const source = context.sources[0];
    const lateMessage = [...source.listeners.get('task_event')!][0];
    const lateOpen = [...source.listeners.get('open')!][0];
    const lateError = [...source.listeners.get('error')!][0];
    source.emit('task_event', event(2));
    context.feed.close();
    context.feed.close();
    lateMessage(new MessageEvent('task_event', { data: JSON.stringify(event(3)) }));
    lateOpen(new Event('open'));
    lateError(new Event('error'));
    await context.feed.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.close).toHaveBeenCalledOnce();
    expect([...source.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(context.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(context.snapshots).toHaveLength(1);
    expect(context.states).toEqual(['connecting']);
    expect(context.errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fences a pending refresh and suppresses its late rejection after close', async () => {
    const pending = deferred<TaskSnapshot>();
    const context = setup(vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(pending.promise));
    await settle();
    const refreshing = context.feed.refresh();
    context.feed.close();
    expect(context.fetchSnapshot.mock.calls[1][0].aborted).toBe(true);
    pending.reject(new Error('request ended after disposal'));
    await refreshing;
    expect(context.errors).toEqual([]);
    expect(context.snapshots).toHaveLength(1);
  });
});
