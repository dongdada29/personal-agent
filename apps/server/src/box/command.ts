/**
 * 宿主适配层的命令执行器。
 *
 * - 一律 shell:false + 参数数组，不拼接 shell 字符串；
 * - 有超时与输出上限，输出只用于解析，不写日志、不回传给浏览器；
 * - 可注入（测试里用假的 runner 回放 colima / docker / wsl 的输出）。
 */
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export interface CommandResult {
  /** 进程退出码；超时或无法启动时为 null。 */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 可执行文件不存在（ENOENT）。适配器据此判断“未安装”。 */
  notFound?: boolean;
  timedOut?: boolean;
}

export interface CommandOptions {
  timeoutMs?: number;
  /** wsl.exe 默认输出 UTF-16LE；auto 会自动识别。 */
  encoding?: 'utf8' | 'auto';
  maxBytes?: number;
  /**
   * 写入子进程 stdin 后关闭。用于把桌面令牌交给 `docker exec -i pa-box-ctl`：
   * 令牌绝不放进 argv（容器 / VM 内其他进程能看到命令行）。
   */
  input?: string;
}

export type CommandRunner = (file: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

/** macOS 上 launchd / Electron 启动的进程通常没有 Homebrew 目录，补上常见位置。 */
export function augmentedPath(platform: NodeJS.Platform = process.platform, current = process.env.PATH ?? ''): string {
  const extra = platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
    : platform === 'linux' ? ['/usr/local/bin', '/usr/bin', '/bin'] : [];
  const parts = current.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of extra) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(platform === 'win32' ? ';' : ':');
}

/**
 * 按 PATH（Windows 还按 PATHEXT）解析出可执行文件的绝对路径。
 * 找不到时返回 undefined，调用方据此报告“未安装”，而不是交给 shell 猜。
 */
export function findExecutable(name: string, options: { platform?: NodeJS.Platform; path?: string; pathext?: string;
  exists?: (path: string) => boolean } = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? ((path: string) => {
    try { accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK); return true; } catch { return false; }
  });
  const sep = platform === 'win32' ? ';' : delimiter;
  const join_ = platform === 'win32' ? (dir: string, file: string) => `${dir.replace(/[\\/]+$/, '')}\\${file}` : join;
  const absolute = platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(name) || name.startsWith('\\\\') : isAbsolute(name);
  const extensions = platform === 'win32'
    ? (/\.[A-Za-z0-9]+$/.test(name) ? [''] : (options.pathext ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean))
    : [''];
  if (absolute) {
    for (const ext of extensions) if (exists(name + ext)) return name + ext;
    return undefined;
  }
  if (/[\\/]/.test(name)) return undefined;
  const dirs = (options.path ?? augmentedPath(platform)).split(sep).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join_(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** UTF-16LE（wsl.exe 的默认输出）识别：大量奇数位为 0。 */
export function decodeCommandOutput(buffer: Buffer, encoding: 'utf8' | 'auto' = 'utf8'): string {
  if (encoding === 'auto' && buffer.length >= 2) {
    const bomLE = buffer[0] === 0xff && buffer[1] === 0xfe;
    let zeros = 0;
    for (let index = 1; index < Math.min(buffer.length, 512); index += 2) if (buffer[index] === 0) zeros++;
    if (bomLE || zeros > Math.min(buffer.length, 512) / 4) return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return buffer.toString('utf8');
}

/** 宿主命令的环境：去掉会改变 docker 目标或 Node 加载行为的变量。 */
export function commandEnvironment(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, PATH: augmentedPath(platform, env.PATH ?? env.Path ?? '') };
  // DOCKER_HOST / DOCKER_CONTEXT 会覆盖或冲突于显式的 --context，必须移除，
  // 保证适配器永远只操作自己的 colima-pa-box 上下文，不碰默认上下文。
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete next[key];
  // 不让任何 bash / sh 读取用户的启动配置（L0：用户 zsh 里 docker 等命令被 alias 成不存在的程序）。
  // 适配器从不经 shell 执行；这里再兜底清掉非交互 bash / sh 会读取的 BASH_ENV / ENV。
  for (const key of ['BASH_ENV', 'ENV']) delete next[key];
  // 新版 WSL 支持直接输出 UTF-8。
  if (platform === 'win32') next.WSL_UTF8 = '1';
  return next;
}

export const defaultCommandRunner: CommandRunner = (file, args, options = {}) => new Promise(resolve => {
  const resolved = findExecutable(file);
  if (!resolved) { resolve({ code: null, stdout: '', stderr: '', notFound: true }); return; }
  const child = execFile(resolved, args, {
    encoding: 'buffer', shell: false, windowsHide: true, timeout: options.timeoutMs ?? 15_000,
    maxBuffer: options.maxBytes ?? 1024 * 1024, env: commandEnvironment(),
  }, (error, stdout, stderr) => {
    const out = decodeCommandOutput(stdout as Buffer, options.encoding);
    const err = decodeCommandOutput(stderr as Buffer, options.encoding);
    if (!error) { resolve({ code: 0, stdout: out, stderr: err }); return; }
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: string | number };
    if (failure.code === 'ENOENT') { resolve({ code: null, stdout: '', stderr: '', notFound: true }); return; }
    resolve({ code: typeof failure.code === 'number' ? failure.code : null, stdout: out, stderr: err,
      ...(failure.killed || failure.signal ? { timedOut: true } : {}) });
  });
  // 子进程提前退出时写 stdin 会 EPIPE；结果以退出码为准，这里忽略。
  child.stdin?.on('error', () => undefined);
  if (options.input !== undefined) child.stdin?.end(options.input);
  else child.stdin?.end();
});
