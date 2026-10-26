import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeviceOrchestrator, CHANNEL_CATALOG } from '../src/orchestrator.js';
import { FakeDeviceExecutor, FAKE_PNG_BASE64 } from '../src/fake-adapter.js';
import { resolveDeviceConfig, DEFAULT_DEVICE_CHANNEL, LLD12_UDID } from '../src/config.js';
import { DeviceError, WriteLeaseError } from '../src/errors.js';
import { WriteLease } from '../src/lease.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-device-orch-'));
  dirs.push(dir);
  return dir;
}

describe('DeviceOrchestrator', () => {
  it('默认通道是 M1，未实现的备份 / 实验通道不能当写控', () => {
    const orch = createDeviceOrchestrator({
      config: resolveDeviceConfig({}, { home: tmp() }),
      leaseDir: tmp(),
      invoke: async () => ({ code: 0, stdout: JSON.stringify({ v: 1, ok: true, deviceOnline: true, wdaReady: true }), stderr: '' }),
    });
    expect(orch.defaultChannel).toBe(DEFAULT_DEVICE_CHANNEL);
    expect(orch.executor().channel).toBe('m1');
    expect(orch.capabilities()).toMatchObject({ channel: 'm1', udid: LLD12_UDID, canPay: true });
    expect(() => orch.executor('m4')).toThrowError(expect.objectContaining({ code: 'CHANNEL_NOT_IMPLEMENTED' }));
    expect(() => orch.executor('esp32')).toThrowError(expect.objectContaining({ code: 'CHANNEL_NOT_IMPLEMENTED' }));
    expect(CHANNEL_CATALOG.find(item => item.id === 'm1')?.role).toBe('default');
    expect(CHANNEL_CATALOG.find(item => item.id === 'esp32')?.implemented).toBe(false);
  });

  it('注入的备份通道也不能与 M1 同时写控', async () => {
    const lease = new WriteLease({ dir: tmp(), now: () => 2_000_000, pid: 11, isAlive: () => true, ttlMs: 60_000 });
    const m4 = new FakeDeviceExecutor({ channel: 'm4', host: 'm4', lease });
    const orch = createDeviceOrchestrator({
      config: resolveDeviceConfig({}, { home: tmp() }),
      lease,
      adapters: { m4 },
      invoke: async () => ({ code: 0, stdout: JSON.stringify({ v: 1, ok: true, deviceOnline: true, wdaReady: true }), stderr: '' }),
    });
    const session = await orch.acquire({ holder: 'primary' }, 'm1');
    await expect(orch.acquire({ holder: 'backup' }, 'm4')).rejects.toBeInstanceOf(WriteLeaseError);
    await orch.release(session);
    const failover = await orch.acquire({ holder: 'backup' }, 'm4');
    expect(failover.channel).toBe('m4');
  });

  it('技能入口的 smoke：health + observe 走接口而不是 Appium', async () => {
    const orch = createDeviceOrchestrator({
      channel: 'fake',
      config: resolveDeviceConfig({ PA_DEVICE_CHANNEL: 'fake' }, { home: tmp() }),
      leaseDir: tmp(),
    });
    const health = await orch.health();
    const observation = await orch.observe({ includeTree: true });
    expect(health.ok).toBe(true);
    expect(observation.screenshot.base64).toBe(FAKE_PNG_BASE64);
    expect(observation.channel).toBe('fake');
  });

  it('PA_DEVICE_CHANNEL 非法时拒绝启动，避免静默落到未知通道', () => {
    expect(() => resolveDeviceConfig({ PA_DEVICE_CHANNEL: 'usb-gadget' }, { home: tmp() }))
      .toThrow(DeviceError);
  });

  it('绝对路径校验：ios_act 覆盖必须是绝对路径', () => {
    expect(() => resolveDeviceConfig({ PA_DEVICE_IOS_ACT: 'scripts/ios_act.py' }, { home: tmp() }))
      .toThrowError(expect.objectContaining({ code: 'INPUT_INVALID' }));
  });
});
