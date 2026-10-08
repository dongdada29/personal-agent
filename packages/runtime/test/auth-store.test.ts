import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthSecurityConfig } from '@personal-agent/contracts';
import { AuthStore } from '../src/auth-store.js';
import { TaskStore } from '../src/store.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
const loader = require.resolve('tsx');
const authModuleUrl = new URL('../src/auth-store.ts', import.meta.url).href;
const baseTime = Date.parse('2026-10-02T00:00:00.000Z');
const policy: AuthSecurityConfig = { mode: 'paired', publicOrigin: 'https://fixture.example.invalid' };
const fixtures: { directory: string; tasks: TaskStore; auth: AuthStore[]; readers: import('node:sqlite').DatabaseSync[] }[] = [];
const children: ChildProcess[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'personal-agent-auth-store-'));
  const filename = join(directory, 'tasks.sqlite');
  const tasks = new TaskStore(filename);
  let now = baseTime;
  const auth = new AuthStore(filename, { now: () => now });
  const cleanup = { directory, tasks, auth: [auth], readers: [] as import('node:sqlite').DatabaseSync[] };
  fixtures.push(cleanup);
  function second() { const store = new AuthStore(filename, { now: () => now }); cleanup.auth.push(store); return store; }
  function reader() { const db = new DatabaseSync(filename); cleanup.readers.push(db); return db; }
  return { auth, tasks, filename, reader, second, setNow: (value: number) => { now = value; } };
}

function pair(auth: AuthStore, name = 'Test device') {
  const issued = auth.issueTicket();
  return auth.exchangeTicket(issued.ticket!, name);
}

