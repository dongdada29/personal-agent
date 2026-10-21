import { describe, expect, it } from 'vitest';
import { allowsPermission, classifyPath } from '../src/permissions.js';

describe('route permission classification', () => {
  it('treats listing devices as read and mutating client devices as pair', () => {
    expect(classifyPath('GET', '/api/devices')).toBe('read');
    expect(classifyPath('POST', '/api/pair-tickets')).toBe('pair');
    expect(classifyPath('POST', '/api/client-devices/abc/approve')).toBe('pair');
    expect(classifyPath('DELETE', '/api/client-devices/abc')).toBe('pair');
  });

  it('lets observers mint a desktop ticket but not start or stop a desktop', () => {
    expect(classifyPath('POST', '/api/box/deployments/local/desktops/d1/tickets')).toBe('read');
    expect(classifyPath('POST', '/api/box/deployments/local/desktops/d1/start')).toBe('write');
    expect(classifyPath('POST', '/api/box/deployments/local/desktops/d1/stop')).toBe('write');
    expect(classifyPath('GET', '/api/box/deployments')).toBe('read');
  });

  it('only operators may write or pair', () => {
    expect(allowsPermission('observer', 'read')).toBe(true);
    expect(allowsPermission('observer', 'write')).toBe(false);
    expect(allowsPermission('observer', 'pair')).toBe(false);
    expect(allowsPermission('operator', 'write')).toBe(true);
    expect(allowsPermission(undefined, 'write')).toBe(true);
  });
});
