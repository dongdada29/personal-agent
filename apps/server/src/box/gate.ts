/**
 * box 网关（容器内 pa-box-gate）的客户端握手。
 *
 * 协议：连接后发送一行 `PA-BOX-GATE 1 <desktopId> <token>\n`，网关回复 `OK\n`（之后是原始 RFB 字节）
 * 或 `ERR <CODE>\n` 并关闭。令牌是每次打开桌面时新生成的 32 字节随机值，经 stdin 交给
 * pa-box-ctl，网关只接受 60 秒内写入、尚未用过的令牌（一次性）。
 * 再次打开桌面会轮换新令牌。令牌从不写日志、不返回给浏览器。
 */
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { BoxError } from './host-adapter.js';

export const newDesktopToken = (): string => randomBytes(32).toString('base64url');

const GATE_ERRORS: Record<string, [code: string, message: string, status: number]> = {
  UNAUTHORIZED: ['BOX_DESKTOP_TOKEN_REJECTED', 'box 网关拒绝了桌面令牌，请重新打开桌面。', 502],
  DESKTOP_DOWN: ['BOX_DESKTOP_NOT_RUNNING', '桌面未运行。', 409],
  BUSY: ['BOX_GATE_BUSY', 'box 网关连接数已满。', 503],
  BAD_PREAMBLE: ['BOX_GATE_PROTOCOL', 'box 网关协议不匹配（镜像版本可能过旧）。', 502],
};

/** 发送前导并等待网关应答；成功后返回同一条流（应答之后多读到的字节会退回流中）。 */
export function gateHandshake(stream: Duplex, desktopId: string, token: string, timeoutMs = 10_000): Promise<Duplex> {
  if (!/^d[1-9]$/.test(desktopId) || !/^[A-Za-z0-9_-]{43}$/.test(token)) return Promise.reject(new BoxError('BOX_INPUT_INVALID', '桌面或令牌无效。', 400));
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => { clearTimeout(timer); stream.off('data', onData); stream.off('error', onError); stream.off('close', onClose); };
    const fail = (error: BoxError) => { cleanup(); stream.destroy(); reject(error); };
    const timer = setTimeout(() => fail(new BoxError('BOX_GATE_TIMEOUT', 'box 网关未在限定时间内应答。', 504)), timeoutMs);
    timer.unref?.();
    const onError = () => fail(new BoxError('BOX_DESKTOP_UNREACHABLE', 'box 网关连接失败。', 502));
    const onClose = () => fail(new BoxError('BOX_DESKTOP_UNREACHABLE', 'box 网关连接已关闭。', 502));
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        if (buffered.length > 64) fail(new BoxError('BOX_GATE_PROTOCOL', 'box 网关协议不匹配。', 502));
        return;
      }
      const line = buffered.subarray(0, newline).toString('ascii');
      const rest = buffered.subarray(newline + 1);
      if (line === 'OK') {
        cleanup();
        stream.pause();
        if (rest.length) stream.unshift(rest);
        resolve(stream);
        return;
      }
      const code = /^ERR ([A-Z_]{1,32})$/.exec(line)?.[1];
      const [errorCode, message, status] = (code && GATE_ERRORS[code]) || GATE_ERRORS.BAD_PREAMBLE;
      fail(new BoxError(errorCode, message, status));
    };
    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('close', onClose);
    stream.write(`PA-BOX-GATE 1 ${desktopId} ${token}\n`);
  });
}
