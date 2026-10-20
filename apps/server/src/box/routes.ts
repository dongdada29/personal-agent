/**
 * /api/box/* 路由与 HTTP upgrade（桌面 WebSocket 代理、守护进程反向隧道）。
 *
 * 浏览器侧：
 *   GET    /api/box/deployments                      部署列表（本机 + 云端）与实时状态
 *   POST   /api/box/deployments                      添加云端主机（只保存凭据引用）
 *   DELETE /api/box/deployments/:id                  移除云端主机
 *   POST   /api/box/deployments/:id/actions          启停 VM / 容器（后台执行，返回 202）
 *   POST   /api/box/deployments/:id/tickets          为 agent 连接签发一次性注册票据
 *   POST   /api/box/deployments/:id/desktops/:d/start  启动桌面（并发上限 / 内存压力 / 预算准入）
 *   POST   /api/box/deployments/:id/desktops/:d/stop   停止桌面
 *   UPGRADE /api/box/deployments/:id/desktops/:d/vnc  noVNC 的 WebSocket：server 鉴权并终结 WebSocket，
 *          再经 box 网关（每桌面 120 秒内可重复使用的令牌）连到桌面的 unix socket，桌面从不直接暴露
 *
 * 主机守护进程侧（不使用 Cookie / CSRF / 桌面令牌，由票据或 machine 凭据鉴权）：
 *   POST   /api/box/agent/register | heartbeat | poll
 *   UPGRADE /api/box/agent/tunnel/:streamId           反向隧道（Upgrade: pa-box-tunnel）
 *   这些路径在 box 关闭时不会挂载。若 paired 实例经隧道公开，它们会暴露在公网，只靠票据/凭据保护。
 *
 * demo 实例：只有 GET 返回 fake 数据；所有写接口与 upgrade 一律 403 DEMO_FAKE_ONLY，
 * 检查放在已路由的 handler 内（与 /api/tasks 一致），编码路径变体同样会被拦截。agent 端点不挂载。
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BoxAction, CreateCloudBoxCommand } from '@personal-agent/contracts';
import { bearerToken, type UpgradeAuthorization } from '../access-control.js';
import { BoxError } from './host-adapter.js';
import { fakeBoxDeployments } from './fake-adapter.js';
import type { BoxService } from './service.js';
import type { AgentResult } from './cloud-adapters.js';

export interface BoxRouteOptions {
  /** demo 实例传 undefined：结构上不存在真实适配器。 */
  service: BoxService | undefined;
  demo: boolean;
  /** false 时不挂载 /api/box/agent/*（含隧道）。关闭 box 或 demo 时应为 false。 */
  agentRoutes?: boolean;
  authorizeUpgrade(request: IncomingMessage, kind: 'browser' | 'agent'): UpgradeAuthorization;
  requireActive(request: import('fastify').FastifyRequest): void;
}

const demoFakeOnly = { code: 'DEMO_FAKE_ONLY', message: '此公开演示只展示 fake 云电脑，不会启动、连接或代理任何真实机器。' };
const commandId = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' };
const deploymentId = '^(?:local|cloud-[a-f0-9-]{36})$';
const actions: BoxAction[] = ['start_vm', 'stop_vm', 'start_container', 'stop_container'];

const VNC_PATH = /^\/api\/box\/deployments\/(local|cloud-[a-f0-9-]{36})\/desktops\/(d[1-3])\/vnc$/;
/** 浏览器 → 桌面的单条 WebSocket 消息上限（RFB 客户端消息很小，剪贴板最大）。 */
const VNC_MAX_PAYLOAD = 4 * 1024 * 1024;
/** 发往浏览器的缓冲超过该值时暂停读取网关，防止慢客户端撑爆内存。 */
const VNC_HIGH_WATER = 8 * 1024 * 1024;
const TUNNEL_PATH = /^\/api\/box\/agent\/tunnel\/([A-Za-z0-9_-]{24})$/;

