import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, isTemporaryConnectionFailure, request } from '../src/api';
import { authSession, notifyAuthRequired } from '../src/auth-session';

beforeEach(() => { authSession.drop(); authSession.set({ mode: 'loopback' }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); authSession.drop(); });

function abortableFetch() {
  return vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(new DOMException('Request aborted', 'AbortError'));
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener('abort', abort, { once: true });
  }));
}

describe('workbench connection recovery', () => {
  it('reports an outage without retiring a confirmed session or its generation', async () => {
    const generation = authSession.generation;
    const onLocked = vi.fn();
    const stop = authSession.subscribe(onLocked);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    try {
      const error = await api.getSession().catch((cause: unknown) => cause);
      expect(error).toMatchObject({ status: 0, code: 'NETWORK_UNAVAILABLE' });
      expect(isTemporaryConnectionFailure(error)).toBe(true);
      expect((error as Error).message).toContain('确认服务已启动');
      expect(authSession.session).toEqual({ mode: 'loopback' });
      expect(authSession.generation).toBe(generation);
      expect(onLocked).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it('keeps a confirmed session during a temporary 503 and can confirm it again on recovery', async () => {
    const generation = authSession.generation;
    const fetch = vi.fn().mockImplementationOnce(() => Promise.resolve(new Response('{"code":"SERVER_CLOSING"}', { status: 503 })))
      .mockImplementationOnce(() => Promise.resolve(new Response('{"mode":"loopback"}', { status: 200 })));
    vi.stubGlobal('fetch', fetch);
    const error = await api.getSession().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 503, code: 'SERVER_CLOSING' });
    expect(isTemporaryConnectionFailure(error)).toBe(true);
    expect(authSession.generation).toBe(generation);
    await expect(api.getSession()).resolves.toEqual({ mode: 'loopback' });
    expect(authSession.session).toEqual({ mode: 'loopback' });
  });

  it('bounds a stalled request and leaves the confirmed session available for recovery', async () => {
    vi.useFakeTimers();
    const fetch = abortableFetch();
    vi.stubGlobal('fetch', fetch);
    const result = api.getSession().catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await result;
    expect(error).toMatchObject({ status: 408, code: 'REQUEST_TIMEOUT' });
    expect(isTemporaryConnectionFailure(error)).toBe(true);
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(authSession.session).toEqual({ mode: 'loopback' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves caller cancellation instead of presenting it as a network outage', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', abortableFetch());
    const controller = new AbortController();
    const result = api.getSession(controller.signal).catch((cause: unknown) => cause);
    controller.abort();
    const error = await result;
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(isTemporaryConnectionFailure(error)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the request deadline when a successful response arrives', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"mode":"loopback"}', { status: 200 })));
    await expect(api.getSession()).resolves.toEqual({ mode: 'loopback' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a late 401 response belonging to an explicitly cancelled read', async () => {
    const generation = authSession.generation;
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const controller = new AbortController();
    const result = api.getSession(controller.signal).catch((cause: unknown) => cause);
    controller.abort();
    finish(new Response(null, { status: 401 }));
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(authSession.generation).toBe(generation);
    expect(authSession.session).toEqual({ mode: 'loopback' });
  });

  it.each(['<html>proxy response</html>', 'null', '[]', '"unexpected"'])('rejects a successful but unusable API response: %s', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const error = await request('/api/tasks').catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(isTemporaryConnectionFailure(error)).toBe(false);
  });

  it('translates actionable error codes while retaining their status and code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"code":"WORKSPACE_INVALID","message":"Git operation did not complete"}', { status: 400 })));
    await expect(api.registerWorkspace('Demo', '/missing/repo', 'register-demo')).rejects.toMatchObject({
      status: 400, code: 'WORKSPACE_INVALID', message: expect.stringContaining('仓库根目录的绝对路径'),
    });
  });

  it.each([0, 408, 429, 500, 502, 503, 504])('allows reconnecting after temporary status %s', (status) => {
    expect(isTemporaryConnectionFailure(new ApiError('Temporary', status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409])('does not mistake status %s for temporary connectivity', (status) => {
    expect(isTemporaryConnectionFailure(new ApiError('Denied', status))).toBe(false);
  });

  it('fences a late network rejection after the session has been locked', async () => {
    let reject!: (cause: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_yes, no) => { reject = no; })));
    const result = api.getSession().catch((cause: unknown) => cause);
    notifyAuthRequired();
    reject(new TypeError('Late network failure'));
    expect(await result).toMatchObject({ status: 409, code: 'SESSION_CHANGED' });
    expect(authSession.session).toBeNull();
  });
});

describe('task creation acknowledgement', () => {
  const command = { commandId: 'original-create', goal: 'Preserve this task draft', engine: 'fake' as const };
  const task = {
    ...command, id: 'original-task', status: 'queued', deliveryStatus: 'pending', pauseRequested: false,
    activeAttemptId: null, createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z',
  };

  it.each([
    {}, { ...task, id: undefined }, { ...task, id: ' ' }, { ...task, status: 'unexpected' },
    { ...task, commandId: 'another-create' }, { ...task, goal: 'Another task' },
    { ...task, deliveryStatus: 'unexpected' }, { ...task, createdAt: 'invalid' },
  ])('rejects unusable or unrelated creation receipts before acknowledging success: %j', async (receipt) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt), { status: 201 })));
    await expect(api.createTask(command)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('accepts a confirmed original creation when the same command is retried after an invalid response', async () => {
    const fetch = vi.fn().mockImplementationOnce(() => Promise.resolve(new Response('{}', { status: 201 })))
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify(task), { status: 200 })));
    vi.stubGlobal('fetch', fetch);
    await expect(api.createTask(command)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(api.createTask(command)).resolves.toEqual(task);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([command, command]);
  });
});
