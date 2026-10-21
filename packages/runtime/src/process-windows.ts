import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Windows 进程归属工具。
 *
 * Windows 没有 POSIX 进程组，PID 也会被很快复用，所以这里的归属判断始终同时比对三件事：
 *   1. PID；
 *   2. 进程创建时间（WMI Win32_Process.CreationDate，精确到 100ns，PID 复用后必然不同）；
 *   3. 完整命令行（按 CommandLineToArgvW 规则解析后逐项比对）。
 * 子孙进程通过 ParentProcessId 追踪：Windows 中父进程退出后孤儿进程仍保留原 ParentProcessId，
 * 因此只要再要求“子进程创建时间不早于父进程”，就能排除“父 PID 被复用后挂上来的无关进程”。
 */

export interface WindowsProcessRow {
  pid: number;
  ppid: number;
  /** ISO 8601 UTC（PowerShell 'o' 格式，7 位小数）；系统进程可能为 null。 */
  created: string | null;
  commandLine: string | null;
  /** Win32_Process.ExecutablePath；CommandLine 为空时用来确认仍是同一份 node/electron。 */
  executablePath?: string | null;
}

export interface WindowsProcessIdentity { pid: number; created: string }

export type WindowsQuery = (pids?: number[]) => Promise<WindowsProcessRow[]>;

/** 系统自带的 Windows PowerShell 5.1；固定绝对路径，避免 PATH 中同名程序被优先执行。 */
export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** 生成查询脚本；pids 只会是正整数（调用方校验），不会拼入任何外部字符串。 */
export function windowsProcessQueryScript(pids?: number[]): string {
  const filter = pids && pids.length ? ` -Filter "${pids.map(pid => `ProcessId=${pid}`).join(' OR ')}"` : '';
  // 按 PID 查身份时必须拉完整实例：Windows PowerShell 5.1 的 Get-CimInstance -Property
  // 会让 Win32_Process.CommandLine 变成空，归属判定就会误判失败。
  // 全表扫描只用于结束进程树（只需 PID / PPID / 创建时间），用 -Property 减负。
  const properties = pids?.length ? '' : ' -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 15';
  return [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    `$rows=@(Get-CimInstance -ClassName Win32_Process${filter}${properties} | ForEach-Object {`,
    '  [pscustomobject]@{ p=[int64]$_.ProcessId; pp=[int64]$_.ParentProcessId;',
    "    c=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null });",
    '    l=$_.CommandLine; e=$_.ExecutablePath } })',
    // -InputObject 保证即使只有 0/1 行也输出 JSON 数组。
    '[Console]::Out.Write((ConvertTo-Json -Compress -Depth 2 -InputObject $rows))',
  ].join('\n');
}

/** 解析查询脚本的输出；任何结构异常都返回 undefined（调用方必须按“无法确认”处理）。 */
export function parseWindowsProcessTable(stdout: string): WindowsProcessRow[] | undefined {
  let value: unknown;
  try { value = JSON.parse(stdout.trim() || '[]'); } catch { return undefined; }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) value = [value];
  if (!Array.isArray(value)) return undefined;
  const rows: WindowsProcessRow[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined;
    const { p, pp, c, l, e } = item as Record<string, unknown>;
    if (!Number.isSafeInteger(p) || (p as number) < 0 || !Number.isSafeInteger(pp) || (pp as number) < 0) return undefined;
    if (c !== null && c !== undefined && (typeof c !== 'string' || Number.isNaN(Date.parse(c)))) return undefined;
    if (l !== null && l !== undefined && typeof l !== 'string') return undefined;
    if (e !== null && e !== undefined && typeof e !== 'string') return undefined;
    rows.push({ pid: p as number, ppid: pp as number, created: (c as string | null | undefined) ?? null,
      commandLine: (l as string | null | undefined) ?? null, executablePath: (e as string | null | undefined) ?? null });
  }
  return rows;
}

