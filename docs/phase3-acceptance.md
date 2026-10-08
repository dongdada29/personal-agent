# 第三阶段：本地任务可靠性验收

日期：2026-10-02。环境：macOS arm64，Node.js 24.18.0 与 22.18.0。本阶段完成本地暂停、接管、恢复、交付控制、持久审批、SSE 与配置快照；不包含远程访问或设备鉴权。恢复版本标记为 `phase3-validated`，只保存本地 Git。

## 已实现与文件

| 部分 | 主要文件 | 结果 |
| --- | --- | --- |
| 契约 | `packages/contracts/src/index.ts` | 控制命令、指令、配置快照与 PipelineCheckpoint；状态机保留 attempt 隔离 |
| 持久层 | `packages/runtime/src/store.ts`、`migrations.ts` | v3 增量迁移；配置/档案、控制意图、进程账本及审计；阶段完成与游标原子提交；COMMIT 后通知 |
| 执行 | `packages/runtime/src/pipeline.ts`、`runner.ts` | 阶段暂停、立即接管、补充要求、重新验证、从未完成阶段开启新 attempt；保留原 worktree 和历史成果 |
| 进程 | `process-owner.mjs`、`process-registry.ts`、`engine-acp.ts`、`verification.ts` | fd3 START 门禁；登记成功才启动命令；固定归属核验、有限时收尾及持久关闭 |
| 服务 | `apps/server/src/app.ts`、`instance-lock.ts`、`main.ts`、`sse.ts` | 全部控制/配置 API、独占目录、启动恢复与持久 seq 补发 |
| 工作台 | `apps/web/src/App.tsx`、`TaskControls.tsx`、`TaskContext.tsx`、`SettingsPanel.tsx`、`task-feed.ts`、`mutation-commands.ts`、`approval-display.ts` | 控制与成果接收、配置/档案选择、快照展示、SSE 重连、单飞提交与丢响应重试 |
| 回归 | `packages/runtime/test`、`apps/server/test`、`apps/web/test`、`packages/contracts/test` | 共 24 个测试文件；新增服务崩溃 fixture 位于 `apps/server/test/fixtures` |

未新增依赖，ACP SDK 1.3.0 和 Claude ACP 0.65.0 保持精确锁定。原 Apache 2.0 来源及 NOTICE 保留，相邻旧工作区没有修改。

## 行为与故障验收

- 双分析作为一个阶段收尾。阶段成功状态、下一阶段游标和事件在同一事务提交；pauseRequested 禁止进入新阶段。所有五个阶段的暂停与恢复均覆盖，已完成阶段不重复执行。fake 单阶段完成后暂停再继续也不重复生成成果。
- takeover/cancel 先持久保存控制意图与要求，再取消当前 Agent/验证并确认进程退出。等待审批时无需批准工具，旧审批过期；继续建立新 attempt，迟到回调和旧审批不能写入新 attempt。补充要求立即落库，并在下一阶段统一取快照。
- accept 只更新交付状态。return 必须填写要求，保留 worktree、旧成果与分析，从开发阶段建立新 attempt；不会提交、合并、推送或部署代码。
- commandId 使用共享持久命名空间；重复请求返回原结果，改变任务、action 或内容返回 409。测试包含并发重复、未完成意图跨重启、字段顺序不同的同义请求以及 HTTP 响应丢失后重试。
- 验证证据保存完整补丁 SHA-256。评审、汇总和交付前后代码变化，或旧游标缺少指纹时，清除旧验证关联、审查和 outcome，退回实际验证，保留历史阶段与成果。人工修改后的失败测试不能沿用旧 pass；原计划的一次自动返工仍保留。
- 完成检查点事务回滚后，阶段记为 failed、原游标不前进。失败状态也不能落库时阻断调度。审批或事件持久化失败立即触发 EVENT_FAILURE 并关闭进程，不等默认 30 分钟预算。
- 配置和档案更改不影响既有任务快照；角色不匹配拒绝，档案 PATCH 不能改角色。公开配置仅含模型标识、提示词、引擎选择和超时，不管理凭据。默认引擎供工作台选择；API 省略 engine 时继续兼容 fake。

SSE 使用持久 seq、Last-Event-ID 与 after 游标，支持快照到订阅之间的缺口、按序去重、任务隔离、异常订阅者、重入提交、慢连接和有界缓冲。通知只在 COMMIT 后发出，回滚无通知；通知内容与落库 JSON 完全一致。断线、页面关闭与服务关闭均正确清理订阅，断线不取消任务。

