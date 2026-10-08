import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Dispose only a newly-created demo directory after confirmed process cleanup. */
export async function closeDemoData(dataDir: string, instance?: { app: { close(): Promise<void> }; runner: { isBlocked: boolean } }): Promise<void> {
  try { await instance?.app.close(); }
  catch { throw Object.assign(new Error('Demo evidence retained'), { code: 'DEMO_CLEANUP_FAILED' }); }
  if (instance?.runner.isBlocked || existsSync(join(dataDir, 'service.lock')) || existsSync(join(dataDir, 'recovery.lock'))) {
    throw Object.assign(new Error('Demo evidence retained'), { code: 'DEMO_CLEANUP_FAILED' });
  }
  rmSync(dataDir, { recursive: true, force: true });
}