/** CIM/WMI 需要一套系统环境；不能只留 SystemRoot+PATH，否则 GitHub-hosted 上查询会挂死或空结果。 */
export function windowsQueryEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keys = ['SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC',
    'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME', 'USERDOMAIN',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_REVISION',
    'PSModulePath', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'PUBLIC', 'HOMEDRIVE', 'HOMEPATH'];
  const out: NodeJS.ProcessEnv = {};
  for (const key of keys) if (typeof env[key] === 'string' && env[key]) out[key] = env[key];
  out.SystemRoot ??= env.SYSTEMROOT ?? 'C:\\Windows';
  out.PATH ??= env.Path ?? '';
  return out;
}

/** 通过 PowerShell + CIM 读取进程表；失败或超时抛错（调用方 fail closed）。 */
export const queryWindowsProcesses: WindowsQuery = (pids) => new Promise((resolve, reject) => {
  if (pids?.some(pid => !Number.isSafeInteger(pid) || pid < 1)) { reject(new Error('invalid pid')); return; }
  execFile(windowsPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsProcessQueryScript(pids)],
    { encoding: 'utf8', timeout: pids?.length ? 15_000 : 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: windowsQueryEnv() }, (error, stdout) => {
      if (error) { reject(error); return; }
      const rows = parseWindowsProcessTable(stdout);
      if (!rows) reject(new Error('unparseable process table')); else resolve(rows);
    });
});

/**
 * 按 CommandLineToArgvW 规则拆分命令行（与 libuv 生成命令行的引用规则互逆）：
 * - argv[0] 特殊：以引号开头则取到下一个引号，不处理反斜杠；
 * - 其后：2n 个反斜杠 + 引号 => n 个反斜杠并切换引号状态；2n+1 个 => n 个反斜杠 + 字面引号；
 *   引号内连续两个引号 => 字面引号；不在引号前的反斜杠按字面保留。
 */
export function windowsCommandLineToArgv(commandLine: string): string[] {
  const argv: string[] = [];
  let index = 0;
  const length = commandLine.length;
  const space = (char: string | undefined) => char === ' ' || char === '\t';
  while (index < length && space(commandLine[index])) index++;
  if (index >= length) return argv;
  let program = '';
  if (commandLine[index] === '"') {
    index++;
    while (index < length && commandLine[index] !== '"') program += commandLine[index++];
    if (index < length) index++;
  } else {
    while (index < length && !space(commandLine[index])) program += commandLine[index++];
  }
  argv.push(program);
  while (true) {
    while (index < length && space(commandLine[index])) index++;
    if (index >= length) break;
    let current = '';
    let quoted = false;
    while (index < length && (quoted || !space(commandLine[index]))) {
      const char = commandLine[index];
      if (char === '\\') {
        let slashes = 0;
        while (commandLine[index] === '\\') { slashes++; index++; }
        if (commandLine[index] === '"') {
          current += '\\'.repeat(Math.floor(slashes / 2));
          if (slashes % 2 === 1) { current += '"'; index++; }
        } else current += '\\'.repeat(slashes);
        continue;
      }
      if (char === '"') {
        if (quoted && commandLine[index + 1] === '"') { current += '"'; index += 2; continue; }
        quoted = !quoted; index++; continue;
      }
      current += char; index++;
    }
    argv.push(current);
  }
  return argv;
}

/** 与 libuv quote_cmd_arg 相同的引用规则；用于测试往返与 cmd.exe 之外的命令行拼接。 */
export function quoteWindowsArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"]/u.test(arg)) return arg;
  let result = '"';
  let slashes = 0;
  for (const char of arg) {
    if (char === '\\') { slashes++; continue; }
    if (char === '"') { result += '\\'.repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    result += '\\'.repeat(slashes) + char; slashes = 0;
  }
  return result + '\\'.repeat(slashes * 2) + '"';
}

