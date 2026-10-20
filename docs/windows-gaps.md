# Windows 缺口清单

本文件列出桌面客户端与 box 在 Windows 上仍然存在的缺口。每一项都给出代码位置和拟议修法；**已在本 PR 修复的项标为「已修复」**。

Windows CI（`windows-latest`）跑与 Ubuntu/macOS 相同的 typecheck / 全量测试 / 构建，并额外打 NSIS 包。box 镜像脚本的 Python/bash 实测在 Windows 上跳过（没有 AF_UNIX 的 Linux 门禁环境）。

## 已在本 PR 修复

| 缺口 | 文件 | 修法 |
| --- | --- | --- |
| POSIX-only 进程归属，Windows 直接 `PROCESS_UNSUPPORTED` | `packages/runtime/src/process-registry.ts` | Windows 用 PID + WMI `CreationDate`（100ns）+ `CommandLineToArgvW` 精确 argv 三者确认 owner。 |
| 无进程组，PID 复用快，孤儿追踪 | `packages/runtime/src/process-windows.ts` | 按 `ParentProcessId` 找子孙；孤儿保留原 PPID。创建时间早于父进程的“子进程”视为 PID 复用，忽略。 |
| 结束进程树 | `packages/runtime/src/engine-process.ts`、`process-windows.ts` | 对已核实身份调用 `taskkill /T /F`，再查进程表直到消失。taskkill 前再次核对创建时间。 |
| `npm` 实际是 `npm.cmd`，`shell:false` 找不到 | `packages/runtime/src/process-windows.ts`、`verification.ts` | PATH × PATHEXT 解析；npm/npx 的 `.cmd` 改为 `node <npm-cli.js>`，不经过 `cmd.exe`。 |
| Electron 托管时 `process.execPath` 是 Electron 本体 | `packages/runtime/src/process-registry.ts`、`process-owner.mjs` | owner 设置 `ELECTRON_RUN_AS_NODE=1`；只有子进程仍是同一可执行文件时才保留该变量。 |
| owner 启动闸门：fd 3 + `detached:true` 在 Windows 上等不到 READY | `process-registry.ts` `ownedProcessSpawnOptions`、`process-owner.mjs` | Windows 改 Node IPC（`stdio[3]='ipc'`，`serialization:'json'`），不 detach；POSIX 仍用 fd 3。子进程删除 `NODE_CHANNEL_FD`。 |
| `node D:\file.ts` / `fork(D:\file.ts)` 被 ESM loader 当成 `d:` 协议 | `engine-fake.ts`、`server-supervisor.ts`、desktop / hostd 测试 | 入口改 `file://` URL；hostd 动态 import 加 `@vite-ignore`，避免 Vite 把 `\scripts` 内联成非法转义。 |
| Git 配置 `/dev/null` | `workspace.ts` `gitNullDevice` | Windows 用 `NUL`。 |
| fake 引擎依赖 tsx 加载 `.ts` | `packages/runtime/src/engine-fake.ts` | 打包产物优先 `engine-fake-fixture.mjs`。 |
| doctor 把 Windows 标成不支持 | `scripts/doctor.ts` | `processManagementSupported` 含 `win32`。 |
| WSL2 检测 | `apps/server/src/box/local-adapters.ts` | `wsl.exe -l -v` 解析发行版名、版本、状态；未安装 / 未配置会给出提示。 |
| 路径大小写与 `\\?\` 前缀 | `packages/runtime/src/process-windows.ts` `sameWindowsPath` | 规范化后再比较。 |
| NSIS 打包 | `apps/desktop/electron-builder.yml`、`.github/workflows/ci.yml` | `windows-latest` 打未签名 nsis；`signAndEditExecutable: false`。 |

## 仍未完成

| 缺口 | 文件 | 拟议修法 |
| --- | --- | --- |
| 通用 `.cmd` / `.bat` 验证命令被拒绝 | `packages/runtime/src/process-windows.ts` `resolveWindowsCommand` | Node 20.12+ 禁止 `shell:false` 直接跑批处理（CVE-2024-27980）。经 `cmd.exe /d /s /c` 转发需要逐参数转义 `%`、`^`、`&` 等（BatBadBut）。短期保持拒绝；若要支持，只允许无元字符的参数并写专项测试。 |
| 实例锁仍只看 PID | `apps/server/src/instance-lock.ts` | Windows PID 复用会使“确认已死”误判。应像进程账本一样把创建时间写入 `service.lock`，回收前核对。 |
| 未使用 Job Object | `packages/runtime/src/process-windows.ts` | `taskkill /T` 依赖仍然活着的父子关系；若中间进程先退出且 WMI 尚未看到孤儿，可能漏杀。更强的做法是 owner 创建时把自身放进 Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）。 |
| NTFS 上 `mode: 0o600` 只是建议 | `apps/server/src/instance-lock.ts`、`packages/runtime/src/workspace.ts`、`apps/desktop/src/config.ts` | 用 ACL（`icacls` 或 `SetNamedSecurityInfo`）把 DACL 收成 SYSTEM + 当前用户；失败则拒绝启动。 |
| WSL2 发行版 `pa-box` 未自动创建 | `apps/server/src/box/local-adapters.ts`、本文件 | 目前只检测。拟议：提供 `scripts/box/import-wsl-pa-box.ps1`，导入 rootfs tar、写 `/etc/wsl.conf`、把 `pa-box-seccomp.json` 放到发行版内 `/etc/pa-box/seccomp.json`。不要用默认发行版。 |
| WSL2 localhost 转发假设 | `apps/server/src/box/local-adapters.ts` `openGate` | 依赖 `localhostForwarding=true`（WSL 默认）。若用户关了它，网关端口不会出现在 Windows 的 127.0.0.1。应在打开桌面前用 `Get-NetTCPConnection` 复核，失败则给出明确提示。 |
| 宿主端口暴露检测用 `lsof` | `apps/server/src/box/local-adapters.ts` `verifyHostListener` | 仅 Colima（macOS）。Windows 应使用 `Get-NetTCPConnection -LocalPort 47830` 或 `netstat -ano`，同样要求只绑定 127.0.0.1。 |
| box 镜像 / 门禁的 live 测试在 Windows CI 跳过 | `apps/server/test/box-gate.test.ts` | 门禁用 unix socket；Windows 上 Python 的 AF_UNIX 支持因版本而异。保持 skipIf，不把 Linux 门禁冒充成 Windows 通过。 |
| 路径中的换行符 | `packages/runtime/test/workspace.test.ts` | NTFS 不允许文件名含 `\\n`。相关用例在 win32 上 skip；生产路径校验仍拒绝 `\\0`，但不把换行当 Windows 合法名。 |
| 未签名 NSIS 会触发 SmartScreen | `apps/desktop/electron-builder.yml` | 需要代码签名证书。本仓库不提交证书或密码。 |
| Electron 在部分 CI 环境需要 `--no-sandbox` | 仅 CI 启动参数，**不得**传给 box 内 Chromium | box 镜像明确禁止 `--no-sandbox`。这是宿主 Electron 与容器 Chromium 两件不同的事。 |
| 备份脚本的 `mkdirSync(..., { mode: 0o700 })` | `scripts/backup.ts` | 同 ACL 缺口。备份不是桌面客户端的启动路径。Windows CI 不把目录 mode 当作验收条件。 |
| 云端 docker 组 = root | `scripts/box/install-cloud-host.sh` | Linux 缺口，Windows 用户走 WSL2 时同样适用。优先 rootless podman。 |

## 明确不在 Windows 上做的事

- Colima / vz：macOS only。Windows 本机适配器是 WSL2。
- 把 VNC 端口发布到非回环地址，或给桌面加 VNC 密码代替网关令牌。
- 在仓库里写局域网 IP、主机名、密码或令牌。
- 让 demo 模式执行任何真实命令。
