import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  nodeEsmSpecifier, parseWindowsProcessTable, quoteWindowsArg, resolveWindowsCommand, terminateWindowsIdentities, windowsCommandLineToArgv,
  windowsDescendants, windowsOwnerCommandMatches, windowsOwnerIdentityMatches, windowsProcessQueryScript, type WindowsProcessRow,
} from '../src/process-windows.js';
import { engineStartupTimeoutMs } from '../src/engine.js';
import { classifyWindowsOwner, ownedProcessSpawnOptions, ownerIdentityDeadlineMs, ownerReadyDeadlineMs, processOwnerWrapperPath, recoverOwnedProcesses, spawnOwnedProcess,
  verifyProcessOwner, type OwnedProcessRecord } from '../src/process-registry.js';

const EXEC = 'C:\\Program Files\\nodejs\\node.exe';
const WRAPPER = 'C:\\Users\\dev\\personal-agent\\packages\\runtime\\src\\process-owner.mjs';
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const T0 = '2026-10-20T01:02:03.1234567Z';
const later = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString().replace('Z', '0000Z');

describe('Windows command lines (CommandLineToArgvW)', () => {
  it('parses libuv-quoted owner command lines exactly', () => {
    const line = `"${EXEC}" ${WRAPPER} --personal-agent-owner=${ID}`;
    expect(windowsCommandLineToArgv(line)).toEqual([EXEC, WRAPPER, `--personal-agent-owner=${ID}`]);
    expect(windowsOwnerCommandMatches(line, EXEC, WRAPPER, ID)).toBe(true);
    // 大小写与分隔符差异视为同一路径；多余参数或不同标记一律拒绝。
    expect(windowsOwnerCommandMatches(line.toLowerCase().replace(ID, ID), EXEC.toUpperCase(), WRAPPER.replaceAll('\\', '/'), ID)).toBe(true);
    expect(windowsOwnerCommandMatches(`${line} extra`, EXEC, WRAPPER, ID)).toBe(false);
    expect(windowsOwnerCommandMatches(line.replace(ID, '1f8fad5b-d9cb-469f-a165-70867728950e'), EXEC, WRAPPER, ID)).toBe(false);
    expect(windowsOwnerCommandMatches(null, EXEC, WRAPPER, ID)).toBe(false);
  });

  it('round-trips arguments with spaces, quotes and trailing backslashes', () => {
    const args = ['plain', 'with space', 'quote"inside', 'C:\\dir with space\\', 'back\\\\"slash', '', 'tab\there', '中文 参数'];
    const line = ['C:\\x\\a.exe', ...args].map(quoteWindowsArg).join(' ');
    expect(windowsCommandLineToArgv(line)).toEqual(['C:\\x\\a.exe', ...args]);
  });

  it('applies the argv[0] rule and the doubled-quote rule', () => {
    expect(windowsCommandLineToArgv('"C:\\a\\"b c')).toEqual(['C:\\a\\', 'b', 'c']);
    expect(windowsCommandLineToArgv('a "x""y" \\\\\\"z')).toEqual(['a', 'x"y', '\\"z']);
    expect(windowsCommandLineToArgv('   ')).toEqual([]);
  });
});

