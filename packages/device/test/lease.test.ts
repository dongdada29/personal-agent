import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WriteLease } from '../src/lease.js';
import { WriteLeaseError } from '../src/errors.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function leaseDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-device-lease-'));
  dirs.push(dir);
  return dir;
}

describe('WriteLease 全局单写控', () => {
  it('同一时刻只允许一个通道持有写控', () => {
    const lease = new WriteLease({ dir: leaseDir(), now: () => 1_000_000, pid: 7, isAlive: () => true, ttlMs: 60_000 });
    const session = lease.acquire('m1', 'skill:meituan');
    expect(session.channel).toBe('m1');
    expect(() => lease.acquire('esp32', 'skill:toy')).toThrow(WriteLeaseError);
    expect(() => lease.acquire('esp32', 'skill:toy')).toThrowError(expect.objectContaining({ code: 'MULTI_CHANNEL_WRITE_FORBIDDEN' }));
    expect(lease.peek()?.holder).toBe('skill:meituan');
    lease.release(session);
    const backup = lease.acquire('m4', 'skill:failover');
    expect(backup.channel).toBe('m4');
  });

  it('同一 holder 对同一通道可以续租，其它 holder 不行', () => {
    const lease = new WriteLease({ dir: leaseDir(), now: () => 1_000_000, pid: 7, isAlive: () => true, ttlMs: 60_000 });
    const first = lease.acquire('m1', 'bot');
    const again = lease.acquire('m1', 'bot');
    expect(again.id).toBe(first.id);
    expect(() => lease.acquire('m1', 'other')).toThrowError(expect.objectContaining({ code: 'WRITE_LEASE_HELD' }));
  });

  it('过期或持有进程已死时回收租约', () => {
    const clock = { t: 5_000 };
    const lease = new WriteLease({ dir: leaseDir(), now: () => clock.t, pid: 8, isAlive: pid => pid === 8, ttlMs: 1_000 });
    lease.acquire('m1', 'old');
    clock.t += 5_000;
    const next = lease.acquire('m1', 'new');
    expect(next.holder).toBe('new');
  });

  it('release 只删除匹配的会话', () => {
    const dir = leaseDir();
    const lease = new WriteLease({ dir, now: () => 1_000_000, pid: 9, isAlive: () => true, ttlMs: 60_000 });
    const session = lease.acquire('m1', 'bot');
    expect(() => lease.release({ ...session, id: 'other' })).toThrowError(expect.objectContaining({ code: 'WRITE_LEASE_STALE' }));
    expect(JSON.parse(readFileSync(join(dir, 'write.lock'), 'utf8')).sessionId).toBe(session.id);
    lease.release(session);
    expect(lease.peek()).toBeUndefined();
  });

  it('拒绝空 holder', () => {
    const lease = new WriteLease({ dir: leaseDir(), ttlMs: 60_000 });
    expect(() => lease.acquire('m1', '  ')).toThrow(WriteLeaseError);
  });

  it('损坏的锁文件视为可回收', () => {
    const dir = leaseDir();
    writeFileSync(join(dir, 'write.lock'), 'not-json');
    const lease = new WriteLease({ dir, now: () => 1, pid: 1, isAlive: () => true, ttlMs: 5_000 });
    expect(lease.acquire('m1', 'bot').channel).toBe('m1');
  });
});
