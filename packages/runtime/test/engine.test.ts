import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { methods, PROTOCOL_VERSION, type ToolCallUpdate } from '@agentclientprotocol/sdk';
import { createFakeEngineAdapter } from '../src/engine-fake.js';
import { createAcpEngineAdapter } from '../src/engine-acp.js';
import { createClaudeProbeConfig, readClaudeUserProbeMetadata } from '../src/engine-claude.js';
import type { EngineConfig, EngineEvent, EngineHooks, EnginePermission, EngineRunContext, EngineSession } from '../src/engine.js';
import type { OwnedProcessRecord } from '../src/process-registry.js';
import { processRunning as processAlive } from './helpers/process-observation.js';

const fixture = fileURLToPath(new URL('../src/engine-fake-fixture.ts', import.meta.url));
const loader = createRequire(import.meta.url).resolve('tsx');
let cwd: string;
let context: EngineRunContext;
let sessions: EngineSession[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function open(options: Partial<EngineConfig> = {}, hooks: Partial<EngineHooks> = {}) {
  const events: EngineEvent[] = [];
  const session = await createFakeEngineAdapter(options).open(context, {
    ...hooks,
    onEvent: hooks.onEvent ?? ((event) => { events.push(event); }),
  });
  sessions.push(session);
  return { session, events };
}

/** Independent ACP child that can hang after one or several human decisions. */
async function openPermissionDeadlineFixture(options: {
  promptTimeoutMs: number;
  activeBeforeMs?: number;
  requestCount?: number;
  finishAfterMs?: number;
  toolCall?: ToolCallUpdate;
}, onPermission: (request: EnginePermission) => void | Promise<void>): Promise<EngineSession> {
  const path = join(cwd, 'permission-deadline.mjs');
  await writeFile(path, `
    import { createInterface } from 'node:readline';
    const keepAlive = setInterval(() => {}, 1000);
    process.stdin.on('end', () => { clearInterval(keepAlive); process.exit(0); });
    const methods = ${JSON.stringify(methods)};
    const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
    const requests = new Set();
    let promptId;
    let refused = false;
    createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.method === methods.agent.initialize) {
        write({ id: request.id, result: { protocolVersion: ${PROTOCOL_VERSION}, agentCapabilities: {} } });
      } else if (request.method === methods.agent.session.new) {
        write({ id: request.id, result: { sessionId: 'deadline-session', modes: {
          currentModeId: 'default', availableModes: [{ id: 'plan', name: 'Plan' }, { id: 'default', name: 'Default' }],
        } } });
      } else if (request.method === methods.agent.session.setMode) {
        write({ id: request.id, result: {} });
      } else if (request.method === methods.agent.session.prompt) {
        promptId = request.id;
        setTimeout(() => {
          for (let index = 0; index < ${options.requestCount ?? 1}; index++) {
            const id = 1000 + index;
            requests.add(id);
            write({ id, method: methods.client.session.requestPermission, params: {
              sessionId: 'deadline-session', toolCall: { toolCallId: 'read-' + index, title: 'Harmless read', kind: 'read',
                ...${JSON.stringify(options.toolCall ?? {})} },
              options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }],
            } });
          }
        }, ${options.activeBeforeMs ?? 0});
      } else if (!request.method && requests.delete(request.id)) {
        refused ||= request.result?.outcome?.optionId === 'reject-once';
        if (requests.size === 0 && ${options.finishAfterMs !== undefined}) {
          setTimeout(() => write({ id: promptId, result: { stopReason: refused ? 'refusal' : 'end_turn' } }),
            ${options.finishAfterMs ?? 0});
        }
      }
    });
  `);
  const session = await createAcpEngineAdapter({ command: process.execPath, args: [path],
    promptTimeoutMs: options.promptTimeoutMs, startupTimeoutMs: 3_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  }).open(context, { onEvent: () => {}, onPermission });
  sessions.push(session);
  return session;
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'personal-agent-engine-test-'));
  context = { taskId: 'task', attemptId: 'attempt', runId: 'run', cwd, mode: 'plan' };
  sessions = [];
});

afterEach(async () => {
  await Promise.all(sessions.map((session) => session.close()));
  await rm(cwd, { recursive: true, force: true });
});

