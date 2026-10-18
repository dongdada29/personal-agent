import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildApp } from '../apps/server/src/app.js';
import { demoConfigFromEnv } from '../apps/server/src/demo-mode.js';
import { createFakeEngineAdapter } from '../packages/runtime/src/engine-fake.js';
import type { TaskSnapshot } from '@personal-agent/contracts';
import { failCli, isMain } from './cli.js';
import { closeDemoData } from './demo-cleanup.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** --check 未指定公开 origin 时使用的保留域名，只用于进程内 inject 断言，不会发起网络请求。 */
export const CHECK_PUBLIC_ORIGIN = 'https://demo.example.invalid';

export interface DemoOptions {
  /** 公开 https origin（如 Cloudflare 隧道域名）；未设置时只接受 loopback。 */
  publicOrigin?: string;
  env?: Record<string, string | undefined>;
}

export async function startDemo(port = 47811, options: DemoOptions = {}) {
  // 先校验配置再创建临时目录，避免无效配置留下空目录。
  const demo = demoConfigFromEnv(options.env ?? process.env, { publicOrigin: options.publicOrigin });
  const dataDir = mkdtempSync(join(tmpdir(), 'personal-agent-demo-'));
  // demo 模式由服务端结构化强制：store/runner 均为 fake-only，真实 adapter 不会被构造；
  // 环境中的模型设置和 paired 安全配置都不会被这个独立演示实例读取。
  let instance: Awaited<ReturnType<typeof buildApp>> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    await closeDemoData(dataDir, instance);
    closed = true;
  };
  try {
    instance = await buildApp({ dataDir, adapter: createFakeEngineAdapter(), port, demo });
    const address = await instance.app.listen({ host: '127.0.0.1', port });
    const headers = { 'Content-Type': 'application/json' };
    const send = (path: string, method: string, body: unknown) => fetch(`${address}${path}`, { method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const create = async (commandId: string, goal: string) => {
      const response = await send('/api/tasks', 'POST', { commandId, goal, engine: 'fake' });
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
    const replay = await send('/api/tasks', 'POST', { commandId: 'demo_success', goal: 'Produce a fake result for the local interactive demo.', engine: 'fake' });
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

    // 审计中的绕过方式：编码路径、claude 引擎、仓库注册、默认引擎修改和验证命令执行都必须被拒绝。
    const marker = join(tmpdir(), `pa-demo-check-${process.pid}-marker`);
    const realTask = { goal: 'Must not execute', engine: 'claude', workspaceId: 'any', verificationCommands: [{ command: '/usr/bin/touch', args: [marker] }] };
    const rejected: Array<[string, string, unknown]> = [
      ['/api/tasks', 'POST', { commandId: 'demo_real_rejected', goal: 'Must not execute', engine: 'claude' }],
      ['/api/%74asks', 'POST', { commandId: 'demo_real_encoded', ...realTask }],
      ['/api/tasks', 'POST', { commandId: 'demo_fake_verification', goal: 'Must not execute', engine: 'fake', verificationCommands: realTask.verificationCommands }],
      ['/api/%77orkspaces', 'POST', { commandId: 'demo_workspace_encoded', name: 'Escape', path: process.cwd() }],
      ['/api/workspaces', 'POST', { commandId: 'demo_workspace', name: 'Escape', path: process.cwd() }],
      ['/api/%73ettings', 'PATCH', { commandId: 'demo_settings_encoded', defaultEngine: 'claude' }],
      ['/api/settings', 'PATCH', { commandId: 'demo_settings', defaultEngine: 'claude' }],
    ];
    for (const [path, method, body] of rejected) {
      const response = await send(path, method, body);
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal((await response.json() as { code: string }).code, 'DEMO_FAKE_ONLY', `${method} ${path}`);
    }
    for (const path of ['//api/tasks', '/api/tasks/', '/API/tasks', '/api/tasks%2f', '/api/./tasks', '/api/tasks/../tasks']) {
      const response = await send(path, 'POST', { commandId: `demo_variant_${Buffer.from(path).toString('hex')}`, ...realTask });
      assert.ok(response.status >= 400 && response.status < 500, `POST ${path} -> ${response.status}`);
    }
    await instance.runner.idle();
    assert.equal(instance.store.list().length, 2);
    assert.equal(instance.store.list().some(task => task.engine === 'claude'), false);
    assert.equal(instance.store.workspaces().length, 0);
    assert.equal(instance.store.settings().defaultEngine, 'fake');
    assert.equal(existsSync(marker), false);
    assert.equal(instance.runner.isFakeOnly, true);

    let publicOriginChecked = false;
    if (demo.publicOrigin) {
      const host = new URL(demo.publicOrigin).host;
      const inject = (url: string, method: 'GET' | 'POST', extra: Record<string, string>, payload?: unknown) =>
        instance!.app.inject({ url, method, headers: { host, ...extra }, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });
      const session = await inject('/api/session', 'GET', {});
      assert.equal(session.statusCode, 200);
      assert.deepEqual(session.json(), { mode: 'loopback', demo: 'fake' });
      const accepted = await inject('/api/tasks', 'POST', { origin: demo.publicOrigin }, { commandId: 'demo_public', goal: 'Public origin fake task', engine: 'fake' });
      assert.equal(accepted.statusCode, 201);
      assert.equal((await inject('/api/tasks', 'POST', { origin: 'https://evil.example' }, { commandId: 'demo_foreign', goal: 'x' })).json().code, 'ORIGIN_REJECTED');
      assert.equal((await inject('/api/tasks', 'POST', {}, { commandId: 'demo_no_origin', goal: 'x' })).json().code, 'ORIGIN_REQUIRED');
      assert.equal((await inject('/api/%74asks', 'POST', { origin: demo.publicOrigin }, { commandId: 'demo_public_real', ...realTask })).json().code, 'DEMO_FAKE_ONLY');
      assert.equal((await instance.app.inject({ url: '/api/session', headers: { host: 'evil.example' } })).json().code, 'LOCAL_ONLY');
      await instance.runner.idle();
      publicOriginChecked = true;
    }
    return { address, dataDir, close, publicOrigin: demo.publicOrigin, result: { result: 'PASS', engine: 'fake ACP over stdio', commandReplay: true, sqliteMatchesHttp: true, realExecutionRejected: true,
      encodedPathBypassRejected: true, workspaceRegistrationRejected: true, defaultEngineLocked: true, verificationCommandsNeverRun: true,
      realAdapterConstructed: false, publicOriginChecked,
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
    let check = false, port = 47811, publicOrigin: string | undefined;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--check') check = true;
      else if (args[index] === '--port' && args[index + 1]) {
        port = Number(args[++index]);
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw Object.assign(new Error('Port'), { code: 'CLI_ARGUMENT' });
      } else if (args[index] === '--public-origin' && args[index + 1]) publicOrigin = args[++index];
      else throw Object.assign(new Error('Usage'), { code: 'CLI_ARGUMENT' });
    }
    if (!check && port === 0) throw Object.assign(new Error('Interactive demo needs a fixed loopback port'), { code: 'CLI_ARGUMENT' });
    if (check && !args.includes('--port')) port = 0;
    // --check 总是验证公开 origin 的准入逻辑；未配置时使用保留域名，只在进程内注入请求。
    if (check) publicOrigin ??= process.env.PERSONAL_AGENT_DEMO_PUBLIC_ORIGIN || CHECK_PUBLIC_ORIGIN;
    demo = await startDemo(port, { publicOrigin });
    console.log(JSON.stringify(demo.result, null, 2));
    if (check) await demo.close();
    else {
      console.log(`Open ${demo.address}/?demo=fake in your browser. This disposable fake demo is separate from your real instance.`);
      if (demo.publicOrigin) console.log(`Public fake-only origin accepted: ${demo.publicOrigin} (the tunnel must forward the original Host to ${demo.address}).`);
      console.log('Press Ctrl+C to stop and remove its temporary data.');
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
