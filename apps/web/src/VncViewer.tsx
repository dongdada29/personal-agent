import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, Spin } from 'antd';
import type RFB from '@novnc/novnc';
import { api } from './api';
import { desktopBridge, openDesktopChannel, vncCloseMessage, vncWebSocketUrl } from './vnc-channel';

/**
 * 经 server 鉴权代理打开的 Linux 桌面。
 * 浏览器先申请一张 60 秒一次性桌面票，再把票放进 WebSocket 子协议 `pa-dt.<ticket>`；
 * Electron 由主进程代申请票并代连（渲染进程拿不到端口、令牌或票）。
 * VNC 口令只在服务端完成 RFB 认证，前端永远看不到。
 */
export function VncViewer({ deploymentId, desktopId, title, viewOnly = false, onClose }: {
  deploymentId: string; desktopId: string; title: string; viewOnly?: boolean; onClose: () => void;
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
        // Electron 主进程自己去申请票；浏览器必须在握手前把票放进子协议。
        const protocols = ['binary'];
        if (!bridge) {
          const minted = await api.mintDesktopTicket(deploymentId, desktopId);
          if (cancelled) return;
          protocols.push(`pa-dt.${minted.ticket}`);
        }
        session = new Client(surface.current, channel, { shared: true, wsProtocols: protocols });
        session.scaleViewport = true;
        session.clipViewport = true;
        // 只读：前端也关掉输入；真正的丢弃在服务端 RfbViewOnlyFilter。
        session.viewOnly = viewOnly;
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
  }, [deploymentId, desktopId, viewOnly, onClose]);

  return <Modal open title={title} onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width="90vw" destroyOnClose>
    {status === 'connecting' && <div className="vnc-status"><Spin /> 正在经鉴权代理连接桌面…</div>}
    {status === 'error' && message && <Alert type="error" showIcon message={message} />}
    <div ref={surface} className="vnc-frame" role="application" aria-label={title} />
  </Modal>;
}
