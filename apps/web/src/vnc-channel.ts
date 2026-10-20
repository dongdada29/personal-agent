/**
 * noVNC 的连接通道。
 *
 * - 浏览器（loopback / paired）：直接连接同源的 ws(s)://<host>/api/box/deployments/<id>/desktops/<dN>/vnc，
 *   由 server 用设备 Cookie / 回环规则鉴权；
 * - Electron 桌面客户端：app:// 无法承载 WebSocket，改由主进程代连（带启动令牌），
 *   这里把收到的 MessagePort 包装成 noVNC 接受的“WebSocket 形状”的通道对象。
 */
export interface DesktopBridge {
  version: number;
  info(): Promise<{ mode: 'managed' | 'connect'; platform: string; version: string }>;
  switchMode(mode: 'managed' | 'connect'): Promise<void>;
  openVnc(deploymentId: string, desktopId: string): string;
}

declare global {
  interface Window { personalAgentDesktop?: DesktopBridge }
}

export function desktopBridge(): DesktopBridge | undefined {
  return typeof window !== 'undefined' && window.personalAgentDesktop?.version === 1 ? window.personalAgentDesktop : undefined;
}

const DEPLOYMENT_ID = /^(?:local|cloud-[a-f0-9-]{36})$/u;
const DESKTOP_ID = /^d[1-3]$/u;

export function vncWebSocketUrl(location: { protocol: string; host: string }, deploymentId: string, desktopId: string): string {
  if (!DEPLOYMENT_ID.test(deploymentId) || !DESKTOP_ID.test(desktopId)) throw new Error('invalid desktop');
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/box/deployments/${deploymentId}/desktops/${desktopId}/vnc`;
}

type Listener = ((event: any) => void) | null;

/**
 * 以 MessagePort 实现的 WebSocket 子集：noVNC 只使用 send/close/binaryType/protocol/readyState
 * 与 onopen/onmessage/onclose/onerror。readyState 使用 WebSocket 的数值常量。
 */
export class MessagePortChannel {
  binaryType: BinaryType = 'arraybuffer';
  protocol = 'binary';
  onopen: Listener = null;
  onmessage: Listener = null;
  onclose: Listener = null;
  onerror: Listener = null;
  private state = 0;
  private port: MessagePort | undefined;
  private pending: ArrayBuffer[] = [];

  get readyState(): number { return this.state; }

  /** 绑定主进程传来的端口；在此之前 send 的数据会暂存。 */
  attach(port: MessagePort): void {
    if (this.state >= 2) { port.close(); return; }
    this.port = port;
    port.onmessage = (event: MessageEvent) => this.handle(event.data);
    port.start();
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (this.state !== 1 || !this.port) return;
    const buffer = data instanceof ArrayBuffer ? data.slice(0) : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.port.postMessage({ type: 'data', data: buffer }, [buffer as ArrayBuffer]);
  }

  close(): void {
    if (this.state >= 2) return;
    this.state = 2;
    try { this.port?.postMessage({ type: 'close' }); } catch { /* 端口已关闭 */ }
    this.finish(1000, '');
  }

  private handle(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const value = message as { type?: unknown; data?: unknown; code?: unknown; reason?: unknown };
    if (value.type === 'open' && this.state === 0) {
      this.state = 1;
      this.onopen?.({ type: 'open' });
      for (const buffer of this.pending.splice(0)) this.onmessage?.({ data: buffer });
      return;
    }
    if (value.type === 'data' && value.data instanceof ArrayBuffer) {
      if (this.state === 1) this.onmessage?.({ data: value.data });
      else if (this.state === 0) this.pending.push(value.data);
      return;
    }
    if (value.type === 'close') {
      const code = typeof value.code === 'number' ? value.code : 1006;
      if (code !== 1000) this.onerror?.({ type: 'error' });
      this.finish(code, typeof value.reason === 'string' ? value.reason : '');
    }
  }

  private finish(code: number, reason: string): void {
    if (this.state === 3) return;
    this.state = 3;
    try { this.port?.close(); } catch { /* ignore */ }
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }
}

/** 在桌面客户端中打开通道：请求主进程建立桥，等待对应 requestId 的 MessagePort。 */
export function openDesktopChannel(bridge: DesktopBridge, deploymentId: string, desktopId: string, target: Window = window): MessagePortChannel {
  const channel = new MessagePortChannel();
  const requestId = bridge.openVnc(deploymentId, desktopId);
  const onMessage = (event: MessageEvent) => {
    if (event.source !== target || event.origin !== target.location.origin) return;
    const data = event.data as { type?: unknown; requestId?: unknown } | null;
    if (!data || data.type !== 'personal-agent-vnc-port' || data.requestId !== requestId || !event.ports[0]) return;
    target.removeEventListener('message', onMessage);
    channel.attach(event.ports[0]);
  };
  target.addEventListener('message', onMessage);
  return channel;
}

/** HTTP 拒绝（桥把握手失败映射为 4000+状态码）→ 提示。 */
export function vncCloseMessage(code: number): string | undefined {
  if (code === 1000 || code === 1005) return undefined;
  if (code === 4401 || code === 1008) return '桌面连接未通过鉴权，请刷新页面后重试。';
  if (code === 4403) return '当前访问不允许打开桌面。';
  if (code === 4409 || code === 4429) return '桌面暂时不可用（未运行、已达上限或宿主内存紧张）。';
  if (code === 4502 || code === 4503 || code === 1011) return '无法连接 box 网关，请确认容器正在运行。';
  return `桌面连接已断开（${code}）。`;
}
