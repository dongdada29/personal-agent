import type { AgentRole, TaskConfigurationSnapshot } from '@personal-agent/contracts';
import type { ProcessLifecycleHooks } from './process-registry.js';

export interface EngineConfig {
  command: string;
  args?: string[];
  cwd?: string;
  /** Passed only to the child, never stored in events or probe output. */
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  promptTimeoutMs?: number;
  cancelGraceMs?: number;
  sessionMeta?: Record<string, unknown>;
}

export interface EngineRunContext {
  taskId: string;
  attemptId: string;
  runId: string;
  cwd: string;
  mode: 'plan' | 'default';
  /** Cancels startup before an EngineSession is available to the caller. */
  signal?: AbortSignal;
  role?: AgentRole;
  configSnapshot?: TaskConfigurationSnapshot;
}

export interface EngineArtifact {
  kind: 'markdown';
  title: string;
  content: string;
}

export type EngineEvent =
  | { type: 'message'; text: string }
  | { type: 'plan'; entries: Array<{ content: string; priority: string; status: string }> }
  | { type: 'mode'; modeId: string }
  | ({ type: 'artifact' } & EngineArtifact)
  | { type: 'completed'; stopReason: string };

export interface EnginePermission {
  id: string;
  sessionId: string;
  toolCallId: string;
  title: string;
  /** Complete ACP tool evidence; oversized requests fail without truncation. */
  toolCall?: {
    kind?: string;
    rawInput?: unknown;
    content?: unknown[];
    locations?: unknown[];
  };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface EngineHooks extends ProcessLifecycleHooks {
  onEvent(event: EngineEvent): void | Promise<void>;
  /** Persist the request; resolvePermission delivers its eventual response. */
  onPermission?(request: EnginePermission): void | Promise<void>;
}

export interface EnginePromptResult {
  stopReason: string;
  text: string;
  artifacts: EngineArtifact[];
}

export interface EngineSession {
  readonly sessionId: string;
  readonly processId: number | undefined;
  readonly availableModes: string[];
  prompt(input: string, signal?: AbortSignal): Promise<EnginePromptResult>;
  resolvePermission(requestId: string, optionId: string): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface EngineProbeResult {
  protocolReady: boolean;
  sessionReady: boolean;
  planModeSupported: boolean;
  authenticatedPrompt: 'not_checked' | 'passed' | 'failed';
  error?: { code: string; message: string };
}

export interface EngineAdapter {
  probe(config?: Partial<EngineConfig>): Promise<EngineProbeResult>;
  open(context: EngineRunContext, hooks: EngineHooks): Promise<EngineSession>;
}

export type EngineErrorCode =
  | 'ENGINE_FAILED' | 'AUTH_REQUIRED' | 'STARTUP_TIMEOUT' | 'PROMPT_TIMEOUT'
  | 'ABORTED' | 'SESSION_CLOSED' | 'SESSION_BUSY' | 'MODE_UNSUPPORTED'
  | 'PERMISSION_UNKNOWN' | 'PERMISSION_OPTION' | 'EVENT_FAILURE' | 'CLEANUP_FAILED' | 'PROBE_CONFIG_UNSAFE' | 'PROCESS_UNSUPPORTED';

/** Safe diagnostics contain no raw engine stderr, protocol payloads or credentials. */
export class EngineError extends Error {
  constructor(readonly code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

export function safeEngineError(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === -32000) {
    return new EngineError('AUTH_REQUIRED', 'Engine authentication is unavailable; use the engine’s existing local login.');
  }
  return new EngineError('ENGINE_FAILED', 'Engine operation failed. Raw engine diagnostics are withheld.');
}
