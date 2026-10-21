import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, Spin } from 'antd';
import type RFB from '@novnc/novnc';
import { desktopBridge, openDesktopChannel, vncCloseMessage, vncWebSocketUrl } from './vnc-channel';

/**
 * 经 server 鉴权代理打开的 Linux 桌面。
 * 浏览器走同源 WebSocket；Electron 走主进程 MessagePort 桥（渲染进程拿不到端口或令牌）。
 */
export function VncViewer({ deploymentId, desktopId, title, onClose }: {
  deploymentId: string; desktopId: string; title: string; onClose: () => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'open' | 'error'>('connecting');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const target = surface.current;
    if (!target) return;
    let cancelled = false;
    let session: RFB | undefined;
    void (async () => {
      try {
        const { default: Client } = await import('@novnc/novnc');
        if (cancelled || !surface.current) return;
        const bridge = desktopBridge();
        const channel = bridge
          ? openDesktopChannel(bridge, deploymentId, desktopId)
          : vncWebSocketUrl(window.location, deploymentId, desktopId);
        session = new Client(surface.current, channel, { shared: true, wsProtocols: ['binary'] });
        session.scaleViewport = true;
        session.clipViewport = true;
        session.addEventListener('connect', () => { if (!cancelled) setStatus('open'); });
        session.addEventListener('disconnect', (event) => {
          if (cancelled) return;
          const code = typeof (event as { code?: number }).code === 'number' ? (event as { code: number }).code : event.detail?.clean ? 1000 : 1006;
          const hint = vncCloseMessage(code);
          if (hint) { setStatus('error'); setMessage(hint); }
          else onClose();
        });
      } catch (cause) {
        if (!cancelled) { setStatus('error'); setMessage(cause instanceof Error ? cause.message : '无法打开桌面。'); }
      }
    })();
    return () => { cancelled = true; try { session?.disconnect(); } catch { /* 已经断开 */ } };
  }, [deploymentId, desktopId, onClose]);

  return <Modal open title={title} onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width="90vw" destroyOnClose>
    {status === 'connecting' && <div className="vnc-status"><Spin /> 正在经鉴权代理连接桌面…</div>}
    {status === 'error' && message && <Alert type="error" showIcon message={message} />}
    <div ref={surface} className="vnc-frame" role="application" aria-label={title} />
  </Modal>;
}
