import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { openVncBridge, vncUpstreamUrl, type PortLike } from '../src/vnc-bridge.js';

const TOKEN = 'b'.repeat(43);
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(done => { server.closeAllConnections(); server.close(done); }))); });

/** 模拟 MessagePortMain：记录主进程发往渲染进程的消息，并能模拟渲染进程发来的消息。 */
class FakePort extends EventEmitter implements PortLike {
  sent: any[] = [];
  closed = false;
  postMessage(message: unknown) { if (this.closed) throw new Error('closed'); this.sent.push(message); this.emit('posted', message); }
  start() {}
  close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
  fromRenderer(message: unknown) { this.emit('message', { data: message }); }
  next(type: string) {
    return new Promise<any>(resolve => {
      const found = this.sent.find(item => item.type === type);
      if (found) { resolve(found); return; }
      const listener = (message: any) => { if (message.type === type) { this.off('posted', listener); resolve(message); } };
      this.on('posted', listener);
    });
  }
}

async function gateServer(onConnection: (headers: Record<string, unknown>, socket: import('ws').WebSocket) => void, reject?: number) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, handleProtocols: protocols => protocols.has('binary') ? 'binary' : false });
  server.on('upgrade', (request, socket, head) => {
    if (reject) { socket.end(`HTTP/1.1 ${reject} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    wss.handleUpgrade(request, socket, head, ws => onConnection(request.headers, ws));
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
}

describe('VNC MessagePort bridge', () => {
  it('validates deployment and desktop ids before building the upstream URL', () => {
    expect(vncUpstreamUrl({ port: 5 }, 'local', 'd1')).toBe('ws://127.0.0.1:5/api/box/deployments/local/desktops/d1/vnc');
    for (const [deployment, desktop] of [['local', 'd4'], ['../x', 'd1'], ['local', 'd1/../../x'], ['cloud-xyz', 'd1']]) {
      expect(vncUpstreamUrl({ port: 5 }, deployment, desktop)).toBeUndefined();
    }
    const port = new FakePort();
    openVncBridge({ port: 5 }, 'local', 'd9', port);
    expect(port.sent).toEqual([{ type: 'close', code: 1008, reason: 'invalid desktop' }]);
    expect(port.closed).toBe(true);
  });

  it('authenticates upstream with the launch token and relays binary frames both ways', async () => {
    let headers: Record<string, unknown> = {};
    const received: Buffer[] = [];
    const gatePort = await gateServer((seen, ws) => {
      headers = seen;
      ws.send(Buffer.from('RFB 003.008\n'));
      ws.on('message', data => { received.push(data as Buffer); ws.send(data as Buffer); });
    });
    const port = new FakePort();
    const close = openVncBridge({ port: gatePort, token: TOKEN }, 'local', 'd2', port);
    await port.next('open');
    const banner = await port.next('data');
    expect(Buffer.from(banner.data).toString()).toBe('RFB 003.008\n');
    expect(headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, host: `127.0.0.1:${gatePort}`, 'sec-websocket-protocol': 'binary' });
    expect(headers.origin).toBeUndefined();
    port.fromRenderer({ type: 'data', data: new Uint8Array([1, 2, 3]).buffer });
    await expect.poll(() => received.length).toBe(1);
    expect([...received[0]]).toEqual([1, 2, 3]);
    port.fromRenderer({ type: 'data', data: 'text is ignored' });
    close();
    expect(port.sent.at(-1)).toMatchObject({ type: 'close', code: 1000 });
    expect(port.closed).toBe(true);
  });

  it('maps HTTP rejections to 4000+status close codes and closes the port', async () => {
    const gatePort = await gateServer(() => {}, 429);
    const port = new FakePort();
    openVncBridge({ port: gatePort, token: TOKEN }, 'local', 'd1', port);
    expect(await port.next('close')).toMatchObject({ code: 4429 });
    expect(port.closed).toBe(true);
  });

  it('closes upstream when the renderer closes its port', async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>(done => { upstreamClosed = done; });
    const gatePort = await gateServer((_headers, ws) => { ws.on('close', () => upstreamClosed()); });
    const port = new FakePort();
    openVncBridge({ port: gatePort }, 'local', 'd3', port);
    await port.next('open');
    port.fromRenderer({ type: 'close' });
    await closed;
  });
});
