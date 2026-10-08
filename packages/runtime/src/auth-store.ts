import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AuthSecurityConfig, Device, PairingTicket } from '@personal-agent/contracts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type Row = Record<string, unknown>;
const ticketLifetimeMs = 5 * 60_000;
const sessionLifetimeMs = 30 * 24 * 60 * 60_000;
const tokenPattern = /^[a-zA-Z0-9_-]{43}$/;

export class AuthStoreError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode: number) {
    super(message); this.name = 'AuthStoreError';
  }
}

const invalidPairing = () => new AuthStoreError('PAIRING_INVALID', 'Pairing ticket is invalid or unavailable', 400);
const conflict = () => new AuthStoreError('COMMAND_CONFLICT', 'commandId was already used for a different authentication request', 409);
const secret = () => randomBytes(32).toString('base64url');
const hash = (purpose: 'ticket' | 'session' | 'csrf', value: string) => createHash('sha256')
  .update(`personal-agent:auth:v1:${purpose}\0`).update(value, 'utf8').digest('hex');
const csrfFor = (session: string) => createHash('sha256')
  .update('personal-agent:auth:v1:csrf-token\0').update(session, 'utf8').digest('base64url');
const timestamp = (value: unknown) => new Date(Number(value)).toISOString();

function deviceFrom(row: Row): Device {
  return { id: String(row.id), name: String(row.name), createdAt: timestamp(row.created_at), expiresAt: timestamp(row.expires_at),
    revokedAt: row.revoked_at === null ? null : timestamp(row.revoked_at) };
}

