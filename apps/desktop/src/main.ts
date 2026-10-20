import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, protocol, shell, type MenuItemConstructorOptions } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadSettings, saveSettings, defaultDataDir, type DesktopSettings } from './config.js';
import { parseConnectUrl, probeInstance } from './connect-mode.js';
import { APP_HOST, APP_ORIGIN, APP_SCHEME, proxyRequest, type UpstreamTarget } from './proxy.js';
import { ServerStartError, ServerSupervisor } from './server-supervisor.js';
import { serveStatic } from './static-files.js';
import { openVncBridge } from './vnc-bridge.js';

/**
 * Personal Agent 桌面客户端主进程。
 *
 * 两种模式：
 * - managed（默认）：fork 打包的 server（Electron 自带 Node），监听 127.0.0.1 随机端口，令牌只经 IPC；
 * - connect：连接本机已运行的 loopback 实例（默认 http://127.0.0.1:47801），不启动 server。
 * 渲染进程只加载 app://personal-agent/，所有 /api 请求由主进程同源代理，渲染进程看不到端口或令牌。
 */

// 必须在 app ready 之前注册：standard + secure 让 app:// 拥有正常的同源语义，stream 支持 SSE。
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true, corsEnabled: false,
} }]);

const resourcesDir = () => app.getAppPath();
const webRoot = () => join(resourcesDir(), 'dist', 'web');
/** server 包在 asarUnpack 中（子进程以普通文件方式执行，任务子进程也要能读取 owner 包装脚本）。 */
const serverEntry = () => {
  const unpacked = join(resourcesDir().replace(/app\.asar$/u, 'app.asar.unpacked'), 'dist', 'server', 'desktop-main.mjs');
  return existsSync(unpacked) ? unpacked : join(resourcesDir(), 'dist', 'server', 'desktop-main.mjs');
};
const settingsFile = () => join(app.getPath('userData'), 'desktop-settings.json');

let settings: DesktopSettings;
let supervisor: ServerSupervisor | undefined;
let target: UpstreamTarget | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting: Promise<void> | undefined;
let quitReady = false;
const bridges = new Set<() => void>();

const startupHints: Record<string, string> = {
  INSTANCE_LOCKED: '该数据目录已被另一个 Personal Agent 服务占用（例如正在运行的 npm run dev）。可以切换到“连接已有实例”模式。',
  DESKTOP_CONFIG_INVALID: '该数据目录配置了 paired（远程配对）访问策略，桌面托管模式不能与之叠加。请改用连接模式或另一个数据目录。',
  CLEANUP_FAILED: '启动时无法确认上次遗留的任务进程已清理。请保留数据目录并检查进程后重试。',
  PROCESS_UNSUPPORTED: '当前平台不支持任务进程托管。',
  EADDRINUSE: '无法在本机回环地址上监听端口。',
  DESKTOP_SERVER_TIMEOUT: '本机服务启动超时。',
};

async function stopServer(): Promise<void> {
  for (const close of [...bridges]) close();
  bridges.clear();
  target = undefined;
  const current = supervisor;
  supervisor = undefined;
  if (current) await current.stop();
}

async function startManaged(): Promise<boolean> {
  const next = new ServerSupervisor({ entry: serverEntry(), dataDir: settings.dataDir ?? defaultDataDir() });
  supervisor = next;
  next.on('unexpected-exit', () => {
    if (supervisor !== next || quitting) return;
    target = undefined;
    void dialog.showMessageBox({ type: 'error', title: 'Personal Agent', message: '本机服务意外退出。', detail: next.diagnostics().slice(-5).join('\n'),
      buttons: ['重新启动', '退出'], defaultId: 0, cancelId: 1 }).then(async ({ response }) => {
      if (response === 0) { await stopServer(); if (await startManaged()) mainWindow?.reload(); } else app.quit();
    });
  });
  try {
    const port = await next.start();
    target = { port, token: next.token };
    return true;
  } catch (error) {
    const code = error instanceof ServerStartError ? error.code : 'STARTUP_FAILED';
    await stopServer();
    const { response } = await dialog.showMessageBox({ type: 'error', title: 'Personal Agent', message: `本机服务无法启动（${code}）`,
      detail: startupHints[code] ?? '请检查数据目录与依赖后重试。', buttons: ['重试', '连接已有实例', '退出'], defaultId: 0, cancelId: 2 });
    if (response === 0) return startManaged();
    if (response === 1) { settings = { ...settings, mode: 'connect' }; saveSettings(settingsFile(), settings); return startConnect(); }
    app.quit();
    return false;
  }
}

