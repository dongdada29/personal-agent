/**
 * 调用 M1 上现有 ios_act.py 的 JSON 门面。
 *
 * 本模块从不直连 Appium：一律 `python3 m1_bridge.py --script ios_act.py --udid …`，
 * 请求走 stdin，应答走 stdout。测试注入 invoke，不启动真 Python。
 */
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import type { DeviceAction, EntropyGear, Observation, UiNode } from './types.js';
import { DeviceError, HumanGateError, type HumanGateReason } from './errors.js';

export interface InvokeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  notFound?: boolean;
  timedOut?: boolean;
}

export type IosActInvoke = (file: string, args: string[], options?: {
  input?: string;
  timeoutMs?: number;
  maxBytes?: number;
}) => Promise<InvokeResult>;

export interface IosActRequest {
  v: 1;
  op: 'health' | 'observe' | 'act';
  includeTree?: boolean;
  action?: DeviceAction;
  entropy?: EntropyGear;
}

export interface IosActHealthBody {
  deviceOnline?: boolean;
  wdaReady?: boolean;
  scriptFound?: boolean;
  entropyModule?: boolean;
  detail?: string;
  width?: number;
  height?: number;
  bundleId?: string;
}

export interface IosActObserveBody {
  width?: number;
  height?: number;
  screenshotBase64?: string;
  screenshotMime?: 'image/png' | 'image/jpeg';
  tree?: UiNode;
  bundleId?: string;
  notes?: string[];
}

export interface IosActActBody {
  clipboardText?: string;
  notes?: string[];
}

export interface IosActResponse extends IosActHealthBody, IosActObserveBody, IosActActBody {
  v?: 1;
  ok: boolean;
  error?: { code?: string; reason?: string; message?: string };
}

const GATE_REASONS: ReadonlySet<string> = new Set(['captcha', 'payment', 'face_id', 'unlock', 'confirm']);

export const defaultIosActInvoke: IosActInvoke = (file, args, options = {}) => new Promise(resolve => {
  const child = execFile(file, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: options.timeoutMs ?? 20_000,
    maxBuffer: options.maxBytes ?? 8 * 1024 * 1024,
    env: { ...process.env },
  }, (error, stdout, stderr) => {
    if (!error) { resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' }); return; }
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: string | number };
    if (failure.code === 'ENOENT') { resolve({ code: null, stdout: '', stderr: '', notFound: true }); return; }
    resolve({
      code: typeof failure.code === 'number' ? failure.code : null,
      stdout: stdout ?? '',
      stderr: stderr ?? '',
      ...(failure.killed || failure.signal ? { timedOut: true } : {}),
    });
  });
  child.stdin?.on('error', () => undefined);
  if (options.input !== undefined) child.stdin?.end(options.input);
  else child.stdin?.end();
});

export function pathExists(path: string): boolean {
  try { accessSync(path, constants.F_OK); return true; }
  catch { return false; }
}

export function parseIosActResponse(stdout: string): IosActResponse {
  const trimmed = stdout.trim();
  if (!trimmed) throw new DeviceError('HEALTH_FAILED', 'ios_act 没有返回 JSON。');
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); }
  catch { throw new DeviceError('HEALTH_FAILED', 'ios_act 返回的不是 JSON。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DeviceError('HEALTH_FAILED', 'ios_act 返回的 JSON 不是对象。');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.ok !== 'boolean') throw new DeviceError('HEALTH_FAILED', 'ios_act 返回缺少 ok 字段。');
  return record as unknown as IosActResponse;
}

export function throwIfRemoteError(response: IosActResponse, fallback: DeviceError['code']): void {
  if (response.ok) return;
  const code = response.error?.code;
  const message = response.error?.message || '设备通道拒绝了本次操作。';
  const reason = response.error?.reason;
  if (code === 'HUMAN_GATE' || (reason && GATE_REASONS.has(reason))) {
    const gate = (reason && GATE_REASONS.has(reason) ? reason : 'confirm') as HumanGateReason;
    throw new HumanGateError(gate, message);
  }
  if (code === 'DEVICE_OFFLINE') throw new DeviceError('DEVICE_OFFLINE', message);
  if (code === 'WDA_NOT_READY') throw new DeviceError('WDA_NOT_READY', message);
  if (code === 'SCRIPT_MISSING') throw new DeviceError('SCRIPT_MISSING', message);
  throw new DeviceError(fallback, message);
}

/** 把桥接 observe 应答收成结构化 Observation；缺截图视为失败。 */
export function observationFromResponse(
  response: IosActResponse,
  channel: Observation['channel'],
  capturedAt: string,
): Observation {
  if (!response.screenshotBase64 || typeof response.screenshotBase64 !== 'string') {
    throw new DeviceError('OBSERVE_FAILED', '观察结果缺少截图。');
  }
  const width = Number(response.width);
  const height = Number(response.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new DeviceError('OBSERVE_FAILED', '观察结果缺少有效的屏幕尺寸。');
  }
  return {
    capturedAt,
    channel,
    width,
    height,
    screenshot: {
      mime: response.screenshotMime === 'image/jpeg' ? 'image/jpeg' : 'image/png',
      base64: response.screenshotBase64,
    },
    ...(response.tree ? { tree: response.tree } : {}),
    ...(typeof response.bundleId === 'string' ? { bundleId: response.bundleId } : {}),
    ...(response.notes ? { notes: response.notes } : {}),
  };
}
