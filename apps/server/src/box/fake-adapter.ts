/**
 * demo 实例专用的 fake 部署：只返回固定的假状态，没有任何命令执行、网络连接或桌面串流能力。
 * demo 实例在构造时就拿不到真实适配器（与任务 fake-only 的三层兜底同一思路）。
 */
import type { BoxDeployment, BoxDeploymentList } from '@personal-agent/contracts';
import { DEFAULT_DESKTOP_POLICY } from './policy.js';

export function fakeBoxDeployments(now = new Date()): BoxDeploymentList {
  const checkedAt = now.toISOString();
  const deployments: BoxDeployment[] = [{
    id: 'fake-local', kind: 'local', adapter: 'fake', name: '演示 · 本机 box（fake）', fake: true, checkedAt, actions: [],
    desktopPolicy: { ...DEFAULT_DESKTOP_POLICY }, memoryPressure: 'normal',
    host: { state: 'running', profile: 'pa-box', runtime: 'docker', arch: 'aarch64', version: 'fake', detail: '公开演示只展示假数据，不会启动任何虚拟机。',
      resources: { cpus: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 40 * 1024 ** 3 } },
    container: { state: 'running', name: 'pa-box', image: 'personal-agent/pa-box:0.1', statusText: 'running', cpuPercent: 3.2, memoryUsedBytes: 820 * 1024 ** 2, memoryLimitBytes: 3.5 * 1024 ** 3 },
    desktops: [{ id: 'd1', label: '桌面 1', display: ':1', state: 'running', streamable: false, viewers: 0 },
      { id: 'd2', label: '桌面 2', display: ':2', state: 'stopped', streamable: false, viewers: 0 },
      { id: 'd3', label: '桌面 3', display: ':3', state: 'stopped', streamable: false, viewers: 0 }],
  }, {
    id: 'fake-cloud', kind: 'cloud', adapter: 'fake', name: '演示 · 云端主机（fake）', providerLabel: 'fake provider', connection: 'agent', registered: true,
    lastHeartbeatAt: checkedAt, fake: true, checkedAt, actions: [],
    desktopPolicy: { ...DEFAULT_DESKTOP_POLICY }, memoryPressure: 'unknown',
    host: { state: 'running', runtime: 'docker', arch: 'x86_64', version: 'fake', resources: { cpus: 4, memoryBytes: 8 * 1024 ** 3 } },
    container: { state: 'stopped', name: 'pa-box', image: 'personal-agent/pa-box:0.1' },
    desktops: [],
  }];
  return { platform: 'demo', deployments };
}
