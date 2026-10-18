import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type { TaskSnapshot } from '@personal-agent/contracts';
import { recoverOwnedProcesses, TaskStore, processOwnerWrapperPath, type OwnedProcessRecord } from '@personal-agent/runtime';
import { acquireInstanceLock } from '../src/instance-lock.js';
import { buildApp } from '../src/app.js';
import { processRunning as alive } from '../../../packages/runtime/test/helpers/process-observation.js';
import { createFixtureIpc, withFixtureCleanup } from './fixtures/fixture-ipc.js';

const loader = createRequire(import.meta.url).resolve('tsx');
const serverPath = fileURLToPath(new URL('./fixtures/restart-server.ts', import.meta.url));
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) { const value = await read(); if (check(value)) return value;
    if (Date.now() >= deadline) throw new Error('Fixture state deadline exceeded');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
function launch(dataDir: string) {
  const child = spawn(process.execPath, ['--import', loader, serverPath, dataDir], {
    env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return createFixtureIpc(child);
}

// The production permission check is left intact. A sandbox denial is visible
// as a skipped real-host check; no alternate source or broadened PID match.
let psAvailable = false;
try { execFileSync('ps', ['-ww', '-p', String(process.pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'command='], { stdio: 'pipe' }); psAvailable = true; } catch { /* explicit sandbox boundary */ }
const realRestart = psAvailable ? it : it.skip;

function repository(root: string): string {
  const path = join(root, 'repo'); mkdirSync(path);
  const hooks = join(root, 'hooks'); mkdirSync(hooks);
  writeFileSync(join(path, 'feature.txt'), 'before\n');
  const git = (args: string[]) => execFileSync('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgSign=false', '-C', path, ...args], { stdio: 'pipe' });
  git(['init', '--quiet']); git(['add', '.']);
  git(['-c', 'user.name=Restart fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture baseline']);
  return path;
}
async function createReal(server: ReturnType<typeof launch>, repo: string, goal: string, args: string[]) {
  const workspace = await server.request({ method: 'POST', url: '/api/workspaces', payload: { commandId: randomUUID(), name: 'Restart fixture', path: repo } });
  expect(workspace.statusCode).toBe(201);
  const result = await server.request({ method: 'POST', url: '/api/tasks', payload: {
    commandId: randomUUID(), goal, engine: 'claude', workspaceId: workspace.body.id,
    verificationCommands: [{ command: process.execPath, args }],
  } });
  expect(result.statusCode).toBe(201); return result.body.id as string;
}
async function cleanup(root: string, servers: ReturnType<typeof launch>[]) {
  const failures: unknown[] = [];
  for (const server of servers) { try { await server.close(); } catch (error) { failures.push(error); } }
  const filename = join(root, 'data', 'personal-agent.sqlite');
  try {
    if (existsSync(filename)) {
      const store = new TaskStore(filename);
      await withFixtureCleanup(async () => { await recoverOwnedProcesses(store.processes(), record => store.closeProcess(record)); },
        async () => { store.close(); });
    }
  } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Restart fixture cleanup failed');
  rmSync(root, { recursive: true, force: true });
}

realRestart('reclaims a confirmed-dead service, cleans only its verified ACP group, interrupts and requires an explicit fresh attempt', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-real-restart-')));
  const data = join(root, 'data'); const first = launch(data); const servers = [first];
  await withFixtureCleanup(async () => {
    await first.ready;
    const created = await first.request({ method: 'POST', url: '/api/tasks', payload: { commandId: 'crash-task', goal: 'fake:stubborn fake:spawn-grandchild' } });
    const id = created.body.id;
    const before = await until(async () => (await first.request({ url: `/api/tasks/${id}` })).body as TaskSnapshot,
      value => value.events.some(event => event.type === 'engine.message' && String(event.data.text).includes('grandchild:')));
    const owners = await first.request({ op: 'processes' }) as OwnedProcessRecord[];
    expect(owners.filter(record => record.status === 'active')).toHaveLength(1);
    const group = owners[0]; expect(alive(group.pid)).toBe(true);
    first.child.kill('SIGKILL'); await first.exit;
    expect(alive(group.pid)).toBe(true);
    const second = launch(data); servers.push(second); await second.ready;
    const restored = (await second.request({ url: `/api/tasks/${id}` })).body as TaskSnapshot;
    expect(restored.task.status).toBe('interrupted'); expect(restored.task.activeAttemptId).toBeNull();
    expect(alive(group.pid)).toBe(false); expect(alive(-group.pgid)).toBe(false);
    expect((await second.request({ op: 'processes' })).every((record: OwnedProcessRecord) => record.status === 'closed')).toBe(true);
    expect(restored.events.filter(event => event.type.startsWith('engine.'))).toEqual(before.events.filter(event => event.type.startsWith('engine.')));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await second.request({ url: `/api/tasks/${id}` })).body.task.status).toBe('interrupted');
    const resumed = await second.request({ method: 'POST', url: `/api/tasks/${id}/control`, payload: { commandId: 'resume-crash', action: 'resume' } });
    expect(resumed.body.status).toBe('queued');
    const active = await until(async () => (await second.request({ url: `/api/tasks/${id}` })).body as TaskSnapshot, value => value.task.status === 'running');
    expect(active.task.activeAttemptId).not.toBe(before.task.activeAttemptId);
    expect((await second.request({ method: 'POST', url: `/api/tasks/${id}/control`, payload: { commandId: 'cancel-resumed', action: 'cancel' } })).body.status).toBe('cancelled');
  }, () => cleanup(root, servers));
}, 30_000);

