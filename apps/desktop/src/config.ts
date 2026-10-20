import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_CONNECT_URL, parseConnectUrl } from './connect-mode.js';

/**
 * 客户端设置（保存在 Electron userData 目录下的 desktop-settings.json）。
 * 不保存任何令牌或口令：托管模式的令牌每次启动重新生成，只存在于内存。
 */
export interface DesktopSettings {
  mode: 'managed' | 'connect';
  connectUrl: string;
  /** 托管模式的数据目录；默认与命令行版相同（~/.personal-agent），可用 PERSONAL_AGENT_DATA_DIR 覆盖。 */
  dataDir?: string;
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return resolve(env.PERSONAL_AGENT_DATA_DIR || join(home, '.personal-agent'));
}

export const DEFAULT_SETTINGS: DesktopSettings = { mode: 'managed', connectUrl: DEFAULT_CONNECT_URL };

export function normalizeSettings(value: unknown): DesktopSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const mode = input.mode === 'connect' ? 'connect' : 'managed';
  const connectUrl = typeof input.connectUrl === 'string' && parseConnectUrl(input.connectUrl) ? parseConnectUrl(input.connectUrl)!.url : DEFAULT_CONNECT_URL;
  const dataDir = typeof input.dataDir === 'string' && input.dataDir && !input.dataDir.includes('\0') ? resolve(input.dataDir) : undefined;
  return { mode, connectUrl, ...(dataDir ? { dataDir } : {}) };
}

export function loadSettings(file: string): DesktopSettings {
  try { return normalizeSettings(JSON.parse(readFileSync(file, 'utf8'))); }
  catch { return { ...DEFAULT_SETTINGS }; }
}

/** 原子写入：先写临时文件再 rename（Windows 上 rename 覆盖同样是原子的替换）。 */
export function saveSettings(file: string, settings: DesktopSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(normalizeSettings(settings), null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
}
