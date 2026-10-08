import { createAcpEngineAdapter } from './engine-acp.js';
import { createClaudeProbeConfig, readClaudeUserProbeMetadata } from './engine-claude.js';
import type { EngineAdapter } from './engine.js';

/** Native user authentication only; no credential extraction or persistent config. */
export function createClaudeTaskAdapter(): EngineAdapter {
  const metadata = () => readClaudeUserProbeMetadata();
  return {
    async probe(config) {
      const profile = { source: 'user' as const, ...await metadata() };
      return createAcpEngineAdapter(createClaudeProbeConfig(config?.cwd ?? process.cwd(), profile)).probe(config);
    },
    async open(context, hooks) {
      const profile = { source: 'user' as const, ...await metadata() };
      const config = createClaudeProbeConfig(context.cwd, profile);
      config.promptTimeoutMs = context.configSnapshot?.settings.agentRunTimeoutMs ?? 30 * 60_000;
      const meta = config.sessionMeta!.claudeCode as { options: Record<string, unknown> };
      const readTools = ['Read', 'Glob', 'Grep'];
      meta.options.tools = context.mode === 'plan' ? readTools : [...readTools, 'Edit', 'Write'];
      meta.options.allowedTools = readTools;
      meta.options.maxTurns = 30;
      const agentProfile = context.role ? context.configSnapshot?.profiles[context.role] : undefined;
      if (agentProfile?.model) meta.options.model = agentProfile.model;
      meta.options.systemPrompt = 'Work only inside the supplied task Git worktree. Never inspect authentication, settings, home directories, or other repositories. Do not commit, merge, push, deploy, change permissions, start network services, or install software. Runtime alone runs the user-selected verification commands. Read stages do not modify files. Development may edit task files using ordinary permission approval.'
        + (agentProfile?.instructions ? `\n\nRole instructions:\n${agentProfile.instructions}` : '');
      return createAcpEngineAdapter(config).open(context, hooks);
    },
  };
}
