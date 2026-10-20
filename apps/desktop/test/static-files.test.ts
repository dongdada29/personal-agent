import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, serveStatic, staticCandidate } from '../src/static-files.js';

let base: string, root: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'pa-desktop-static-'));
  root = join(base, 'web');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>pa</title>');
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(base, 'secret.txt'), 'outside');
  try { symlinkSync(join(base, 'secret.txt'), join(root, 'assets', 'link.txt')); } catch { /* Windows 无符号链接权限时跳过 */ }
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
const get = (path: string, method = 'GET') => serveStatic(root, new Request(`app://personal-agent${path}`, { method }));

describe('static web build over app://', () => {
  it('serves index and assets with CSP and content types', async () => {
    const index = await get('/');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*unsafe/u);
    const asset = await get('/assets/app.js');
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await asset.text()).toBe('console.log(1)');
    expect((await get('/assets/app.js', 'HEAD')).status).toBe(200);
  });

  it('falls back to index.html for routes but 404s missing assets', async () => {
    expect(await (await get('/tasks/123')).text()).toContain('<title>pa</title>');
    expect((await get('/assets/missing.js')).status).toBe(404);
    expect((await get('/', 'POST')).status).toBe(405);
  });

  it('never escapes the web root', async () => {
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/%5c..%5csecret.txt', '/%00', '/%E0%A4%A']) {
      const response = await get(path);
      expect(await response.text(), path).not.toContain('outside');
    }
    expect(staticCandidate(root, '/../secret.txt')).not.toBe(join(base, 'secret.txt'));
    expect(staticCandidate(root, '/a%5cb')).toBeUndefined();
    const link = await get('/assets/link.txt');
    expect(await link.text()).not.toContain('outside');
  });
});
