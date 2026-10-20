import type { AddressInfo } from 'node:net';
import { buildApp, type AppOptions } from './app.js';

/**
 * Electron 托管模式的服务端入口逻辑（与 IPC 解耦，便于测试）。
 *
 * 不变量：
 * - 只监听 127.0.0.1，端口由系统随机分配（port 0），绝不监听 0.0.0.0 / ::；
 * - 监听后再次读取实际地址并断言，任何偏差都立即关闭并报错；
 * - 令牌只经调用方（IPC）传入，这里不记录、不回显；
 * - 不托管静态页面（webRoot:false），页面由 Electron 主进程经 app:// 提供。
 */
export const DESKTOP_HOST = '127.0.0.1';

export interface DesktopServerOptions extends Omit<AppOptions, 'desktop' | 'webRoot' | 'port' | 'security' | 'demo'> {
  token: string;
}

export interface DesktopServer {
  port: number;
  close(): Promise<void>;
  app: Awaited<ReturnType<typeof buildApp>>['app'];
}

/** 校验实际监听地址：必须是 IPv4 回环且端口为正整数。 */
export function assertLoopbackAddress(address: string | AddressInfo | null): number {
  if (!address || typeof address === 'string' || address.address !== DESKTOP_HOST || address.family !== 'IPv4' ||
    !Number.isSafeInteger(address.port) || address.port < 1 || address.port > 65_535) {
    throw Object.assign(new Error('Desktop server is not bound to the IPv4 loopback address'), { code: 'DESKTOP_BIND_UNSAFE' });
  }
  return address.port;
}

export async function startDesktopServer(options: DesktopServerOptions): Promise<DesktopServer> {
  const { token, ...rest } = options;
  // port 只影响 loopbackOrigins（浏览器 Origin 白名单）；桌面代理会剥离 Origin，因此这里沿用默认值即可。
  const { app } = await buildApp({ ...rest, webRoot: false, desktop: { token } });
  try {
    await app.listen({ host: DESKTOP_HOST, port: 0 });
    const port = assertLoopbackAddress(app.server.address());
    let closing: Promise<void> | undefined;
    return { app, port, close: () => closing ??= app.close() };
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}
