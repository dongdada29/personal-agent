/**
 * 测试 / 烟测用的内存执行器：不启动 Appium、不碰真机、不读本机路径。
 * 生产默认通道仍是 M1；只有显式 channel=fake 或烟测脚本才会构造它。
 */
import type {
  AcquireOptions, ActResult, DeviceAction, DeviceCapabilities, DeviceChannelId, DeviceExecutor,
  DeviceHealth, DeviceSession, Observation, ObserveInput, UiNode,
} from './types.js';
import { DeviceError } from './errors.js';
import { WriteLease } from './lease.js';

/** 1×1 透明 PNG，避免测试依赖真截图。 */
export const FAKE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const FAKE_TREE: UiNode = {
  role: 'Application',
  label: 'Settings',
  children: [{ role: 'Button', label: 'Wi-Fi', bounds: { x: 20, y: 80, width: 300, height: 44 } }],
};

export interface FakeDeviceExecutorOptions {
  channel?: DeviceChannelId;
  host?: string;
  lease?: WriteLease;
  now?: () => number;
  capabilities?: Partial<DeviceCapabilities>;
}

export class FakeDeviceExecutor implements DeviceExecutor {
  readonly channel: DeviceChannelId;
  private readonly host: string;
  private readonly lease?: WriteLease;
  private readonly now: () => number;
  private readonly extraCaps: Partial<DeviceCapabilities>;
  private bundleId = 'com.apple.Preferences';
  private clipboard = '';
  private notes: string[] = [];

  constructor(options: FakeDeviceExecutorOptions = {}) {
    this.channel = options.channel ?? 'fake';
    this.host = options.host ?? 'fake';
    this.lease = options.lease;
    this.now = options.now ?? Date.now;
    this.extraCaps = options.capabilities ?? {};
  }

  capabilities(): DeviceCapabilities {
    return {
      channel: this.channel,
      host: this.host,
      canPay: false,
      needsUnlock: false,
      visionOnly: false,
      uiTree: true,
      entropy: true,
      writeControl: true,
      detail: '内存假通道，只供测试与本地烟测，不能支付。',
      ...this.extraCaps,
    };
  }

  async health(): Promise<DeviceHealth> {
    return {
      ok: true,
      channel: this.channel,
      host: this.host,
      deviceOnline: true,
      wdaReady: true,
      scriptFound: true,
      pythonFound: true,
      entropyModule: false,
      detail: 'fake 通道就绪。',
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  async observe(input: ObserveInput = {}): Promise<Observation> {
    return {
      capturedAt: new Date(this.now()).toISOString(),
      channel: this.channel,
      width: 390,
      height: 844,
      screenshot: { mime: 'image/png', base64: FAKE_PNG_BASE64 },
      ...(input.includeTree ? { tree: FAKE_TREE } : {}),
      bundleId: this.bundleId,
      notes: [...this.notes],
    };
  }

  async act(action: DeviceAction, session: DeviceSession): Promise<ActResult> {
    this.assertSession(session);
    if (action.type === 'launch') this.bundleId = action.bundleId;
    if (action.type === 'clipboard' && action.op === 'set') this.clipboard = action.text ?? '';
    if (action.type === 'tap') this.notes = [`tap:${action.x},${action.y}`];
    if (action.type === 'swipe') this.notes = [`swipe:${action.from.x},${action.from.y}->${action.to.x},${action.to.y}`];
    if (action.type === 'type') this.notes = [`type:${action.text.length}`];
    return {
      ok: true,
      ...(action.type === 'clipboard' && action.op === 'get' ? { clipboardText: this.clipboard } : {}),
      notes: [...this.notes],
    };
  }

  async acquire(options: AcquireOptions): Promise<DeviceSession> {
    if (!this.lease) {
      const acquiredAt = new Date(this.now()).toISOString();
      return {
        id: `fake-${this.channel}`,
        channel: this.channel,
        holder: options.holder,
        acquiredAt,
        expiresAt: new Date(this.now() + (options.ttlMs ?? 60_000)).toISOString(),
      };
    }
    return this.lease.acquire(this.channel, options.holder, options.ttlMs);
  }

  async release(session: DeviceSession): Promise<void> {
    this.lease?.release(session);
  }

  private assertSession(session: DeviceSession): void {
    if (session.channel !== this.channel) {
      throw new DeviceError('SESSION_MISMATCH', '会话不属于当前假通道。');
    }
    if (this.lease) {
      const held = this.lease.peek();
      if (!held || held.sessionId !== session.id) {
        throw new DeviceError('SESSION_REQUIRED', '写控租约无效或已过期，请先 acquire。');
      }
    }
  }
}