/** Windows 路径不区分大小写；同时统一分隔符与 \\?\ 前缀。 */
export function sameWindowsPath(a: string, b: string): boolean {
  const normalize = (value: string) => win32.normalize(value.replace(/^\\\\\?\\/u, '')).toLowerCase();
  return normalize(a) === normalize(b);
}

/**
 * Node 的 ESM loader 把 `D:\file.ts` 当成协议 `d:`。
 * `--import`、fork 入口、以及 `node file.mjs` 在 Windows 上必须用 file://。
 * POSIX 保持原路径：tsx 对已经是 file:// 的 specifier 会再加一层前缀。
 * 盘符转换不依赖当前 OS，这样在 Linux CI 上也能测 Windows 行为。
 */
export function nodeEsmSpecifier(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || path.startsWith('file:')) return path;
  const slash = path.replace(/\\/g, '/');
  const drive = /^([A-Za-z]:)(\/.*)?$/u.exec(slash);
  if (drive) return `file:///${drive[1]}${(drive[2] ?? '').split('/').map(encodeURIComponent).join('/')}`;
  return process.platform === 'win32' ? pathToFileURL(path).href : `file://${slash}`;
}

/** 当前命令行是否正是我们启动的 owner（execPath + wrapper + 唯一标记，无多余参数）。 */
export function windowsOwnerCommandMatches(commandLine: string | null, execPath: string, wrapperPath: string, id: string): boolean {
  if (!commandLine) return false;
  const argv = windowsCommandLineToArgv(commandLine);
  return argv.length === 3 && sameWindowsPath(argv[0], execPath) && sameWindowsPath(argv[1], wrapperPath) &&
    argv[2] === `--personal-agent-owner=${id}`;
}

/**
 * 启动时与恢复时共用的归属判定：
 * - 能读到 CommandLine 时必须精确匹配 wrapper 与 owner id；
 * - GitHub-hosted Windows 等环境经常读不到 CommandLine，此时退化为
 *   PID + 100ns CreationDate + ExecutablePath（同一份 node/electron）。
 */
export function windowsOwnerIdentityMatches(row: WindowsProcessRow, execPath: string, wrapperPath: string, id: string): boolean {
  if (windowsOwnerCommandMatches(row.commandLine, execPath, wrapperPath, id)) return true;
  return !row.commandLine && typeof row.executablePath === 'string' && sameWindowsPath(row.executablePath, execPath);
}

const createdAtOrAfter = (child: string | null, parent: string) => child !== null && Date.parse(child) >= Date.parse(parent);

/**
 * 计算 roots 的全部子孙。孤儿保留原 ParentProcessId，所以父进程已退出也能找到；
 * 创建时间早于父进程的“子进程”说明父 PID 被复用过，忽略之。
 */
export function windowsDescendants(rows: WindowsProcessRow[], roots: WindowsProcessIdentity[]): WindowsProcessIdentity[] {
  const result: WindowsProcessIdentity[] = [];
  const seen = new Set(roots.map(root => root.pid));
  const queue = [...roots];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const row of rows) {
      if (row.ppid !== parent.pid || seen.has(row.pid) || row.pid === 0 || !createdAtOrAfter(row.created, parent.created)) continue;
      seen.add(row.pid);
      const identity = { pid: row.pid, created: row.created! };
      result.push(identity);
      queue.push(identity);
    }
  }
  return result;
}

/** 某个身份（PID + 创建时间）是否仍存在；查询失败视为“仍存在”（fail closed）。 */
export function windowsIdentityAlive(rows: WindowsProcessRow[], identity: WindowsProcessIdentity): boolean {
  return rows.some(row => row.pid === identity.pid && row.created === identity.created);
}

export type TaskkillRunner = (pid: number) => Promise<boolean>;

