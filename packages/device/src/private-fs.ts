import { chmodSync, mkdirSync } from 'node:fs';

/** 租约目录只给当前用户：0700。与 runtime 的 ensurePrivateDirectory 语义一致，避免本包依赖 runtime。 */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* Windows 上 chmod 往往是空操作 */ }
}
