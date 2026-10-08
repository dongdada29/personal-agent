import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Input, InputNumber, Select, Spin, Tag } from 'antd';
import type { AgentProfile, AgentRole, InstanceSettings, TaskEngine } from '@personal-agent/contracts';
import { api } from './api';
import { MutationCommands, MutationFlight } from './mutation-commands';
import { allowedTaskEngines, taskEngineForMode } from './demo-mode';

export const roleLabels: Record<AgentRole, string> = { planner: '方案 Agent', developer: '开发 Agent', reviewer: '检查 Agent' };
const roles: AgentRole[] = ['planner', 'developer', 'reviewer'];

export function SettingsPanel({ settings, profiles, loading, error, fakeDemo = false, onReload, onSettingsChanged, onProfileChanged }: {
  settings: InstanceSettings | null;
  profiles: AgentProfile[];
  loading: boolean;
  error: string | null;
  fakeDemo?: boolean;
  onReload: () => Promise<void>;
  onSettingsChanged: (value: InstanceSettings) => void;
  onProfileChanged: (value: AgentProfile) => void;
}) {
  const [engine, setEngine] = useState<TaskEngine>('fake');
  const [runSeconds, setRunSeconds] = useState<number | null>(1800);
  const [verificationSeconds, setVerificationSeconds] = useState<number | null>(120);
  const [selectedProfileId, setSelectedProfileId] = useState('new');
  const [name, setName] = useState('');
  const [role, setRole] = useState<AgentRole>('planner');
  const [model, setModel] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState<'settings' | 'profile' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const commands = useRef(new MutationCommands());
  const flight = useRef(new MutationFlight());
  const profile = profiles.find((item) => item.id === selectedProfileId);

  useEffect(() => {
    if (!settings) return;
    setEngine(taskEngineForMode(settings.defaultEngine, fakeDemo));
    setRunSeconds(settings.agentRunTimeoutMs / 1000);
    setVerificationSeconds(settings.verificationTimeoutMs / 1000);
  }, [settings, fakeDemo]);

  useEffect(() => {
    setName(profile?.name ?? '');
    setRole(profile?.role ?? 'planner');
    setModel(profile?.model ?? '');
    setInstructions(profile?.instructions ?? '');
    setSaveError(null);
  }, [selectedProfileId, profile]);

  async function saveSettings() {
    if (!settings || loading || flight.current.isRunning) return;
    if (runSeconds === null || verificationSeconds === null || [runSeconds, verificationSeconds].some((seconds) => !Number.isFinite(seconds) || seconds < 1 || seconds > 1800)) {
      setSaveError('超时时间应为 1 至 1800 秒。');
      return;
    }
    const payload = { defaultEngine: taskEngineForMode(engine, fakeDemo), agentRunTimeoutMs: Math.round(runSeconds * 1000), verificationTimeoutMs: Math.round(verificationSeconds * 1000) };
    const key = commands.current.key('settings', payload, settings.updatedAt);
    setBusy('settings'); setSaveError(null); setNotice(null);
    await flight.current.run(async () => {
      try {
        const result = await api.updateSettings({ ...payload, commandId: commands.current.id(key) });
        commands.current.complete(key);
        onSettingsChanged(result);
        setNotice('实例设置已保存，后续新任务会使用新的设置。');
      } catch (cause) { setSaveError(cause instanceof Error ? cause.message : '设置保存失败。'); }
      finally { setBusy(null); }
    });
  }

  async function saveProfile() {
    if (loading || flight.current.isRunning) return;
    if (!name.trim()) { setSaveError('请填写档案名称。'); return; }
    if (model.trim().length > 200 || !/^[a-zA-Z0-9._:/-]*$/.test(model.trim())) { setSaveError('模型名称仅支持字母、数字和 . _ : / -，最长 200 字符。'); return; }
    const payload = { name: name.trim(), model: model.trim(), instructions };
    const body = profile ? payload : { ...payload, role };
    const key = commands.current.key(profile ? `profile:${profile.id}` : 'profile:new', body, profile?.updatedAt);
    setBusy('profile'); setSaveError(null); setNotice(null);
    await flight.current.run(async () => {
      try {
        const commandId = commands.current.id(key);
        const result = profile ? await api.updateAgent(profile.id, { ...payload, commandId }) : await api.createAgent({ ...payload, role, commandId });
        commands.current.complete(key);
        onProfileChanged(result);
        setSelectedProfileId(result.id);
        setNotice('Agent 档案已保存，已有任务的配置快照保持不变。');
      } catch (cause) { setSaveError(cause instanceof Error ? cause.message : '档案保存失败。'); }
      finally { setBusy(null); }
    });
  }

  return (
    <section className="settings-panel" aria-label="实例配置">
      <div className="section-heading"><h2>实例与 Agent 配置</h2><Button onClick={() => void onReload()} loading={loading} disabled={loading || busy !== null}>重新读取</Button></div>
      <p className="intro-description">配置用于后续新任务。已有任务保存创建时的设置与档案快照。</p>
      {error && <Alert className="request-error" type="error" showIcon message={error} />}
      {saveError && <Alert className="request-error" type="error" showIcon message={saveError} />}
      {notice && <Alert className="request-error" type="success" showIcon message={notice} />}
      {loading && !settings ? <div className="loading-area"><Spin /></div> : (
        <div className="settings-grid">
          <Card bordered={false} title="实例设置">
            <label className="input-label" htmlFor="default-engine">新任务默认引擎</label>
            <Select id="default-engine" className="full-width" value={taskEngineForMode(engine, fakeDemo)} disabled={!settings || loading || busy !== null || fakeDemo} onChange={(value: TaskEngine) => setEngine(taskEngineForMode(value, fakeDemo))} options={allowedTaskEngines(fakeDemo).map((value) => ({ value, label: value === 'fake' ? 'fake · 演示' : 'Claude · 真实执行' }))} />
            <label className="input-label" htmlFor="agent-timeout">Agent 活跃执行超时 · 秒</label>
            <InputNumber id="agent-timeout" className="full-width" min={1} max={1800} step={1} value={runSeconds} disabled={!settings || loading || busy !== null} onChange={setRunSeconds} />
            <p className="field-hint">等待用户审批的时间不计入活跃执行时间。</p>
            <label className="input-label" htmlFor="verification-timeout">Runtime 验证超时 · 秒</label>
            <InputNumber id="verification-timeout" className="full-width" min={1} max={1800} step={1} value={verificationSeconds} disabled={!settings || loading || busy !== null} onChange={setVerificationSeconds} />
            <Button className="settings-save" type="primary" block loading={busy === 'settings'} disabled={!settings || loading || busy !== null} onClick={() => void saveSettings()}>保存实例设置</Button>
          </Card>

          <Card bordered={false} title="Agent 档案">
            <label className="input-label" htmlFor="agent-profile">选择档案</label>
            <Select id="agent-profile" className="full-width" value={selectedProfileId} disabled={loading || busy !== null} onChange={setSelectedProfileId} options={[{ value: 'new', label: '新建档案' }, ...profiles.map((item) => ({ value: item.id, label: `${item.name} · ${roleLabels[item.role]}` }))]} />
            <label className="input-label" htmlFor="agent-name">名称</label>
            <Input id="agent-name" value={name} onChange={(event) => setName(event.target.value)} disabled={loading || busy !== null} maxLength={200} placeholder="给这个档案一个名称" />
            <label className="input-label" htmlFor="agent-role">角色 {profile && <Tag>固定</Tag>}</label>
            <Select id="agent-role" className="full-width" value={role} disabled={!!profile || loading || busy !== null} onChange={setRole} options={roles.map((value) => ({ value, label: roleLabels[value] }))} />
            <label className="input-label" htmlFor="agent-model">模型 · 可选</label>
            <Input id="agent-model" value={model} onChange={(event) => setModel(event.target.value)} disabled={loading || busy !== null} maxLength={200} placeholder="留空使用引擎默认模型" />
            <label className="input-label" htmlFor="agent-instructions">档案提示词 · 可选</label>
            <Input.TextArea id="agent-instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} disabled={loading || busy !== null} maxLength={10000} autoSize={{ minRows: 4, maxRows: 10 }} placeholder="例如：先说明方案和验证依据，尽量保持修改范围小。" />
            <Button className="settings-save" type="primary" block loading={busy === 'profile'} disabled={loading || busy !== null || !name.trim()} onClick={() => void saveProfile()}>{profile ? '保存档案修改' : '创建档案'}</Button>
          </Card>
        </div>
      )}
    </section>
  );
}
