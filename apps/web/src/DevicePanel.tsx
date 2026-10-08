import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Input, Modal, Spin, Tag } from 'antd';
import type { AuthSession, Device, PairingTicket } from '@personal-agent/contracts';
import { api } from './api';
import { notifyAuthRequired, pairingTicketLink } from './auth-session';
import { MutationFlight } from './mutation-commands';

export { pairingTicketLink } from './auth-session';

function time(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : '时间暂不可用';
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : '请求未成功，请重试。';
}

export function DevicePanel({ session }: { session: AuthSession }) {
  const currentDevice = session.device;
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ticket, setTicket] = useState<PairingTicket | null>(null);
  const [generating, setGenerating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmDevice, setConfirmDevice] = useState<Device | null>(null);
  const [copying, setCopying] = useState(false);
  const alive = useRef(false);
  const generation = useRef(0);
  const listController = useRef<AbortController | null>(null);
  const pairCommand = useRef<string | null>(null);
  const revokeCommands = useRef(new Map<string, string>());
  const mutations = useRef(new MutationFlight());
  const copyFlight = useRef(new MutationFlight());
  const busy = generating || revokingId !== null;
  const link = pairingTicketLink(ticket, window.location.origin);

  const loadDevices = useCallback(async () => {
    if (!alive.current) return;
    const requestGeneration = generation.current;
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    setLoading(true);
    try {
      const result = await api.listDevices(controller.signal);
      if (!alive.current || generation.current !== requestGeneration || controller.signal.aborted) return;
      setDevices(result.devices.filter((device) => device.revokedAt === null));
      setError(null);
    } catch (cause) {
      if (alive.current && generation.current === requestGeneration && !controller.signal.aborted) setError(message(cause));
    } finally {
      if (alive.current && generation.current === requestGeneration && !controller.signal.aborted) setLoading(false);
      if (listController.current === controller) listController.current = null;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    generation.current += 1;
    setDevices([]);
    setTicket(null);
    setConfirmDevice(null);
    setGenerating(false);
    setRevokingId(null);
    setCopying(false);
    setError(null);
    setNotice(null);
    pairCommand.current = null;
    revokeCommands.current.clear();
    mutations.current = new MutationFlight();
    copyFlight.current = new MutationFlight();
    if (session.mode === 'paired') void loadDevices();
    else setLoading(false);
    return () => {
      alive.current = false;
      generation.current += 1;
      listController.current?.abort();
      listController.current = null;
      pairCommand.current = null;
      revokeCommands.current.clear();
    };
  }, [loadDevices, session.mode, session.device?.id]);

  useEffect(() => {
    if (!ticket) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiresAt = Date.parse(ticket.expiresAt);
    function checkExpiry() {
      if (timer !== undefined) clearTimeout(timer);
      const remaining = expiresAt - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        setTicket(null);
        setNotice('配对链接已过期，请创建新的链接。');
        return;
      }
      timer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
    }
    checkExpiry();
    document.addEventListener('visibilitychange', checkExpiry);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', checkExpiry);
    };
  }, [ticket]);

  async function createTicket() {
    if (!alive.current || session.mode !== 'paired' || mutations.current.isRunning) return;
    const requestGeneration = generation.current;
    const commandId = pairCommand.current ?? crypto.randomUUID();
    pairCommand.current = commandId;
    setGenerating(true);
    setTicket(null);
    setError(null);
    setNotice(null);
    await mutations.current.run(async () => {
      try {
        const result = await api.createPairTicket({ commandId });
        if (!alive.current || generation.current !== requestGeneration) return;
        pairCommand.current = null;
        if (result.ticket === null) {
          setNotice('配对请求已确认，重复请求不会再次显示票据。请再点“创建新配对链接”生成新票据。');
        } else if (!pairingTicketLink(result, window.location.origin)) {
          setNotice('配对链接已过期，请创建新的链接。');
        } else {
          setTicket(result);
        }
      } catch (cause) {
        if (alive.current && generation.current === requestGeneration) setError(message(cause));
      } finally {
        if (alive.current && generation.current === requestGeneration) setGenerating(false);
      }
    });
  }

  async function copyLink() {
    if (!alive.current || copyFlight.current.isRunning) return;
    const value = pairingTicketLink(ticket, window.location.origin);
    if (!value) {
      setTicket(null);
      setNotice('配对链接已过期，请创建新的链接。');
      return;
    }
    const requestGeneration = generation.current;
    setCopying(true);
    await copyFlight.current.run(async () => {
      try {
        await navigator.clipboard.writeText(value);
        if (alive.current && generation.current === requestGeneration) setNotice('配对链接已复制。');
      } catch {
        if (alive.current && generation.current === requestGeneration) setError('复制未成功，请手动复制链接。');
      } finally {
        if (alive.current && generation.current === requestGeneration) setCopying(false);
      }
    });
  }

  async function revoke(device: Device) {
    if (!alive.current || mutations.current.isRunning) return;
    const requestGeneration = generation.current;
    const commandId = revokeCommands.current.get(device.id) ?? crypto.randomUUID();
    revokeCommands.current.set(device.id, commandId);
    setRevokingId(device.id);
    setError(null);
    setNotice(null);
    await mutations.current.run(async () => {
      try {
        const result = await api.revokeDevice(device.id, { commandId });
        if (!alive.current || generation.current !== requestGeneration) return;
        if (result.id !== device.id || result.revokedAt === null) throw new Error('撤销结果尚未确认，请重试或刷新设备。');
        revokeCommands.current.delete(device.id);
        // Retire an older list read before removing the acknowledged device.
        listController.current?.abort();
        setDevices((previous) => previous.filter((item) => item.id !== device.id));
        setConfirmDevice(null);
        if (device.id === currentDevice?.id) {
          setTicket(null);
          notifyAuthRequired();
          return;
        }
        setNotice(`已撤销“${device.name}”的访问。`);
        await loadDevices();
      } catch (cause) {
        if (alive.current && generation.current === requestGeneration) setError(message(cause));
      } finally {
        if (alive.current && generation.current === requestGeneration) setRevokingId(null);
      }
    });
  }

  if (session.mode !== 'paired') return null;

  return (
    <section className="device-panel" aria-label="设备与配对">
      <div className="section-heading"><h2>设备与配对</h2><Button loading={loading} disabled={busy} onClick={() => void loadDevices()}>刷新设备</Button></div>
      {error && <Alert className="request-error" type="error" showIcon message={error} />}
      {notice && <Alert className="request-error" type="info" showIcon message={notice} />}
      <div className="device-grid">
        <Card bordered={false} title="当前设备">
          {currentDevice ? <>
            <div className="device-heading"><strong>{currentDevice.name}</strong><Tag color="green">当前会话</Tag></div>
            <dl className="device-meta evidence-meta">
              <div><dt>设备 ID</dt><dd>{currentDevice.id}</dd></div>
              <div><dt>配对时间</dt><dd>{time(currentDevice.createdAt)}</dd></div>
              <div><dt>访问到期</dt><dd>{time(currentDevice.expiresAt)}</dd></div>
            </dl>
          </> : <p className="field-hint">当前会话已配对，设备信息暂不可用。</p>}
          <p className="field-hint">撤销当前设备后，整个工作台立即锁定，需要重新配对。</p>
        </Card>

        <Card bordered={false} title="添加设备">
          <p className="field-hint">明确创建一次性配对链接，再复制给要配对的浏览器。链接仅在当前页面显示，到期后清除。</p>
          <Button type="primary" block loading={generating} disabled={busy} onClick={() => void createTicket()}>{pairCommand.current && !generating ? '重试创建配对链接' : '创建新配对链接'}</Button>
          {link && ticket && <div className="pair-ticket">
            <label className="input-label" htmlFor="pair-ticket-link">一次性配对链接</label>
            <Input.TextArea id="pair-ticket-link" className="pair-link" readOnly value={link} autoSize={{ minRows: 2, maxRows: 5 }} />
            <p className="field-hint">到期时间：{time(ticket.expiresAt)}</p>
            <Button block loading={copying} disabled={busy || copying} onClick={() => void copyLink()}>复制配对链接</Button>
          </div>}
        </Card>
      </div>

      <Card bordered={false} title={`已配对设备 · ${devices.length}`}>
        {loading && devices.length === 0 ? <div className="loading-area"><Spin /></div> : devices.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无设备记录" /> : (
          <ul className="device-list">{devices.map((device) => <li className="device-card" key={device.id}>
            <div className="device-heading"><strong>{device.name}</strong>{device.id === currentDevice?.id && <Tag color="green">当前设备</Tag>}{Date.parse(device.expiresAt) <= Date.now() && <Tag>已到期</Tag>}</div>
            <dl className="device-meta evidence-meta"><div><dt>设备 ID</dt><dd>{device.id}</dd></div><div><dt>配对时间</dt><dd>{time(device.createdAt)}</dd></div><div><dt>访问到期</dt><dd>{time(device.expiresAt)}</dd></div></dl>
            <div className="device-actions"><Button danger disabled={busy} onClick={() => { setError(null); setConfirmDevice(device); }}>撤销访问</Button></div>
          </li>)}</ul>
        )}
      </Card>

      <Modal open={confirmDevice !== null} title={confirmDevice ? `撤销“${confirmDevice.name}”的访问？` : '撤销设备访问'} okText={confirmDevice?.id === currentDevice?.id ? '撤销并锁定工作台' : '确认撤销'} cancelText="保留访问" okButtonProps={{ danger: true, disabled: generating }} confirmLoading={revokingId !== null} closable={revokingId === null} maskClosable={revokingId === null} onCancel={() => { if (!busy) setConfirmDevice(null); }} onOk={() => { if (confirmDevice) void revoke(confirmDevice); }}>
        <p className="device-warning">撤销后，该设备立即失去工作台访问权限。正在执行的任务继续运行。</p>
        {confirmDevice?.id === currentDevice?.id && <Alert type="warning" showIcon message="这是当前设备。确认后整个工作台立即锁定，需要重新配对。" />}
        {error && <Alert className="request-error" type="error" showIcon message={error} />}
      </Modal>
    </section>
  );
}
