import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readClaudeUserProbeMetadata } from '../src/engine-claude.js';

it('allows native authentication when no user settings file exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-metadata-'));
  try { expect(await readClaudeUserProbeMetadata(join(dir, 'missing.json'))).toEqual({ disabledPlugins: [] }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

it('does not treat malformed existing settings as missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-metadata-'));
  try {
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{invalid');
    await expect(readClaudeUserProbeMetadata(path)).rejects.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
