import { Alert, Card, Tag } from 'antd';
import type { AgentRunRecord, ApprovalRecord, StageRecord, TaskSnapshot, VerificationResult } from '@personal-agent/contracts';

export function ApprovalDetails({ approval }: { approval: ApprovalRecord }) {
  if (!approval.toolCall) {
    return <p className="field-hint">此请求未提供完整工具详情。请核对操作目标和修改内容后再处理。</p>;
  }
  return (
    <details className="event-details approval-tool-details" open style={{ marginBottom: 16 }}>
      <summary>完整工具详情 · 输入、目标与差异</summary>
      <pre>{JSON.stringify(approval.toolCall, null, 2)}</pre>
    </details>
  );
}

const stageLabels: Record<StageRecord['name'], string> = {
  analysis: '并行分析',
  development: '开发修改',
  verification: 'Runtime 验证',
  review: '检查评审',
  summary: '成果汇总',
};

const roleLabels: Record<AgentRunRecord['role'], string> = {
  planner: '方案 Agent',
  developer: '开发 Agent',
  reviewer: '检查 Agent',
};

const labels: Record<AgentRunRecord['status'], string> = {
  running: '执行中',
  waiting_human: '等待审批',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const colors: Record<AgentRunRecord['status'], string> = {
  running: 'processing',
  waiting_human: 'warning',
  completed: 'success',
  failed: 'error',
  cancelled: 'default',
};

function VerificationCard({ result }: { result: VerificationResult }) {
  const passed = result.exitCode === 0 && !result.timedOut && !result.cancelled;
  const outcome = result.cancelled ? '已取消' : result.timedOut ? '执行超时' : passed ? '通过' : '失败';
  return (
    <article className="verification-result">
      <div className="artifact-heading">
        <strong>Runtime 验证</strong>
        <Tag color={passed ? 'success' : result.cancelled ? 'default' : 'error'}>{outcome}</Tag>
      </div>
      <dl className="evidence-meta">
        <div><dt>可执行程序</dt><dd><code>{result.command.command}</code></dd></div>
        <div><dt>参数</dt><dd><code>{JSON.stringify(result.command.args)}</code></dd></div>
        <div><dt>实际退出码</dt><dd>{result.exitCode === null ? '无退出码' : result.exitCode}</dd></div>
        <div><dt>执行尝试</dt><dd><code>{result.attemptId}</code></dd></div>
      </dl>
      <details className="output-details" open={!passed}>
        <summary>stdout / stderr</summary>
        <p className="output-label">stdout</p>
        <pre>{result.stdout || '（无输出）'}</pre>
        <p className="output-label">stderr</p>
        <pre>{result.stderr || '（无输出）'}</pre>
      </details>
    </article>
  );
}

export function TaskEvidence({ snapshot }: { snapshot: TaskSnapshot }) {
  const stages = snapshot.stages ?? [];
  const runs = snapshot.runs ?? [];
  const verifications = snapshot.verifications ?? [];
  const failedVerification = verifications.some((result) => result.exitCode !== 0 || result.timedOut || result.cancelled);

  if (snapshot.task.engine !== 'claude' && stages.length === 0 && verifications.length === 0) return null;

  return (
    <>
      <Card className="stages-card" bordered={false} title="执行阶段与 Agent">
        {stages.length === 0 ? <p className="section-empty">工作区准备完成后，将开始方案与检查并行分析。</p> : (
          <ol className="stage-list">
            {stages.map((stage) => (
              <li className="stage-item" key={stage.id}>
                <div className="stage-heading">
                  <strong>{stageLabels[stage.name]}</strong>
                  <Tag color={colors[stage.status]}>{labels[stage.status]}</Tag>
                </div>
                <p className="stage-attempt">执行尝试 {stage.attemptId} · 第 {stage.iteration + 1} 轮</p>
                <ul className="run-list">
                  {runs.filter((run) => run.stageId === stage.id).map((run) => {
                    const status = snapshot.approvals?.some((approval) => approval.status === 'pending' && approval.runId === run.id && approval.attemptId === run.attemptId) ? 'waiting_human' : run.status;
                    return (
                      <li key={run.id}>
                        <span>{roleLabels[run.role]} <code>{run.mode}</code></span>
                        <Tag color={colors[status]}>{labels[status]}</Tag>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </Card>
      <Card className="verifications-card" bordered={false} title={<span>实际验证记录 <span className="count-label">{verifications.length}</span></span>}>
        {failedVerification && <Alert className="verification-notice" type="warning" showIcon message="历史记录包含未通过的验证。每次执行的退出码与输出均保留，请结合执行尝试查看后续结果。" />}
        {verifications.length === 0 ? <p className="section-empty">Runtime 尚未产生验证结果；Agent 消息不能替代实际命令结果。</p> : <div className="verification-list">{verifications.map((result) => <VerificationCard key={result.id} result={result} />)}</div>}
      </Card>
    </>
  );
}
