import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TaskEvent } from '@personal-agent/contracts';

/** Notifications are emitted only after their database transaction commits. */
export interface TaskEventSource {
  require(taskId: string): unknown;
  events(taskId: string, after?: number, limit?: number): TaskEvent[];
  latestEventSeq(taskId: string): number;
  subscribe(listener: (event: TaskEvent) => void): () => void;
}

/** Authentication state stays outside event frames and transport diagnostics. */
export interface StreamAuthorization {
  expiresAt: number;
  isValid: () => boolean;
  subscribeInvalidation: (close: () => void) => () => void;
}

export interface TaskEventStreamOptions {
  heartbeatMs?: number;
  reconnectMs?: number;
  /** Includes bytes already accepted into the response's writable buffer. */
  maxBufferBytes?: number;
  /** Yield to other tasks while replaying a long history. */
  replayBatchSize?: number;
  /** Undefined preserves the unauthenticated local demo transport. */
  authorize?: (request: FastifyRequest) => StreamAuthorization | undefined;
}

// Node clamps a larger delay to 1 ms. Long leases must re-arm in segments.
const MAX_TIMER_DELAY = 2_147_483_647;
const authRequired = () => Object.assign(new Error('Stream authorization is required'), {
  statusCode: 401, code: 'AUTH_REQUIRED',
});

function cursor(value: unknown): number {
  if (value === undefined) return 0;
  if ((typeof value !== 'string' && typeof value !== 'number') ||
      !/^(0|[1-9][0-9]*)$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw Object.assign(new Error('Event cursor must be a non-negative safe integer'), {
      statusCode: 400, code: 'INVALID_EVENT_CURSOR',
    });
  }
  return Number(value);
}

