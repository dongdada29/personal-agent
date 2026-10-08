import { EventEmitter } from 'node:events';
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { Readable, Writable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskEvent } from '@personal-agent/contracts';
import {
  createTaskEventStream, type StreamAuthorization, type TaskEventSource, type TaskEventStreamOptions,
} from '../src/sse.js';

/** Fake device leases only; these tests never load the service's credentials. */
class Lease implements StreamAuthorization {
  valid = true;
  readonly listeners = new Set<() => void>();
  readonly unsubscribe = vi.fn();
  onSubscribe?: () => void;
  constructor(readonly expiresAt = Date.now() + 60_000) {}
  isValid = () => this.valid;
  subscribeInvalidation = (close: () => void) => {
    this.listeners.add(close);
    this.onSubscribe?.();
    return () => {
      this.unsubscribe();
      this.listeners.delete(close);
    };
  };
  revoke() {
    this.valid = false;
    for (const close of [...this.listeners]) close();
  }
}

class Events implements TaskEventSource {
  readonly task = { id: 'task', status: 'running' };
  readonly cancel = vi.fn();
  readonly rows: TaskEvent[] = [];
  readonly listeners = new Set<(event: TaskEvent) => void>();
  readonly unsubscribe = vi.fn();
  onSubscribe?: () => void;
  onRead?: () => void;
  reads = 0;
  require(taskId: string) {
    if (taskId !== this.task.id) throw Object.assign(new Error('Missing task'), { statusCode: 404 });
    return this.task;
  }
  events(taskId: string, after = 0, limit?: number) {
    this.reads++;
    const events = this.rows.filter(event => event.taskId === taskId && event.seq > after).slice(0, limit);
    this.onRead?.();
    return events;
  }
  latestEventSeq(taskId: string) {
    return this.rows.filter(event => event.taskId === taskId).at(-1)?.seq ?? 0;
  }
  subscribe(listener: (event: TaskEvent) => void) {
    this.listeners.add(listener);
    this.onSubscribe?.();
    return () => {
      this.unsubscribe();
      this.listeners.delete(listener);
    };
  }
  commit(text = 'durable event') {
    const event: TaskEvent = {
      seq: this.rows.length + 1, taskId: this.task.id, attemptId: 'attempt', type: 'engine.message',
      data: { text }, createdAt: '2026-10-02T00:00:00.000Z',
    };
    this.rows.push(event);
    for (const listener of [...this.listeners]) listener(event);
    return event;
  }
}

/** Real writable behavior with only HTTP header operations stubbed. */
class Response extends Writable {
  readonly chunks: string[] = [];
  readonly headers = new Map<string, string>();
  flushed = false;
  constructor(highWaterMark = 16_384) { super({ highWaterMark }); }
  setHeader(name: string, value: string) { this.headers.set(name, value); }
  flushHeaders() { this.flushed = true; }
  _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    this.chunks.push(chunk.toString());
    done();
  }
  ids() { return eventIds(this.chunks.join('')); }
}

function eventIds(body: string): number[] {
  return body.split('\n').filter(line => line.startsWith('id: ')).map(line => Number(line.slice(4)));
}

type Connection = {
  request: { destroy: () => void };
  response: { statusCode?: number; headers: OutgoingHttpHeaders; destroy: () => void };
  chunks: string[];
  closed: Promise<void>;
  isClosed: () => boolean;
  body: () => string;
};

const apps: FastifyInstance[] = [];
const clients: Connection[] = [];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function observe(
  request: Connection['request'], response: Connection['response'], payload: Readable,
): Connection {
  const chunks: string[] = [];
  let ended = payload.destroyed;
  const closed = new Promise<void>(done => {
    if (ended) { done(); return; }
    const finish = () => { ended = true; done(); };
    payload.once('close', finish);
    payload.once('end', finish);
  });
  payload.on('data', chunk => chunks.push(chunk.toString()));
  payload.on('error', () => {}); // Revocation intentionally closes the streamed response.
  const connection = { request, response, chunks, closed, isClosed: () => ended, body: () => chunks.join('') };
  clients.push(connection);
  return connection;
}