realRestart('expires a durable permission after a crash without granting or replaying its tool', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-permission-restart-')));
  const data = join(root, 'data'); const first = launch(data); const servers = [first];
  await withFixtureCleanup(async () => {
    const repo = repository(root); await first.ready;
    const id = await createReal(first, repo, 'restart-permission', ['-e', 'process.exit(0)']);
    const before = await until(async () => (await first.request({ url: `/api/tasks/${id}` })).body as TaskSnapshot,
      value => value.task.status === 'waiting_human' && value.approvals!.some(item => item.status === 'pending'));
    const approval = before.approvals!.find(item => item.status === 'pending')!;
    const logPath = join(before.task.worktreePath!, 'fixture-executions.log'); const log = readFileSync(logPath, 'utf8');
    first.child.kill('SIGKILL'); await first.exit;
    const second = launch(data); servers.push(second); await second.ready;
    const restored = (await second.request({ url: `/api/tasks/${id}` })).body as TaskSnapshot;
    expect(restored.task.status).toBe('interrupted');
    expect(restored.task.checkpoint?.nextStage).toBe('development');
    expect(restored.approvals!.find(item => item.id === approval.id)?.status).toBe('expired');
    expect(restored.runs!.filter(run => run.attemptId === before.task.activeAttemptId).every(run => !['running', 'waiting_human'].includes(run.status))).toBe(true);
    expect(readFileSync(logPath, 'utf8')).toBe(log); expect(readFileSync(join(before.task.worktreePath!, 'feature.txt'), 'utf8')).toBe('before\n');
    const stale = await second.request({ method: 'POST', url: `/api/approvals/${approval.id}/resolve`, payload: { commandId: 'late-decision', optionId: 'allow-once' } });
    expect(stale.statusCode).toBe(409);
    await second.request({ method: 'POST', url: `/api/tasks/${id}/control`, payload: { commandId: 'explicit-continue', action: 'resume' } });
    const next = await until(async () => (await second.request({ url: `/api/tasks/${id}` })).body as TaskSnapshot,
      value => value.approvals!.some(item => item.status === 'pending'));
    expect(next.task.activeAttemptId).not.toBe(before.task.activeAttemptId);
    expect(next.approvals!.find(item => item.status === 'pending')!.id).not.toBe(approval.id);
    expect(readFileSync(logPath, 'utf8').split('\n').filter(line => line.startsWith('analysis:'))).toHaveLength(2);
    await second.request({ method: 'POST', url: `/api/tasks/${id}/control`, payload: { commandId: 'take-over-new-permission', action: 'takeover', requirements: 'Keep the fixture unedited' } });
  }, () => cleanup(root, servers));
}, 30_000);

realRestart('cleans a verification group on restart and preserves its cursor until explicit resume', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-verification-restart-')));
  const data = join(root, 'data'); const first = launch(data); const servers = [first];
  await withFixtureCleanup(async () => {
    const repo = repository(root); await first.ready;
    const code = 'require("node:fs").appendFileSync("verification-starts.log","start\\n");process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
    const id = await createReal(first, repo, 'restart-verification', ['-e', code]);
    const before = await until(async () => (await first.request({ url: `/api/tasks/${id}` })).body as TaskSnapshot,
      value => value.task.checkpoint?.nextStage === 'verification' && value.stages!.some(stage => stage.name === 'verification' && stage.status === 'running') && existsSync(join(value.task.worktreePath!, 'verification-starts.log')));
    const owners = await first.request({ op: 'processes' }) as OwnedProcessRecord[];
    const verify = owners.find(record => record.kind === 'verification' && record.status === 'active')!;
    expect(verify).toBeDefined(); const log = join(before.task.worktreePath!, 'verification-starts.log');
    first.child.kill('SIGKILL'); await first.exit;
    const second = launch(data); servers.push(second); await second.ready;
    const restored = (await second.request({ url: `/api/tasks/${id}` })).body as TaskSnapshot;
    expect(restored.task.status).toBe('interrupted'); expect(restored.task.checkpoint?.nextStage).toBe('verification');
    expect(alive(-verify.pgid)).toBe(false); expect(readFileSync(log, 'utf8')).toBe('start\n');
    expect(restored.verifications).toHaveLength(0);
    await second.request({ method: 'POST', url: `/api/tasks/${id}/control`, payload: { commandId: 'resume-verification', action: 'resume' } });
    await until(async () => readFileSync(log, 'utf8'), value => value === 'start\nstart\n');
    const next = (await second.request({ url: `/api/tasks/${id}` })).body as TaskSnapshot;
    expect(next.task.activeAttemptId).not.toBe(before.task.activeAttemptId);
    expect(readFileSync(join(before.task.worktreePath!, 'fixture-executions.log'), 'utf8').split('\n').filter(line => line.startsWith('development:'))).toHaveLength(1);
    await second.request({ method: 'POST', url: `/api/tasks/${id}/control`, payload: { commandId: 'cancel-verification', action: 'cancel' } });
  }, () => cleanup(root, servers));
}, 30_000);

