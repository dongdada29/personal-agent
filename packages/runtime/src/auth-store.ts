import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AuthSecurityConfig, ClientDevice, Device, DeviceKind, DeviceRole, PairingTicket } from '@personal-agent/contracts';
import { DEVICE_ID_PATTERN, DEVICE_PUBLIC_KEY_PATTERN, deviceIdFromPublicKey } from './device-crypto.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type Row = Record<string, unknown>;
const ticketLifetimeMs = 5 * 60_000;
const sessionLifetimeMs = 30 * 24 * 60 * 60_000;
const deviceSessionLifetimeMs = 30 * 24 * 60 * 60_000;
const tokenPattern = /^[a-zA-Z0-9_-]{43}$/;
const SCHEMA_VERSION = 5;

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
  // Cookie 配对设备保持原公开字段，避免把 v5 的 client_devices 角色混进旧会话。
  return { id: String(row.id), name: String(row.name), createdAt: timestamp(row.created_at), expiresAt: timestamp(row.expires_at),
    revokedAt: row.revoked_at === null ? null : timestamp(row.revoked_at) };
}

function clientDeviceFrom(row: Row): ClientDevice {
  return {
    id: String(row.id),
    name: String(row.name),
    publicKey: String(row.public_key),
    role: row.role === 'observer' ? 'observer' : 'operator',
    status: row.status === 'approved' || row.status === 'rejected' || row.status === 'revoked' ? row.status : 'pending',
    trust: row.trust === 'desktop' || row.trust === 'loopback' ? row.trust : 'manual',
    kind: row.kind === 'desktop' ? 'desktop' : 'browser',
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    approvedAt: row.approved_at === null || row.approved_at === undefined ? null : timestamp(row.approved_at),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : timestamp(row.revoked_at),
    lastSeenAt: row.last_seen_at === null || row.last_seen_at === undefined ? null : timestamp(row.last_seen_at),
  };
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
      if (version !== SCHEMA_VERSION) throw new Error(`Authentication requires TaskStore schema migration version exactly ${SCHEMA_VERSION}`);
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
    this.closed = true;
    this.listeners.clear();
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* still close */ }
    this.db.close();
  }

  // ---------------------------------------------------------------------------
  // Ed25519 客户端设备（v5）。与 Cookie 配对设备分开存，互不影响。
  // ---------------------------------------------------------------------------

  private hashDeviceSession(value: string): string {
    return hash('session', `device-session:${value}`);
  }

  clientDevices(): ClientDevice[] {
    return (this.db.prepare('SELECT * FROM client_devices ORDER BY created_at,rowid').all() as Row[]).map(clientDeviceFrom);
  }

  clientDevice(id: string): ClientDevice | null {
    if (typeof id !== 'string' || !DEVICE_ID_PATTERN.test(id)) return null;
    const row = this.db.prepare('SELECT * FROM client_devices WHERE id=?').get(id) as Row | undefined;
    return row ? clientDeviceFrom(row) : null;
  }

  /**
   * 登记或刷新一台出示了有效签名的设备。
   * autoApprove 为 true 时直接批准（托管桌面或本机回环浏览器）；否则进入 pending。
   * 已被拒绝 / 撤销的设备再次连接会开一条新的 pending（不静默复活）。
   */
  registerClientDevice(input: {
    publicKey: string;
    name: string;
    kind: DeviceKind;
    autoApprove: boolean;
    trust?: ClientDevice['trust'];
    role?: DeviceRole;
  }): { device: ClientDevice; created: boolean } {
    if (!DEVICE_PUBLIC_KEY_PATTERN.test(input.publicKey)) {
      throw new AuthStoreError('DEVICE_IDENTITY_INVALID', 'Device public key is invalid', 400);
    }
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100 || input.name.includes('\0')) {
      throw new AuthStoreError('BAD_AUTH_REQUEST', 'Device name is invalid', 400);
    }
    if (input.kind !== 'desktop' && input.kind !== 'browser') {
      throw new AuthStoreError('BAD_AUTH_REQUEST', 'Device kind is invalid', 400);
    }
    const id = deviceIdFromPublicKey(input.publicKey);
    return this.transaction(() => {
      const now = this.now();
      const existing = this.db.prepare('SELECT * FROM client_devices WHERE id=?').get(id) as Row | undefined;
      const name = input.name.trim();
      if (!existing) {
        const status = input.autoApprove ? 'approved' : 'pending';
        const trust = input.autoApprove ? (input.trust ?? 'loopback') : 'manual';
        const role = input.autoApprove ? (input.role ?? 'operator') : 'observer';
        this.db.prepare('INSERT INTO client_devices VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, input.publicKey, name, role, status, trust, input.kind, now, now,
            input.autoApprove ? now : null, null, now);
        return { device: this.clientDevice(id)!, created: true };
      }
      if (String(existing.public_key) !== input.publicKey) {
        throw new AuthStoreError('DEVICE_IDENTITY_CONFLICT', 'Device identity does not match the stored public key', 409);
      }
      if (existing.status === 'approved' && existing.revoked_at === null) {
        this.db.prepare('UPDATE client_devices SET name=?, kind=?, last_seen_at=?, updated_at=? WHERE id=?')
          .run(name, input.kind, now, now, id);
        return { device: this.clientDevice(id)!, created: false };
      }
      // 拒绝 / 撤销后重新申请：回到 pending，等待操作员再次批准。不自动恢复权限。
      this.db.prepare('UPDATE client_devices SET name=?, kind=?, role=?, status=?, trust=?, updated_at=?, approved_at=NULL, revoked_at=NULL, last_seen_at=? WHERE id=?')
        .run(name, input.kind, input.autoApprove ? (input.role ?? 'operator') : 'observer',
          input.autoApprove ? 'approved' : 'pending',
          input.autoApprove ? (input.trust ?? 'loopback') : 'manual', now, now, id);
      return { device: this.clientDevice(id)!, created: false };
    });
  }

  issueDeviceSession(deviceId: string): { device: ClientDevice; deviceSession: string } {
    if (!DEVICE_ID_PATTERN.test(deviceId)) throw new AuthStoreError('DEVICE_NOT_FOUND', 'Device not found', 404);
    return this.transaction(() => {
      const now = this.now();
      const row = this.db.prepare('SELECT * FROM client_devices WHERE id=?').get(deviceId) as Row | undefined;
      if (!row || row.status !== 'approved' || row.revoked_at !== null) {
        throw new AuthStoreError('PAIRING_REQUIRED', 'This device is not approved', 403);
      }
      const deviceSession = secret();
      const expires = now + deviceSessionLifetimeMs;
      this.db.prepare('INSERT INTO client_device_sessions VALUES (?,?,?,?)')
        .run(this.hashDeviceSession(deviceSession), deviceId, now, expires);
      this.db.prepare('UPDATE client_devices SET last_seen_at=?, updated_at=? WHERE id=?').run(now, now, deviceId);
      return { device: clientDeviceFrom({ ...row, last_seen_at: now, updated_at: now }), deviceSession };
    });
  }

  authenticateClientSession(deviceSession: string): ClientDevice | null {
    if (typeof deviceSession !== 'string' || !tokenPattern.test(deviceSession)) return null;
    const row = this.db.prepare(`SELECT d.* FROM client_device_sessions s JOIN client_devices d ON d.id=s.device_id
      WHERE s.session_hash=?`).get(this.hashDeviceSession(deviceSession)) as Row | undefined;
    if (!row || row.status !== 'approved' || row.revoked_at !== null) return null;
    const session = this.db.prepare('SELECT expires_at FROM client_device_sessions WHERE session_hash=?')
      .get(this.hashDeviceSession(deviceSession)) as Row | undefined;
    if (!session || !Number.isSafeInteger(session.expires_at) || Number(session.expires_at) <= this.now()) return null;
    return clientDeviceFrom(row);
  }

  decideClientDevice(id: string, decision: 'approved' | 'rejected' | 'revoked', role: DeviceRole | undefined, commandId: string, issuer?: string): ClientDevice {
    if (!DEVICE_ID_PATTERN.test(id)) throw new AuthStoreError('DEVICE_NOT_FOUND', 'Device not found', 404);
    if (decision === 'approved' && role !== 'operator' && role !== 'observer') {
      throw new AuthStoreError('BAD_AUTH_REQUEST', 'An approved device needs an explicit role', 400);
    }
    const request = JSON.stringify({ action: `client_device_${decision}`, id, role: role ?? null, issuer: issuer ?? null });
    return this.transaction(invalidations => {
      const now = this.now();
      this.requireIssuer(issuer, now);
      const replay = this.command<ClientDevice>(commandId, request);
      if (replay) return replay;
      const row = this.db.prepare('SELECT * FROM client_devices WHERE id=?').get(id) as Row | undefined;
      if (!row) throw new AuthStoreError('DEVICE_NOT_FOUND', 'Device not found', 404);
      if (decision === 'approved') {
        // 上面已校验 role；这里再收窄一次，避免 SQLite 绑定收到 undefined。
        if (role !== 'operator' && role !== 'observer') {
          throw new AuthStoreError('BAD_AUTH_REQUEST', 'An approved device needs an explicit role', 400);
        }
        this.db.prepare('UPDATE client_devices SET status=?, role=?, trust=?, approved_at=?, revoked_at=NULL, updated_at=? WHERE id=?')
          .run('approved', role, 'manual', now, now, id);
      } else if (decision === 'rejected') {
        this.db.prepare('UPDATE client_devices SET status=?, revoked_at=?, updated_at=? WHERE id=?')
          .run('rejected', now, now, id);
        this.db.prepare('DELETE FROM client_device_sessions WHERE device_id=?').run(id);
        invalidations.push(id);
      } else {
        this.db.prepare('UPDATE client_devices SET status=?, revoked_at=?, updated_at=? WHERE id=?')
          .run('revoked', now, now, id);
        this.db.prepare('DELETE FROM client_device_sessions WHERE device_id=?').run(id);
        invalidations.push(id);
      }
      const device = this.clientDevice(id)!;
      this.saveCommand(commandId, request, device, now);
      return device;
    });
  }

  touchClientDevice(id: string): void {
    if (!DEVICE_ID_PATTERN.test(id)) return;
    const now = this.now();
    this.db.prepare('UPDATE client_devices SET last_seen_at=? WHERE id=? AND status=? AND revoked_at IS NULL').run(now, id, 'approved');
  }
}