async function setup(options: TaskEventStreamOptions = {}, store = new Events()) {
  const app = Fastify();
  apps.push(app);
  app.addHook('onRequest', (_request, reply, done) => {
    reply.header('Content-Security-Policy', "default-src 'self'");
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Vary', 'Origin');
    reply.header('X-Content-Type-Options', 'nosniff');
    done();
  });
  const stream = createTaskEventStream(app, store, options);
  app.get<{ Params: { id: string } }>('/tasks/:id/events', (request, reply) => {
    stream(request, reply, request.params.id);
  });
  await app.ready();
  function unitConnect(response = new Response(), hijack = vi.fn()) {
    const raw = new EventEmitter();
    const request = { headers: {}, raw } as unknown as FastifyRequest;
    const reply = { raw: response, hijack } as unknown as FastifyReply;
    stream(request, reply, store.task.id);
    return { raw, response, reply };
  }
  let address: string | undefined;
  async function connect(device = 'device') {
    // Default injection exercises Fastify's raw response without listening.
    // It does not constitute real socket acceptance. The explicit opt-in path
    // is retained for a separately authorized loopback-network verification.
    if (process.env.PERSONAL_AGENT_SSE_REAL_SOCKETS !== '1') {
      const injected = await app.inject({
        url: '/tasks/task/events', headers: { 'x-test-device': device }, payloadAsStream: true,
      });
      const payload = injected.stream();
      return observe({ destroy: () => injected.raw.res.destroy() }, {
        statusCode: injected.statusCode,
        headers: injected.headers,
        destroy: () => { injected.raw.res.destroy(); payload.destroy(); },
      }, payload);
    }
    address ??= await app.listen({ host: '127.0.0.1', port: 0 });
    return new Promise<Connection>((resolve, reject) => {
      const request = httpRequest(`${address}/tasks/task/events`, {
        method: 'GET', agent: false, headers: { 'x-test-device': device },
      });
      request.once('error', reject);
      request.once('response', response => {
        request.off('error', reject);
        request.on('error', () => {}); // Revocation intentionally destroys the HTTP socket.
        resolve(observe(request, response, response));
      });
      request.end();
    });
  }
  return { app, store, connect, unitConnect };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const client of clients.splice(0)) {
    client.request.destroy();
    client.response.destroy();
  }
  for (const app of apps.splice(0)) await app.close();
});

