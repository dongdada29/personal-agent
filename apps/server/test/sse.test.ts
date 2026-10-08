import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskEvent } from '@personal-agent/contracts';
import { createTaskEventStream, resolveEventCursor, type TaskEventSource } from '../src/sse.js';

class CommittedEvents implements TaskEventSource {
  readonly tasks = new Set(['task', 'other']);
  readonly rows: TaskEvent[] = [];
  readonly listeners = new Set<(event: TaskEvent) => void>();
  onSubscribe?: () => void;
  onRead?: () => void;
  reads = 0;
  require(id: string) {
    if (!this.tasks.has(id)) throw Object.assign(new Error('Missing task'), { statusCode: 404 });
  }
  events(id: string, after = 0, limit?: number): TaskEvent[] {
    this.reads++;
    const rows = this.rows.filter(event => event.taskId === id && event.seq > after).slice(0, limit);
    this.onRead?.();
    return rows;
  }
  latestEventSeq(id: string) { return this.rows.filter(event => event.taskId === id).at(-1)?.seq ?? 0; }
  subscribe(listener: (event: TaskEvent) => void) {
    this.listeners.add(listener);
    this.onSubscribe?.();
    return () => this.listeners.delete(listener);
  }
  commit(taskId = 'task', data: Record<string, unknown> = { text: 'durable message' }): TaskEvent {
    const event: TaskEvent = { seq: this.rows.length + 1, taskId, attemptId: 'attempt', type: 'engine.message', data,
      createdAt: '2026-10-02T00:00:00.000Z' };
    this.rows.push(event);
    this.publish(event);
    return event;
  }
  publish(event: TaskEvent) { for (const listener of this.listeners) listener(event); }
}

/** Actual Writable buffering/drain behavior; only HTTP header methods are stubs. */
class Response extends Writable {
  readonly headers = new Map<string, string>();
  readonly chunks: string[] = [];
  readonly callbacks: (() => void)[] = [];
  stalled: boolean;
  flushed = false;
  failAfter?: number;
  constructor(stalled = false, highWaterMark = 16_384) {
    super({ highWaterMark });
    this.stalled = stalled;
  }
  setHeader(name: string, value: string) { this.headers.set(name, value); }
  flushHeaders() { this.flushed = true; }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(chunk.toString());
    if (this.failAfter && this.chunks.length >= this.failAfter) callback(new Error('Closed socket'));
    else if (this.stalled) this.callbacks.push(callback);
    else callback();
  }
  release() {
    this.stalled = false;
    for (const callback of this.callbacks.splice(0)) callback();
  }
  ids(): number[] { return this.chunks.join('').split('\n').filter(line => line.startsWith('id: ')).map(line => Number(line.slice(4))); }
  messages(): TaskEvent[] { return this.chunks.join('').split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))); }
}

const apps: FastifyInstance[] = [];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function setup(store = new CommittedEvents(), options: Parameters<typeof createTaskEventStream>[2] = {}) {
  const app = Fastify();
  apps.push(app);
  const stream = createTaskEventStream(app, store, options);
  await app.ready();
  function connect(after?: unknown, lastEventId?: unknown, response = new Response(), taskId = 'task') {
    const raw = new EventEmitter();
    const request = { headers: lastEventId === undefined ? {} : { 'last-event-id': lastEventId }, raw } as unknown as FastifyRequest;
    const reply = { raw: response, hijack: vi.fn() } as unknown as FastifyReply;
    stream(request, reply, taskId, after);
    return { raw, response, reply };
  }
  return { app, store, stream, connect };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.close();
});