function rejectUpgrade(socket: Duplex, status: number, code: string): void {
  const reason = ({ 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' } as Record<number, string>)[status] ?? 'Error';
  const body = JSON.stringify({ code });
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/** 只接受标准 WebSocket 握手（Upgrade: websocket、合法的 Sec-WebSocket-Key、版本 13）。 */
export function isWebSocketHandshake(request: IncomingMessage): boolean {
  const headers = request.headers;
  const key = headers['sec-websocket-key'];
  return request.method === 'GET' && String(headers.upgrade ?? '').toLowerCase() === 'websocket'
    && typeof key === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(key) && headers['sec-websocket-version'] === '13';
}

/**
 * WebSocket ⇄ RFB 字节流。WebSocket 协议由 server（ws 库）终结，box 内不需要 websockify：
 * 浏览器发来的二进制消息原样写入网关流，网关流的数据作为二进制消息发回浏览器。
 */
export function bridgeWebSocket(ws: WebSocket, stream: Duplex, onActivity: () => void, onClose: () => void): void {
  let closed = false;
  let lastActivity = 0;
  const activity = () => { const now = Date.now(); if (now - lastActivity > 5_000) { lastActivity = now; onActivity(); } };
  const close = () => {
    if (closed) return;
    closed = true;
    stream.destroy();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000);
    onClose();
  };
  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (!isBinary) { ws.close(1003); return; }
    const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    activity();
    stream.write(chunk);
  });
  stream.on('data', (chunk: Buffer) => {
    activity();
    ws.send(chunk, { binary: true }, () => { if (stream.isPaused() && ws.bufferedAmount < VNC_HIGH_WATER / 2) stream.resume(); });
    if (ws.bufferedAmount > VNC_HIGH_WATER) stream.pause();
  });
  ws.once('close', close);
  ws.once('error', close);
  stream.once('close', close);
  stream.once('error', close);
  stream.resume();
}

