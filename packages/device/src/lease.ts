/**
 * 全局单写控租约：同一时刻只允许一个通道持有写权限。
 * M1 / M4 / ESP32 共用这一把锁；并行 observe 可以，并行 act 不行。
 *
 * 文件锁用 wx 创建，内容是 JSON（channel / holder / pid / 到期时间）。
 * 过期或持有进程已死时允许回收；活着的异通道持有者一律拒绝。
 */
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDirectory } from './private-fs.js';
import { WriteLeaseError } from './errors.js';
import type { DeviceChannelId, DeviceSession } from './types.js';
import { DEFAULT_LEASE_TTL_MS } from './config.js';

export interface LeaseRecord {
  channel: DeviceChannelId;
  holder: string;
  sessionId: string;
  pid: number;
  acquiredAt: string;
  expiresAt: string;
}

export interface WriteLeaseOptions {
  dir: string;
  now?: () => number;
  pid?: number;
  ttlMs?: number;
  isAlive?: (pid: number) => boolean;
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readRecord(path: string): LeaseRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LeaseRecord>;
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (typeof parsed.channel !== 'string' || typeof parsed.holder !== 'string') return undefined;
    if (typeof parsed.sessionId !== 'string' || typeof parsed.pid !== 'number') return undefined;
    if (typeof parsed.acquiredAt !== 'string' || typeof parsed.expiresAt !== 'string') return undefined;
    return parsed as LeaseRecord;
  } catch {
    return undefined;
  }
}

export class WriteLease {
  private readonly path: string;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly ttlMs: number;
  private readonly isAlive: (pid: number) => boolean;

  constructor(options: WriteLeaseOptions) {
    ensurePrivateDirectory(options.dir);
    this.path = join(options.dir, 'write.lock');
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this.isAlive = options.isAlive ?? pidAlive;
  }

  peek(): LeaseRecord | undefined {
    const record = readRecord(this.path);
    if (!record) return undefined;
    if (this.stale(record)) return undefined;
    return record;
  }

  /**
   * 占用全局写控。同一 holder 对同一通道可续租；其它通道或其它 holder 会被拒绝。
   */
  acquire(channel: DeviceChannelId, holder: string, ttlMs = this.ttlMs): DeviceSession {
    if (!holder.trim()) throw new WriteLeaseError('写控租约的 holder 不能为空。');
    if (ttlMs < 1_000) throw new WriteLeaseError('写控租约 TTL 过短。');
    const existing = readRecord(this.path);
    if (existing && !this.stale(existing)) {
      if (existing.channel !== channel) {
        throw new WriteLeaseError(
          `写控已被通道 ${existing.channel} 占用，禁止多通道同时写。`,
          { channel: existing.channel, holder: existing.holder },
          'MULTI_CHANNEL_WRITE_FORBIDDEN',
        );
      }
      if (existing.holder !== holder) {
        throw new WriteLeaseError(
          `写控已被 ${existing.holder} 占用。`,
          { channel: existing.channel, holder: existing.holder },
        );
      }
      return this.write(existing.channel, existing.holder, existing.sessionId, existing.acquiredAt, ttlMs);
    }
    if (existing && this.stale(existing)) this.reclaim();
    return this.create(channel, holder, ttlMs);
  }

  release(session: DeviceSession): void {
    const existing = readRecord(this.path);
    if (!existing) return;
    if (existing.sessionId !== session.id || existing.channel !== session.channel) {
      throw new WriteLeaseError('写控租约与当前会话不匹配。', undefined, 'WRITE_LEASE_STALE');
    }
    try { unlinkSync(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private stale(record: LeaseRecord): boolean {
    if (Date.parse(record.expiresAt) <= this.now()) return true;
    return !this.isAlive(record.pid);
  }

  private reclaim(): void {
    try { unlinkSync(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private create(channel: DeviceChannelId, holder: string, ttlMs: number): DeviceSession {
    let descriptor: number;
    try {
      descriptor = openSync(this.path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = readRecord(this.path);
      if (raced && !this.stale(raced)) {
        throw new WriteLeaseError(
          `写控已被通道 ${raced.channel} 占用，禁止多通道同时写。`,
          { channel: raced.channel, holder: raced.holder },
          raced.channel === channel ? 'WRITE_LEASE_HELD' : 'MULTI_CHANNEL_WRITE_FORBIDDEN',
        );
      }
      this.reclaim();
      descriptor = openSync(this.path, 'wx', 0o600);
    }
    const acquiredAt = new Date(this.now()).toISOString();
    const sessionId = randomUUID();
    const expiresAt = new Date(this.now() + ttlMs).toISOString();
    const record: LeaseRecord = { channel, holder, sessionId, pid: this.pid, acquiredAt, expiresAt };
    try { writeFileSync(descriptor, JSON.stringify(record)); }
    catch (error) { closeSync(descriptor); unlinkSync(this.path); throw error; }
    closeSync(descriptor);
    return { id: sessionId, channel, holder, acquiredAt, expiresAt };
  }

  private write(channel: DeviceChannelId, holder: string, sessionId: string, acquiredAt: string, ttlMs: number): DeviceSession {
    const expiresAt = new Date(this.now() + ttlMs).toISOString();
    const record: LeaseRecord = { channel, holder, sessionId, pid: this.pid, acquiredAt, expiresAt };
    writeFileSync(this.path, JSON.stringify(record), { mode: 0o600 });
    return { id: sessionId, channel, holder, acquiredAt, expiresAt };
  }
}
