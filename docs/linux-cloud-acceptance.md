# 2026-10-08 Linux 云端开发与验收

完整源码发布基线为 [`def4a2138c33f8ee46840e3f388e637e80ea511f`](https://github.com/dongdada29/personal-agent/commit/def4a2138c33f8ee46840e3f388e637e80ea511f)，树为 `ce7780f55b94add159ce825fdf621156aab0e123`，共 116 个跟踪文件。后续开发、修复与测试在 Codex Linux 云端工作区完成，不依赖用户 MacBook 或 M1 在线；10 月 6 日、7 日的 macOS 结果保留为历史，不能作为本次 Linux 通过证据。

云端工作区会话用于开发与验收，不构成生产永久在线、公开部署、系统自启动或持续外部访问保证。本轮仅使用临时数据、fake/mock 引擎、测试自建进程和虚拟身份；不读取真实模型凭据，不操作用户本机或 M1 实例。

## 环境与基线结果

首轮源码验收环境为 Debian 13.6、Linux 6.18.44 x86_64，Node 24.19.0、npm 11.9.0、git 2.52.0。从官方注册表完成干净安装 342 个包；类型检查、构建、doctor、smoke 和 HTTP demo 均退出 0。完整测试为 590/605 通过、15 项失败、0 跳过，29/33 文件通过，并有 4 个未处理错误；不能将该基线写成 Linux 全量通过。

失败集中在容器中未被 init 回收的僵尸进程：`kill(-PGID, 0)` 仍成功，清理误判为执行未结束；恢复时僵尸已经没有可匹配的 argv，又触发 `unsafe`。修复通过只读 `/proc` 区分僵尸与活动成员，同时保留 owner 归属与恢复门禁；owner 僵尸而组内仍有活动成员，或状态无法安全核验时，仍须阻断。

进程检查要求同一 PID 命名空间和完整可见的标准 `/proc` 挂载。受限 `hidepid` 视图、PID 子目录额外挂载、不可读取或不确定的状态继续阻断；僵尸主线程仍有其他线程也不能算执行结束。非 Linux 的实例锁继续只接受 `ESRCH` 作为不存在的证据。

## 修复后完整验收

本记录所在的 `fix/linux-zombie-process-recovery` 分支基于上述 `def4a213`，验收源码对应草稿 PR 的提交。最终全量复验于 2026-10-08 15:35:46 UTC 开始，环境仍为 Debian 13.6、Linux 6.18.44 x86_64、Node 24.19.0、npm 11.9.0、git 2.52.0。复验前固定 108 个非 Markdown 文件的 SHA-256，全部检查完成后确认这些文件没有变化；文档随后填入结果。

| 检查 | 最终结果 | 退出码 |
| --- | --- | --- |
| 官方注册表干净安装 | 342 个包，禁用安装脚本、启用 TLS 校验 | 0 |
| TypeScript 类型检查 | 通过 | 0 |
| 构建 | 通过；Vite 提示现有大 chunk，未阻断构建 | 0 |
| 完整测试 | **695/695、36/36 文件、0 跳过、0 未处理错误** | 0 |
| doctor | `READY`；不检查真实引擎认证或公网访问 | 0 |
| smoke | `PASS`，fake ACP over stdio | 0 |
| HTTP demo | `PASS`，命令重放、SQLite/HTTP 一致性及拒绝真实执行 | 0 |

保留原有 605 项测试，新增 90 项回归：进程状态 75 项、实例锁 8 项、fixture IPC 与清理错误 7 项。旧测试的存活断言使用独立的 `ps` 观察器，避免用生产判定函数验证其自身；真实重启 fixture 与 loopback HTTP/SSE 都实际执行。测试没有隐藏失败或跳过原场景。

smoke 与 demo 已关闭自建服务并清理各自临时数据；没有生产数据访问或真实访问凭据生成。僵尸可以仍由容器 PID 1 持有，但已确认没有活动执行；本修复不替代 init 回收僵尸，也不扩大原有进程组信号范围。

在最终修复源码上使用官方注册表、TLS 校验与锁定依赖执行：

```sh
node --version
npm --version
git --version
npm ci --ignore-scripts --registry=https://registry.npmjs.org --strict-ssl=true --no-audit --no-fund
npm run typecheck
npm run build
PERSONAL_AGENT_SSE_REAL_SOCKETS=1 \
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 \
npm test -- --maxWorkers=1 --minWorkers=1
npm run doctor
npm run smoke
npm run demo -- --check
git diff --check
```

全量启用真实 loopback HTTP/SSE socket，单 worker 控制资源；Git 配置隔离避免主机全局配置影响临时仓库测试。临时虚拟认证不为真实设备开通访问。`smoke` 通过 `app.inject` 和 stdio fake ACP 检查任务；`demo -- --check` 检查真实 HTTP、命令重放、SQLite 一致性及拒绝真实执行，完成后关闭并清理自己的数据。

## 未验证范围

本次不验证真实模型调用、真实 Claude 开发任务、浏览器交互、HTTPS、固定公网入口、生产 paired 或手机关闭 Wi-Fi 后的跨网流程，也不承诺工作区之外的持续运行。Linux 其他主机、init 配置或容器环境应在目标环境复验；僵尸的最终回收仍由操作系统父进程/init 负责。Windows 进程管理当前未适配。

本轮修复通过草稿 PR 供审阅，不自动合并或部署。既有 macOS/M1 真实 fixture 与运维记录见 [2026-10-07 本机交付验收](delivery-acceptance.md) 和 [2026-10-06 历史报告](delivery-acceptance-2026-10-06.md)。
