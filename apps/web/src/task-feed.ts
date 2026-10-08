import type { TaskEvent, TaskSnapshot } from '@personal-agent/contracts';

export type TaskFeedConnectionState = 'connecting' | 'live' | 'reconnecting' | 'polling';

/** Small structural interface so the feed also works with an injected transport. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export interface TaskFeedOptions {
  taskId: string;
  fetchSnapshot: (signal: AbortSignal) => Promise<TaskSnapshot>;
  onSnapshot: (snapshot: TaskSnapshot) => void;
  onConnectionState?: (state: TaskFeedConnectionState) => void;
  onError?: (error: unknown) => void;
  eventSourceFactory?: (url: string) => EventSourceLike;
  debounceMs?: number;
  pollIntervalMs?: number;
  reconnectIntervalMs?: number;
}

export interface TaskFeed {
  /** Coalesces concurrent requests and resolves after their queued follow-up. */
  refresh(): Promise<void>;
  /** Stops this reader only; it never sends a task or approval command. */
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTaskEvent(value: unknown, taskId: string): value is TaskEvent {
  return isRecord(value)
    && value.taskId === taskId
    && typeof value.seq === 'number' && Number.isSafeInteger(value.seq) && value.seq > 0
    && (value.attemptId === null || typeof value.attemptId === 'string')
    && typeof value.type === 'string'
    && isRecord(value.data)
    && typeof value.createdAt === 'string';
}

function assertSnapshot(snapshot: TaskSnapshot, taskId: string): void {
  if (
    !isRecord(snapshot) || !isRecord(snapshot.task) || snapshot.task.id !== taskId
    || !Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < 0
    || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.artifacts)
    || snapshot.events.some((event) => !isTaskEvent(event, taskId) || event.seq > snapshot.cursor)
  ) {
    throw new Error('Received an invalid snapshot for this task.');
  }
}

/**
 * Read one task using an authoritative snapshot followed by persisted SSE replay.
 * Events are merged by sequence; a lagging response cannot remove streamed evidence
 * or replace a newer snapshot's task/approval state. All requests share one flight.
 */
