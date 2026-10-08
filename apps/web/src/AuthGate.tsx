import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Alert, Button, Card, Input, Spin, Tag } from 'antd';
import type { AuthSession } from '@personal-agent/contracts';
import { App } from './App';
import { ApiError, api, isTemporaryConnectionFailure } from './api';
import { authSession, isLocalHttpDevelopment, notifyAuthRequired, observePairingNavigation, sessionExpiresIn, verifiedSession } from './auth-session';
import { MutationFlight } from './mutation-commands';

export interface PairingFragment { ticket: string | null }

function PairingForm({ initialTicket, checking, connectionError, onCheck, beforePair, onPairFinished, onPaired }: {
  initialTicket: string | null;
  checking: boolean;
  connectionError: string | null;
  onCheck: () => void;
  beforePair: () => void;
  onPairFinished: () => void;
  onPaired: (value: AuthSession) => void;
}) {
  const [ticket, setTicket] = useState(initialTicket ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef(new MutationFlight());
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  async function pair() {
    if (!ticket.trim() || !name.trim() || flight.current.isRunning) return;
    beforePair();
    setBusy(true); setError(null);
    await flight.current.run(async () => {
      try {
        const result = verifiedSession(await api.pairDevice(ticket.trim(), name.trim()));
        if (result.mode !== 'paired') throw new Error('Pairing did not authorize this device');
        if (active.current) { setTicket(''); onPaired(result); }
      } catch (cause) {
        if (active.current) setError(isTemporaryConnectionFailure(cause)
          ? '暂时无法确认配对结果。连接恢复后，请先点“重新确认当前设备访问”；票据可能已使用，无需立即申请新票据。'
          : '配对未成功。请确认设备名称和票据；票据过期或已使用时，请从已配对设备生成新票据。');
      } finally { if (active.current) { onPairFinished(); setBusy(false); } }
    });
  }

  return <div className="auth-shell">
    <div className="auth-brand">Personal Agent</div>
    <Card className="pair-card" bordered={false} title="设备配对">
      <p className="intro-description">在已配对设备生成一次性票据，通过配对链接打开此页，或在下方输入票据。</p>
      {isLocalHttpDevelopment(location.protocol, location.hostname) ? <Tag className="auth-mode" color="orange">本机 HTTP · 开发模式</Tag> : <p className="field-hint">生产访问使用配置的 HTTPS 地址。</p>}
      <label className="input-label" htmlFor="pair-name">设备名称</label>
      <Input id="pair-name" value={name} disabled={busy} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="例如：我的手机" autoComplete="off" />
      <label className="input-label" htmlFor="pair-ticket">一次性配对票据</label>
      <Input.Password id="pair-ticket" value={ticket} disabled={busy} maxLength={256} onChange={(event) => setTicket(event.target.value)} placeholder="票据只保留在当前页面" autoComplete="off" visibilityToggle={false} />
      {connectionError && <Alert className="create-error" type="warning" showIcon message={connectionError} />}
      {error && <Alert className="create-error" type="error" showIcon message={error} />}
      <Button className="create-button" type="primary" size="large" block disabled={!name.trim() || !ticket.trim() || busy} loading={busy} onClick={() => void pair()}>配对此设备</Button>
      <p className="field-hint">提交后由服务器设置设备 Cookie。票据不会保存到浏览器存储。</p>
      <Button block disabled={busy || checking} loading={checking} onClick={onCheck}>重新确认当前设备访问</Button>
    </Card>
  </div>;
}

/** The authenticated workspace is detached synchronously on every HTTP 401. */
export function AuthGate({ fragment }: { fragment: PairingFragment }) {
  const [initialTicket, setInitialTicket] = useState(fragment.ticket);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'locked' | 'unavailable'>('loading');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const [pairFormVersion, setPairFormVersion] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const checkRunning = useRef(false);
  const checkVersion = useRef(0);
  const mounted = useRef(false);
  const hadSession = useRef(false);
  const pairing = useRef(false);
  const currentStatus = useRef(status);
  currentStatus.current = status;

  async function check() {
    if (checkRunning.current) return;
    checkRunning.current = true;
    const next = new AbortController();
    controller.current = next;
    const version = ++checkVersion.current;
    setChecking(true);
    try {
      const result = verifiedSession(await api.getSession(next.signal));
      if (!mounted.current || next.signal.aborted || version !== checkVersion.current) return;
      authSession.set(result);
      hadSession.current = true;
      setConnectionError(null);
      setSession(result); setStatus('ready'); setEpoch(authSession.generation);
      if (result.mode === 'loopback') setInitialTicket(null);
    } catch (cause) {
      if (!mounted.current || next.signal.aborted || version !== checkVersion.current) return;
      if (isTemporaryConnectionFailure(cause)) {
        setConnectionError(cause instanceof Error ? cause.message : '暂时无法连接服务，请稍后重试。');
        // Keep the mounted workbench, its draft and uncertain command IDs during an outage.
        // The known expiry timer and every actual HTTP 401 still lock it synchronously.
        if (['loading', 'unavailable'].includes(currentStatus.current)) setStatus('unavailable');
        return;
      }
      notifyAuthRequired();
      setConnectionError(cause instanceof ApiError ? cause.message : '服务未返回有效的访问状态。请检查服务后重新连接。');
      setStatus('unavailable');
    } finally {
      if (controller.current === next) checkRunning.current = false;
      if (mounted.current && version === checkVersion.current) setChecking(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    // The one-time handoff no longer retains a ticket in the root's props.
    fragment.ticket = null;
    const unsubscribe = authSession.subscribe(() => {
      checkVersion.current += 1;
      controller.current?.abort();
      checkRunning.current = false;
      if (!mounted.current) return;
      flushSync(() => {
        setSession(null); setStatus('locked'); setChecking(false); setEpoch(authSession.generation);
        setConnectionError(null);
        if (hadSession.current || pairing.current) setInitialTicket(null);
      });
    });
    const stopPairNavigation = observePairingNavigation(window, window.location, window.history, (ticket) => {
      if (authSession.session?.mode === 'loopback') return;
      // Invalidating first fences late responses and synchronously detaches the workspace/feed.
      notifyAuthRequired();
      pairing.current = false;
      flushSync(() => { setInitialTicket(ticket); setPairFormVersion((version) => version + 1); });
    });
    void check();
    const timer = window.setInterval(() => {
      if (['ready', 'unavailable'].includes(currentStatus.current) && !pairing.current) void check();
    }, 5000);
    const visible = () => {
      if (document.visibilityState !== 'visible') return;
      if (sessionExpiresIn(authSession.session) === 0) notifyAuthRequired();
      else if (!pairing.current) void check();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      mounted.current = false;
      unsubscribe();
      stopPairNavigation();
      controller.current?.abort();
      checkRunning.current = false;
      checkVersion.current += 1;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  useEffect(() => {
    if (status !== 'ready' || session?.mode !== 'paired') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expires = () => {
      const remaining = sessionExpiresIn(authSession.session);
      if (remaining === null) return;
      if (remaining === 0) { notifyAuthRequired(); return; }
      timer = setTimeout(expires, Math.min(remaining, 2_147_483_647));
    };
    expires();
    return () => { if (timer !== undefined) clearTimeout(timer); };
  }, [status, session]);

  if (status === 'loading') return <div className="auth-shell auth-loading" role="status"><Spin /><p>正在确认设备访问…</p></div>;
  if (status === 'unavailable') return <div className="auth-shell">
    <div className="auth-brand">Personal Agent</div>
    <Card className="pair-card" bordered={false} title="工作台连接尚未恢复">
      <Alert type="warning" showIcon message={connectionError ?? '暂时无法确认服务状态。'} />
      <p className="field-hint">页面每 5 秒自动重试。确认服务在原地址运行后，也可以立即重新连接。</p>
      <Button block type="primary" loading={checking} disabled={checking} onClick={() => void check()}>重新连接工作台</Button>
    </Card>
  </div>;
  const pairPage = location.pathname === '/pair' && session?.mode === 'paired';
  if (status === 'ready' && session && !pairPage) return <>
    {connectionError && <div className="session-connection"><Alert type="warning" showIcon message="服务连接暂时中断，正在自动重试。" description="当前填写内容已保留。任务可能仍在执行，连接恢复后可重试原操作并查看最新进度。" action={<Button size="small" loading={checking} disabled={checking} onClick={() => void check()}>重新连接</Button>} /></div>}
    <App key={epoch} session={session} />
  </>;
  return <PairingForm key={`${epoch}:${pairFormVersion}`} initialTicket={initialTicket} checking={checking} connectionError={connectionError} onCheck={() => void check()} beforePair={() => {
    pairing.current = true;
    controller.current?.abort();
    checkRunning.current = false;
    checkVersion.current += 1;
    setChecking(false);
  }} onPairFinished={() => { pairing.current = false; }} onPaired={(value) => {
    pairing.current = false;
    authSession.set(value);
    hadSession.current = true;
    setConnectionError(null);
    setInitialTicket(null); setSession(value); setStatus('ready'); setEpoch(authSession.generation);
    history.replaceState(null, '', '/');
  }} />;
}
