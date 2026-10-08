import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskEvent } from '@personal-agent/contracts';
import { TaskStore } from '@personal-agent/runtime';
import { createTaskEventStream } from '../src/sse.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const fixtures: { app: FastifyInstance; store: TaskStore; dir: string }[] = [];
const readers: import('node:sqlite').DatabaseSync[] = [];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-sse-store-'));
  const filename = join(dir, 'events.sqlite');
  const store = new TaskStore(filename);
  const app = Fastify();
  fixtures.push({ app, store, dir });
  const stream = createTaskEventStream(app, store, { replayBatchSize: 2 });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/tasks/:id/events', (request, reply) => {
    stream(request, reply, request.params.id, request.query.after);
  });
  await app.ready();
  let subscriptionCount = 0;
  const subscribe = store.subscribe.bind(store);
  vi.spyOn(store, 'subscribe').mockImplementation(listener => {
    subscriptionCount++;
    const release = subscribe(listener);
    let released = false;
    return () => {
      if (!released) { released = true; subscriptionCount--; }
      release();
    };
  });
  async function connect(taskId: string, after = 0, lastEventId?: number) {
    const response = await app.inject({ url: `/api/tasks/${taskId}/events?after=${after}`, payloadAsStream: true,
      headers: lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) } });
    expect(response.statusCode).toBe(200);
    const chunks: string[] = [];
    const payload = response.stream();
    payload.on('data', chunk => chunks.push(chunk.toString()));
    payload.on('error', () => {}); // Deliberate stream disconnects produce LIGHT_ECONNRESET.
    await tick();
    return {
      response, payload,
      events: () => chunks.join('').split('\n').filter(line => line.startsWith('data: '))
        .map(line => JSON.parse(line.slice(6)) as TaskEvent),
      close: async () => { response.raw.res.destroy(); await tick(); },
    };
  }
  function reader() { const db = new DatabaseSync(filename); readers.push(db); return db; }
  return { dir, filename, store, app, connect, reader, subscriptions: () => subscriptionCount };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    try { fixture.store.close(); } catch { /* A persistence test may already have closed it. */ }
    for (const db of readers.splice(0)) db.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('SQLite committed event stream integration', () => {
  it('publishes only events that an independent SQLite connection can already read', async () => {
    const { store, reader } = await fixture();
    const db = reader();
    const received: TaskEvent[] = [];
    const states: string[] = [];
    const release = store.subscribe(event => {
      const row = db.prepare('SELECT type,data_json FROM task_events WHERE seq=?').get(event.seq);
      expect(row?.type).toBe(event.type);
      expect(JSON.parse(String(row?.data_json))).toEqual(event.data);
      states.push(String(db.prepare('SELECT status FROM tasks WHERE id=?').get(event.taskId)?.status));
      received.push(event);
    });
    const task = store.create({ commandId: 'commit', goal: 'Commit before broadcasting' }).task;
    const running = store.start(task.id);
    const message = store.append(task.id, running.activeAttemptId!, 'engine.message', { text: 'Committed output' });
    expect(received).toEqual(store.events(task.id));
    expect(received.at(-1)).toEqual(message);
    expect(states).toEqual(['queued', 'running', 'running']);
    expect(store.latestEventSeq(task.id)).toBe(message.seq);
    expect(store.events(task.id, 0, 1)).toEqual([received[0]]);
    release();
  });

  it('rolls back a successfully inserted event when a later command write fails, without broadcasting it', async () => {
    const { store, reader } = await fixture();
    const db = reader();
    const received: TaskEvent[] = [];
    const release = store.subscribe(event => received.push(event));
    db.exec(`CREATE TRIGGER reject_command BEFORE INSERT ON commands
      WHEN NEW.command_id='rollback-after-event' BEGIN SELECT RAISE(ABORT,'fixture command failure'); END;`);
    expect(() => store.create({ commandId: 'rollback-after-event', goal: 'Rolled back task' })).toThrow('fixture command failure');
    expect(received).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()?.count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_events').get()?.count).toBe(0);
    db.exec('DROP TRIGGER reject_command');
    const task = store.create({ commandId: 'successful-after-rollback', goal: 'Committed task' }).task;
    expect(received).toEqual(store.events(task.id));
    expect(received).toHaveLength(1);
    release();
  });

  it('publishes canonical persisted JSON without losing notifications for functions, undefined or NaN', async () => {
    const { store, connect } = await fixture();
    const task = store.create({ commandId: 'canonical-json', goal: 'Canonical JSON notification fixture' }).task;
    const running = store.start(task.id);
    const cursor = store.snapshot(task.id).cursor;
    const connection = await connect(task.id, cursor);
    const received: TaskEvent[] = [];
    const release = store.subscribe(event => received.push(event));
    store.append(task.id, running.activeAttemptId!, 'engine.message', {
      text: 'Durable canonical output', omitted: undefined, callback: () => 'omitted', invalidNumber: Number.NaN,
      array: [undefined, Number.NaN, () => 'omitted'], nested: { missing: undefined, present: true },
    });
    await tick();
    const persisted = store.events(task.id, cursor);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].data).toEqual({ text: 'Durable canonical output', invalidNumber: null,
      array: [null, null, null], nested: { present: true } });
    expect(received).toEqual(persisted);
    expect(connection.events()).toEqual(persisted);
    release();
  });

  it('contains subscriber errors and preserves seq order for reentrant committed writes', async () => {
    const { store } = await fixture();
    const received: TaskEvent[] = [];
    const releaseBad = store.subscribe(() => { throw new Error('Fixture subscriber failed'); });
    let nestedTaskId: string | undefined;
    const releaseWriter = store.subscribe(event => {
      if (event.type === 'task.created' && !nestedTaskId) {
        nestedTaskId = 'creating';
        nestedTaskId = store.create({ commandId: 'nested', goal: 'Nested commit' }).task.id;
      }
    });
    const releaseReader = store.subscribe(event => received.push(event));
    const outer = store.create({ commandId: 'outer', goal: 'Outer commit' }).task;
    expect(received.map(event => event.taskId)).toEqual([outer.id, nestedTaskId]);
    expect(received.map(event => event.seq)).toEqual([...received.map(event => event.seq)].sort((a, b) => a - b));
    expect(store.list()).toHaveLength(2);
    releaseBad(); releaseWriter(); releaseReader();
  });

  it('replays the snapshot-to-subscription gap, then emits committed live events with no foreign-task records', async () => {
    const { store, connect, subscriptions } = await fixture();
    const task = store.create({ commandId: 'snapshot-gap', goal: 'Snapshot to SSE' }).task;
    const running = store.start(task.id);
    const snapshot = store.snapshot(task.id);
    const gap = store.append(task.id, running.activeAttemptId!, 'engine.message', { text: 'Between snapshot and subscribe' });
    const connection = await connect(task.id, snapshot.cursor);
    expect(subscriptions()).toBe(1);
    expect(connection.events()).toEqual([gap]);
    store.create({ commandId: 'foreign', goal: 'Another task' });
    const live = store.append(task.id, running.activeAttemptId!, 'engine.message', { text: 'Live after commit' });
    await tick();
    expect(connection.events()).toEqual([gap, live]);
    await connection.close();
    expect(subscriptions()).toBe(0);
    expect(store.require(task.id).status).toBe('running');
    expect(store.events(task.id, snapshot.cursor)).toEqual([gap, live]);
  });

  it('does not publish or stream an artifact whose transaction rolls back', async () => {
    const { store, connect, reader } = await fixture();
    const task = store.create({ commandId: 'stream-rollback', goal: 'Do not stream rolled back output' }).task;
    const running = store.start(task.id);
    const snapshot = store.snapshot(task.id);
    const connection = await connect(task.id, snapshot.cursor);
    const db = reader();
    db.exec(`CREATE TRIGGER reject_artifact_event BEFORE INSERT ON task_events
      WHEN NEW.type='artifact.created' BEGIN SELECT RAISE(ABORT,'fixture artifact failure'); END;`);
    expect(() => store.addArtifact(task.id, running.activeAttemptId!, {
      kind: 'text', name: 'Uncommitted fixture', content: 'Should never reach SSE',
    })).toThrow('fixture artifact failure');
    await tick();
    expect(connection.events()).toEqual([]);
    expect(store.snapshot(task.id)).toEqual(snapshot);
    db.exec('DROP TRIGGER reject_artifact_event');
    const artifact = store.addArtifact(task.id, running.activeAttemptId!, {
      kind: 'text', name: 'Committed fixture', content: 'Durable output',
    });
    await tick();
    expect(connection.events()).toEqual(store.events(task.id, snapshot.cursor));
    expect(connection.events()[0].data.artifactId).toBe(artifact.id);
  });

  it('continues disconnected tasks and uses Last-Event-ID to replay only unseen persistent records', async () => {
    const { store, app, connect, subscriptions } = await fixture();
    const task = store.create({ commandId: 'disconnect', goal: 'Disconnect does not cancel' }).task;
    const running = store.start(task.id);
    const first = await connect(task.id);
    const cursor = first.events().at(-1)!.seq;
    await first.close();
    expect(subscriptions()).toBe(0);
    expect(store.require(task.id)).toEqual(running);
    const unseen = store.append(task.id, running.activeAttemptId!, 'engine.message', { text: 'Written while disconnected' });
    store.addArtifact(task.id, running.activeAttemptId!, { kind: 'text', name: 'Preserved', content: 'After disconnect' });
    const replay = await connect(task.id, 0, cursor);
    await tick();
    expect(replay.events()).toEqual(store.events(task.id, cursor));
    expect(replay.events()[0]).toEqual(unseen);
    expect(replay.events().every(event => event.seq > cursor)).toBe(true);
    const beforeClose = store.snapshot(task.id);
    await app.close();
    await tick();
    expect(subscriptions()).toBe(0);
    expect(replay.payload.destroyed).toBe(true);
    expect(store.snapshot(task.id)).toEqual(beforeClose);
  });
});