/** taskkill /T /F：按父子关系结束整棵树。只对已核实身份的 PID 调用。 */
export const taskkillTree: TaskkillRunner = (pid) => new Promise(resolve => {
  if (!Number.isSafeInteger(pid) || pid < 1) { resolve(false); return; }
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const killer = spawn(win32.join(root, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const timer = setTimeout(() => { killer.kill(); resolve(false); }, 5_000);
  killer.once('error', () => { clearTimeout(timer); resolve(false); });
  // 128 = 进程不存在（已退出），对“结束”而言等同成功；最终仍由调用方复查进程表。
  killer.once('exit', code => { clearTimeout(timer); resolve(code === 0 || code === 128); });
});

/**
 * 结束一组已核实身份的进程（含子孙），然后在 deadline 内复查直到全部消失。
 * 每次 taskkill 前都重新核对创建时间，避免 PID 复用后误杀。
 */
export async function terminateWindowsIdentities(identities: WindowsProcessIdentity[], options: {
  query?: WindowsQuery; kill?: TaskkillRunner; verifyMs?: number;
} = {}): Promise<boolean> {
  const query = options.query ?? queryWindowsProcesses, kill = options.kill ?? taskkillTree;
  const verifyMs = options.verifyMs ?? 3_000;
  if (!identities.length) return true;
  const before = await query();
  const all = [...identities, ...windowsDescendants(before, identities)];
  for (const identity of all) {
    if (windowsIdentityAlive(before, identity)) await kill(identity.pid);
  }
  const deadline = Date.now() + verifyMs;
  while (true) {
    const rows = await query();
    if (!all.some(identity => windowsIdentityAlive(rows, identity))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(done => setTimeout(done, 100));
  }
}

/**
 * shell:false 下把 `npm`、`npx` 等命令解析为可直接执行的形式：
 * - 先按 PATH × PATHEXT 找到实际文件；
 * - `.exe/.com` 直接执行；
 * - npm/npx 的 `.cmd` 包装改为 `node <npm-cli.js>`，完全绕开 cmd.exe；
 * - 其它 `.cmd/.bat` 一律拒绝：Node 20.12+ 不允许 shell:false 直接执行批处理（CVE-2024-27980），
 *   经 cmd.exe 转发又需要逐参数转义 cmd 元字符（BatBadBut），见 docs/windows-gaps.md。
 * 返回 undefined 表示无法安全解析（调用方给出“命令不可用”）。
 */
export function resolveWindowsCommand(command: string, args: string[], env: NodeJS.ProcessEnv, options: {
  exists?: (path: string) => boolean; execPath?: string;
} = {}): { command: string; args: string[] } | undefined {
  const exists = options.exists ?? existsSync;
  const pathext = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(ext => ext.toLowerCase());
  const candidates: string[] = [];
  const extname = win32.extname;
  const withExt = (base: string) => extname(base) ? [base, ...pathext.map(ext => base + ext)] : pathext.map(ext => base + ext);
  if (win32.isAbsolute(command) || /[\\/]/u.test(command)) candidates.push(...withExt(command));
  else {
    // Windows 环境变量名不区分大小写，Node 在 win32 上也会把 Path 归一为 PATH；这里两者都兼容。
    const dirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
    for (const dir of dirs) candidates.push(...withExt(win32.join(dir, command)));
  }
  const found = candidates.find(candidate => pathext.includes(extname(candidate).toLowerCase()) && exists(candidate));
  if (!found) return undefined;
  const ext = extname(found).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { command: found, args };
  if (ext !== '.cmd' && ext !== '.bat') return undefined;
  const base = win32.basename(found, extname(found)).toLowerCase();
  if (base !== 'npm' && base !== 'npx') return undefined;
  const dir = win32.dirname(found);
  const cli = win32.join(dir, 'node_modules', 'npm', 'bin', `${base}-cli.js`);
  if (!exists(cli)) return undefined;
  const node = win32.join(dir, 'node.exe');
  return { command: exists(node) ? node : options.execPath ?? process.execPath, args: [cli, ...args] };
}