function equalDigest(left: string, right: unknown): boolean {
  return typeof right === 'string' && /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function canonicalPolicy(config: AuthSecurityConfig): AuthSecurityConfig {
  if (!config || config.mode !== 'paired' || typeof config.publicOrigin !== 'string' || !config.publicOrigin ||
      (config.allowInsecureLocalhost !== undefined && typeof config.allowInsecureLocalhost !== 'boolean')) {
    throw new AuthStoreError('SECURITY_POLICY_INVALID', 'Security policy is invalid', 400);
  }
  return { mode: 'paired', publicOrigin: config.publicOrigin,
    ...(config.allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {}) };
}

/**
 * TaskStore applies migrations first. This connection owns authentication only;
 * auth_commands is deliberately separate from task/configuration command IDs.
 */
export class AuthStore {
  private readonly db: import('node:sqlite').DatabaseSync;
  private readonly clock: () => number;
  private readonly listeners = new Set<(deviceId: string) => void>();
  private readonly committedInvalidations: string[] = [];
  private publishing = false;
  private closed = false;

  constructor(public readonly filename: string, options: { now?: () => number } = {}) {
    this.clock = options.now ?? Date.now;
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
      const version = Number((this.db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get() as Row).version);
      if (version !== 4) throw new Error('Authentication requires TaskStore schema migration version exactly 4');
    } catch (error) { this.db.close(); throw error; }
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) throw new Error('Authentication clock is invalid');
    return value;
  }

  private transaction<T>(fn: (invalidations: string[]) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    const invalidations: string[] = [];
    let result: T;
    try { result = fn(invalidations); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.committedInvalidations.push(...invalidations);
    if (!this.publishing) {
      this.publishing = true;
      try {
        while (this.committedInvalidations.length) {
          const id = this.committedInvalidations.shift()!;
          for (const listener of [...this.listeners]) {
            try { listener(id); } catch { /* committed revocation is authoritative */ }
          }
        }
      } finally { this.publishing = false; }
    }
    return result;
  }

  policy(): AuthSecurityConfig | null {
    const row = this.db.prepare('SELECT payload_json FROM security_policy WHERE id=1').get() as Row | undefined;
    return row ? canonicalPolicy(JSON.parse(String(row.payload_json)) as AuthSecurityConfig) : null;
  }

  enforcePolicy(config: AuthSecurityConfig): AuthSecurityConfig {
    const policy = canonicalPolicy(config);
    return this.transaction(() => {
      const current = this.policy();
      if (current && JSON.stringify(current) !== JSON.stringify(policy)) {
        throw new AuthStoreError('SECURITY_POLICY_CONFLICT', 'Persistent security policy cannot be implicitly changed', 409);
      }
      if (!current) this.db.prepare('INSERT INTO security_policy VALUES (1,?)').run(JSON.stringify(policy));
      return policy;
    });
  }

  private command<T>(id: string | undefined, request: string): T | undefined {
    if (id === undefined) return;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new AuthStoreError('BAD_AUTH_COMMAND', 'commandId is invalid', 400);
    const row = this.db.prepare('SELECT request_json,result_json FROM auth_commands WHERE command_id=?').get(id) as Row | undefined;
    if (!row) return;
    if (row.request_json !== request) throw conflict();
    return JSON.parse(String(row.result_json)) as T;
  }

  private saveCommand(id: string | undefined, request: string, result: unknown, now: number): void {
    if (id !== undefined) this.db.prepare('INSERT INTO auth_commands VALUES (?,?,?,?)').run(id, request, JSON.stringify(result), now);
  }

  private active(row: Row | undefined, now: number): row is Row {
    return !!row && row.revoked_at === null && Number.isSafeInteger(row.expires_at) && Number(row.expires_at) > now;
  }

  private requireIssuer(id: string | undefined, now: number): void {
    if (id === undefined) return; // Explicit local bootstrap issuance has no device issuer.
    const row = this.db.prepare('SELECT * FROM devices WHERE id=?').get(id) as Row | undefined;
    if (!this.active(row, now)) throw new AuthStoreError('AUTH_REQUIRED', 'An active device is required', 401);
  }

  issueTicket(issuerDeviceId?: string, commandId?: string): PairingTicket {
    const request = JSON.stringify({ action: 'issue_ticket', issuerDeviceId: issuerDeviceId ?? null });
    return this.transaction(() => {
      const now = this.now();
      this.requireIssuer(issuerDeviceId, now);
      const replay = this.command<PairingTicket>(commandId, request);
      if (replay) return replay;
      const ticket = secret(), id = randomUUID(), expires = now + ticketLifetimeMs;
      this.db.prepare('INSERT INTO pairing_tickets VALUES (?,?,?,?,?,?,?)')
        .run(id, hash('ticket', ticket), now, expires, null, issuerDeviceId ?? null, commandId ?? null);
      const metadata: PairingTicket = { id, ticket: null, expiresAt: timestamp(expires) };
      this.saveCommand(commandId, request, metadata, now);
      return { ...metadata, ticket };
    });
  }

  exchangeTicket(ticket: string, name: string): { device: Device; sessionToken: string; csrfToken: string } {
    if (typeof ticket !== 'string' || !tokenPattern.test(ticket)) throw invalidPairing();
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 200 || name.includes('\0')) {
      throw new AuthStoreError('BAD_AUTH_REQUEST', 'Device name is invalid', 400);
    }
    return this.transaction(() => {
      const now = this.now();
      const row = this.db.prepare('SELECT * FROM pairing_tickets WHERE ticket_hash=?').get(hash('ticket', ticket)) as Row | undefined;
      if (!row || row.consumed_at !== null || !Number.isSafeInteger(row.expires_at) || Number(row.expires_at) <= now) throw invalidPairing();
      if (row.issuer_device_id !== null) {
        const issuer = this.db.prepare('SELECT * FROM devices WHERE id=?').get(String(row.issuer_device_id)) as Row | undefined;
        if (!this.active(issuer, now)) throw invalidPairing();
      }
      const claimed = this.db.prepare('UPDATE pairing_tickets SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?')
        .run(now, String(row.id), now);
      if (Number(claimed.changes) !== 1) throw invalidPairing();
      const sessionToken = secret(), csrfToken = csrfFor(sessionToken), id = randomUUID(), expires = now + sessionLifetimeMs;
      this.db.prepare('INSERT INTO devices VALUES (?,?,?,?,?,?,?)')
        .run(id, name.trim(), hash('session', sessionToken), hash('csrf', csrfToken), now, expires, null);
      const device: Device = { id, name: name.trim(), createdAt: timestamp(now), expiresAt: timestamp(expires), revokedAt: null };
      return { device, sessionToken, csrfToken };
    });
  }

  authenticate(sessionToken: string): { device: Device; csrfToken: string } | null {
    if (typeof sessionToken !== 'string' || !tokenPattern.test(sessionToken)) return null;
    const row = this.db.prepare('SELECT * FROM devices WHERE session_hash=?').get(hash('session', sessionToken)) as Row | undefined;
    if (!this.active(row, this.now())) return null;
    const csrfToken = csrfFor(sessionToken);
    if (!equalDigest(hash('csrf', csrfToken), row.csrf_hash)) return null;
    return { device: deviceFrom(row), csrfToken };
  }

  validateCsrf(sessionToken: string, candidate: string): boolean {
    if (typeof candidate !== 'string' || !tokenPattern.test(candidate)) return false;
    const session = this.authenticate(sessionToken);
    return !!session && equalDigest(hash('csrf', candidate), hash('csrf', session.csrfToken));
  }

  devices(): Device[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY created_at,rowid').all() as Row[]).map(deviceFrom);
  }

  revoke(id: string, commandId: string, issuerDeviceId: string): Device {
    if (typeof issuerDeviceId !== 'string' || !issuerDeviceId) throw new AuthStoreError('AUTH_REQUIRED', 'An active device is required', 401);
    if (typeof commandId !== 'string') throw new AuthStoreError('BAD_AUTH_COMMAND', 'commandId is invalid', 400);
    const request = JSON.stringify({ action: 'revoke_device', id, issuerDeviceId });
    return this.transaction(invalidations => {
      const now = this.now();
      this.requireIssuer(issuerDeviceId, now);
      const replay = this.command<Device>(commandId, request);
      if (replay) return replay;
      const row = this.db.prepare('SELECT * FROM devices WHERE id=?').get(id) as Row | undefined;
      if (!row) throw new AuthStoreError('DEVICE_NOT_FOUND', 'Device not found', 404);
      if (row.revoked_at === null) {
        this.db.prepare('UPDATE devices SET revoked_at=? WHERE id=?').run(now, id);
        this.db.prepare('UPDATE pairing_tickets SET consumed_at=? WHERE issuer_device_id=? AND consumed_at IS NULL').run(now, id);
        invalidations.push(id);
      }
      const device = deviceFrom({ ...row, revoked_at: row.revoked_at ?? now });
      this.saveCommand(commandId, request, device, now);
      return device;
    });
  }

  isActive(id: string): boolean {
    return this.active(this.db.prepare('SELECT * FROM devices WHERE id=?').get(id) as Row | undefined, this.now());
  }

  subscribeInvalidation(listener: (deviceId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.listeners.clear(); this.db.close();
  }
}
