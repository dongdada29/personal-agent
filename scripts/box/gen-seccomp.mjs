#!/usr/bin/env -S node
/**
 * 生成 box 容器使用的 seccomp 配置 deploy/box/pa-box-seccomp.json。
 *
 * 规则（来自 L0 实测，见 docs/desktop.md「box 加固」）：
 *   = moby 默认 seccomp 配置（固定到 moby/profiles 的某个提交，并校验 sha256）
 *   + 一条无条件放行 clone / unshare / setns 的规则。
 *
 * 原因：默认配置只在容器拥有 CAP_SYS_ADMIN 时才放行这三个调用（clone 还要求不带
 * CLONE_NEW* 标志），于是非特权用户无法创建 user namespace，Chromium 报
 * "No usable sandbox"。放开这三个调用后，Chromium 用 user/pid namespace 沙箱运行，
 * 不需要 --no-sandbox，也不需要特权容器或改 VM sysctl。clone3 保持默认（ENOSYS），
 * glibc 会自动回退到 clone。
 *
 * 用法：
 *   node scripts/box/gen-seccomp.mjs            # 下载固定版本并重新生成
 *   node scripts/box/gen-seccomp.mjs base.json  # 使用本地已下载的基础配置（同样校验 sha256）
 *
 * 生成结果提交进仓库；单元测试会校验“去掉追加规则后与基础配置逐字节等价”。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** moby/profiles 的 seccomp/v0.2.4 标签对应的提交。 */
export const BASE_COMMIT = '245180c51918481c0525424b3ee025d2b435d46c';
export const BASE_URL = `https://raw.githubusercontent.com/moby/profiles/${BASE_COMMIT}/seccomp/default.json`;
/** 原始文件字节的 sha256，防止下载内容被替换。 */
export const BASE_SHA256 = '785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334';

export const ADDED_RULE = {
  names: ['clone', 'setns', 'unshare'],
  action: 'SCMP_ACT_ALLOW',
  comment: 'personal-agent pa-box: allow unprivileged user namespaces so the Chromium sandbox works without --no-sandbox (L0 measurement)',
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const output = join(root, 'deploy', 'box', 'pa-box-seccomp.json');

async function loadBase(path) {
  if (path) return readFileSync(path);
  const response = await fetch(BASE_URL);
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const raw = await loadBase(process.argv[2]);
const sha = createHash('sha256').update(raw).digest('hex');
if (sha !== BASE_SHA256) {
  console.error(`base profile sha256 mismatch: expected ${BASE_SHA256}, got ${sha}`);
  process.exit(1);
}
const base = JSON.parse(raw.toString('utf8'));
const profile = { ...base, syscalls: [...base.syscalls, ADDED_RULE] };
writeFileSync(output, `${JSON.stringify(profile, null, 2)}\n`);
// 测试用：基础配置规范化（JSON.stringify 无缩进）后的 sha256。
console.log(`wrote ${output}`);
console.log(`canonical base sha256: ${createHash('sha256').update(JSON.stringify(base)).digest('hex')}`);
