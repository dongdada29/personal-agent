import { isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { VerificationCommand } from '@personal-agent/contracts';
import { spawnOwnedProcess, type ProcessContext, type ProcessLifecycleHooks } from './process-registry.js';
import { EngineError } from './engine.js';
import { resolveWindowsCommand } from './process-windows.js';

export interface VerificationExecution {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}
export interface RunVerificationOptions {
  worktreePath: string;
  command: VerificationCommand;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  context?: ProcessContext;
  hooks?: ProcessLifecycleHooks;
}

export class VerificationError extends Error {
  constructor(readonly code: 'VERIFICATION_INVALID' | 'CLEANUP_FAILED', message: string) {
    super(message);
    this.name = 'VerificationError';
  }
}

/** Preserve normal tool environment but withhold inherited credentials and executable startup overrides. */
export function verificationEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH|COOKIE|SESSION|PRIVATE_?KEY|^(ANTHROPIC_|OPENAI_|AWS_|AZURE_|GOOGLE_|GITHUB_|GH_|GIT_|NPM_CONFIG_|LD_|DYLD_)|^(NODE_OPTIONS|BASH_ENV|ENV|PYTHONSTARTUP|DATABASE_URL|REDIS_URL|MONGODB_URI|MONGO_URL)$/i.test(key)) delete env[key];
  }
  return env;
}

class CapturedOutput {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;
  constructor(private limit: number, private label: string) {}
  add(chunk: Buffer | string): void {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.limit - this.bytes;
    if (value.length > remaining) this.truncated = true;
    if (remaining > 0) {
      const kept = value.subarray(0, remaining);
      this.chunks.push(kept);
      this.bytes += kept.length;
    }
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8') + (this.truncated ? `\n[${this.label} truncated after ${this.limit} bytes]\n` : '');
  }
}

/** Selected commands execute once with shell:false. Failure and cancellation remain actual process evidence. */
export async function runVerification(options: RunVerificationOptions): Promise<VerificationExecution> {
  const { command, args } = options.command;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  if (typeof command !== 'string' || !command.trim() || command.includes('\0') || command.length > 4096 ||
    !Array.isArray(args) || args.length > 128 || args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > 32_768) ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000 ||
    !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 4 * 1024 * 1024 ||
    typeof options.worktreePath !== 'string' || !isAbsolute(options.worktreePath) || options.worktreePath.includes('\0')) {
    throw new VerificationError('VERIFICATION_INVALID', 'Verification requires an executable, an argument array, a worktree path and bounded limits.');
  }
  let cwd: string;
  try { cwd = await realpath(options.worktreePath); }
  catch { throw new VerificationError('VERIFICATION_INVALID', 'The verification working directory is unavailable.'); }
  const started = Date.now();
  const stdout = new CapturedOutput(maxOutputBytes, 'stdout');
  const stderr = new CapturedOutput(maxOutputBytes, 'stderr');
  let timedOut = false;
  let cancelled = options.signal?.aborted ?? false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const env = verificationEnvironment();
  let executable = { command, args: [...args] };
  if (process.platform === 'win32' && !cancelled) {
    // shell:false 找不到 npm（实际是 npm.cmd）；解析为可直接执行的 .exe 或 node + npm-cli.js。
    const resolved = resolveWindowsCommand(command, [...args], env);
    if (!resolved) {
      const finished = Date.now();
      const missingPath = isAbsolute(command) || /[\\/]/u.test(command);
      return { command, args: [...args], exitCode: null, signal: null, stdout: '',
        stderr: missingPath
          ? 'Verification command could not be started (ENOENT).\n'
          : 'Verification command could not be started (ENOENT: not found on PATH, or a .cmd/.bat other than npm/npx).\n',
        stdoutTruncated: false, stderrTruncated: false, timedOut: false, cancelled: false,
        startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(), durationMs: finished - started };
    }
    executable = resolved;
  }
  if (!cancelled) {
    const owner = spawnOwnedProcess({ command: executable.command, args: executable.args, cwd, env, kind: 'verification', context: options.context });
    const child = owner.process;
    child.stdin.end(); // Verification children receive EOF, as with stdin:'ignore'.
    child.stdout.on('data', (chunk: Buffer) => stdout.add(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.add(chunk));
    let ended = false;
    let cleanup: Promise<void> | undefined;
    let resolveStop!: () => void;
    const stopRequested = new Promise<void>((done) => { resolveStop = done; });
    const stopped = (reason: 'timeout' | 'cancel') => {
      if (ended || cleanup) return;
      timedOut = reason === 'timeout';
      cancelled = reason === 'cancel';
      cleanup = owner.close();
      // Mark as handled immediately; the awaited race below still observes rejection.
      void cleanup.catch(() => {});
      resolveStop();
    };
    const onAbort = () => stopped('cancel');
    let timer: ReturnType<typeof setTimeout> | undefined;
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const exited = owner.exit.then((result) => {
      ended = true;
      exitCode = result.exitCode;
      exitSignal = result.signal;
      if (result.spawnError) stderr.add(`Verification command could not be started (${result.spawnError}).\n`);
      clearTimeout(timer);
    });
    const closed = new Promise<void>((done) => { child.once('close', () => done()); });
    try {
      if (options.signal?.aborted) onAbort();
      await Promise.race([owner.start(options.hooks, options.signal), stopRequested.then(() => {
        throw new EngineError('ABORTED', 'Verification startup was cancelled.');
      })]);
      timer = setTimeout(() => stopped('timeout'), timeoutMs);
      await Promise.race([exited, stopRequested]);
      await (cleanup ?? owner.close());
      await exited;
      // Cleanup must release inherited stdout/stderr descriptors as well as the parent.
      const streamsClosed = await new Promise<boolean>((done) => {
        const deadline = setTimeout(() => done(false), 200);
        void closed.then(() => { clearTimeout(deadline); done(true); });
      });
      if (!streamsClosed) throw new Error('streams remain open');
    } catch (error) {
      try { await (cleanup ?? owner.close()); }
      catch { throw new VerificationError('CLEANUP_FAILED', 'Verification process tree cleanup could not be confirmed; scheduling must stop for inspection.'); }
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EVENT_FAILURE') throw error;
      if (options.signal?.aborted) { cancelled = true; exitCode = null; }
      else throw new VerificationError('CLEANUP_FAILED', 'Verification process tree cleanup could not be confirmed; scheduling must stop for inspection.');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  const finished = Date.now();
  return { command, args: [...args], exitCode, signal: exitSignal, stdout: stdout.text(), stderr: stderr.text(),
    stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated, timedOut, cancelled,
    startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(), durationMs: finished - started };
}
