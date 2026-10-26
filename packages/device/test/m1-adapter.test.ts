import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { M1Adapter } from '../src/m1-adapter.js';
import { FakeDeviceExecutor, FAKE_PNG_BASE64 } from '../src/fake-adapter.js';
import { LLD12_UDID, resolveDeviceConfig } from '../src/config.js';
import { DeviceError, HumanGateError, requirePaymentGate } from '../src/errors.js';
import { WriteLease } from '../src/lease.js';
import type { IosActInvoke, InvokeResult } from '../src/ios-act-client.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-device-m1-'));
  dirs.push(dir);
  return dir;
}

function jsonInvoke(handler: (request: Record<string, unknown>, args: string[]) => object): { invoke: IosActInvoke; calls: { file: string; args: string[]; input?: string }[] } {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const invoke: IosActInvoke = async (file, args, options) => {
    calls.push({ file, args, input: options?.input });
    const request = JSON.parse(options?.input || '{}') as Record<string, unknown>;
    const body = handler(request, args);
    return { code: 0, stdout: JSON.stringify(body), stderr: '' } satisfies InvokeResult;
  };
  return { invoke, calls };
}

const healthy = {
  v: 1 as const, ok: true, deviceOnline: true, wdaReady: true, scriptFound: true, entropyModule: true,
  detail: 'M1 真机通道就绪。',
};

