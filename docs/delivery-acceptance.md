# 2026-10-07 本地交付验收

本机可运行交付已验收。执行源码基线为 `39fe3115b86f138b0f07309b98963b22370227a3`（114 个跟踪文件）；本次收尾仅更新中文文档并保留历史报告，没有改运行代码、锁定依赖或许可证。最终文档提交、文件数与逐文件 SHA-256 由交付包的 `source-manifest.json` 记录。未公开 push、发布文章或升级 M1 生产实例。

## 今日独立源码安装与全量检查

从上述 Git 提交导出新独立目录，不复用主仓库 node_modules，也不覆盖旧 task-2 检查点。macOS arm64，Node **24.18.0**，npm **10.9.2**。安装使用不同的空 user/global npm 配置、官方注册表、TLS 校验和已校验缓存。`npm ci` 新安装 **340 个包**，退出 0。首次下载时间取决于网络与缓存，不承诺固定分钟数。

```sh
npm ci --ignore-scripts --prefer-offline \
  --registry=https://registry.npmjs.org --strict-ssl=true --no-audit --no-fund
npm run typecheck
npm run build
PERSONAL_AGENT_SSE_REAL_SOCKETS=1 \
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 \
npm test -- --maxWorkers=1 --minWorkers=1
npm run doctor
npm run smoke
npm run demo -- --check
```

| 今日检查 | 实际结果 | 退出码 |
| --- | --- | --- |
| npm ci | 340 包安装完成 | 0 |
| typecheck / build | 根工程和 Web 类型检查、Web 构建通过 | 0 / 0 |
| 全量测试 | **33/33 文件，605/605 用例，0 跳过**，101.45 秒 | 0 |
| doctor | READY，依赖、Git、进程管理和 Web 构建就绪 | 0 |
| smoke | PASS；独立 stdio fake ACP，completed、13 事件、1 成果 | 0 |
| HTTP demo | PASS；故障 failed/7 事件/0 成果；正常 completed/13 事件/1 成果；命令重放与 SQLite 一致 | 0 |

全量测试启用真实 loopback HTTP/SSE socket，使用临时仓库、fake/mock 引擎、验证子进程和临时虚拟身份，不调用真实模型或给真实设备配对。HTTP demo 拒绝 Claude 真实执行；检查模式退出并清理。构建保留 774.98 kB 单 chunk 的 Vite 提示，安装有传递依赖 glob 的弃用提示；这些不是此次检查失败。未将安装成功称作依赖安全审计。

## 今日 fake 中断、重试与隔离冷恢复

独立测试包装器为 fake ACP 注入一次瞬时错误或挂起；标记在专用测试数据中持久化，后续 attempt 不再注入故障。包装器是私有验收材料，不加入产品或源码包。固定 `fake:error` 原目标重试仍会触发同一错误，不能把它当作自动修复示例。

1. ACP 首次异常退出，任务为 failed、没有成功成果，原始错误内容保持脱敏；HTTP 显式 retry 后新 attempt 完成并产生 1 项成果。
2. 另一个 fake 任务执行中仅向自建服务 PID 发送 SIGKILL。用同一源码、路径与测试数据重启，生产恢复器核验并收尾其 ACP 进程，任务进入 interrupted，旧事件完整保留，没有自动继续。
3. HTTP 显式 retry 后建立新 attempt，任务 completed；接收成果后保存完整快照。自建服务正常停止，实例锁释放。
4. 冷备份 **5 个文件**，逐文件大小/SHA-256 全部一致，源 SQLite 字节不变。将备份数据复制到另一个尚不存在的隔离目录并实际启动；两项原任务的完整 HTTP 快照逐项相等，accepted 状态保留，health 为 ok。
5. 恢复副本继续创建新的 fake 任务，completed、1 成果；服务正常关闭。模型调用数为 0，未读取或改动生产数据。

这是同机 fake 数据恢复演练，不是跨机器 worktree 迁移、生产升级或故障切换验收。冷备份与恢复步骤见 [运行维护](operations.md#隔离副本恢复演练)。

## 今日真实开发与浏览器既有检查点

恢复前的 `real-fixture-result.json` 记录 PASS：真实 greeting fixture **5 个阶段、5 次 AgentRun** 完成，Runtime **3/3** 测试通过，exitCode **0**，**8 项成果**。原文件 WIP 未变；实际浏览器接收、刷新和重新选择原任务后成果仍见；1280px 与 390px 视口验证，390px 无横向溢出；临时服务正常重启后快照不变。

该结果是 **2026-10-07 已完成的真实任务**，恢复收尾没有重复运行有成本的任务。证据快照 SHA-256 为 `18ff78b636ed7114f70f9a2c1d53e4f68bbdefdba819511986aa0d9fb5006942`。它不证明任意仓库、provider 或实体手机移动网络均可用。

旧 CLI 会话 15284 与 53139 在接管时已失效；只读进程/端口检查未发现对应安装进程或 47812 监听，没有误停其他服务。task-2 的缓存重试安装日志退出 0，旧独立目录的两处未合入文档改进保留并纳入此次文档收尾。

## 历史证据与 M1 范围

[2026-10-06 交付报告](delivery-acceptance-2026-10-06.md) 保留当日 MacBook Node 22.18.0、24.18.0 与 M1 独立目录 Node 24.21.0 各 **605/605、33 文件、无跳过**的记录，包含 Chrome fake 操作与 M1 受限 Claude 探针。今日只新增上面的本机 Node 24.18.0 全量结果，没有声称重跑三环境。

本次交接提供的 M1 只读检查点为源文件 **114/114** 与 `39fe311` 一致、health ok、监听 `127.0.0.1:47801`、launchd 节流 30 秒。这些是交接状态，本恢复任务未重复深查、注入故障、更新源码、迁移生产数据或改变其网络/安全设置。10 月 6 日报告描述的是当日原实例状态，应按日期阅读。

## 证据与干净源码

私有本地证据分别保存在任务检查点目录：今日独立 npm-ci/typecheck/build/full-tests/doctor/smoke/demo 日志、`verification-status.json`、`recovery-result.json` 与隔离恢复数据；真实 fixture 的结果与快照保留在原 task-2 检查点。源码分享包不包含这些日志、任务正文、数据库、备份、截图或绝对机器路径。

源码包只从最终审阅提交导出，保留 README、LICENSE、NOTICE、package-lock、源码、测试及中文文档；附提交标识、文件大小与 SHA-256 清单。排除 `.git`、node_modules、dist、credentials、runtime 数据、数据库与私有验收证据。`share:check` 是启发式检查，不能作为绝对无秘密保证。Library 保存只有返回确认文件 ID/版本才算上传完成；未确认时以本地包与摘要交付，不虚称附件成功。

## 尚待用户决定或另行验收

项目当前声明 Apache-2.0，本轮未修改 LICENSE、NOTICE 或 package metadata；公开仓库推送与文章发布仍待用户批准。真实 HTTPS、固定公网入口、生产 paired、实体手机关闭 Wi-Fi 后的创建/审批/接管/重连/接收/撤销属于后续部署与实测范围，尚未记为本报告已通过。Linux 未做目标机验收，Windows 当前进程管理不支持。这些范围不影响已验证的本机源码安装、fake 演示和今日真实 fixture 结果。
