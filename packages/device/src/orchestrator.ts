/**
 * 薄编排入口：技能 / Bot 只通过这里拿执行器，不 import Appium、不拼 ios_act 命令行。
 *
 * Phase 1 固定默认通道 = M1。M4 / ESP32 若未注入适配器，直接 CHANNEL_NOT_IMPLEMENTED，
 * 避免“半实现通道”被误当成可写控。全局 WriteLease 禁止双开。
 */
import type {
  AcquireOptions, ChannelDescriptor, DeviceChannelId, DeviceExecutor, DeviceHealth, DeviceSession,
  HumanGateHandler, Observation, ObserveInput,
} from './types.js';
import { DeviceError } from './errors.js';
import { DEFAULT_DEVICE_CHANNEL, resolveDeviceConfig, type DeviceConfig } from './config.js';
import { WriteLease } from './lease.js';
import { M1Adapter } from './m1-adapter.js';
import { FakeDeviceExecutor } from './fake-adapter.js';
import type { IosActInvoke } from './ios-act-client.js';

export const CHANNEL_CATALOG: readonly ChannelDescriptor[] = [
  { id: 'm1', role: 'default', implemented: true, detail: 'M1 · Appium/WDA · LLD12。生产默认写控。' },
  { id: 'm4', role: 'backup', implemented: false, detail: '同栈备份，Phase 2。' },
  { id: 'esp32', role: 'experimental', implemented: false, detail: 'HID 实验旁路，Phase 3；canPay=false。' },
  { id: 'web', role: 'readonly', implemented: false, detail: '网页/H5 只读浏览，不承担支付。' },
  { id: 'fake', role: 'test', implemented: true, detail: '内存假通道，仅测试与本地烟测。' },
];

export interface DeviceOrchestratorOptions {
  channel?: DeviceChannelId;
  env?: NodeJS.ProcessEnv;
  config?: DeviceConfig;
  lease?: WriteLease;
  leaseDir?: string;
  invoke?: IosActInvoke;
  now?: () => number;
  onHumanGate?: HumanGateHandler;
  /** 测试或后续 Phase 注入已实现的备份通道。 */
  adapters?: Partial<Record<DeviceChannelId, DeviceExecutor>>;
}

export class DeviceOrchestrator {
  readonly defaultChannel: DeviceChannelId;
  private readonly lease: WriteLease;
  private readonly adapters: Partial<Record<DeviceChannelId, DeviceExecutor>>;
  private readonly m1: M1Adapter;
  private readonly fake: FakeDeviceExecutor;

  constructor(options: DeviceOrchestratorOptions = {}) {
    const config = options.config ?? resolveDeviceConfig(options.env);
    this.defaultChannel = options.channel ?? DEFAULT_DEVICE_CHANNEL;
    this.lease = options.lease ?? new WriteLease({
      dir: options.leaseDir ?? config.leaseDir,
      now: options.now,
      ttlMs: config.leaseTtlMs,
    });
    this.m1 = new M1Adapter({
      config,
      lease: this.lease,
      invoke: options.invoke,
      now: options.now,
      onHumanGate: options.onHumanGate,
    });
    this.fake = new FakeDeviceExecutor({ channel: 'fake', lease: this.lease, now: options.now });
    this.adapters = { m1: this.m1, fake: this.fake, ...options.adapters };
  }

  catalog(): readonly ChannelDescriptor[] {
    return CHANNEL_CATALOG.map(entry => ({
      ...entry,
      implemented: entry.implemented || this.adapters[entry.id] !== undefined,
    }));
  }

  /**
   * 按通道取执行器。未实现的通道抛错，而不是悄悄落到 M1——避免技能误以为已经切到备份。
   */
  executor(channel: DeviceChannelId = this.defaultChannel): DeviceExecutor {
    const adapter = this.adapters[channel];
    if (adapter) return adapter;
    throw new DeviceError(
      'CHANNEL_NOT_IMPLEMENTED',
      channel === 'm4'
        ? 'M4 备份通道尚未接入（Phase 2）。默认写控仍是 M1。'
        : channel === 'esp32'
          ? 'ESP32 通道未接入主路径（Phase 3 可选实验）。'
          : `通道 ${channel} 尚未实现。`,
    );
  }

  capabilities(channel?: DeviceChannelId) {
    return this.executor(channel).capabilities();
  }

  health(channel?: DeviceChannelId): Promise<DeviceHealth> {
    return this.executor(channel).health();
  }

  observe(input?: ObserveInput, channel?: DeviceChannelId): Promise<Observation> {
    return this.executor(channel).observe(input);
  }

  acquire(options: AcquireOptions, channel?: DeviceChannelId): Promise<DeviceSession> {
    return this.executor(channel).acquire(options);
  }

  release(session: DeviceSession): Promise<void> {
    return this.executor(session.channel).release(session);
  }
}

/** 技能侧推荐入口：不传 channel 就是 M1。 */
export function createDeviceOrchestrator(options?: DeviceOrchestratorOptions): DeviceOrchestrator {
  return new DeviceOrchestrator(options);
}
