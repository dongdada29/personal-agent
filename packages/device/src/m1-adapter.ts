/**
 * M1Adapter：把 M1 上现有的 ios_act.py（及可选 human_entropy）包成 DeviceExecutor。
 *
 * 默认宿主 m1、默认真机 LLD12。技能只看到 observe / act / session，看不到 Appium URL。
 */
import type {
  AcquireOptions, ActResult, DeviceAction, DeviceCapabilities, DeviceExecutor, DeviceHealth,
  DeviceSession, HumanGateHandler, Observation, ObserveInput,
} from './types.js';
import { DeviceError, HumanGateError } from './errors.js';
import { DEFAULT_DEVICE_HOST, LLD12_UDID, resolveDeviceConfig, type DeviceConfig } from './config.js';
import { WriteLease } from './lease.js';
import {
  defaultIosActInvoke, observationFromResponse, parseIosActResponse, pathExists, throwIfRemoteError,
  type IosActInvoke, type IosActRequest, type IosActResponse,
} from './ios-act-client.js';

export interface M1AdapterOptions {
  config?: DeviceConfig;
  env?: NodeJS.ProcessEnv;
  lease?: WriteLease;
  leaseDir?: string;
  invoke?: IosActInvoke;
  now?: () => number;
  onHumanGate?: HumanGateHandler;
}

const M1_DETAIL = 'M1 · Appium/WDA 真机通道（LLD12 USB）。支付必须 human_gate。';

export class M1Adapter implements DeviceExecutor {
  readonly channel = 'm1' as const;
  readonly config: DeviceConfig;
  private readonly lease: WriteLease;
  private readonly invoke: IosActInvoke;
  private readonly now: () => number;
  private readonly onHumanGate?: HumanGateHandler;

  constructor(options: M1AdapterOptions = {}) {
    this.config = options.config ?? resolveDeviceConfig(options.env);
    this.now = options.now ?? Date.now;
    this.invoke = options.invoke ?? defaultIosActInvoke;
    this.lease = options.lease ?? new WriteLease({
      dir: options.leaseDir ?? this.config.leaseDir,
      now: this.now,
      ttlMs: this.config.leaseTtlMs,
    });
    this.onHumanGate = options.onHumanGate;
  }

  capabilities(): DeviceCapabilities {
    return {
      channel: 'm1',
      host: this.config.host || DEFAULT_DEVICE_HOST,
      udid: this.config.udid || LLD12_UDID,
      canPay: true,
      needsUnlock: true,
      visionOnly: false,
      uiTree: true,
      entropy: true,
      writeControl: true,
      detail: M1_DETAIL,
    };
  }

  async health(): Promise<DeviceHealth> {
    const checkedAt = new Date(this.now()).toISOString();
    const pythonFound = this.config.python.length > 0;
    const scriptFound = pathExists(this.config.iosActScript);
    const bridgeFound = pathExists(this.config.bridgeScript);
    const base = {
      channel: this.channel,
      host: this.config.host,
      udid: this.config.udid,
      scriptFound,
      pythonFound,
      entropyModule: false,
      checkedAt,
    };
    if (!pythonFound) {
      return { ...base, ok: false, deviceOnline: false, wdaReady: false, detail: '未配置 Python 解释器。' };
    }
    if (!bridgeFound) {
      return { ...base, ok: false, deviceOnline: false, wdaReady: false, detail: '缺少 m1_bridge.py。' };
    }
    try {
      const response = await this.call({ v: 1, op: 'health' }, 15_000, 'HEALTH_FAILED');
      const deviceOnline = response.deviceOnline === true;
      const wdaReady = response.wdaReady === true;
      const entropyModule = response.entropyModule === true;
      const ok = response.ok && deviceOnline && wdaReady && (response.scriptFound !== false);
      return {
        ...base,
        ok,
        deviceOnline,
        wdaReady,
        scriptFound: response.scriptFound === undefined ? scriptFound : response.scriptFound === true,
        entropyModule,
        detail: response.detail || (ok ? 'M1 真机通道就绪。' : 'M1 真机通道未就绪。'),
      };
    } catch (error) {
      if (error instanceof DeviceError && error.code === 'PYTHON_MISSING') {
        return { ...base, pythonFound: false, ok: false, deviceOnline: false, wdaReady: false, detail: '未找到 Python 解释器。' };
      }
      const detail = error instanceof DeviceError ? error.message : '健康检查失败。';
      return { ...base, ok: false, deviceOnline: false, wdaReady: false, detail };
    }
  }

