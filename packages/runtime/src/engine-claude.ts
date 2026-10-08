import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EngineError, type EngineConfig } from './engine.js';

export type ClaudeProbeProfile = { source: 'isolated' } | { source: 'user'; disabledPlugins: string[] };

/** Reads public guard/plugin identifiers only; never forwards auth/env values. */
export async function readClaudeUserProbeMetadata(settingsPath = join(homedir(), '.claude', 'settings.json')): Promise<{ disabledPlugins: string[] }> {
  let info: Awaited<ReturnType<typeof stat>>;
  try { info = await stat(settingsPath); }
  catch (error) {
    // Native OAuth can exist without a user settings file.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { disabledPlugins: [] };
    throw error;
  }
  if (info.size > 1_048_576) throw new EngineError('PROBE_CONFIG_UNSAFE', 'User settings exceed the probe metadata size limit.');
  const settings: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new EngineError('PROBE_CONFIG_UNSAFE', 'User settings metadata is not a supported object.');
  }
  const keys = Object.keys(settings);
  if (['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'proxyAuthHelper', 'gcpAuthRefresh',
    'otelHeadersHelper', 'processWrapper', 'policyHelper'].some((key) => keys.includes(key))) {
    throw new EngineError('PROBE_CONFIG_UNSAFE', 'User settings contain an authentication helper; the no-execution probe cannot use this configuration.');
  }
  const plugins = (settings as { enabledPlugins?: unknown }).enabledPlugins;
  if (plugins === undefined) return { disabledPlugins: [] };
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) {
    throw new EngineError('PROBE_CONFIG_UNSAFE', 'User plugin metadata is not a supported object.');
  }
  // Do not access env, model, modelSettings, authentication or plugin values.
  return { disabledPlugins: Object.keys(plugins) };
}

/** Ephemeral no-tool probe config; uses the engine's existing native auth. */
export function createClaudeProbeConfig(cwd: string, profile: ClaudeProbeProfile = { source: 'isolated' }): EngineConfig {
  return {
    command: process.execPath,
    args: [createRequire(import.meta.url).resolve('claude-code-acp-ts/dist/index.js')],
    cwd,
    startupTimeoutMs: 30_000,
    promptTimeoutMs: 45_000,
    sessionMeta: {
      disableBuiltInTools: true,
      claudeCode: { options: {
        tools: [], allowedTools: [], skills: [], plugins: [], mcpServers: {},
        settingSources: profile.source === 'user' ? ['user'] : [],
        persistSession: false, hooks: {}, maxTurns: 1, strictMcpConfig: true,
        // The pinned native CLI identifies DISABLE_AUTOUPDATER as disabling
        // plugin autoupdate as well as its own updater. These static flags do
        // not contain or replace authentication values.
        env: { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        settings: {
          disableAllHooks: true, disableAgentView: true, disableRemoteControl: true, disableWorkflows: true,
          env: { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
          ...(profile.source === 'user' ? { enabledPlugins: Object.fromEntries(profile.disabledPlugins.map((id) => [id, false])) } : {}),
        },
        systemPrompt: 'You are performing a minimal connectivity probe. Reply to the supplied text only. Do not use tools or read any files.',
      } },
    },
  };
}
