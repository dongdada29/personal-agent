/**
 * 设备执行器层（Phase 1）。
 *
 * 技能 / Bot 从这里拿 DeviceExecutor，不要直接 import Appium 或拼 ios_act 命令行。
 * 默认通道是 M1；M4 / ESP32 只作为后续 Adapter 占位。
 */
export {
  DeviceError, HumanGateError, WriteLeaseError, requireHumanGate, requirePaymentGate,
  type DeviceErrorCode, type HumanGateReason,
} from './errors.js';
export type {
  AcquireOptions, ActResult, ChannelDescriptor, DeviceAction, DeviceCapabilities, DeviceChannelId,
  DeviceExecutor, DeviceHealth, DeviceSession, EntropyGear, HumanGateHandler, HumanGateRequest,
  Observation, ObserveInput, Point, Screenshot, UiBounds, UiNode,
} from './types.js';
export { DEVICE_CHANNEL_IDS } from './types.js';
export {
  DEFAULT_DEVICE_CHANNEL, DEFAULT_DEVICE_HOST, DEFAULT_ENTROPY, DEFAULT_LEASE_TTL_MS, LLD12_UDID,
  packagedBridgePath, resolveDeviceConfig, type DeviceConfig,
} from './config.js';
export { WriteLease, type LeaseRecord, type WriteLeaseOptions } from './lease.js';
export { M1Adapter, type M1AdapterOptions } from './m1-adapter.js';
export { FakeDeviceExecutor, FAKE_PNG_BASE64, type FakeDeviceExecutorOptions } from './fake-adapter.js';
export {
  DeviceOrchestrator, CHANNEL_CATALOG, createDeviceOrchestrator, type DeviceOrchestratorOptions,
} from './orchestrator.js';
export {
  defaultIosActInvoke, parseIosActResponse, throwIfRemoteError, observationFromResponse,
  type IosActInvoke, type IosActRequest, type IosActResponse, type InvokeResult,
} from './ios-act-client.js';