it('does not reclaim a live, malformed or guarded owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'personal-agent-lock-'));
  try {
    writeFileSync(join(root, 'service.lock'), JSON.stringify({ pid: process.pid, startedAt: 'fixture' }));
    expect(() => acquireInstanceLock(root)).toThrowError(expect.objectContaining({ code: 'INSTANCE_LOCKED' }));
    writeFileSync(join(root, 'service.lock'), 'not-json');
    expect(() => acquireInstanceLock(root)).toThrowError(expect.objectContaining({ code: 'INSTANCE_LOCKED' }));
    writeFileSync(join(root, 'service.lock'), JSON.stringify({ pid: 999_999_999 }));
    writeFileSync(join(root, 'recovery.lock'), 'fixture guard');
    expect(() => acquireInstanceLock(root)).toThrowError(expect.objectContaining({ code: 'INSTANCE_LOCKED' }));
    expect(existsSync(join(root, 'service.lock'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('keeps the lock and active attempt untouched when recovery cannot verify a saved owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'personal-agent-unsafe-recovery-'));
  const filename = join(root, 'personal-agent.sqlite');
  let store = new TaskStore(filename);
  try {
    const task = store.create({ commandId: 'unsafe-owner', goal: 'No tools may be dispatched' }).task;
    const active = store.start(task.id);
    store.create({ commandId: 'queued-behind-unsafe', goal: 'Stay queued' });
    // This is the test's own ordinary Node PID, whose argv is not the wrapper.
    store.registerProcess({ id: randomUUID(), taskId: task.id, attemptId: active.activeAttemptId!,
      pid: process.pid, pgid: process.pid, wrapperPath: processOwnerWrapperPath,
      startedAt: new Date().toISOString(), status: 'active', kind: 'engine' });
    const before = store.snapshot(task.id); store.close();
    await expect(buildApp({ dataDir: root, webRoot: join(root, 'absent') })).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    expect(alive(process.pid)).toBe(true); expect(existsSync(join(root, 'service.lock'))).toBe(true);
    store = new TaskStore(filename);
    expect(store.snapshot(task.id)).toEqual(before);
    expect(store.processes()).toHaveLength(1);
    expect(store.list().find(item => item.commandId === 'queued-behind-unsafe')?.status).toBe('queued');
    await expect(buildApp({ dataDir: root })).rejects.toMatchObject({ code: 'INSTANCE_LOCKED' });
  } finally { try { store.close(); } catch { /* already closed */ } rmSync(root, { recursive: true, force: true }); }
});

it('blocks an active pre-ledger task instead of assuming its old tools stopped during upgrade', async () => {
  const root = mkdtempSync(join(tmpdir(), 'personal-agent-legacy-recovery-'));
  const filename = join(root, 'personal-agent.sqlite');
  let store = new TaskStore(filename);
  try {
    const task = store.create({ commandId: 'legacy-active', goal: 'Legacy execution must be inspected' }).task;
    store.start(task.id); store.close();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(filename);
    try { db.prepare('UPDATE tasks SET execution_json=? WHERE id=?').run('{"engine":"fake"}', task.id); } finally { db.close(); }
    await expect(buildApp({ dataDir: root })).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    expect(existsSync(join(root, 'service.lock'))).toBe(true);
    store = new TaskStore(filename);
    expect(store.require(task.id).status).toBe('running');
    expect(store.events(task.id).some(event => event.type === 'task.status_changed' && event.data.status === 'interrupted')).toBe(false);
  } finally { try { store.close(); } catch { /* already closed */ } rmSync(root, { recursive: true, force: true }); }
});
