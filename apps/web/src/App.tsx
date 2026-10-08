import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Input, Select, Spin, Tag, Typography } from 'antd';
import type { AgentProfile, AgentRole, ApprovalRecord, Artifact, AuthSession, CreateTaskCommand, InstanceSettings, Task, TaskSnapshot, VerificationCommand, Workspace } from '@personal-agent/contracts';
import { api } from './api';
import { ApprovalDetails, TaskEvidence } from './TaskEvidence';
import { groupTaskEvents, type DisplayEvent } from './event-display';
import { SettingsPanel, roleLabels } from './SettingsPanel';
import { TaskControls } from './TaskControls';
import { TaskContext } from './TaskContext';
import { TaskMutationCommands, MutationFlight, controlCommand, type ControlAction } from './mutation-commands';
import { createTaskFeed, type TaskFeed, type TaskFeedConnectionState } from './task-feed';
import { mergeApprovalRecords } from './approval-display';
import { DevicePanel } from './DevicePanel';
import { allowedTaskEngines, isFakeDemo, taskEngineForMode } from './demo-mode';

const { TextArea } = Input;

const statusLabels: Record<Task['status'], string> = {
  queued: '排队中',
  running: '执行中',
  waiting_human: '等待处理',
  paused: '已暂停',
  interrupted: '执行中断',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
};

const statusColors: Record<Task['status'], string> = {
  queued: 'default',
  running: 'processing',
  waiting_human: 'warning',
  paused: 'warning',
  interrupted: 'warning',
  completed: 'success',
  failed: 'error',
  cancelled: 'default',
};

const deliveryLabels: Record<Task['deliveryStatus'], string> = {
  pending: '待接收',
  accepted: '已接收',
  returned: '已退回',
};

const eventLabels: Record<string, string> = {
  'task.created': '任务已创建',
  'task.status_changed': '任务状态变更',
  'task.started': '开始执行',
  'task.completed': '任务完成',
  'task.failed': '任务失败',
  'task.interrupted': '任务中断',
  'attempt.started': '开始执行尝试',
  'engine.message': 'Agent 消息',
  'engine.event': '引擎事件',
  'artifact.created': '成果已保存',
  'workspace.prepared': '独立工作区已准备',
  'workspace.ready': '独立工作区已准备',
  'stage.updated': '阶段状态变更',
  'agent_run.updated': 'Agent 状态变更',
  'stage.started': '阶段开始',
  'stage.completed': '阶段完成',
  'stage.failed': '阶段失败',
  'run.started': 'Agent 开始执行',
  'run.completed': 'Agent 执行完成',
  'verification.completed': '验证命令完成',
  'approval.requested': '等待用户审批',
  'approval.resolved': '用户已处理审批',
  'task.cancelled': '任务已取消',
  'task.feedback_added': '补充要求已保存',
  'task.pause_requested': '已请求暂停',
  'task.paused': '任务已暂停',
  'task.taken_over': '已由用户接管',
  'task.resumed': '任务继续执行',
  'task.delivery_changed': '交付状态变更',
  'task.checkpoint_saved': '阶段检查点已保存',
  'task.instruction_added': '补充要求已保存',
  'task.control_requested': '任务控制已请求',
  'task.control_applied': '任务控制已执行',
  'delivery.returned': '成果已退回返工',
  'delivery.accepted': '成果已接收',
  'pipeline.checkpoint': '阶段检查点已保存',
};

const connectionLabels: Record<TaskFeedConnectionState, string> = {
  connecting: '连接事件流', live: '实时事件已连接', reconnecting: '正在重连事件流', polling: '连接恢复中 · 轮询进度',
};
const agentRoles: AgentRole[] = ['planner', 'developer', 'reviewer'];

function isActive(task: Task): boolean {
  return task.status === 'queued' || task.status === 'running' || task.status === 'waiting_human';
}

interface VerificationDraft { id: string; command: string; argsText: string }
type TaskInput<T = CreateTaskCommand> = T extends CreateTaskCommand ? Omit<T, 'commandId'> : never;

function blankVerification(): VerificationDraft {
  return { id: crypto.randomUUID(), command: '', argsText: '' };
}

