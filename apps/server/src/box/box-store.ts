/**
 * 云端 box 部署的持久化（独立的 box.sqlite，不改动任务库 personal-agent.sqlite 的迁移版本）。
 *
 * 保存内容：部署名称、服务商标签、连接方式、ssh 别名 / 展示地址、凭据“引用”（不是凭据）、
 * 一次性注册票据的哈希、machine 凭据的哈希、最近一次心跳的已清洗快照。
 * 明文票据与 machine 凭据只在签发时返回一次，库里只有 SHA-256 摘要。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { tightenPrivateFile } from '@personal-agent/runtime';
import type { BoxCloudConnection, BoxContainerState, BoxHostState, BoxMemoryPressure } from '@personal-agent/contracts';
import { BoxError } from './host-adapter.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type Row = Record<string, unknown>;

export const BOX_TICKET_LIFETIME_MS = 10 * 60_000;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const secret = () => randomBytes(32).toString('base64url');
const digest = (purpose: 'ticket' | 'credential', value: string) => createHash('sha256')
  .update(`personal-agent:box:v1:${purpose}\0`).update(value, 'utf8').digest('hex');

function equalDigest(left: string, right: unknown): boolean {
  return typeof right === 'string' && /^[a-f0-9]{64}$/.test(right) && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export interface CloudDeploymentRecord {
  id: string;
  name: string;
  providerLabel?: string;
  connection: BoxCloudConnection;
  endpoint?: string;
  authRef?: string;
  createdAt: string;
  registeredAt?: string;
  lastHeartbeatAt?: string;
  heartbeat?: AgentHeartbeat;
}

/** 主机守护进程上报的快照（经过白名单清洗）。 */
export interface AgentHeartbeat {
  host: { state: BoxHostState; version?: string; arch?: string; runtime?: string; cpus?: number; memoryBytes?: number; diskBytes?: number; hostname?: string };
  /** safe：守护进程按与 server 相同的规则（只发布 127.0.0.1 网关端口、seccomp、no-new-privileges 等）校验通过。 */
  container: { state: BoxContainerState; image?: string; statusText?: string; cpuPercent?: number; memoryUsedBytes?: number; memoryLimitBytes?: number; safe?: boolean };
  desktops: { id: string; state: 'running' | 'stopped' }[];
  /** 守护进程能读到 pa-box-ctl status（网关与桌面控制可用）。 */
  gateReady?: boolean;
  memoryPressure?: BoxMemoryPressure;
  agentVersion?: string;
}

