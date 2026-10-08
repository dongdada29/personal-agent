import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, request } from '../src/api';
import { authSession, notifyAuthRequired } from '../src/auth-session';

const paired = { mode: 'paired' as const, csrfToken: 'a'.repeat(43), device: { id: 'test-device', name: 'Temporary phone', createdAt: '2029-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null } };
const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => { authSession.drop(); });
afterEach(() => { vi.unstubAllGlobals(); authSession.drop(); });

describe('authenticated browser requests', () => {
  it('cannot send an in-memory CSRF header to an external address', async () => {
    authSession.set(paired);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(request('https://other.invalid/api/tasks', { method: 'POST' })).rejects.toMatchObject({ code: 'INVALID_API_URL' });
    await expect(request('//other.invalid/api/tasks', { method: 'POST' })).rejects.toMatchObject({ code: 'INVALID_API_URL' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('attaches in-memory CSRF and same-origin cookies to every JSON mutation', async () => {
    authSession.set(paired);
    const fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => Promise.resolve(ok(url === '/api/tasks' ? {
      ...JSON.parse(String(init.body)), id: 'test-task', status: 'queued', deliveryStatus: 'pending',
      createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z',
    } : {})));
    vi.stubGlobal('fetch', fetch);
    await api.createTask({ commandId: 'test-command', goal: 'Temporary fake', engine: 'fake' });
    await api.updateSettings({ commandId: 'test-settings', defaultEngine: 'fake' });
    await api.revokeDevice('other-device', { commandId: 'test-revoke' });
    for (const [url, init] of fetch.mock.calls) {
      const headers = new Headers(init.headers);
      expect(headers.get('X-CSRF-Token')).toBe('a'.repeat(43));
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(init.credentials).toBe('same-origin');
      expect(init.redirect).toBe('error');
      expect(String(url)).not.toContain('a'.repeat(43));
    }
  });
  it('does not attach CSRF to readonly requests or loopback mutations', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(ok({})));
    vi.stubGlobal('fetch', fetch);
    authSession.set(paired);
    await api.listDevices();
    expect(new Headers(fetch.mock.calls[0][1].headers).has('X-CSRF-Token')).toBe(false);
    authSession.set({ mode: 'loopback' });
    await request('/api/tasks', { method: 'POST', headers: { 'X-CSRF-Token': 'stale-test-token' }, body: '{}' });
    expect(new Headers(fetch.mock.calls[1][1].headers).has('X-CSRF-Token')).toBe(false);
  });
  it('can explicitly pair from a locked gate without CSRF', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(paired));
    vi.stubGlobal('fetch', fetch);
    await api.pairDevice('temporary_test_ticket', 'Temporary phone');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/pair');
    expect(new Headers(init.headers).has('X-CSRF-Token')).toBe(false);
    expect(JSON.parse(init.body)).toEqual({ ticket: 'temporary_test_ticket', name: 'Temporary phone' });
    expect(authSession.session).toBeNull();
  });
  it('fails before network IO for a paired mutation missing CSRF', async () => {
    authSession.set({ ...paired, csrfToken: undefined });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(api.createPairTicket({ commandId: 'temporary-command' })).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(fetch).not.toHaveBeenCalled();
    expect(authSession.session).toBeNull();
  });
  it('broadcasts 401 and drops memory before reading a potentially sensitive body', async () => {
    authSession.set(paired);
    const json = vi.fn().mockRejectedValue(new Error('Body must not be read'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401, ok: false, json }));
    const observed: unknown[] = [];
    const unsubscribe = authSession.subscribe(() => observed.push(authSession.session));
    try {
      await expect(api.listTasks()).rejects.toBeInstanceOf(ApiError);
      expect(observed).toEqual([null]);
      expect(json).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });
  it('rejects late protected data after the gate is locked', async () => {
    authSession.set(paired);
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const pending = api.listTasks();
    notifyAuthRequired();
    finish(ok({ tasks: [{ id: 'must-not-return' }] }));
    await expect(pending).rejects.toMatchObject({ status: 409, code: 'SESSION_CHANGED' });
    expect(authSession.session).toBeNull();
  });
  it('rejects data from the old device after another session becomes active', async () => {
    authSession.set(paired);
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const pending = api.listTasks();
    authSession.set({ ...paired, device: { ...paired.device, id: 'new-device' }, csrfToken: 'b'.repeat(43) });
    finish(ok({ tasks: [{ id: 'old-device-data' }] }));
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(authSession.session?.device?.id).toBe('new-device');
  });
  it('does not let a late old-session 401 lock a newly paired device', async () => {
    authSession.set(paired);
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const pending = api.listTasks();
    notifyAuthRequired();
    authSession.set({ ...paired, device: { ...paired.device, id: 'new-device' }, csrfToken: 'b'.repeat(43) });
    finish(new Response(null, { status: 401 }));
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(authSession.session?.device?.id).toBe('new-device');
  });
  it('discards a response whose JSON parsing outlives an invalidated session', async () => {
    authSession.set(paired);
    let finish!: (body: unknown) => void;
    const body = new Promise<unknown>((resolve) => { finish = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true, json: () => body }));
    const pending = api.getSession();
    await Promise.resolve();
    notifyAuthRequired();
    finish(paired);
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(authSession.session).toBeNull();
  });
  it('keeps structured error status for non-auth API failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'COMMAND_CONFLICT', message: 'Conflict' }), { status: 409 })));
    await expect(api.listTasks()).rejects.toMatchObject({ status: 409, code: 'COMMAND_CONFLICT', message: 'Conflict' });
  });
});