describe('Windows process table', () => {
  it('parses PowerShell CIM JSON, including the single-object form', () => {
    expect(parseWindowsProcessTable(`[{"p":4,"pp":0,"c":null,"l":null},{"p":100,"pp":4,"c":"${T0}","l":"x.exe"}]`)).toEqual([
      { pid: 4, ppid: 0, created: null, commandLine: null, executablePath: null },
      { pid: 100, ppid: 4, created: T0, commandLine: 'x.exe', executablePath: null }]);
    expect(parseWindowsProcessTable(`{"p":100,"pp":4,"c":"${T0}","l":"x.exe"}`)).toHaveLength(1);
    expect(parseWindowsProcessTable('')).toEqual([]);
    for (const bad of ['nope', '[{"p":"1","pp":0}]', '[{"p":1,"pp":0,"c":"yesterday"}]', '[1]', '"x"']) {
      expect(parseWindowsProcessTable(bad), bad).toBeUndefined();
    }
  });

  it('only embeds numeric PID filters in the query script', () => {
    expect(windowsProcessQueryScript([12, 34])).toContain('-Filter "ProcessId=12 OR ProcessId=34"');
    // 按 PID 查身份时不能用 -Property，否则 CommandLine 为空。
    expect(windowsProcessQueryScript([12])).not.toContain('-Property');
    expect(windowsProcessQueryScript([12])).toContain('l=$_.CommandLine; e=$_.ExecutablePath');
    expect(windowsProcessQueryScript()).not.toContain('-Filter');
    expect(windowsProcessQueryScript()).toContain('-Property ProcessId,ParentProcessId,CreationDate');
    expect(windowsProcessQueryScript()).toContain('-InputObject $rows');
  });

  it('converts Windows paths to file:// ESM specifiers and leaves POSIX paths alone', () => {
    expect(nodeEsmSpecifier('D:\\a\\file.ts', 'win32')).toBe('file:///D:/a/file.ts');
    expect(nodeEsmSpecifier('file:///D:/a/file.ts', 'win32')).toBe('file:///D:/a/file.ts');
    expect(nodeEsmSpecifier('/tmp/file.ts', 'linux')).toBe('/tmp/file.ts');
  });

  it('finds orphaned descendants and ignores children of a reused parent PID', () => {
    const rows: WindowsProcessRow[] = [
      // 200 是 owner(100) 的子进程；300 是 200 的孤儿（200 已退出但 ParentProcessId 仍为 200）。
      { pid: 200, ppid: 100, created: later(1), commandLine: 'engine' },
      { pid: 300, ppid: 200, created: later(2), commandLine: 'grandchild' },
      // 400 的 ParentProcessId 也是 100，但它比 owner 更早创建：说明它的父进程是 PID 100 的前任，必须忽略。
      { pid: 400, ppid: 100, created: '2026-10-19T00:00:00.0000000Z', commandLine: 'unrelated' },
    ];
    expect(windowsDescendants(rows, [{ pid: 100, created: T0 }]).map(item => item.pid)).toEqual([200, 300]);
  });

  it('classifies owners by PID, creation time and exact command line', () => {
    const record: OwnedProcessRecord = { id: ID, pid: 100, pgid: 100, wrapperPath: WRAPPER, startedAt: T0, status: 'active', kind: 'engine', created: T0 };
    const line = `"${EXEC}" "${WRAPPER}" --personal-agent-owner=${ID}`;
    expect(classifyWindowsOwner(record, [{ pid: 100, ppid: 1, created: T0, commandLine: line }], EXEC)).toBe('owned');
    expect(classifyWindowsOwner(record, [{ pid: 100, ppid: 1, created: later(5), commandLine: line }], EXEC)).toBe('gone');
    expect(classifyWindowsOwner(record, [], EXEC)).toBe('gone');
    expect(classifyWindowsOwner(record, [{ pid: 100, ppid: 1, created: T0, commandLine: `"${EXEC}" -e x` }], EXEC)).toBe('unsafe');
    expect(classifyWindowsOwner({ ...record, created: undefined }, [], EXEC)).toBe('unsafe');
    // CommandLine 读不到时，PID + 创建时间 + ExecutablePath 仍视为 owned；错误的可执行文件或冲突的命令行一律 unsafe。
    expect(classifyWindowsOwner(record, [{ pid: 100, ppid: 1, created: T0, commandLine: null, executablePath: EXEC }], EXEC)).toBe('owned');
    expect(classifyWindowsOwner(record, [{ pid: 100, ppid: 1, created: T0, commandLine: null, executablePath: 'C:\\Windows\\System32\\cmd.exe' }], EXEC)).toBe('unsafe');
    expect(windowsOwnerIdentityMatches({ pid: 100, ppid: 1, created: T0, commandLine: `"${EXEC}" -e x`, executablePath: EXEC }, EXEC, WRAPPER, ID)).toBe(false);
  });

  it('terminates identities with descendants, skips reused PIDs and verifies they are gone', async () => {
    let table: WindowsProcessRow[] = [
      { pid: 100, ppid: 1, created: T0, commandLine: 'owner' },
      { pid: 200, ppid: 100, created: later(1), commandLine: 'engine' },
      { pid: 300, ppid: 200, created: later(2), commandLine: 'grandchild' },
      { pid: 500, ppid: 1, created: T0, commandLine: 'other' },
    ];
    const killed: number[] = [];
    const ok = await terminateWindowsIdentities([{ pid: 100, created: T0 }], {
      query: async () => table,
      kill: async pid => { killed.push(pid); table = table.filter(row => row.pid !== pid); return true; },
      verifyMs: 200,
    });
    expect(ok).toBe(true);
    expect(killed).toEqual([100, 200, 300]);
    expect(table.map(row => row.pid)).toEqual([500]);

    // PID 100 已被一个更晚创建的无关进程复用：它不属于记录的身份，绝不结束它。
    const reused: WindowsProcessRow[] = [{ pid: 100, ppid: 1, created: later(60), commandLine: 'reused' }];
    const none: number[] = [];
    expect(await terminateWindowsIdentities([{ pid: 100, created: T0 }], { query: async () => reused, kill: async pid => { none.push(pid); return true; } })).toBe(true);
    expect(none).toEqual([]);

    // taskkill 失败而进程仍在：在期限后报告失败（调用方 fail closed）。
    expect(await terminateWindowsIdentities([{ pid: 500, created: T0 }], { query: async () => table, kill: async () => false, verifyMs: 50 })).toBe(false);
  });
});

