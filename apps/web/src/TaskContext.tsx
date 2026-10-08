import { Card, Tag } from 'antd';
import type { Task } from '@personal-agent/contracts';

const stageLabels = { analysis: '并行分析', development: '开发修改', verification: 'Runtime 验证', review: '检查评审', summary: '成果汇总', delivery: '成果交付' };

export function TaskContext({ task }: { task: Task }) {
  const instructions = task.instructions ?? [];
  if (!task.configSnapshot && !task.checkpoint && instructions.length === 0) return null;
  return (
    <Card className="context-card" bordered={false} title="要求与执行配置">
      {task.checkpoint && (
        <div className="checkpoint-summary">
          <strong>恢复位置</strong><Tag>{stageLabels[task.checkpoint.nextStage]}</Tag><span>第 {task.checkpoint.iteration + 1} 轮</span>
          {task.checkpoint.outcome?.reason && <p>{task.checkpoint.outcome.reason}</p>}
          <details className="event-details"><summary>查看阶段检查点</summary><pre>{JSON.stringify(task.checkpoint, null, 2)}</pre></details>
        </div>
      )}
      {instructions.length > 0 && <ol className="instruction-list">{instructions.map((instruction) => <li key={instruction.id}><time dateTime={instruction.createdAt}>{new Date(instruction.createdAt).toLocaleString('zh-CN')}</time><p>{instruction.requirements}</p></li>)}</ol>}
      {task.configSnapshot && <details className="event-details task-configuration"><summary>创建时的配置快照 · 后续配置修改不会改变此任务</summary><pre>{JSON.stringify(task.configSnapshot, null, 2)}</pre></details>}
    </Card>
  );
}