describe('M1Adapter', () => {
  it('默认宿主是 M1、默认真机是 LLD12，能力声明支付必须走 human_gate', () => {
    const adapter = new M1Adapter({
      config: resolveDeviceConfig({}, { home: tmp() }),
      leaseDir: tmp(),
      invoke: async () => ({ code: 0, stdout: JSON.stringify(healthy), stderr: '' }),
    });
    const caps = adapter.capabilities();
    expect(caps).toMatchObject({
      channel: 'm1', host: 'm1', udid: LLD12_UDID, canPay: true, needsUnlock: true,
      visionOnly: false, uiTree: true, entropy: true, writeControl: true,
    });
    expect(adapter.channel).toBe('m1');
  });

  it('health 走桥接 JSON，不抛异常，并把 UDID / entropy 传给 ios_act', async () => {
    const { invoke, calls } = jsonInvoke(() => healthy);
    const home = tmp();
    const adapter = new M1Adapter({
      config: resolveDeviceConfig({ PA_DEVICE_ENTROPY: 'low' }, { home }),
      leaseDir: tmp(),
      invoke,
    });
    const health = await adapter.health();
    expect(health).toMatchObject({ ok: true, channel: 'm1', deviceOnline: true, wdaReady: true, entropyModule: true });
    expect(calls[0]?.args).toContain(LLD12_UDID);
    expect(calls[0]?.args).toContain('--json');
    expect(calls[0]?.args).toContain('low');
    expect(JSON.parse(calls[0]?.input || '{}')).toMatchObject({ v: 1, op: 'health' });
  });

  it('Python 不存在时 health 返回未就绪而不是抛错', async () => {
    const adapter = new M1Adapter({
      config: resolveDeviceConfig({}, { home: tmp() }),
      leaseDir: tmp(),
      invoke: async () => ({ code: null, stdout: '', stderr: '', notFound: true }),
    });
    const health = await adapter.health();
    expect(health.ok).toBe(false);
    expect(health.pythonFound).toBe(false);
    expect(health.detail).toContain('Python');
  });

  it('observe 返回结构化 Observation，含截图', async () => {
    const adapter = new M1Adapter({
      config: resolveDeviceConfig({}, { home: tmp() }),
      leaseDir: tmp(),
      invoke: async (_file, _args, options) => {
        const request = JSON.parse(options?.input || '{}') as { op?: string; includeTree?: boolean };
        expect(request.op).toBe('observe');
        return {
          code: 0,
          stdout: JSON.stringify({
            v: 1, ok: true, width: 390, height: 844, screenshotBase64: FAKE_PNG_BASE64, screenshotMime: 'image/png',
            bundleId: 'com.apple.springboard', ...(request.includeTree ? { tree: { role: 'Application' } } : {}),
          }),
          stderr: '',
        };
      },
    });
    const shot = await adapter.observe();
    expect(shot.channel).toBe('m1');
    expect(shot.screenshot.base64).toBe(FAKE_PNG_BASE64);
    expect(shot.tree).toBeUndefined();
    const withTree = await adapter.observe({ includeTree: true });
    expect(withTree.tree).toMatchObject({ role: 'Application' });
  });

  it('act 必须持有本通道写控租约，并把熵档位传下去', async () => {
    const { invoke, calls } = jsonInvoke(() => ({ v: 1, ok: true, notes: ['tap'] }));
    const leaseDir = tmp();
    const adapter = new M1Adapter({
      config: resolveDeviceConfig({ PA_DEVICE_ENTROPY: 'high' }, { home: tmp() }),
      leaseDir,
      invoke,
    });
    await expect(adapter.act({ type: 'tap', x: 10, y: 20 }, {
      id: 'missing', channel: 'm1', holder: 'x', acquiredAt: 't', expiresAt: 't',
    })).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
    const session = await adapter.acquire({ holder: 'skill:meituan' });
    const result = await adapter.act({ type: 'tap', x: 10, y: 20 }, session);
    expect(result.ok).toBe(true);
    const request = JSON.parse(calls.at(-1)?.input || '{}') as { action?: { entropy?: string }; entropy?: string };
    expect(request.entropy).toBe('high');
    expect(request.action).toMatchObject({ type: 'tap', x: 10, y: 20 });
  });

  it('验证码 / 支付应答变成 HumanGateError，并通知上层 hook', async () => {
    const gates: string[] = [];
    const adapter = new M1Adapter({
      config: resolveDeviceConfig({}, { home: tmp() }),
      leaseDir: tmp(),
      onHumanGate: request => { gates.push(request.reason); },
      invoke: async () => ({
        code: 2,
        stdout: JSON.stringify({ ok: false, error: { code: 'HUMAN_GATE', reason: 'captcha', message: '需要完成验证码。' } }),
        stderr: '',
      }),
    });
    const session = await adapter.acquire({ holder: 'bot' });
    await expect(adapter.act({ type: 'tap', x: 1, y: 1 }, session)).rejects.toBeInstanceOf(HumanGateError);
    await expect(adapter.act({ type: 'tap', x: 1, y: 1 }, session)).rejects.toMatchObject({ reason: 'captcha', code: 'HUMAN_GATE' });
    expect(gates).toEqual(['captcha', 'captcha']);
  });

  it('支付门在契约层拦住无人下单', () => {
    expect(() => requirePaymentGate()).toThrow(HumanGateError);
    try { requirePaymentGate(); }
    catch (error) {
      expect(error).toMatchObject({ reason: 'payment', code: 'HUMAN_GATE' });
    }
  });
});

describe('FakeDeviceExecutor 烟测路径', () => {
  it('health + observe 不依赖真机', async () => {
    const fake = new FakeDeviceExecutor({ lease: new WriteLease({ dir: tmp(), ttlMs: 5_000 }) });
    const health = await fake.health();
    const observation = await fake.observe({ includeTree: true });
    expect(health.ok).toBe(true);
    expect(observation.screenshot.base64).toBe(FAKE_PNG_BASE64);
    expect(observation.tree?.label).toBe('Settings');
    const session = await fake.acquire({ holder: 'smoke' });
    await fake.act({ type: 'launch', bundleId: 'com.meituan.imeituan' }, session);
    const after = await fake.observe();
    expect(after.bundleId).toBe('com.meituan.imeituan');
  });

  it('损坏的 observe JSON 对 M1 是 OBSERVE_FAILED', async () => {
    const adapter = new M1Adapter({
      config: resolveDeviceConfig({}, { home: tmp() }),
      leaseDir: tmp(),
      invoke: async () => ({ code: 1, stdout: 'not-json', stderr: '' }),
    });
    await expect(adapter.observe()).rejects.toBeInstanceOf(DeviceError);
    await expect(adapter.observe()).rejects.toMatchObject({ code: 'OBSERVE_FAILED' });
  });
});
