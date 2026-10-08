import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Readable, Writable } from 'node:stream';
import {
  client, methods, PROTOCOL_VERSION,
  type ClientConnection, type RequestPermissionResponse, type SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  EngineError, safeEngineError, type EngineAdapter, type EngineArtifact, type EngineConfig,
  type EngineEvent, type EngineHooks, type EnginePermission, type EngineProbeResult,
  type EnginePromptResult, type EngineRunContext, type EngineSession,
} from './engine.js';
import { spawnOwnedProcess } from './process-registry.js';
import { safeAcpStdioStream } from './engine-transport.js';

type PendingPermission = {
  request: EnginePermission;
  resolve: (response: RequestPermissionResponse) => void;
};
const MAX_PERMISSION_BYTES = 128 * 1024;

function deadline<T>(operation: Promise<T>, ms: number, error: EngineError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error), ms);
    operation.then((value) => { clearTimeout(timer); resolve(value); }, (cause) => { clearTimeout(timer); reject(cause); });
  });
}

/** A prompt consumes its budget only while it is not awaiting human decisions. */
class ActiveDeadline {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private runningSince: number | undefined;
  private stopped = false;

  constructor(private remainingMs: number, private readonly expire: () => void) {}

  resume(): void {
    if (this.stopped || this.runningSince !== undefined) return;
    this.runningSince = performance.now();
    this.timer = setTimeout(() => {
      // Expiry is final even before the rejected prompt reaches its catch block.
      this.stop();
      this.expire();
    }, Math.max(0, this.remainingMs));
  }

