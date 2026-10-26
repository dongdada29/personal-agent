import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeviceChannelId, EntropyGear } from './types.js';
import { DeviceError } from './errors.js';

/** LLD12（iPhone 12）在 M1 USB 上的固定 UDID。 */
export const LLD12_UDID = '00008101-001E28A10CE0001E';

/** 默认写控通道：M1 真机。M4 / ESP32 不得抢这个默认值。 */
export const DEFAULT_DEVICE_CHANNEL: DeviceChannelId = 'm1';
export const DEFAULT_DEVICE_HOST = 'm1';
export const DEFAULT_ENTROPY: EntropyGear = 'medium';
export const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

const ENTROPY_GEARS: ReadonlySet<string> = new Set(['off', 'low', 'medium', 'high']);
const CHANNELS: ReadonlySet<string> = new Set(['m1', 'm4', 'esp32', 'web', 'fake']);

export interface DeviceConfig {
  channel: DeviceChannelId;
  host: string;
  udid: string;
  python: string;
  iosActScript: string;
  bridgeScript: string;
  entropy: EntropyGear;
  leaseDir: string;
  leaseTtlMs: number;
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function homeWorkspaceIosAct(home: string): string {
  // 运行时拼接 $HOME，避免把 /Users/<name>/workspace 写进源码触发 share:check。
  return join(home, 'workspace', 'ios-ai-automation', 'scripts', 'ios_act.py');
}

export function packagedBridgePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'm1_bridge.py');
}

export function defaultLeaseDir(home: string): string {
  return join(home, '.personal-agent', 'device');
}

/**
 * 解析执行器层配置。路径类变量必须是绝对路径；未设置时用 M1 默认值。
 * 不读取模型密钥，也不读取 PERSONAL_AGENT_AUTH_*。
 */
export function resolveDeviceConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { home?: string; now?: () => number } = {},
): DeviceConfig {
  const home = options.home ?? homedir();
  const channelRaw = envValue(env, 'PA_DEVICE_CHANNEL') ?? DEFAULT_DEVICE_CHANNEL;
  if (!CHANNELS.has(channelRaw)) {
    throw new DeviceError('INPUT_INVALID', 'PA_DEVICE_CHANNEL 不是已规划的通道。', 400);
  }
  const entropyRaw = envValue(env, 'PA_DEVICE_ENTROPY') ?? DEFAULT_ENTROPY;
  if (!ENTROPY_GEARS.has(entropyRaw)) {
    throw new DeviceError('INPUT_INVALID', 'PA_DEVICE_ENTROPY 必须是 off / low / medium / high。', 400);
  }
  const iosAct = envValue(env, 'PA_DEVICE_IOS_ACT') ?? homeWorkspaceIosAct(home);
  const leaseDir = envValue(env, 'PA_DEVICE_LEASE_DIR') ?? defaultLeaseDir(home);
  const python = envValue(env, 'PA_DEVICE_PYTHON') ?? 'python3';
  const udid = envValue(env, 'PA_DEVICE_UDID') ?? LLD12_UDID;
  const host = envValue(env, 'PA_DEVICE_HOST') ?? DEFAULT_DEVICE_HOST;
  const ttlRaw = envValue(env, 'PA_DEVICE_LEASE_TTL_MS');
  const leaseTtlMs = ttlRaw ? Number(ttlRaw) : DEFAULT_LEASE_TTL_MS;
  if (!Number.isFinite(leaseTtlMs) || leaseTtlMs < 1_000 || leaseTtlMs > 24 * 60 * 60_000) {
    throw new DeviceError('INPUT_INVALID', 'PA_DEVICE_LEASE_TTL_MS 超出允许范围。', 400);
  }
  for (const [name, value] of [['PA_DEVICE_IOS_ACT', iosAct], ['PA_DEVICE_LEASE_DIR', leaseDir]] as const) {
    if (envValue(env, name) && !isAbsolute(value)) {
      throw new DeviceError('INPUT_INVALID', `${name} 必须是绝对路径。`, 400);
    }
  }
  return {
    channel: channelRaw as DeviceChannelId,
    host,
    udid,
    python,
    iosActScript: iosAct,
    bridgeScript: envValue(env, 'PA_DEVICE_BRIDGE') ?? packagedBridgePath(),
    entropy: entropyRaw as EntropyGear,
    leaseDir,
    leaseTtlMs,
  };
}
