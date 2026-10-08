import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskStore } from '@personal-agent/runtime';
import { buildApp } from '../../apps/server/src/app.js';
import { coldBackup } from '../backup.js';
import { inspectDataDirectory } from '../doctor.js';
import { inspectShareFile } from '../share-check.js';
import { closeDemoData } from '../demo-cleanup.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'personal-agent-delivery-test-')); roots.push(root);
  const data = join(root, 'instance'); mkdirSync(data);
  const store = new TaskStore(join(data, 'personal-agent.sqlite'));
  const { task } = store.create({ commandId: 'backup_fixture', goal: 'Preserve this queued fake task', engine: 'fake' });
  store.close();
  return { root, data, task, output: join(root, 'backup') };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('read-only diagnostics and cold data backups', () => {
  it('inspects an old schema without migrating or initializing missing tables', () => {
    const root = mkdtempSync(join(tmpdir(), 'personal-agent-delivery-test-')); roots.push(root);
    const filename = join(root, 'personal-agent.sqlite');
    const db = new DatabaseSync(filename);
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES(1);'); db.close();
    const original = readFileSync(filename);
    expect(inspectDataDirectory(root)).toMatchObject({ schemaVersion: 1, activeOwnedProcesses: 0, mode: 'loopback' });
    expect(readFileSync(filename)).toEqual(original);
    const check = new DatabaseSync(filename, { readOnly: true });
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name='devices'").get()).toBeUndefined(); check.close();
  });

  it('does not create a missing data directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'personal-agent-delivery-test-')); roots.push(root);
    expect(() => inspectDataDirectory(join(root, 'missing'))).toThrow();
    expect(existsSync(join(root, 'missing'))).toBe(false);
  });

  it.each(['service.lock', 'recovery.lock'])('refuses %s and preserves the exact ownership record', lock => {
    const { data, output } = fixture(); const value = '{"pid":123,"id":"do-not-reclaim"}';
    writeFileSync(join(data, lock), value);
    expect(() => coldBackup(data, output)).toThrowError(expect.objectContaining({ code: 'BACKUP_BUSY' }));
    expect(readFileSync(join(data, lock), 'utf8')).toBe(value);
    expect(existsSync(output)).toBe(false);
  });

  it('refuses unresolved durable process records without signalling their PID', () => {
    const { data, output } = fixture(); const db = new DatabaseSync(join(data, 'personal-agent.sqlite'));
    db.prepare('INSERT INTO owned_processes(id,status,payload_json) VALUES(?,?,?)').run('unresolved', 'running', JSON.stringify({ pid: process.pid })); db.close();
    expect(() => coldBackup(data, output)).toThrowError(expect.objectContaining({ code: 'BACKUP_BUSY' }));
    expect(existsSync(output)).toBe(false);
  });

  it('refuses existing or nested outputs without overwriting data', () => {
    const { data, output } = fixture(); mkdirSync(output); writeFileSync(join(output, 'keep.txt'), 'keep');
    expect(() => coldBackup(data, output)).toThrowError(expect.objectContaining({ code: 'BACKUP_TARGET' }));
    expect(readFileSync(join(output, 'keep.txt'), 'utf8')).toBe('keep');
    expect(() => coldBackup(data, join(data, 'backup'))).toThrowError(expect.objectContaining({ code: 'BACKUP_TARGET' }));
  });

  it('rejects links instead of following or copying external files', () => {
    const { root, data, output } = fixture(); writeFileSync(join(root, 'outside.txt'), 'private fixture'); symlinkSync(join(root, 'outside.txt'), join(data, 'outside-link'));
    expect(() => coldBackup(data, output)).toThrowError(expect.objectContaining({ code: 'BACKUP_SYMLINK' }));
    expect(existsSync(output)).toBe(false);
  });

  it('restores a hash-verified private copy with tasks and events intact', () => {
    const { data, output, task } = fixture(); writeFileSync(join(data, 'evidence.txt'), 'retained evidence'); mkdirSync(join(data, 'empty-artifact-directory'));
    const original = readFileSync(join(data, 'personal-agent.sqlite'));
    expect(coldBackup(data, output)).toMatchObject({ result: 'PASS', schemaVersion: 4, restoreScope: 'same-host', sourceDataPreserved: true });
    expect(statSync(output).mode & 0o777).toBe(0o700);
    expect(existsSync(join(data, 'service.lock'))).toBe(false);
    expect(readFileSync(join(data, 'personal-agent.sqlite'))).toEqual(original);
    const manifest = JSON.parse(readFileSync(join(output, 'backup-manifest.json'), 'utf8')) as { files: { path: string; sha256: string }[] };
    for (const file of manifest.files) expect(createHash('sha256').update(readFileSync(join(output, 'data', file.path))).digest('hex')).toBe(file.sha256);
    const restored = new TaskStore(join(output, 'data', 'personal-agent.sqlite'));
    try { expect(restored.get(task.id)?.status).toBe('queued'); expect(restored.events(task.id).length).toBeGreaterThan(0); }
    finally { restored.close(); }
    expect(readFileSync(join(output, 'data', 'evidence.txt'), 'utf8')).toBe('retained evidence');
    expect(statSync(join(output, 'data', 'empty-artifact-directory')).isDirectory()).toBe(true);
    const second = join(output, '..', 'second-backup');
    expect(coldBackup(join(output, 'data'), second).result).toBe('PASS');
  });

  it('preserves completed fake events and artifacts through a stopped-instance restore', async () => {
    const { data, output } = fixture();
    const { app, runner } = await buildApp({ dataDir: data });
    const created = await app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: 'restore_completed', goal: 'Preserve completed result', engine: 'fake' } });
    expect(created.statusCode).toBe(201);
    await runner.idle();
    const before = (await app.inject(`/api/tasks/${created.json().id}`)).json();
    expect(before.task.status).toBe('completed');
    await app.close();
    coldBackup(data, output);
    const restored = new TaskStore(join(output, 'data', 'personal-agent.sqlite'));
    try {
      expect(restored.get(before.task.id)?.status).toBe('completed');
      expect(restored.events(before.task.id)).toEqual(before.events);
      expect(restored.artifacts(before.task.id)).toEqual(before.artifacts);
    } finally { restored.close(); }
  });
});

