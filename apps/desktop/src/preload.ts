import { contextBridge, ipcRenderer } from 'electron';

/**
 * 沙箱 preload：只暴露最小的桌面能力，不暴露 ipcRenderer 本身。
 * VNC 的 MessagePort 无法经 contextBridge 直接传递，按 Electron 推荐方式用 window.postMessage
 * 转交给页面（限定同源 app://personal-agent）。
 */
let counter = 0;
const nextRequestId = () => `vnc-${Date.now().toString(36)}-${(counter++).toString(36)}`;

ipcRenderer.on('vnc:port', (event, payload: { requestId?: unknown }) => {
  if (!payload || typeof payload.requestId !== 'string' || !event.ports[0]) return;
  window.postMessage({ type: 'personal-agent-vnc-port', requestId: payload.requestId }, window.location.origin, [event.ports[0]]);
});

contextBridge.exposeInMainWorld('personalAgentDesktop', {
  version: 1,
  info: (): Promise<{ mode: 'managed' | 'connect'; platform: string; version: string }> => ipcRenderer.invoke('desktop:info'),
  switchMode: (mode: 'managed' | 'connect'): Promise<void> => ipcRenderer.invoke('desktop:switch-mode', mode),
  /** 请求主进程建立 VNC 桥；返回 requestId，页面随后通过 message 事件收到对应的 MessagePort。 */
  openVnc: (deploymentId: string, desktopId: string): string => {
    const requestId = nextRequestId();
    ipcRenderer.send('vnc:open', { requestId, deploymentId, desktopId });
    return requestId;
  },
});