/** A browser reconnect header can be newer than its original after query. */
export function resolveEventCursor(after?: unknown, lastEventId?: unknown): number {
  return Math.max(cursor(after), cursor(lastEventId));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

/**
 * The caller keeps existing authentication/origin checks and JSON event replay.
 * Hijacked responses are ended in preClose, before Fastify waits for connections.
 */
export function createTaskEventStream(app: FastifyInstance, store: TaskEventSource, options: TaskEventStreamOptions = {}) {
  const heartbeatMs = positiveInteger(options.heartbeatMs ?? 15_000, 'heartbeatMs');
  const reconnectMs = positiveInteger(options.reconnectMs ?? 1_000, 'reconnectMs');
  const maxBufferBytes = positiveInteger(options.maxBufferBytes ?? 262_144, 'maxBufferBytes');
  const replayBatchSize = positiveInteger(options.replayBatchSize ?? 100, 'replayBatchSize');
  const connections = new Set<() => void>();
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
    for (const close of [...connections]) close();
  });

  return function streamTaskEvents(request: FastifyRequest, reply: FastifyReply, taskId: string, after?: unknown): void {
    if (closing) throw Object.assign(new Error('Service is closing'), { statusCode: 503, code: 'SERVER_CLOSING' });
    const authorization = options.authorize?.(request);
    function leaseValid(): boolean {
      if (!authorization) return true;
      try {
        const expiresAt = authorization.expiresAt;
        return Number.isFinite(expiresAt) && Date.now() < expiresAt && authorization.isValid() && Date.now() < expiresAt;
      }
      catch { return false; }
    }
    if (!leaseValid()) throw authRequired();
    store.require(taskId);
    let lastWrittenSeq = resolveEventCursor(after, request.headers['last-event-id']);
    let ready = false;
    let closed = false;
    let pumping = false;
    let dirty = false;
    let backpressured = false;
    let scheduled: NodeJS.Immediate | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let expiryTimer: NodeJS.Timeout | undefined;
    let hijacked = false;
    const response = reply.raw;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeAuthorization: (() => void) | undefined;

    const close = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (expiryTimer) clearTimeout(expiryTimer);
      if (scheduled) clearImmediate(scheduled);
      try { unsubscribe?.(); } catch { /* transport cleanup must still finish */ }
      unsubscribe = undefined;
      try { unsubscribeAuthorization?.(); } catch { /* authorization cleanup must not retain the transport */ }
      unsubscribeAuthorization = undefined;
      connections.delete(close);
      response.off('drain', onDrain);
      response.off('close', close);
      response.off('error', close);
      request.raw.off('aborted', close);
      // A blocked peer must not hold app.close() open or retain queued bytes.
      // Before hijack Fastify still owns the response and can send a 401.
      if (hijacked) response.destroy();
    };

    function authorized(): boolean {
      if (closed) return false;
      if (!leaseValid()) { close(); return false; }
      // isValid can itself trigger a synchronous invalidation callback.
      return !closed;
    }

    function scheduleExpiry(): void {
      if (!authorization || !authorized()) return;
      let remaining: number;
      try { remaining = authorization.expiresAt - Date.now(); }
      catch { close(); return; }
      if (!Number.isFinite(remaining) || remaining <= 0) { close(); return; }
      expiryTimer = setTimeout(() => {
        expiryTimer = undefined;
        if (authorized()) scheduleExpiry();
      }, Math.min(MAX_TIMER_DELAY, Math.max(1, Math.ceil(remaining))));
      expiryTimer.unref();
    }

    function write(frame: string): boolean {
      if (!authorized()) return false;
      if (closed || response.destroyed || response.writableEnded) { close(); return false; }
      const bytes = Buffer.byteLength(frame);
      if (bytes + response.writableLength > maxBufferBytes) { close(); return false; }
      try {
        const writable = response.write(frame);
        if (!writable) backpressured = true;
        return true; // A false write result still accepted this frame into Node's buffer.
      } catch { close(); return false; }
    }

    function schedulePump() {
      if (!authorized() || !ready || backpressured || scheduled) return;
      scheduled = setImmediate(() => { scheduled = undefined; pump(); });
    }

    function pump() {
      if (!authorized() || !ready || backpressured) return;
      if (pumping) { dirty = true; return; }
      pumping = true;
      dirty = false;
      let count = 0;
      try {
        while (authorized() && !backpressured && count < replayBatchSize) {
          // One durable record at a time bounds replay memory and preserves seq
          // order even when a commit notification arrives during this read.
          const event = store.events(taskId, lastWrittenSeq, 1)[0];
          if (!event) break;
          if (event.taskId !== taskId || !Number.isSafeInteger(event.seq) || event.seq <= lastWrittenSeq) {
            close(); break;
          }
          const frame = `id: ${event.seq}\nevent: task_event\ndata: ${JSON.stringify(event)}\n\n`;
          if (!write(frame)) break;
          lastWrittenSeq = event.seq;
          count++;
        }
      } catch { close(); }
      finally { pumping = false; }
      if (count === replayBatchSize || dirty) schedulePump();
    }

    function onDrain() { backpressured = false; pump(); }

    try {
      // Revocation is observed before any durable event replay. A lease may
      // invalidate synchronously while registering its callback; in that case
      // clean the returned subscription even though close ran before assignment.
      if (authorization) {
        let release: () => void;
        try { release = authorization.subscribeInvalidation(close); }
        catch { close(); throw authRequired(); }
        if (closed) { try { release(); } catch { /* already closed */ } }
        else unsubscribeAuthorization = release;
        if (!authorized()) throw authRequired();
        scheduleExpiry();
      }
      // Subscribe first: a commit between a snapshot read and this request, or
      // during replay itself, remains available in the authoritative DB cursor.
      const release = store.subscribe(event => {
        if (!authorized() || event.taskId !== taskId || event.seq <= lastWrittenSeq) return;
        if (!ready || pumping) { dirty = true; return; }
        pump();
      });
      if (closed) { try { release(); } catch { /* already closed */ } }
      else unsubscribe = release;
      if (!authorized()) throw authRequired();
      const latestSeq = store.latestEventSeq(taskId);
      if (!authorized()) throw authRequired();
      if (lastWrittenSeq > latestSeq) {
        throw Object.assign(new Error('Event cursor is ahead of this task; refresh its snapshot'), {
          statusCode: 409, code: 'EVENT_CURSOR_AHEAD',
        });
      }
    } catch (error) { close(); throw error; }

    response.on('drain', onDrain);
    response.on('close', close);
    response.on('error', close);
    request.raw.on('aborted', close);
    connections.add(close);
    try {
      // Fastify's security/origin hooks set headers on Reply before the route
      // hijacks it. Preserve those headers when switching to the raw stream.
      if (typeof reply.getHeaders === 'function') {
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) response.setHeader(name, value);
        }
      }
      if (!authorized()) throw authRequired();
      reply.hijack();
      hijacked = true;
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', authorization ? 'no-store, no-transform' : 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders();
    }
    catch (error) {
      close();
      if (!hijacked && (error as { code?: string }).code === 'AUTH_REQUIRED') throw error;
      return;
    }
    ready = true;
    if (!write(`retry: ${reconnectMs}\n\n`)) return;
    pump();
    if (closed) return;
    heartbeat = setInterval(() => {
      // Heartbeats never accumulate behind an already blocked event write.
      if (authorized() && !backpressured) write(': heartbeat\n\n');
    }, heartbeatMs);
    heartbeat.unref();
  };
}