describe('disposable demo cleanup', () => {
  it('retains data after close returns with a blocked runner', async () => {
    const { data } = fixture();
    await expect(closeDemoData(data, { app: { close: async () => {} }, runner: { isBlocked: true } })).rejects.toMatchObject({ code: 'DEMO_CLEANUP_FAILED' });
    expect(existsSync(join(data, 'personal-agent.sqlite'))).toBe(true);
  });
  it('retains unresolved ownership evidence even without a runner', async () => {
    const { data } = fixture(); writeFileSync(join(data, 'service.lock'), 'preserve');
    await expect(closeDemoData(data)).rejects.toMatchObject({ code: 'DEMO_CLEANUP_FAILED' });
    expect(readFileSync(join(data, 'service.lock'), 'utf8')).toBe('preserve');
    expect(existsSync(join(data, 'personal-agent.sqlite'))).toBe(true);
  });
});

describe('source sharing checks', () => {
  it('reports locations without printing matching secret content', () => {
    const token = ['sk', 'ant', 'x'.repeat(40)].join('-');
    const findings = inspectShareFile('README.md', `Example\n${token}\n`);
    expect(findings).toEqual([{ path: 'README.md', category: 'provider-token', line: 2 }]);
    expect(JSON.stringify(findings)).not.toContain(token);
  });
  it('rejects runtime files and private-key material while allowing a public template', () => {
    expect(inspectShareFile('.data/personal-agent.sqlite', '')[0]?.category).toBe('runtime-or-secret-file');
    const key = ['-----BEGIN ', 'OPENSSH PRIVATE KEY-----'].join('');
    expect(inspectShareFile('unsafe.txt', key)[0]?.category).toBe('private-key');
    expect(inspectShareFile('.env.example', 'PUBLIC_ORIGIN=https://agent.example.invalid')).toEqual([]);
  });
});
