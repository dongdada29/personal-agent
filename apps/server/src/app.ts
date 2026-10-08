import { existsSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { AuthStore, TaskRunner, TaskStore, inspectWorkspace, recoverOwnedProcesses, type EngineAdapter } from '@personal-agent/runtime';
import type { CreateTaskCommand, TaskControlCommand, InstanceSettings, AgentRole, AuthSecurityConfig } from '@personal-agent/contracts';
import { acquireInstanceLock } from './instance-lock.js';
import { createTaskEventStream } from './sse.js';
import { installAccessControl, validateSecurityConfig } from './access-control.js';

export interface AppOptions {
  dataDir: string;
  autoRun?: boolean;
  adapter?: EngineAdapter;
  realAdapter?: EngineAdapter;
  port?: number;
  webRoot?: string;
  security?: AuthSecurityConfig;
}

export async function buildApp(options: AppOptions) {
  if (options.security) validateSecurityConfig(options.security);
  const releaseLock = acquireInstanceLock(options.dataDir);
  let store!: TaskStore;
  let authStore!: AuthStore;
  try {
    store = new TaskStore(resolve(options.dataDir, 'personal-agent.sqlite'));
    authStore = new AuthStore(store.filename);
    if (options.security) authStore.enforcePolicy(validateSecurityConfig(options.security));
    const saved = authStore.policy();
    if (saved) validateSecurityConfig(saved);
  } catch (error) { authStore?.close(); store?.close(); releaseLock(); throw error; }
  let initializingRunner: TaskRunner | undefined;
  let initializingApp: ReturnType<typeof Fastify> | undefined;
  let recoveryConfirmed = false;
  try {
    if (store.list().some(task => ['running', 'waiting_human'].includes(task.status) && !task.configSnapshot &&
      !store.processes(false).some(record => record.attemptId === task.activeAttemptId))) {
      throw Object.assign(new Error('Legacy active attempt has no durable process ownership; confirm its execution stopped before upgrading'), { code: 'CLEANUP_FAILED' });
    }
    await recoverOwnedProcesses(store.processes(), record => store.closeProcess(record));
    recoveryConfirmed = true;
    store.interruptActive();
    const runner = new TaskRunner(store, options.dataDir, options.adapter, options.realAdapter);
    initializingRunner = runner;
    const taskOperations = new Map<string, Promise<unknown>>();
    async function serialTask<T>(id: string, work: () => Promise<T>): Promise<T> {
      const previous = taskOperations.get(id) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(work);
      taskOperations.set(id, current);
      try { return await current; }
      finally { if (taskOperations.get(id) === current) taskOperations.delete(id); }
    }
    const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 32_768,
      ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
    initializingApp = app;
    app.addHook('onClose', async () => {
      try { await runner.close(); }
      finally { try { authStore.close(); store.close(); } finally { if (!runner.isBlocked) releaseLock(); } }
    });
    const port = options.port ?? 47801;
    const access = installAccessControl(app, authStore, port);
    app.setErrorHandler((error, _request, reply) => {
      const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
      reply.code(status).send({ code: status === 500 ? 'INTERNAL_ERROR' : error.code ?? 'BAD_REQUEST',
        message: status === 500 ? 'Request failed' : error.message });
    });
    app.get('/api/health', async (_request, reply) => {
      if (runner.isBlocked) reply.code(503);
      return { status: runner.isBlocked ? 'blocked' : 'ok', engines: ['fake', 'claude'], phase: 4 };
    });
    app.post<{ Body: CreateTaskCommand }>('/api/tasks', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'goal'], properties: {
        commandId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' },
        goal: { type: 'string', minLength: 1, maxLength: 10_000, pattern: '\\S' },
        engine: { type: 'string', enum: ['fake', 'claude'] }, workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
        profileIds: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['planner', 'developer', 'reviewer'].map(role => [role, { type: 'string', minLength: 1, maxLength: 128 }])) },
        verificationCommands: { type: 'array', minItems: 1, maxItems: 10, items: {
          type: 'object', additionalProperties: false, required: ['command', 'args'], properties: {
            command: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^[^\\u0000]+$' },
            args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 32768, pattern: '^[^\\u0000]*$' } },
          },
        } },
      } } },
    }, async (request, reply) => {
      const replay = store.replayCreation(request.body);
      if (replay) return reply.code(200).send(replay);
      if (runner.isBlocked) return reply.code(503).send({ code: 'RUNNER_BLOCKED', message: 'Engine cleanup or persistence needs attention' });
      let baselineSha: string | undefined;
      if (request.body.engine === 'claude') {
        if (!request.body.workspaceId || !request.body.verificationCommands?.length) return reply.code(400).send({ code: 'REAL_TASK_INPUT', message: 'Claude tasks require a registered workspace and explicit verification commands' });
        const workspace = store.workspace(request.body.workspaceId);
        if (!workspace) return reply.code(400).send({ code: 'WORKSPACE_REQUIRED', message: 'Register and select a Git workspace first' });
        baselineSha = (await inspectWorkspace(workspace.path)).headSha;
      } else if (request.body.workspaceId || request.body.verificationCommands) {
        return reply.code(400).send({ code: 'FAKE_TASK_INPUT', message: 'Fake tasks do not use repositories or verification commands' });
      }
      access.requireActive(request);
      const result = store.create(request.body, baselineSha);
      reply.code(result.created ? 201 : 200);
      if (result.created && options.autoRun !== false) runner.enqueue(result.task.id);
      return result.task;
    });
    app.get('/api/tasks', async () => ({ tasks: store.list() }));
    app.get('/api/workspaces', async () => ({ workspaces: store.workspaces() }));
    app.post<{ Body: { commandId: string; name: string; path: string } }>('/api/workspaces', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'name', 'path'], properties: {
        commandId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' },
        name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' }, path: { type: 'string', minLength: 1, maxLength: 4096 },
      } } },
    }, async (request, reply) => {
      const replay = store.replayWorkspaceRegistration(request.body);
      if (replay) return reply.code(200).send(replay);
      const inspected = await inspectWorkspace(request.body.path);
      access.requireActive(request);
      reply.code(201);
      return store.registerWorkspace(inspected.path, request.body.name, request.body.commandId, request.body.path);
    });
    app.post<{ Params: { id: string }; Body: TaskControlCommand }>('/api/tasks/:id/control', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'action'], properties: {
        commandId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' },
        action: { type: 'string', enum: ['feedback', 'pause', 'takeover', 'resume', 'retry', 'cancel', 'accept', 'return'] },
        requirements: { type: 'string', minLength: 1, maxLength: 10_000, pattern: '\\S' },
      }, allOf: [
        { if: { properties: { action: { enum: ['feedback', 'return'] } } }, then: { required: ['requirements'] } },
        { if: { properties: { action: { enum: ['pause', 'resume', 'retry', 'cancel', 'accept'] } } }, then: { not: { required: ['requirements'] } } },
      ] } },
    }, async (request, reply) => serialTask(request.params.id, async () => {
      access.requireActive(request);
      const replay = store.replayControl(request.params.id, request.body);
      if (replay) return replay;
      if (runner.isBlocked) return reply.code(503).send({ code: 'RUNNER_BLOCKED', message: 'Engine cleanup or persistence needs attention' });
      const before = store.beginControl(request.params.id, request.body);
      if (request.body.action === 'cancel') await runner.cancel(before.id);
      if (request.body.action === 'takeover' || (request.body.action === 'pause' && before.status === 'waiting_human')) await runner.takeover(before.id);
      if (runner.isBlocked) return reply.code(503).send({ code: 'RUNNER_BLOCKED', message: 'Control could not confirm process exit or persistence' });
      const result = store.finishControl(before.id, request.body);
      if (result.created && ['resume', 'retry', 'return'].includes(request.body.action) && options.autoRun !== false) runner.enqueue(result.task.id);
      return result.task;
    }));
    app.get('/api/approvals', async () => ({ approvals: store.approvals() }));
    app.post<{ Params: { id: string }; Body: { commandId: string; optionId: string } }>('/api/approvals/:id/resolve', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'optionId'], properties: {
        commandId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' }, optionId: { type: 'string', minLength: 1, maxLength: 200 },
      } } },
    }, async (request) => {
      const owner = store.approval(request.params.id);
      if (!owner) throw Object.assign(new Error('Approval not found'), { statusCode: 404, code: 'APPROVAL_NOT_FOUND' });
      return serialTask(owner.taskId, async () => {
        access.requireActive(request);
        const approval = store.approval(request.params.id);
        if (approval?.status === 'pending' && !runner.canResolvePermission(approval.id)) {
          throw Object.assign(new Error('Permission is no longer attached to an active engine'), { statusCode: 409, code: 'STALE_ATTEMPT' });
        }
        const result = store.resolveApproval(request.params.id, request.body.commandId, request.body.optionId);
        await runner.resolvePermission(result.id, request.body.optionId);
        return result;
      });
    });
    app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request) => store.snapshot(request.params.id));
    const streamTaskEvents = createTaskEventStream(app, store, { authorize: request => access.streamAuthorization(request) });
    app.get<{ Params: { id: string }; Querystring: { after?: string; stream?: string } }>('/api/tasks/:id/events', {
      schema: { querystring: { type: 'object', additionalProperties: false, properties: {
        after: { type: 'string', pattern: '^(0|[1-9][0-9]{0,15})$' }, stream: { type: 'string', enum: ['1'] },
      } } },
    }, async (request, reply) => {
      store.require(request.params.id);
      if (request.query.stream === '1' || request.headers.accept?.includes('text/event-stream')) {
        return streamTaskEvents(request, reply, request.params.id, request.query.after);
      }
      const after = Number(request.query.after ?? 0);
      if (!Number.isSafeInteger(after)) return reply.code(400).send({ code: 'INVALID_EVENT_CURSOR', message: 'Event cursor must be a safe integer' });
      return { events: store.events(request.params.id, after) };
    });
    app.get<{ Params: { id: string } }>('/api/tasks/:id/artifacts', async (request) => {
      store.require(request.params.id);
      return { artifacts: store.artifacts(request.params.id) };
    });
    const commandIdSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' };
    const profileFields = {
      commandId: commandIdSchema, name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
      model: { type: 'string', maxLength: 200, pattern: '^[a-zA-Z0-9._:/-]*$' },
      instructions: { type: 'string', maxLength: 10_000 },
    };
    app.get('/api/settings', async () => store.settings());
    app.patch<{ Body: { commandId: string; defaultEngine?: InstanceSettings['defaultEngine']; agentRunTimeoutMs?: number; verificationTimeoutMs?: number } }>('/api/settings', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['commandId'], minProperties: 2, properties: {
        commandId: commandIdSchema, defaultEngine: { type: 'string', enum: ['fake', 'claude'] },
        agentRunTimeoutMs: { type: 'integer', minimum: 1000, maximum: 1_800_000 },
        verificationTimeoutMs: { type: 'integer', minimum: 1000, maximum: 1_800_000 },
      } } },
    }, async request => store.updateSettings(request.body));
    app.get('/api/agents', async () => ({ agents: store.profiles() }));
    app.post<{ Body: { commandId: string; name: string; role: AgentRole; model?: string; instructions: string } }>('/api/agents', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'name', 'role', 'instructions'], properties: {
        ...profileFields, role: { type: 'string', enum: ['planner', 'developer', 'reviewer'] },
      } } },
    }, async (request, reply) => {
      const result = store.saveProfile(request.body);
      return reply.code(201).send(result);
    });
    app.patch<{ Params: { id: string }; Body: { commandId: string; name?: string; model?: string; instructions?: string } }>('/api/agents/:id', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['commandId'], minProperties: 2, properties: profileFields } },
    }, async request => store.saveProfile(request.body, request.params.id));
    const webRoot = options.webRoot ?? resolve('apps/web/dist');
    if (existsSync(webRoot)) {
      const actualRoot = realpathSync(webRoot);
      await app.register(fastifyStatic, { root: actualRoot, dotfiles: 'deny', ...(access.config ? { cacheControl: false } : {}), allowedPath: pathname => {
        try {
          const target = realpathSync(resolve(actualRoot, `.${pathname.startsWith('/') ? pathname : `/${pathname}`}`));
          const inside = relative(actualRoot, target);
          return inside !== '..' && !inside.startsWith(`..${sep}`) && !inside.split(sep).some(part => part.startsWith('.'));
        } catch { return false; }
      } });
      app.get('/pair', async (_request, reply) => reply.sendFile('index.html'));
    }
    if (options.autoRun !== false) for (const task of store.list()) if (task.status === 'queued') runner.enqueue(task.id);
    return { app, store, authStore, runner };
  } catch (error) {
    // An unsuccessful startup must not retain ownership of an unused data directory.
    try { await initializingApp?.close(); } catch { /* original startup error is authoritative */ }
    try { await initializingRunner?.close(); } catch { /* cleanup confirmation controls the lock below */ }
    try { store.close(); } catch { /* onClose may already have closed it */ }
    try { authStore.close(); } catch { /* onClose may already have closed it */ }
    if (recoveryConfirmed && !initializingRunner?.isBlocked) releaseLock();
    throw error;
  }
}