async function startConnect(): Promise<boolean> {
  const parsed = parseConnectUrl(settings.connectUrl);
  const probe = parsed ? await probeInstance(parsed.port) : { ok: false as const, code: 'UNREACHABLE' as const };
  if (parsed && probe.ok) { target = { port: parsed.port }; return true; }
  const reason = !probe.ok ? { UNREACHABLE: '没有在该地址找到正在运行的实例。', NOT_PERSONAL_AGENT: '该地址不是 Personal Agent 服务。',
    NOT_LOOPBACK: '该实例使用 paired 访问策略，请用浏览器访问其配置的 HTTPS 地址。', DESKTOP_INSTANCE: '该实例属于另一个桌面客户端（需要它的启动令牌）。' }[probe.code] : '';
  const { response } = await dialog.showMessageBox({ type: 'warning', title: 'Personal Agent', message: `无法连接 ${settings.connectUrl}`,
    detail: reason, buttons: ['重试', '改用托管模式', '退出'], defaultId: 0, cancelId: 2 });
  if (response === 0) return startConnect();
  if (response === 1) { settings = { ...settings, mode: 'managed' }; saveSettings(settingsFile(), settings); return startManaged(); }
  app.quit();
  return false;
}

const startCurrentMode = () => settings.mode === 'connect' ? startConnect() : startManaged();

async function switchMode(mode: DesktopSettings['mode']): Promise<void> {
  if (mode === settings.mode) return;
  settings = { ...settings, mode };
  saveSettings(settingsFile(), settings);
  await stopServer();
  if (await startCurrentMode()) mainWindow?.reload();
  buildMenu();
}

function buildMenu(): void {
  const modeItems: MenuItemConstructorOptions[] = [
    { label: '托管模式（启动内置服务）', type: 'radio', checked: settings.mode === 'managed', click: () => void switchMode('managed') },
    { label: `连接已有实例（${settings.connectUrl}）`, type: 'radio', checked: settings.mode === 'connect', click: () => void switchMode('connect') },
  ];
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: '模式', submenu: modeItems },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600, show: false, title: 'Personal Agent',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false,
    },
  });
  mainWindow = window;
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined; });
  // 只允许停留在 app:// 页面；外部链接交给系统浏览器，且只限 http(s)。
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//iu.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  void window.loadURL(`${APP_ORIGIN}/`);
}

function installProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    // /api/ 下的请求一律交给代理（代理自己拒绝不允许的路径），其余是静态页面。
    if (url.pathname.startsWith('/api/')) return proxyRequest(request, target);
    return serveStatic(webRoot(), request);
  });
}

function installIpc(): void {
  const trusted = (frameUrl: string | undefined) => !!frameUrl && frameUrl.startsWith(`${APP_ORIGIN}/`);
  ipcMain.handle('desktop:info', (event) => {
    if (!trusted(event.senderFrame?.url)) throw new Error('untrusted sender');
    return { mode: settings.mode, platform: process.platform, version: app.getVersion() };
  });
  ipcMain.handle('desktop:switch-mode', async (event, mode: unknown) => {
    if (!trusted(event.senderFrame?.url) || (mode !== 'managed' && mode !== 'connect')) throw new Error('invalid request');
    await switchMode(mode);
  });
  ipcMain.on('vnc:open', (event, raw: unknown) => {
    if (!trusted(event.senderFrame?.url) || !raw || typeof raw !== 'object') return;
    const { requestId, deploymentId, desktopId } = raw as Record<string, unknown>;
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/u.test(requestId) || typeof deploymentId !== 'string' || typeof desktopId !== 'string') return;
    const { port1, port2 } = new MessageChannelMain();
    if (!target) { port1.start(); port1.postMessage({ type: 'close', code: 4503, reason: 'service not ready' }); port1.close(); }
    else {
      const close = openVncBridge(target, deploymentId, desktopId, port1);
      const tracked = () => { bridges.delete(tracked); close(); };
      bridges.add(tracked);
      port1.on('close', () => bridges.delete(tracked));
    }
    event.sender.postMessage('vnc:port', { requestId }, [port2]);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.on('web-contents-created', (_event, contents) => {
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    contents.on('will-attach-webview', event => event.preventDefault());
  });
  app.whenReady().then(async () => {
    settings = loadSettings(settingsFile());
    installProtocol();
    installIpc();
    buildMenu();
    if (await startCurrentMode()) createWindow();
  }).catch(() => app.quit());
  app.on('window-all-closed', () => app.quit());
  // 退出前先优雅关闭 server（任务进程、数据库、实例锁），再真正退出。
  app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    quitting ??= stopServer().catch(() => {}).finally(() => { quitReady = true; app.quit(); });
  });
}
