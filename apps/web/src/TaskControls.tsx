import { Alert, Button, Input, Tag } from 'antd';
import { useState } from 'react';
import type { Task } from '@personal-agent/contracts';
import { availableTaskActions, type ControlAction } from './mutation-commands';

const labels: Record<ControlAction, string> = {
  feedback: '保存补充要求', pause: '阶段结束后暂停', takeover: '立即接管', resume: '继续执行',
  retry: '重试任务', cancel: '取消任务', accept: '接收成果', return: '退回返工',
};

export function TaskControls({ task, hasPendingApproval, busy, error, onControl }: {
  task: Task;
  hasPendingApproval: boolean;
  busy: ControlAction | null;
  error: string | null;
  onControl: (action: ControlAction, requirements?: string) => Promise<boolean>;
}) {
  const [requirements, setRequirements] = useState('');
  const actions = availableTaskActions(task, hasPendingApproval);
  const showRequirements = actions.some((action) => ['feedback', 'takeover', 'return'].includes(action));

  async function act(action: ControlAction) {
    const applied = await onControl(action, requirements.trim());
    if (applied && ['feedback', 'takeover', 'return'].includes(action)) setRequirements('');
  }

  return (
    <section className="control-panel" aria-label="任务控制">
      {task.pauseRequested && <Tag color="warning">已请求阶段结束后暂停</Tag>}
      {showRequirements && (
        <div className="requirements-input">
          <label className="input-label" htmlFor="task-requirements">{task.status === 'completed' ? '退回要求' : '补充要求'}</label>
          <Input.TextArea id="task-requirements" value={requirements} onChange={(event) => setRequirements(event.target.value)} disabled={busy !== null} maxLength={10000} autoSize={{ minRows: 2, maxRows: 6 }} placeholder={task.status === 'completed' ? '退回返工需说明希望修改的内容。' : '保存后从下一阶段起生效；立即接管会先停止当前阶段。'} />
          {task.status !== 'completed' && <p className="field-hint">补充要求从下一阶段生效。若已进入评审或汇总，要修改已完成代码请先接管处理，或交付后退回返工；汇总时的补充仅用于汇总。</p>}
        </div>
      )}
      <div className="task-controls">
        {actions.map((action) => (
          <Button key={action} type={['resume', 'accept'].includes(action) ? 'primary' : 'default'} danger={action === 'cancel'} loading={busy === action} disabled={busy !== null || (['feedback', 'return'].includes(action) && !requirements.trim())} onClick={() => void act(action)}>
            {action === 'pause' && task.status === 'queued' ? '暂停排队' : labels[action]}
          </Button>
        ))}
      </div>
      {task.status === 'waiting_human' && !hasPendingApproval && <Alert className="create-error" type="warning" showIcon message="流程等待人工检查。请查看验证与评审记录，处理问题后可重试任务。" />}
      {error && <Alert className="create-error" type="error" showIcon message={error} />}
    </section>
  );
}
