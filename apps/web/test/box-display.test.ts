import { describe, expect, it } from 'vitest';
import type { BoxDeployment, BoxDesktop } from '@personal-agent/contracts';
import {
  canStartDesktop, formatBytes, formatRelative, installCommand, memoryUsage, orderDeployments, publicInstallOrigin,
} from '../src/box-display';

const policy = { concurrent: 2, max: 3, budgetBytesPerDesktop: Math.round(0.7 * 1024 ** 3), idleStopMinutes: 15 };
const desktop = (id: string, extra: Partial<BoxDesktop> = {}): BoxDesktop =>
  ({ id, label: `桌面 ${id.slice(1)}`, display: `:${id.slice(1)}`, state: 'stopped', streamable: true, ...extra });
const deployment = (extra: Partial<BoxDeployment> = {}): BoxDeployment => ({
  id: 'local', kind: 'local', adapter: 'colima', name: '本机', checkedAt: '2026-10-20T00:00:00Z',
  host: { state: 'running' }, container: { state: 'running', name: 'pa-box' },
  desktops: [desktop('d1'), desktop('d2'), desktop('d3')], desktopPolicy: policy, memoryPressure: 'normal', actions: [],
  ...extra,
});

describe('box display helpers', () => {
  it('formats bytes, relative times and memory usage', () => {
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(4 * 1024 ** 3)).toBe('4 GiB');
    expect(formatBytes(0.7 * 1024 ** 3)).toBe('717 MiB');
    const now = Date.parse('2026-10-20T00:01:00Z');
    expect(formatRelative(null, now)).toBe('从未');
    expect(formatRelative('2026-10-20T00:00:30Z', now)).toBe('30 秒前');
    expect(formatRelative('2026-10-20T00:10:00Z', now)).toBe('9 分钟后');
    expect(memoryUsage(820 * 1024 ** 2, 3.5 * 1024 ** 3)).toMatch(/MiB \/ 3\.5 GiB/);
  });

  it('refuses new desktops at the concurrent cap or under memory pressure', () => {
    expect(canStartDesktop(deployment(), desktop('d1'))).toEqual({ ok: true });
    expect(canStartDesktop(deployment({ fake: true }), desktop('d1'))).toEqual({ ok: false, reason: '演示数据' });
    expect(canStartDesktop(deployment(), desktop('d1', { state: 'running' }))).toEqual({ ok: false, reason: '已在运行' });
    expect(canStartDesktop(deployment({ container: { state: 'stopped', name: 'pa-box' } }), desktop('d1'))).toEqual({ ok: false, reason: '容器未运行' });
    expect(canStartDesktop(deployment({ desktops: [desktop('d1', { state: 'running' }), desktop('d2', { state: 'running' }), desktop('d3')] }), desktop('d3')))
      .toEqual({ ok: false, reason: '已达并发上限（2 个）' });
    expect(canStartDesktop(deployment({ memoryPressure: 'warn' }), desktop('d1'))).toEqual({ ok: false, reason: '内存紧张' });
    expect(canStartDesktop(deployment({ desktops: [desktop('d1', { streamable: false })] }), desktop('d1', { streamable: false })))
      .toEqual({ ok: false, reason: '容器未就绪或未通过安全校验' });
  });

  it('lists local deployments before named cloud hosts', () => {
    const { local, cloud } = orderDeployments([
      deployment({ id: 'cloud-b', kind: 'cloud', name: 'zeta', adapter: 'cloud-agent' }),
      deployment({ id: 'local', kind: 'local', name: '本机' }),
      deployment({ id: 'cloud-a', kind: 'cloud', name: 'alpha', adapter: 'cloud-ssh' }),
    ]);
    expect(local.map(item => item.id)).toEqual(['local']);
    expect(cloud.map(item => item.name)).toEqual(['alpha', 'zeta']);
  });

  it('only builds an https install command with a 43-character ticket', () => {
    const ticket = 'A'.repeat(43);
    expect(publicInstallOrigin({ protocol: 'https:', origin: 'https://agent.example.test' })).toBe('https://agent.example.test');
    expect(publicInstallOrigin({ protocol: 'http:', origin: 'http://127.0.0.1:47801' })).toBeUndefined();
    expect(publicInstallOrigin({ protocol: 'app:', origin: 'app://personal-agent' })).toBeUndefined();
    const command = installCommand('https://agent.example.test', ticket);
    expect(command).toContain('--ticket-file /root/pa-box.ticket');
    expect(command).toContain('--server https://agent.example.test');
    expect(command).toContain("bash --noprofile --norc");
    expect(() => installCommand('http://127.0.0.1:47801', ticket)).toThrow();
    expect(() => installCommand('https://agent.example.test', 'short')).toThrow();
  });
});
