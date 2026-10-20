#!/usr/bin/env node
// 构建 Electron 客户端的 dist/：
//   dist/main.cjs、dist/preload.cjs           主进程与沙箱 preload（CJS，electron 外部依赖）
//   dist/server/desktop-main.mjs              server 打包（ESM，Electron 自带 Node 以 ELECTRON_RUN_AS_NODE 运行）
//   dist/server/process-owner.mjs             任务进程 owner 包装脚本（必须是独立文件，命令行要可核对）
//   dist/server/engine-fake-fixture.mjs       fake 引擎（打包后不依赖 tsx）
//   dist/server/box/pa-box-seccomp.json       box 的 seccomp 配置（Colima / Podman 由本机 docker CLI 读取）
//   dist/web/                                 与浏览器版相同的 apps/web 构建
// 用法：node scripts/build.mjs [--skip-web]
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const repo = resolve(desktop, '..', '..');
const dist = join(desktop, 'dist');
const skipWeb = process.argv.includes('--skip-web');

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'server', 'box'), { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: false, legalComments: 'linked', logLevel: 'warning' };

await build({ ...common, entryPoints: [join(desktop, 'src', 'main.ts')], outfile: join(dist, 'main.cjs'), format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: [join(desktop, 'src', 'preload.ts')], outfile: join(dist, 'preload.cjs'), format: 'cjs', external: ['electron'] });

// server 的 ESM 打包里仍有少量 CommonJS 依赖会调用 require()，这里补一个基于 import.meta.url 的 require。
const banner = "import { createRequire as __paCreateRequire } from 'node:module'; const require = __paCreateRequire(import.meta.url);";
await build({
  ...common,
  entryPoints: [join(repo, 'apps', 'server', 'src', 'desktop-main.ts')],
  outfile: join(dist, 'server', 'desktop-main.mjs'),
  format: 'esm',
  banner: { js: banner },
  // claude-code-acp-ts 以独立子进程运行（require.resolve 它的入口文件），其原生 CLI 也无法打进单文件；
  // 它作为桌面包的生产依赖随 node_modules 分发并 asarUnpack。
  external: ['claude-code-acp-ts', 'claude-code-acp-ts/*', 'tsx', 'node:sqlite'],
});
await build({
  ...common,
  entryPoints: [join(repo, 'packages', 'runtime', 'src', 'engine-fake-fixture.ts')],
  outfile: join(dist, 'server', 'engine-fake-fixture.mjs'),
  format: 'esm',
  banner: { js: banner },
});
cpSync(join(repo, 'packages', 'runtime', 'src', 'process-owner.mjs'), join(dist, 'server', 'process-owner.mjs'));
cpSync(join(repo, 'deploy', 'box', 'pa-box-seccomp.json'), join(dist, 'server', 'box', 'pa-box-seccomp.json'));
// 打包产物的 package.json：让 Node 把 dist/server 下的 .mjs 之外的文件也按 ESM 解析（保持一致）。
writeFileSync(join(dist, 'server', 'package.json'), JSON.stringify({ type: 'module' }) + '\n');

if (!skipWeb) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // Windows 上 .cmd 需要经 shell 执行（参数固定，不含外部输入）。
  execFileSync(npm, ['run', 'build', '--workspace', '@personal-agent/web'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
}
const webDist = join(repo, 'apps', 'web', 'dist');
if (!existsSync(join(webDist, 'index.html'))) {
  console.error('apps/web/dist/index.html 不存在：请先运行 npm run build（或去掉 --skip-web）。');
  process.exit(1);
}
cpSync(webDist, join(dist, 'web'), { recursive: true });
console.log('desktop build ready:', dist);
