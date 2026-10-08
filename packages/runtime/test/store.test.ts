import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskStore } from '../src/store.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const directories: string[] = [];
const stores: TaskStore[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-store-'));
  directories.push(dir);
  const filename = join(dir, 'nested', 'tasks.sqlite');
  const store = new TaskStore(filename);
  stores.push(store);
  return { dir, filename, store };
}
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch {} }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('persistent task store', () => {
  it('migrates once, commits an attempt and artifact, and retains cursor after reopening', () => {
    const { filename, store } = fixture();
    const created = store.create({ commandId: 'persist-1', goal: 'Build a demo' }).task;
    const running = store.start(created.id);
    store.append(created.id, running.activeAttemptId!, 'engine.message', { text: 'working' });
    store.addArtifact(created.id, running.activeAttemptId!, { kind: 'markdown', name: 'Result', content: '# Complete' });
    store.transition(created.id, 'completed', running.activeAttemptId!);
    const before = store.snapshot(created.id);
    store.close();
    const reopened = new TaskStore(filename);
    stores.push(reopened);
    expect(reopened.snapshot(created.id)).toEqual(before);
    expect(before.task.status).toBe('completed');
    expect(before.task.deliveryStatus).toBe('pending');
    expect(before.artifacts[0].content).toBe('# Complete');
    expect(before.events.map(e => e.seq)).toEqual([...before.events.map(e => e.seq)].sort((a, b) => a - b));
    const db = new DatabaseSync(filename);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()?.count).toBe(4);
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    expect(db.prepare('SELECT status FROM attempts').get()?.status).toBe('completed');
    db.close();
  });

  it('replays the original creation result and rejects a conflicting command atomically', () => {
    const { store } = fixture();
    const result = store.create({ commandId: 'same', goal: 'One' });
    store.start(result.task.id);
    expect(store.create({ commandId: 'same', goal: 'One' })).toEqual({ ...result, created: false });
    expect(() => store.create({ commandId: 'same', goal: 'Two' })).toThrow('commandId');
    expect(store.list()).toHaveLength(1);
    expect(store.events(result.task.id)).toHaveLength(2);
  });

  it('rejects stale output and invalid transitions without changing task or event ledger', () => {
    const { store } = fixture();
    const task = store.create({ commandId: 'fence', goal: 'One' }).task;
    const running = store.start(task.id);
    const snapshot = store.snapshot(task.id);
    expect(() => store.transition(task.id, 'completed', 'old-attempt')).toThrow();
    expect(() => store.addArtifact(task.id, 'old-attempt', { kind: 'text', name: 'bad', content: 'late' })).toThrow();
    expect(() => store.transition(task.id, 'queued', running.activeAttemptId!)).toThrow();
    expect(store.snapshot(task.id)).toEqual(snapshot);
    store.transition(task.id, 'failed', running.activeAttemptId!);
    expect(() => store.append(task.id, running.activeAttemptId!, 'late', {})).toThrow();
    expect(store.events(task.id)).toHaveLength(snapshot.events.length + 1);
  });

  it('interrupts active tasks without replay and preserves finished results and queued work', () => {
    const { store } = fixture();
    const active = store.create({ commandId: 'active', goal: 'Active' }).task;
    const queued = store.create({ commandId: 'queued', goal: 'Queued' }).task;
    const done = store.create({ commandId: 'done', goal: 'Done' }).task;
    const doneRun = store.start(done.id);
    store.addArtifact(done.id, doneRun.activeAttemptId!, { kind: 'text', name: 'result', content: 'kept' });
    store.transition(done.id, 'completed', doneRun.activeAttemptId!);
    const run = store.start(active.id);
    store.transition(active.id, 'waiting_human', run.activeAttemptId!);
    store.interruptActive();
    const snapshot = store.snapshot(active.id);
    expect(snapshot.task.status).toBe('interrupted');
    expect(snapshot.task.activeAttemptId).toBeNull();
    expect(snapshot.events.at(-1)?.data.reason).toBe('service_restart');
    store.interruptActive();
    expect(store.snapshot(active.id)).toEqual(snapshot);
    expect(store.get(queued.id)?.status).toBe('queued');
    expect(store.get(done.id)?.status).toBe('completed');
    expect(store.artifacts(done.id)[0].content).toBe('kept');
  });

  it('scopes cursor replay to a task even when other tasks allocate intervening sequences', () => {
    const { store } = fixture();
    const first = store.create({ commandId: 'cursor-a', goal: 'A' }).task;
    const second = store.create({ commandId: 'cursor-b', goal: 'B' }).task;
    const cursor = store.snapshot(first.id).cursor;
    const run = store.start(first.id);
    store.append(first.id, run.activeAttemptId!, 'progress', { value: 1 });
    expect(store.events(first.id, cursor).map(e => e.taskId)).toEqual([first.id, first.id]);
    expect(store.events(second.id, cursor)).toHaveLength(1);
  });

  it('rolls back state, attempt and artifact rows when the associated event insert fails', () => {
    const { filename, store } = fixture();
    const task = store.create({ commandId: 'atomic', goal: 'One' }).task;
    const db = new DatabaseSync(filename);
    db.exec(`CREATE TRIGGER fail_event BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT,'test event failure'); END;`);
    expect(() => store.start(task.id)).toThrow('test event failure');
    expect(store.get(task.id)).toEqual(task);
    expect(db.prepare('SELECT COUNT(*) AS count FROM attempts').get()?.count).toBe(0);
    expect(store.events(task.id)).toHaveLength(1);
    db.exec('DROP TRIGGER fail_event');
    const running = store.start(task.id);
    const before = store.snapshot(task.id);
    db.exec(`CREATE TRIGGER fail_artifact_event BEFORE INSERT ON task_events WHEN NEW.type='artifact.created' BEGIN SELECT RAISE(ABORT,'test artifact event failure'); END;`);
    expect(() => store.addArtifact(task.id, running.activeAttemptId!, { kind: 'text', name: 'Atomic', content: 'body' })).toThrow();
    expect(store.snapshot(task.id)).toEqual(before);
    expect(store.artifacts(task.id)).toHaveLength(0);
    db.close();
  });
});