describe('Windows owner spawn options', () => {
  it('uses Node IPC and does not detach, so extra stdio handles are inherited', () => {
    expect(ownedProcessSpawnOptions('win32')).toEqual({
      detached: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], serialization: 'json',
    });
    expect(ownedProcessSpawnOptions('linux')).toEqual({
      detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    expect(ownedProcessSpawnOptions('darwin').stdio[3]).toBe('pipe');
    expect(ownerReadyDeadlineMs('win32')).toBe(15_000);
    expect(ownerReadyDeadlineMs('linux')).toBe(3_000);
    expect(ownerIdentityDeadlineMs('win32')).toBe(15_000);
    expect(ownerIdentityDeadlineMs('linux')).toBe(0);
    expect(engineStartupTimeoutMs('win32')).toBe(45_000);
    expect(engineStartupTimeoutMs('linux')).toBe(15_000);
  });
});

describe('Windows verification command resolution', () => {
  const files = new Set([
    'C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'C:\\Program Files\\nodejs\\npx.cmd',
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', 'C:\\Tools\\git.exe', 'C:\\Tools\\build.bat',
  ]);
  const exists = (path: string) => [...files].some(file => file.toLowerCase() === path.toLowerCase());
  const env = { PATH: 'C:\\Tools;C:\\Program Files\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  it('maps npm/npx shims to node + npm-cli.js without cmd.exe', () => {
    expect(resolveWindowsCommand('npm', ['test', '--', 'a b'], env, { exists })).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'test', '--', 'a b'] });
    expect(resolveWindowsCommand('npx', ['vitest'], env, { exists })?.args[0]).toMatch(/npx-cli\.js$/u);
  });

  it('resolves executables via PATH × PATHEXT and refuses other batch files', () => {
    expect(resolveWindowsCommand('git', ['status'], env, { exists })).toEqual({ command: 'C:\\Tools\\git.exe', args: ['status'] });
    expect(resolveWindowsCommand('C:\\Tools\\git.exe', [], env, { exists })?.command).toBe('C:\\Tools\\git.exe');
    expect(resolveWindowsCommand('build', ['&calc'], env, { exists })).toBeUndefined();
    expect(resolveWindowsCommand('missing', [], env, { exists })).toBeUndefined();
  });
});

describe.runIf(process.platform === 'win32')('live Windows process owners', () => {
  let directory: string;
  const owners: Array<ReturnType<typeof spawnOwnedProcess>> = [];
  beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'pa-win-owner-'))); });
  afterEach(async () => {
    await Promise.all(owners.splice(0).map(owner => owner.close().catch(() => {})));
    await rm(directory, { recursive: true, force: true });
  });
  const owner = (script: string, args: string[] = []) => {
    const result = spawnOwnedProcess({ command: process.execPath, args: ['-e', script, ...args], cwd: directory,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, kind: 'engine' });
    result.process.stdout.resume(); result.process.stderr.resume(); owners.push(result);
    return result;
  };
  const waitForFile = async (path: string) => {
    let value = '';
    await expect.poll(async () => { try { value = await readFile(path, 'utf8'); return value.length > 0; } catch { return false; } }, { timeout: 10_000 }).toBe(true);
    return value;
  };

  it('records the owner creation time, runs the command and closes after a normal exit', async () => {
    const marker = join(directory, 'ran');
    const result = owner('require("fs").writeFileSync(process.argv[1],"ok")', [marker]);
    await result.start();
    expect(result.record.created).toMatch(/^\d{4}-\d\d-\d\dT/u);
    expect(result.record.wrapperPath).toBe(processOwnerWrapperPath);
    expect(await waitForFile(marker)).toBe('ok');
    await result.exit;
    await result.close();
    expect(await verifyProcessOwner(result.record)).toBe('gone');
  }, 30_000);

  it('recovers a live owner and kills its descendant tree', async () => {
    const marker = join(directory, 'child-pid');
    const script = 'const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});' +
      'require("fs").writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)';
    const result = owner(script, [marker]);
    await result.start();
    const descendant = Number(await waitForFile(marker));
    expect(await verifyProcessOwner(result.record)).toBe('owned');
    const closed: OwnedProcessRecord[] = [];
    await recoverOwnedProcesses([result.record], record => { closed.push(record); });
    expect(closed).toHaveLength(1);
    await expect.poll(() => { try { process.kill(descendant, 0); return true; } catch { return false; } }, { timeout: 10_000 }).toBe(false);
  }, 60_000);
});
