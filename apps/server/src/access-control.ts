import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthSecurityConfig, Device } from '@personal-agent/contracts';
import type { AuthStore } from '@personal-agent/runtime';
import type { StreamAuthorization } from './sse.js';

const invalidSecurity = (message: string) => Object.assign(new Error(message), { code: 'SECURITY_CONFIG_INVALID' });

export function validateSecurityConfig(config: AuthSecurityConfig): AuthSecurityConfig {
  let origin: URL;
  try { origin = new URL(config.publicOrigin); }
  catch { throw invalidSecurity('A fixed public origin is required for paired access'); }
  if (config.mode !== 'paired' || origin.origin !== config.publicOrigin || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash || !['https:', 'http:'].includes(origin.protocol)) {
    throw invalidSecurity('Paired access requires one exact HTTP(S) origin without a path or credentials');
  }
  if (origin.protocol !== 'https:' && !(config.allowInsecureLocalhost === true && ['127.0.0.1', 'localhost'].includes(origin.hostname))) {
    throw invalidSecurity('Insecure cookies are allowed only at an explicitly selected localhost development origin');
  }
  return { mode: 'paired', publicOrigin: origin.origin, ...(config.allowInsecureLocalhost === true ? { allowInsecureLocalhost: true } : {}) };
}

export function securityConfigFromEnv(env: Record<string, string | undefined>): AuthSecurityConfig | undefined {
  const mode = env.PERSONAL_AGENT_AUTH_MODE;
  if (mode === undefined) {
    if (env.PERSONAL_AGENT_PUBLIC_ORIGIN !== undefined || env.PERSONAL_AGENT_INSECURE_LOCALHOST !== undefined) {
      throw invalidSecurity('Partial security configuration requires explicit paired mode');
    }
    return undefined;
  }
  if (mode !== 'paired') throw invalidSecurity('PERSONAL_AGENT_AUTH_MODE must be paired or omitted');
  return validateSecurityConfig({ mode, publicOrigin: env.PERSONAL_AGENT_PUBLIC_ORIGIN ?? '',
    ...(env.PERSONAL_AGENT_INSECURE_LOCALHOST === '1' ? { allowInsecureLocalhost: true } : {}) });
}

