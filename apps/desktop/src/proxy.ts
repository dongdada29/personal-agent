import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';

/**
 * app:// → 127.0.0.1:<port> 的同源反向代理（运行在 Electron 主进程，不依赖 electron 模块，便于测试）。
 *
 * 渲染进程只看到 app://personal-agent/api/...，永远拿不到端口和令牌：
 * - 只转发 /api/ 前缀；主机守护进程接口（/api/box/agent/*）不允许经渲染进程访问；
 * - 丢弃渲染进程带来的 Origin / Referer / Cookie / Authorization / CSRF / Sec-Fetch-* 与逐跳头，
 *   由代理重新设置 Host 与 `Authorization: Bearer <本次启动令牌>`；
 * - 响应去掉 Set-Cookie 与逐跳头，正文以流的方式透传（SSE 可以持续推送）。
 */
export interface UpstreamTarget {
  port: number;
  /** 托管模式的本次启动令牌；连接模式（已有的本机实例）没有令牌。 */
  token?: string;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
const STRIPPED_REQUEST = new Set(['origin', 'referer', 'cookie', 'authorization', 'x-csrf-token', 'content-length']);
const STRIPPED_RESPONSE = new Set(['set-cookie', 'set-cookie2', 'content-length']);
const MAX_BODY_BYTES = 1024 * 1024;

export const APP_SCHEME = 'app';
export const APP_HOST = 'personal-agent';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** 允许经代理访问的路径：/api/ 下除主机守护进程接口外的全部。 */
export function proxiablePath(pathname: string): boolean {
  return pathname.startsWith('/api/') && !pathname.startsWith('/api/box/agent/') && !pathname.includes('\0');
}

export function upstreamHeaders(incoming: Headers, target: UpstreamTarget): Record<string, string> {
  const headers: Record<string, string> = {};
  incoming.forEach((value, name) => {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || STRIPPED_REQUEST.has(key) || key.startsWith('sec-fetch-')) return;
    headers[key] = value;
  });
  headers.host = `127.0.0.1:${target.port}`;
  if (target.token) headers.authorization = `Bearer ${target.token}`;
  return headers;
}

export function downstreamHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(key) || STRIPPED_RESPONSE.has(key)) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
  }
  return headers;
}

const jsonError = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ code, message }), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function readBody(request: Request): Promise<Buffer | undefined> {
  if (['GET', 'HEAD'].includes(request.method) || !request.body) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = request.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** 把一个 app:// 请求转发到上游；target 为 undefined 表示服务尚未就绪。 */
export async function proxyRequest(request: Request, target: UpstreamTarget | undefined): Promise<Response> {
  const url = new URL(request.url);
  if (!proxiablePath(url.pathname)) return jsonError(404, 'NOT_FOUND', 'Not found');
  if (!target) return jsonError(503, 'DESKTOP_SERVER_STARTING', 'The local service is not ready yet');
  let body: Buffer | undefined;
  try { body = await readBody(request); }
  catch { return jsonError(413, 'BODY_TOO_LARGE', 'Request body is too large'); }
  const headers = upstreamHeaders(request.headers, target);
  if (body) headers['content-length'] = String(body.length);
  return new Promise<Response>(resolve => {
    const upstream = httpRequest({ host: '127.0.0.1', port: target.port, method: request.method, path: url.pathname + url.search, headers }, response => {
      const status = response.statusCode ?? 502;
      const responseHeaders = downstreamHeaders(response.headers);
      // 204/304 与 HEAD 的响应不能带正文。
      if (status === 204 || status === 304 || request.method === 'HEAD') {
        response.resume();
        resolve(new Response(null, { status, headers: responseHeaders }));
        return;
      }
      const stream = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
      resolve(new Response(stream, { status, headers: responseHeaders }));
    });
    upstream.once('error', () => resolve(jsonError(502, 'DESKTOP_SERVER_UNAVAILABLE', 'The local service is unavailable')));
    // 渲染进程关闭 EventSource / 取消 fetch 时，立即断开上游连接，避免 SSE 连接泄漏。
    request.signal?.addEventListener('abort', () => upstream.destroy(), { once: true });
    upstream.end(body);
  });
}