## 重启与权限边界

最终回归中的真实重启使用自行新建的临时 Node、Git 和 ACP fixture，没有调用真实模型。服务通过 IPC 测试，不监听测试端口；人为 SIGKILL 只用于本次新建的 fixture 服务。

1. 挂起 ACP 引擎及孙进程：服务崩溃后，核验固定 Node executable、wrapper 路径、UUID、PID/PGID，停止对应进程组，任务变为 interrupted。未自动重放；明确 resume 才建立新 attempt。
2. 持久审批：服务崩溃后旧审批 expired，未授权工具，工作区日志和文件保持原状；明确继续后生成不同 attempt 与审批，分析不重跑。
3. 正在执行的验证：清理已登记验证进程组，保持 verification 游标；日志没有自动追加。明确继续后验证再次执行，开发不重跑。
4. 无法核验的账本、EPERM/EACCES、标记或进程组不匹配、死 owner 但仍有活动组，均不发送恢复信号。启动阻断并保留锁、原任务与账本。旧版活动 attempt 没有进程账本时也拒绝假定旧工具已经停止。

沙箱最初禁止 ps。没有换渠道读取受限信息或放宽匹配；限定查询本次 fixture PID 的 PID/PGID/命令行后，通过工具 `require_escalated` 的合规审批完成真实恢复检查。不读取进程环境变量，不修改系统设置。沙箱定向测试的进程元数据模拟与正常权限下的真实崩溃测试分别保留；最终两套全量回归均包含真实检查，没有跳过。

## 最终命令与结果

| 命令 | Node 24.18.0 | Node 22.18.0 |
| --- | --- | --- |
| `npm run typecheck` | 通过（build 内执行） | 通过 |
| `npm test -- --maxWorkers=1 --minWorkers=1` | **424/424，24 文件，无跳过** | **424/424，24 文件，无跳过** |
| `npm run smoke` | fake stdio ACP completed，13 events、1 artifact | 同样通过 |
| `npm run build` | 通过 | 通过 |
| `git diff --check` | 通过 | 同一源码 |

Node 22.18 使用前阶段从官方发布取得并校验的二进制。测试输出位于 `.data/phase3-acceptance/evidence/node24-tests.log` 与 `node22-tests.log`。Node 22 的 SQLite experimental 提示及 Vite 大 chunk 提示仍存在，未影响检查结果。

`npm run probe:claude` 在新版实现上通过真实 ACP 协议、会话与 plan 模式；isolated 配置、工具/hooks/MCP/持久化均关闭，authenticatedPrompt 为 **not_checked**。本轮没有发新的真实模型请求；前阶段的认证与真实开发闭环证据仍见 [第二阶段验收](phase2-acceptance.md)，不能据此声称本轮重做了真实模型开发任务。

## 手机与桌面

Nuwa 独立 Space 中验收 390px 与 1600px，两者 scrollWidth 分别等于 390 和 1600。覆盖配置 PATCH、创建档案、快照不变、退回/接收、反馈丢响应重试、暂停/继续/接管及双击单飞。

在无模型 ACP 审批 fixture 上主动关闭 SSE 并阻断重连，任务与 attempt 不变、审批保持 pending，界面降级轮询；解除后从 cursor 85 自动重连。暂停后旧审批 expired，继续后新 attempt 与新审批，接管要求只保存一次。没有调用审批 resolve。所有 QA 任务最后为 accepted 或 cancelled，没有待审批或可继续的 mock 引擎任务。

普通测试证据保存在忽略目录 `.data/phase3-acceptance/evidence`：`ui-evidence.json`、12 张手机/桌面截图、`preview-before-restart.json`、`restarted-preview.json`。正式 main 重开同一数据目录后，三个任务快照字节完全一致，SHA-256 为 `c4045953b63eee20b66952992bb31236cdbbb6569db06f3907fddc21cb40f385`；活动进程账本 0、待审批 0、health ok。预览仅位于 `http://127.0.0.1:47801`。

## 剩余项

当前没有本地验收阻碍。Linux 目标主机尚未实测；Windows 进程管理返回 PROCESS_UNSUPPORTED，不能宣称跨平台验收完成。设备配对、鉴权/CSRF、设备撤销、常驻安装、隧道和跨网访问、大成果分页与下载、引擎模型目录仍属于后续工作。本阶段没有生成访问凭据、配置网络、建立隧道、推送、创建 PR 或部署。
