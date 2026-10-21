import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

/**
 * 托管模式：用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE=1）fork 打包后的 server，
 * 经 IPC 下发本次启动的随机令牌，等待 { type:'ready', port }。
 *
 * - 令牌只经 IPC 传输：不进 argv、不进环境变量、不写日志；
 * - 子进程只监听 127.0.0.1 随机端口（由 server 侧断言），这里再校验端口范围；
 * - stop()：先发 shutdown 让 server 关闭任务进程与数据库，超时后才强制结束；
 * - 子进程的 stdout/stderr 只保留最近若干行用于诊断（server 本身从不输出令牌）。
 */
export type ServerState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface SupervisorOptions {
  /** 打包后的 desktop-main.mjs（或开发时由 tsx 加载的 .ts）。 */
  entry: string;
  dataDir: string;
  execPath?: string;
  execArgv?: string[];
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** 注入用于测试。 */
  forkImpl?: typeof fork;
  baseEnv?: NodeJS.ProcessEnv;
}

export class ServerStartError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ServerStartError'; }
}

export const newLaunchToken = () => randomBytes(32).toString('base64url');

/** 子进程环境：继承用户环境（引擎需要 PATH/HOME 等），但去掉会改变 Node 启动行为的变量。 */
export function serverEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (/^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE|ELECTRON_NO_ASAR|NODE_CHANNEL_FD|NODE_UNIQUE_ID)$/iu.test(key)) continue;
    if (/^PERSONAL_AGENT_DEMO_/iu.test(key)) continue;
    env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

export class ServerSupervisor extends EventEmitter {
  state: ServerState = 'idle';
  port: number | undefined;
  readonly token = newLaunchToken();
  private child: ChildProcess | undefined;
  private recent: string[] = [];
  private exited: Promise<number | null> | undefined;

  constructor(private readonly options: SupervisorOptions) { super(); }

  /** 最近的子进程输出（诊断用）。 */
  diagnostics(): string[] { return [...this.recent]; }

  start(): Promise<number> {
    if (this.state !== 'idle') return Promise.reject(new ServerStartError('DESKTOP_SUPERVISOR_STATE', 'Server was already started'));
    this.state = 'starting';
    const forkImpl = this.options.forkImpl ?? fork;
    // Windows ESM loader 拒绝 `D:\...` 作为模块路径，必须是 file:// URL。
    const entry = process.platform === 'win32' && !/^[a-z][a-z0-9+.-]*:/iu.test(this.options.entry)
      ? pathToFileURL(this.options.entry).href : this.options.entry;
    const child = forkImpl(entry, [], {
      execPath: this.options.execPath ?? process.execPath,
      execArgv: this.options.execArgv ?? [],
      env: serverEnvironment(this.options.baseEnv ?? process.env),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    });
    this.child = child;
    const remember = (chunk: Buffer | string) => {
      for (const line of String(chunk).split(/\r?\n/u)) if (line.trim()) this.recent.push(line.slice(0, 500));
      if (this.recent.length > 50) this.recent.splice(0, this.recent.length - 50);
    };
    child.stdout?.on('data', remember);
    child.stderr?.on('data', remember);
    this.exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    void this.exited.then(code => {
      const unexpected = this.state === 'running' || this.state === 'starting';
      this.state = unexpected ? 'failed' : 'stopped';
      this.port = undefined;
      if (unexpected) this.emit('unexpected-exit', code);
    });
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => fail('DESKTOP_SERVER_TIMEOUT', 'The local service did not start in time'), this.options.startTimeoutMs ?? 60_000);
      const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); };
      const fail = (code: string, message: string) => {
        cleanup();
        this.state = 'failed';
        if (child.exitCode === null && child.signalCode === null) child.kill();
        reject(new ServerStartError(code, message));
      };
      const onMessage = (raw: unknown) => {
        const message = raw as { type?: unknown; port?: unknown; code?: unknown } | null;
        if (!message || typeof message !== 'object') return;
        if (message.type === 'ready') {
          if (!Number.isSafeInteger(message.port) || (message.port as number) < 1 || (message.port as number) > 65_535) {
            fail('DESKTOP_SERVER_PROTOCOL', 'The local service reported an invalid port'); return;
          }
          cleanup();
          this.state = 'running';
          this.port = message.port as number;
          resolve(this.port);
        } else if (message.type === 'error') {
          const code = typeof message.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(message.code) ? message.code : 'STARTUP_FAILED';
          fail(code, 'The local service could not start');
        }
      };
      const onExit = (code: number | null) => fail('DESKTOP_SERVER_EXITED', `The local service exited during startup (code ${code})`);
      const onError = () => fail('DESKTOP_SERVER_SPAWN', 'The local service could not be launched');
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.once('error', onError);
      child.send({ type: 'start', token: this.token, dataDir: this.options.dataDir }, error => {
        if (error) fail('DESKTOP_SERVER_IPC', 'The local service IPC channel failed');
      });
    });
  }

  /** 优雅关闭；超时后强制结束。可重复调用。 */
  async stop(): Promise<'clean' | 'killed' | 'not-running'> {
    const child = this.child;
    if (!child || !this.exited || child.exitCode !== null || child.signalCode !== null) { this.state = 'stopped'; return 'not-running'; }
    this.state = 'stopping';
    if (child.connected) child.send({ type: 'shutdown' }, () => {});
    const timeout = new Promise<'timeout'>(resolve => { const timer = setTimeout(() => resolve('timeout'), this.options.stopTimeoutMs ?? 15_000); timer.unref?.(); });
    const outcome = await Promise.race([this.exited.then(() => 'exited' as const), timeout]);
    if (outcome === 'exited') return 'clean';
    // 强制结束：任务子进程是独立的 owner，下次启动时由 recoverOwnedProcesses 核实身份后清理。
    child.kill('SIGKILL');
    await this.exited;
    return 'killed';
  }
}
