import type { Duplex } from 'node:stream';
import { BoxError } from './box/host-adapter.js';
import { desEcbEncrypt } from './des-ecb.js';

/**
 * 服务端作为 VNC 客户端完成 RFB 3.8 VncAuth，再向浏览器呈现 SecurityTypes None。
 *
 * 口令只在这一层使用：不进 URL、不进前端、不进 API 响应、不写普通日志。
 * 浏览器拿到的是已经认证过的画面流，noVNC 不再需要口令。
 */
export const RFB_VERSION = Buffer.from('RFB 003.008\n');
const VNC_AUTH = 2;
const VNC_NONE = 1;

export class RfbAuthError extends BoxError {
  constructor(message: string) {
    super('BOX_VNC_AUTH_FAILED', message, 502);
    this.name = 'RfbAuthError';
  }
}

/** VNC 经典 DES：每个密钥字节按位反转后再做 ECB，挑战 16 字节分成两块。 */
export function encryptVncChallenge(challenge: Buffer, password: string): Buffer {
  if (challenge.length !== 16) throw new RfbAuthError('VNC challenge is invalid');
  const key = Buffer.alloc(8);
  Buffer.from(password, 'utf8').copy(key, 0, 0, 8);
  for (let index = 0; index < 8; index++) {
    let bits = key[index];
    bits = ((bits >>> 1) & 0x55) | ((bits << 1) & 0xaa);
    bits = ((bits >>> 2) & 0x33) | ((bits << 2) & 0xcc);
    bits = ((bits >>> 4) & 0x0f) | ((bits << 4) & 0xf0);
    key[index] = bits;
  }
  return desEcbEncrypt(challenge, key);
}

function readExact(stream: Duplex, size: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => { clearTimeout(timer); stream.off('data', onData); stream.off('error', onError); stream.off('close', onClose); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => fail(new RfbAuthError('VNC handshake timed out')), timeoutMs);
    timer.unref?.();
    const onError = () => fail(new RfbAuthError('VNC connection failed during authentication'));
    const onClose = () => fail(new RfbAuthError('VNC connection closed during authentication'));
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < size) return;
      cleanup();
      stream.pause();
      const extra = buffered.subarray(size);
      if (extra.length) stream.unshift(extra);
      resolve(buffered.subarray(0, size));
    };
    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('close', onClose);
    stream.resume();
  });
}

function writeAll(stream: Duplex, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, error => error ? reject(error) : resolve());
  });
}

/**
 * 与 Xvnc 完成 VncAuth。成功后流停在 ClientInit 之前，调用方再把它交给浏览器侧的 None 握手。
 */
export async function authenticateRfb(stream: Duplex, password: string, timeoutMs = 8_000): Promise<Duplex> {
  if (typeof password !== 'string' || password.length < 8 || password.includes('\0') || password.includes('\n')) {
    throw new RfbAuthError('VNC password is invalid');
  }
  const version = await readExact(stream, RFB_VERSION.length, timeoutMs);
  if (!version.equals(RFB_VERSION)) throw new RfbAuthError('VNC protocol version is not 3.8');
  await writeAll(stream, RFB_VERSION);
  const countBuf = await readExact(stream, 1, timeoutMs);
  const count = countBuf[0];
  if (count < 1 || count > 16) throw new RfbAuthError('VNC security types are invalid');
  const types = await readExact(stream, count, timeoutMs);
  if (![...types].includes(VNC_AUTH)) throw new RfbAuthError('VNC server did not offer VncAuth');
  await writeAll(stream, Buffer.from([VNC_AUTH]));
  const challenge = await readExact(stream, 16, timeoutMs);
  await writeAll(stream, encryptVncChallenge(challenge, password));
  const result = await readExact(stream, 4, timeoutMs);
  if (result.readUInt32BE(0) !== 0) throw new RfbAuthError('VNC authentication was rejected');
  return stream;
}

export interface RfbBrowserPeer {
  send(data: Buffer): void;
  onceMessage(timeoutMs?: number): Promise<Buffer>;
  /** 握手结束后取出尚未交给桌面的浏览器帧，并停止拦截后续 message。 */
  drain?(): Buffer[];
}

/** 向浏览器呈现 SecurityTypes None，消费它的版本协商与 ClientInit，再交给已经认证的 Xvnc。 */
export async function offerRfbNoneToBrowser(
  browser: RfbBrowserPeer,
  desktop: Duplex,
  timeoutMs = 8_000,
): Promise<void> {
  browser.send(RFB_VERSION);
  const version = await browser.onceMessage(timeoutMs);
  if (!version.equals(RFB_VERSION)) throw new RfbAuthError('Browser RFB version is not 3.8');
  browser.send(Buffer.from([1, VNC_NONE]));
  const selected = await browser.onceMessage(timeoutMs);
  if (selected.length !== 1 || selected[0] !== VNC_NONE) throw new RfbAuthError('Browser did not select SecurityTypes None');
  browser.send(Buffer.from([0, 0, 0, 0]));
  const clientInit = await browser.onceMessage(timeoutMs);
  if (clientInit.length < 1) throw new RfbAuthError('Browser omitted ClientInit');
  desktop.write(clientInit);
}

/** 把 WebSocket 包成 offerRfbNoneToBrowser 需要的 peer（单条消息队列）。 */
export function websocketRfbPeer(ws: {
  send(data: Buffer, options: { binary: true }, cb?: (error?: Error) => void): void;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
  off?(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
}): RfbBrowserPeer {
  const queue: Buffer[] = [];
  const waiters: Array<(data: Buffer) => void> = [];
  const onMessage = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (!isBinary) return;
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    const waiter = waiters.shift();
    if (waiter) waiter(buffer);
    else queue.push(buffer);
  };
  ws.on('message', onMessage);
  return {
    send(data) { ws.send(data, { binary: true }); },
    onceMessage(timeoutMs = 8_000) {
      if (queue.length) return Promise.resolve(queue.shift()!);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new RfbAuthError('Browser RFB handshake timed out')), timeoutMs);
        timer.unref?.();
        waiters.push(data => { clearTimeout(timer); resolve(data); });
      });
    },
    drain() {
      ws.off?.('message', onMessage);
      waiters.length = 0;
      return queue.splice(0);
    },
  };
}
