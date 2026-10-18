#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(root, 'docs', 'assets');
const artifactsDir = join(root, 'cloud-agent-artifacts');
const port = Number(process.env.PERSONAL_AGENT_DEMO_CAPTURE_PORT ?? '47811');
const runLabel = new Date().toISOString().slice(11, 19).replaceAll(':', '');
const goal = `为 greeting 模块补充单元测试（演示 ${runLabel}）`;

function command(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function which(name) {
  try {
    return execFileSync(command('which'), [name], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function loadPlaywright() {
  const localRequire = createRequire(import.meta.url);
  try {
    return localRequire('playwright');
  } catch {
    const playwrightBin = which('playwright');
    if (!playwrightBin) {
      throw new Error('Playwright not found. Run: npm exec --yes --package playwright -- node scripts/capture-demo-assets.mjs');
    }
    const transientNodeModules = resolve(dirname(playwrightBin), '..');
    return localRequire(localRequire.resolve('playwright', { paths: [transientNodeModules] }));
  }
}

function findChrome() {
  return which('google-chrome') ?? which('chromium') ?? which('chromium-browser') ?? undefined;
}

function npmRun(args) {
  const npmExec = process.env.npm_execpath;
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
  const options = { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' };
  if (npmExec && existsSync(npmExec)) return spawn(process.execPath, [npmExec, ...args], options);
  return spawn(command('npm'), args, options);
}

async function startDemo() {
  const child = npmRun(['run', 'demo', '--', '--port', String(port)]);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); process.stdout.write(chunk); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); process.stderr.write(chunk); });
  const address = await new Promise((resolveAddress, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Demo did not start. Output:\n${output}`)), 30_000);
    const check = () => {
      const match = output.match(/Open (http:\/\/127\.0\.0\.1:\d+)\/\?demo=fake/);
      if (match) {
        clearTimeout(timeout);
        resolveAddress(match[1]);
      }
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Demo exited before capture with code ${code}. Output:\n${output}`));
    });
  });
  return { child, address };
}

async function stopDemo(child) {
  if (child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => resolveStop(), 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
  if (child.exitCode === null) {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      return;
    }
    await new Promise((resolveStop) => {
      const timer = setTimeout(() => resolveStop(), 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveStop();
      });
    });
  }
}

async function createDemoTask(page) {
  await page.getByLabel('你想完成什么？').fill(goal);
  await page.getByRole('button', { name: '创建演示任务' }).click();
  const overview = page.locator('.detail-overview').filter({ hasText: goal });
  await overview.waitFor({ timeout: 10_000 });
  await overview.locator('.overview-tags').getByText('已完成', { exact: true }).waitFor({ timeout: 30_000 });
}

async function captureScreenshots(browser, address) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`${address}/?demo=fake`, { waitUntil: 'networkidle' });

  await page.getByLabel('你想完成什么？').fill(goal);
  await page.screenshot({ path: join(assetsDir, 'desktop-create-task.png'), fullPage: false });

  await page.getByRole('button', { name: '创建演示任务' }).click();
  const overview = page.locator('.detail-overview').filter({ hasText: goal });
  await overview.waitFor({ timeout: 10_000 });
  await overview.locator('.overview-tags').getByText('已完成', { exact: true }).waitFor({ timeout: 30_000 });
  await page.locator('.events-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(assetsDir, 'desktop-events-approval.png'), fullPage: false });

  await page.locator('.artifacts-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(assetsDir, 'desktop-artifacts-verification.png'), fullPage: false });

  await context.close();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 1200 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${address}/?demo=fake`, { waitUntil: 'networkidle' });
  await mobilePage.getByText(goal).first().waitFor({ timeout: 10_000 });
  await mobilePage.screenshot({ path: join(assetsDir, 'mobile-390.png'), fullPage: false });
  await mobile.close();
}

async function recordGif(browser, address) {
  const frameDir = join(tmpdir(), `personal-agent-frames-${Date.now()}`);
  mkdirSync(frameDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 960, height: 600 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  let frame = 0;
  const captureFrame = async () => {
    await page.screenshot({ path: join(frameDir, `frame-${String(frame++).padStart(4, '0')}.png`), fullPage: false });
  };
  const captureFor = async (milliseconds) => {
    const deadline = Date.now() + milliseconds;
    do {
      await captureFrame();
      await page.waitForTimeout(100);
    } while (Date.now() < deadline);
  };

  await page.goto(`${address}/?demo=fake`, { waitUntil: 'networkidle' });
  await captureFor(1200);
  await page.getByLabel('你想完成什么？').fill(goal);
  await captureFor(1500);
  await page.getByRole('button', { name: '创建演示任务' }).click();
  const overview = page.locator('.detail-overview').filter({ hasText: goal });
  await overview.waitFor({ timeout: 10_000 });
  await captureFor(2500);
  await page.locator('.events-card').scrollIntoViewIfNeeded();
  await overview.locator('.overview-tags').getByText('已完成', { exact: true }).waitFor({ timeout: 30_000 });
  await captureFor(3500);
  await page.locator('.artifacts-card').scrollIntoViewIfNeeded();
  await captureFor(2500);
  await page.getByRole('button', { name: '接收成果' }).click();
  await page.getByText('已接收').first().waitFor({ timeout: 10_000 });
  await captureFor(2500);
  await context.close();

  const palette = join(frameDir, 'palette.png');
  const gif = join(assetsDir, 'demo.gif');
  const attempts = [
    { fps: 10, width: 960 },
    { fps: 10, width: 840 },
    { fps: 8, width: 760 },
  ];
  for (const attempt of attempts) {
    const vf = `scale=${attempt.width}:-1:flags=lanczos`;
    const pattern = join(frameDir, 'frame-%04d.png');
    spawnSync('ffmpeg', ['-y', '-framerate', String(attempt.fps), '-i', pattern, '-vf', `${vf},palettegen`, palette], { stdio: 'inherit' });
    spawnSync('ffmpeg', ['-y', '-framerate', String(attempt.fps), '-i', pattern, '-i', palette, '-lavfi', `${vf} [x]; [x][1:v] paletteuse`, gif], { stdio: 'inherit' });
    if (statSync(gif).size <= 5 * 1024 * 1024) return;
  }
  throw new Error(`Generated GIF exceeds 5MB: ${statSync(gif).size} bytes`);
}

function copyArtifacts() {
  mkdirSync(artifactsDir, { recursive: true });
  for (const name of ['desktop-create-task.png', 'desktop-events-approval.png', 'desktop-artifacts-verification.png', 'mobile-390.png', 'demo.gif']) {
    execFileSync(command('cp'), [join(assetsDir, name), join(artifactsDir, name)]);
  }
}

async function main() {
  mkdirSync(assetsDir, { recursive: true });
  const { chromium } = loadPlaywright();
  const demo = await startDemo();
  const browser = await chromium.launch({ headless: true, executablePath: findChrome() });
  try {
    await captureScreenshots(browser, demo.address);
    await recordGif(browser, demo.address);
  } finally {
    await browser.close();
    await stopDemo(demo.child);
  }
  copyArtifacts();
  console.log(JSON.stringify({
    screenshots: ['desktop-create-task.png', 'desktop-events-approval.png', 'desktop-artifacts-verification.png', 'mobile-390.png'].map((name) => join(assetsDir, name)),
    gif: join(assetsDir, 'demo.gif'),
    artifacts: artifactsDir,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