  async observe(input: ObserveInput = {}): Promise<Observation> {
    const response = await this.call({
      v: 1,
      op: 'observe',
      includeTree: input.includeTree === true,
      entropy: this.config.entropy,
    }, 30_000, 'OBSERVE_FAILED');
    throwIfRemoteError(response, 'OBSERVE_FAILED');
    return observationFromResponse(response, 'm1', new Date(this.now()).toISOString());
  }

  async act(action: DeviceAction, session: DeviceSession): Promise<ActResult> {
    this.assertSession(session);
    if (action.type === 'clipboard' && action.op === 'set' && (action.text === undefined || action.text.includes('\0'))) {
      throw new DeviceError('INPUT_INVALID', '剪贴板写入内容无效。', 400);
    }
    if (action.type === 'type' && action.text.includes('\0')) {
      throw new DeviceError('INPUT_INVALID', '输入文本无效。', 400);
    }
    const response = await this.call({
      v: 1,
      op: 'act',
      action,
      entropy: action.type === 'tap' || action.type === 'swipe' ? (action.entropy ?? this.config.entropy) : this.config.entropy,
    }, 30_000, 'ACT_FAILED');
    throwIfRemoteError(response, 'ACT_FAILED');
    return {
      ok: true,
      ...(typeof response.clipboardText === 'string' ? { clipboardText: response.clipboardText } : {}),
      ...(response.notes ? { notes: response.notes } : {}),
    };
  }

  async acquire(options: AcquireOptions): Promise<DeviceSession> {
    if (!options.holder.trim()) throw new DeviceError('INPUT_INVALID', '写控 holder 不能为空。', 400);
    return this.lease.acquire('m1', options.holder, options.ttlMs ?? this.config.leaseTtlMs);
  }

  async release(session: DeviceSession): Promise<void> {
    this.lease.release(session);
  }

  private assertSession(session: DeviceSession): void {
    if (session.channel !== 'm1') {
      throw new DeviceError('SESSION_MISMATCH', '会话不属于 M1 通道。');
    }
    const held = this.lease.peek();
    if (!held || held.sessionId !== session.id) {
      throw new DeviceError('SESSION_REQUIRED', '写控租约无效或已过期，请先 acquire。');
    }
  }

  private async call(request: IosActRequest, timeoutMs: number, fallback: DeviceError['code']): Promise<IosActResponse> {
    const result = await this.invoke(this.config.python, [
      this.config.bridgeScript,
      '--script', this.config.iosActScript,
      '--udid', this.config.udid,
      '--host', this.config.host,
      '--entropy', request.entropy ?? this.config.entropy,
      '--json',
    ], { input: JSON.stringify(request), timeoutMs });
    if (result.notFound) throw new DeviceError('PYTHON_MISSING', '未找到 Python 解释器。');
    if (result.timedOut) throw new DeviceError(fallback, 'ios_act 调用超时。');
    let response: IosActResponse;
    try {
      response = parseIosActResponse(result.stdout);
    } catch (error) {
      if (result.code !== 0) throw new DeviceError(fallback, 'ios_act 调用失败。');
      throw error;
    }
    const reason = response.error?.reason;
    const isGate = response.error?.code === 'HUMAN_GATE' || reason === 'captcha' || reason === 'payment'
      || reason === 'face_id' || reason === 'unlock' || reason === 'confirm';
    if (!response.ok && isGate) {
      const gateError = this.gateError(response);
      await this.onHumanGate?.({ reason: gateError.reason, message: gateError.message });
      throw gateError;
    }
    return response;
  }

  private gateError(response: IosActResponse): HumanGateError {
    try {
      throwIfRemoteError(response, 'ACT_FAILED');
    } catch (error) {
      if (error instanceof HumanGateError) return error;
    }
    return new HumanGateError('confirm', response.error?.message || '需要人工确认。');
  }
}
