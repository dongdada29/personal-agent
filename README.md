# Personal Agent

在自己的电脑或 VM 上运行任务、查看 Agent 分工、处理审批，并接收代码补丁和实际验证记录。浏览器工作台支持窄屏；当前可直接使用的是本机入口，远程手机访问需要另行配置 HTTPS 和设备配对。

Claude 任务以选定 Git HEAD 创建独立 worktree，经过双 Agent 分析、开发、Runtime 验证、审查与汇总。任务、事件、审批、控制命令和阶段检查点保存在 SQLite；页面关闭不会取消任务。`fake` 引擎提供无模型、无账号的演示。

## 首次本地演示

准备 Node.js **22.18 或更高**、npm 和 Git。当前进程管理支持 macOS/Linux POSIX；已验证的平台是 macOS arm64，Linux 需在目标机器复验，Windows 暂不支持启动。

在取得的源码目录运行：

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org --strict-ssl=true
npm run build
npm run smoke
```

`smoke` 在临时目录完成 fake ACP 任务，预期输出 `PASS`、`completed`、13 条事件和 1 项成果，然后清理自建数据。它不需要模型认证，也不启动常驻服务。

想实际操作工作台，运行：

```sh
npm run demo
```

打开启动终端打印的地址，默认是 <http://127.0.0.1:47811/?demo=fake>。独立 demo 使用临时数据、fake 引擎和与正式实例不同的端口，预置成功和故障任务；不自动打开浏览器。填写目标后点击“创建演示任务”，查看记录和成果，点击“接收成果”。按 **Ctrl+C** 停止 demo，确认执行收尾后清理其临时数据；清理阻断时保留目录与归属记录。需要保留任务时使用 [持久实例启动](docs/getting-started.md#保留任务的本机实例)。

完整操作、可复现 HTTP demo 和真实 Claude fixture 见 [首次运行与任务流程](docs/getting-started.md)。停止、备份、升级、回滚和恢复见 [运行维护](docs/operations.md)。

## 可以做什么

| 功能 | 当前行为 |
| --- | --- |
| 创建任务 | fake 演示；Claude 使用本机已有认证，在独立 Git worktree 执行 |
| 查看执行 | 持久事件、各 Agent 阶段、实际验证输出、补丁与汇总；SSE 断线后补发 |
| 人工控制 | 补充要求、阶段结束后暂停、立即接管、继续、重试和取消 |
| 审批与交付 | 工具请求等待明确允许/拒绝；完成后接收成果或带要求退回返工 |
| 重启恢复 | 核验已登记进程归属，活动任务进入 interrupted；用户明确继续后恢复 |
| 实例配置 | Agent 档案和执行超时；任务保存创建时快照，后续修改不改变既有任务 |
| 设备访问 | 显式 paired 模式、一次性配对、CSRF 与设备撤销；默认仅 loopback |

单实例按 FIFO 一次执行一个任务，分析阶段最多两个引擎会话并行。`completed` 表示执行完成，`accepted` 表示用户接收；接收不会提交、合并、推送或部署代码。worktree 隔离 Git 修改，不能充当操作系统沙箱。

## 验证与交付边界

```sh
npm run doctor
npm run demo -- --check
npm run typecheck
PERSONAL_AGENT_SSE_REAL_SOCKETS=1 npm test -- --maxWorkers=1 --minWorkers=1
npm run smoke
npm run build
```

自动测试使用临时 Git 仓库、fake ACP、验证子进程和虚拟设备，不调用真实模型。全量测试会在临时数据库生成并销毁测试配对票据和会话；它不会给真实设备开通访问。

源码维护者在 Git 检出目录执行 `npm run share:check`，只检查跟踪文件。接收无 `.git` 的源码归档时按提供的 SHA-256 清单核验，无需运行此维护命令。

2026-10-07 从 `39fe311` 的干净源码在独立目录完成 `npm ci`、类型检查、构建与 **605/605、33 文件、零跳过**全量回归，本机 macOS arm64 / Node 24.18.0 的 doctor、smoke、HTTP demo、fake 中断/重试和冷备份恢复均通过。今日真实 greeting fixture 完成 5 阶段、5 次 AgentRun、Runtime 3/3 测试与 8 项成果，浏览器接收、刷新重选和正常服务重启后记录保持一致。10 月 6 日三环境全量结果单独保留为历史证据。完整命令和边界见 [本次交付验收](docs/delivery-acceptance.md)，分享材料见 [分享与证据清单](docs/sharing.md)。

真实 HTTPS、Named Tunnel、手机移动网络完整流程和系统自启动尚待单独配置及验收。服务固定监听 `127.0.0.1:47801`，默认免登录本地模式不得直接转发到公网。设备配对、代理配置及原数据迁移见 [设备访问说明](docs/device-access.md)。

## 工程与许可

| 目录 | 职责 |
| --- | --- |
| `apps/server` | Fastify 5 API、SSE、同源 Web 托管、实例锁与启动恢复 |
| `apps/web` | React 18 / Vite 5 / Antd 5 浏览器工作台 |
| `packages/contracts` | 共享类型、任务状态机与错误契约 |
| `packages/runtime` | Node SQLite、ACP、worktree、流水线、验证、检查点和进程账本 |
| `scripts` | 本地演示、fixture、受限 Claude 探针、备份检查与显式配对操作 |

npm workspaces / TypeScript ESM；依赖由 `package-lock.json` 固定，ACP SDK **1.3.0**、Claude ACP **0.65.0**。模型凭据由引擎使用其本机原生配置，本项目不提供登录或凭据搬运服务。

项目当前声明 [Apache License 2.0](LICENSE)，并保留固定来源 [NOTICE](NOTICE)；公开仓库发布仍待用户批准，本轮仅准备本地源码草稿。依赖采用各自许可，完整分发边界见 [第三方许可说明](docs/third-party-licenses.md)。架构、讲解提纲和分享检查见 [分享说明](docs/sharing.md)。实施边界见 [MVP 计划](plans/personal-agent-mvp-plan.md)，历史证据见 [阶段一](docs/phase1-acceptance.md)、[阶段二](docs/phase2-acceptance.md)、[阶段三](docs/phase3-acceptance.md)、[阶段四](docs/phase4-acceptance.md)。