describe('stdio ACP engine adapter', () => {
  it('performs ACP negotiation, explicitly selects plan, streams events and creates a result artifact', async () => {
    const { session, events } = await open();
    expect(session.sessionId).toMatch(/^fake-/);
    expect(processAlive(session.processId)).toBe(true);
    expect(session.availableModes).toContain('plan');
    const result = await session.prompt('Complete the test task');
    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toContain('# Fake ACP result');
    expect(result.artifacts).toEqual([{ kind: 'markdown', title: 'Agent response', content: result.text }]);
    expect(events.map((event) => event.type)).toEqual(['mode', 'mode', 'plan', 'message', 'message', 'artifact', 'completed']);
    await session.close();
    await session.close();
    expect(processAlive(session.processId)).toBe(false);
  });

  it('reports protocol/session readiness separately from an authenticated prompt', async () => {
    expect(await createFakeEngineAdapter({ cwd }).probe()).toEqual({
      protocolReady: true, sessionReady: true, planModeSupported: true, authenticatedPrompt: 'not_checked',
    });
  });

  it('registers a stable engine owner before launching the ACP child and records closure after group exit', async () => {
    const marker = join(cwd, 'child-started');
    const bootstrap = join(cwd, 'bootstrap.mjs');
    await writeFile(bootstrap, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started'); await import(${JSON.stringify(fixture)});`);
    const entered = deferred<void>(), release = deferred<void>();
    const records: OwnedProcessRecord[] = [];
    const opening = open({ args: ['--import', loader, bootstrap] }, {
      async onProcessStart(record) { records.push(record); entered.resolve(); await release.promise; },
      onProcessEnd(record) {
        expect(processAlive(record.pid)).toBe(false); expect(processAlive(-record.pgid)).toBe(false); records.push(record);
      },
    });
    await entered.promise;
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(records[0]).toMatchObject({ taskId: context.taskId, attemptId: context.attemptId, runId: context.runId, kind: 'engine', status: 'active' });
    release.resolve();
    const { session } = await opening;
    expect(session.processId).toBe(records[0].pid);
    expect(await readFile(marker, 'utf8')).toBe('started');
    await session.close();
    expect(records.map(record => record.status)).toEqual(['active', 'closed']);
    expect(records[1].id).toBe(records[0].id);
  });

  it('cleans startup ownership persistence failure before returning EVENT_FAILURE without launching its child', async () => {
    const marker = join(cwd, 'must-not-run');
    const bootstrap = join(cwd, 'bootstrap.mjs');
    await writeFile(bootstrap, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started'); await import(${JSON.stringify(fixture)});`);
    let owner: OwnedProcessRecord | undefined;
    const onProcessEnd = vi.fn();
    const error = await open({ args: ['--import', loader, bootstrap] }, {
      onProcessStart(record) { owner = record; throw new Error('private persistence fixture detail'); }, onProcessEnd,
    }).catch(error => error);
    expect(error).toMatchObject({ code: 'EVENT_FAILURE' });
    expect(JSON.stringify(error)).not.toContain('private persistence fixture detail');
    expect(processAlive(owner!.pid)).toBe(false); expect(processAlive(-owner!.pgid)).toBe(false);
    expect(onProcessEnd).not.toHaveBeenCalled();
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cannot launch a child when startup cancellation interrupts pending owner persistence', async () => {
    const marker = join(cwd, 'must-not-run');
    const bootstrap = join(cwd, 'bootstrap.mjs');
    await writeFile(bootstrap, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started'); await import(${JSON.stringify(fixture)});`);
    const entered = deferred<void>(), release = deferred<void>(), closed = deferred<OwnedProcessRecord>();
    const controller = new AbortController();
    context.signal = controller.signal;
    const opening = expect(open({ args: ['--import', loader, bootstrap] }, {
      async onProcessStart() { entered.resolve(); await release.promise; },
      onProcessEnd(record) { expect(processAlive(-record.pgid)).toBe(false); closed.resolve(record); },
    })).rejects.toMatchObject({ code: 'ABORTED' });
    await entered.promise;
    const start = Date.now(); controller.abort(); await opening;
    expect(Date.now() - start).toBeLessThan(3_000);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    release.resolve();
    expect((await closed.promise).status).toBe('closed');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('delivers the restrictive Claude probe options and disabled client capabilities over the actual ACP wire', async () => {
    const config = { ...createClaudeProbeConfig(cwd), args: ['--import', loader, fixture, '--require-safe-probe'] };
    expect(await createAcpEngineAdapter(config).probe()).toMatchObject({ protocolReady: true, sessionReady: true, planModeSupported: true });
  });

  it('uses only native user config while disabling exact plugin metadata keys without copying authentication values', async () => {
    const path = join(cwd, 'settings.json');
    await writeFile(path, JSON.stringify({ enabledPlugins: { 'one@example': true, 'two@example': ['1.0'] },
      env: { ANTHROPIC_AUTH_TOKEN: 'SECRET_TEST_TOKEN' }, model: 'private-model-setting', modelSettings: { token: 'SECRET_TEST_TOKEN' } }));
    const metadata = await readClaudeUserProbeMetadata(path);
    expect(metadata).toEqual({ disabledPlugins: ['one@example', 'two@example'] });
    const config = createClaudeProbeConfig(cwd, { source: 'user', ...metadata });
    expect(JSON.stringify(config)).not.toContain('SECRET_TEST_TOKEN');
    expect(JSON.stringify(config)).not.toContain('private-model-setting');
    const wireConfig = { ...config, args: ['--import', loader, fixture, '--require-safe-probe'] };
    expect(await createAcpEngineAdapter(wireConfig).probe()).toMatchObject({ sessionReady: true, planModeSupported: true });
  });

  it.each(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'proxyAuthHelper', 'gcpAuthRefresh',
    'otelHeadersHelper', 'processWrapper', 'policyHelper'])('blocks a native user profile containing executable auth helper %s', async (key) => {
    const path = join(cwd, 'settings.json');
    await writeFile(path, JSON.stringify({ [key]: 'a-command', env: { ANTHROPIC_AUTH_TOKEN: 'SECRET_TEST_TOKEN' } }));
    await expect(readClaudeUserProbeMetadata(path)).rejects.toMatchObject({ code: 'PROBE_CONFIG_UNSAFE' });
  });

  it('rejects missing plan capability and closes the engine on startup failure', async () => {
    const options = { args: ['--import', loader, fixture, '--no-plan'] };
    await expect(open(options)).rejects.toMatchObject({ code: 'MODE_UNSUPPORTED' });
    expect(await createFakeEngineAdapter({ ...options, cwd }).probe()).toMatchObject({
      protocolReady: true, sessionReady: false, planModeSupported: false, error: { code: 'MODE_UNSUPPORTED' },
    });
  });

  it('rejects failed mode selection rather than quietly using the current mode', async () => {
    await expect(open({ args: ['--import', loader, fixture, '--mode-failure'] })).rejects.toMatchObject({ code: 'ENGINE_FAILED' });
  });

  it('waits independently for permission resolution and rejects invalid or stale decisions', async () => {
    const request = deferred<EnginePermission>();
    const { session } = await open({}, { onPermission: (permission) => { request.resolve(permission); } });
    let settled = false;
    const prompt = session.prompt('fake:permission').finally(() => { settled = true; });
    const permission = await request.promise;
    expect(settled).toBe(false);
    await expect(session.resolvePermission(permission.id, 'invented-option')).rejects.toMatchObject({ code: 'PERMISSION_OPTION' });
    await session.resolvePermission(permission.id, 'allow-once');
    expect((await prompt).text).toContain('Permission: allow-once');
    await expect(session.resolvePermission(permission.id, 'allow-once')).rejects.toMatchObject({ code: 'PERMISSION_UNKNOWN' });
  });

  it('preserves complete fixture edit input, diff and absolute file locations from a stdio permission request', async () => {
    const path = join(cwd, 'safe-fixture.txt');
    await writeFile(path, 'before\n');
    const evidence = {
      kind: 'edit', rawInput: { file_path: path, old_string: 'before\n', new_string: 'after\n', replace_all: false },
      content: [
        { type: 'diff', path, oldText: 'before\n', newText: 'after\n' },
        { type: 'content', content: { type: 'text', text: 'Replace only the fixture first line.' } },
      ],
      locations: [{ path, line: 1 }],
    } satisfies NonNullable<EnginePermission['toolCall']>;
    const requested = deferred<EnginePermission>();
    const session = await openPermissionDeadlineFixture({ promptTimeoutMs: 3_000, finishAfterMs: 0,
      toolCall: { toolCallId: 'fixture-edit', title: `Edit ${path}`, ...evidence } as ToolCallUpdate,
    }, (request) => { requested.resolve(request); });
    const prompt = session.prompt('Propose a harmless fixture edit');
    const request = await requested.promise;
    expect(request).toMatchObject({ sessionId: 'deadline-session', toolCallId: 'fixture-edit', title: `Edit ${path}` });
    expect(request.toolCall).toEqual(evidence);
    expect(request.options).toEqual([
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ]);
    await session.resolvePermission(request.id, 'allow-once');
    expect((await prompt).stopReason).toBe('end_turn');
  });

  it.each(['rawInput', 'content', 'locations', 'combined'] as const)(
    'fails oversized %s permission evidence without creating a truncated approval', async (field) => {
      const path = join(cwd, 'safe-fixture.txt');
      // UTF-8 bytes, rather than JS string length, define the 128 KiB limit.
      const largeText = 'fixture-only-proposal:' + 'é'.repeat(field === 'combined' ? 40_000 : 65_536);
      const toolCall: ToolCallUpdate = { toolCallId: 'fixture-edit', title: 'Fixture-only proposal', kind: 'edit',
        ...(field === 'rawInput' || field === 'combined' ? { rawInput: { file_path: path, new_string: largeText } } : {}),
        ...(field === 'content' || field === 'combined' ? { content: [{ type: 'diff', path, oldText: 'before\n', newText: largeText }] } : {}),
        ...(field === 'locations' ? { locations: [{ path: `/${largeText}`, line: 1 }] } : {}),
      };
      const onPermission = vi.fn();
      const session = await openPermissionDeadlineFixture({ promptTimeoutMs: 3_000, finishAfterMs: 0, toolCall }, onPermission);
      const failure = await session.prompt('Propose an oversized fixture edit').catch((error: Error) => error);
      expect(failure).toMatchObject({ code: 'EVENT_FAILURE' });
      expect(JSON.stringify(failure)).not.toContain('fixture-only-proposal:');
      expect(onPermission).not.toHaveBeenCalled();
      expect(processAlive(session.processId)).toBe(false);
      await expect(session.resolvePermission('invented', 'allow-once')).rejects.toMatchObject({ code: 'PERMISSION_UNKNOWN' });
    },
  );

  it('delivers permission refusal to the engine without producing a success artifact', async () => {
    const request = deferred<EnginePermission>();
    const { session } = await open({}, { onPermission: (permission) => { request.resolve(permission); } });
    const prompt = session.prompt('fake:permission');
    await session.resolvePermission((await request.promise).id, 'reject-once');
    expect(await prompt).toMatchObject({ stopReason: 'refusal', artifacts: [] });
  });

  it('excludes human permission waiting from the active prompt deadline', async () => {
    const request = deferred<EnginePermission>();
    const { session } = await open({ promptTimeoutMs: 100 }, {
      onPermission: (permission) => { request.resolve(permission); },
    });
    let settled = false;
    const prompt = session.prompt('fake:permission').finally(() => { settled = true; });
    const permission = await request.promise;
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(settled).toBe(false);
    expect(processAlive(session.processId)).toBe(true);
    await session.resolvePermission(permission.id, 'allow-once');
    expect(await prompt).toMatchObject({ stopReason: 'end_turn' });
  });

  it.each(['allow-once', 'reject-once'])(
    'resumes only the remaining active budget after the human chooses %s', async (optionId) => {
      const request = deferred<EnginePermission>();
      const session = await openPermissionDeadlineFixture({ promptTimeoutMs: 350, activeBeforeMs: 180 },
        (permission) => { request.resolve(permission); });
      let settled = false;
      const prompt = session.prompt('Read fixture').catch((error: unknown) => error)
        .finally(() => { settled = true; });
      const permission = await request.promise;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);
      const resumedAt = performance.now();
      await session.resolvePermission(permission.id, optionId);
      expect(await prompt).toMatchObject({ code: 'PROMPT_TIMEOUT' });
      // A reset 350ms budget would violate this bound even before cleanup.
      expect(performance.now() - resumedAt).toBeLessThan(300);
      expect(processAlive(session.processId)).toBe(false);
    },
  );

  it('keeps the clock paused until every pending human permission is resolved', async () => {
    const received = deferred<EnginePermission[]>();
    const permissions: EnginePermission[] = [];
    const session = await openPermissionDeadlineFixture({ promptTimeoutMs: 100, requestCount: 2, finishAfterMs: 0 },
      (permission) => {
        permissions.push(permission);
        if (permissions.length === 2) received.resolve(permissions);
      });
    let settled = false;
    const prompt = session.prompt('Read two fixture files').finally(() => { settled = true; });
    await received.promise;
    await session.resolvePermission(permissions[0].id, 'allow-once');
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(settled).toBe(false);
    expect(processAlive(session.processId)).toBe(true);
    await session.resolvePermission(permissions[1].id, 'allow-once');
    expect(await prompt).toMatchObject({ stopReason: 'end_turn' });
  });

  it('immediately fails and cleans a hung prompt when permission persistence fails', async () => {
    const request = deferred<EnginePermission>();
    const release = deferred<void>();
    const session = await openPermissionDeadlineFixture({ promptTimeoutMs: 30 * 60_000 }, async (permission) => {
      request.resolve(permission);
      await release.promise;
      throw new Error('PRIVATE_FIXTURE_PERMISSION_PERSISTENCE_FAILURE');
    });
    let settled = false;
    const prompt = session.prompt('Read fixture').catch((error: unknown) => error)
      .finally(() => { settled = true; });
    const permission = await request.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    const failedAt = performance.now();
    release.resolve();
    const failure = await prompt;
    expect(failure).toMatchObject({ code: 'EVENT_FAILURE' });
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_FIXTURE_PERMISSION_PERSISTENCE_FAILURE');
    expect(performance.now() - failedAt).toBeLessThan(3_000);
    await expect(session.resolvePermission(permission.id, 'allow-once')).rejects.toMatchObject({ code: 'PERMISSION_UNKNOWN' });
    expect(processAlive(session.processId)).toBe(false);
    expect(processAlive(-session.processId!)).toBe(false);
  });

  it.each(['cancel', 'close'] as const)('bounds %s while the prompt deadline is paused and cannot revive it', async (action) => {
    const request = deferred<EnginePermission>();
    const release = deferred<void>();
    const { session } = await open({ promptTimeoutMs: 100 }, { async onPermission(permission) {
      request.resolve(permission);
      await release.promise;
      throw new Error('Late permission persistence failure.');
    } });
    const prompt = expect(session.prompt('fake:permission')).rejects.toMatchObject({ code: 'ABORTED' });
    const permission = await request.promise;
    await new Promise((resolve) => setTimeout(resolve, 180));
    const start = performance.now();
    const stopping = session[action]();
    release.resolve();
    await stopping;
    await prompt;
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(processAlive(session.processId)).toBe(false);
    await expect(session.resolvePermission(permission.id, 'allow-once')).rejects.toMatchObject({ code: 'PERMISSION_UNKNOWN' });
    await expect(session.prompt('Cannot reopen')).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
  });

  it('denies permission when no human resolver is connected', async () => {
    const { session } = await open();
    expect(await session.prompt('fake:permission')).toMatchObject({ stopReason: 'refusal', text: 'Permission: cancelled\n', artifacts: [] });
  });

  it('cancels while waiting for permission and invalidates the old request', async () => {
    const request = deferred<EnginePermission>();
    const { session } = await open({}, { onPermission: (permission) => { request.resolve(permission); } });
    const prompt = expect(session.prompt('fake:permission')).rejects.toMatchObject({ code: 'ABORTED' });
    const permission = await request.promise;
    await session.cancel();
    await prompt;
    expect(processAlive(session.processId)).toBe(false);
    await expect(session.resolvePermission(permission.id, 'allow-once')).rejects.toMatchObject({ code: 'PERMISSION_UNKNOWN' });
  });

  it('aborts a hung prompt, prevents prompt overlap, and makes session closure final', async () => {
    const { session } = await open();
    const controller = new AbortController();
    const prompt = expect(session.prompt('fake:hang', controller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(session.prompt('second prompt')).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    controller.abort();
    await prompt;
    expect(processAlive(session.processId)).toBe(false);
    await expect(session.prompt('third prompt')).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
  });

  it('hard-stops an engine that ignores cancellation, stdin EOF and SIGTERM before a bounded deadline', async () => {
    const { session } = await open({ promptTimeoutMs: 100 });
    const start = Date.now();
    await expect(session.prompt('fake:stubborn')).rejects.toMatchObject({ code: 'PROMPT_TIMEOUT' });
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(processAlive(session.processId)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('terminates the full process group, including a stubborn grandchild', async () => {
    const childPid = deferred<number>();
    const { session } = await open({}, { onEvent(event) {
      if (event.type === 'message' && event.text.startsWith('grandchild:')) childPid.resolve(Number(event.text.slice('grandchild:'.length)));
    } });
    const prompt = expect(session.prompt('fake:spawn-grandchild')).rejects.toMatchObject({ code: 'ABORTED' });
    const pid = await childPid.promise;
    expect(processAlive(pid)).toBe(true);
    const start = Date.now();
    await session.cancel();
    await prompt;
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(processAlive(session.processId)).toBe(false);
    expect(processAlive(pid)).toBe(false);
  });

  it('bounds startup hangs and returns a safe error if the command is missing', async () => {
    const start = Date.now();
    await expect(open({ args: ['--import', loader, fixture, '--startup-hang'], startupTimeoutMs: 100 })).rejects.toMatchObject({ code: 'STARTUP_TIMEOUT' });
    expect(Date.now() - start).toBeLessThan(3_000);
    await expect(createAcpEngineAdapter({ command: join(cwd, 'nonexistent-engine') }).open(context, { onEvent: () => {} })).rejects.toMatchObject({ code: 'ENGINE_FAILED' });
  });

  it('rejects pre-cancelled startup before spawning any engine', async () => {
    const controller = new AbortController();
    controller.abort();
    // A missing command would otherwise return ENGINE_FAILED. ABORTED must
    // win without dispatching startup effects or touching an engine process.
    const onEvent = vi.fn();
    await expect(createAcpEngineAdapter({ command: join(cwd, 'nonexistent-engine') })
      .open({ ...context, signal: controller.signal }, { onEvent })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it.each([methods.agent.initialize, methods.agent.session.new, methods.agent.session.setMode])(
    'cancels while %s is pending and verifies owned startup process cleanup', async (pendingMethod) => {
      const progressPath = join(cwd, 'startup-progress.json');
      const startupFixture = join(cwd, 'startup.mjs');
      // This independent process deliberately ignores EOF and SIGTERM, so the
      // assertion proves bounded hard cleanup, rather than just Promise.race.
      await writeFile(startupFixture, `
        import { writeFileSync } from 'node:fs';
        import { createInterface } from 'node:readline';
        process.on('SIGTERM', () => {});
        setInterval(() => {}, 1000);
        const results = ${JSON.stringify({
          [methods.agent.initialize]: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
          [methods.agent.session.new]: { sessionId: 'startup-session', modes: {
            currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }],
          } },
          [methods.agent.session.setMode]: {},
        })};
        createInterface({ input: process.stdin }).on('line', (line) => {
          const request = JSON.parse(line);
          writeFileSync(${JSON.stringify(progressPath)}, JSON.stringify({ pid: process.pid, method: request.method }));
          if (request.method === ${JSON.stringify(pendingMethod)}) return;
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: results[request.method] }) + '\\n');
        });
      `);
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      const onEvent = vi.fn();
      const adapter = createAcpEngineAdapter({ command: process.execPath, args: [startupFixture], startupTimeoutMs: 30_000 });
      const opening = expect(adapter.open({ ...context, signal: controller.signal }, { onEvent }))
        .rejects.toMatchObject({ code: 'ABORTED' });
      let pid = 0;
      await expect.poll(async () => {
        try {
          const progress = JSON.parse(await readFile(progressPath, 'utf8')) as { pid: number; method: string };
          pid = progress.pid;
          return progress.method;
        } catch { return undefined; }
      }, { timeout: 3_000 }).toBe(pendingMethod);
      expect(processAlive(pid)).toBe(true);
      const start = Date.now();
      controller.abort();
      await opening;
      expect(Date.now() - start).toBeLessThan(3_000);
      expect(processAlive(pid)).toBe(false);
      expect(onEvent).not.toHaveBeenCalled();
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    },
  );

  it('detaches the startup abort listener after opening succeeds', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    context.signal = controller.signal;
    const { session } = await open();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(processAlive(session.processId)).toBe(true);
    expect((await session.prompt('still open')).stopReason).toBe('end_turn');
  });

  it('cannot finish startup or dispatch queued modes after cancellation during event persistence', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const events: EngineEvent[] = [];
    let held = false;
    const adapter = createFakeEngineAdapter();
    const opening = expect(adapter.open({ ...context, signal: controller.signal }, { async onEvent(event) {
      events.push(event);
      if (!held) { held = true; entered.resolve(); await release.promise; }
    } })).rejects.toMatchObject({ code: 'ABORTED' });
    await entered.promise;
    controller.abort();
    release.resolve();
    await opening;
    expect(events).toEqual([{ type: 'mode', modeId: 'plan' }]);
  });

  it('redacts engine crash diagnostics and ACP authentication error data', async () => {
    const { session } = await open();
    const crash = await session.prompt('fake:error').catch((error: Error) => error);
    expect(crash).toMatchObject({ code: 'ENGINE_FAILED' });
    expect(JSON.stringify(crash)).not.toContain('SECRET_TEST_TOKEN');
    expect(JSON.stringify(crash)).not.toContain('must-not-be-exposed');
    const { session: authSession } = await open();
    const auth = await authSession.prompt('fake:auth').catch((error: Error) => error);
    expect(auth).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(JSON.stringify(auth)).not.toContain('must-not-be-exposed');
  });

  it.each(['fake:malformed', 'fake:bad-update', 'fake:coerced-update', 'fake:unknown-response'])('rejects %s without the SDK logging raw engine data', async (scenario) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { session } = await open();
      await expect(session.prompt(scenario)).rejects.toMatchObject({ code: 'ENGINE_FAILED' });
      expect(errorLog).not.toHaveBeenCalled();
      expect(warnLog).not.toHaveBeenCalled();
      expect(processAlive(session.processId)).toBe(false);
    } finally { errorLog.mockRestore(); warnLog.mockRestore(); }
  });

  it('fails the prompt if its events cannot be persisted', async () => {
    const { session } = await open({}, { onEvent(event) { if (event.type === 'message') throw new Error('Database unavailable'); } });
    await expect(session.prompt('test task')).rejects.toMatchObject({ code: 'EVENT_FAILURE' });
    expect(processAlive(session.processId)).toBe(false);
  });

  it('immediately fails and cleans a hung prompt and descendants when event persistence fails', async () => {
    const entered = deferred<void>(), release = deferred<void>();
    let descendant: number | undefined;
    const { session } = await open({ promptTimeoutMs: 30 * 60_000 }, { async onEvent(event) {
      if (event.type !== 'message') return;
      descendant = Number(event.text.match(/^grandchild:(\d+)$/)?.[1]);
      entered.resolve();
      await release.promise;
      throw new Error('PRIVATE_FIXTURE_EVENT_PERSISTENCE_FAILURE');
    } });
    const prompt = session.prompt('fake:spawn-grandchild').catch((error: unknown) => error);
    await entered.promise;
    expect(Number.isSafeInteger(descendant)).toBe(true);
    expect(processAlive(descendant)).toBe(true);
    const failedAt = performance.now();
    release.resolve();
    const failure = await prompt;
    expect(failure).toMatchObject({ code: 'EVENT_FAILURE' });
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_FIXTURE_EVENT_PERSISTENCE_FAILURE');
    expect(performance.now() - failedAt).toBeLessThan(3_000);
    expect(processAlive(session.processId)).toBe(false);
    expect(processAlive(-session.processId!)).toBe(false);
    expect(processAlive(descendant)).toBe(false);
  });

  it.each(['close', 'abort'] as const)('cannot succeed or dispatch queued artifacts when %s interrupts pending event persistence', async (action) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const events: EngineEvent[] = [];
    const controller = new AbortController();
    let held = false;
    const { session } = await open({}, { async onEvent(event) {
      events.push(event);
      if (event.type === 'message' && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
    } });
    const prompt = expect(session.prompt('test task', controller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    await entered.promise;
    // Let the independent fake finish its end_turn response while persistence
    // remains blocked, reproducing the cancellation-after-RPC race.
    await new Promise((resolve) => setTimeout(resolve, 30));
    let stopping: Promise<void> | undefined;
    if (action === 'close') stopping = session.close();
    else controller.abort();
    release.resolve();
    await stopping;
    await prompt;
    expect(events.some((event) => event.type === 'artifact' || event.type === 'completed')).toBe(false);
    expect(processAlive(session.processId)).toBe(false);
  });
});
