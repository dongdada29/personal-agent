import { createServer, type AddressInfo, type Server } from 'node:net';
import type { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { RFB_VERSION } from '../../src/rfb-preauth.js';

/** 假 Xvnc：RFB 3.8 + VncAuth，不校验口令；吃掉 ClientInit 后再回显后续帧。 */
export function attachFakeVncAuth(socket: Duplex): void {
  let buffered = Buffer.alloc(0);
  let phase: 'version' | 'select' | 'response' | 'clientInit' | 'echo' = 'version';
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (phase === 'version') {
      if (buffered.length < RFB_VERSION.length) return;
      buffered = buffered.subarray(RFB_VERSION.length);
      phase = 'select';
      socket.write(Buffer.from([1, 2]));
    }
    if (phase === 'select') {
      if (buffered.length < 1) return;
      buffered = buffered.subarray(1);
      phase = 'response';
      socket.write(Buffer.alloc(16, 7));
    }
    if (phase === 'response') {
      if (buffered.length < 16) return;
      buffered = buffered.subarray(16);
      phase = 'clientInit';
      socket.write(Buffer.from([0, 0, 0, 0]));
    }
    if (phase === 'clientInit') {
      if (buffered.length < 1) return;
      // 真 Xvnc 在这里发 ServerInit，不会把 ClientInit 原样回给浏览器。
      buffered = buffered.subarray(1);
      phase = 'echo';
      if (buffered.length) socket.write(buffered);
      buffered = Buffer.alloc(0);
      socket.on('data', data => socket.write(data));
      socket.off('data', onData);
    }
  };
  socket.write(RFB_VERSION);
  socket.on('data', onData);
}

export async function fakeVncAuthGate(tokens: Map<string, string>): Promise<{ server: Server; port: number; preambles: string[] }> {
  const preambles: string[] = [];
  const server = createServer(socket => {
    let buffered = '';
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('latin1');
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      socket.off('data', onData);
      const line = buffered.slice(0, newline);
      preambles.push(line);
      const rest = Buffer.from(buffered.slice(newline + 1), 'latin1');
      const match = /^PA-BOX-GATE 1 (d[1-3]) ([A-Za-z0-9_-]{43})$/.exec(line);
      if (!match || tokens.get(match[1]) !== match[2]) { socket.end('ERR UNAUTHORIZED\n'); return; }
      socket.write('OK\n');
      if (rest.length) socket.unshift(rest);
      attachFakeVncAuth(socket);
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, preambles };
}

const queuedMessages = new WeakMap<WebSocket, Buffer[]>();

function queueMessages(ws: WebSocket): void {
  if (queuedMessages.has(ws)) return;
  const queue: Buffer[] = [];
  queuedMessages.set(ws, queue);
  ws.on('message', (data: Buffer) => queue.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)));
}

export function onceMessage(ws: WebSocket, timeoutMs = 5_000): Promise<Buffer> {
  queueMessages(ws);
  const queue = queuedMessages.get(ws)!;
  if (queue.length) return Promise.resolve(queue.shift()!);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RFB message timeout')), timeoutMs);
    const onMessage = () => {
      if (!queue.length) return;
      ws.off('message', onMessage);
      clearTimeout(timer);
      resolve(queue.shift()!);
    };
    ws.on('message', onMessage);
    ws.once('error', reject);
  });
}

/** 走完服务端呈现给浏览器的 SecurityTypes None，之后就是普通 RFB。 */
export async function completeBrowserRfbNone(ws: WebSocket): Promise<void> {
  const version = await onceMessage(ws);
  if (!version.equals(RFB_VERSION)) throw new Error(`unexpected RFB version ${version.toString()}`);
  ws.send(RFB_VERSION);
  const types = await onceMessage(ws);
  if (types.length < 2 || types[0] !== 1 || types[1] !== 1) throw new Error(`unexpected security types ${[...types]}`);
  ws.send(Buffer.from([1]));
  const result = await onceMessage(ws);
  if (result.readUInt32BE(0) !== 0) throw new Error('RFB None rejected');
  ws.send(Buffer.from([1]));
}

export async function mintDesktopTicket(
  app: { inject: Function },
  desktopId: string,
  headers: Record<string, string> = {},
  deploymentId = 'local',
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/box/deployments/${deploymentId}/desktops/${desktopId}/tickets`,
    headers: { host: '127.0.0.1:47801', 'content-type': 'application/json', ...headers },
    payload: {},
  });
  if (response.statusCode !== 200) throw Object.assign(new Error(`ticket ${response.statusCode}`), { status: response.statusCode, body: response.json() });
  const ticket = response.json().ticket as string;
  if (typeof ticket !== 'string') throw new Error('ticket missing');
  return ticket;
}

/** 申请票并用 pa-dt 子协议打开桌面 WebSocket（尚未做浏览器侧 RFB None）。 */
export function openTicketedVnc(
  port: number,
  desktopId: string,
  ticket: string,
  headers: Record<string, string> = {},
  deploymentId = 'local',
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/box/deployments/${deploymentId}/desktops/${desktopId}/vnc`,
      ['binary', `pa-dt.${ticket}`],
      { headers },
    );
    queueMessages(ws);
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_request, response) => reject(Object.assign(new Error(`HTTP ${response.statusCode}`), { status: response.statusCode })));
    ws.once('error', reject);
  });
}
