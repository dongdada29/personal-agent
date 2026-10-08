/** Test-only IPC service. It never listens on a network port or opens a model. */
import { fileURLToPath } from 'node:url';
import { createAcpEngineAdapter } from '@personal-agent/runtime';
import { buildApp } from '../../src/app.js';
const dataDir = process.argv[2];
try {
  const { app, store } = await buildApp({ dataDir, webRoot: `${dataDir}/absent`,
    realAdapter: createAcpEngineAdapter({ command: process.execPath,
      args: [fileURLToPath(new URL('./restart-acp.mjs', import.meta.url))],
      env: { PATH: process.env.PATH }, startupTimeoutMs: 5000, promptTimeoutMs: 60_000 }),
  });
  process.on('message', async (value) => {
    const request = value as { id: number; method?: 'GET' | 'POST'; url?: string; payload?: unknown; op?: string };
    try {
      if (request.op === 'close') {
        await app.close();
        process.send?.({ id: request.id, result: { closed: true } }, () => process.disconnect());
      } else if (request.op === 'processes') {
        process.send?.({ id: request.id, result: store.processes(false) });
      } else {
        const response = await app.inject({ method: request.method ?? 'GET', url: request.url!, payload: request.payload as string | object | undefined });
        process.send?.({ id: request.id, result: { statusCode: response.statusCode, body: response.json() } });
      }
    } catch { process.send?.({ id: request.id, error: 'FIXTURE_REQUEST_FAILED' }); }
  });
  process.send?.({ ready: true });
} catch (error) {
  process.send?.({ startupError: error && typeof error === 'object' && 'code' in error ? error.code : 'STARTUP_FAILED' });
  process.disconnect();
}
