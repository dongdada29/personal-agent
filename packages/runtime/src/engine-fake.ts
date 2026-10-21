import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createAcpEngineAdapter } from './engine-acp.js';
import { engineStartupTimeoutMs, type EngineAdapter, type EngineConfig } from './engine.js';
import { nodeEsmSpecifier } from './process-windows.js';

/**
 * fake 引擎子进程的启动参数：
 * - 打包产物（Electron 客户端的 dist/server）里有预编译的 engine-fake-fixture.mjs，直接由 Node 运行，
 *   不依赖 tsx；
 * - 源码运行时使用 tsx 加载 .ts 夹具。
 * Windows 上入口与 `--import` 都必须是 file://，否则 ESM loader 会把 `D:\...` 当成 `d:` 协议。
 */
export function fakeEngineArgs(baseUrl: string = import.meta.url): string[] {
  const bundled = fileURLToPath(new URL('./engine-fake-fixture.mjs', baseUrl));
  // 主模块保持文件系统路径；只有 `--import` 在 Windows 上需要 file://。
  if (existsSync(bundled)) return [bundled];
  const fixture = fileURLToPath(new URL('./engine-fake-fixture.ts', baseUrl));
  const loader = nodeEsmSpecifier(createRequire(baseUrl).resolve('tsx'));
  return ['--import', loader, fixture];
}

/** An independent stdio ACP process, using the same pinned SDK as real engines. */
export function createFakeEngineAdapter(options: Partial<EngineConfig> = {}): EngineAdapter {
  return createAcpEngineAdapter({
    command: process.execPath,
    args: fakeEngineArgs(),
    startupTimeoutMs: process.platform === 'win32' ? engineStartupTimeoutMs() : 5_000,
    promptTimeoutMs: 5_000,
    // The fake child never needs model credentials or other ambient secrets.
    // ELECTRON_RUN_AS_NODE is added by spawnOwnedProcess when running inside Electron.
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    ...options,
  });
}