export function installBoxRoutes(app: FastifyInstance, options: BoxRouteOptions): void {
  const { service, demo } = options;
  const agentRoutes = options.agentRoutes !== false && !!service;
  const openSockets = new Set<Duplex>();
  let closing = false;
  let registerWindow = Date.now(), registerCount = 0;

  const fail = (reply: import('fastify').FastifyReply, error: unknown) => {
    if (error instanceof BoxError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    throw error;
  };
  const real = (reply: import('fastify').FastifyReply): BoxService | undefined => {
    if (demo || !service) { void reply.code(403).send(demoFakeOnly); return undefined; }
    return service;
  };

  app.get('/api/box/deployments', async (_request, reply) => {
    if (demo || !service) return fakeBoxDeployments();
    try { return await service.list(); } catch (error) { return fail(reply, error); }
  });

  app.post<{ Body: CreateCloudBoxCommand }>('/api/box/deployments', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'name', 'connection'], properties: {
      commandId, name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
      providerLabel: { type: 'string', minLength: 1, maxLength: 64 }, connection: { type: 'string', enum: ['agent', 'ssh'] },
      endpoint: { type: 'string', minLength: 1, maxLength: 260 }, authRef: { type: 'string', minLength: 3, maxLength: 160 },
    } } },
  }, async (request, reply) => {
    const box = real(reply); if (!box) return reply;
    options.requireActive(request);
    try {
      const { deployment, created } = box.addCloud(request.body);
      return reply.code(created ? 201 : 200).send(await box.get(deployment.id));
    } catch (error) { return fail(reply, error); }
  });

  app.delete<{ Params: { id: string }; Body: { commandId: string } }>('/api/box/deployments/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: deploymentId } } },
      body: { type: 'object', additionalProperties: false, required: ['commandId'], properties: { commandId } } },
  }, async (request, reply) => {
    const box = real(reply); if (!box) return reply;
    options.requireActive(request);
    try { box.removeCloud(request.params.id); return { id: request.params.id, removed: true }; }
    catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: { id: string }; Body: { commandId: string; action: BoxAction } }>('/api/box/deployments/:id/actions', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: deploymentId } } },
      body: { type: 'object', additionalProperties: false, required: ['commandId', 'action'], properties: { commandId, action: { type: 'string', enum: actions } } } },
  }, async (request, reply) => {
    const box = real(reply); if (!box) return reply;
    options.requireActive(request);
    try { return reply.code(202).send({ id: request.params.id, operation: await box.perform(request.params.id, request.body.action) }); }
    catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: { id: string }; Body: { commandId: string } }>('/api/box/deployments/:id/tickets', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: deploymentId } } },
      body: { type: 'object', additionalProperties: false, required: ['commandId'], properties: { commandId } } },
  }, async (request, reply) => {
    const box = real(reply); if (!box) return reply;
    options.requireActive(request);
    try { return reply.code(201).send({ deploymentId: request.params.id, ...box.store.issueTicket(request.params.id) }); }
    catch (error) { return fail(reply, error); }
  });

  for (const op of ['start', 'stop'] as const) {
    app.post<{ Params: { id: string; desktopId: string }; Body: { commandId: string } }>(`/api/box/deployments/:id/desktops/:desktopId/${op}`, {
      schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: deploymentId }, desktopId: { type: 'string', pattern: '^d[1-3]$' } } },
        body: { type: 'object', additionalProperties: false, required: ['commandId'], properties: { commandId } } },
    }, async (request, reply) => {
      const box = real(reply); if (!box) return reply;
      options.requireActive(request);
      try {
        const { id, desktopId } = request.params;
        return await (op === 'start' ? box.startDesktop(id, desktopId) : box.stopDesktop(id, desktopId));
      } catch (error) { return fail(reply, error); }
    });
  }

  if (agentRoutes) {
    const hostSchema = { type: 'object', additionalProperties: true, maxProperties: 16 };
    app.post<{ Body: { ticket: string; host?: unknown; agentVersion?: string } }>('/api/box/agent/register', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['ticket'], properties: {
        ticket: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }, host: hostSchema, agentVersion: { type: 'string', maxLength: 32 },
      } } },
    }, async (request, reply) => {
      const box = real(reply); if (!box) return reply;
      if (Date.now() - registerWindow >= 60_000) { registerWindow = Date.now(); registerCount = 0; }
      if (++registerCount > 30) return reply.code(429).send({ code: 'BOX_REGISTER_RATE_LIMIT', message: 'Try again later' });
      try {
        const { deploymentId: id, credential } = box.store.register(request.body.ticket);
        return reply.code(201).send({ deploymentId: id, credential, heartbeatIntervalMs: 15_000 });
      } catch (error) { return fail(reply, error); }
    });

    const agentId = (request: import('fastify').FastifyRequest, box: BoxService) => box.store.authenticate(bearerToken(request.raw.rawHeaders));

    app.post<{ Body: { snapshot: unknown; results?: AgentResult[] } }>('/api/box/agent/heartbeat', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['snapshot'], properties: {
        snapshot: { type: 'object', maxProperties: 16 },
        results: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['id', 'ok'], properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, ok: { type: 'boolean' }, errorCode: { type: 'string', pattern: '^[A-Z_]{1,64}$' },
        } } },
      } } },
    }, async (request, reply) => {
      const box = real(reply); if (!box) return reply;
      const id = agentId(request, box);
      if (!id) return reply.code(401).send({ code: 'BOX_AGENT_UNAUTHORIZED', message: 'Machine credential is invalid' });
      box.store.heartbeat(id, request.body.snapshot);
      if (request.body.results?.length) box.broker.reportResults(id, request.body.results);
      return { ok: true, heartbeatIntervalMs: 15_000 };
    });

    app.post('/api/box/agent/poll', {
      schema: { body: { type: 'object', additionalProperties: false, properties: {} } },
    }, async (request, reply) => {
      const box = real(reply); if (!box) return reply;
      const id = agentId(request, box);
      if (!id) return reply.code(401).send({ code: 'BOX_AGENT_UNAUTHORIZED', message: 'Machine credential is invalid' });
      return { commands: await box.broker.poll(id) };
    });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: VNC_MAX_PAYLOAD, perMessageDeflate: false,
    // noVNC 请求 binary 子协议时回应；不请求时不选子协议。
    handleProtocols: protocols => protocols.has('binary') ? 'binary' : false });

  app.addHook('preClose', async () => {
    closing = true;
    for (const client of wss.clients) client.terminate();
    for (const socket of [...openSockets]) socket.destroy();
    service?.broker.close();
    wss.close();
  });

  const track = (socket: Duplex) => { openSockets.add(socket); socket.once('close', () => openSockets.delete(socket)); };

  app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const rawPath = (request.url ?? '').split('?', 1)[0];
    const vnc = VNC_PATH.exec(rawPath);
    const tunnel = agentRoutes ? TUNNEL_PATH.exec(rawPath) : null;
    if (!vnc && !tunnel) { rejectUpgrade(socket, 404, 'NOT_FOUND'); return; }
    if (closing) { rejectUpgrade(socket, 503, 'SERVER_CLOSING'); return; }
    if (demo || !service) { rejectUpgrade(socket, 403, 'DEMO_FAKE_ONLY'); return; }
    const authorization = options.authorizeUpgrade(request, tunnel ? 'agent' : 'browser');
    if (!authorization.ok) { rejectUpgrade(socket, authorization.status, authorization.code); return; }

    if (tunnel) {
      const id = service.store.authenticate(bearerToken(request.rawHeaders));
      if (!id || String(request.headers.upgrade ?? '').toLowerCase() !== 'pa-box-tunnel') { rejectUpgrade(socket, 401, 'BOX_AGENT_UNAUTHORIZED'); return; }
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: pa-box-tunnel\r\nConnection: Upgrade\r\n\r\n');
      if (head.length) socket.unshift(head);
      track(socket);
      if (!service.broker.acceptTunnel(id, tunnel[1], socket)) socket.destroy();
      return;
    }

    if (!isWebSocketHandshake(request)) { rejectUpgrade(socket, 400, 'WEBSOCKET_REQUIRED'); return; }
    const [, id, desktopId] = vnc!;
    track(socket);
    let release: (() => void) | undefined;
    let desktop: { stream: Duplex; release(): void } | undefined;
    const abort = () => { release?.(); release = undefined; desktop?.stream.destroy(); desktop?.release(); desktop = undefined; socket.destroy(); };
    let upgraded = false;
    // 握手完成前浏览器断开：释放已打开的网关流；完成后由 bridgeWebSocket 负责清理。
    socket.once('close', () => { if (desktop && !upgraded) abort(); });
    if (authorization.subscribeInvalidation) release = authorization.subscribeInvalidation(abort);
    // 先在 HTTP 层完成准入与网关握手：失败时浏览器拿到明确的 HTTP 状态码，而不是一个立即关闭的 WebSocket。
    service.openDesktopStream(id, desktopId).then(opened => {
      if (socket.destroyed) { opened.stream.destroy(); opened.release(); release?.(); return; }
      desktop = opened;
      track(opened.stream);
      wss.handleUpgrade(request, socket, head, ws => {
        upgraded = true;
        bridgeWebSocket(ws, opened.stream, () => service.touchDesktop(id, desktopId), () => { release?.(); release = undefined; opened.release(); });
        // 会话被撤销（配对设备吊销）时立即断开。
        if (authorization.subscribeInvalidation) { release?.(); release = authorization.subscribeInvalidation(() => ws.close(1008)); }
      });
    }, (error: unknown) => {
      release?.();
      rejectUpgrade(socket, error instanceof BoxError ? error.statusCode : 502, error instanceof BoxError ? error.code : 'BOX_DESKTOP_UNREACHABLE');
    });
  });
}
