import type { AgentRole, TaskConfigurationSnapshot } from '@personal-agent/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpEngineAdapter } from '../src/engine-acp.js';
import { readClaudeUserProbeMetadata } from '../src/engine-claude.js';
import { createClaudeTaskAdapter } from '../src/engine-claude-task.js';
import type { EngineAdapter, EngineConfig, EngineHooks, EngineRunContext, EngineSession } from '../src/engine.js';

vi.mock('../src/engine-acp.js', () => ({ createAcpEngineAdapter: vi.fn() }));
vi.mock('../src/engine-claude.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine-claude.js')>();
  return { ...actual, readClaudeUserProbeMetadata: vi.fn() };
});

const fixedGuard = 'Work only inside the supplied task Git worktree. Never inspect authentication, settings, home directories, or other repositories. Do not commit, merge, push, deploy, change permissions, start network services, or install software. Runtime alone runs the user-selected verification commands. Read stages do not modify files. Development may edit task files using ordinary permission approval.';
const readTools = ['Read', 'Glob', 'Grep'];
const delegatedOpen = vi.fn<EngineAdapter['open']>();
const delegatedProbe = vi.fn<EngineAdapter['probe']>();
const session: EngineSession = {
  sessionId: 'mock-claude-session', processId: undefined, availableModes: ['plan', 'default'],
  prompt: vi.fn(), resolvePermission: vi.fn(), cancel: vi.fn(), close: vi.fn(),
};

function snapshot(): TaskConfigurationSnapshot {
  const updatedAt = '2026-10-02T12:00:00.000Z';
  return {
    settings: { defaultEngine: 'claude', agentRunTimeoutMs: 123_456, verificationTimeoutMs: 7_890, updatedAt },
    profiles: {
      planner: { id: 'planner-profile', name: 'Planner', role: 'planner', model: 'planner-model', instructions: 'Planner snapshot instruction.', updatedAt },
      developer: { id: 'developer-profile', name: 'Developer', role: 'developer', model: 'developer-model', instructions: 'Developer snapshot instruction.', updatedAt },
      reviewer: { id: 'reviewer-profile', name: 'Reviewer', role: 'reviewer', model: 'reviewer-model', instructions: 'Reviewer snapshot instruction.', updatedAt },
    },
  };
}

function context(overrides: Partial<EngineRunContext> = {}): EngineRunContext {
  return { taskId: 'claude-task', attemptId: 'claude-attempt', runId: 'claude-run', cwd: '/fixture/task-worktree', mode: 'plan', ...overrides };
}

function capturedConfig(): EngineConfig {
  expect(createAcpEngineAdapter).toHaveBeenCalledTimes(1);
  return vi.mocked(createAcpEngineAdapter).mock.calls[0][0];
}

function claudeOptions(config: EngineConfig): Record<string, unknown> {
  return (config.sessionMeta!.claudeCode as { options: Record<string, unknown> }).options;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readClaudeUserProbeMetadata).mockResolvedValue({ disabledPlugins: ['fixture-plugin@fixture-marketplace'] });
  vi.mocked(createAcpEngineAdapter).mockReturnValue({ open: delegatedOpen, probe: delegatedProbe });
  delegatedOpen.mockResolvedValue(session);
  delegatedProbe.mockResolvedValue({ protocolReady: true, sessionReady: true, planModeSupported: true, authenticatedPrompt: 'not_checked' });
});

describe('Claude task configuration', () => {
  it.each<[AgentRole, EngineRunContext['mode']]>([
    ['planner', 'plan'], ['developer', 'default'], ['reviewer', 'plan'],
  ])('applies the captured %s profile and bounded %s tool policy', async (role, mode) => {
    const configSnapshot = snapshot();
    const runContext = context({ role, mode, configSnapshot });
    const hooks: EngineHooks = { onEvent: vi.fn(), onPermission: vi.fn(), onProcessStart: vi.fn(), onProcessEnd: vi.fn() };
    expect(await createClaudeTaskAdapter().open(runContext, hooks)).toBe(session);

    const config = capturedConfig();
    const options = claudeOptions(config);
    expect(config.cwd).toBe(runContext.cwd);
    expect(config.promptTimeoutMs).toBe(configSnapshot.settings.agentRunTimeoutMs);
    expect(config.promptTimeoutMs).not.toBe(configSnapshot.settings.verificationTimeoutMs);
    expect(options.model).toBe(configSnapshot.profiles[role].model);
    expect(options.systemPrompt).toBe(fixedGuard + '\n\nRole instructions:\n' + configSnapshot.profiles[role].instructions);
    expect(options.tools).toEqual(mode === 'plan' ? readTools : [...readTools, 'Edit', 'Write']);
    expect(options.allowedTools).toEqual(readTools);
    expect(options).not.toHaveProperty('permissionMode');
    expect(options).not.toHaveProperty('allowDangerouslySkipPermissions');
    expect(options).not.toHaveProperty('dangerouslySkipPermissions');
    expect(options.tools).not.toContain('Bash');
    expect(options.allowedTools).not.toContain('Bash');
    expect(options).toMatchObject({
      settingSources: ['user'], hooks: {}, skills: [], plugins: [], mcpServers: {}, strictMcpConfig: true,
      persistSession: false, maxTurns: 30,
      settings: { disableAllHooks: true, enabledPlugins: { 'fixture-plugin@fixture-marketplace': false } },
    });
    expect(delegatedOpen).toHaveBeenCalledTimes(1);
    expect(delegatedOpen).toHaveBeenCalledWith(runContext, hooks);
    expect(readClaudeUserProbeMetadata).toHaveBeenCalledTimes(1);
    expect(readClaudeUserProbeMetadata).toHaveBeenCalledWith();
    expect(delegatedProbe).not.toHaveBeenCalled();
  });

  it('keeps the fixed guard and default timeout without a task configuration snapshot', async () => {
    await createClaudeTaskAdapter().open(context({ mode: 'default' }), { onEvent: vi.fn() });
    const config = capturedConfig();
    const options = claudeOptions(config);
    expect(config.promptTimeoutMs).toBe(30 * 60_000);
    expect(options.systemPrompt).toBe(fixedGuard);
    expect(options).not.toHaveProperty('model');
    expect(options.tools).toEqual([...readTools, 'Edit', 'Write']);
    expect(options.allowedTools).toEqual(readTools);
  });

  it('does not inherit another role profile when the selected profile omits optional customizations', async () => {
    const configSnapshot = snapshot();
    delete configSnapshot.profiles.reviewer.model;
    configSnapshot.profiles.reviewer.instructions = '';
    await createClaudeTaskAdapter().open(context({ role: 'reviewer', configSnapshot }), { onEvent: vi.fn() });
    const options = claudeOptions(capturedConfig());
    expect(options).not.toHaveProperty('model');
    expect(options.systemPrompt).toBe(fixedGuard);
  });
});
