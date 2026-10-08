# 首阶段验收记录

日期：2026-10-02。环境：macOS arm64。此记录只证明首阶段本地底座，不代表完整 MVP、真实开发任务或手机跨网验收完成。

## 已交付

| 范围 | 文件 |
| --- | --- |
| npm workspaces、精确依赖锁、类型与测试配置 | package.json、package-lock.json、tsconfig.json、vitest.config.ts |
| 共享任务/事件/成果类型、执行和交付状态机 | packages/contracts/src/index.ts、对应状态机测试 |
| SQLite WAL、版本迁移、事务事件、幂等、attempt 围栏 | packages/runtime/src/migrations.ts、store.ts、对应存储测试 |
| FIFO fake 任务执行、异常收尾、进程退出确认、调度阻断 | packages/runtime/src/runner.ts、对应执行器测试 |
| 最小 EngineAdapter、SDK stdio fake ACP、受控故障、真实 ACP 探针 | packages/runtime/src/engine*.ts、引擎测试、scripts/probe-claude.ts |
| Fastify 创建/列表/快照/事件/成果 API、实例目录锁 | apps/server/src/*、对应 inject 测试 |
| 响应式任务创建、进度和成果工作台 | apps/web/* |
| 使用说明与固定代码来源 | README.md、LICENSE、NOTICE |

迁移当前保存 tasks、attempts、task_events、artifacts 和 commands。阶段、档案、工作空间、审批、设备等表随对应后续功能引入。fake 成果是演示文本；不代表开发补丁或真实测试记录。

## 自动验证

Node 24.18.0 与计划指定的 Node 22.18.0 均完成下列测试及 smoke。22.18.0 使用 Node 官方临时发行包，并核对官方 SHA256；没有更改系统 Node。

| 命令 | 结果 |
| --- | --- |
| `npm test` | 两个版本均 5 个测试文件、149/149 项通过 |
| `npm run smoke` | 两个版本均 PASS；实际 stdio fake ACP，completed、10 条事件、1 份成果 |
| `npm run typecheck` | server/runtime/contracts 与 Web 均通过 |
| `npm run build` | 通过；Web 单 JS 包约 590 kB，有 Vite 体积提示 |
| `npm ls @agentclientprotocol/sdk claude-code-acp-ts` | SDK 1.3.0、Claude ACP 0.65.0；SDK 去重到同一版本 |

测试覆盖任务创建落库和重开、幂等原结果与冲突、事件游标、事务中断完整回滚、合法和非法状态转换、独立交付状态、过期 attempt、重启 interrupted、fake 崩溃后继续 FIFO、权限拒绝、目录/数据库故障、调度收尾入队竞争、旧成果围栏、实例锁以及 blocked 的 HTTP 503。

引擎测试启动独立进程，覆盖模式缺失/切换失败、审批回执和取消、prompt 重叠、启动/执行超时、关闭期间输出围栏、忽略取消和 SIGTERM 的子进程组、畸形 ACP 原始诊断过滤。Windows 清理有失败关闭分支，但本记录没有 Windows/Linux 实机证据。

## 真实引擎探针

运行：

```sh
npm run probe:claude -- --prompt --user-settings
```

在允许出站联网的执行环境，结果为：

```json
{
  "protocolReady": true,
  "sessionReady": true,
  "planModeSupported": true,
  "authenticatedPrompt": "passed",
  "configSource": "user"
}
```

真实引擎返回了要求的固定文本。工具、hooks、插件、外部 MCP、自动更新及会话持久化均在探针内禁用；无客户端文件或终端能力，不授予工具权限。使用现有原生认证/provider，无登录、生成 token、凭据输出、转存或持久配置。

隔离用户设置的初次探针出现 AUTH_REQUIRED；加载现有用户设置但使用受限网络时出现 PROMPT_TIMEOUT。最终用户设置模式和允许联网模式已通过，因此无需新建凭据或重新配置 provider。这只证明无工具的真实模型往返，不证明真实开发流程。

## Web 实测

使用 nuwa-browser 的独立任务空间，实际点击创建任务，看到 completed、10 条事件和成果。重启服务、刷新页面后成果仍可读取。

| 视口 | document scrollWidth | document clientWidth | 结果 |
| --- | --- | --- | --- |
| 1280px 桌面 | 1280 | 1280 | 无页面横向溢出 |
| 390px 手机模拟 | 390 | 390 | 无页面横向溢出，成果可读 |

这是浏览器视口模拟，不是手机实机或移动网络验收。

## 本地预览与恢复点

本轮启动的临时本地预览：`http://127.0.0.1:47801`。

```sh
PERSONAL_AGENT_DATA_DIR=/tmp/personal-agent-browser-acceptance npm run dev
```

该进程为前台开发服务，没有安装开机启动。测试数据在 /tmp，正式本地使用可按 README 选择数据目录。接口只执行 fake 任务，未创建隧道、配对访问或远程网络配置。

源码前恢复点：`phase1-baseline`（46cd87e）。本阶段完成恢复点：`phase1-foundation`。仅本地 Git，没有 push、PR 或部署。

## 下一阶段

按原计划接入登记 Git 工作空间、基线和 worktree，固定双 Agent 分析、开发、Runtime 实际验证与评审成果。随后加入阶段/档案配置、持久审批和接管、SSE、设备配对、远程入口及跨平台实机验证。Cloudflare 账号、域名、持久访问和安全网络配置仍需单独授权；本阶段未执行这些操作。
