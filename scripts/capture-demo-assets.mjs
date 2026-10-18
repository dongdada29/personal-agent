#!/usr/bin/env node
// Regenerates docs/assets screenshots and demo.gif from a disposable fake demo.
// Playwright is loaded on demand and is not a project dependency:
//   npm run build
//   npm exec --yes --package playwright -- node scripts/capture-demo-assets.mjs
// Requires ffmpeg on PATH. Set PERSONAL_AGENT_CAPTURE_COPY_DIR to also copy the outputs elsewhere.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(root, 'docs', 'assets');
const copyDir = process.env.PERSONAL_AGENT_CAPTURE_COPY_DIR;
const port = Number(process.env.PERSONAL_AGENT_CAPTURE_PORT ?? '47811');
const screenshotGoal = '为 greeting 模块补充单元测试';
const gifGoal = '为 greeting 模块补充边界输入的单元测试';
const outputs = ['desktop-create-task.png', 'desktop-events-approval.png', 'desktop-artifacts-verification.png', 'mobile-390.png', 'demo.gif'];
const maxGifBytes = 5 * 1024 * 1024;

function which(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch {
    // `npm exec --package playwright` puts the package on PATH but not on this module's resolution path.
    const bin = which('playwright');
    if (!bin) throw new Error('Playwright not found. Run: npm exec --yes --package playwright -- node scripts/capture-demo-assets.mjs');
    return require(require.resolve('playwright', { paths: [resolve(dirname(bin), '..')] }));
  }
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

async function startDemo() {
  // Own process group so a stray child cannot outlive the capture run.
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/demo.ts', '--port', String(port)], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let output = '';
  const address = await new Promise((resolveAddress, reject) => {
    const timer = setTimeout(() => reject(new Error(`Demo did not start:\n${output}`)), 30_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Open (http:\/\/127\.0\.0\.1:\d+)\/\?demo=fake/);
      if (match) { clearTimeout(timer); resolveAddress(match[1]); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Demo exited with code ${code}:\n${output}`)); });
  });
  return { child, address };
}

async function stopDemo(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  // SIGINT runs the demo's own cleanup of its temporary data directory.
  process.kill(-child.pid, 'SIGINT');
  const timeout = new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 15_000));
  if (await Promise.race([exited, timeout]) === 'timeout') {
    process.kill(-child.pid, 'SIGKILL');
    await exited;
  }
}

function taskOverview(page, goal) {
  return page.locator('.detail-overview').filter({ has: page.getByRole('heading', { name: goal, exact: true }) });
}

async function createTask(page, goal) {
  await page.getByLabel('你想完成什么？').fill(goal);
  await page.getByRole('button', { name: '创建演示任务' }).click();
  const overview = taskOverview(page, goal);
  await overview.waitFor({ timeout: 10_000 });
  return overview;
}

async function waitCompleted(overview) {
  await overview.locator('.overview-tags').getByText('已完成', { exact: true }).waitFor({ timeout: 30_000 });
}

async function scrollToTop(locator) {
  await locator.evaluate((element) => element.scrollIntoView({ block: 'start' }));
}

async function captureScreenshots(browser, address) {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await desktop.newPage();
  await page.goto(`${address}/?demo=fake`, { waitUntil: 'networkidle' });
  await page.getByLabel('你想完成什么？').fill(screenshotGoal);
  await page.screenshot({ path: join(assetsDir, 'desktop-create-task.png') });

  const overview = await createTask(page, screenshotGoal);
  await waitCompleted(overview);
  await scrollToTop(overview);
  await page.screenshot({ path: join(assetsDir, 'desktop-events-approval.png') });

  await page.locator('.artifacts-card').evaluate((element) => element.scrollIntoView({ block: 'end' }));
  await page.screenshot({ path: join(assetsDir, 'desktop-artifacts-verification.png') });
  await desktop.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${address}/?demo=fake`, { waitUntil: 'networkidle' });
  await mobilePage.locator('.task-list-item').filter({ hasText: screenshotGoal }).click();
  const mobileOverview = taskOverview(mobilePage, screenshotGoal);
  await mobileOverview.waitFor({ timeout: 10_000 });
  await scrollToTop(mobileOverview);
  await mobilePage.screenshot({ path: join(assetsDir, 'mobile-390.png') });
  await mobile.close();
}

async function recordGif(browser, address) {
  const frameDir = mkdtempSync(join(tmpdir(), 'personal-agent-frames-'));
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 750 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const frames = [];
    // Screenshots take longer than the target frame interval, so each frame keeps its real timestamp.
    const hold = async (milliseconds) => {
      const end = Date.now() + milliseconds;
      do {
        const path = join(frameDir, `frame-${String(frames.length).padStart(4, '0')}.png`);
        await page.screenshot({ path });
        frames.push({ path, at: Date.now() });
      } while (Date.now() < end);
    };

    await page.goto(`${address}/?demo=fake`, { waitUntil: 'networkidle' });
    await hold(2_000);
    await page.getByLabel('你想完成什么？').fill(gifGoal);
    await hold(2_500);
    const overview = await createTask(page, gifGoal);
    await hold(1_500);
    await waitCompleted(overview);
    await scrollToTop(page.locator('.events-card'));
    await hold(5_000);
    await page.locator('.artifacts-card').scrollIntoViewIfNeeded();
    await hold(3_000);
    await scrollToTop(overview);
    await hold(1_500);
    await overview.getByRole('button', { name: '接收成果' }).click();
    await overview.getByText('已接收', { exact: true }).waitFor({ timeout: 10_000 });
    await hold(3_500);
    await context.close();

    const list = frames.map((frame, index) => {
      const next = frames[index + 1]?.at ?? frame.at + 1_000;
      return `file '${frame.path}'\nduration ${((next - frame.at) / 1000).toFixed(3)}`;
    });
    // The concat demuxer ignores the last entry's duration unless the file is repeated.
    list.push(`file '${frames.at(-1).path}'`);
    const listFile = join(frameDir, 'frames.txt');
    writeFileSync(listFile, `${list.join('\n')}\n`);

    const gif = join(assetsDir, 'demo.gif');
    for (const { fps, width } of [{ fps: 12, width: 960 }, { fps: 10, width: 960 }, { fps: 10, width: 800 }]) {
      const filter = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
      // Transparent inter-frame diffs leave stale regions behind after large scrolls; changed rectangles are stored opaque.
      ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-filter_complex', filter, '-gifflags', '-transdiff', '-loop', '0', gif]);
      if (statSync(gif).size <= maxGifBytes) return;
    }
    throw new Error(`demo.gif is larger than 5 MB: ${statSync(gif).size} bytes`);
  } finally {
    rmSync(frameDir, { recursive: true, force: true });
  }
}

async function main() {
  mkdirSync(assetsDir, { recursive: true });
  const { chromium } = loadPlaywright();
  const executablePath = which('google-chrome') ?? which('chromium') ?? which('chromium-browser');
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  let demo;
  try {
    demo = await startDemo();
    await captureScreenshots(browser, demo.address);
    await recordGif(browser, demo.address);
  } finally {
    await browser.close();
    if (demo) await stopDemo(demo.child);
  }
  if (copyDir) {
    mkdirSync(copyDir, { recursive: true });
    for (const name of outputs) copyFileSync(join(assetsDir, name), join(copyDir, name));
  }
  console.log(JSON.stringify({ assets: outputs.map((name) => join('docs', 'assets', name)), copiedTo: copyDir ?? null }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