  pause(): void {
    if (this.stopped || this.runningSince === undefined) return;
    this.remainingMs = Math.max(0, this.remainingMs - (performance.now() - this.runningSince));
    this.runningSince = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.runningSince = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

class AcpEngineSession implements EngineSession {
  sessionId = '';
  availableModes: string[] = [];
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly ownedProcess: ReturnType<typeof spawnOwnedProcess>;
  private readonly connection: ClientConnection;
  private readonly permissions = new Map<string, PendingPermission>();
  private eventTail: Promise<void> = Promise.resolve();
  private hookError: EngineError | undefined;
  private text = '';
  private busy = false;
  private closePromise: Promise<void> | undefined;
  private cancelPromise: Promise<void> | undefined;
  private stopped = false;
  private rejectActive: ((error: EngineError) => void) | undefined;
  private promptDeadline: ActiveDeadline | undefined;
  protocolReady = false;

  constructor(private readonly config: EngineConfig, private readonly hooks: EngineHooks) {
    this.ownedProcess = spawnOwnedProcess({ command: config.command, args: config.args ?? [], cwd: config.cwd,
      env: config.env ?? process.env, kind: 'engine' });
    this.process = this.ownedProcess.process;
    // Drain without retaining or printing diagnostics, which can contain secrets.
    this.process.stderr.resume();
    this.process.stdin.on('error', () => { /* connection reports write failure */ });
    const app = client({ name: 'personal-agent' })
      .onNotification(methods.client.session.update, ({ params }) => this.onUpdate(params))
      .onRequest(methods.client.session.requestPermission, ({ params, requestId }) => {
        if (params.sessionId !== this.sessionId || this.stopped || !this.hooks.onPermission) {
          return { outcome: { outcome: 'cancelled' } } as RequestPermissionResponse;
        }
        const request: EnginePermission = {
          id: `${this.sessionId}:${String(requestId)}:${randomUUID()}`,
          sessionId: params.sessionId, toolCallId: params.toolCall.toolCallId,
          title: params.toolCall.title ?? 'Engine permission request', options: params.options,
          toolCall: {
            ...(params.toolCall.kind != null ? { kind: params.toolCall.kind } : {}),
            ...(params.toolCall.rawInput !== undefined ? { rawInput: params.toolCall.rawInput } : {}),
            ...(params.toolCall.content != null ? { content: params.toolCall.content } : {}),
            ...(params.toolCall.locations != null ? { locations: params.toolCall.locations } : {}),
          },
        };
        try {
          if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_PERMISSION_BYTES) throw new Error('oversized');
        } catch {
          // A human must see the complete proposal. Never create an approval
          // with shortened evidence or surface raw tool inputs as diagnostics.
          this.hookError = new EngineError('EVENT_FAILURE', 'Engine permission evidence exceeds its size limit or cannot be serialized safely.');
          this.rejectActive?.(this.hookError);
          return { outcome: { outcome: 'cancelled' } } as RequestPermissionResponse;
        }
        return new Promise<RequestPermissionResponse>((resolve) => {
          this.permissions.set(request.id, { request, resolve });
          this.updatePromptDeadline();
          Promise.resolve().then(() => {
            if (this.stopped || !this.permissions.has(request.id)) return;
            return this.hooks.onPermission?.(request);
          }).catch(() => {
            this.hookError = new EngineError('EVENT_FAILURE', 'Permission request could not be persisted.');
            this.rejectActive?.(this.hookError);
            this.permissions.delete(request.id);
            this.updatePromptDeadline();
            resolve({ outcome: { outcome: 'cancelled' } });
          });
        });
      });
    // No client filesystem or terminal handlers are registered.
    this.connection = app.connect(safeAcpStdioStream(
      Writable.toWeb(this.process.stdin), Readable.toWeb(this.process.stdout) as ReadableStream<Uint8Array>,
    ));
    this.process.once('error', () => this.connection.close(new EngineError('ENGINE_FAILED', 'Engine process could not start.')));
    this.process.once('exit', () => this.connection.close(new EngineError('ENGINE_FAILED', 'Engine process exited.')));
  }

  get processId(): number | undefined { return this.process.pid; }

  async initialize(context: EngineRunContext): Promise<void> {
    const signal = context.signal;
    let rejectInterrupted!: (error: EngineError) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
    const abort = () => {
      // close() marks the session stopped synchronously. The outstanding RPC
      // may settle later, but cannot start the next startup step or emit events.
      void this.close().catch(() => { /* catch below reports cleanup failure */ });
      rejectInterrupted(new EngineError('ABORTED', 'Engine startup was cancelled.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      await deadline(Promise.race([(async () => {
        this.assertActive(signal);
        await this.ownedProcess.start({
          onProcessStart: (record) => this.hooks.onProcessStart?.({ ...record, taskId: context.taskId, attemptId: context.attemptId, runId: context.runId }),
          onProcessEnd: (record) => this.hooks.onProcessEnd?.({ ...record, taskId: context.taskId, attemptId: context.attemptId, runId: context.runId }),
        }, signal);
        this.assertActive(signal);
        const initialized = await this.connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'personal-agent', version: '0.1.0' },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, plan: {}, auth: { terminal: false } },
        });
        this.assertActive(signal);
        if (initialized.protocolVersion !== PROTOCOL_VERSION) {
          throw new EngineError('ENGINE_FAILED', 'Engine ACP protocol version does not match the pinned SDK.');
        }
        this.protocolReady = true;
        const session = await this.connection.agent.request(methods.agent.session.new, {
          cwd: context.cwd, mcpServers: [], ...(this.config.sessionMeta ? { _meta: this.config.sessionMeta } : {}),
        });
        this.assertActive(signal);
        this.sessionId = session.sessionId;
        this.availableModes = session.modes?.availableModes.map(({ id }) => id) ?? [];
        if (!this.availableModes.includes(context.mode)) {
          throw new EngineError('MODE_UNSUPPORTED', `Engine does not advertise the required ${context.mode} mode.`);
        }
        // Explicitly select mode, including default; never inherit bypass modes.
        await this.connection.agent.request(methods.agent.session.setMode, { sessionId: this.sessionId, modeId: context.mode });
        this.assertActive(signal);
        await this.emit({ type: 'mode', modeId: context.mode });
        this.assertActive(signal);
      })(), interrupted]), this.config.startupTimeoutMs ?? 15_000, new EngineError('STARTUP_TIMEOUT', 'Engine startup exceeded its deadline.'));
    } catch (error) {
      await this.close();
      throw safeEngineError(error);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  private emit(event: EngineEvent): Promise<void> {
    this.eventTail = this.eventTail.then(() => {
      if (this.stopped || this.hookError) return;
      return deadline(Promise.resolve().then(() => {
        if (this.stopped || this.hookError) return;
        return this.hooks.onEvent(event);
      }),
        5_000, new EngineError('EVENT_FAILURE', 'Engine event could not be persisted before its deadline.'));
    }).catch(() => {
      this.hookError = new EngineError('EVENT_FAILURE', 'Engine event could not be persisted.');
      this.rejectActive?.(this.hookError);
    });
    return this.eventTail;
  }

  private onUpdate(notification: SessionNotification): void {
    if (notification.sessionId !== this.sessionId || this.stopped) return;
    const update = notification.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      this.text += update.content.text;
      void this.emit({ type: 'message', text: update.content.text });
    } else if (update.sessionUpdate === 'plan') {
      void this.emit({ type: 'plan', entries: update.entries });
    } else if (update.sessionUpdate === 'current_mode_update') {
      void this.emit({ type: 'mode', modeId: update.currentModeId });
    }
  }

  private assertActive(signal?: AbortSignal): void {
    if (this.stopped || signal?.aborted) throw new EngineError('ABORTED', 'Engine prompt was cancelled.');
    if (this.hookError) throw this.hookError;
  }

  private updatePromptDeadline(): void {
    if (this.stopped || this.permissions.size > 0) this.promptDeadline?.pause();
    else this.promptDeadline?.resume();
  }

  async prompt(input: string, signal?: AbortSignal): Promise<EnginePromptResult> {
    if (this.stopped) throw new EngineError('SESSION_CLOSED', 'Engine session is closed.');
    if (this.busy) throw new EngineError('SESSION_BUSY', 'Engine session already has an active prompt.');
    if (signal?.aborted) {
      await this.cancel();
      throw new EngineError('ABORTED', 'Engine prompt was cancelled.');
    }
    this.busy = true;
    this.text = '';
    const interrupted = new Promise<never>((_, reject) => { this.rejectActive = reject; });
    const timedOut = new Promise<never>((_, reject) => {
      this.promptDeadline = new ActiveDeadline(this.config.promptTimeoutMs ?? 30 * 60_000,
        () => reject(new EngineError('PROMPT_TIMEOUT', 'Engine prompt exceeded its active execution deadline.')));
    });
    this.updatePromptDeadline();
    const abort = () => { void this.cancel().catch(() => { /* prompt/close report cleanup */ }); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      // Cancellation and the prompt deadline cover persistence as well as RPC.
      // A late RPC/hook completion must never turn an already closed run into
      // a successful result or dispatch queued artifacts after shutdown.
      const operation = (async (): Promise<EnginePromptResult> => {
        const response = await this.connection.agent.request(methods.agent.session.prompt, {
          sessionId: this.sessionId, prompt: [{ type: 'text', text: input }],
        });
        await deadline(this.eventTail, 5_000, new EngineError('EVENT_FAILURE', 'Engine events did not settle before the prompt deadline.'));
        this.assertActive(signal);
        const artifacts: EngineArtifact[] = [];
        if (response.stopReason === 'end_turn' && this.text.length > 0) {
          const artifact: EngineArtifact = { kind: 'markdown', title: 'Agent response', content: this.text };
          artifacts.push(artifact);
          await this.emit({ type: 'artifact', ...artifact });
          this.assertActive(signal);
        }
        await this.emit({ type: 'completed', stopReason: response.stopReason });
        this.assertActive(signal);
        return { stopReason: response.stopReason, text: this.text, artifacts };
      })();
      return await Promise.race([operation, interrupted, timedOut]);
    } catch (error) {
      await this.close();
      throw safeEngineError(error);
    } finally {
      this.promptDeadline?.stop();
      this.promptDeadline = undefined;
      this.busy = false;
      this.rejectActive = undefined;
      signal?.removeEventListener('abort', abort);
    }
  }

  async resolvePermission(requestId: string, optionId: string): Promise<void> {
    const pending = this.permissions.get(requestId);
    if (!pending || this.stopped) throw new EngineError('PERMISSION_UNKNOWN', 'Permission request is no longer active.');
    if (!pending.request.options.some((option) => option.optionId === optionId)) {
      throw new EngineError('PERMISSION_OPTION', 'Permission option is not available for this request.');
    }
    this.permissions.delete(requestId);
    this.updatePromptDeadline();
    pending.resolve({ outcome: { outcome: 'selected', optionId } });
  }

  private dismissPermissions(): void {
    // Cancellation/closure never resumes a budget when clearing the final item.
    this.promptDeadline?.stop();
    for (const pending of this.permissions.values()) pending.resolve({ outcome: { outcome: 'cancelled' } });
    this.permissions.clear();
  }

  cancel(): Promise<void> {
    this.cancelPromise ??= (async () => {
      if (this.stopped) return this.close();
      this.dismissPermissions();
      this.rejectActive?.(new EngineError('ABORTED', 'Engine prompt was cancelled.'));
      try {
        await deadline(this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId }),
          this.config.cancelGraceMs ?? 200, new EngineError('ABORTED', 'Engine cancellation deadline reached.'));
      } catch { /* hard cleanup remains mandatory */ }
      await this.close();
    })();
    return this.cancelPromise;
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.stopped = true;
      this.dismissPermissions();
      this.rejectActive?.(new EngineError('ABORTED', 'Engine session was closed.'));
      this.connection.close(new EngineError('SESSION_CLOSED', 'Engine session is closed.'));
      try { await this.ownedProcess.close(); }
      finally {
        this.process.stdin.destroy();
        this.process.stdout.destroy();
        this.process.stderr.destroy();
      }
      await deadline(this.eventTail, 500, new EngineError('EVENT_FAILURE', 'Engine events did not settle before cleanup completed.'));
    })();
    return this.closePromise;
  }
}

