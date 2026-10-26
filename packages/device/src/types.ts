import type { HumanGateReason } from './errors.js';

/** 已规划的通道。Phase 1 只实现 m1；m4 / esp32 仅占位，禁止当写控主路径。 */
export const DEVICE_CHANNEL_IDS = ['m1', 'm4', 'esp32', 'web', 'fake'] as const;
export type DeviceChannelId = (typeof DEVICE_CHANNEL_IDS)[number];

/** 拟人熵档位。off 表示坐标原样下发；现有 ios_act / human_entropy 有档位时透传。 */
export type EntropyGear = 'off' | 'low' | 'medium' | 'high';

export interface Point {
  x: number;
  y: number;
}

export interface UiBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 可选 UI 树；视觉-only 通道（ESP32）可以不提供。 */
export interface UiNode {
  role?: string;
  label?: string;
  value?: string;
  bounds?: UiBounds;
  children?: UiNode[];
}

export interface Screenshot {
  mime: 'image/png' | 'image/jpeg';
  /** PNG/JPEG 的标准 base64，不含 data: 前缀。 */
  base64: string;
}

export interface Observation {
  capturedAt: string;
  channel: DeviceChannelId;
  width: number;
  height: number;
  screenshot: Screenshot;
  tree?: UiNode;
  bundleId?: string;
  notes?: string[];
}

export type DeviceAction =
  | { type: 'tap'; x: number; y: number; entropy?: EntropyGear }
  | { type: 'swipe'; from: Point; to: Point; durationMs?: number; entropy?: EntropyGear }
  | { type: 'type'; text: string }
  | { type: 'launch'; bundleId: string }
  | { type: 'clipboard'; op: 'get' | 'set'; text?: string };

export interface ActResult {
  ok: true;
  clipboardText?: string;
  notes?: string[];
}

export interface ObserveInput {
  includeTree?: boolean;
}

/**
 * 通道能力声明。编排层按此选路，技能不写死宿主机。
 * canPay=true 仍必须走 human_gate；false 的通道（规划中的 ESP32）不得被选去做外卖支付。
 */
export interface DeviceCapabilities {
  channel: DeviceChannelId;
  /** 默认写控宿主，例如 m1。 */
  host: string;
  /** 真机 UDID；网页通道可省略。 */
  udid?: string;
  canPay: boolean;
  needsUnlock: boolean;
  visionOnly: boolean;
  /** 是否能取 accessibility / XML 树。 */
  uiTree: boolean;
  entropy: boolean;
  writeControl: boolean;
  /** 人类可读说明，不含路径。 */
  detail: string;
}

export interface DeviceHealth {
  ok: boolean;
  channel: DeviceChannelId;
  host: string;
  udid?: string;
  deviceOnline: boolean;
  wdaReady: boolean;
  scriptFound: boolean;
  pythonFound: boolean;
  entropyModule: boolean;
  detail: string;
  checkedAt: string;
}

export interface DeviceSession {
  id: string;
  channel: DeviceChannelId;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface HumanGateRequest {
  reason: HumanGateReason;
  message: string;
  observation?: Observation;
}

/**
 * 意图层回调：执行器检测到验证码 / 支付 / Face ID 时先通知，再抛 HumanGateError。
 * 回调不得被当成“已批准支付”——批准必须来自明确的人工确认。
 */
export type HumanGateHandler = (request: HumanGateRequest) => Promise<void> | void;

export interface AcquireOptions {
  holder: string;
  ttlMs?: number;
}

/**
 * 统一设备执行器契约。新通道只实现这一组方法；编排层不感知 USB 还是蓝牙。
 *
 * - health / capabilities：只读，不占写控租约。
 * - observe：截图（可选 UI 树）；不要求租约，但不得通过它下发手势。
 * - act：必须持有本通道的写控租约。
 * - acquire / release：全局单写控；同一时刻只允许一个通道写。
 */
export interface DeviceExecutor {
  readonly channel: DeviceChannelId;
  capabilities(): DeviceCapabilities;
  health(): Promise<DeviceHealth>;
  observe(input?: ObserveInput): Promise<Observation>;
  act(action: DeviceAction, session: DeviceSession): Promise<ActResult>;
  acquire(options: AcquireOptions): Promise<DeviceSession>;
  release(session: DeviceSession): Promise<void>;
}

export interface ChannelDescriptor {
  id: DeviceChannelId;
  role: 'default' | 'backup' | 'experimental' | 'readonly' | 'test';
  implemented: boolean;
  detail: string;
}