describe('SSE authorization lifecycle', () => {
  it.each([
    ['revoked', () => { const lease = new Lease(); lease.valid = false; return lease; }],
    ['expired', () => new Lease(Date.now() - 1)],
    ['non-finite expiry', () => new Lease(Number.POSITIVE_INFINITY)],
    ['throwing validation', () => {
      const lease = new Lease();
      lease.isValid = () => { throw new Error('private lease diagnostic'); };
      return lease;
    }],
    ['throwing expiry getter', () => {
      const lease = new Lease();
      Object.defineProperty(lease, 'expiresAt', { get: () => { throw new Error('private lease diagnostic'); } });
      return lease;
    }],
  ] as const)('returns HTTP 401 for an %s lease before subscribing or replaying', async (_label, makeLease) => {
    const lease = makeLease();
    const { store, connect } = await setup({ authorize: () => lease });
    store.commit('private task event');
    const connection = await connect();
    await vi.waitFor(() => expect(connection.isClosed()).toBe(true), { timeout: 1_000 });
    expect(connection.response.statusCode).toBe(401);
    expect(JSON.parse(connection.body())).toMatchObject({ code: 'AUTH_REQUIRED', statusCode: 401 });
    expect(connection.body()).not.toContain('private task event');
    expect(connection.body()).not.toContain('private lease diagnostic');
    expect(store.listeners.size).toBe(0);
    expect(store.reads).toBe(0);
    expect(lease.listeners.size).toBe(0);
    expect(lease.unsubscribe).not.toHaveBeenCalled();
  });

  it('subscribes to invalidation before store subscription and durable replay', async () => {
    const lease = new Lease();
    const { store, unitConnect } = await setup({ authorize: () => lease });
    const event = store.commit();
    store.onSubscribe = () => expect(lease.listeners.size).toBe(1);
    store.onRead = () => {
      expect(lease.listeners.size).toBe(1);
      expect(store.listeners.size).toBe(1);
    };
    const { response } = unitConnect();
    expect(response.ids()).toEqual([event.seq]);
    lease.revoke();
    expect(response.destroyed).toBe(true);
    expect(lease.unsubscribe).toHaveBeenCalledOnce();
    expect(store.unsubscribe).toHaveBeenCalledOnce();
  });

  it('returns a normal HTTP 401 when invalidation fires synchronously during subscription', async () => {
    const lease = new Lease();
    lease.onSubscribe = () => lease.revoke();
    const { store, connect } = await setup({ authorize: () => lease });
    store.commit('must not replay');
    const connection = await connect();
    await vi.waitFor(() => expect(connection.isClosed()).toBe(true), { timeout: 1_000 });
    expect(connection.response.statusCode).toBe(401);
    expect(JSON.parse(connection.body())).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(connection.response.headers['content-type']).not.toContain('text/event-stream');
    expect(connection.body()).not.toContain('must not replay');
    expect(store.listeners.size).toBe(0);
    expect(store.reads).toBe(0);
    expect(store.unsubscribe).not.toHaveBeenCalled();
    expect(lease.listeners.size).toBe(0);
    expect(lease.unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not hijack, write frames, or retain listeners after synchronous authorization invalidation', async () => {
    const lease = new Lease();
    lease.onSubscribe = () => lease.revoke();
    const { store, unitConnect } = await setup({ authorize: () => lease });
    const response = new Response();
    const hijack = vi.fn();
    expect(() => unitConnect(response, hijack)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED', statusCode: 401 }));
    expect(hijack).not.toHaveBeenCalled();
    expect(response.flushed).toBe(false);
    expect(response.destroyed).toBe(false); // Fastify must still be able to produce its JSON rejection.
    expect(response.chunks).toEqual([]);
    expect(response.listenerCount('close')).toBe(0);
    expect(response.listenerCount('drain')).toBe(0);
    expect(store.listeners.size).toBe(0);
    expect(lease.listeners.size).toBe(0);
    expect(lease.unsubscribe).toHaveBeenCalledOnce();
  });

  it('cleans a store subscription returned after synchronous device revocation during subscribe', async () => {
    const lease = new Lease();
    const { store, unitConnect } = await setup({ authorize: () => lease });
    store.onSubscribe = () => lease.revoke();
    const response = new Response();
    expect(() => unitConnect(response)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED', statusCode: 401 }));
    expect(response.flushed).toBe(false);
    expect(response.chunks).toEqual([]);
    expect(store.reads).toBe(0);
    expect(store.listeners.size).toBe(0);
    expect(lease.listeners.size).toBe(0);
    expect(store.unsubscribe).toHaveBeenCalledOnce();
    expect(lease.unsubscribe).toHaveBeenCalledOnce();
  });

  it('closes a live streamed transport immediately on revocation without delivering later committed frames', async () => {
    const lease = new Lease();
    const { store, connect } = await setup({ authorize: () => lease });
    const first = store.commit('before revoke');
    const connection = await connect();
    expect(connection.response.statusCode).toBe(200);
    expect(connection.response.headers['cache-control']).toBe('no-store, no-transform');
    expect(connection.response.headers['content-security-policy']).toBe("default-src 'self'");
    expect(connection.response.headers['referrer-policy']).toBe('no-referrer');
    expect(connection.response.headers.vary).toBe('Origin');
    expect(connection.response.headers['x-content-type-options']).toBe('nosniff');
    await vi.waitFor(() => expect(eventIds(connection.body())).toEqual([first.seq]), { timeout: 1_000 });
    lease.revoke();
    const later = store.commit('after revoke');
    await vi.waitFor(() => expect(connection.isClosed()).toBe(true), { timeout: 500 });
    expect(eventIds(connection.body())).toEqual([first.seq]);
    expect(connection.body()).not.toContain('after revoke');
    expect(store.rows).toEqual([first, later]);
    expect(store.listeners.size).toBe(0);
    expect(lease.listeners.size).toBe(0);
    expect(lease.unsubscribe).toHaveBeenCalledOnce();
  });

  it('closes an idle streamed transport at expiry and rejects the expired reconnect with HTTP 401', async () => {
    let lease: Lease;
    const { store, connect } = await setup({ authorize: () => lease, heartbeatMs: 5_000 });
    lease = new Lease(Date.now() + 500);
    const first = store.commit();
    const connection = await connect();
    expect(connection.response.statusCode).toBe(200);
    await vi.waitFor(() => expect(eventIds(connection.body())).toEqual([first.seq]), { timeout: 1_000 });
    await vi.waitFor(() => expect(connection.isClosed()).toBe(true), { timeout: 1_000 });
    store.commit('expired event');
    expect(eventIds(connection.body())).toEqual([first.seq]);
    expect(store.listeners.size).toBe(0);
    expect(lease.listeners.size).toBe(0);
    expect(lease.unsubscribe).toHaveBeenCalledOnce();
    const reconnect = await connect();
    await vi.waitFor(() => expect(reconnect.isClosed()).toBe(true), { timeout: 1_000 });
    expect(reconnect.response.statusCode).toBe(401);
    expect(JSON.parse(reconnect.body())).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(store.listeners.size).toBe(0);
    expect(lease.unsubscribe).toHaveBeenCalledOnce();
  });

  it('revokes only that device while another authorized device keeps receiving events', async () => {
    const leases = { first: new Lease(), second: new Lease() };
    const { store, connect } = await setup({
      authorize: request => leases[request.headers['x-test-device'] as keyof typeof leases],
    });
    const first = await connect('first');
    const second = await connect('second');
    await vi.waitFor(() => expect(store.listeners.size).toBe(2), { timeout: 1_000 });
    leases.first.revoke();
    const event = store.commit('second device remains');
    await vi.waitFor(() => {
      expect(first.isClosed()).toBe(true);
      expect(eventIds(second.body())).toEqual([event.seq]);
    }, { timeout: 1_000 });
    expect(eventIds(first.body())).toEqual([]);
    expect(second.isClosed()).toBe(false);
    expect(store.listeners.size).toBe(1);
    expect(leases.first.listeners.size).toBe(0);
    expect(leases.second.listeners.size).toBe(1);
    expect(leases.first.unsubscribe).toHaveBeenCalledOnce();
    expect(leases.second.unsubscribe).not.toHaveBeenCalled();
  });

  it('cleans a disconnected client without cancelling the running task or losing later durable events', async () => {
    const lease = new Lease();
    const { store, connect } = await setup({ authorize: () => lease });
    const first = await connect();
    first.request.destroy();
    first.response.destroy();
    await vi.waitFor(() => {
      expect(store.listeners.size).toBe(0);
      expect(lease.listeners.size).toBe(0);
    }, { timeout: 1_000 });
    expect(store.cancel).not.toHaveBeenCalled();
    expect(store.task.status).toBe('running');
    const event = store.commit('engine continues after disconnect');
    const reconnect = await connect();
    await vi.waitFor(() => expect(eventIds(reconnect.body())).toEqual([event.seq]), { timeout: 1_000 });
    expect(store.cancel).not.toHaveBeenCalled();
    expect(store.task.status).toBe('running');
    expect(store.rows).toEqual([event]);
    expect(lease.unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not emit a fetched event when its durable read synchronously revokes authorization', async () => {
    const lease = new Lease();
    const { store, unitConnect } = await setup({ authorize: () => lease });
    const event = store.commit('fetched but revoked');
    store.onRead = () => lease.revoke();
    const { response, raw } = unitConnect();
    expect(response.chunks).toEqual(['retry: 1000\n\n']);
    expect(response.ids()).toEqual([]);
    expect(response.destroyed).toBe(true);
    expect(store.rows).toEqual([event]);
    expect(store.listeners.size).toBe(0);
    expect(lease.listeners.size).toBe(0);
    expect(lease.unsubscribe).toHaveBeenCalledOnce();
    expect(store.unsubscribe).toHaveBeenCalledOnce();
    expect(response.listenerCount('drain')).toBe(0);
    expect(raw.listenerCount('aborted')).toBe(0);
    await tick();
  });

  it.each(['isValid', 'expiresAt'] as const)('closes the transport when live %s validation throws without emitting another frame', async field => {
    const lease = new Lease();
    const { store, unitConnect } = await setup({ authorize: () => lease });
    const { response } = unitConnect();
    if (field === 'isValid') lease.isValid = () => { throw new Error('private live authorization diagnostic'); };
    else Object.defineProperty(lease, 'expiresAt', { get: () => { throw new Error('private live authorization diagnostic'); } });
    const event = store.commit('must not emit after validation failure');
    expect(response.destroyed).toBe(true);
    expect(response.chunks).toEqual(['retry: 1000\n\n']);
    expect(store.rows).toEqual([event]);
    expect(store.listeners.size).toBe(0);
    expect(lease.listeners.size).toBe(0);
    expect(store.unsubscribe).toHaveBeenCalledOnce();
    expect(lease.unsubscribe).toHaveBeenCalledOnce();
  });

  it('segments expiry beyond Node timer limits and closes precisely at the lease deadline', async () => {
    const maxDelay = 2_147_483_647;
    const { store, unitConnect } = await setup({
      heartbeatMs: maxDelay,
      authorize: () => lease,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
    const lease = new Lease(Date.now() + 2 * maxDelay + 73);
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const { response } = unitConnect();
    expect(timeout.mock.calls.map(call => call[1])).toEqual([maxDelay]);
    vi.advanceTimersByTime(maxDelay);
    expect(response.destroyed).toBe(false);
    expect(timeout.mock.calls.map(call => call[1])).toEqual([maxDelay, maxDelay]);
    vi.advanceTimersByTime(maxDelay);
    expect(response.destroyed).toBe(false);
    expect(timeout.mock.calls.map(call => call[1])).toEqual([maxDelay, maxDelay, 73]);
    vi.advanceTimersByTime(72);
    expect(response.destroyed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(response.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(lease.unsubscribe).toHaveBeenCalledOnce();
    expect(store.unsubscribe).toHaveBeenCalledOnce();
    expect(lease.listeners.size).toBe(0);
    expect(store.listeners.size).toBe(0);
  });

  it('preserves the local demo stream when authorization is undefined', async () => {
    const { store, unitConnect } = await setup({ authorize: () => undefined });
    const event = store.commit('demo event');
    const { response } = unitConnect();
    expect(response.ids()).toEqual([event.seq]);
    expect(response.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    expect(response.destroyed).toBe(false);
  });
});
