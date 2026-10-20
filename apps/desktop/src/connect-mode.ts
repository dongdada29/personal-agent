import { request } from 'node:http';

/**
 * 连接模式：不启动新 server，而是连接本机已在运行的实例（例如 `npm run dev` 的 127.0.0.1:47801）。
 * 只允许本机回环地址；只支持 loopback 访问模式的实例（paired 实例要求 HTTPS 与设备 Cookie，
 * 应直接用浏览器访问其公开地址）。
 */
export const DEFAULT_CONNECT_URL = 'http://127.0.0.1:47801';

export function parseConnectUrl(input: string): { port: number; url: string } | undefined {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return undefined; }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash) return undefined;
  if (url.pathname !== '/' && url.pathname !== '') return undefined;
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return undefined;
  const port = Number(url.port || 80);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
  return { port, url: `http://127.0.0.1:${port}` };
}

export type ProbeResult = { ok: true } | { ok: false; code: 'UNREACHABLE' | 'NOT_PERSONAL_AGENT' | 'NOT_LOOPBACK' | 'DESKTOP_INSTANCE' };

/** 探测目标是否是 loopback 模式的 Personal Agent 实例。 */
export function probeInstance(port: number, timeoutMs = 3_000): Promise<ProbeResult> {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path: '/api/session', method: 'GET', headers: { host: `127.0.0.1:${port}`, accept: 'application/json' }, timeout: timeoutMs }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { if (body.length < 4096) body += chunk; });
      response.on('end', () => {
        if (response.statusCode === 401) { resolve({ ok: false, code: 'DESKTOP_INSTANCE' }); return; }
        let session: { mode?: unknown; desktop?: unknown } | undefined;
        try { session = JSON.parse(body); } catch { /* 下方统一处理 */ }
        if (response.statusCode !== 200 || !session || typeof session !== 'object') { resolve({ ok: false, code: 'NOT_PERSONAL_AGENT' }); return; }
        if (session.mode !== 'loopback') { resolve({ ok: false, code: 'NOT_LOOPBACK' }); return; }
        resolve({ ok: true });
      });
    });
    req.once('timeout', () => req.destroy());
    req.once('error', () => resolve({ ok: false, code: 'UNREACHABLE' }));
    req.end();
  });
}
