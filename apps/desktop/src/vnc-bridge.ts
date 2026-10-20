import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';
import type { UpstreamTarget } from './proxy.js';

/**
 * noVNC 桥：自定义协议 app:// 无法承载 WebSocket，所以由主进程代为连接
 * ws://127.0.0.1:<port>/api/box/deployments/<id>/desktops/<dN>/vnc。
 *
 * 第四层桌面票：先 POST 申请 60 秒一次性票，再把票放进子协议 `pa-dt.<ticket>`。
 * 启动令牌只出现在主进程的 Authorization 头；渲染进程既拿不到端口、令牌，也拿不到票。
 *
 * MessagePort 上的消息格式：
 *   主 → 渲染 { type:'open' } | { type:'data', data:ArrayBuffer } | { type:'close', code, reason }
 *   渲染 → 主 { type:'data', data:ArrayBuffer } | { type:'close' }
 */
export interface PortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  start(): void;
  close(): void;
}

export const DEPLOYMENT_ID = /^(?:local|cloud-[a-f0-9-]{36})$/u;
export const DESKTOP_ID = /^d[1-3]$/u;
const MAX_BUFFERED = 8 * 1024 * 1024;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function vncUpstreamUrl(target: UpstreamTarget, deploymentId: string, desktopId: string): string | undefined {
  if (!DEPLOYMENT_ID.test(deploymentId) || !DESKTOP_ID.test(desktopId)) return undefined;
  return `ws://127.0.0.1:${target.port}/api/box/deployments/${deploymentId}/desktops/${desktopId}/vnc`;
}

export function desktopTicketPath(deploymentId: string, desktopId: string): string | undefined {
  if (!DEPLOYMENT_ID.test(deploymentId) || !DESKTOP_ID.test(desktopId)) return undefined;
  return `/api/box/deployments/${deploymentId}/desktops/${desktopId}/tickets`;
}

const toBuffer = (data: unknown): Buffer | undefined => {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
};

/** 向本机服务申请一张一次性桌面票。票只在主进程内存里停留到 WebSocket 握手完成。 */
export function mintDesktopTicket(
  target: UpstreamTarget,
  deploymentId: string,
  desktopId: string,
  post: typeof httpRequest = httpRequest,
): Promise<string> {
  const path = desktopTicketPath(deploymentId, desktopId);
  if (!path) return Promise.reject(new Error('invalid desktop'));
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: `127.0.0.1:${target.port}`,
      'content-type': 'application/json',
      'content-length': '2',
    };
    if (target.token) headers.authorization = `Bearer ${target.token}`;
    const request = post({ host: '127.0.0.1', port: target.port, method: 'POST', path, headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ticket?: unknown };
          if (response.statusCode !== 200 || typeof body.ticket !== 'string' || !TICKET_PATTERN.test(body.ticket)) {
            reject(Object.assign(new Error('desktop ticket rejected'), { status: response.statusCode ?? 502 }));
            return;
          }
          resolve(body.ticket);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
    request.end('{}');
  });
}

export interface VncBridgeOptions {
  createSocket?: (url: string, protocols: string[], options: WebSocket.ClientOptions) => WebSocket;
  mintTicket?: (target: UpstreamTarget, deploymentId: string, desktopId: string) => Promise<string>;
}

/** 建立一条桥；返回关闭函数。任何一端关闭都会关闭另一端。 */
export function openVncBridge(target: UpstreamTarget, deploymentId: string, desktopId: string, port: PortLike,
  options: VncBridgeOptions = {}): () => void {
  const createSocket = options.createSocket ?? ((url, protocols, socketOptions) => new WebSocket(url, protocols, socketOptions));
  const requestTicket = options.mintTicket ?? mintDesktopTicket;
  const url = vncUpstreamUrl(target, deploymentId, desktopId);
  let closed = false;
  let socket: WebSocket | undefined;
  const finish = (code = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    try { port.postMessage({ type: 'close', code, reason: reason.slice(0, 120) }); } catch { /* 端口已关闭 */ }
    try { port.close(); } catch { /* ignore */ }
    try { socket?.close(); } catch { /* ignore */ }
  };
  if (!url) { port.start(); finish(1008, 'invalid desktop'); return () => {}; }
  const headers: Record<string, string> = { host: `127.0.0.1:${target.port}` };
  if (target.token) headers.authorization = `Bearer ${target.token}`;

  const attach = (ticket: string) => {
    if (closed) return;
    // binary 给 noVNC；pa-dt.<ticket> 给服务端一次性票校验。
    const upstream = createSocket(url, ['binary', `pa-dt.${ticket}`], { headers, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 30_000 });
    socket = upstream;
    upstream.binaryType = 'nodebuffer';
    upstream.on('open', () => { if (!closed) port.postMessage({ type: 'open' }); });
    upstream.on('message', (data: Buffer, isBinary: boolean) => {
      if (closed || !isBinary) return;
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      port.postMessage({ type: 'data', data: copy.buffer });
    });
    upstream.on('unexpected-response', (_request, response) => {
      // HTTP 错误（未授权 / 准入拒绝 / 桌面未运行等）映射为 4000 + 状态码，渲染进程据此给出提示。
      finish(4000 + Math.min(999, response.statusCode ?? 502), `HTTP ${response.statusCode ?? 502}`);
    });
    upstream.on('close', (code, reason) => finish(code === 1005 ? 1000 : code, reason.toString('utf8')));
    upstream.on('error', () => finish(1011, 'upstream error'));
  };

  void requestTicket(target, deploymentId, desktopId).then(attach, error => {
    const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 401;
    finish(4000 + Math.min(999, status), 'desktop ticket');
  });
  port.on('message', event => {
    const message = event.data as { type?: unknown; data?: unknown } | null;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'close') { finish(1000, ''); return; }
    if (message.type !== 'data' || !socket || socket.readyState !== WebSocket.OPEN) return;
    const buffer = toBuffer(message.data);
    if (!buffer) return;
    // 渲染端发送过快（例如粘贴大量文本）时直接断开，而不是无限缓冲。
    if (socket.bufferedAmount > MAX_BUFFERED) { finish(1009, 'backpressure'); return; }
    socket.send(buffer, { binary: true });
  });
  port.on('close', () => finish(1000, ''));
  port.start();
  return () => finish(1000, '');
}
