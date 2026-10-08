# 本次本地交付验收

日期：2026-10-06。实现候选为 `8ac1c0234b253f970b9efa38fca393fae84aeb47`，含 113 个跟踪文件。本记录与其后 README、首次运行及分享说明的更新仅补充文档；最终源码包提交标识由随包 `source-manifest.json` 记录。未推送、创建 PR 或公开发布。

## 交付内容

- npm workspaces、共享状态机、SQLite 迁移与持久事件、任务 API、独立 stdio fake ACP、受限真实 Claude 探针已实现，原阶段证据见 [阶段一](phase1-acceptance.md)。
- 真实任务流水线、worktree、实际验证、审批、补充要求、暂停/接管/继续、重试、接收/退回、重启恢复与设备访问代码的历史证据分别见 [阶段二](phase2-acceptance.md)、[阶段三](phase3-acceptance.md)、[阶段四](phase4-acceptance.md)。
- 本轮补齐连接恢复与创建回执校验、fake demo 限制、Git 子进程配置隔离、安全启动错误提示，以及 `doctor`、独立 HTTP `demo`、冷备份 `backup`、源码 `share:check` 四项交付工具。
- [首次运行](getting-started.md)、[运行维护](operations.md)、[分享说明](sharing.md)、[第三方许可](third-party-licenses.md) 和 [完整中文文章初稿](article-draft.zh-CN.md) 均已保存。

## 完整自动回归

| 实际环境 | Node | 测试文件 | 测试数 | 跳过 | 结果 |
| --- | --- | --- | --- | --- | --- |
| MacBook，macOS arm64 | 22.18.0 | 33/33 | 605/605 | 0 | PASS |
| MacBook，macOS arm64 | 24.18.0 | 33/33 | 605/605 | 0 | PASS |
| M1 目标节点，macOS arm64，独立新目录 | 24.21.0 | 33/33 | 605/605 | 0 | PASS |

三次回归均启用真实 HTTP/SSE socket，包括服务重启与事件恢复用例；全部使用临时仓库、fake/mock 引擎、验证子进程和临时虚拟认证，没有真实模型请求或生产设备配对。相对旧基线的 530 项回归，本轮增加 75 项。M1 候选源码 113/113 文件的大小与 SHA-256 在每项命令前后核验一致。

MacBook Node 24.18.0 和 M1 的完整测试命令：

```sh
PERSONAL_AGENT_SSE_REAL_SOCKETS=1 \
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 \
npm test -- --maxWorkers=1 --minWorkers=1
```

MacBook Node 22.18.0 使用经官方 SHA-256 校验的独立 Node 二进制；没有替换系统 Node。等价命令为：

```sh
PERSONAL_AGENT_SSE_REAL_SOCKETS=1 \
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 \
'<NODE_22_18_0_BINARY>' ./node_modules/vitest/vitest.mjs run --maxWorkers=1 --minWorkers=1
```

M1 从源码包在新的独立目录安装并依次运行以下命令，退出码全部为 0；安装使用独立空 npm 配置，不绕过 TLS：

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org --strict-ssl=true --no-audit --no-fund
npm run build
npm run doctor
# 全量测试使用上面的真实 socket 命令
npm run smoke
npm run demo -- --check
```

`build` 包含根工程与 Web 类型检查；`doctor` 返回 `READY`。`smoke` 返回 `PASS`，通过独立 stdio fake ACP 产生 completed、13 条事件、1 项成果。HTTP demo 返回 `PASS`：故障任务 failed、7 条事件、0 项成果；后续成功任务 completed、13 条事件、1 项成果；命令重放返回同一任务，SQLite 与 HTTP 一致，并拒绝真实执行。demo 没有读取生产数据或生成访问凭据。

冷备份测试验证已完成 fake 任务的事件和成果恢复、空目录保留、旧 schema 只读检查、实例锁/活动进程/链接拒绝，以及清理阻断保留归属证据。生产数据未用于备份演练，也未执行升级或回滚。

构建有 Vite 单 chunk 大于 500 kB 的提示，Node 22.18 的 `node:sqlite` 有实验性提示；相关命令均成功。这些结果不证明 Linux 或 Windows 的运行兼容性。

## 实际浏览器

使用实际 Chrome、独立临时 profile、loopback HTTP 和 fake ACP：

1. 实际点击创建任务、等待完成、接收成果。
2. 刷新页面并从列表重新选择原任务，接收状态和成果仍可读取。
3. 仅拦截 `/api/session` 模拟连接故障，工作台与草稿保留；恢复连接后草稿仍在。
4. 拦截同一接口返回 401，工作台立即卸载。
5. 1440px 桌面和 390px 手机视口的页面宽度均无横向溢出，两份截图已目视检查。

临时浏览器、profile 和 demo 均已清理，测试端口无残留监听。连接故障与 401 为 CDP 拦截模拟；390px 为浏览器视口，尚未验收实体手机、移动网络或公网 HTTPS。

## 真实引擎与原实例

M1 使用该机既有原生用户 provider，执行一次受限探针：

```sh
npm run probe:claude -- --prompt --user-settings
```

返回 `protocolReady: true`、`sessionReady: true`、`planModeSupported: true`、`authenticatedPrompt: "passed"`。工具、MCP、hooks、持久会话和自动更新保护均启用；没有新登录、认证搬运或持久访问配置。这证明最小模型往返；本轮没有在 M1 重跑真实多 Agent 开发 fixture。探针在原基线源码运行，其脚本及 Claude adapter 与候选保持一致。

M1 原有正式实例仍运行 `f2294c7f337132074085862c9626e0fc7a9e72d7`，继续只监听 `127.0.0.1:47801`，健康检查通过；候选没有替换它、重启它或迁移其数据。原实例的 HTTP fake 创建及落库证据与候选全量回归分开保存，不能把独立目录测试称为正式升级。

## 证据与源码材料

本地私有证据保存于 `.data/delivery-acceptance/evidence/`，已被 Git 排除，源码分享包不包含它：

- `macbook-node22-final-tests.log`、`macbook-node24-final-tests.log`：605 项完整回归日志。
- `m1/status.json` 与 `m1/*.log`：独立候选安装、构建、doctor、605 项回归、smoke、demo。
- `m1-claude-probe.log`：受限探针的固定安全状态输出。
- `browser-evidence.json`、`browser-1440.png`、`browser-390.png`：实际浏览器结果与截图。
- `m1-original-instance-preservation.json`：交付收尾时的只读实例保留检查。

源码归档仅从审阅提交导出，附提交标识、逐文件大小/SHA-256 和归档摘要；排除 `.git`、依赖、构建产物、数据库、日志、运行目录、凭据、备份及私有验收证据。最终文件数和包 SHA-256 以随包清单为准。`share:check` 是启发式辅助检查，通过不构成绝对无秘密保证。

仓库保留原计划 Apache-2.0 LICENSE 与移植模块 NOTICE；正式对外开源的许可证选择仍待确认。依赖各自许可，源码包不捆绑 Anthropic SDK 二进制或 node_modules。

## 未执行项与下一步

当前可用范围是本机。M1 原实例升级须另行确认停止、冷备份、源码切换、重启和回滚范围。固定公网入口还需确认 DNS/NS 变更、Named Tunnel 持久 token、生产 paired、首次设备配对和发布路由，随后实测 HTTPS 与手机关闭 Wi-Fi 后的创建、审批、接管、重连、接收、撤销。系统自启动和电源设置另行确认。

许可证最终选择、公开仓库推送与文章发布尚未授权。以上待办不影响本地源码、fake 演示、完整自动回归、浏览器操作和受限真实探针的已完成结果。
