import { describe, expect, it, vi } from 'vitest';
import { MessagePortChannel, openDesktopChannel, vncCloseMessage, vncWebSocketUrl } from '../src/vnc-channel';

class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  started = false;
  closed = false;
  start() { this.started = true; }
  close() { this.closed = true; }
  postMessage(data: unknown) { this.posted.push(data); }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}

describe('noVNC channels', () => {
  it('builds same-origin websocket URLs and rejects other ids', () => {
    expect(vncWebSocketUrl({ protocol: 'https:', host: 'agent.example.test' }, 'local', 'd2'))
      .toBe('wss://agent.example.test/api/box/deployments/local/desktops/d2/vnc');
    expect(vncWebSocketUrl({ protocol: 'http:', host: '127.0.0.1:47801' }, 'cloud-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'd1'))
      .toBe('ws://127.0.0.1:47801/api/box/deployments/cloud-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/desktops/d1/vnc');
    expect(() => vncWebSocketUrl({ protocol: 'http:', host: '127.0.0.1' }, 'local', 'd9')).toThrow();
    expect(() => vncWebSocketUrl({ protocol: 'http:', host: '127.0.0.1' }, '../x', 'd1')).toThrow();
  });

  it('maps MessagePort frames to the WebSocket subset noVNC expects', () => {
    const channel = new MessagePortChannel();
    const port = new FakePort();
    expect(channel.readyState).toBe(0);
    expect(channel.protocol).toBe('binary');
    channel.attach(port as unknown as MessagePort);
    expect(port.started).toBe(true);
    const opened = vi.fn();
    const messages: ArrayBuffer[] = [];
    channel.onopen = opened;
    channel.onmessage = event => messages.push(event.data);
    port.emit({ type: 'open' });
    expect(opened).toHaveBeenCalledOnce();
    expect(channel.readyState).toBe(1);
    const payload = new Uint8Array([1, 2, 3]).buffer;
    port.emit({ type: 'data', data: payload });
    expect(messages).toHaveLength(1);
    channel.send(new Uint8Array([9, 8]));
    expect(port.posted).toEqual([{ type: 'data', data: expect.any(ArrayBuffer) }]);
    channel.close();
    expect(port.posted.at(-1)).toEqual({ type: 'close' });
    expect(channel.readyState).toBe(3);
    expect(port.closed).toBe(true);
  });

  it('opens a desktop MessagePort only for the matching request id and origin', () => {
    const listeners: Array<(event: MessageEvent) => void> = [];
    const target = {
      location: { origin: 'app://personal-agent' },
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => { listeners.push(listener); },
      removeEventListener: () => {},
    };
    const bridge = { version: 1, info: async () => ({ mode: 'managed' as const, platform: 'darwin', version: '0.1.0' }),
      switchMode: async () => {}, openVnc: () => 'vnc-req-1' };
    const channel = openDesktopChannel(bridge, 'local', 'd1', target as unknown as Window);
    const port = new FakePort();
    listeners[0]!({ source: target, origin: 'https://evil.example', data: { type: 'personal-agent-vnc-port', requestId: 'vnc-req-1' }, ports: [port] } as unknown as MessageEvent);
    expect(port.started).toBe(false);
    expect(channel.readyState).toBe(0);
    listeners[0]!({ source: target, origin: 'app://personal-agent', data: { type: 'personal-agent-vnc-port', requestId: 'other' }, ports: [port] } as unknown as MessageEvent);
    expect(port.started).toBe(false);
    listeners[0]!({ source: target, origin: 'app://personal-agent', data: { type: 'personal-agent-vnc-port', requestId: 'vnc-req-1' }, ports: [port] } as unknown as MessageEvent);
    expect(port.started).toBe(true);
  });

  it('maps HTTP-mapped close codes to operator-facing messages', () => {
    expect(vncCloseMessage(1000)).toBeUndefined();
    expect(vncCloseMessage(4401)).toMatch(/鉴权/);
    expect(vncCloseMessage(4409)).toMatch(/不可用/);
    expect(vncCloseMessage(4502)).toMatch(/网关/);
  });
});
