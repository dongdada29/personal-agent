# 第二阶段本地验收

日期：2026-10-02。环境：macOS arm64。源码、自动检查、自建 fixture 真实开发闭环与最终服务重启复验均通过。没有推送、PR、部署、隧道、配对或凭据配置变更。

## 实现

- contracts 增加工作区、阶段、AgentRun、验证与审批，严格解析 pass/rework，拒绝非法审查结果。
- SQLite v2 保留 v1，持久执行记录和审批，当前 attempt 约束写入。
- 登记仓库固定 HEAD 创建任务分支/worktree，保留宿主 WIP，重试复用 worktree；补丁包含新增文件，拒绝二进制和超过 1 MiB 的结果。
- 两个 plan 分析并行，开发 default；Runtime 执行用户选定 executable/args，真实退出码及输出落库。模型 pass 不能覆盖测试失败，自动返工最多一次。
- 用户处理持久审批；取消确认进程退出；新 attempt 保留历史。并发重复审批只投递一次，旧审批不能污染新 attempt。
- 审批保存完整 kind/rawInput/content/locations，UI 在选项前展示路径与 diff。完整请求超过 128 KiB UTF-8 时 EVENT_FAILURE，不生成可批准请求、不截断证据。
- Web 展示基线、阶段/角色、验证、补丁与审批，并提供取消/重试。流式消息合并展示，原始序号和详情保留。

## 自动检查

分别在 **Node 24.18.0** 和 **Node 22.18.0** 执行通过：

```sh
npm run typecheck
npm test
npm run build
npm run smoke
```

- Vitest：13 文件、**267/267 通过**。
- stdio fake smoke：completed，10 events、1 artifact，cursor=10。
- server/runtime/contracts/Web 类型检查和 Vite 构建通过；`git diff --check` 通过。
- Node 22 SQLite experimental 和 Vite bundle >500 kB 提示为非失败信息。
- 只读复核重跑 runner/startup/metadata/phase2 API：4 文件、24 项通过。

回归包括：分析同组失败与清理、启动取消、exit 23 与模型 pass 冲突、顽固子进程、数据库收尾失败时取消返回、排队取消竞态、并发审批幂等、审批等待不消耗活跃预算、启动失败释放 DB/锁、审批跨重开过期且不重放、缺用户 settings.json、完整审批证据传递和四种超限请求拒绝。

`npm run fixture` 重复执行通过，没有覆盖宿主 WIP。基线 `node --test test/greet.test.js` 预期 1 pass/2 fail（exit 1），证明需求尚未实现；这不是最终开发验证结果。

## 浏览器

nuwa-browser 本机验收，临时测试服务已关闭：

- fake completed，10 事件/1 成果，刷新保留。
- 独立 Git fixture 登记成功；空 executable、非 JSON args、非字符串参数阻止提交。
- 真实任务 Claude 标签、基线、worktree、双分析及开发/待审批可见。
- 当时 1,891 条持久事件合并为 22 段可读记录，原始详情可展开。
- 390px：`clientWidth=scrollWidth=390`，审批按钮正常换行。

最终任务通过只读浏览器验收：5 阶段 completed、Runtime exit 0 和 stdout 3 pass/0 fail、结构化 review pass、Code patch 包含 greet.js 和新增 CHANGELOG.md、Delivery summary 均可见。刷新后结果保留，3036 原始事件合并为 60 段，390px 仍无横向溢出。

## 真实引擎

仅执行项目自建、无敏感数据和第三方依赖的 greeting fixture，没有执行用户其他仓库。Claude 原生使用已有认证/provider，没有复制、输出、生成或改写认证。

| 项目 | 观察结果 |
| --- | --- |
| 仓库 | `.data/phase2-fixture/repo` |
| 基线 | `ab4fe68f0a861472ea1faf567324e65dc7f19258` |
| 任务 | `45f3614e-2f5f-4ed3-9549-adb95b891732` |
| attempt | `5ada7c6f-7b5a-420e-bc01-bb61766b93a3` |
| 数据 | `.data/phase2-acceptance`，Git ignored |
| worktree | `.data/phase2-acceptance/tasks/45f3614e-2f5f-4ed3-9549-adb95b891732/workspace` |
| 双分析 | planner/reviewer completed，响应已落库 |
| 开发 | default；仅改 greet.js、新增 CHANGELOG.md，未提交 |
| 权限 | 操作者核对两个完整提案后分别 Allow Once，均 resolved |
| Runtime 最终验证 | 原所选 Node executable + `--test test/greet.test.js`；exit 0，3 pass/0 fail |
| 最终审查 | model/effective verdict 均 pass、blockers=[]，包含文件与实际测试证据 |
| 汇总及补丁 | completed，8 项成果；patch 含新增文件且反向 `git apply --check` 通过 |
| 执行 | 5 阶段、5 AgentRun completed；3036 事件、8 成果、无待审批 |

每个提案均核对完整路径、文件原文/新文、diff 和目标类型，仅为自建 worktree 的 greet.js 或 CHANGELOG.md。产品未增加自动审批；本次开发测试操作者按既定 fixture 范围分别选择 Allow Once，没有 bypass、allow_always 或持久权限设置。宿主 HEAD 仍为原基线，只有预置 README WIP，宿主 greet.js 未改变；任务 worktree HEAD 也未提交。

早期任务 `db8b78bc-a781-41f3-89e7-5a05c7b872aa` 的审批只有标题，无法完整审核，因此安全取消并保留分析与 expired 审批。补齐完整证据后，最终版本新任务完成上述闭环。早期 npm 终端退出遗留服务锁，经确认 PID 退出、无监听和无所属 fixture 进程后人工清理；最终直接启动进程正常 SIGTERM 退出 0 并自动释放锁。

最终服务重启后，整个任务快照字节相同：SHA-256 `ee476770b40ec9e6c4ab5fea5ae9280c9a981198725767eef0e8120e1a975200`，仍 completed、5 runs、3036 events，没有模型工具重放。最新 runVerification 在同一 worktree 再执行原所选命令，exit 0、3/3 通过。

非敏感证据导出在 Git 忽略目录 `.data/phase2-acceptance/evidence/`：`fixture-snapshot.json`、`fixture.patch`、`verification.json`、`restarted-verification.json`。截图在 `/tmp/personal-agent-phase2-approval-details-mobile.png`、`/tmp/personal-agent-phase2-real-validation-mobile.png` 和 `/tmp/personal-agent-phase2-real-patch-mobile.png`。

首阶段固定文本真实 Claude 探针通过，见 [首阶段记录](phase1-acceptance.md)。本阶段另有上述完整真实模型、文件编辑和 Runtime 子进程证据，不以 fake 测试替代真实开发结果。

## 待完成

retry 当前重新执行完整流程并保留 worktree、旧 attempt 与证据；尚无从未完成阶段接管。成果接收/退回、档案配置、SSE、持久进程登记/恢复协调、配对/鉴权/隧道和手机跨网验收按原计划继续。worktree 不是操作系统安全沙箱，实机证据仅限 macOS。

下一步按原计划实施接管、成果接收/退回和故障恢复。当前本地验收无剩余权限或认证阻碍；远程和跨平台能力不包含在本次通过声明中。
