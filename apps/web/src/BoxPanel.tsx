import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Input, Modal, Radio, Spin, Tag } from 'antd';
import type { BoxAction, BoxDeployment, BoxDesktop, BoxRegistrationTicket, CreateCloudBoxCommand } from '@personal-agent/contracts';
import { ApiError, api } from './api';
import {
  actionLabels, adapterLabels, boxErrorMessages, canStartDesktop, containerStateLabels, formatBytes, formatRelative,
  hostStateLabels, installCommand, memoryUsage, orderDeployments, pressureLabels, publicInstallOrigin,
} from './box-display';
import { MutationCommands, MutationFlight } from './mutation-commands';
import { VncViewer } from './VncViewer';

function message(cause: unknown): string {
  return cause instanceof ApiError || cause instanceof Error ? cause.message : '请求未成功，请重试。';
}

function policyText(deployment: BoxDeployment): string {
  const { concurrent, max, budgetBytesPerDesktop, idleStopMinutes } = deployment.desktopPolicy;
  return `并发 ${concurrent}/${max} · 每桌面 ${formatBytes(budgetBytesPerDesktop)} · 空闲 ${idleStopMinutes} 分钟停止`;
}

function DesktopRow({ deployment, desktop, busy, fakeDemo, onStart, onStop, onOpen }: {
  deployment: BoxDeployment; desktop: BoxDesktop; busy: boolean; fakeDemo: boolean;
  onStart: () => void; onStop: () => void; onOpen: () => void;
}) {
  const start = canStartDesktop(deployment, desktop);
  const running = desktop.state === 'running';
  return <div className="box-desktop">
    <div>
      <strong>{desktop.label}</strong>
      <div className="box-meta">
        {running ? '运行中' : '已停止'}
        {desktop.viewers ? ` · ${desktop.viewers} 人查看` : ''}
        {desktop.idleStopAt ? ` · ${formatRelative(desktop.idleStopAt)} 空闲停止` : ''}
        {desktop.streamable ? '' : ' · 不可串流'}
      </div>
    </div>
    <div className="box-actions">
      {running
        ? <Button size="small" disabled={busy || fakeDemo} onClick={onStop}>停止</Button>
        : <Button size="small" disabled={busy || fakeDemo || !start.ok} title={start.ok ? undefined : start.reason} onClick={onStart}>启动</Button>}
      <Button size="small" type="primary" disabled={busy || fakeDemo || (!running && !start.ok) || !desktop.streamable}
        title={!desktop.streamable ? '只能经服务端鉴权代理打开，容器未就绪或未通过安全校验' : undefined}
        onClick={onOpen}>打开桌面</Button>
    </div>
  </div>;
}

