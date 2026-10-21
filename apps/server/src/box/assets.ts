/**
 * 定位随 server 分发的 box 资源文件（目前只有 seccomp 配置 pa-box-seccomp.json）。
 *
 * 查找顺序：
 *   1. 环境变量 PA_BOX_ASSETS_DIR（运维 / 测试覆盖）；
 *   2. 打包后的 server（apps/desktop/dist/server/desktop-main.mjs）旁的 box/ 目录；
 *   3. 源码运行时仓库里的 deploy/box/。
 * docker CLI 在调用方所在机器上读取该文件，再把内容发给 Colima VM 里的 dockerd，
 * 所以 Colima / 本地 Podman 用这里的路径；WSL2 与云端用主机上的 /etc/pa-box/seccomp.json。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoxError } from './host-adapter.js';

export const BOX_SECCOMP_FILE = 'pa-box-seccomp.json';
/** WSL2 发行版与云端主机上的安装位置（由 install-cloud-host.sh / docs/windows-gaps.md 的步骤放置）。 */
export const BOX_REMOTE_SECCOMP_PATH = '/etc/pa-box/seccomp.json';

export function boxAssetCandidates(name: string, env: NodeJS.ProcessEnv = process.env, moduleUrl = import.meta.url): string[] {
  const here = fileURLToPath(new URL('.', moduleUrl));
  return [
    ...(env.PA_BOX_ASSETS_DIR ? [join(env.PA_BOX_ASSETS_DIR, name)] : []),
    join(here, 'box', name),
    join(here, '..', '..', '..', '..', 'deploy', 'box', name),
  ];
}

export function resolveBoxAsset(name: string, exists: (path: string) => boolean = existsSync, env: NodeJS.ProcessEnv = process.env): string {
  const found = boxAssetCandidates(name, env).find(path => exists(path));
  if (!found) throw new BoxError('BOX_SECCOMP_MISSING', `找不到 box 的 ${name}，无法以加固配置创建容器。`);
  return found;
}