async function exchangeWorker(filename: string, now: number) {
  // Test credentials travel over private IPC, never through argv or stdout.
  const script = `import { AuthStore } from ${JSON.stringify(authModuleUrl)};
    const auth = new AuthStore(process.argv[1], { now: () => Number(process.argv[2]) });
    process.send({ ready: true });
    process.once('message', ({ ticket }) => {
      try { const result = auth.exchangeTicket(ticket, 'Concurrent test device');
        process.send({ ok: true, deviceId: result.device.id }); }
      catch (error) { process.send({ ok: false, code: error.code }); }
      finally { auth.close(); process.disconnect(); }
    });`;
  const child = spawn(process.execPath, ['--import', loader, '--input-type=module', '--eval', script, filename, String(now)],
    { env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.push(child);
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveResult!: (value: { ok: boolean; code?: string; deviceId?: string }) => void, rejectResult!: (error: Error) => void;
  const result = new Promise<{ ok: boolean; code?: string; deviceId?: string }>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  void result.catch(() => {});
  const timer = setTimeout(() => {
    const error = new Error('Auth exchange fixture deadline exceeded'); rejectReady(error); rejectResult(error); child.kill('SIGKILL');
  }, 8_000);
  child.once('error', error => { clearTimeout(timer); rejectReady(error); rejectResult(error); });
  child.once('exit', () => {
    clearTimeout(timer); const error = new Error('Auth fixture exited before its exchange result');
    rejectReady(error); rejectResult(error);
  });
  child.on('message', (message: any) => {
    if (message.ready) resolveReady();
    if (typeof message.ok === 'boolean') { clearTimeout(timer); resolveResult(message); }
  });
  await ready;
  return { child, result, exit };
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGKILL'); await exit;
    }
  }
  for (const fixture of fixtures.splice(0)) {
    for (const auth of fixture.auth) auth.close();
    fixture.tasks.close();
    for (const reader of fixture.readers) reader.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe('persistent device authentication', () => {
  it('fails closed on a future database schema instead of opening an unknown authentication format', () => {
    const { filename, reader } = fixture();
    reader().prepare('INSERT INTO schema_migrations VALUES (?,?)').run(5, new Date(baseTime).toISOString());
    expect(() => new AuthStore(filename)).toThrow('schema migration version exactly 4');
  });

  it('fixes public paired policy without storing extra fields or permitting implicit changes', () => {
    const { auth, second, reader } = fixture();
    expect(auth.policy()).toBeNull();
    auth.enforcePolicy({ ...policy, privateValue: 'must-not-be-saved' } as AuthSecurityConfig);
    expect(auth.policy()).toEqual(policy);
    expect(second().enforcePolicy({ ...policy, allowInsecureLocalhost: false })).toEqual(policy);
    expect(() => auth.enforcePolicy({ ...policy, publicOrigin: 'https://different.example.invalid' }))
      .toThrow(expect.objectContaining({ code: 'SECURITY_POLICY_CONFLICT', statusCode: 409 }));
    expect(() => auth.enforcePolicy({ ...policy, allowInsecureLocalhost: true }))
      .toThrow(expect.objectContaining({ code: 'SECURITY_POLICY_CONFLICT' }));
    expect(String(reader().prepare('SELECT payload_json FROM security_policy').get()?.payload_json)).not.toContain('privateValue');
    expect(auth.policy()).toEqual(policy);
  });

  it('issues unique 32-byte one-time tickets and replays only public metadata', () => {
    const { auth, second } = fixture();
    const owner = pair(auth);
    const first = auth.issueTicket(owner.device.id, 'ticket-once');
    expect(first.ticket).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    expect(Buffer.from(first.ticket!, 'base64url')).toHaveLength(32);
    expect(first.expiresAt).toBe(new Date(baseTime + 5 * 60_000).toISOString());
    expect(second().issueTicket(owner.device.id, 'ticket-once')).toEqual({ ...first, ticket: null });
    expect(auth.issueTicket().ticket).not.toBe(auth.issueTicket().ticket);
  });

  it('atomically exchanges once and persists only purpose-separated credential hashes', () => {
    const { auth, reader, tasks } = fixture();
    const ticket = auth.issueTicket(undefined, 'initial-device');
    const result = auth.exchangeTicket(ticket.ticket!, 'Mobile test device');
    expect(result.sessionToken).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    expect(result.csrfToken).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    expect(result.csrfToken).not.toBe(result.sessionToken);
    expect(result.device).toEqual({ id: result.device.id, name: 'Mobile test device', createdAt: new Date(baseTime).toISOString(),
      expiresAt: new Date(baseTime + 30 * 24 * 60 * 60_000).toISOString(), revokedAt: null });
    expect(() => auth.exchangeTicket(ticket.ticket!, 'Again')).toThrow(expect.objectContaining({ code: 'PAIRING_INVALID', statusCode: 400 }));
    const db = reader();
    const rows = JSON.stringify(['pairing_tickets', 'devices', 'auth_commands', 'security_policy']
      .flatMap(table => db.prepare(`SELECT * FROM ${table}`).all()));
    for (const credential of [ticket.ticket!, result.sessionToken, result.csrfToken]) expect(rows).not.toContain(credential);
    const hashes = db.prepare('SELECT session_hash,csrf_hash FROM devices').get();
    expect(hashes?.session_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashes?.csrf_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashes?.session_hash).not.toBe(hashes?.csrf_hash);
    expect(tasks.list()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_events').get()?.count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get()?.count).toBe(0);
  });

  it('uses the same opaque failure for unknown, expired, consumed and malformed tickets', () => {
    const { auth, setNow } = fixture();
    const expired = auth.issueTicket();
    const consumed = auth.issueTicket(); auth.exchangeTicket(consumed.ticket!, 'Consumed');
    setNow(baseTime + 5 * 60_000);
    const failures = ['A'.repeat(43), expired.ticket!, consumed.ticket!, '', 'short', 'x'.repeat(44)].map(ticket => {
      try { auth.exchangeTicket(ticket, 'Test'); throw new Error('Expected invalid ticket'); }
      catch (error) { return error as Error & { code?: string; statusCode?: number }; }
    });
    expect(failures.map(error => [error.code, error.statusCode, error.message])).toEqual(
      failures.map(() => ['PAIRING_INVALID', 400, 'Pairing ticket is invalid or unavailable']));
    for (const error of failures) expect(String(error)).not.toContain(expired.ticket!);
  });

  it('accepts the last millisecond before ticket expiry and rejects expired sessions at the exact boundary', () => {
    const { auth, setNow } = fixture();
    const issued = auth.issueTicket();
    setNow(baseTime + 5 * 60_000 - 1);
    const result = auth.exchangeTicket(issued.ticket!, 'Boundary test device');
    const expiry = Date.parse(result.device.expiresAt);
    setNow(expiry - 1);
    expect(auth.isActive(result.device.id)).toBe(true);
    expect(auth.authenticate(result.sessionToken)?.device).toEqual(result.device);
    expect(auth.validateCsrf(result.sessionToken, result.csrfToken)).toBe(true);
    setNow(expiry);
    expect(auth.isActive(result.device.id)).toBe(false);
    expect(auth.authenticate(result.sessionToken)).toBeNull();
    expect(auth.validateCsrf(result.sessionToken, result.csrfToken)).toBe(false);
  });

  it('derives a stable CSRF token after reconnect and never accepts CSRF or pairing tokens as sessions', () => {
    const { auth, second } = fixture();
    const ticket = auth.issueTicket();
    const first = auth.exchangeTicket(ticket.ticket!, 'Purpose test');
    const other = pair(auth, 'Another device');
    expect(second().authenticate(first.sessionToken)).toEqual({ device: first.device, csrfToken: first.csrfToken });
    expect(auth.authenticate(first.csrfToken)).toBeNull();
    expect(auth.authenticate(ticket.ticket!)).toBeNull();
    expect(auth.validateCsrf(first.sessionToken, first.sessionToken)).toBe(false);
    expect(auth.validateCsrf(first.sessionToken, other.csrfToken)).toBe(false);
    expect(auth.validateCsrf(first.sessionToken, `${first.csrfToken.slice(0, -1)}!`)).toBe(false);
    expect(auth.validateCsrf('invalid', first.csrfToken)).toBe(false);
  });

  it('detects corrupted CSRF verification data without authenticating the affected session', () => {
    const { auth, reader } = fixture();
    const result = pair(auth);
    reader().prepare('UPDATE devices SET csrf_hash=? WHERE id=?').run('malformed', result.device.id);
    expect(auth.authenticate(result.sessionToken)).toBeNull();
    expect(auth.validateCsrf(result.sessionToken, result.csrfToken)).toBe(false);
  });

  it('rejects invalid names without consuming a usable ticket', () => {
    const { auth } = fixture();
    const ticket = auth.issueTicket();
    for (const name of ['', '   ', 'x'.repeat(201), 'name\0']) {
      expect(() => auth.exchangeTicket(ticket.ticket!, name)).toThrow(expect.objectContaining({ code: 'BAD_AUTH_REQUEST' }));
    }
    expect(auth.exchangeTicket(ticket.ticket!, ' Valid device ').device.name).toBe('Valid device');
  });

  it('keeps authentication command IDs separate from task IDs while rejecting cross-issuer and cross-action reuse', () => {
    const { auth, tasks } = fixture();
    const owner = pair(auth), other = pair(auth);
    const task = tasks.create({ commandId: 'shared-id', goal: 'Independent task command' }).task;
    const ticket = auth.issueTicket(owner.device.id, 'shared-id');
    expect(ticket.ticket).not.toBeNull();
    expect(tasks.replayCreation({ commandId: 'shared-id', goal: 'Independent task command' })).toEqual(task);
    expect(() => auth.issueTicket(other.device.id, 'shared-id')).toThrow(expect.objectContaining({ code: 'COMMAND_CONFLICT' }));
    expect(() => auth.revoke(other.device.id, 'shared-id', owner.device.id)).toThrow(expect.objectContaining({ code: 'COMMAND_CONFLICT' }));
  });

  it('rolls back ticket issuance if persisting its metadata command fails', () => {
    const { auth, reader } = fixture();
    const owner = pair(auth);
    const db = reader();
    const before = db.prepare('SELECT COUNT(*) AS count FROM pairing_tickets').get()?.count;
    db.exec("CREATE TRIGGER fail_ticket_command BEFORE INSERT ON auth_commands WHEN NEW.command_id='ticket-atomic' BEGIN SELECT RAISE(ABORT,'test ticket command failure'); END;");
    expect(() => auth.issueTicket(owner.device.id, 'ticket-atomic')).toThrow('test ticket command failure');
    expect(db.prepare('SELECT COUNT(*) AS count FROM pairing_tickets').get()?.count).toBe(before);
    db.exec('DROP TRIGGER fail_ticket_command');
    const successful = auth.issueTicket(owner.device.id, 'ticket-atomic');
    expect(successful.ticket).not.toBeNull();
    expect(auth.exchangeTicket(successful.ticket!, 'Successful retry').device.name).toBe('Successful retry');
  });

  it('rolls back a claimed ticket if the device insert fails, leaving it exchangeable', () => {
    const { auth, reader } = fixture();
    const ticket = auth.issueTicket();
    const db = reader();
    db.exec("CREATE TRIGGER fail_device BEFORE INSERT ON devices BEGIN SELECT RAISE(ABORT,'test device insert failure'); END;");
    expect(() => auth.exchangeTicket(ticket.ticket!, 'Atomic device')).toThrow('test device insert failure');
    expect(db.prepare('SELECT consumed_at FROM pairing_tickets WHERE id=?').get(ticket.id)?.consumed_at).toBeNull();
    expect(auth.devices()).toEqual([]);
    db.exec('DROP TRIGGER fail_device');
    expect(auth.exchangeTicket(ticket.ticket!, 'Atomic retry').device.name).toBe('Atomic retry');
  });

  it('allows exactly one exchange across two simultaneous independent database connections', async () => {
    const { auth, filename } = fixture();
    const ticket = auth.issueTicket();
    const workers = await Promise.all([exchangeWorker(filename, baseTime), exchangeWorker(filename, baseTime)]);
    for (const worker of workers) worker.child.send({ ticket: ticket.ticket });
    const results = await Promise.all(workers.map(worker => worker.result));
    await Promise.all(workers.map(worker => worker.exit));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, code: 'PAIRING_INVALID' }]);
    expect(auth.devices()).toHaveLength(1);
  });

  it('revokes an active device and its unused tickets after commit and replays the original metadata', () => {
    const { auth, second, reader } = fixture();
    const owner = pair(auth, 'Owner'), target = pair(auth, 'Revoked device');
    const issued = auth.issueTicket(target.device.id, 'target-ticket');
    const db = reader();
    const received: { id: string; persisted: unknown }[] = [];
    const release = auth.subscribeInvalidation(id => received.push({ id,
      persisted: db.prepare('SELECT revoked_at FROM devices WHERE id=?').get(id)?.revoked_at }));
    const revoked = auth.revoke(target.device.id, 'revoke-once', owner.device.id);
    expect(revoked.revokedAt).toBe(new Date(baseTime).toISOString());
    expect(received).toEqual([{ id: target.device.id, persisted: baseTime }]);
    expect(second().authenticate(target.sessionToken)).toBeNull();
    expect(auth.validateCsrf(target.sessionToken, target.csrfToken)).toBe(false);
    expect(() => auth.exchangeTicket(issued.ticket!, 'Should fail')).toThrow(expect.objectContaining({ code: 'PAIRING_INVALID' }));
    expect(auth.revoke(target.device.id, 'revoke-once', owner.device.id)).toEqual(revoked);
    expect(auth.revoke(target.device.id, 'revoke-already-revoked', owner.device.id)).toEqual(revoked);
    expect(received).toHaveLength(1);
    expect(auth.devices()).toEqual([owner.device, revoked]);
    expect(Object.keys(auth.devices()[0]).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'name', 'revokedAt']);
    release();
  });

  it('rejects self-revocation replay and all new mutations from revoked or expired issuers', () => {
    const { auth, setNow } = fixture();
    const self = pair(auth), active = pair(auth);
    auth.revoke(self.device.id, 'self-revoke', self.device.id);
    expect(() => auth.revoke(self.device.id, 'self-revoke', self.device.id)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    expect(() => auth.issueTicket(self.device.id, 'after-self-revoke')).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    expect(() => auth.revoke(active.device.id, 'revoked-issuer', self.device.id)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    setNow(Date.parse(active.device.expiresAt));
    expect(() => auth.issueTicket(active.device.id)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    expect(() => auth.revoke(active.device.id, 'expired-issuer', active.device.id)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
  });

  it('requires a currently active issuer before replaying ticket or revocation metadata', () => {
    const { auth, setNow } = fixture();
    const owner = pair(auth), target = pair(auth);
    auth.issueTicket(owner.device.id, 'cached-ticket');
    auth.revoke(target.device.id, 'cached-revoke', owner.device.id);
    setNow(Date.parse(owner.device.expiresAt));
    expect(() => auth.issueTicket(owner.device.id, 'cached-ticket')).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    expect(() => auth.revoke(target.device.id, 'cached-revoke', owner.device.id)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
  });

  it('rejects outstanding tickets when their issuer session expires', () => {
    const { auth, setNow } = fixture();
    const issuer = pair(auth);
    setNow(Date.parse(issuer.device.expiresAt) - 1);
    const ticket = auth.issueTicket(issuer.device.id);
    setNow(Date.parse(issuer.device.expiresAt));
    expect(() => auth.exchangeTicket(ticket.ticket!, 'Expired issuer')).toThrow(expect.objectContaining({ code: 'PAIRING_INVALID' }));
  });

  it('rolls back revocation, ticket retirement and notifications if command persistence fails', () => {
    const { auth, reader } = fixture();
    const owner = pair(auth), target = pair(auth);
    const ticket = auth.issueTicket(target.device.id);
    const before = auth.devices();
    const received: string[] = [];
    auth.subscribeInvalidation(id => received.push(id));
    const db = reader();
    db.exec("CREATE TRIGGER fail_revoke_command BEFORE INSERT ON auth_commands WHEN NEW.command_id='revoke-atomic' BEGIN SELECT RAISE(ABORT,'test revoke command failure'); END;");
    expect(() => auth.revoke(target.device.id, 'revoke-atomic', owner.device.id)).toThrow('test revoke command failure');
    expect(auth.devices()).toEqual(before);
    expect(auth.authenticate(target.sessionToken)?.device).toEqual(target.device);
    expect(db.prepare('SELECT consumed_at FROM pairing_tickets WHERE id=?').get(ticket.id)?.consumed_at).toBeNull();
    expect(received).toEqual([]);
    db.exec('DROP TRIGGER fail_revoke_command');
    auth.revoke(target.device.id, 'revoke-atomic', owner.device.id);
    expect(received).toEqual([target.device.id]);
  });

  it('isolates invalidation observer errors and queues reentrant revocations in committed order', () => {
    const { auth } = fixture();
    const owner = pair(auth), first = pair(auth), second = pair(auth);
    auth.subscribeInvalidation(() => { throw new Error('Fixture observer disconnected'); });
    auth.subscribeInvalidation(id => { if (id === first.device.id) auth.revoke(second.device.id, 'nested-revoke', owner.device.id); });
    const received: string[] = [];
    const release = auth.subscribeInvalidation(id => received.push(id));
    expect(() => auth.revoke(first.device.id, 'outer-revoke', owner.device.id)).not.toThrow();
    expect(received).toEqual([first.device.id, second.device.id]);
    release();
    auth.revoke(owner.device.id, 'unsubscribed-revoke', owner.device.id);
    expect(received).toEqual([first.device.id, second.device.id]);
  });

  it('returns unknown-device 404 only with an active issuer and keeps command conflicts isolated', () => {
    const { auth } = fixture();
    const owner = pair(auth), target = pair(auth);
    expect(() => auth.revoke('unknown', 'unknown-target', owner.device.id))
      .toThrow(expect.objectContaining({ code: 'DEVICE_NOT_FOUND', statusCode: 404 }));
    expect(() => auth.revoke('unknown', 'no-auth-target', 'unknown-issuer'))
      .toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED', statusCode: 401 }));
    auth.revoke(target.device.id, 'fixed-revoke', owner.device.id);
    expect(() => auth.revoke(owner.device.id, 'fixed-revoke', owner.device.id)).toThrow(expect.objectContaining({ code: 'COMMAND_CONFLICT' }));
    expect(auth.isActive(owner.device.id)).toBe(true);
  });
});
