import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createAcpEngineAdapter } from './engine-acp.js';
import type { EngineAdapter, EngineConfig } from './engine.js';

/** An independent stdio ACP process, using the same pinned SDK as real engines. */
export function createFakeEngineAdapter(options: Partial<EngineConfig> = {}): EngineAdapter {
  const fixture = fileURLToPath(new URL('./engine-fake-fixture.ts', import.meta.url));
  const loader = createRequire(import.meta.url).resolve('tsx');
  return createAcpEngineAdapter({
    command: process.execPath,
    args: ['--import', loader, fixture],
    startupTimeoutMs: 5_000,
    promptTimeoutMs: 5_000,
    // The fake child never needs model credentials or other ambient secrets.
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    ...options,
  });
}
