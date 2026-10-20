#!/usr/bin/env node
// 打包产物冒烟：用当前 Node（或 Electron 的 ELECTRON_RUN_AS_NODE）fork dist/server/desktop-main.mjs，
// 经 IPC 下发令牌，创建一个 fake 任务并等待完成，最后优雅关闭。
// 用法：node scripts/smoke-bundle.mjs            （CI 在 build 之后运行）
//       ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-bundle.mjs
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(desktop, 'dist', 'server', 'desktop-main.mjs');
const dataDir = mkdtempSync(join(tmpdir(), 'pa-desktop-smoke-'));
const token = randomBytes(32).toString('base64url');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
delete env.NODE_OPTIONS;
const child = fork(process.platform === 'win32' ? pathToFileURL(entry) : entry, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env });
const message = (type) => new Promise((resolveMessage, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 60_000);
  child.on('message', function onMessage(value) {
    if (value?.type === 'error') { clearTimeout(timer); reject(new Error(`server error ${value.code}`)); }
    if (value?.type === type) { clearTimeout(timer); child.off('message', onMessage); resolveMessage(value); }
  });
});
async function removeDataDir() {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { rmSync(dataDir, { recursive: true, force: true }); return; }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || attempt === 7) throw error;
      await new Promise(done => setTimeout(done, 50 * (attempt + 1)));
    }
  }
}
let exitCode = 1;
try {
  child.send({ type: 'start', token, dataDir });
  const { port } = await message('ready');
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if ((await fetch(`${base}/api/health`)).status !== 401) throw new Error('missing token was not rejected');
  const health = await (await fetch(`${base}/api/health`, { headers })).json();
  if (health.status !== 'ok') throw new Error(`health ${JSON.stringify(health)}`);
  const created = await (await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ commandId: 'desktop-smoke', goal: 'Desktop bundle smoke' }) })).json();
  let snapshot = created;
  let status = created?.task?.status ?? created?.status ?? '';
  for (let attempt = 0; attempt < 120; attempt++) {
    snapshot = await (await fetch(`${base}/api/tasks/${created.id}`, { headers })).json();
    status = snapshot.task?.status ?? snapshot.status ?? '';
    if (!['queued', 'running'].includes(status)) break;
    await new Promise(done => setTimeout(done, 250));
  }
  if (!['completed', 'waiting_human', 'succeeded', 'done'].includes(status)) {
    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    const last = events.at(-1);
    const errorCode = last?.data?.reason ?? last?.data?.code ?? last?.data?.error ?? snapshot.task?.status ?? 'unknown';
    const errorMessage = last?.data?.message ?? last?.data?.error ?? JSON.stringify(last?.data ?? snapshot.task ?? snapshot);
    throw new Error(`fake task ended as ${status} errorCode=${errorCode} errorMessage=${errorMessage} lastEvents=${JSON.stringify(events.slice(-5))}`);
  }
  child.send({ type: 'shutdown' });
  const stopped = await message('stopped');
  if (stopped.exitCode !== 0) throw new Error('unclean shutdown');
  console.log(JSON.stringify({ result: 'PASS', port, taskStatus: status, platform: process.platform, electron: process.versions.electron ?? null }));
  exitCode = 0;
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: String(error?.message ?? error) }));
  try { if (child.connected) child.send({ type: 'shutdown' }); } catch { /* already gone */ }
  await Promise.race([
    new Promise(done => { if (child.exitCode !== null) done(); else child.once('exit', done); }),
    new Promise(done => setTimeout(done, 5_000)),
  ]);
  if (child.exitCode === null && child.kill) child.kill();
} finally {
  await new Promise(done => { if (child.exitCode !== null) done(); else child.once('exit', done); });
  await removeDataDir().catch(error => console.error(JSON.stringify({ result: 'FAIL', cleanup: String(error?.message ?? error) })));
  process.exit(exitCode);
}
