# Personal Agent 首版实施计划

日期：2026 年 10 月 2 日。工作名称：Personal Agent。计划状态：首阶段底座、第二阶段本地流水线与真实 fixture 闭环、第三阶段本地任务可靠性及工作台均已验收；第四阶段设备配对/访问鉴权代码与隔离验收已完成，真实 HTTPS、Named Tunnel 和手机跨网尚未启用或验收。证据见 ../docs/phase1-acceptance.md、../docs/phase2-acceptance.md、../docs/phase3-acceptance.md 和 ../docs/phase4-acceptance.md。

目标是在用户的电脑或虚拟机上运行一个常驻 Personal Agent，提供后台管理与手机 Web 客户端。用户下达目标，多个 Agent 分工执行，用户接收成果，也能中途审批、补充要求或接管。首版以一个真实开发任务证明完整流程，并在 10 月 7 日前形成可演示原型。

本文采用的默认选择是成熟引擎优先、开发任务优先、手机浏览器通过 HTTPS 访问。此前尚未收到这些选择的单独回答；它们作为首版默认值写入计划，可在开始实现前调整。

## 1 首版产品与范围

Personal Agent 是一个长期运行的个人实例，拥有自己的工作空间、Agent 档案、任务记录和成果。执行 Agent 是实例为完成任务启动的引擎会话。首版支持一个用户、一个运行节点和多个已配对浏览器；后台管理与任务客户端共用一个后端及一份数据。

| 入口 | 首版功能 |
| --- | --- |
| 手机任务工作台 | 新建任务、看进度、处理审批、补充要求、接管与继续、接收或退回成果 |
| 后台管理 | 检查运行环境与引擎就绪状态，管理工作空间、Agent 档案、已配对设备及远程入口配置 |
| 本机 CLI | 初始化、启动、停止、检查状态、生成配对入口、查看安装与部署指引 |

内置方案、开发、检查三类 Agent 档案，支持修改名称、提示词及引擎报告支持的模型，支持复制档案；每个任务选择这三个角色的档案。运行任务使用配置快照，后台修改仅影响后续任务。首版只接 Claude 引擎，Codex 和直接模型 API 留给相同适配接口。

首版验证文件、终端和开发工具组成的完整宿主执行环境。浏览器自动化与 GUI 应用接管进入下一阶段。桌面原生客户端、多用户租户、多个节点的统一调度、任意 DAG 编辑、消息渠道生态和跨节点长程记忆也放到下一阶段。

成果包括代码补丁、修改说明、实际测试结果和检查结论。接受成果只更新交付状态并保留任务工作区；合并、推送、发布与清理工作区均由用户单独操作。

## 2 技术结构与复用边界

工程目录为 <PROJECT_ROOT>。采用 npm workspaces，划分 apps/server、apps/web、packages/runtime、packages/contracts 四个边界。运行数据默认位于 ~/.personal-agent，测试使用临时数据目录。

| 子系统 | 确定方案 |
| --- | --- |
| 服务 | Node.js 22.18 及以上、TypeScript ESM、Fastify 5；默认监听 127.0.0.1:47801 |
| 持久化 | SQLite，使用 node:sqlite 的基本 DatabaseSync API；存储层隔离，WAL、事务与版本化迁移 |
| Web | React 18、Vite 5、Ant Design 5；响应式布局，桌面和手机共用，同源由服务托管构建产物 |
| 执行引擎 | claude-code-acp-ts 0.65.0 与 @agentclientprotocol/sdk 1.3.0，精确锁定依赖及 lockfile |
| 通信 | REST 提交命令，SSE 订阅已持久化事件；不把引擎会话状态直接当任务状态 |
| 远程入口 | Cloudflare Named Tunnel，固定 HTTPS 域名；产品提供配置指引与连接检查 |
| 工程验证 | Vitest、Fastify inject、fake ACP 引擎、浏览器验收；macOS、Windows、Linux CI |

