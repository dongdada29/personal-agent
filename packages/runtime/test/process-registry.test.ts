import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { terminateEngineProcessTree } from '../src/engine-process.js';
import { recoverOwnedProcesses, spawnOwnedProcess, verifyProcessOwner, processOwnerWrapperPath,
  type OwnedProcessRecord } from '../src/process-registry.js';

let directory: string;
// ps is denied inside the execution sandbox. Simulate its narrow owner rows
// only in this test fork; production still calls ps and fails closed on EPERM.
// These tests do not constitute a new live process-inspection acceptance run.
const inspection = vi.hoisted(() => ({ rows: new Map<number, { pid: number; pgid: number; command: string }>(), denied: false }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign(actual.execFile.bind(actual), {
    [promisify.custom]: async (command: string, args: string[], options: unknown) => {
      if (command !== 'ps') return promisify(actual.execFile)(command, args, options as never);
      const row = inspection.rows.get(Number(args[args.indexOf('-p') + 1]));
      if (inspection.denied || !row) throw Object.assign(new Error('Fixture-only ps permission denial'), { code: 'EPERM' });
      return { stdout: `${row.pid} ${row.pgid} ${row.command}\n`, stderr: '' };
    },
  });
  return { ...actual, execFile };
});
const owners: Array<ReturnType<typeof spawnOwnedProcess>> = [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function owner(script: string, args: string[] = [], context = { taskId: 'fixture-task', attemptId: 'fixture-attempt', runId: 'fixture-run' }) {
  const result = spawnOwnedProcess({ command: process.execPath, args: ['-e', script, ...args], cwd: directory,
    env: { PATH: process.env.PATH }, kind: 'engine', context });
  result.process.stdout.resume(); result.process.stderr.resume(); owners.push(result);
  inspection.rows.set(result.record.pid, { pid: result.record.pid, pgid: result.record.pgid,
    command: `${process.execPath} ${processOwnerWrapperPath} --personal-agent-owner=${result.record.id}` });
  return result;
}
async function waitForFile(path: string) {
  let value: string | undefined;
  await expect.poll(async () => {
    try { value = await readFile(path, 'utf8'); return true; } catch { return false; }
  }, { timeout: 3_000 }).toBe(true);
  return value!;
}
beforeEach(async () => { inspection.rows.clear(); inspection.denied = false; directory = await realpath(await mkdtemp(join(tmpdir(), 'personal-agent-process-owner-'))); });
afterEach(async () => {
  await Promise.all(owners.splice(0).map(result => result.close().catch(() => {})));
  await rm(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('persistent POSIX Node process owners', () => {
  it('executes nothing while registration is pending, then starts exactly the selected command and closes after verified exit', async () => {
    const marker = join(directory, 'execution');
    const started = deferred<void>(), release = deferred<void>();
    const records: OwnedProcessRecord[] = [];
    const result = owner('require("fs").writeFileSync(process.argv[1],process.argv[2]);setInterval(()=>{},1000)', [marker, 'utf8 fixture ✓']);
    const starting = result.start({ async onProcessStart(record) {
      records.push({ ...record }); started.resolve(); await release.promise;
    }, onProcessEnd(record) {
      expect(alive(record.pid)).toBe(false); expect(alive(-record.pgid)).toBe(false); records.push(record);
    } });
    await started.promise;
    expect(await verifyProcessOwner(result.record)).toBe('owned');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    release.resolve(); await starting;
    expect(await waitForFile(marker)).toBe('utf8 fixture ✓');
    await result.close();
    expect(records.map(record => record.status)).toEqual(['active', 'closed']);
    expect(records[0]).toMatchObject({ taskId: 'fixture-task', attemptId: 'fixture-attempt', runId: 'fixture-run', kind: 'engine', wrapperPath: processOwnerWrapperPath });
    expect(records[0].pgid).toBe(records[0].pid);
    expect(await verifyProcessOwner(result.record)).toBe('gone');
  });

  it('does not execute a command when fd3 closes before START', async () => {
    const marker = join(directory, 'must-not-execute');
    const result = owner('require("fs").writeFileSync(process.argv[1],"executed")', [marker]);
    await result.close();
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await verifyProcessOwner(result.record)).toBe('gone');
  });

  it('rejects failed durable registration and cleans the unstarted wrapper without leaking command arguments', async () => {
    const marker = join(directory, 'must-not-execute');
    const result = owner('require("fs").writeFileSync(process.argv[1],process.argv[2])', [marker, 'PRIVATE FIXTURE ARGUMENT']);
    const failure = await result.start({ onProcessStart() { throw new Error('private persistence details'); } }).catch(error => error);
    expect(failure).toMatchObject({ code: 'EVENT_FAILURE' });
    expect(JSON.stringify(failure)).not.toContain('private persistence details');
    expect(JSON.stringify(result.record)).not.toContain('PRIVATE FIXTURE ARGUMENT');
    await result.close();
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await verifyProcessOwner(result.record)).toBe('gone');
  });

  it('cannot release the gate after cancellation during a pending registration, and reports closure only after process exit', async () => {
    const marker = join(directory, 'must-not-execute');
    const entered = deferred<void>(), release = deferred<void>();
    const controller = new AbortController();
    const closed: OwnedProcessRecord[] = [];
    const result = owner('require("fs").writeFileSync(process.argv[1],"executed")', [marker]);
    const starting = expect(result.start({ async onProcessStart() { entered.resolve(); await release.promise; },
      onProcessEnd(record) { expect(alive(-record.pgid)).toBe(false); closed.push(record); },
    }, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    await entered.promise;
    controller.abort();
    const stopping = result.close();
    release.resolve();
    await stopping; await starting;
    expect(closed).toHaveLength(1); expect(closed[0].status).toBe('closed');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a verified stubborn owner and its descendants, persisting closure after the group is gone', async () => {
    const marker = join(directory, 'descendant');
    const childScript = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
    const script = `const child=require("child_process").spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:"ignore"});require("fs").writeFileSync(process.argv[1],String(child.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)`;
    const result = owner(script, [marker]);
    await result.start();
    const descendant = Number(await waitForFile(marker));
    expect(alive(descendant)).toBe(true);
    const closed: OwnedProcessRecord[] = [];
    const started = Date.now();
    await recoverOwnedProcesses([result.record], record => {
      expect(alive(record.pid)).toBe(false); expect(alive(-record.pgid)).toBe(false); closed.push(record);
    }, { termGraceMs: 100 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(alive(descendant)).toBe(false);
    expect(closed).toEqual([{ ...result.record, status: 'closed' }]);
  });

  it('marks a dead owner closed without sending signals, and ignores already closed records', async () => {
    const result = owner('process.exit(0)');
    await result.start(); await result.exit; await result.close();
    const closed: OwnedProcessRecord[] = [];
    await recoverOwnedProcesses([result.record, { ...result.record, status: 'closed' }], record => { closed.push(record); });
    expect(closed).toEqual([{ ...result.record, status: 'closed' }]);
  });

  it.each(['nonce', 'wrapperPath', 'pgid'] as const)('refuses mismatched %s metadata before signalling any saved owner', async (field) => {
    const first = owner('setInterval(()=>{},1000)'), second = owner('setInterval(()=>{},1000)');
    await Promise.all([first.start(), second.start()]);
    const bad = { ...second.record,
      ...(field === 'nonce' ? { id: randomUUID() } : field === 'wrapperPath' ? { wrapperPath: join(directory, 'foreign-wrapper.mjs') } : { pgid: process.pid }),
    };
    expect(await verifyProcessOwner(bad)).toBe('unsafe');
    await expect(recoverOwnedProcesses([first.record, bad], () => {})).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    expect(alive(first.record.pid)).toBe(true); expect(alive(second.record.pid)).toBe(true);
  });

  it('refuses an unrelated Node process with a matching saved PID and never kills it', async () => {
    const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } });
    foreign.on('error', () => {});
    const record: OwnedProcessRecord = { id: randomUUID(), pid: foreign.pid!, pgid: foreign.pid!, wrapperPath: processOwnerWrapperPath,
      startedAt: new Date().toISOString(), status: 'active', kind: 'engine' };
    inspection.rows.set(record.pid, { pid: record.pid, pgid: record.pgid, command: `${process.execPath} -e unrelated-fixture` });
    try {
      expect(await verifyProcessOwner(record)).toBe('unsafe');
      await expect(recoverOwnedProcesses([record], () => {})).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
      expect(alive(foreign.pid!)).toBe(true);
    } finally { await terminateEngineProcessTree(foreign); }
  });

  it('treats a ps permission denial as unsafe and sends no recovery signals', async () => {
    const result = owner('setInterval(()=>{},1000)');
    await result.start();
    inspection.denied = true;
    expect(await verifyProcessOwner(result.record)).toBe('unsafe');
    await expect(recoverOwnedProcesses([result.record], () => {})).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    expect(alive(result.record.pid)).toBe(true);
  });

  it('keeps a denied inspection unsafe when liveness could subsequently report the owner gone', async () => {
    const result = owner('setInterval(()=>{},1000)');
    await result.start();
    inspection.denied = true;
    let checks = 0;
    const liveness = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (++checks <= 2) return true;
      throw Object.assign(new Error('Fixture process exited'), { code: 'ESRCH' });
    });
    try {
      expect(await verifyProcessOwner(result.record)).toBe('unsafe');
      // Only the initial owner/group liveness checks occur. Permission denial
      // must not trigger a fallback conclusion, even if both could be dead.
      expect(checks).toBe(2);
    } finally { liveness.mockRestore(); }
  });

  it('fails closed if the owner PID is dead while an orphaned process group remains alive', async () => {
    const marker = join(directory, 'orphan');
    const childScript = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
    const script = `const child=require("child_process").spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:"ignore"});require("fs").writeFileSync(process.argv[1],String(child.pid));child.unref()`;
    const result = owner(script, [marker]);
    await result.start(); await result.exit;
    await expect.poll(() => alive(result.record.pid), { timeout: 3_000 }).toBe(false);
    const orphan = Number(await waitForFile(marker));
    expect(await verifyProcessOwner(result.record)).toBe('unsafe');
    await expect(recoverOwnedProcesses([result.record], () => {})).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    expect(alive(orphan)).toBe(true);
    await result.close(); // This still-live test owns the original spawn handle.
    expect(alive(orphan)).toBe(false);
  });

  it('retains a recoverable active record when closure persistence fails', async () => {
    const result = owner('setInterval(()=>{},1000)');
    await result.start({ onProcessEnd() { throw new Error('private database failure'); } });
    const error = await result.close().catch(error => error);
    expect(error).toMatchObject({ code: 'EVENT_FAILURE' });
    expect(JSON.stringify(error)).not.toContain('private database failure');
    expect(await verifyProcessOwner(result.record)).toBe('gone');
    const closed: OwnedProcessRecord[] = [];
    await recoverOwnedProcesses([result.record], record => { closed.push(record); });
    expect(closed[0].status).toBe('closed');
  });
});
