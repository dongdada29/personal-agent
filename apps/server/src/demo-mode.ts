/**
 * 公开 fake 演示模式的配置与校验。
 *
 * demo 模式只能由 scripts/demo.ts 显式传给 buildApp；生产入口 main.ts 遇到任何
 * PERSONAL_AGENT_DEMO_* 变量都会拒绝启动，避免把持久实例误配成公开演示，
 * 也避免误以为设置环境变量就能让持久实例变成 fake-only。
 */
export interface DemoModeConfig {
  mode: 'fake';
  /** 可选的公开 HTTPS origin（例如 Cloudflare 命名隧道的域名）；只做精确匹配。 */
  publicOrigin?: string;
  /** 演示实例最多保存的任务数，超出返回 429，需重启演示（数据目录随之重置）。 */
  maxTasks: number;
  /** 演示实例最多保存的 Agent 配置数（含 3 个默认配置）。 */
  maxProfiles: number;
  /** 整个实例每分钟允许的写请求数；隧道后的请求都来自 loopback，因此是全局计数。 */
  mutationsPerMinute: number;
}

export const DEMO_ENV_KEYS = ['PERSONAL_AGENT_DEMO_MODE', 'PERSONAL_AGENT_DEMO_PUBLIC_ORIGIN', 'PERSONAL_AGENT_DEMO_MAX_TASKS',
  'PERSONAL_AGENT_DEMO_MUTATIONS_PER_MINUTE'] as const;

const invalidDemo = (message: string) => Object.assign(new Error(message), { code: 'DEMO_CONFIG_INVALID' });

function boundedInteger(value: unknown, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  const number = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < min || number > max) {
    throw invalidDemo(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

/** 公开演示 origin 必须是不带路径、查询、凭据的规范 https origin。 */
export function validateDemoPublicOrigin(value: string): string {
  let origin: URL;
  try { origin = new URL(value); }
  catch { throw invalidDemo('PERSONAL_AGENT_DEMO_PUBLIC_ORIGIN must be an exact https origin'); }
  if (origin.protocol !== 'https:' || origin.origin !== value || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) {
    throw invalidDemo('PERSONAL_AGENT_DEMO_PUBLIC_ORIGIN must be one exact https origin without a path, query or credentials');
  }
  return origin.origin;
}

/** 数值字段可以来自环境变量字符串，统一在这里转换并限制范围。 */
export interface DemoModeInput {
  mode: 'fake';
  publicOrigin?: string;
  maxTasks?: number | string;
  maxProfiles?: number | string;
  mutationsPerMinute?: number | string;
}

export function validateDemoConfig(config: DemoModeInput): DemoModeConfig {
  if (config.mode !== 'fake') throw invalidDemo('Demo mode supports fake only');
  return {
    mode: 'fake',
    ...(config.publicOrigin !== undefined ? { publicOrigin: validateDemoPublicOrigin(config.publicOrigin) } : {}),
    maxTasks: boundedInteger(config.maxTasks, 200, 'maxTasks', 1, 10_000),
    maxProfiles: boundedInteger(config.maxProfiles, 20, 'maxProfiles', 3, 1_000),
    mutationsPerMinute: boundedInteger(config.mutationsPerMinute, 120, 'mutationsPerMinute', 1, 100_000),
  };
}

/** scripts/demo.ts 使用：PERSONAL_AGENT_DEMO_MODE 若设置则只能是 fake。 */
export function demoConfigFromEnv(env: Record<string, string | undefined>, overrides: { publicOrigin?: string } = {}): DemoModeConfig {
  if (env.PERSONAL_AGENT_DEMO_MODE !== undefined && env.PERSONAL_AGENT_DEMO_MODE !== 'fake') {
    throw invalidDemo('PERSONAL_AGENT_DEMO_MODE must be fake or omitted');
  }
  const publicOrigin = overrides.publicOrigin ?? (env.PERSONAL_AGENT_DEMO_PUBLIC_ORIGIN || undefined);
  return validateDemoConfig({ mode: 'fake', publicOrigin,
    maxTasks: env.PERSONAL_AGENT_DEMO_MAX_TASKS, mutationsPerMinute: env.PERSONAL_AGENT_DEMO_MUTATIONS_PER_MINUTE });
}

/** main.ts 使用：持久实例不接受任何演示配置。 */
export function rejectDemoEnvForPersistentServer(env: Record<string, string | undefined>): void {
  const present = DEMO_ENV_KEYS.filter(key => env[key] !== undefined);
  if (present.length) throw invalidDemo(`${present.join(', ')} only apply to npm run demo; the persistent server never runs in demo mode`);
}