function verificationCommands(drafts: VerificationDraft[]): VerificationCommand[] {
  return drafts.map((draft, index) => {
    if (!draft.command.trim()) throw new Error(`请填写验证命令 ${index + 1} 的可执行程序。`);
    let args: unknown;
    try {
      args = JSON.parse(draft.argsText);
    } catch {
      throw new Error(`验证命令 ${index + 1} 的参数应为 JSON 字符串数组；无参数请填 []。`);
    }
    if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === 'string')) {
      throw new Error(`验证命令 ${index + 1} 的参数应为 JSON 字符串数组。`);
    }
    return { command: draft.command.trim(), args };
  });
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求未成功，请重试。';
}

function StatusTag({ task }: { task: Task }) {
  return <Tag color={statusColors[task.status]}>{statusLabels[task.status]}</Tag>;
}

function EngineTag({ task }: { task: Task }) {
  return task.engine === 'claude' ? <Tag color="purple">Claude · 真实执行</Tag> : <Tag color="blue">fake · 演示</Tag>;
}

function EventItem({ item }: { item: DisplayEvent }) {
  const { event, message } = item;
  const [rawOpen, setRawOpen] = useState(false);
  const [messageOpen, setMessageOpen] = useState(false);
  const role = typeof event.data.role === 'string' ? ({ planner: '方案', developer: '开发', reviewer: '检查' } as Record<string, string>)[event.data.role] : undefined;
  const label = event.type === 'engine.message' && role ? `${role} Agent 消息` : eventLabels[event.type] ?? event.type;
  const longMessage = message !== null && message.length > 1000;
  return (
    <li className="event-item">
      <span className="event-dot" aria-hidden="true" />
      <div className="event-body">
        <div className="event-heading">
          <strong>{label}</strong>
          <time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time>
        </div>
        {message && <p className="event-message">{longMessage ? `${message.slice(0, 1000)}…` : message}</p>}
        {longMessage && <details className="message-details" onToggle={(event) => setMessageOpen(event.currentTarget.open)}><summary>展开完整消息</summary>{messageOpen && <pre>{message}</pre>}</details>}
        <details className="event-details" onToggle={(event) => setRawOpen(event.currentTarget.open)}>
          <summary>{item.events.length > 1 ? `消息片段 ${item.events.length} 条 · #${event.seq} → #${item.lastSeq}` : `事件 #${event.seq} · ${event.type}`}</summary>
          {rawOpen && <pre>{JSON.stringify(item.events.length > 1 ? item.events : event.data, null, 2)}</pre>}
        </details>
      </div>
    </li>
  );
}

function ArtifactCard({ artifact }: { artifact: Artifact }) {
  return (
    <article className="artifact">
      <div className="artifact-heading">
        <strong>{artifact.name}</strong>
        <Tag>{artifact.kind}</Tag>
      </div>
      <pre>{artifact.content}</pre>
      <time dateTime={artifact.createdAt}>保存于 {formatTime(artifact.createdAt)}</time>
    </article>
  );
}

