import { chmodSync, mkdirSync } from 'node:fs';

/**
 * 数据目录只给当前用户：0700。已存在的目录也会收紧，避免托管模式第一次
 * 用默认 umask 建成 0755 之后一直敞着。
 */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* Windows 上 chmod 往往是空操作 */ }
}

/** SQLite / 口令文件：0600。WAL/SHM 一并收紧。 */
export function tightenPrivateFile(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try { chmodSync(candidate, 0o600); } catch { /* 文件尚未出现或平台忽略 mode */ }
  }
}