function DeploymentCard({ deployment, fakeDemo, busy, onAction, onStartDesktop, onStopDesktop, onOpenDesktop, onTicket, onRemove }: {
  deployment: BoxDeployment; fakeDemo: boolean; busy: boolean;
  onAction: (action: BoxAction) => void;
  onStartDesktop: (desktop: BoxDesktop) => void;
  onStopDesktop: (desktop: BoxDesktop) => void;
  onOpenDesktop: (desktop: BoxDesktop) => void;
  onTicket: () => void;
  onRemove: () => void;
}) {
  const host = hostStateLabels[deployment.host.state];
  const container = containerStateLabels[deployment.container.state];
  const pressure = pressureLabels[deployment.memoryPressure];
  return <Card className="box-card" bordered={false} title={<>
    <span>{deployment.name}</span>
    <Tag color={deployment.kind === 'local' ? 'blue' : 'purple'}>{deployment.kind === 'local' ? '本机' : '云端'}</Tag>
    {deployment.fake && <Tag>演示数据</Tag>}
  </>} extra={<span className="box-meta">{adapterLabels[deployment.adapter]}</span>}>
    {deployment.host.installHint && <Alert className="box-hint" type="info" showIcon message={deployment.host.installHint} />}
    {deployment.host.detail && <p className="field-hint">{deployment.host.detail}</p>}
    <dl className="box-stats">
      <div><dt>宿主 / VM</dt><dd><Tag color={host.color}>{host.text}</Tag>
        {deployment.host.resources?.cpus ? ` · ${deployment.host.resources.cpus} vCPU` : ''}
        {deployment.host.resources?.memoryBytes ? ` · ${formatBytes(deployment.host.resources.memoryBytes)}` : ''}
        {deployment.host.resources?.diskBytes ? ` · 磁盘 ${formatBytes(deployment.host.resources.diskBytes)}` : ''}</dd></div>
      <div><dt>容器</dt><dd><Tag color={container.color}>{container.text}</Tag>
        {deployment.container.cpuPercent !== undefined ? ` · CPU ${deployment.container.cpuPercent.toFixed(1)}%` : ''}
        {` · ${memoryUsage(deployment.container.memoryUsedBytes, deployment.container.memoryLimitBytes)}`}</dd></div>
      <div><dt>内存压力</dt><dd><Tag color={pressure.color}>{pressure.text}</Tag></dd></div>
      <div><dt>桌面策略</dt><dd>{policyText(deployment)}</dd></div>
      {deployment.kind === 'cloud' && <>
        <div><dt>连接</dt><dd>{deployment.connection === 'ssh' ? 'SSH' : '主机守护进程'}{deployment.endpoint ? ` · ${deployment.endpoint}` : ''}{deployment.authRef ? ` · ${deployment.authRef}` : ''}</dd></div>
        <div><dt>心跳</dt><dd>{deployment.registered ? formatRelative(deployment.lastHeartbeatAt) : '尚未注册'}</dd></div>
      </>}
      {deployment.providerLabel && <div><dt>服务商</dt><dd>{deployment.providerLabel}</dd></div>}
    </dl>
    {deployment.operation && !deployment.operation.finishedAt && <p className="field-hint">{actionLabels[deployment.operation.action]} 正在执行…</p>}
    {deployment.operation?.errorCode && <Alert type="error" showIcon message={boxErrorMessages[deployment.operation.errorCode] ?? deployment.operation.errorCode} />}
    <div className="box-actions">
      {deployment.actions.map(action => <Button key={action} size="small" disabled={busy || fakeDemo} onClick={() => onAction(action)}>{actionLabels[action]}</Button>)}
      {deployment.kind === 'cloud' && deployment.connection === 'agent' && !deployment.fake &&
        <Button size="small" disabled={busy || fakeDemo} onClick={onTicket}>签发注册票据</Button>}
      {deployment.kind === 'cloud' && !deployment.fake &&
        <Button size="small" danger disabled={busy || fakeDemo} onClick={onRemove}>移除</Button>}
    </div>
    <div className="box-desktops" aria-label="桌面">
      {deployment.desktops.length === 0
        ? <p className="field-hint">容器运行后会出现桌面 1–3。</p>
        : deployment.desktops.map(desktop => <DesktopRow key={desktop.id} deployment={deployment} desktop={desktop}
          busy={busy} fakeDemo={fakeDemo}
          onStart={() => onStartDesktop(desktop)} onStop={() => onStopDesktop(desktop)} onOpen={() => onOpenDesktop(desktop)} />)}
    </div>
  </Card>;
}

