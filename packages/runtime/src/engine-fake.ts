import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createAcpEngineAdapter } from './engine-acp.js';
import type { EngineAdapter, EngineConfig } from './engine.js';

/**
 * fake 引擎子进程的启动参数：
 * - 打包产物（Electron 客户端的 dist/server）里有预编译的 engine-fake-fixture.mjs，直接由 Node 运行，
 *   不依赖 tsx；
 * - 源码运行时使用 tsx 加载 .ts 夹具。
 */
export function fakeEngineArgs(baseUrl: string = import.meta.url): string[] {
  const bundled = fileURLToPath(new URL('./engine-fake-fixture.mjs', baseUrl));
  if (existsSync(bundled)) return [bundled];
  const fixture = fileURLToPath(new URL('./engine-fake-fixture.ts', baseUrl));
  const loader = createRequire(baseUrl).resolve('tsx');
  // Windows ESM loader rejects a raw `D:\...` specifier; POSIX `node file.ts` keeps the path.
  return ['--import', loader, process.platform === 'win32' ? pathToFileURL(fixture).href : fixture];
}

/** An independent stdio ACP process, using the same pinned SDK as real engines. */
export function createFakeEngineAdapter(options: Partial<EngineConfig> = {}): EngineAdapter {
  return createAcpEngineAdapter({
    command: process.execPath,
    args: fakeEngineArgs(),
    startupTimeoutMs: 5_000,
    promptTimeoutMs: 5_000,
    // The fake child never needs model credentials or other ambient secrets.
    // ELECTRON_RUN_AS_NODE is added by spawnOwnedProcess when running inside Electron.
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    ...options,
  });
}
