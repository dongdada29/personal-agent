import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { readSessionCookie, securityConfigFromEnv, validateSecurityConfig } from '../src/access-control.js';

const origin = 'https://agent.example';
const baseHeaders = { host: 'agent.example', origin };
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const instances: { app: Awaited<ReturnType<typeof buildApp>>['app']; dir: string }[] = [];
async function fixture(web = false) {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-auth-http-'));
  const webRoot = join(dir, 'web');
  if (web) {
    mkdirSync(join(webRoot, 'assets'), { recursive: true });
    writeFileSync(join(webRoot, 'index.html'), '<html>Public application shell</html>');
    writeFileSync(join(webRoot, 'assets', 'app-test.js'), 'console.log("public asset")');
    writeFileSync(join(webRoot, '.env'), 'DIST_SECRET');
    writeFileSync(join(webRoot, 'private.json'), '{"test":"PRIVATE_DIST_CONTENT"}');
    writeFileSync(join(dir, 'outside.txt'), 'OUTSIDE_PRIVATE');
    symlinkSync(join(dir, 'outside.txt'), join(webRoot, 'assets', 'outside.js'));
  }
  const result = await buildApp({ dataDir: dir, autoRun: false, webRoot, security: { mode: 'paired', publicOrigin: origin } });
  instances.push({ app: result.app, dir });
  return { ...result, dir };
}
async function pair(result: Awaited<ReturnType<typeof fixture>>, name = 'Temporary test browser') {
  const ticket = result.authStore.issueTicket();
  const response = await result.app.inject({ method: 'POST', url: '/api/pair', headers: baseHeaders, payload: { ticket: ticket.ticket, name } });
  expect(response.statusCode).toBe(200);
  const cookie = String(response.headers['set-cookie']).split(';', 1)[0];
  return { cookie, device: response.json().device, csrf: response.json().csrfToken, response,
    headers: { ...baseHeaders, cookie, 'x-csrf-token': response.json().csrfToken } };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { app, dir } of instances.splice(0)) { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

describe('paired HTTP access boundary', () => {
  it('hides every existing API, SSE, artifact, unknown path and HEAD before authentication', async () => {
    const result = await fixture();
    const task = result.store.create({ commandId: 'secret-task', goal: 'PRIVATE_TASK_GOAL' }).task;
    const urls = ['/api/health', '/api/tasks', `/api/tasks/${task.id}`, `/api/tasks/${task.id}/events?stream=1`,
      `/api/tasks/${task.id}/artifacts`, '/api/artifacts/private', '/api/approvals', '/api/settings', '/api/agents',
      '/api/workspaces', '/api/devices', '/api/unknown', '/private-file', '/api/session'];
    for (const url of urls) for (const method of ['GET', 'HEAD'] as const) {
      const response = await result.app.inject({ url, method, headers: baseHeaders });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.body).not.toMatch(/PRIVATE_TASK_GOAL|personal-agent.sqlite|worktreePath|session_hash|csrf_hash/);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    for (const [url, method] of [['/api/tasks', 'POST'], [`/api/tasks/${task.id}/control`, 'POST'], ['/api/approvals/private/resolve', 'POST'],
      ['/api/settings', 'PATCH'], ['/api/agents/private', 'PATCH'], ['/api/workspaces', 'POST'], ['/api/devices/private', 'DELETE']] as const) {
      const response = await result.app.inject({ url, method, headers: baseHeaders, payload: { commandId: 'no-auth', goal: 'forbidden' } });
      expect(response.statusCode).toBe(401);
    }
    expect(result.store.list()).toHaveLength(1);
    expect(result.store.events(task.id)).toHaveLength(1);
  });

  it('exchanges once, uses a host-only secure cookie and exposes no bearer secrets', async () => {
    const result = await fixture();
    const session = await pair(result);
    expect(session.response.headers['set-cookie']).toMatch(/^__Host-pa-device=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=2592000$/);
    expect(session.response.body).not.toMatch(/sessionToken|session_hash|csrf_hash|ticket_hash/);
    const info = await result.app.inject({ url: '/api/session', headers: session.headers });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toEqual({ mode: 'paired', device: session.device, csrfToken: session.csrf });
    expect((await result.app.inject({ url: '/api/devices', headers: session.headers })).json()).toEqual({ devices: [session.device] });
    expect((await result.app.inject({ url: '/api/health', headers: session.headers })).json().status).toBe('ok');
  });

  it.each([undefined, 'null', 'https://evil.example', 'https://sibling.agent.example', 'https://agent.example, https://evil.example'])('rejects mutation Origin %s before any ticket is consumed', async badOrigin => {
    const result = await fixture();
    const ticket = result.authStore.issueTicket();
    const response = await result.app.inject({ method: 'POST', url: '/api/pair', headers: { host: 'agent.example', ...(badOrigin ? { origin: badOrigin } : {}) },
      payload: { ticket: ticket.ticket, name: 'Invalid origin test' } });
    expect(response.statusCode).toBe(403);
    expect(result.authStore.devices()).toEqual([]);
    const good = await result.app.inject({ method: 'POST', url: '/api/pair', headers: baseHeaders, payload: { ticket: ticket.ticket, name: 'Good' } });
    expect(good.statusCode).toBe(200);
  });

  it('requires JSON, rejects Fetch-Metadata cross-site and never trusts forwarded identity', async () => {
    const result = await fixture();
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded']) {
      expect((await result.app.inject({ method: 'POST', url: '/api/pair', headers: { ...baseHeaders, 'content-type': contentType }, payload: 'ticket=invalid' })).statusCode).toBe(415);
    }
    for (const fetchSite of ['cross-site', 'same-site']) expect((await result.app.inject({ url: '/api/session', headers: { ...baseHeaders, 'sec-fetch-site': fetchSite } })).statusCode).toBe(403);
    expect((await result.app.inject({ url: '/api/session', headers: { ...baseHeaders, host: 'evil.example', 'x-forwarded-host': 'agent.example', 'x-forwarded-proto': 'https', forwarded: 'host=agent.example;proto=https' } })).statusCode).toBe(403);
    const session = await pair(result);
    expect((await result.app.inject({ url: '/api/health', headers: { ...session.headers, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', forwarded: 'host=evil.example;proto=http' } })).statusCode).toBe(200);
    expect((await result.app.inject({ url: '/api/session', headers: { ...session.headers, origin: 'https://evil.example' } })).statusCode).toBe(403);
  });

  it('requires the current device CSRF for every mutation and never accepts it as a session', async () => {
    const result = await fixture(), first = await pair(result, 'First'), second = await pair(result, 'Second');
    for (const csrf of ['', 'x', second.csrf, first.cookie.split('=')[1]]) {
      const response = await result.app.inject({ method: 'POST', url: '/api/tasks', headers: { ...first.headers, 'x-csrf-token': csrf }, payload: { commandId: 'bad-csrf', goal: 'Forbidden' } });
      expect(response.statusCode).toBe(403);
    }
    expect((await result.app.inject({ url: '/api/health', headers: { ...baseHeaders, cookie: `__Host-pa-device=${first.csrf}` } })).statusCode).toBe(401);
    const task = await result.app.inject({ method: 'POST', url: '/api/tasks', headers: { ...first.headers, 'sec-fetch-site': 'same-origin' }, payload: { commandId: 'good-csrf', goal: 'Authorized fake' } });
    expect(task.statusCode).toBe(201);
    expect(result.store.list()).toHaveLength(1);
  });

  it('rejects duplicate, encoded, wrong-mode and query bearer credentials', async () => {
    const result = await fixture(), session = await pair(result);
    const token = session.cookie.split('=')[1];
    for (const cookie of [`${session.cookie}; ${session.cookie}`, `__Host-pa-device=%${token}`, `pa-device-dev=${token}`, `${session.cookie}; pa-device-dev=${token}`, '__Host-pa-device=']) {
      expect((await result.app.inject({ url: '/api/tasks', headers: { ...baseHeaders, cookie } })).statusCode).toBe(401);
    }
    expect((await result.app.inject({ url: '/api/tasks', headers: { ...baseHeaders, authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    for (const url of [`/api/tasks?token=${token}`, '/api/session?csrfToken=x', '/pair?ticket=x', '/api/tasks?ACCESS_TOKEN=x']) {
      expect((await result.app.inject({ url, headers: session.headers })).statusCode).toBe(400);
      expect((await result.app.inject({ url, headers: baseHeaders })).statusCode).toBe(400);
    }
    expect(readSessionCookie(undefined, '__Host-pa-device')).toBeUndefined();
  });

  it('rejects an expired cookie at the HTTP boundary and exposes no stale task content', async () => {
    const result = await fixture(), session = await pair(result);
    const task = result.store.create({ commandId: 'expiry-goal', goal: 'EXPIRY_PRIVATE_GOAL' }).task;
    const database = new DatabaseSync(result.store.filename);
    database.prepare('UPDATE devices SET expires_at=? WHERE id=?').run(Date.now() - 1, session.device.id);
    database.close();
    for (const url of ['/api/session', `/api/tasks/${task.id}`, `/api/tasks/${task.id}/events?stream=1`, '/api/settings']) {
      const response = await result.app.inject({ url, headers: session.headers });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('EXPIRY_PRIVATE_GOAL');
    }
    expect((await result.app.inject({ method: 'POST', url: '/api/tasks', headers: session.headers, payload: { commandId: 'after-expiry', goal: 'Denied' } })).statusCode).toBe(401);
    expect(result.store.list()).toHaveLength(1);
  });

  it('uniformly rejects consumed, missing and expired tickets without setting a cookie', async () => {
    const result = await fixture(), ticket = result.authStore.issueTicket();
    const first = await result.app.inject({ method: 'POST', url: '/api/pair', headers: baseHeaders, payload: { ticket: ticket.ticket, name: 'First' } });
    expect(first.statusCode).toBe(200);
    const responses = [];
    for (const value of [ticket.ticket, 'A'.repeat(43)]) responses.push(await result.app.inject({ method: 'POST', url: '/api/pair', headers: baseHeaders, payload: { ticket: value, name: 'Repeat' } }));
    for (const response of responses) { expect(response.statusCode).toBe(400); expect(response.json().code).toBe('PAIRING_INVALID'); expect(response.headers['set-cookie']).toBeUndefined(); }
    expect(responses[0].body).toBe(responses[1].body);
    expect(result.authStore.devices()).toHaveLength(1);
  });

  it('issues only metadata on command replay and atomically revokes a browser and its outstanding tickets', async () => {
    const result = await fixture(), admin = await pair(result, 'Admin'), victim = await pair(result, 'Victim');
    const issue = await result.app.inject({ method: 'POST', url: '/api/pair-tickets', headers: victim.headers, payload: { commandId: 'one-ticket' } });
    const again = await result.app.inject({ method: 'POST', url: '/api/pair-tickets', headers: victim.headers, payload: { commandId: 'one-ticket' } });
    expect(issue.json().ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(again.json()).toEqual({ ...issue.json(), ticket: null });
    const revoke = await result.app.inject({ method: 'DELETE', url: `/api/devices/${victim.device.id}`, headers: admin.headers, payload: { commandId: 'revoke-victim' } });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().revokedAt).toBeTypeOf('string');
    expect((await result.app.inject({ url: '/api/tasks', headers: victim.headers })).statusCode).toBe(401);
    expect((await result.app.inject({ method: 'POST', url: '/api/pair', headers: baseHeaders, payload: { ticket: issue.json().ticket, name: 'Revoked issuer' } })).statusCode).toBe(400);
    expect((await result.app.inject({ url: '/api/tasks', headers: admin.headers })).statusCode).toBe(200);
    expect((await result.app.inject({ method: 'DELETE', url: `/api/devices/${admin.device.id}`, headers: admin.headers, payload: { commandId: 'revoke-self' } })).headers['set-cookie']).toMatch(/Max-Age=0/);
    expect((await result.app.inject({ url: '/api/session', headers: admin.headers })).statusCode).toBe(401);
  });

  it('does not execute a queued control after its device was revoked', async () => {
    const result = await fixture(), session = await pair(result);
    const task = result.store.create({ commandId: 'queue-task', goal: 'Keep unchanged' }).task;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const takeover = vi.spyOn(result.runner, 'takeover').mockImplementation(async () => { await gate; });
    const first = result.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/control`, headers: session.headers, payload: { commandId: 'first-control', action: 'takeover' } });
    await vi.waitFor(() => expect(takeover).toHaveBeenCalledOnce());
    const queued = result.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/control`, headers: session.headers, payload: { commandId: 'revoked-queued', action: 'feedback', requirements: 'MUST_NOT_PERSIST' } });
    await new Promise(resolve => setImmediate(resolve));
    result.authStore.revoke(session.device.id, 'direct-test-revoke', session.device.id);
    release();
    expect((await queued).statusCode).toBe(401);
    await first;
    expect(result.store.get(task.id)?.instructions?.some(value => value.requirements === 'MUST_NOT_PERSIST')).not.toBe(true);
  });

  it('serves only safe public shell/assets, blocks symlinks/dotfiles, and sets browser protection headers', async () => {
    const result = await fixture(true);
    for (const url of ['/', '/pair', '/assets/app-test.js']) {
      const response = await result.app.inject({ url, headers: baseHeaders });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    for (const url of ['/.env', '/assets/../outside.txt', '/assets/%2e%2e/.env', '/assets/outside.js']) {
      const response = await result.app.inject({ url, headers: baseHeaders });
      expect([401, 403, 404]).toContain(response.statusCode);
      expect(response.body).not.toMatch(/DIST_SECRET|OUTSIDE_PRIVATE/);
    }
    const session = await pair(result);
    expect((await result.app.inject({ url: '/private.json', headers: baseHeaders })).statusCode).toBe(401);
    const privateFile = await result.app.inject({ url: '/private.json', headers: session.headers });
    expect(privateFile.statusCode).toBe(200);
    expect(privateFile.headers['cache-control']).toBe('no-store');
    expect((await result.app.inject({ url: '/assets/outside.js', headers: session.headers })).body).not.toContain('OUTSIDE_PRIVATE');
    expect((await result.app.inject({ url: '/.env', headers: session.headers })).body).not.toContain('DIST_SECRET');
  });

  it('retains paired protection on restart without environment and refuses policy downgrade', async () => {
    const result = await fixture(), session = await pair(result);
    await result.app.close();
    const reopened = await buildApp({ dataDir: result.dir, autoRun: false, webRoot: join(result.dir, 'absent') });
    instances.push({ app: reopened.app, dir: result.dir });
    expect((await reopened.app.inject({ url: '/api/tasks', headers: baseHeaders })).statusCode).toBe(401);
    expect((await reopened.app.inject({ url: '/api/tasks', headers: session.headers })).statusCode).toBe(200);
    await reopened.app.close();
    await expect(buildApp({ dataDir: result.dir, autoRun: false, security: { mode: 'paired', publicOrigin: 'http://localhost:47801', allowInsecureLocalhost: true } })).rejects.toMatchObject({ code: 'SECURITY_POLICY_CONFLICT' });
  });

  it('uses a separate insecure cookie only at an explicitly enabled exact localhost origin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'personal-agent-dev-cookie-'));
    const result = await buildApp({ dataDir: dir, autoRun: false, port: 47812, webRoot: join(dir, 'absent'), security: { mode: 'paired', publicOrigin: 'http://localhost:47812', allowInsecureLocalhost: true } });
    instances.push({ app: result.app, dir });
    const ticket = result.authStore.issueTicket();
    const response = await result.app.inject({ method: 'POST', url: '/api/pair', headers: { host: 'localhost:47812', origin: 'http://localhost:47812' }, payload: { ticket: ticket.ticket, name: 'Explicit temporary dev' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toMatch(/^pa-device-dev=/);
    expect(response.headers['set-cookie']).not.toContain('Secure');
  });
});

describe('security configuration validation', () => {
  it.each(['http://agent.example', 'http://localhost.evil.example', 'https://user:pass@agent.example', 'https://agent.example/path', 'https://agent.example?secret=x', 'https://agent.example#x', 'file:///tmp/file', 'https://agent.example/', 'https://agent.example:443'])('rejects noncanonical or unsafe origin %s', publicOrigin => {
    expect(() => validateSecurityConfig({ mode: 'paired', publicOrigin, allowInsecureLocalhost: true })).toThrow();
  });
  it('requires explicit paired mode and HTTP development opt-in', () => {
    expect(securityConfigFromEnv({})).toBeUndefined();
    expect(() => securityConfigFromEnv({ PERSONAL_AGENT_AUTH_MODE: 'loopback' })).toThrow();
    expect(() => securityConfigFromEnv({ PERSONAL_AGENT_AUTH_MODE: 'paired' })).toThrow();
    expect(() => securityConfigFromEnv({ PERSONAL_AGENT_PUBLIC_ORIGIN: origin })).toThrow();
    expect(() => securityConfigFromEnv({ PERSONAL_AGENT_INSECURE_LOCALHOST: '1' })).toThrow();
    expect(() => validateSecurityConfig({ mode: 'paired', publicOrigin: 'http://localhost:47801' })).toThrow();
    expect(validateSecurityConfig({ mode: 'paired', publicOrigin: origin })).toEqual({ mode: 'paired', publicOrigin: origin });
  });
});