export function BoxPanel({ fakeDemo = false }: { fakeDemo?: boolean }) {
  const [deployments, setDeployments] = useState<BoxDeployment[]>([]);
  const [platform, setPlatform] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState<{ deploymentId: string; desktopId: string; title: string } | null>(null);
  const [ticket, setTicket] = useState<BoxRegistrationTicket | null>(null);
  const [form, setForm] = useState<{ name: string; providerLabel: string; connection: 'agent' | 'ssh'; endpoint: string; authRef: string }>({
    name: '', providerLabel: '', connection: 'agent', endpoint: '', authRef: '',
  });
  const alive = useRef(false);
  const listController = useRef<AbortController | null>(null);
  const commands = useRef(new MutationCommands());
  const flight = useRef(new MutationFlight());

  const load = useCallback(async () => {
    if (!alive.current) return;
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    try {
      const result = await api.listBoxDeployments(controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setDeployments(result.deployments);
      setPlatform(result.platform);
      setError(null);
    } catch (cause) {
      if (alive.current && !controller.signal.aborted) setError(message(cause));
    } finally {
      if (alive.current && !controller.signal.aborted) setLoading(false);
      if (listController.current === controller) listController.current = null;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => { if (!flight.current.isRunning) void load(); }, 5_000);
    return () => { alive.current = false; clearInterval(timer); listController.current?.abort(); };
  }, [load]);

  async function run(work: () => Promise<void>) {
    if (flight.current.isRunning) return;
    setBusy(true); setError(null);
    await flight.current.run(async () => {
      try { await work(); await load(); }
      catch (cause) { if (alive.current) setError(message(cause)); }
      finally { if (alive.current) setBusy(false); }
    });
  }

  const { local, cloud } = orderDeployments(deployments);
  const origin = publicInstallOrigin(window.location);
  const ticketCommand = ticket && origin ? installCommand(origin, ticket.ticket) : null;

  async function addCloud() {
    const name = form.name.trim();
    if (!name) { setError('请填写云端主机名称。'); return; }
    const command: CreateCloudBoxCommand = {
      commandId: commands.current.id(commands.current.key('box-create', { name, connection: form.connection, endpoint: form.endpoint, authRef: form.authRef })),
      name, connection: form.connection,
      ...(form.providerLabel.trim() ? { providerLabel: form.providerLabel.trim() } : {}),
      ...(form.endpoint.trim() ? { endpoint: form.endpoint.trim() } : {}),
      ...(form.authRef.trim() ? { authRef: form.authRef.trim() } : {}),
    };
    await run(async () => {
      const created = await api.createCloudBox(command);
      commands.current.complete(commands.current.key('box-create', { name, connection: form.connection, endpoint: form.endpoint, authRef: form.authRef }));
      if (created.connection === 'agent') {
        const issued = await api.issueBoxTicket(created.id, { commandId: commands.current.id(`ticket:${created.id}`) });
        setTicket(issued);
      }
      setForm({ name: '', providerLabel: '', connection: form.connection, endpoint: '', authRef: '' });
    });
  }

  async function openDesktop(deployment: BoxDeployment, desktop: BoxDesktop) {
    if (fakeDemo || deployment.fake) { setError('公开演示只展示示例数据，不能打开真实桌面。'); return; }
    if (desktop.state !== 'running') {
      await run(async () => {
        const key = commands.current.key(`desktop-start:${deployment.id}`, desktop.id);
        await api.startBoxDesktop(deployment.id, desktop.id, { commandId: commands.current.id(key) });
        commands.current.complete(key);
      });
    }
    setViewer({ deploymentId: deployment.id, desktopId: desktop.id, title: `${deployment.name} · ${desktop.label}` });
  }

  return <section className="box-panel" aria-labelledby="box-title">
    <p className="intro-description">本机（Colima / WSL2 / Podman）与云端主机并排管理。桌面只经本实例的鉴权代理打开，容器内 VNC 不监听 TCP。</p>
    {fakeDemo && <Alert className="phase-notice" type="info" showIcon message="公开演示只展示假的云电脑状态，不会启动虚拟机、容器或桌面。" />}
    {error && <Alert className="request-error" type="error" showIcon message={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} />}
    {loading ? <div className="box-loading"><Spin /> 正在读取云电脑状态…</div> : <>
      <div className="box-grid">
        <div>
          <h2 className="box-section-title" id="box-title">本机</h2>
          {local.length === 0 ? <Empty description={platform ? `当前平台（${platform}）没有本机适配器。` : '没有本机部署'} /> :
            local.map(item => <DeploymentCard key={item.id} deployment={item} fakeDemo={fakeDemo} busy={busy}
              onAction={action => void run(async () => { const key = commands.current.key(`action:${item.id}`, action); await api.boxAction(item.id, { commandId: commands.current.id(key), action }); commands.current.complete(key); })}
              onStartDesktop={desktop => void run(async () => { const key = commands.current.key(`desktop-start:${item.id}`, desktop.id); await api.startBoxDesktop(item.id, desktop.id, { commandId: commands.current.id(key) }); commands.current.complete(key); })}
              onStopDesktop={desktop => void run(async () => { const key = commands.current.key(`desktop-stop:${item.id}`, desktop.id); await api.stopBoxDesktop(item.id, desktop.id, { commandId: commands.current.id(key) }); commands.current.complete(key); })}
              onOpenDesktop={desktop => void openDesktop(item, desktop)} onTicket={() => {}} onRemove={() => {}} />)}
        </div>
        <div>
          <h2 className="box-section-title">云端</h2>
          {cloud.map(item => <DeploymentCard key={item.id} deployment={item} fakeDemo={fakeDemo} busy={busy}
            onAction={action => void run(async () => { const key = commands.current.key(`action:${item.id}`, action); await api.boxAction(item.id, { commandId: commands.current.id(key), action }); commands.current.complete(key); })}
            onStartDesktop={desktop => void run(async () => { const key = commands.current.key(`desktop-start:${item.id}`, desktop.id); await api.startBoxDesktop(item.id, desktop.id, { commandId: commands.current.id(key) }); commands.current.complete(key); })}
            onStopDesktop={desktop => void run(async () => { const key = commands.current.key(`desktop-stop:${item.id}`, desktop.id); await api.stopBoxDesktop(item.id, desktop.id, { commandId: commands.current.id(key) }); commands.current.complete(key); })}
            onOpenDesktop={desktop => void openDesktop(item, desktop)}
            onTicket={() => void run(async () => { const issued = await api.issueBoxTicket(item.id, { commandId: commands.current.id(`ticket:${item.id}:${Date.now()}`) }); setTicket(issued); })}
            onRemove={() => void run(async () => { const key = commands.current.key(`remove:${item.id}`, item.id); await api.removeCloudBox(item.id, { commandId: commands.current.id(key) }); commands.current.complete(key); })} />)}
          <Card className="box-card" bordered={false} title="添加云端主机">
            <p className="field-hint">凭据不要写入仓库或粘贴到这里。SSH 使用本机 ssh 配置中的 Host 别名；主机守护进程用一次性票据从云主机向外连接。</p>
            <label className="input-label" htmlFor="box-name">名称</label>
            <Input id="box-name" value={form.name} maxLength={100} disabled={busy || fakeDemo} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="例如：开发机" />
            <label className="input-label" htmlFor="box-provider">服务商标签（可选）</label>
            <Input id="box-provider" value={form.providerLabel} maxLength={64} disabled={busy || fakeDemo} onChange={event => setForm({ ...form, providerLabel: event.target.value })} placeholder="例如：云厂商机型名" />
            <label className="input-label">连接方式</label>
            <Radio.Group value={form.connection} disabled={busy || fakeDemo} onChange={event => setForm({ ...form, connection: event.target.value })}>
              <Radio value="agent">主机守护进程（一次性票据）</Radio>
              <Radio value="ssh">SSH</Radio>
            </Radio.Group>
            <label className="input-label" htmlFor="box-endpoint">{form.connection === 'ssh' ? 'ssh 配置 Host 别名' : '展示用主机名（可选）'}</label>
            <Input id="box-endpoint" value={form.endpoint} maxLength={260} disabled={busy || fakeDemo} onChange={event => setForm({ ...form, endpoint: event.target.value })} placeholder={form.connection === 'ssh' ? 'pa-cloud' : '可选'} autoComplete="off" />
            <label className="input-label" htmlFor="box-auth">凭据引用（可选）</label>
            <Input id="box-auth" value={form.authRef} maxLength={160} disabled={busy || fakeDemo} onChange={event => setForm({ ...form, authRef: event.target.value })} placeholder="ssh-config:pa-cloud" autoComplete="off" />
            <Button className="settings-save" type="primary" disabled={busy || fakeDemo || !form.name.trim() || (form.connection === 'ssh' && !form.endpoint.trim())} onClick={() => void addCloud()}>添加</Button>
          </Card>
        </div>
      </div>
    </>}
    {ticket && <Modal open title="一次性注册票据" onCancel={() => setTicket(null)} footer={<Button onClick={() => setTicket(null)}>已复制，关闭</Button>}>
      <p className="field-hint">票据只显示这一次，10 分钟内有效。请在云主机上写入文件后再运行安装脚本，不要把票据放进命令行参数或仓库。</p>
      <pre className="pair-link">{ticket.ticket}</pre>
      {ticketCommand ? <pre className="pair-link">{ticketCommand}</pre>
        : <Alert type="warning" showIcon message="当前页面不是 HTTPS 公开地址。主机守护进程需要能访问 paired 实例的 https 源；本机 loopback 或桌面客户端请改用 SSH 连接，或先配置 paired 访问。" />}
    </Modal>}
    {viewer && <VncViewer {...viewer} onClose={() => setViewer(null)} />}
  </section>;
}
