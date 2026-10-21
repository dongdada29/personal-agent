import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { startDesktopServer, type DesktopServer } from './desktop.js';

/**
 * Electron 托管模式的子进程入口：由主进程以 child_process.fork（ELECTRON_RUN_AS_NODE=1）启动。
 *
 * IPC 协议（全部经 Node IPC 通道，不经 argv / env / 标准输出）：
 *   主进程 → 子进程  { type: 'start', token, dataDir? }   只接受一次
 *   子进程 → 主进程  { type: 'ready', port }              监听 127.0.0.1:<随机端口> 成功
 *   子进程 → 主进程  { type: 'error', code }              启动失败（只含错误码，不含令牌或路径）
 *   主进程 → 子进程  { type: 'shutdown' }                 优雅关闭，完成后发送 { type: 'stopped' } 并退出
 * IPC 断开（主进程崩溃）同样触发优雅关闭。
 */
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
type Inbound = { type: 'start'; token: string; dataDir?: string } | { type: 'shutdown' };

if (typeof process.send !== 'function') {
  console.error('[DESKTOP_IPC_REQUIRED] desktop-main must be started by the Electron client over IPC.');
  process.exit(64);
}

const send = (message: Record<string, unknown>) => new Promise<void>(done => {
  if (!process.connected) { done(); return; }
  process.send!(message, undefined, {}, () => done());
});
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'STARTUP_FAILED';

let server: DesktopServer | undefined;
let starting: Promise<void> | undefined;
let stopping: Promise<void> | undefined;

function shutdown(exitCode = 0): Promise<void> {
  stopping ??= (async () => {
    try { await starting?.catch(() => {}); await server?.close(); }
    catch { exitCode = 1; console.error('[SHUTDOWN_CLEANUP_FAILED] Service cleanup needs inspection; preserve the data directory and locks.'); }
    await send({ type: 'stopped', exitCode });
    process.exitCode = exitCode;
    // 关闭后不再有任何句柄需要等待；显式断开 IPC 让进程自然退出。
    if (process.connected) process.disconnect();
  })();
  return stopping;
}

process.on('message', (raw: unknown) => {
  const message = raw as Partial<Inbound> | null;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'shutdown') { void shutdown(0); return; }
  if (message.type !== 'start' || starting) return;
  const { token, dataDir } = message as { token?: unknown; dataDir?: unknown };
  if (typeof token !== 'string' || !TOKEN.test(token) || (dataDir !== undefined && (typeof dataDir !== 'string' || !dataDir || dataDir.includes('\0')))) {
    void send({ type: 'error', code: 'DESKTOP_CONFIG_INVALID' }).then(() => shutdown(1));
    return;
  }
  starting = (async () => {
    try {
      // 数据目录必须由 Electron 主进程传入（默认 userData）。这里不再回落到 ~/.personal-agent，以免与 CLI 实例撞锁。
      server = await startDesktopServer({ token, dataDir: resolve(dataDir ?? process.env.PERSONAL_AGENT_DATA_DIR ?? `${homedir()}/.personal-agent-desktop`) });
      await send({ type: 'ready', port: server.port });
    } catch (error) {
      await send({ type: 'error', code: errorCode(error) });
      await shutdown(1);
    }
  })();
});
process.on('disconnect', () => { void shutdown(process.exitCode === undefined ? 0 : Number(process.exitCode)); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown(0); });