export function App({ session }: { session: AuthSession }) {
  const fakeDemo = isFakeDemo(window.location.search);
  const [view, setView] = useState<'workbench' | 'settings' | 'devices'>('workbench');
  const [goal, setGoal] = useState('');
  const [requestedEngine, setEngine] = useState<'fake' | 'claude'>('fake');
  const engine = taskEngineForMode(requestedEngine, fakeDemo);
  const [settings, setSettings] = useState<InstanceSettings | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [profileIds, setProfileIds] = useState<Partial<Record<AgentRole, string>>>({});
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [registering, setRegistering] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<VerificationDraft[]>(() => [blankVerification()]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState<ControlAction | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<TaskSnapshot | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [visibleEventCount, setVisibleEventCount] = useState(100);
  const [connectionState, setConnectionState] = useState<TaskFeedConnectionState>('connecting');
  const pendingCommand = useRef<{ fingerprint: string; commandId: string } | null>(null);
  const workspaceCommand = useRef<{ fingerprint: string; commandId: string } | null>(null);
  const controlCommands = useRef(new TaskMutationCommands());
  const approvalCommands = useRef(new Map<string, { optionId: string; commandId: string }>());
  const controlFlight = useRef(new MutationFlight());
  const createFlight = useRef(new MutationFlight());
  const workspaceFlight = useRef(new MutationFlight());
  const approvalFlight = useRef(new MutationFlight());
  const metadataController = useRef<AbortController | null>(null);
  const configurationController = useRef<AbortController | null>(null);
  const engineTouched = useRef(false);
  const feed = useRef<TaskFeed | null>(null);
  const latestSnapshot = useRef<TaskSnapshot | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useLayoutEffect(() => () => {
    feed.current?.close();
    metadataController.current?.abort();
    configurationController.current?.abort();
    latestSnapshot.current = null;
    selectedIdRef.current = null;
    pendingCommand.current = null;
    workspaceCommand.current = null;
    controlCommands.current = new TaskMutationCommands();
    approvalCommands.current.clear();
  }, []);

  const loadMetadata = useCallback(async () => {
    metadataController.current?.abort();
    const controller = new AbortController();
    metadataController.current = controller;
    try {
      const [taskList, workspaceList, approvalList] = await Promise.all([
        api.listTasks(controller.signal), api.listWorkspaces(controller.signal), api.listApprovals(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setTasks((previous) => taskList.tasks.map((task) => {
        const newer = previous.find((item) => item.id === task.id);
        return newer && newer.updatedAt > task.updatedAt ? newer : task;
      }));
      setSelectedId((current) => current ?? taskList.tasks[0]?.id ?? null);
      setWorkspaces(workspaceList.workspaces);
      // New pending requests survive lagging snapshots; terminal decisions cannot regress.
      setApprovals((previous) => mergeApprovalRecords(previous, approvalList.approvals, latestSnapshot.current?.approvals ?? []));
      setError(null);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setInitialLoading(false);
    }
  }, []);

  const loadConfiguration = useCallback(async () => {
    configurationController.current?.abort();
    const controller = new AbortController();
    configurationController.current = controller;
    setSettingsLoading(true);
    try {
      const [nextSettings, agentList] = await Promise.all([api.getSettings(controller.signal), api.listAgents(controller.signal)]);
      if (controller.signal.aborted) return;
      setSettings(nextSettings);
      if (!engineTouched.current) setEngine(taskEngineForMode(nextSettings.defaultEngine, fakeDemo));
      setProfiles(agentList.agents);
      setSettingsError(null);
    } catch (cause) {
      if (!controller.signal.aborted) setSettingsError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setSettingsLoading(false);
    }
  }, [fakeDemo]);

  const refresh = useCallback(async () => {
    await Promise.all([loadMetadata(), feed.current?.refresh()]);
  }, [loadMetadata]);

  useEffect(() => {
    void loadMetadata();
    void loadConfiguration();
    return () => {
      metadataController.current?.abort();
      configurationController.current?.abort();
    };
  }, [loadMetadata, loadConfiguration]);

  useLayoutEffect(() => {
    if (!selectedId) return;
    let current = true;
    setDetailLoading(true);
    setVisibleEventCount(100);
    setControlError(null);
    setApprovalError(null);
    setSnapshot(null);
    latestSnapshot.current = null;
    setConnectionState('connecting');
    const reader = createTaskFeed({
      taskId: selectedId,
      fetchSnapshot: (signal) => api.getTask(selectedId, signal),
      onSnapshot: (result) => {
        if (!current || selectedIdRef.current !== selectedId) return;
        latestSnapshot.current = result;
        setSnapshot(result);
        setTasks((previous) => previous.map((task) => task.id === selectedId ? result.task : task));
        if (result.approvals) setApprovals((previous) => mergeApprovalRecords(previous, result.approvals!));
        setDetailLoading(false);
        setError(null);
      },
      onConnectionState: (state) => { if (current) setConnectionState(state); },
      onError: (cause) => {
        if (current && selectedIdRef.current === selectedId) {
          setError(errorMessage(cause).startsWith('Task event stream disconnected') ? '任务事件流暂时断开，正在重新连接。任务会继续执行。' : errorMessage(cause));
          setDetailLoading(false);
        }
      },
    });
    feed.current = reader;
    return () => {
      current = false;
      reader.close();
      latestSnapshot.current = null;
      if (feed.current === reader) feed.current = null;
    };
  }, [selectedId]);

  const hasActiveTasks = tasks.some(isActive) || approvals.some((approval) => approval.status === 'pending');
  useEffect(() => {
    if (!hasActiveTasks) return;
    const timer = window.setInterval(() => { void loadMetadata(); }, 4000);
    return () => window.clearInterval(timer);
  }, [hasActiveTasks, loadMetadata]);

  async function createTask() {
    const trimmedGoal = goal.trim();
    if (!trimmedGoal || createFlight.current.isRunning) return;
    let input: TaskInput;
    try {
      if (engine === 'claude') {
        if (!workspaceId) throw new Error('请选择已登记的 Git 工作区。');
        input = { goal: trimmedGoal, engine, workspaceId, verificationCommands: verificationCommands(drafts) };
      } else {
        input = { goal: trimmedGoal, engine };
      }
    } catch (cause) {
      setCreateError(errorMessage(cause));
      return;
    }
    if (Object.keys(profileIds).length > 0) input = { ...input, profileIds };
    const fingerprint = JSON.stringify(input);
    if (!pendingCommand.current || pendingCommand.current.fingerprint !== fingerprint) {
      pendingCommand.current = { fingerprint, commandId: crypto.randomUUID() };
    }
    const commandId = pendingCommand.current.commandId;

    setSubmitting(true);
    setCreateError(null);
    await createFlight.current.run(async () => {
      try {
        const task = await api.createTask({ ...input, commandId });
        pendingCommand.current = null;
        setGoal('');
        setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
        setSelectedId(task.id);
        setError(null);
        void loadMetadata();
      } catch (cause) {
        setCreateError(errorMessage(cause));
      } finally {
        setSubmitting(false);
      }
    });
  }

  async function registerWorkspace() {
    const name = workspaceName.trim();
    const path = workspacePath.trim();
    if (!name || !path || workspaceFlight.current.isRunning) return;
    const fingerprint = JSON.stringify({ name, path });
    if (!workspaceCommand.current || workspaceCommand.current.fingerprint !== fingerprint) {
      workspaceCommand.current = { fingerprint, commandId: crypto.randomUUID() };
    }
    const commandId = workspaceCommand.current.commandId;
    setRegistering(true);
    setWorkspaceError(null);
    await workspaceFlight.current.run(async () => {
      try {
        const workspace = await api.registerWorkspace(name, path, commandId);
        workspaceCommand.current = null;
        setWorkspaces((current) => [...current.filter((item) => item.id !== workspace.id), workspace]);
        setWorkspaceId(workspace.id);
        setWorkspaceName('');
        setWorkspacePath('');
      } catch (cause) {
        setWorkspaceError(errorMessage(cause));
      } finally {
        setRegistering(false);
      }
    });
  }

  async function controlTask(task: Task, action: ControlAction, requirements?: string): Promise<boolean> {
    if (controlFlight.current.isRunning) return false;
    const trimmed = requirements?.trim() ?? '';
    if ((action === 'feedback' || action === 'return') && !trimmed) {
      setControlError('请先填写补充或退回要求。');
      return false;
    }
    const payload = controlCommand(action, '', trimmed);
    const key = controlCommands.current.taskKey(task, payload);
    setControlBusy(action);
    setControlError(null);
    return await controlFlight.current.run(async () => {
      try {
        const command = { ...payload, commandId: controlCommands.current.id(key) };
        const result = await api.controlTask(task.id, command);
        controlCommands.current.acknowledged(task, payload, key);
        setTasks((previous) => previous.map((item) => item.id === result.id ? result : item));
        if (selectedIdRef.current === task.id) await feed.current?.refresh();
        await loadMetadata();
        return true;
      } catch (cause) {
        controlCommands.current.unacknowledged(task, payload, key);
        // Persisted feedback is an acknowledgement even when its HTTP reply was lost.
        if (action === 'feedback' && latestSnapshot.current?.task.id === task.id && latestSnapshot.current.task.instructions?.some((instruction) => instruction.commandId === controlCommands.current.id(key))) {
          controlCommands.current.acknowledged(task, payload, key);
          return true;
        }
        if (selectedIdRef.current === task.id) setControlError(errorMessage(cause));
        return false;
      } finally { setControlBusy(null); }
    }) ?? false;
  }

  async function resolveApproval(approval: ApprovalRecord, optionId: string) {
    if (approvalFlight.current.isRunning) return;
    const previous = approvalCommands.current.get(approval.id);
    const command = previous?.optionId === optionId ? previous : { optionId, commandId: crypto.randomUUID() };
    approvalCommands.current.set(approval.id, command);
    setResolvingId(approval.id);
    setApprovalError(null);
    await approvalFlight.current.run(async () => {
      try {
        await api.resolveApproval(approval.id, optionId, command.commandId);
        approvalCommands.current.delete(approval.id);
        await refresh();
      } catch (cause) {
        if (selectedIdRef.current === approval.taskId) setApprovalError(errorMessage(cause));
      } finally { setResolvingId(null); }
    });
  }

  const selectedTask = snapshot?.task ?? tasks.find((task) => task.id === selectedId);
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');
  const selectedApprovals = pendingApprovals.filter((approval) => approval.taskId === selectedId);
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const displayEvents = useMemo(() => groupTaskEvents(snapshot?.events ?? []), [snapshot?.events]);
  const visibleEvents = displayEvents.slice(-visibleEventCount);

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href={fakeDemo ? '/?demo=fake' : '/'} aria-label="Personal Agent 首页">
          <span className="brand-mark" aria-hidden="true">P</span>
          <span>Personal Agent<span className="brand-subtitle">个人任务工作台</span></span>
        </a>
        <Tag className="environment-tag" color={session.mode === 'paired' ? 'green' : 'blue'}>{session.mode === 'paired' ? '已配对设备' : '本机访问'}</Tag>
      </header>

      <main>
        <section className="intro" aria-labelledby="workbench-title">
          <div>
            <p className="eyebrow">YOUR PERSONAL WORKSPACE</p>
            <Typography.Title level={1} id="workbench-title">给一个目标，看看它如何完成</Typography.Title>
            <p className="intro-description">查看 Agent 分工、补充要求、接管执行，再接收或退回成果。</p>
          </div>
          <div className="demo-label"><span className="demo-dot" />{session.mode === 'paired' ? '已配对任务工作台' : '本机任务工作台'}</div>
        </section>

        <nav className="app-navigation" aria-label="工作台导航">
          <Button type={view === 'workbench' ? 'primary' : 'default'} aria-pressed={view === 'workbench'} onClick={() => setView('workbench')}>任务工作台</Button>
          <Button type={view === 'settings' ? 'primary' : 'default'} aria-pressed={view === 'settings'} onClick={() => setView('settings')}>实例配置</Button>
          {session.mode === 'paired' && <Button type={view === 'devices' ? 'primary' : 'default'} aria-pressed={view === 'devices'} onClick={() => setView('devices')}>设备管理</Button>}
        </nav>

        {view === 'devices' && session.mode === 'paired' ? <DevicePanel session={session} /> : view === 'settings' ? <SettingsPanel settings={settings} profiles={profiles} loading={settingsLoading} error={settingsError} fakeDemo={fakeDemo} onReload={loadConfiguration} onSettingsChanged={(value) => { setSettings(value); if (!engineTouched.current) setEngine(taskEngineForMode(value.defaultEngine, fakeDemo)); }} onProfileChanged={(value) => setProfiles((previous) => [...previous.filter((item) => item.id !== value.id), value])} /> : <>
        <Alert
          className="phase-notice"
          type="info"
          showIcon
          message={fakeDemo ? '临时 fake 演示，退出后数据清理。' : '选择 fake 可体验演示；选择 Claude 将在独立 Git worktree 中真实执行。'}
          description={fakeDemo ? '可创建演示任务，查看事件、成果和任务控制。仅使用 fake 引擎；在启动终端退出演示后清理数据，关闭页面不会停止演示。' : '真实任务保存代码补丁和实际验证结果。工作区会保留，合并、推送和清理需由你另外操作。'}
        />

        {error && <Alert className="request-error" type="error" showIcon message={error} action={<Button size="small" onClick={() => void refresh()}>重试连接</Button>} />}

        <div className="workbench">
          <aside className="task-sidebar" aria-label="任务创建与列表">
            <Card className="create-card" title="新建任务" bordered={false}>
              <label className="input-label" htmlFor="task-engine">执行引擎</label>
              <Select
                id="task-engine"
                className="full-width"
                value={engine}
                onChange={(value: 'fake' | 'claude') => { engineTouched.current = true; setEngine(taskEngineForMode(value, fakeDemo)); setCreateError(null); }}
                disabled={submitting || fakeDemo}
                options={allowedTaskEngines(fakeDemo).map((value) => ({ value, label: value === 'fake' ? 'fake · 演示任务' : 'Claude · 真实执行' }))}
              />
              <p className="field-hint">{engine === 'fake' ? '演示引擎生成事件与成果。' : '本机 Claude 依次执行分析、开发、评审与汇总。'}</p>

              <details className="profile-picker">
                <summary>Agent 档案 · 可选</summary>
                <p className="field-hint">留空使用各角色的默认档案，创建时保存配置快照。</p>
                {agentRoles.map((role) => <div key={role}>
                  <label className="input-label" htmlFor={`task-profile-${role}`}>{roleLabels[role]}</label>
                  <Select id={`task-profile-${role}`} className="full-width" value={profileIds[role]} allowClear disabled={submitting || settingsLoading} placeholder="默认档案" options={profiles.filter((profile) => profile.role === role).map((profile) => ({ value: profile.id, label: profile.name }))} onChange={(value: string | undefined) => setProfileIds((previous) => { const next = { ...previous }; if (value) next[role] = value; else delete next[role]; return next; })} />
                </div>)}
                {settingsError && <p className="field-hint">档案暂未读取，可到实例配置重新读取。</p>}
              </details>

              {engine === 'claude' && (
                <div className="real-task-fields">
                  <label className="input-label" htmlFor="task-workspace">Git 工作区</label>
                  <Select
                    id="task-workspace"
                    className="full-width"
                    value={workspaceId}
                    onChange={(value: string) => setWorkspaceId(value)}
                    disabled={submitting || registering}
                    placeholder="选择已登记的工作区"
                    options={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
                    notFoundContent="请先登记本机 Git 工作区"
                  />
                  {selectedWorkspace && <p className="workspace-path">{selectedWorkspace.path}</p>}
                  <p className="field-hint">以创建时的 HEAD 为基线；宿主目录的未提交修改不进入任务。</p>
                  <details className="workspace-register">
                    <summary>登记 Git 工作区</summary>
                    <label className="input-label" htmlFor="workspace-name">名称</label>
                    <Input id="workspace-name" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} disabled={registering} placeholder="例如：本地演示项目" />
                    <label className="input-label" htmlFor="workspace-path">本机路径</label>
                    <Input id="workspace-path" value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} disabled={registering} placeholder="Git 仓库的完整路径" />
                    {workspaceError && <Alert className="create-error" type="error" showIcon message={workspaceError} />}
                    <Button block loading={registering} disabled={!workspaceName.trim() || !workspacePath.trim() || submitting} onClick={() => void registerWorkspace()}>登记并选择</Button>
                  </details>

                  <div className="verification-fields">
                    <h3>由 Runtime 执行的验证命令</h3>
                    <p className="field-hint">请明确选定程序与参数。参数作为独立数组传入。</p>
                    {drafts.map((draft, index) => (
                      <div className="verification-draft" key={draft.id}>
                        <div className="draft-heading"><strong>命令 {index + 1}</strong>{drafts.length > 1 && <Button type="text" size="small" disabled={submitting} onClick={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))}>移除</Button>}</div>
                        <label className="input-label" htmlFor={`command-${draft.id}`}>可执行程序</label>
                        <Input id={`command-${draft.id}`} value={draft.command} disabled={submitting} placeholder="例如 npm 或 node" onChange={(event) => setDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, command: event.target.value } : item))} />
                        <label className="input-label" htmlFor={`args-${draft.id}`}>参数 · JSON 字符串数组</label>
                        <TextArea id={`args-${draft.id}`} value={draft.argsText} disabled={submitting} placeholder={'例如 ["test"]；无参数填 []'} autoSize={{ minRows: 2, maxRows: 5 }} onChange={(event) => setDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, argsText: event.target.value } : item))} />
                      </div>
                    ))}
                    <Button block type="dashed" disabled={submitting || drafts.length >= 8} onClick={() => setDrafts((current) => [...current, blankVerification()])}>添加验证命令</Button>
                  </div>
                </div>
              )}

              <label className="input-label" htmlFor="task-goal">你想完成什么？</label>
              <TextArea
                id="task-goal"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder="例如：为一个待办应用增加任务筛选，并给出验证记录。"
                autoSize={{ minRows: 4, maxRows: 8 }}
                maxLength={8000}
                disabled={submitting}
              />
              {createError && <Alert className="create-error" type="error" message={createError} showIcon />}
              <Button className="create-button" type="primary" size="large" block loading={submitting} disabled={!goal.trim()} onClick={() => void createTask()}>
                {createError ? '重试创建任务' : engine === 'claude' ? '创建真实任务' : '创建演示任务'}
              </Button>
              <p className="form-hint">目标与执行记录将保存到本机。</p>
            </Card>

            {pendingApprovals.length > 0 && (
              <section className="pending-approval-list" aria-label="待处理审批">
                <h2>待处理审批 <span>{pendingApprovals.length}</span></h2>
                {pendingApprovals.map((approval) => <button key={approval.id} type="button" onClick={() => setSelectedId(approval.taskId)}>{approval.title}<span>查看任务 {approval.taskId.slice(0, 8)}</span></button>)}
              </section>
            )}

            <section className="task-list-section" aria-labelledby="task-list-heading">
              <div className="section-heading"><h2 id="task-list-heading">任务记录 <span>{tasks.length}</span></h2><Button type="text" size="small" onClick={() => void refresh()}>刷新</Button></div>
              {initialLoading ? <div className="loading-area"><Spin /></div> : tasks.length === 0 ? <div className="list-empty">还没有任务。写下第一个目标吧。</div> : (
                <ul className="task-list">
                  {tasks.map((task) => (
                    <li key={task.id}>
                      <button className={`task-list-item${selectedId === task.id ? ' selected' : ''}`} type="button" aria-pressed={selectedId === task.id} onClick={() => setSelectedId(task.id)}>
                        <span className="task-row"><StatusTag task={task} /><time dateTime={task.createdAt}>{formatTime(task.createdAt)}</time></span>
                        <span className="task-engine-label"><EngineTag task={task} /></span>
                        <span className="task-goal">{task.goal}</span>
                        <span className="task-id">{task.id.slice(0, 8)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>

          <section className="task-detail" aria-label="任务详情" aria-busy={detailLoading}>
            {!selectedTask ? (
              <Card className="empty-card" bordered={false}>
                <div className="empty-symbol" aria-hidden="true">↗</div>
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="任务进度会出现在这里" />
                <p>创建任务后，查看 Agent 的事件与成果。</p>
              </Card>
            ) : (
              <>
                <Card className="detail-overview" bordered={false}>
                  <div className="overview-heading"><span className="eyebrow">TASK OVERVIEW</span><div className="overview-tags"><EngineTag task={selectedTask} /><StatusTag task={selectedTask} /></div></div>
                  <Typography.Title level={2}>{selectedTask.goal}</Typography.Title>
                  <dl className="task-meta">
                    <div><dt>任务 ID</dt><dd>{selectedTask.id}</dd></div>
                    <div><dt>交付状态</dt><dd>{selectedTask.deliveryStatus === 'pending' && selectedTask.status !== 'completed' ? '尚未交付' : deliveryLabels[selectedTask.deliveryStatus]}</dd></div>
                    <div><dt>最近更新</dt><dd>{formatTime(selectedTask.updatedAt)}</dd></div>
                  </dl>
                  {selectedTask.engine === 'claude' && (
                    <>
                      <dl className="workspace-meta">
                        <div><dt>Git 基线</dt><dd>{selectedTask.baselineSha ?? '等待准备'}</dd></div>
                        <div><dt>任务分支</dt><dd>{selectedTask.branchName ?? '等待准备'}</dd></div>
                        <div><dt>独立 worktree</dt><dd>{selectedTask.worktreePath ?? '等待准备'}</dd></div>
                      </dl>
                      <p className="field-hint">任务工作区与补丁保留在本机。完成后可查看成果，再决定合并或清理。</p>
                    </>
                  )}
                  {!detailLoading && <TaskControls key={selectedTask.id} task={selectedTask} hasPendingApproval={selectedApprovals.length > 0} busy={controlBusy} error={controlError} onControl={(action, requirements) => controlTask(selectedTask, action, requirements)} />}
                  <p className="polling-hint" role="status"><span className="demo-dot" /><Tag color={connectionState === 'live' ? 'success' : 'warning'}>{connectionLabels[connectionState]}</Tag><span>事件 #{snapshot?.cursor ?? 0}</span></p>
                </Card>

                {detailLoading ? <div className="loading-area"><Spin /></div> : snapshot && (
                  <>
                    {selectedApprovals.length > 0 && (
                      <Card className="approvals-card" bordered={false} title="需要你处理的审批">
                        <p className="field-hint">请求会持续等待。请查看具体操作，并明确选择一个选项。</p>
                        {selectedApprovals.map((approval) => (
                          <article className="approval-item" key={approval.id}>
                            <h3>{approval.title}</h3>
                            <p className="approval-context">执行尝试 {approval.attemptId} · Agent {approval.runId}</p>
                            <ApprovalDetails approval={approval} />
                            <div className="approval-options">{approval.options.map((option) => <Button key={option.optionId} danger={option.kind.startsWith('reject')} disabled={resolvingId !== null} loading={resolvingId === approval.id && approvalCommands.current.get(approval.id)?.optionId === option.optionId} onClick={() => void resolveApproval(approval, option.optionId)}>{option.name}</Button>)}</div>
                          </article>
                        ))}
                        {approvalError && <Alert className="create-error" type="error" showIcon message={approvalError} />}
                      </Card>
                    )}
                    <TaskEvidence snapshot={snapshot} />
                    <TaskContext task={snapshot.task} />
                    <Card className="events-card" bordered={false} title={<span>执行记录 <span className="count-label">{snapshot.events.length}</span></span>}>
                      {snapshot.events.length === 0 ? <p className="section-empty">等待执行事件…</p> : (
                        <>
                          <p className="field-hint">逐字消息已按 Agent 合并。共 {snapshot.events.length} 条原始事件，当前展示 {visibleEvents.length} 段记录。</p>
                          {displayEvents.length > visibleEventCount && <Button className="history-button" block onClick={() => setVisibleEventCount((count) => count + 100)}>展开更早的记录（剩余 {displayEvents.length - visibleEventCount} 段）</Button>}
                          <ol className="event-list">{visibleEvents.map((item) => <EventItem key={item.event.seq} item={item} />)}</ol>
                        </>
                      )}
                    </Card>
                    <Card className="artifacts-card" bordered={false} title={<span>任务成果 <span className="count-label">{snapshot.artifacts.length}</span></span>}>
                      {snapshot.artifacts.length === 0 ? <p className="section-empty">成果生成后会保存在这里。</p> : <div className="artifact-list">{snapshot.artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}</div>}
                    </Card>
                  </>
                )}
              </>
            )}
          </section>
        </div>
        </>}
      </main>
      <footer>{fakeDemo ? 'Personal Agent · 临时 fake 演示' : 'Personal Agent · 本地开发预览 · fake 演示 / Claude 真实执行'}</footer>
    </div>
  );
}