describe('durable task SSE', () => {
  it('uses the newer header/query cursor and rejects ambiguous or unsafe input', () => {
    expect(resolveEventCursor()).toBe(0);
    expect(resolveEventCursor('8', '11')).toBe(11);
    expect(resolveEventCursor('12', '11')).toBe(12);
    expect(resolveEventCursor(0, '0')).toBe(0);
    expect(resolveEventCursor(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of [-1, 1.2, NaN, Infinity, '', '01', ' 1', '1e2', '+1', '9007199254740992', ['1'], null]) {
      expect(() => resolveEventCursor(value)).toThrow('non-negative safe integer');
      expect(() => resolveEventCursor(0, value)).toThrow('non-negative safe integer');
    }
  });

  it('validates task and cursor before hijacking the response and removes rejected subscriptions', async () => {
    const { connect, store } = await setup();
    store.commit();
    const response = new Response();
    expect(() => connect('2', undefined, response)).toThrow('ahead');
    expect(response.flushed).toBe(false);
    expect(response.chunks).toEqual([]);
    expect(store.listeners.size).toBe(0);
    expect(() => connect('-1', undefined, response)).toThrow('non-negative');
    expect(() => connect(0, undefined, response, 'missing')).toThrow('Missing task');
    expect(store.listeners.size).toBe(0);
  });

  it('replays persisted IDs with global gaps and appends live committed events without other tasks', async () => {
    const { connect, store } = await setup();
    const first = store.commit();
    store.commit('other');
    const third = store.commit();
    const { response, reply } = connect();
    const fourth = store.commit();
    store.commit('other');
    expect(reply.hijack).toHaveBeenCalledOnce();
    expect(response.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(response.chunks[0]).toBe('retry: 1000\n\n');
    expect(response.ids()).toEqual([1, 3, 4]);
    expect(response.messages()).toEqual([first, third, fourth]);
  });

  it('includes a commit between a snapshot cursor and subscribing, including a commit during subscribe', async () => {
    const { connect, store } = await setup();
    store.commit();
    const snapshotCursor = store.latestEventSeq('task');
    const between = store.commit();
    let during: TaskEvent;
    store.onSubscribe = () => { store.onSubscribe = undefined; during = store.commit(); };
    const { response } = connect(snapshotCursor);
    expect(response.messages()).toEqual([between, during!]);
  });

  it('does not reorder or lose a commit made during an old replay read', async () => {
    const { connect, store } = await setup();
    const first = store.commit();
    store.onRead = () => {
      expect(store.listeners.size).toBe(1);
      store.onRead = undefined;
      store.commit();
    };
    const { response } = connect();
    expect(response.ids()).toEqual([1, 2]);
    expect(response.messages()[0]).toEqual(first);
  });

  it('rechecks a notification arriving after an empty replay result and ignores duplicate notifications', async () => {
    const { connect, store } = await setup();
    store.onRead = () => { store.onRead = undefined; store.commit(); };
    const { response } = connect();
    await tick();
    const event = store.rows[0];
    store.publish(event);
    store.publish(event);
    expect(response.ids()).toEqual([1]);
  });

  it('reconnects from Last-Event-ID after disconnect without replaying received records', async () => {
    const { connect, store } = await setup();
    store.commit();
    store.commit();
    const first = connect();
    first.response.destroy();
    await tick();
    expect(store.listeners.size).toBe(0);
    store.commit();
    store.commit('other');
    store.commit();
    const next = connect('0', '2');
    expect(next.response.ids()).toEqual([3, 5]);
    expect(store.rows).toHaveLength(5);
  });

  it('does not accumulate live notifications or heartbeat bytes behind a blocked writable', async () => {
    const { connect, store } = await setup(undefined, { heartbeatMs: 10, replayBatchSize: 20, maxBufferBytes: 512 });
    vi.useFakeTimers();
    const response = new Response(true, 1);
    connect(undefined, undefined, response);
    for (let index = 0; index < 250; index++) store.commit();
    vi.advanceTimersByTime(10_000);
    expect(response.chunks).toEqual(['retry: 1000\n\n']);
    expect(response.writableLength).toBe(Buffer.byteLength('retry: 1000\n\n'));
    expect(store.reads).toBe(0);
    vi.useRealTimers();
    response.release();
    for (let index = 0; index < 20; index++) await tick();
    expect(response.ids()).toEqual(store.rows.map(event => event.seq));
    expect(store.listeners.size).toBe(1);
  });

  it('closes an oversized response safely so the client can replay it from the DB', async () => {
    const store = new CommittedEvents();
    const event = store.commit('task', { text: 'x'.repeat(500) });
    const limited = await setup(store, { maxBufferBytes: 256 });
    const first = limited.connect();
    expect(first.response.destroyed).toBe(true);
    expect(first.response.ids()).toEqual([]);
    expect(store.listeners.size).toBe(0);
    const next = await setup(store);
    expect(next.connect().response.messages()).toEqual([event]);
    expect(store.rows).toEqual([event]);
  });

  it('cleans subscriptions, drain listeners and heartbeat timers after request abort', async () => {
    const { connect, store } = await setup(undefined, { heartbeatMs: 10 });
    vi.useFakeTimers();
    const { raw, response } = connect();
    vi.advanceTimersByTime(10);
    expect(response.chunks.at(-1)).toBe(': heartbeat\n\n');
    raw.emit('aborted');
    expect(store.listeners.size).toBe(0);
    expect(response.listenerCount('drain')).toBe(0);
    expect(raw.listenerCount('aborted')).toBe(0);
    const count = response.chunks.length;
    vi.advanceTimersByTime(100);
    expect(response.chunks).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('contains writable errors and allows the durable producer to continue', async () => {
    const { connect, store } = await setup();
    const response = new Response();
    response.failAfter = 2;
    connect(undefined, undefined, response);
    expect(() => store.commit()).not.toThrow();
    await tick();
    expect(store.listeners.size).toBe(0);
    expect(response.destroyed).toBe(true);
    expect(() => store.commit()).not.toThrow();
    expect(store.rows).toHaveLength(2);
  });

  it('ends active and blocked connections in preClose and rejects new ones during shutdown', async () => {
    const { app, connect, store } = await setup();
    const first = connect();
    const second = connect(undefined, undefined, new Response(true, 1));
    expect(store.listeners.size).toBe(2);
    await app.close();
    expect(first.response.destroyed).toBe(true);
    expect(second.response.destroyed).toBe(true);
    expect(store.listeners.size).toBe(0);
    expect(() => connect()).toThrow('Service is closing');
  });

  it('serves a real Fastify streamed response and reconnects after its HTTP response closes', async () => {
    const store = new CommittedEvents();
    const first = store.commit();
    const app = Fastify();
    apps.push(app);
    const stream = createTaskEventStream(app, store);
    app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/tasks/:id/events', (request, reply) => {
      stream(request, reply, request.params.id, request.query.after);
    });
    const response = await app.inject({ url: '/tasks/task/events', payloadAsStream: true });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    const chunks: string[] = [];
    const payload = response.stream();
    payload.on('data', chunk => chunks.push(chunk.toString()));
    payload.on('error', () => {}); // An intentionally closed HTTP stream is expected.
    await tick();
    expect(chunks.join('')).toContain(`data: ${JSON.stringify(first)}\n\n`);
    response.raw.res.destroy();
    await tick();
    expect(store.listeners.size).toBe(0);
    const next = store.commit();
    const replay = await app.inject({ url: '/tasks/task/events?after=0', headers: { 'last-event-id': '1' }, payloadAsStream: true });
    const replayChunks: string[] = [];
    const replayPayload = replay.stream();
    replayPayload.on('data', chunk => replayChunks.push(chunk.toString()));
    replayPayload.on('error', () => {});
    await tick();
    expect(replayChunks.join('')).not.toContain('id: 1\n');
    expect(replayChunks.join('')).toContain(`data: ${JSON.stringify(next)}\n\n`);
    await app.close();
    await tick();
    expect(store.listeners.size).toBe(0);
    expect(replayPayload.destroyed).toBe(true);
  });
});