export function createAcpEngineAdapter(config: EngineConfig): EngineAdapter {
  return {
    async open(context, hooks) {
      if (context.signal?.aborted) throw new EngineError('ABORTED', 'Engine startup was cancelled.');
      const session = new AcpEngineSession({ ...config, cwd: context.cwd }, hooks);
      await session.initialize(context);
      return session;
    },
    async probe(overrides = {}) {
      const probeConfig = { ...config, ...overrides };
      const result: EngineProbeResult = { protocolReady: false, sessionReady: false, planModeSupported: false, authenticatedPrompt: 'not_checked' };
      const session = new AcpEngineSession(probeConfig, { onEvent: () => {} });
      try {
        await session.initialize({ taskId: 'probe', attemptId: 'probe', runId: randomUUID(), cwd: probeConfig.cwd ?? process.cwd(), mode: 'plan' });
        result.sessionReady = true;
        result.planModeSupported = session.availableModes.includes('plan');
      } catch (error) {
        const safe = safeEngineError(error);
        result.error = { code: safe.code, message: safe.message };
      } finally {
        result.protocolReady = session.protocolReady;
        try { await session.close(); } catch (error) {
          const safe = safeEngineError(error);
          result.error = { code: safe.code, message: safe.message };
        }
      }
      return result;
    },
  };
}
