import { describe, expect, it, vi } from 'vitest';
import type { AuthSession, Device } from '@personal-agent/contracts';
import { AuthSessionMemory, consumePairingFragment, isLocalHttpDevelopment, observePairingNavigation, pairingTicketLink, sessionExpiresIn, verifiedSession } from '../src/auth-session';

const now = Date.parse('2030-01-01T00:00:00Z');
const device: Device = { id: 'test-device', name: 'Temporary test phone', createdAt: '2029-01-01T00:00:00Z', expiresAt: '2030-01-02T00:00:00Z', revokedAt: null };
const paired: AuthSession = { mode: 'paired', device, csrfToken: 'a'.repeat(43) };

describe('pairing fragment isolation', () => {
  it('consumes a named ticket only on /pair and clears it before returning', () => {
    const replaceState = vi.fn();
    expect(consumePairingFragment({ pathname: '/pair', search: '?safe=1', hash: '#ticket=test_only-43' }, { replaceState })).toBe('test_only-43');
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/pair?safe=1');
  });
  it('clears a fragment on every other route without using its ticket or redirect', () => {
    const replaceState = vi.fn();
    expect(consumePairingFragment({ pathname: '/', search: '', hash: '#ticket=secret_test&next=https://other.invalid' }, { replaceState })).toBeNull();
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });
  it.each(['#ticket=one&ticket=two', '#ticket=https://other.invalid', '#other=test', '#ticket=%0Atest', `#ticket=${'x'.repeat(257)}`])('clears malformed or ambiguous fragments without accepting %s', (hash) => {
    const replaceState = vi.fn();
    expect(consumePairingFragment({ pathname: '/pair', search: '', hash }, { replaceState })).toBeNull();
    expect(replaceState).toHaveBeenCalledOnce();
  });
  it('does not rewrite an empty fragment', () => {
    const replaceState = vi.fn();
    expect(consumePairingFragment({ pathname: '/pair', search: '', hash: '' }, { replaceState })).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
  it('consumes a replacement ticket on same-document hash navigation before replacing the form', () => {
    const events = new EventTarget();
    const location = { pathname: '/pair', search: '', hash: '#ticket=fresh_test' };
    const replaceState = vi.fn(() => { location.hash = ''; });
    const observed: unknown[] = [];
    const stop = observePairingNavigation(events, location, { replaceState }, (ticket) => observed.push({ ticket, hash: location.hash }));
    events.dispatchEvent(new Event('hashchange'));
    expect(observed).toEqual([{ ticket: 'fresh_test', hash: '' }]);
    location.hash = '#ticket=another_test';
    events.dispatchEvent(new Event('hashchange'));
    expect(observed.at(-1)).toEqual({ ticket: 'another_test', hash: '' });
    stop();
    events.dispatchEvent(new Event('hashchange'));
    expect(observed).toHaveLength(2);
  });
  it('clears other-route fragments and clears old tickets for a blank or invalid /pair history entry', () => {
    const events = new EventTarget();
    const location = { pathname: '/', search: '', hash: '#ticket=unused_test' };
    const replaceState = vi.fn(() => { location.hash = ''; });
    const onPairPage = vi.fn();
    const stop = observePairingNavigation(events, location, { replaceState }, onPairPage);
    events.dispatchEvent(new Event('hashchange'));
    expect(replaceState).toHaveBeenCalledOnce();
    expect(onPairPage).not.toHaveBeenCalled();
    location.pathname = '/pair';
    events.dispatchEvent(new Event('popstate'));
    expect(onPairPage).toHaveBeenLastCalledWith(null);
    location.hash = '#ticket=one&ticket=two';
    events.dispatchEvent(new Event('hashchange'));
    expect(onPairPage).toHaveBeenLastCalledWith(null);
    expect(location.hash).toBe('');
    stop();
    events.dispatchEvent(new Event('popstate'));
    expect(onPairPage).toHaveBeenCalledTimes(2);
  });
  it('keeps a new ticket when a single history navigation dispatches both popstate and hashchange', () => {
    const events = new EventTarget();
    const location = { pathname: '/pair', search: '', hash: '#ticket=fresh_test' };
    const onPairPage = vi.fn();
    const stop = observePairingNavigation(events, location, { replaceState: () => { location.hash = ''; } }, onPairPage);
    events.dispatchEvent(new Event('popstate'));
    events.dispatchEvent(new Event('hashchange'));
    expect(onPairPage).toHaveBeenCalledOnce();
    expect(onPairPage).toHaveBeenCalledWith('fresh_test');
    // A separate empty-fragment navigation still retires the previous ticket.
    events.dispatchEvent(new Event('hashchange'));
    expect(onPairPage).toHaveBeenLastCalledWith(null);
    stop();
  });
});

describe('public session verification', () => {
  it('strips unneeded credentials from loopback and does not require CSRF', () => {
    expect(verifiedSession({ mode: 'loopback', csrfToken: 'must-not-retain', device }, now)).toEqual({ mode: 'loopback' });
  });
  it('accepts a complete active paired device and whitelists metadata', () => {
    const result = verifiedSession({ ...paired, device: { ...device, sessionHash: 'server-only', anotherField: 'ignore' } }, now);
    expect(result).toEqual(paired);
    expect(result.device).not.toBe(device);
  });
  it.each([
    { mode: 'paired' }, { ...paired, csrfToken: '' }, { ...paired, csrfToken: 'short' }, { ...paired, csrfToken: 'a'.repeat(44) }, { ...paired, csrfToken: 12 },
    { ...paired, csrfToken: 'test\r\nheader' }, { ...paired, device: { ...device, revokedAt: '2030-01-01T00:00:00Z' } },
    { ...paired, device: { ...device, expiresAt: 'invalid' } }, { ...paired, device: { ...device, expiresAt: '2029-12-31T00:00:00Z' } },
    { ...paired, device: { ...device, name: {} } }, { mode: 'unknown' }, null,
  ])('fails closed for invalid, revoked, expired or incomplete sessions', (value) => {
    expect(() => verifiedSession(value, now)).toThrow();
  });
});

describe('memory session lifecycle', () => {
  it('calculates a known expiry independently of a stalled session request', () => {
    expect(sessionExpiresIn(paired, now)).toBe(24 * 60 * 60 * 1000);
    expect(sessionExpiresIn(paired, Date.parse(device.expiresAt))).toBe(0);
    expect(sessionExpiresIn(paired, Date.parse(device.expiresAt) + 5000)).toBe(0);
    expect(sessionExpiresIn({ ...paired, device: { ...device, expiresAt: 'invalid' } }, now)).toBe(0);
    expect(sessionExpiresIn({ mode: 'loopback' }, now)).toBeNull();
    expect(sessionExpiresIn(null, now)).toBeNull();
  });
  it('clears cached CSRF and device before notifying invalidation listeners', () => {
    const memory = new AuthSessionMemory();
    memory.set(paired);
    const generation = memory.generation;
    const observed: unknown[] = [];
    const unsubscribe = memory.subscribe(() => observed.push(memory.session));
    memory.drop();
    expect(observed).toEqual([null]);
    expect(memory.session).toBeNull();
    expect(memory.generation).toBeGreaterThan(generation);
    unsubscribe();
    memory.drop();
    expect(observed).toHaveLength(1);
  });
  it('preserves generation during polling but changes it for another device or CSRF', () => {
    const memory = new AuthSessionMemory();
    memory.set(paired);
    const generation = memory.generation;
    memory.set({ ...paired, device: { ...device, name: 'Updated public name' } });
    expect(memory.generation).toBe(generation);
    memory.set({ ...paired, device: { ...device, id: 'other-device' } });
    expect(memory.generation).toBeGreaterThan(generation);
    const next = memory.generation;
    memory.set({ ...paired, csrfToken: 'b'.repeat(43) });
    expect(memory.generation).toBeGreaterThan(next);
  });
});

describe('ticket links and development notice', () => {
  it('keeps tickets in the fragment and retires expired/null replays', () => {
    expect(pairingTicketLink({ id: 'ticket-id', ticket: 'test_only-43', expiresAt: device.expiresAt }, 'https://agent.invalid', now)).toBe('https://agent.invalid/pair#ticket=test_only-43');
    expect(pairingTicketLink({ id: 'ticket-id', ticket: null, expiresAt: device.expiresAt }, 'https://agent.invalid', now)).toBeNull();
    expect(pairingTicketLink({ id: 'ticket-id', ticket: 'test', expiresAt: '2029-01-01T00:00:00Z' }, 'https://agent.invalid', now)).toBeNull();
    expect(pairingTicketLink({ id: 'ticket-id', ticket: 'test', expiresAt: 'bad' }, 'https://agent.invalid', now)).toBeNull();
  });
  it('labels only HTTP loopback as development', () => {
    expect(isLocalHttpDevelopment('http:', 'localhost')).toBe(true);
    expect(isLocalHttpDevelopment('http:', '127.0.0.1')).toBe(true);
    expect(isLocalHttpDevelopment('http:', '[::1]')).toBe(true);
    expect(isLocalHttpDevelopment('https:', 'localhost')).toBe(false);
    expect(isLocalHttpDevelopment('http:', 'agent.invalid')).toBe(false);
  });
});
