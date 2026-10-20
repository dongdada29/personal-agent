import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_ORIGIN, proxiablePath, proxyRequest, upstreamHeaders } from '../src/proxy.js';

let servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(done => { server.closeAllConnections(); server.close(done); }))); });

async function upstream(handler: (request: IncomingMessage, body: string, response: import('node:http').ServerResponse) => void) {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => handler(request, body, response));
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
}

const TOKEN = 'a'.repeat(43);

describe('app:// same-origin proxy', () => {
  it('strips renderer credentials and origin, and injects Host and the launch token', async () => {
    let seen: IncomingMessage | undefined, seenBody = '';
    const port = await upstream((request, body, response) => {
      seen = request; seenBody = body;
      response.writeHead(201, { 'content-type': 'application/json', 'set-cookie': 'x=1', connection: 'close' });
      response.end('{"ok":true}');
    });
    const response = await proxyRequest(new Request(`${APP_ORIGIN}/api/tasks?x=1`, {
      method: 'POST', body: '{"goal":"g"}',
      headers: { 'content-type': 'application/json', origin: APP_ORIGIN, cookie: 'pa-device-dev=secret', authorization: 'Bearer forged',
        'x-csrf-token': 'csrf', referer: `${APP_ORIGIN}/`, 'sec-fetch-site': 'same-origin', 'x-custom': 'kept' },
    }), { port, token: TOKEN });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(seen!.url).toBe('/api/tasks?x=1');
    expect(seen!.method).toBe('POST');
    expect(seenBody).toBe('{"goal":"g"}');
    expect(seen!.headers).toMatchObject({ host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, 'x-custom': 'kept', 'content-length': '12' });
    for (const header of ['origin', 'cookie', 'x-csrf-token', 'referer', 'sec-fetch-site']) expect(seen!.headers[header], header).toBeUndefined();
    // 原始头里只能有一个 Authorization（server 要求恰好一个）。
    expect(seen!.rawHeaders.filter((_, index) => index % 2 === 0 && seen!.rawHeaders[index].toLowerCase() === 'authorization')).toHaveLength(1);
  });

  it('connect mode forwards without any Authorization header', () => {
    const headers = upstreamHeaders(new Headers({ authorization: 'Bearer x', accept: 'text/event-stream' }), { port: 47801 });
    expect(headers).toEqual({ accept: 'text/event-stream', host: '127.0.0.1:47801' });
  });

  it('streams SSE responses incrementally and closes upstream when the renderer aborts', async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>(done => { upstreamClosed = done; });
    const port = await upstream((request, _body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      response.write('data: first\n\n');
      const timer = setInterval(() => response.write(': keepalive\n\n'), 50);
      request.socket.on('close', () => { clearInterval(timer); upstreamClosed(); });
    });
    const controller = new AbortController();
    const response = await proxyRequest(new Request(`${APP_ORIGIN}/api/tasks/t/events?stream=1`, { signal: controller.signal }), { port, token: TOKEN });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('data: first');
    controller.abort();
    await reader.cancel().catch(() => {});
    await closed;
  });

  it('refuses non-API and host-agent paths, and reports an unavailable or unready service', async () => {
    expect(proxiablePath('/api/tasks')).toBe(true);
    expect(proxiablePath('/api/box/agent/poll')).toBe(false);
    expect(proxiablePath('/index.html')).toBe(false);
    expect((await proxyRequest(new Request(`${APP_ORIGIN}/api/box/agent/register`, { method: 'POST', body: '{}' }), { port: 1 })).status).toBe(404);
    expect((await proxyRequest(new Request(`${APP_ORIGIN}/api/health`), undefined)).status).toBe(503);
    const closedPort = await upstream(() => {});
    const server = servers.pop()!;
    await new Promise(done => server.close(done));
    const unavailable = await proxyRequest(new Request(`${APP_ORIGIN}/api/health`), { port: closedPort, token: TOKEN });
    expect(unavailable.status).toBe(502);
    expect(await unavailable.json()).toMatchObject({ code: 'DESKTOP_SERVER_UNAVAILABLE' });
  });

  it('bounds request bodies and handles bodiless statuses', async () => {
    const port = await upstream((_request, _body, response) => { response.writeHead(204); response.end(); });
    expect((await proxyRequest(new Request(`${APP_ORIGIN}/api/x`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) }), { port })).status).toBe(413);
    const empty = await proxyRequest(new Request(`${APP_ORIGIN}/api/x`, { method: 'DELETE' }), { port });
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');
  });
});
