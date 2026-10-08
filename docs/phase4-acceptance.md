# 第四阶段：设备配对与访问鉴权代码验收

日期：2026-10-02。macOS arm64，Node 24.18.0 与 22.18.0。范围为源码、临时数据库/虚拟设备和隔离浏览器验收；没有为真实设备创建访问，没有签发或保存生产配对凭据，没有启用代理、Cloudflare、常驻服务或公网入口。原 `127.0.0.1:47801` 演示数据保持原状。源码本地恢复标签为 `phase4-auth-validated`，不表示跨网验收通过。

## 交付文件

| 部分 | 文件 | 行为 |
| --- | --- | --- |
| 契约/迁移 | `packages/contracts/src/index.ts`、`packages/runtime/src/migrations.ts` | Device/AuthSession/PairingTicket/策略；v4 增量表，原任务数据保留 |
| 身份持久层 | `packages/runtime/src/auth-store.ts` | 32 字节随机票据/会话，用途分离 SHA-256，5 分钟一次性兑换、30 天会话、原子事务、撤销及 COMMIT 后通知 |
| 服务边界 | `apps/server/src/access-control.ts`、`app.ts`、`main.ts` | 显式 paired 策略防降级；全 API/文件鉴权，严格同源与 CSRF，Host/代理头约束和安全响应头 |
| 事件流 | `apps/server/src/sse.ts` | 请求/发送前检查；撤销立即关闭、到期分段定时、背压与重放复核，不取消任务 |
| 手机/桌面 | `apps/web/src/AuthGate.tsx`、`DevicePanel.tsx`、`auth-session.ts`、`api.ts` | 同步清 fragment、显式配对、内存 CSRF、失效卸载工作台、设备管理、过期票据移除、会话代际隔离 |
| 本机操作 | `scripts/pair.ts`、`docs/device-access.md`、`docs/templates/cloudflared.yml.example` | 默认只检查策略；明确 `--issue-ticket` 才签发；占位部署模板未执行 |
| 回归 | 新增 AuthStore、HTTP、SSE-auth、Web auth/API 五个测试文件 | 新增 106 项，全量共 530 项、29 文件 |

未新增依赖，ACP SDK 1.3.0、Claude ACP 0.65.0 与原许可来源保持不变。

## 边界与故障证据

- 票据与会话分别使用 `randomBytes(32)`；数据库、auth_commands、任务事件中无明文票据/会话/CSRF。ticket 与 session/CSRF 用途分离，CSRF 不能作为 Cookie 身份使用。精确到期边界拒绝，事务失败不消费票据或留半个设备。两个真实子进程/独立 SQLite 连接同时兑换，仅一方成功。
- HTTPS 使用 `__Host-pa-device; HttpOnly; Secure; SameSite=Strict; Path=/`，无 Domain；明确 localhost HTTP 开发模式才使用独立 `pa-device-dev`，重复、混合、编码或错误模式 Cookie 拒绝。HTTPS 属性在注入测试验证，本轮浏览器使用隔离 HTTP 开发模式，不等同 TLS 实网验收。
- 未登录 GET/HEAD 请求 health、任务、审批、配置、工作区、设备、成果/文件、SSE 和未知 API 返回 401，无任务内容或路径。变更请求无身份/CSRF不执行；同源要求包括 Origin missing/null/列表/兄弟域与 Fetch Metadata；JSON 以外配对拒绝。
- `trustProxy=false`，伪造 Forwarded/X-Forwarded-* 不改变 Host、Origin、身份或限流。有效身份也拒绝票据/会话等凭据 query。静态真实路径须位于 dist 内，dotfile、外部 symlink 和穿越拒绝；应用壳 CSP/frame-ancestors/X-Frame-Options 拒绝嵌套，所有 paired 响应 no-store，包括静态文件和错误。独立只读审查发现的 query 与静态缓存覆盖均已修复并回归。
- 设备撤销使所有对应 SSE 关闭，另一设备不受影响；慢连接、drain、同步订阅竞态、失效检查异常与 30 天长计时均覆盖。断开不取消任务，重连必须重新校验身份。排队请求在首次副作用前复查设备，撤销后不能向任务写入新要求或送出旧审批。
- 配对策略在进程恢复和调度前读取/核验，已配对数据库重启省环境变量仍受保护，改变 origin 或 HTTP 降级拒绝。CLI 默认检查对临时实例实测 exit 0，票据数量不变，输出无秘密。
- Web 新增 41 项鉴权测试覆盖 fragment 先清、同文档 hash/popstate 新票据、当前代 401 清内存、旧代响应丢弃、当前 CSRF、redirect:error、失效/到期与无存储；Web 全量 81 项。浏览器发现同标签页更新配对 fragment 保留旧票据的问题后，补监听、立即清除、同一导航事件去重并重挂配对表单，重新回归及实际配对通过。

