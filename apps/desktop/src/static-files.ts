import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

/**
 * 在 app://personal-agent/ 下提供 apps/web 的构建产物（与浏览器版完全相同的文件）。
 * - 路径先解码再规范化，任何逃出根目录的路径（含符号链接）都返回 404；
 * - 无扩展名且不存在的路径回退到 index.html（单页应用）；
 * - 所有响应带 CSP：只允许同源脚本 / 连接；antd 的 CSS-in-JS 需要内联样式。
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "connect-src 'self'", "worker-src 'self' blob:", "object-src 'none'", "base-uri 'none'",
  "frame-ancestors 'none'", "form-action 'none'",
].join('; ');

const securityHeaders = (type: string) => ({
  'content-type': type, 'content-security-policy': CONTENT_SECURITY_POLICY, 'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', 'cache-control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=31536000, immutable',
});

/** 把 URL 路径映射到根目录内的文件路径；不安全时返回 undefined。 */
export function staticCandidate(root: string, pathname: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return undefined; }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const relative = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/u, '');
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, relative);
  if (target !== absoluteRoot && !target.startsWith(absoluteRoot + sep)) return undefined;
  return target;
}

async function insideRoot(root: string, file: string): Promise<boolean> {
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
    return realFile === realRoot || realFile.startsWith(realRoot + sep);
  } catch { return false; }
}

async function fileResponse(root: string, file: string, method: string): Promise<Response | undefined> {
  try {
    if (!(await stat(file)).isFile() || !(await insideRoot(root, file))) return undefined;
  } catch { return undefined; }
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const body = method === 'HEAD' ? null : new Uint8Array(await readFile(file));
  return new Response(body, { status: 200, headers: securityHeaders(type) });
}

export async function serveStatic(root: string, request: Request): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: securityHeaders('text/plain; charset=utf-8') });
  const url = new URL(request.url);
  const candidate = staticCandidate(root, url.pathname);
  if (candidate) {
    const found = await fileResponse(root, candidate, request.method);
    if (found) return found;
  }
  // 单页应用：只有“看起来是页面路由”的路径（无扩展名）才回退到 index.html；缺失的资源返回 404。
  if (candidate && !extname(url.pathname)) {
    const index = await fileResponse(root, join(resolve(root), 'index.html'), request.method);
    if (index) return index;
  }
  return new Response('Not found', { status: 404, headers: securityHeaders('text/plain; charset=utf-8') });
}
