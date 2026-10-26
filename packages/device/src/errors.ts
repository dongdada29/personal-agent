/**
 * 设备执行器层的固定错误码。说明文本是给编排层 / 技能看的中文，
 * 从不附带 Appium / WDA / 脚本的原始输出（可能含本机路径）。
 */
export type DeviceErrorCode =
  | 'DEVICE_OFFLINE'
  | 'WDA_NOT_READY'
  | 'SCRIPT_MISSING'
  | 'PYTHON_MISSING'
  | 'SESSION_REQUIRED'
  | 'SESSION_MISMATCH'
  | 'WRITE_LEASE_HELD'
  | 'WRITE_LEASE_STALE'
  | 'CHANNEL_NOT_IMPLEMENTED'
  | 'MULTI_CHANNEL_WRITE_FORBIDDEN'
  | 'HUMAN_GATE'
  | 'ACT_FAILED'
  | 'OBSERVE_FAILED'
  | 'HEALTH_FAILED'
  | 'INPUT_INVALID';

export type HumanGateReason = 'captcha' | 'payment' | 'face_id' | 'unlock' | 'confirm';

export class DeviceError extends Error {
  constructor(
    readonly code: DeviceErrorCode,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'DeviceError';
  }
}

/**
 * 验证码 / 支付 / Face ID / 解锁：执行器暂停，把控制权交回意图层。
 * 技能在支付前也应主动抛出，而不是指望通道自己识别收银台。
 */
export class HumanGateError extends DeviceError {
  readonly reason: HumanGateReason;

  constructor(reason: HumanGateReason, message: string) {
    super('HUMAN_GATE', message, 409);
    this.name = 'HumanGateError';
    this.reason = reason;
  }
}

export class WriteLeaseError extends DeviceError {
  readonly heldBy?: { channel: string; holder: string };

  constructor(message: string, heldBy?: { channel: string; holder: string }, code: DeviceErrorCode = 'WRITE_LEASE_HELD') {
    super(code, message, 409);
    this.name = 'WriteLeaseError';
    this.heldBy = heldBy;
  }
}

/** 支付前的强制人工门：无人下单在契约层就被挡住。 */
export function requirePaymentGate(): never {
  throw new HumanGateError('payment', '支付必须经人工确认（human_gate），禁止无人下单。');
}

/** 技能在敏感步（验证码、Face ID、解锁）显式暂停时使用。 */
export function requireHumanGate(reason: HumanGateReason, message: string): never {
  throw new HumanGateError(reason, message);
}
