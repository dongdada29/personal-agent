/**
 * 设备执行器层烟测：只走 DeviceExecutor 的 health + observe。
 *
 * 默认使用 fake 通道（CI / 无真机），不监听 47801，也不改生产实例。
 * 在 M1 上对 LLD12 做真机探测：npm run device:smoke -- --real
 *
 * 演示口 47811 可同时开着；本脚本不占用端口。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeviceOrchestrator } from '../packages/device/src/index.js';
import { failCli, isMain } from './cli.js';

export interface DeviceSmokeOptions {
  real?: boolean;
  includeTree?: boolean;
}

export async function runDeviceSmoke(options: DeviceSmokeOptions = {}) {
  const leaseDir = mkdtempSync(join(tmpdir(), 'pa-device-smoke-'));
  try {
    const orch = createDeviceOrchestrator(options.real
      ? { channel: 'm1', leaseDir, env: { ...process.env, PA_DEVICE_CHANNEL: 'm1' } }
      : { channel: 'fake', leaseDir, env: { ...process.env, PA_DEVICE_CHANNEL: 'fake' } });
    const health = await orch.health();
    let observation: { width: number; height: number; hasScreenshot: boolean; hasTree: boolean; bundleId?: string; channel: string } | undefined;
    if (health.ok) {
      const shot = await orch.observe({ includeTree: options.includeTree === true });
      observation = {
        channel: shot.channel,
        width: shot.width,
        height: shot.height,
        hasScreenshot: Boolean(shot.screenshot?.base64),
        hasTree: Boolean(shot.tree),
        ...(shot.bundleId ? { bundleId: shot.bundleId } : {}),
      };
    }
    const pass = health.ok && (!options.real || Boolean(observation?.hasScreenshot));
    return {
      result: pass ? 'PASS' : 'NEEDS_ACTION',
      smoke: 'health+observe',
      channel: orch.defaultChannel,
      productionPortUntouched: 47801,
      demoPortOk: 47811,
      health: {
        ok: health.ok,
        channel: health.channel,
        host: health.host,
        deviceOnline: health.deviceOnline,
        wdaReady: health.wdaReady,
        scriptFound: health.scriptFound,
        pythonFound: health.pythonFound,
        entropyModule: health.entropyModule,
        detail: health.detail,
      },
      ...(observation ? { observation } : {}),
      next: options.real
        ? '真机未就绪时检查 USB、WDA 与 PA_DEVICE_IOS_ACT；不要改 47801。'
        : 'CI 使用 fake。M1 真机请加 --real。',
    };
  } finally {
    rmSync(leaseDir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let real = false, includeTree = false;
    for (const arg of args) {
      if (arg === '--real') real = true;
      else if (arg === '--tree') includeTree = true;
      else throw Object.assign(new Error('Usage'), { code: 'CLI_ARGUMENT' });
    }
    const result = await runDeviceSmoke({ real, includeTree });
    console.log(JSON.stringify(result, null, 2));
    if (result.result !== 'PASS') process.exitCode = 1;
  } catch (error) { failCli(error); }
}
