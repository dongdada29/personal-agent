import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildApp } from '../apps/server/src/app.js';
import { createFakeEngineAdapter } from '../packages/runtime/src/engine-fake.js';
import type { TaskSnapshot } from '@personal-agent/contracts';
import { failCli, isMain } from './cli.js';
import { closeDemoData } from './demo-cleanup.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export async function startDemo(port = 47811) {
  const dataDir = mkdtempSync(join(tmpdir(), 'personal-agent-demo-'));
  // Explicitly restrict both adapter slots to fake. Ambient model settings and
  // security environment are never consulted by this standalone demo instance.
  let instance: Awaited<ReturnType<typeof buildApp>> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    await closeDemoData(dataDir, instance);
    closed = true;
  };
  try {
    const fake = createFakeEngineAdapter();
    instance = await buildApp({ dataDir, adapter: fake, realAdapter: fake, port });
    instance.app.addHook('preValidation', async (request, reply) => {
      const body = request.body as { engine?: unknown; defaultEngine?: unknown } | undefined;
      if ((request.method === 'POST' && request.url.split('?', 1)[0] === '/api/tasks' && body?.engine === 'claude') ||
          (request.method === 'POST' && request.url.split('?', 1)[0] === '/api/workspaces') ||
          (request.method === 'PATCH' && request.url.split('?', 1)[0] === '/api/settings' && body?.defaultEngine === 'claude')) {
        return reply.code(400).send({ code: 'DEMO_FAKE_ONLY', message: '此临时演示只运行 fake；真实开发任务请在自己的持久实例中创建。' });
      }
    });
    const address = await instance.app.listen({ host: '127.0.0.1', port });
    const headers = { 'Content-Type': 'application/json' };
    const create = async (commandId: string, goal: string) => {
      const response = await fetch(`${address}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ commandId, goal, engine: 'fake' }), signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 201);
      return await response.json() as { id: string };
    };
    const failure = await create('demo_failure', 'fake:error Demonstrate a recoverable engine failure.');
    const success = await create('demo_success', 'Produce a fake result for the local interactive demo.');
    await instance.runner.idle();
    const snapshots = await Promise.all([failure, success].map(async task => {
      const response = await fetch(`${address}/api/tasks/${task.id}`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200);
      return await response.json() as TaskSnapshot;
    }));
    assert.equal(snapshots[0].task.status, 'failed');
    assert.equal(snapshots[1].task.status, 'completed');
    assert.equal(snapshots[0].artifacts.length, 0);
    assert.equal(snapshots[1].artifacts.length, 1);
    const replay = await fetch(`${address}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ commandId: 'demo_success', goal: 'Produce a fake result for the local interactive demo.', engine: 'fake' }), signal: AbortSignal.timeout(10_000) });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { id: string }).id, success.id);
    const db = new DatabaseSync(join(dataDir, 'personal-agent.sqlite'), { readOnly: true });
    try {
      for (const snapshot of snapshots) {
        assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(snapshot.task.id)?.status, snapshot.task.status);
        assert.equal(Number(db.prepare('SELECT count(*) AS count FROM task_events WHERE task_id=?').get(snapshot.task.id)?.count), snapshot.events.length);
        assert.equal(Number(db.prepare('SELECT count(*) AS count FROM artifacts WHERE task_id=?').get(snapshot.task.id)?.count), snapshot.artifacts.length);
      }
      for (const table of ['security_policy', 'devices', 'pairing_tickets', 'auth_commands']) assert.equal(Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count), 0);
    } finally { db.close(); }
    const realTask = await fetch(`${address}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ commandId: 'demo_real_rejected', goal: 'Must not execute', engine: 'claude' }), signal: AbortSignal.timeout(10_000) });
    assert.equal(realTask.status, 400);
    assert.equal((await realTask.json() as { code: string }).code, 'DEMO_FAKE_ONLY');
    return { address, dataDir, close, result: { result: 'PASS', engine: 'fake ACP over stdio', commandReplay: true, sqliteMatchesHttp: true, realExecutionRejected: true,
      tasks: snapshots.map(snapshot => ({ status: snapshot.task.status, events: snapshot.events.length, artifacts: snapshot.artifacts.length })),
      productionDataAccessed: false, accessCredentialsCreated: false } };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { console.error(`Demo evidence retained at: ${dataDir}`); throw cleanupError; }
    throw error;
  }
}

if (isMain(import.meta.url)) {
  let demo: Awaited<ReturnType<typeof startDemo>> | undefined;
  try {
    const args = process.argv.slice(2);
    let check = false, port = 47811;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--check') check = true;
      else if (args[index] === '--port' && args[index + 1]) {
        port = Number(args[++index]);
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw Object.assign(new Error('Port'), { code: 'CLI_ARGUMENT' });
      } else throw Object.assign(new Error('Usage'), { code: 'CLI_ARGUMENT' });
    }
    if (!check && port === 0) throw Object.assign(new Error('Interactive demo needs a fixed loopback port'), { code: 'CLI_ARGUMENT' });
    if (check && !args.includes('--port')) port = 0;
    demo = await startDemo(port);
    console.log(JSON.stringify(demo.result, null, 2));
    if (check) await demo.close();
    else {
      console.log(`Open ${demo.address}/?demo=fake in your browser. This disposable fake demo is separate from your real instance.\nPress Ctrl+C to stop and remove its temporary data.`);
      let shutdown: Promise<void> | undefined;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
        shutdown ??= demo!.close().catch(error => { console.error(`Demo evidence retained at: ${demo!.dataDir}`); failCli(error); });
      });
    }
  } catch (error) {
    let failure = error;
    if (demo) {
      try { await demo.close(); }
      catch (cleanupError) { console.error(`Demo evidence retained at: ${demo.dataDir}`); failure = cleanupError; }
    }
    failCli(failure);
  }
}