node:sqlite 在所选 Node 22 版本中处于活跃开发状态。首版只使用基础建表、预编译语句、事务和查询 API，并在 Node 22.18 与本机 Node 24.18 验证；不使用新版本专属功能。[Node 22.18 文档](https://nodejs.org/download/release/v22.18.0/docs/api/sqlite.html)

从 nuwa-cli 的 Apache 2.0 源码借鉴窄 ACP 连接、引擎进程启动和进程树收尾实现，保留版权、许可证和来源版本，移植部分增加自己的回归测试。参考 swarm 的工件、取消和阶段恢复思路，但不把两个业务系统直接拼接。

不依赖 nuwa-cli 的整套 serve、Nuwax 云账号注册、现有商业隧道或相邻 checkout 的 file: 依赖。其当前服务存在审批随订阅者消失而取消、会话与事件仅在内存等边界，直接继承会妨碍手机离线使用。

新项目计划使用 Apache 2.0。移植代码保留原署名与必要 NOTICE；引擎及其 SDK 按各自许可证使用，发布前检查实际条款，不将第三方执行引擎宣称为本项目自有代码。

## 3 执行流程与接口

### 任务执行

固定流程为：

目标与基线 → 方案 Agent 与检查 Agent 并行分析 → 开发 Agent 修改代码 → Runtime 执行验证命令 → 检查 Agent 评审 → 方案 Agent 汇总成果 → 用户接收或退回。

- 首版全局最多两个引擎进程，一次执行一个任务，其他任务按 FIFO 排队。这样同一任务有真实的双 Agent 并行阶段，也能控制资源和故障范围。
- 新建任务必须选择已登记 Git 工作空间，记录 HEAD SHA，从该提交创建任务专属分支和 worktree。提交页面展示基线；宿主目录未提交修改不进入任务，宿主 WIP 保留。
- 前置两个分析使用引擎 plan 模式；不支持或切换失败则停止并给出错误。开发 Agent 使用 default 模式；不启用 bypassPermissions 或 dontAsk。
- 编码后的验证命令在任务创建时由用户明确选定，Runtime 在任务 worktree 内执行，保存命令、exitCode、stdout、stderr。检查 Agent 使用 plan 模式读取代码与这些记录，不以模型自述替代真实测试。
- 检查结论采用固定结构：pass 或 rework、阻塞问题、对应证据。解析失败进入待人工处理；测试失败不能被 pass 覆盖。
- 首轮不通过时自动返工一次，仍不通过则等待人工处理。用户退回需填写要求，从编码阶段建立新 attempt，再验证、检查和汇总。
- 任一前置分析失败，停止同组另一 Agent，保留已产生工件，任务进入 failed；重试由用户触发。
- 每个 AgentRun 的最大活跃执行时间默认 30 分钟，等待人工审批时间不计入。超时先停止所属进程，再记为失败。
- Git worktree 用于隔离项目修改，不是操作系统安全沙箱。工具权限沿用引擎机制，引擎实际发出的额外权限请求交由用户处理。

### 接管与故障恢复

- “补充要求”立即落库，默认从下一阶段起生效；若希望立即影响当前阶段，选择“立即接管”。
- “阶段结束后接管”保存暂停请求，当前阶段成功收尾后进入 paused，释放引擎资源。并行分析视为同一阶段，需两者都收尾。
- “立即接管”中止当前阶段所有 Agent 与验证进程：先请求取消，5 秒内仍未退出则终止本任务进程树。确认退出后进入 paused，旧审批失效，已有代码与工件保留。
- paused 任务可修改要求后继续。继续从未完成阶段建立新 attempt，保留已完成阶段及任务 worktree；不承诺保留正在推理的进程状态。
- 用户取消任务采用相同收尾流程，终态为 cancelled，不进入 failed。暂停或取消已处于等待审批的阶段时，无需先批准该工具。
- 等待审批独立于浏览器订阅，手机不在线也保持等待；用户的批准或拒绝只适用于对应 attempt 和工具请求。拒绝后交还引擎处理，无法继续的任务失败并保留原因。
- 服务启动时先核验并清理本服务登记的遗留执行进程，仅处理能确认归属的进程；无法确认时停止调度并提示人工处理。原活动任务记为 interrupted，旧审批失效。
- interrupted 任务需用户明确继续，已完成的阶段与成果保留，未完成阶段建立新 attempt。禁止启动时自动重放可能有副作用的工具操作。
- 同一任务同一时刻只能有一个活动 attempt；旧 attempt 的迟到输出和审批不得覆盖当前状态。重试、接管和返工均遵守这个约束。

### 数据与公开接口

SQLite 保存 Task、Stage、AgentRun、TaskEvent、Approval、Artifact、AgentProfile、Workspace、Device 与幂等命令记录。代码和大工件保存在任务目录，数据库只保存索引与必要元数据。

任务执行状态为 queued、running、waiting_human、paused、interrupted、completed、failed、cancelled；pauseRequested 为独立标记。交付状态另记 pending、accepted、returned，completed 表示已经产生交付物，不表示用户已接受。

最小 EngineAdapter 为 probe(config) 与 open(runContext, hooks)。EngineSession 提供 prompt(input, signal)、resolvePermission(requestId, optionId)、cancel()、close()；hooks 为 onEvent 与 onPermission。引擎层不承担数据库、手机鉴权和调度。

| HTTP 接口 | 职责 |
| --- | --- |
| POST /api/pair，GET /api/devices，DELETE /api/devices/:id | 配对、查询与撤销设备 |
| GET/POST/PATCH /api/agents 与 /api/workspaces | 管理 Agent 档案和工作空间；工作空间变更先验证 Git 与路径 |
| GET/PATCH /api/settings，GET /api/health | 管理实例非密钥配置与读取运行状态 |
| POST/GET /api/tasks，GET /api/tasks/:id | 创建任务、列表和带事件游标的任务快照 |
| GET /api/tasks/:id/events | SSE；按 Last-Event-ID 或 after 游标补发，事件先写数据库 |
| POST /api/tasks/:id/control | feedback、pause、takeover、resume、retry、cancel、accept、return |
| GET /api/approvals，POST /api/approvals/:id/resolve | 待审批列表与处理工具请求 |
| GET /api/tasks/:id/artifacts，GET /api/artifacts/:id | 成果列表、受鉴权保护的内容预览或下载 |

状态与控制接口使用共享 TypeScript 类型和服务端 schema 校验。所有状态变更请求带 commandId；相同身份重复请求返回原结果，不重复创建任务或执行操作。非法状态返回 409，过期 attempt 审批返回 409。

每个任务事件有持久递增 seq。状态变更与对应事件在一个事务提交后才推送。客户端先取快照及游标，再订阅后续事件；重连按游标补看并去重。手机断网、切后台和关闭页面均不取消执行。

最终代码补丁覆盖基线到当前工作区的修改，包括新增文件；不能只取遗漏未跟踪文件的 git diff。成果预览支持 Markdown、文本和 diff，大内容分页或下载，手机页面不出现横向溢出。

## 4 远程连接与部署

后台和手机客户端都必须配对。首次初始化由本机 CLI 生成一次性配对入口；已登录后台或本机 CLI 可继续为手机生成二维码。

配对票据使用 32 字节随机值，5 分钟有效、仅可使用一次，存储哈希。二维码为固定 HTTPS 地址的 /pair#票据，页面读取后清掉 fragment 并通过 POST 换取设备会话。设备 Cookie 使用 HttpOnly、Secure、SameSite=Strict；默认 30 天有效，可单独撤销。开发模式仅在明确的 localhost 入口允许非 Secure Cookie。

任务、SSE、文件、审批、配置与控制接口全部校验设备身份；变更接口检查同源和 CSRF，拒绝任意跨域访问。撤销设备立即终止其事件订阅并拒绝后续操作。密钥不进入 URL、普通日志或事件；管理页只显示认证状态与脱敏信息，首版使用引擎本机认证，不制作云端凭据保管服务。

Cloudflare Named Tunnel 将固定域名转发到本机 loopback 服务；cloudflared 作为独立基础设施进程部署，首版提供安装、配置、状态检查和重连指引。需要 Cloudflare 账号、由 Cloudflare 管理的域名和运行机器的出站连通性。[官方部署前提](https://developers.cloudflare.com/tunnel/get-started/)

Quick Tunnel 不作为默认入口，因为它不支持 SSE 且域名随启动变化。[官方限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

云 VM 也运行同一服务；已有 HTTPS 反向代理时可以转发到相同 loopback 端口。首版不开发云端任务中转控制面。任务记录、模型认证和成果由 Personal Agent 所在节点管理；隧道会转发请求和内容，不宣称中转方无法读取流量。

本机常驻先使用已有进程管理经验：macOS LaunchAgent、Linux systemd user、Windows 当前用户计划任务。服务自启动与“任务自动重放”分开，重启后仍需用户恢复 interrupted 任务。

## 5 实施顺序与验收

按每天 4 至 6 小时、10 月 2 日至 10 月 7 日安排约 24 至 36 小时，目标是 Mac 上完整可演示的原型。代码结构和 CI 覆盖 Windows 与 Linux，真实运行支持必须另外获得实机证据，不能以 CI 代替。

| 日期 | 实现工作 | 当日完成标准 |
| --- | --- | --- |
| 10 月 2 日 | 建工程与共享类型、SQLite、fake ACP；确认真实 Claude 认证与固定 HTTPS 入口前提 | 能创建并落库任务，fake Agent 产出事件与成果；真实引擎探针成功 |
| 10 月 3 日 | 接 Claude Adapter、worktree、双 Agent 分析、编码与验证流程 | 一个本地真实任务产出代码、真实测试记录和成果 |
| 10 月 4 日 | 手机任务工作台与后台管理、档案配置、成果预览 | 可以完整发任务、看每个 Agent 的阶段、读取并接收成果 |
| 10 月 5 日 | 接管、持久审批、服务重启协调、SSE 补发与幂等 | 手机掉线不取消任务，重启进入 interrupted，旧操作不能污染新 attempt |
| 10 月 6 日 | 配对、独立鉴权、Named Tunnel、移动网络验收、跨平台 CI | 手机关闭 Wi-Fi 后真实下任务、处理审批与接收成果 |
| 10 月 7 日 | 修复验收问题、全新安装演练、README、许可证与演示录屏 | 全新环境能按说明复现，形成可供开源发布的版本与明确限制 |

自动测试覆盖：状态转换和命令幂等、真实并行调度、审批等待与重复回执、快照到 SSE 连接间的事件竞争、断线补发、旧 attempt 事件、服务重启不重放工具、工作目录基线与新增文件补丁、进程树收尾、设备撤销和配对票据失效。

fake ACP 用于验证可控故障，不作为真实引擎验收证明。浏览器用桌面和 390 像素手机视口检查任务流、待处理事项与成果，测量 scrollWidth/clientWidth 确认没有页面横向溢出。

最终人工验收使用独立演示 Git 仓库：手机移动网络配对 → 下发开发需求 → 两个 Agent 并行分析 → 代码执行与测试 → 中途接管补充一条要求 → 继续 → 关闭手机 → 重连补看完整成果 → 接受。另测取消、审批时离线、服务重启后恢复和退回返工。

验收记录分别标注源码、自动测试、真实引擎、真实手机跨网与操作系统证据。没有完成的层不得宣称通过。Named Tunnel 的账号、域名与连通性是远程验收前提；缺少它们时可以推进本地实现，但远程目标仍记为未完成。

目前现有 nuwa-cli、swarm、浏览器工作区都有各自的在途工作。新项目从独立目录开始，移植固定来源模块，不修改这些在途路径。首次源码实现前建立新仓库的恢复点；不把其他项目 WIP、凭据或历史任务正文带入新仓库。

后续版本按顺序补 Codex Adapter、浏览器工具与明确的 GUI 接管，再考虑多节点管理和原生客户端。首版先完成上述验收后再扩大范围。
