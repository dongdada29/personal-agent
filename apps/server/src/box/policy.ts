/**
 * 桌面并发与准入策略（L0 实测，M1 Mac mini 16GB）。
 *
 * - 每个桌面按 0.7GB 规划（空闲 ≈0.37GB、轻负载 ≈0.46GB、4 个重标签 ≈0.6–0.7GB，按 PSS）；
 * - 默认同时运行 2 个桌面，硬上限 3 个（镜像只预置 bot1..bot3）；第 4 个必须先停一个空闲桌面；
 * - 宿主内存压力到 warn 及以上时拒绝启动新桌面（已运行的桌面不受影响）；
 * - 无人查看的桌面在 idleStopMinutes 后自动停止。
 *
 * 可配置：PA_BOX_CONCURRENT_DESKTOPS（1..3，默认 2）、PA_BOX_DESKTOP_IDLE_MINUTES（1..1440，默认 15）。
 */
import type { BoxDesktopPolicy } from '@personal-agent/contracts';
import { BoxError, type BoxSnapshot } from './host-adapter.js';
import { BOX_MAX_DESKTOPS } from './parsers.js';

export const DESKTOP_BUDGET_BYTES = Math.round(0.7 * 1024 ** 3);
export const DEFAULT_DESKTOP_POLICY: BoxDesktopPolicy = { concurrent: 2, max: BOX_MAX_DESKTOPS, budgetBytesPerDesktop: DESKTOP_BUDGET_BYTES, idleStopMinutes: 15 };

const boundedInt = (value: string | undefined, min: number, max: number): number | undefined => {
  if (value === undefined || !/^\d{1,4}$/.test(value)) return undefined;
  const number = Number(value);
  return number >= min && number <= max ? number : undefined;
};

export function desktopPolicyFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<BoxDesktopPolicy> = {}): BoxDesktopPolicy {
  const policy = { ...DEFAULT_DESKTOP_POLICY,
    ...(boundedInt(env.PA_BOX_CONCURRENT_DESKTOPS, 1, BOX_MAX_DESKTOPS) !== undefined ? { concurrent: boundedInt(env.PA_BOX_CONCURRENT_DESKTOPS, 1, BOX_MAX_DESKTOPS)! } : {}),
    ...(boundedInt(env.PA_BOX_DESKTOP_IDLE_MINUTES, 1, 1440) !== undefined ? { idleStopMinutes: boundedInt(env.PA_BOX_DESKTOP_IDLE_MINUTES, 1, 1440)! } : {}),
    ...overrides };
  // 并发数永远不超过硬上限。
  policy.concurrent = Math.min(Math.max(1, Math.floor(policy.concurrent)), policy.max);
  return policy;
}

/**
 * 启动一个桌面前的准入判断；返回 undefined 表示允许。
 * 已在运行的桌面总是允许（只是重新打开 / 轮换令牌）。
 */
export function admitDesktop(snapshot: BoxSnapshot, desktopId: string, policy: BoxDesktopPolicy): BoxError | undefined {
  const index = /^d([1-9])$/.exec(desktopId)?.[1];
  if (!index || Number(index) > policy.max) return new BoxError('BOX_DESKTOP_NOT_FOUND', '桌面不存在。', 404);
  if (!snapshot.gateReady) return new BoxError('BOX_DESKTOP_UNAVAILABLE', 'box 容器未运行或未通过安全校验，不能打开桌面。');
  const desktop = snapshot.desktops.find(item => item.id === desktopId);
  if (!desktop) return new BoxError('BOX_DESKTOP_NOT_FOUND', '桌面不存在。', 404);
  if (desktop.running) return undefined;
  if (snapshot.memoryPressure === 'warn' || snapshot.memoryPressure === 'critical') {
    return new BoxError('BOX_MEMORY_PRESSURE', `宿主内存压力为 ${snapshot.memoryPressure}，暂不启动新桌面。请先停止空闲桌面或关闭其他程序。`);
  }
  const running = snapshot.desktops.filter(item => item.running).length;
  if (running >= policy.concurrent) {
    return new BoxError('BOX_DESKTOP_LIMIT', `已有 ${running} 个桌面在运行（上限 ${policy.concurrent}），请先停止一个空闲桌面。`);
  }
  const { memoryUsedBytes, memoryLimitBytes } = snapshot.container;
  if (memoryUsedBytes !== undefined && memoryLimitBytes !== undefined && memoryUsedBytes + policy.budgetBytesPerDesktop > memoryLimitBytes) {
    return new BoxError('BOX_MEMORY_BUDGET', '容器剩余内存不足以再启动一个桌面（每个桌面按 0.7GB 规划）。');
  }
  return undefined;
}