export function createTaskFeed(options: TaskFeedOptions): TaskFeed {
  const { taskId } = options;
  const debounceMs = Math.max(0, options.debounceMs ?? 150);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 3_000);
  const reconnectIntervalMs = Math.max(1, options.reconnectIntervalMs ?? pollIntervalMs);
  const factory = options.eventSourceFactory ?? (
    typeof EventSource === 'undefined' ? undefined : (url: string) => new EventSource(url)
  );

  let closed = false;
  let generation = 0;
  let snapshot: TaskSnapshot | undefined;
  let snapshotCursor = -1;
  let cursor = 0;
  const events = new Map<number, TaskEvent>();
  let state: TaskFeedConnectionState | undefined;
  let source: EventSourceLike | undefined;
  let disposeSource: (() => void) | undefined;
  let hasConnected = false;
  let flight: Promise<void> | undefined;
  let dirty = false;
  let requestController: AbortController | undefined;
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  function setState(next: TaskFeedConnectionState): void {
    if (!closed && state !== next) {
      state = next;
      options.onConnectionState?.(next);
    }
  }

  function report(error: unknown): void {
    if (!closed) options.onError?.(error);
  }

  function publish(): void {
    if (closed || !snapshot) return;
    options.onSnapshot({
      ...snapshot,
      events: [...events.values()].sort((left, right) => left.seq - right.seq),
      cursor,
    });
  }

  function mergeSnapshot(next: TaskSnapshot): void {
    assertSnapshot(next, taskId);
    for (const event of next.events) {
      if (!events.has(event.seq)) events.set(event.seq, event);
    }
    cursor = Math.max(cursor, next.cursor);
    if (
      next.cursor > snapshotCursor
      || (next.cursor === snapshotCursor && (!snapshot || next.task.updatedAt >= snapshot.task.updatedAt))
    ) {
      snapshot = next;
      snapshotCursor = next.cursor;
    }
    publish();
  }

  function stopSource(): void {
    disposeSource?.();
    disposeSource = undefined;
    source = undefined;
  }

  function schedulePoll(): void {
    if (closed || pollTimer !== undefined) return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      if (closed || state === 'live') return;
      void refresh();
      schedulePoll();
    }, pollIntervalMs);
  }

  function scheduleReconnect(): void {
    if (closed || !factory || reconnectTimer !== undefined) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (closed || source) return;
      if (snapshot) connect();
      else scheduleReconnect();
    }, reconnectIntervalMs);
  }

  function fallback(): void {
    setState('polling');
    schedulePoll();
    scheduleReconnect();
  }

  function connect(): void {
    if (closed || source || !snapshot) return;
    if (!factory) {
      fallback();
      return;
    }
    setState(hasConnected ? 'reconnecting' : 'connecting');
    hasConnected = true;
    const sourceGeneration = generation;
    let current: EventSourceLike;
    try {
      current = factory(`/api/tasks/${encodeURIComponent(taskId)}/events?stream=1&after=${cursor}`);
    } catch (error) {
      report(error);
      fallback();
      return;
    }
    source = current;
    const isCurrent = () => !closed && generation === sourceGeneration && source === current;
    const open = () => {
      if (!isCurrent()) return;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      pollTimer = reconnectTimer = undefined;
      setState('live');
    };
    const message = (event: Event) => {
      if (!isCurrent()) return;
      try {
        const value: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (!isTaskEvent(value, taskId)) throw new Error('Received an invalid persisted task event.');
        if (events.has(value.seq)) return;
        events.set(value.seq, value);
        cursor = Math.max(cursor, value.seq);
        // Batch at a bounded cadence: a continuous token stream cannot starve rendering.
        if (eventTimer === undefined) {
          eventTimer = setTimeout(() => {
            eventTimer = undefined;
            if (!isCurrent()) return;
            publish();
            void refresh();
          }, debounceMs);
        }
      } catch (error) {
        report(error);
      }
    };
    const error = () => {
      if (!isCurrent()) return;
      stopSource();
      // Buffered persisted events survive disconnect even before their batch was rendered.
      if (eventTimer !== undefined) clearTimeout(eventTimer);
      eventTimer = undefined;
      publish();
      report(new Error('Task event stream disconnected; reconnecting with snapshot polling.'));
      fallback();
      void refresh();
    };
    current.addEventListener('open', open);
    current.addEventListener('task_event', message);
    current.addEventListener('error', error);
    disposeSource = () => {
      current.removeEventListener('open', open);
      current.removeEventListener('task_event', message);
      current.removeEventListener('error', error);
      current.close();
    };
  }

  function refresh(): Promise<void> {
    if (closed) return Promise.resolve();
    if (flight) {
      dirty = true;
      return flight;
    }
    const requestGeneration = generation;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    flight = promise;
    void (async () => {
      try {
        do {
          dirty = false;
          const controller = new AbortController();
          requestController = controller;
          try {
            const next = await options.fetchSnapshot(controller.signal);
            if (closed || generation !== requestGeneration) return;
            mergeSnapshot(next);
            if (!source && reconnectTimer === undefined) connect();
          } catch (error) {
            if (closed || generation !== requestGeneration || controller.signal.aborted) return;
            report(error);
            if (!source) fallback();
          } finally {
            if (requestController === controller) requestController = undefined;
          }
        } while (dirty && !closed && generation === requestGeneration);
      } finally {
        // Clear the flight before promise settlement: a refresh queued by a
        // snapshot callback must start a new request, rather than be lost.
        if (flight === promise) flight = undefined;
      }
    })().then(resolve, reject);
    return promise;
  }

  setState('connecting');
  void refresh();

  return {
    refresh,
    close() {
      if (closed) return;
      closed = true;
      generation += 1;
      requestController?.abort();
      stopSource();
      if (eventTimer !== undefined) clearTimeout(eventTimer);
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      eventTimer = pollTimer = reconnectTimer = undefined;
      dirty = false;
    },
  };
}
