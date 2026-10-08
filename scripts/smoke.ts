import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { buildApp } from '../apps/server/src/app.js';

const dataDir = mkdtempSync(join(tmpdir(), 'personal-agent-smoke-'));
const { app, runner } = await buildApp({ dataDir });
try {
  const response = await app.inject({ method: 'POST', url: '/api/tasks', payload: { commandId: 'smoke-demo', goal: 'Produce a phase 1 fake result' } });
  assert.equal(response.statusCode, 201);
  await runner.idle();
  const snapshot = (await app.inject(`/api/tasks/${response.json().id}`)).json();
  assert.equal(snapshot.task.status, 'completed');
  assert.ok(snapshot.artifacts.length > 0);
  assert.ok(snapshot.events.some((e: { type: string }) => e.type === 'engine.message'));
  console.log(JSON.stringify({ result: 'PASS', engine: 'fake ACP over stdio', status: snapshot.task.status,
    events: snapshot.events.length, artifacts: snapshot.artifacts.length, cursor: snapshot.cursor }));
} finally {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