const HOST_STATES: BoxHostState[] = ['not_installed', 'not_configured', 'stopped', 'starting', 'running', 'error', 'unknown'];
const CONTAINER_STATES: BoxContainerState[] = ['running', 'stopped', 'missing', 'unknown'];
const PRESSURES: BoxMemoryPressure[] = ['normal', 'warn', 'critical', 'unknown'];
const label = (value: unknown, max = 64) => typeof value === 'string' && value.length > 0 && value.length <= max && /^[\p{L}\p{N} ._:+()/-]+$/u.test(value) ? value : undefined;
const metric = (value: unknown, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
const compact = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

/** 只保留已知字段与安全取值；不认识的字段直接丢弃，而不是存进库里再展示。 */
export function sanitizeHeartbeat(input: unknown): AgentHeartbeat {
  const value = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const host = (value.host && typeof value.host === 'object' ? value.host : {}) as Record<string, unknown>;
  const container = (value.container && typeof value.container === 'object' ? value.container : {}) as Record<string, unknown>;
  const desktops = Array.isArray(value.desktops) ? value.desktops.slice(0, 3) : [];
  return compact({
    host: compact({ state: HOST_STATES.includes(host.state as BoxHostState) ? host.state as BoxHostState : 'unknown', version: label(host.version, 32),
      arch: label(host.arch, 32), runtime: label(host.runtime, 32), cpus: metric(host.cpus, 4096), memoryBytes: metric(host.memoryBytes),
      diskBytes: metric(host.diskBytes), hostname: label(host.hostname, 64) }),
    container: compact({ state: CONTAINER_STATES.includes(container.state as BoxContainerState) ? container.state as BoxContainerState : 'unknown',
      image: label(container.image, 128), statusText: label(container.statusText, 64), cpuPercent: metric(container.cpuPercent, 100_000),
      memoryUsedBytes: metric(container.memoryUsedBytes), memoryLimitBytes: metric(container.memoryLimitBytes),
      safe: container.safe === true ? true : undefined }),
    desktops: desktops.flatMap((item: any) => item && typeof item.id === 'string' && /^d[1-3]$/.test(item.id)
      ? [{ id: item.id, state: item.state === 'running' ? 'running' as const : 'stopped' as const }] : []),
    gateReady: value.gateReady === true ? true : undefined,
    memoryPressure: PRESSURES.includes(value.memoryPressure) ? value.memoryPressure as BoxMemoryPressure : undefined,
    agentVersion: label(value.agentVersion, 32),
  });
}

/** ssh 目标只允许 ssh 配置里的 Host 别名或 user@host；以字母数字开头，杜绝 `-oProxyCommand=` 一类注入。 */
export const SSH_TARGET = /^(?:[a-z_][a-z0-9_-]{0,31}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
/** 凭据引用：scheme:name，例如 ssh-config:pa-cloud、keychain:pa-box-hetzner、env:PA_BOX_SSH。 */
export const AUTH_REF = /^(?:ssh-config|ssh-agent|keychain|credential-manager|secret-service|env|file):[A-Za-z0-9._/-]{1,128}$/;

export class BoxStore {
  private readonly db: import('node:sqlite').DatabaseSync;
  private closed = false;
  constructor(readonly filename: string, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') tightenPrivateFile(filename);
    try {
      this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS box_schema (version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS box_deployments (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, provider_label TEXT, connection TEXT NOT NULL CHECK(connection IN ('agent','ssh')),
          endpoint TEXT, auth_ref TEXT, command_id TEXT UNIQUE, request_json TEXT NOT NULL, created_at INTEGER NOT NULL,
          credential_hash TEXT UNIQUE, registered_at INTEGER, last_heartbeat_at INTEGER, heartbeat_json TEXT
        );
        CREATE TABLE IF NOT EXISTS box_tickets (
          id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL REFERENCES box_deployments(id) ON DELETE CASCADE,
          ticket_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
        );
        INSERT OR IGNORE INTO box_schema VALUES (1);`);
      const version = Number((this.db.prepare('SELECT MAX(version) AS version FROM box_schema').get() as Row).version);
      if (version !== 1) throw new Error('Unsupported box store schema version');
    } catch (error) { this.db.close(); throw error; }
  }

  private record(row: Row): CloudDeploymentRecord {
    const iso = (value: unknown) => value === null || value === undefined ? undefined : new Date(Number(value)).toISOString();
    let heartbeat: AgentHeartbeat | undefined;
    if (typeof row.heartbeat_json === 'string') { try { heartbeat = sanitizeHeartbeat(JSON.parse(row.heartbeat_json)); } catch { heartbeat = undefined; } }
    return compact({ id: String(row.id), name: String(row.name), providerLabel: row.provider_label === null ? undefined : String(row.provider_label),
      connection: row.connection as BoxCloudConnection, endpoint: row.endpoint === null ? undefined : String(row.endpoint),
      authRef: row.auth_ref === null ? undefined : String(row.auth_ref), createdAt: iso(row.created_at)!, registeredAt: iso(row.registered_at),
      lastHeartbeatAt: iso(row.last_heartbeat_at), heartbeat });
  }

  list(): CloudDeploymentRecord[] {
    return (this.db.prepare('SELECT * FROM box_deployments ORDER BY created_at, rowid').all() as Row[]).map(row => this.record(row));
  }

  get(id: string): CloudDeploymentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM box_deployments WHERE id=?').get(id) as Row | undefined;
    return row ? this.record(row) : undefined;
  }

  create(input: { commandId: string; name: string; providerLabel?: string; connection: BoxCloudConnection; endpoint?: string; authRef?: string }): { record: CloudDeploymentRecord; created: boolean } {
    const name = input.name.trim();
    if (!name || name.length > 100) throw new BoxError('BOX_INPUT_INVALID', '名称不能为空且不超过 100 个字符。', 400);
    if (input.providerLabel !== undefined && !label(input.providerLabel, 64)) throw new BoxError('BOX_INPUT_INVALID', '服务商标签只能包含文字、数字和常见符号，最多 64 个字符。', 400);
    if (input.connection === 'ssh' && (!input.endpoint || !SSH_TARGET.test(input.endpoint))) {
      throw new BoxError('BOX_INPUT_INVALID', 'ssh 连接需要 ssh 配置中的 Host 别名（或 user@host），不能以 - 开头。', 400);
    }
    if (input.connection === 'agent' && input.endpoint !== undefined && !SSH_TARGET.test(input.endpoint)) {
      throw new BoxError('BOX_INPUT_INVALID', '展示地址只能是主机名。', 400);
    }
    if (input.authRef !== undefined && !AUTH_REF.test(input.authRef)) {
      throw new BoxError('BOX_INPUT_INVALID', '凭据引用格式为 scheme:name（例如 ssh-config:pa-cloud），不要粘贴密钥或密码本身。', 400);
    }
    const request = JSON.stringify({ name, providerLabel: input.providerLabel ?? null, connection: input.connection, endpoint: input.endpoint ?? null, authRef: input.authRef ?? null });
    const existing = this.db.prepare('SELECT * FROM box_deployments WHERE command_id=?').get(input.commandId) as Row | undefined;
    if (existing) {
      if (existing.request_json !== request) throw new BoxError('COMMAND_CONFLICT', 'commandId 已用于不同的请求。', 409);
      return { record: this.record(existing), created: false };
    }
    const id = `cloud-${randomUUID()}`;
    this.db.prepare('INSERT INTO box_deployments (id,name,provider_label,connection,endpoint,auth_ref,command_id,request_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, name, input.providerLabel ?? null, input.connection, input.endpoint ?? null, input.authRef ?? null, input.commandId, request, this.now());
    return { record: this.get(id)!, created: true };
  }

  remove(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM box_deployments WHERE id=?').run(id).changes) === 1;
  }

  /** 签发新票据时作废该部署所有未使用的旧票据。 */
  issueTicket(deploymentId: string): { ticket: string; expiresAt: string } {
    const record = this.get(deploymentId);
    if (!record) throw new BoxError('BOX_DEPLOYMENT_NOT_FOUND', '部署不存在。', 404);
    if (record.connection !== 'agent') throw new BoxError('BOX_INPUT_INVALID', '只有主机守护进程（agent）连接方式需要注册票据。', 400);
    const now = this.now(), ticket = secret(), expires = now + BOX_TICKET_LIFETIME_MS;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE box_tickets SET consumed_at=? WHERE deployment_id=? AND consumed_at IS NULL').run(now, deploymentId);
      this.db.prepare('INSERT INTO box_tickets VALUES (?,?,?,?,?,?)').run(randomUUID(), deploymentId, digest('ticket', ticket), now, expires, null);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { ticket, expiresAt: new Date(expires).toISOString() };
  }

  /** 票据单次、限时；成功后签发新的 machine 凭据并替换旧凭据（重新注册即轮换）。 */
  register(ticket: string): { deploymentId: string; credential: string } {
    if (typeof ticket !== 'string' || !SECRET.test(ticket)) throw new BoxError('BOX_TICKET_INVALID', '注册票据无效或已过期。', 400);
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM box_tickets WHERE ticket_hash=?').get(digest('ticket', ticket)) as Row | undefined;
      if (!row || row.consumed_at !== null || Number(row.expires_at) <= now) throw new BoxError('BOX_TICKET_INVALID', '注册票据无效或已过期。', 400);
      const claimed = this.db.prepare('UPDATE box_tickets SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(now, String(row.id));
      if (Number(claimed.changes) !== 1) throw new BoxError('BOX_TICKET_INVALID', '注册票据无效或已过期。', 400);
      const credential = secret();
      this.db.prepare('UPDATE box_deployments SET credential_hash=?, registered_at=?, last_heartbeat_at=NULL, heartbeat_json=NULL WHERE id=?')
        .run(digest('credential', credential), now, String(row.deployment_id));
      this.db.exec('COMMIT');
      return { deploymentId: String(row.deployment_id), credential };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  authenticate(credential: string | undefined): string | undefined {
    if (typeof credential !== 'string' || !SECRET.test(credential)) return undefined;
    const expected = digest('credential', credential);
    const row = this.db.prepare('SELECT id, credential_hash FROM box_deployments WHERE credential_hash=?').get(expected) as Row | undefined;
    return row && equalDigest(expected, row.credential_hash) ? String(row.id) : undefined;
  }

  heartbeat(deploymentId: string, payload: unknown): AgentHeartbeat {
    const heartbeat = sanitizeHeartbeat(payload);
    this.db.prepare('UPDATE box_deployments SET last_heartbeat_at=?, heartbeat_json=? WHERE id=?').run(this.now(), JSON.stringify(heartbeat), deploymentId);
    return heartbeat;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* still close */ }
    this.db.close();
  }
}
