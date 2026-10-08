import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TaskStore } from '@personal-agent/runtime';
import { buildApp } from '../src/app.js';

it('releases data directory ownership when static initialization fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-startup-'));
  try {
    const webRoot = join(dir, 'ordinary-file');
    writeFileSync(webRoot, 'fixture');
    await expect(buildApp({ dataDir: dir, autoRun: false, webRoot })).rejects.toThrow();
    expect(existsSync(join(dir, 'service.lock'))).toBe(false);
    const next = await buildApp({ dataDir: dir, autoRun: false, webRoot: join(dir, 'absent') });
    await next.app.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('releases data directory ownership when startup recovery fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-recovery-'));
  const failure = vi.spyOn(TaskStore.prototype, 'interruptActive').mockImplementation(() => { throw new Error('Recovery transaction failed'); });
  try {
    await expect(buildApp({ dataDir: dir, autoRun: false })).rejects.toThrow('Recovery transaction failed');
    expect(existsSync(join(dir, 'service.lock'))).toBe(false);
    failure.mockRestore();
    const next = await buildApp({ dataDir: dir, autoRun: false, webRoot: join(dir, 'absent') });
    await next.app.close();
  } finally { failure.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});