## 最终命令

| 命令 | Node 24.18.0 | Node 22.18.0 |
| --- | --- | --- |
| `PERSONAL_AGENT_SSE_REAL_SOCKETS=1 npm test -- --maxWorkers=1 --minWorkers=1` | **530/530，29 文件，无跳过** | **530/530，29 文件，无跳过** |
| `npm run typecheck` | 通过 | 通过 |
| `npm run smoke` | completed、13 events、1 artifact | 同样通过 |
| `npm run build` | 通过 | 通过 |
| `git diff --check` | 通过 | 同一源码 |

全量日志在忽略目录 `.data/phase4-acceptance/evidence/node24-tests.log` 与 `node22-tests.log`。真实 socket 使用临时 loopback；原真实崩溃恢复 6 项也全部运行。本机工具审批只扩大到测试新建 fixture 的 loopback、PID/PGID/命令行核验及 Nuwa IPC，不读取进程环境、不操作其它进程或系统设置。默认沙箱 SSE 用同一场景的 inject 驱动，最终结果使用显式真实 socket 驱动，未混称。

Node 22 SQLite experimental 与 Vite 770 KB chunk 提示仍存在。当前阶段未调用真实模型；真实引擎闭环证据仍见第二/第三阶段，不视为本轮重做。

## 浏览器与清理

Nuwa 独立 Space 在 `127.0.0.1:47811` 的临时实例上验收，使用 HTTP 开发 Cookie；不访问真实模型或外网。通过以下实际浏览器行为：

- 未登录 tasks/health 401，工作台不挂载；错误和过期票据 POST 400，不显示任务。
- 同文档新配对链接立即清 fragment、正确预填 43 字符票据，显式提交 POST 200/session 200；HttpOnly、SameSiteStrict 正确，开发 Secure=false，JS 不可见 Cookie，local/sessionStorage 为空。
- 任务事件原生 SSE 关闭后降级轮询，再从 `after=1` 重连；任务始终 queued，没有发 control POST。
- 390px/1600px 的 scrollWidth 等于视口，任务、设备和链接显示无横向溢出。票据按钮同 tick 双击只有一个 POST；链接格式正确、切换页签移除，未复制到操作系统剪贴板，截图与证据不保存有效票据。
- 强制虚拟设备到期后 session/tasks 401，任务界面与 feed 清除；新测试设备配对成功，已消费票据重放 400，仅显示安全配对页。
- 当前设备撤销弹窗明确说明锁定；确认后 DELETE 200、tasks 401，任务/设备/成果/弹窗与订阅均清除，票据框及浏览器存储为空。

已验证清除仅测试 Cookie 和该 origin 的 storage，关闭自有浏览器空间（done:true），停止临时服务；其数据库、票据元数据文件均已销毁，同前缀测试目录剩余 0，47811 端口连接拒绝，无残留可用访问。只保存脱敏 `ui-evidence.json`、`cleanup.json` 与 5 张不含票据的截图，位于忽略目录 `.data/phase4-acceptance/evidence`。撤销弹窗通过 DOM 结果验证，未将上一绘制帧误记为弹窗截图。

原演示本轮只读检查：`127.0.0.1:47801` 返回 ECONNREFUSED，没有自动重启；其数据库 `schema_migrations` 仍为 v3，没有 security_policy 表。未对原目录进行迁移或签发设备访问。

## 后续启用与尚未验收

具体待确认项及步骤见 [设备访问说明](device-access.md)：运行机器、数据目录、固定 HTTPS origin、代理/Tunnel 方式和目标设备。批准后先停止/备份原服务，再显式启用 paired、从私有本机终端签发一次性票据，最后完成真实手机移动网络全流程。v4 数据库不能直接交给旧 v3 程序，代码回退须配套原数据库备份。

真实 HTTPS/Tunnel、手机跨网、Cloudflare 账号/域名配置尚未执行或验收；Linux 尚未实机验证，Windows 进程管理仍不支持。本地代码和隔离测试通过不能代替这些证据。本轮未推送、建 PR 或部署。
