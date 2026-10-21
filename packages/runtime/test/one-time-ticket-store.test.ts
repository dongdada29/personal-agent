import { describe, expect, it } from 'vitest';
import { createOneTimeTicketStore } from '../src/one-time-ticket-store.js';

describe('one-time ticket store', () => {
  it('mints a 32-byte token and consumes it only once', () => {
    const store = createOneTimeTicketStore<{ owner: string }>({ ttlMs: 60_000 });
    const minted = store.mint({ owner: 'a' });
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.consume(minted.token)).toEqual({ owner: 'a' });
    expect(store.consume(minted.token)).toBeUndefined();
    store.clear();
  });

  it('rejects expired tickets using a fake clock', () => {
    let now = 1_000_000;
    const store = createOneTimeTicketStore<{ n: number }>({ ttlMs: 60_000, now: () => now });
    const minted = store.mint({ n: 1 });
    now += 60_000;
    expect(store.consume(minted.token, now)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('leaves the ticket in place when accept() does not match', () => {
    const store = createOneTimeTicketStore<{ deviceId: string }>({ ttlMs: 60_000 });
    const minted = store.mint({ deviceId: 'abc' });
    expect(store.consume(minted.token, undefined, payload => payload.deviceId === 'other')).toBeUndefined();
    expect(store.consume(minted.token, undefined, payload => payload.deviceId === 'abc')).toEqual({ deviceId: 'abc' });
    store.clear();
  });

  it('rejects malformed tokens without throwing', () => {
    const store = createOneTimeTicketStore<null>({ ttlMs: 1_000 });
    expect(store.consume('short')).toBeUndefined();
    expect(store.consume('x'.repeat(43))).toBeUndefined();
    store.clear();
  });
});
