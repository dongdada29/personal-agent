import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAcpEngineAdapter } from '../packages/runtime/src/engine-acp.js';
import { createClaudeProbeConfig, readClaudeUserProbeMetadata, type ClaudeProbeProfile } from '../packages/runtime/src/engine-claude.js';
import { safeEngineError, type EngineProbeResult } from '../packages/runtime/src/engine.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--prompt' && arg !== '--user-settings')) {
  console.error('Usage: npm run probe:claude [-- --prompt] [--user-settings]');
  process.exitCode = 2;
} else {
  const cwd = await mkdtemp(join(tmpdir(), 'personal-agent-claude-probe-'));
  // Never inspect, copy, print, set up, or authenticate credentials. Safety
  // options only affect this ephemeral engine session, not persistent config.
  let result: EngineProbeResult;
  try {
    const profile: ClaudeProbeProfile = args.includes('--user-settings')
      ? { source: 'user', ...await readClaudeUserProbeMetadata() } : { source: 'isolated' };
    const config = createClaudeProbeConfig(cwd, profile);
    const adapter = createAcpEngineAdapter(config);
    result = await adapter.probe();
    if (args.includes('--prompt') && result.sessionReady && result.planModeSupported) {
      const session = await adapter.open({ taskId: 'probe', attemptId: 'probe', runId: randomUUID(), cwd, mode: 'plan' }, {
        onEvent: () => {},
        // Absence of an onPermission handler denies all requests as cancelled.
      });
      try {
        const response = await session.prompt('Reply with exactly PERSONAL_AGENT_PROBE_OK. Do not use tools or inspect files.');
        result.authenticatedPrompt = response.stopReason === 'end_turn' && response.text.trim() === 'PERSONAL_AGENT_PROBE_OK' ? 'passed' : 'failed';
        if (result.authenticatedPrompt === 'failed') result.error = { code: 'PROBE_RESPONSE', message: 'The authenticated probe did not return the expected fixed response.' };
      } catch (error) {
        const safe = safeEngineError(error);
        result.authenticatedPrompt = 'failed';
        result.error = { code: safe.code, message: safe.message };
      } finally { await session.close(); }
    }
    // Print booleans and fixed diagnostics only, never streamed model content,
    // raw protocol responses, engine auth methods, environment or stderr.
    console.log(JSON.stringify({
      ...result, configSource: profile.source,
      disabledPluginCount: profile.source === 'user' ? profile.disabledPlugins.length : 0,
      guards: { toolsDisabled: true, mcpRestricted: true, hooksDisabled: true, persistenceDisabled: true, autoUpdatesDisabled: true },
    }, null, 2));
    if (result.error || result.authenticatedPrompt === 'failed') process.exitCode = 1;
  } catch (error) {
    const safe = safeEngineError(error);
    console.log(JSON.stringify({ error: { code: safe.code, message: safe.message } }, null, 2));
    process.exitCode = 1;
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