/** Duplicate, encoded and malformed authentication cookies fail closed. */
export function readSessionCookie(header: unknown, name: string): string | undefined {
  if (typeof header !== 'string' || header.length > 4096) return undefined;
  const parts = header.split(';').map(part => part.trim());
  if (parts.some(part => ['__Host-pa-device', 'pa-device-dev'].includes(part.split('=', 1)[0]) && part.split('=', 1)[0] !== name)) return undefined;
  const values = parts.filter(part => part.split('=', 1)[0] === name);
  if (values.length !== 1) return undefined;
  const value = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicShell(path: string): boolean {
  return ['/', '/pair', '/index.html', '/favicon.ico'].includes(path) ||
    /^\/assets\/[A-Za-z0-9_-]+\.(?:js|css|svg|png|woff2?)$/.test(path);
}

interface Identity { token: string; device: Device; csrfToken: string }

const securityHeaders = {
  'Cache-Control': 'no-store', 'Vary': 'Cookie, Origin', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function singleHost(request: FastifyRequest): string | undefined {
  const hostCount = request.raw.rawHeaders.filter((_, index) => index % 2 === 0 && request.raw.rawHeaders[index].toLowerCase() === 'host').length;
  const host = request.headers.host;
  return hostCount === 1 && typeof host === 'string' ? host : undefined;
}

export interface AccessControlOptions {
  /**
   * 仅限 fake-only 演示：额外接受一个精确的 https 公网 origin（Host 与 Origin 都精确匹配）。
   * 来自该 Host 的写请求必须带同一 Origin 且为 JSON，防止跨站提交；loopback 行为不变。
   */
  demoPublicOrigin?: string;
  /** 在 /api/session 中声明 fake-only 演示，前端据此只展示 fake（服务端仍独立强制）。 */
  fakeOnlyDemo?: boolean;
}

export function installAccessControl(app: FastifyInstance, store: AuthStore, port: number, proposed?: AuthSecurityConfig, options: AccessControlOptions = {}) {
  if (proposed) store.enforcePolicy(validateSecurityConfig(proposed));
  const config = store.policy();
  if (config) validateSecurityConfig(config);
  if (config && options.demoPublicOrigin) throw Object.assign(new Error('A public demo origin cannot be combined with paired access'), { code: 'DEMO_CONFIG_INVALID' });
  const demoOrigin = options.demoPublicOrigin ? new URL(options.demoPublicOrigin) : undefined;
  const publicOrigin = config ? new URL(config.publicOrigin) : undefined;
  const cookieName = publicOrigin?.protocol === 'https:' ? '__Host-pa-device' : 'pa-device-dev';
  const identities = new WeakMap<FastifyRequest, Identity>();
  const completedSelfRevocations = new WeakSet<FastifyRequest>();
  const loopbackOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://localhost:5173', 'http://127.0.0.1:5173']);
  let windowStart = Date.now(), pairRequests = 0;

  const cookie = (token: string, clear = false) => `${cookieName}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; ${publicOrigin?.protocol === 'https:' ? 'Secure; ' : ''}Max-Age=${clear ? 0 : 2_592_000}`;

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (!config) {
      const host = singleHost(request);
      if (demoOrigin && host !== undefined && host.toLowerCase() === demoOrigin.host.toLowerCase()) {
        // 公开演示入口：不信任 X-Forwarded-*，隧道必须保留原始 Host（不要配置 httpHostHeader）。
        reply.headers(securityHeaders);
        if (origin !== undefined && origin !== demoOrigin.origin) return reply.code(403).send({ code: 'ORIGIN_REJECTED', message: 'Origin is not allowed' });
        const fetchSite = request.headers['sec-fetch-site'];
        if (fetchSite !== undefined && !['same-origin', 'none'].includes(String(fetchSite))) {
          return reply.code(403).send({ code: 'ORIGIN_REJECTED', message: 'Cross-site access is not allowed' });
        }
        if (!['GET', 'HEAD'].includes(request.method)) {
          if (origin !== demoOrigin.origin || request.method === 'OPTIONS') return reply.code(403).send({ code: 'ORIGIN_REQUIRED', message: 'Same-origin requests are required' });
          if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
            return reply.code(415).send({ code: 'JSON_REQUIRED', message: 'JSON requests are required' });
          }
        }
        return;
      }
      if (!['127.0.0.1', 'localhost'].includes(request.hostname)) return reply.code(403).send({ code: 'LOCAL_ONLY', message: 'Local development accepts loopback hosts only' });
      if (origin && !loopbackOrigins.has(origin)) return reply.code(403).send({ code: 'ORIGIN_REJECTED', message: 'Origin is not allowed' });
      return;
    }
    reply.headers(securityHeaders);
    // This service never trusts Forwarded or X-Forwarded-* headers. A proxy must
    // preserve the configured Host; TLS and its own admission remain external.
    const host = singleHost(request);
    if (host === undefined || !constantEqual(host.toLowerCase(), publicOrigin!.host.toLowerCase())) {
      return reply.code(403).send({ code: 'HOST_REJECTED', message: 'Host is not allowed' });
    }
    if (origin !== undefined && (typeof origin !== 'string' || !constantEqual(origin, config.publicOrigin))) {
      return reply.code(403).send({ code: 'ORIGIN_REJECTED', message: 'Origin is not allowed' });
    }
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite !== undefined && !['same-origin', 'none'].includes(String(fetchSite))) {
      return reply.code(403).send({ code: 'ORIGIN_REJECTED', message: 'Cross-site access is not allowed' });
    }
    const query = new URL(request.url, config.publicOrigin).searchParams;
    const secretParameters = new Set(['token', 'ticket', 'sessiontoken', 'csrftoken', 'accesstoken', 'devicetoken', 'apikey', 'authorization']);
    if ([...query.keys()].some(key => secretParameters.has(key.toLowerCase().replace(/[_-]/g, '')))) {
      return reply.code(400).send({ code: 'URL_CREDENTIAL_REJECTED', message: 'Credentials are not accepted in URL queries' });
    }
    const path = request.url.split('?', 1)[0];
    const mutation = !['GET', 'HEAD'].includes(request.method);
    if (mutation && (origin !== config.publicOrigin || request.method === 'OPTIONS')) {
      return reply.code(403).send({ code: 'ORIGIN_REQUIRED', message: 'Same-origin requests are required' });
    }
    if (mutation && request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return reply.code(415).send({ code: 'JSON_REQUIRED', message: 'JSON requests are required' });
    }
    if (path === '/api/pair' && request.method === 'POST') {
      if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); pairRequests = 0; }
      if (++pairRequests > 30) return reply.code(429).send({ code: 'PAIRING_RATE_LIMIT', message: 'Try pairing again later' });
      return;
    }
    const token = readSessionCookie(request.headers.cookie, cookieName);
    const identity = token ? store.authenticate(token) : null;
    if (token && identity) identities.set(request, { token, ...identity });
    if ((path === '/api/session' && ['GET', 'HEAD'].includes(request.method)) || (!mutation && publicShell(path))) return;
    if (!token || !identity) return reply.code(401).send({ code: 'AUTH_REQUIRED', message: 'Pair this browser to continue' });
    if (mutation && !store.validateCsrf(token, typeof request.headers['x-csrf-token'] === 'string' ? request.headers['x-csrf-token'] : '')) {
      return reply.code(403).send({ code: 'CSRF_REJECTED', message: 'Refresh this browser session before retrying' });
    }
  });

  function requireActive(request: FastifyRequest): void {
    const identity = identities.get(request);
    if (config && identity && !store.authenticate(identity.token)) {
      throw Object.assign(new Error('Pair this browser to continue'), { code: 'AUTH_REQUIRED', statusCode: 401 });
    }
  }
  app.addHook('preHandler', async request => requireActive(request));
  app.addHook('onSend', async (request, reply, payload) => {
    // Static senders can replace the headers written by onRequest.
    if (config) reply.header('Cache-Control', 'no-store');
    const identity = identities.get(request);
    if (config && identity && !completedSelfRevocations.has(request) && !store.isActive(identity.device.id)) {
      reply.code(401).type('application/json');
      return JSON.stringify({ code: 'AUTH_REQUIRED', message: 'Pair this browser to continue' });
    }
    return payload;
  });

  app.get('/api/session', async (request, reply) => {
    if (!config) return options.fakeOnlyDemo ? { mode: 'loopback', demo: 'fake' } : { mode: 'loopback' };
    const identity = identities.get(request);
    if (!identity) return reply.code(401).send({ code: 'AUTH_REQUIRED', message: 'Pair this browser to continue' });
    return { mode: 'paired', device: identity.device, csrfToken: identity.csrfToken };
  });
  app.post<{ Body: { ticket: string; name: string } }>('/api/pair', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['ticket', 'name'], properties: {
      ticket: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }, name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
    } } },
  }, async (request, reply) => {
    if (!config) return reply.code(403).send({ code: 'PAIRING_DISABLED', message: 'Pairing is not enabled for this instance' });
    const result = store.exchangeTicket(request.body.ticket, request.body.name);
    reply.header('Set-Cookie', cookie(result.sessionToken));
    return { mode: 'paired', device: result.device, csrfToken: result.csrfToken };
  });
  const commandSchema = { body: { type: 'object', additionalProperties: false, required: ['commandId'], properties: {
    commandId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' },
  } } };
  app.post<{ Body: { commandId: string } }>('/api/pair-tickets', { schema: commandSchema }, async (request, reply) => {
    const identity = identities.get(request);
    if (!identity) return reply.code(403).send({ code: 'PAIRING_DISABLED', message: 'Use the local pairing command after explicitly enabling paired access' });
    return store.issueTicket(identity.device.id, request.body.commandId);
  });
  app.get('/api/devices', async (request, reply) => {
    if (!identities.has(request)) return reply.code(403).send({ code: 'PAIRING_DISABLED', message: 'Device management requires paired access' });
    return { devices: store.devices() };
  });
  app.delete<{ Params: { id: string }; Body: { commandId: string } }>('/api/devices/:id', { schema: commandSchema }, async (request, reply) => {
    const identity = identities.get(request);
    if (!identity) return reply.code(403).send({ code: 'PAIRING_DISABLED', message: 'Device management requires paired access' });
    const result = store.revoke(request.params.id, request.body.commandId, identity.device.id);
    if (result.id === identity.device.id) { completedSelfRevocations.add(request); reply.header('Set-Cookie', cookie('', true)); }
    return result;
  });

  return {
    config,
    requireActive,
    streamAuthorization(request: FastifyRequest): StreamAuthorization | undefined {
      if (!config) return undefined;
      const identity = identities.get(request);
      if (!identity) throw Object.assign(new Error('Pair this browser to continue'), { code: 'AUTH_REQUIRED', statusCode: 401 });
      return { expiresAt: Date.parse(identity.device.expiresAt), isValid: () => !!store.authenticate(identity.token),
        subscribeInvalidation: close => store.subscribeInvalidation(id => { if (id === identity.device.id) close(); }) };
    },
  };
}
