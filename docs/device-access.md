# 设备配对与访问启用

本实现可在独立数据目录启用设备鉴权。当前本地演示保持 loopback 模式；本文中的启用、票据签发与代理步骤没有自动执行。配对后的浏览器均代表同一个实例所有者，拥有任务执行、审批、配置和设备管理权限；首版没有设备角色或多用户权限。

## 启用前确定

需要确定运行机器、源码目录、数据目录、一个固定 HTTPS origin（如 `https://agent.example.com`）和要配对的浏览器。运行机器可以是当前 Mac、另一台 Apple Silicon Mac（包括 M1 Mac mini）或符合要求的 VM；选择目标后在该机单独预检，不能沿用当前机器的通过结果。跨网访问还需要选择现有 HTTPS 反向代理或 Cloudflare Named Tunnel，并明确允许的账号、域名和网络操作。服务仍只监听 `127.0.0.1:47801`，同一台机器的另一个数据目录也不能与原实例同时占用该端口。

免费入口方案仍需验证固定 HTTPS 地址、转发到这台机器的方式、精确 Host 和 SSE。临时随机域名不能直接作为本方案的持久 origin。若选择 Sites，先核对它与本机服务的连接方式及这些条件，再确定是否用于该入口；本文不假定已有域名、代理或 Sites 连接。

新版在任何模式下初始化数据库时都会自动迁移；后续启动失败也不表示数据库未改变。首次验收优先使用新的、尚不存在的绝对数据目录。升级原数据时先正常停止原服务，等待执行进程收尾，再做完整数据目录的冷备份，包括数据库、任务文件、worktree 和归属记录。v4 是增量迁移；回退 v3 源码需要与其匹配的完整备份，应用不会自动降级数据库。启用配对后原免登录浏览器将被锁定，首次访问须由本机 CLI 签发一次性票据。

## 在另一台 Apple Silicon Mac 准备源码

非敏感前提：目标机允许本地操作，具备 Node.js 22.18 或更高、npm、Git、足够磁盘空间和官方 npm 注册表的正常 TLS 访问；确认独立的源码与数据绝对路径，以及 47801 未被占用。Claude 任务还需要该机已有的原生认证和可登记的本地 Git 仓库。无需在聊天中提供密码、SSH 私钥、模型凭据或 Tunnel token。

最小部署包只包含已提交源码。确定目标和传输方式后，可从本项目的已验收版本导出到获准的位置：

```sh
git archive --format=tar.gz \
  --output='<APPROVED_SOURCE_ARCHIVE>.tar.gz' phase4-access-prepared
```

将包传到目标机并解压到新的空源码目录，再在该目录执行下一节的依赖安装和构建。重新安装目标机依赖，不复制 `node_modules`；该包不包含 `.git`、运行数据或未提交修改，也不携带用户认证文件。未在本轮创建或传输此包。

目标机从新的数据目录开始，重新登记该机工作区。既有任务迁移涉及持久化的绝对 workspace、worktree 与进程 wrapper 路径，复制目录不等于完成迁移，需要另行核对。不要从原机复制模型凭据、已配对设备会话或账号配置。真实引擎在目标机先运行不发模型请求的 `npm run probe:claude`；真实模型请求是否获准、认证是否可用须分别确认，缺少认证时继续使用 fake。

## 待确认后执行的本机步骤

在获准的源码目录安装锁定依赖并构建；新 checkout 也需要安装依赖：

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run build
```

确认数据目录分支、备份和固定 origin 后，前台启动：

```sh
PERSONAL_AGENT_DATA_DIR='<APPROVED_DATA_DIR>' \
PERSONAL_AGENT_AUTH_MODE=paired \
PERSONAL_AGENT_PUBLIC_ORIGIN='https://<APPROVED_HOSTNAME>' \
npm run dev
```

需要安装 cloudflared 时使用 [Cloudflare 官方下载说明](https://developers.cloudflare.com/tunnel/downloads/) 选择目标机架构；安装、登录、创建 Tunnel、绑定 DNS、运行 connector 和常驻启动分别列入本次获准动作。本轮只检查现有路径与版本，不执行这些操作。先以前台进程验收，再决定是否安装常驻服务。

固定 origin 不接受路径、尾部斜杠、用户信息、query 或 fragment。配对策略持久化后，重启省略环境变量仍强制原策略；改变域名或降为 HTTP 会拒绝启动，需单独设计迁移。不要用环境变量移除鉴权。浏览器通过该 HTTPS origin 访问；本机 CLI 可检查策略并在明确同意设备访问后签发：

```sh
# 检查策略、不签票据；仍以读写方式打开现有 SQLite，不能作为纯只读预检
npm run pair -- --data-dir '<APPROVED_DATA_DIR>'
# 以下命令会产生实际访问票据，仅在批准该设备时执行
npm run pair -- --data-dir '<APPROVED_DATA_DIR>' --issue-ticket
```

签发命令仅在本机终端显示 `/pair#ticket=...`，不写凭据文件。票据使用 32 字节密码学随机值，5 分钟有效、一次兑换；SQLite 只存用途分离的 SHA-256 哈希。配对页立即清除 fragment，填写名称后通过 JSON POST 兑换。会话使用独立 32 字节随机值，固定 30 天有效，数据库只存会话与 CSRF 哈希。

HTTPS Cookie 为 `__Host-pa-device`，包含 `HttpOnly; Secure; SameSite=Strict; Path=/`，无 Domain。已有设备可在“设备与配对”生成后续链接或撤销设备；撤销立即关闭该设备的所有 SSE，并废止其未用票据，不取消任务。撤销最后一台设备后须再次使用本机 CLI。撤销自己的请求如丢响应，旧会话不能重放，刷新会进入配对页。

票据响应丢失时用同一 commandId 重试只取回 metadata，不再次显示秘密；客户端会提示创建新票据。鉴权命令使用独立 `auth_commands` 命名空间，任务命令保持原有幂等规则。

## 本机隔离开发模式

仅明确指定 `PERSONAL_AGENT_INSECURE_LOCALHOST=1` 且 origin 为精确 `http://localhost:<port>` 或 `http://127.0.0.1:<port>` 时使用 `pa-device-dev` 非 Secure Cookie。生产实例不得使用此模式。两种 Cookie 不互认，重复或混合身份 Cookie 被拒绝；开发模式不是 HTTPS 或手机跨网验收。

Vite 的 5173 入口仍适用于未启用鉴权的 loopback 开发。鉴权实例必须用服务托管的构建产物与精确同源入口验收，不额外放行 Vite Origin。

## API 与代理边界

`GET /api/session` 未登录仅返回 401，`POST /api/pair` 允许同源 JSON 兑换。公开内容只有应用壳、配对页和指定 dist 静态资产；任务、文件/成果、SSE、审批、控制、配置、设备、health 和未知 API 都要求身份。静态资源拒绝 dotfile、路径穿越和指向 dist 外的符号链接。

所有请求检查固定 Host、存在的 Origin 和 Fetch Metadata；变更请求必须有精确 Origin、JSON Content-Type 和当前设备的 `X-CSRF-Token`，配对兑换仅豁免 CSRF。没有 CORS 放行，SSE 使用同源 Cookie。敏感响应 `no-store`，应用壳拒绝 iframe 嵌入。凭据不会写入普通日志、任务事件或 URL query。

Fastify `trustProxy=false`；`Forwarded` 与 `X-Forwarded-*` 不参与 Host、Origin、身份或配对速率计算。HTTPS 代理必须保留配置的 Host，TLS、代理准入与访问路径属于基础设施边界。Named Tunnel 占位模板见 [cloudflared.yml.example](templates/cloudflared.yml.example)，未填写任何账号、隧道或凭据，未执行远程配置。模板的逐条 ingress 与 catch-all 依据 [Cloudflare 配置文件](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/)，`httpHostHeader` 用于固定传给本地服务的 Host，见 [Origin parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/#httphostheader)。

此模板仅适用于本地管理的 Named Tunnel，使用 tunnel UUID 和既有凭据文件路径。远程管理的 Tunnel 需在对应管理面配置 hostname 到 `http://127.0.0.1:47801` 的映射及相同 `httpHostHeader`；编辑本地 YAML 不代表远端配置生效。不要把 token、凭据文件内容或认证证书写入模板、仓库或聊天。

## 停机与回滚

1. 停止本实例的外网入口，避免恢复过程中继续接收远程请求。
2. 在本服务前台终端按 Ctrl+C，或向确认属于本实例的服务发送 SIGINT/SIGTERM；等待 Agent、验证进程与数据库收尾。清理失败或锁未正常释放时保留数据目录和锁，按 README 的归属核验处理，不删除锁或进程账本跳过检查。
3. 回到当前 v4 版本时保留与其匹配的完整数据。需要回到 v3 时，先另存当前完整 v4 数据，再恢复事前的 v3 冷备份及匹配源码。使用独立源码 checkout/目录保留原 WIP，避免覆盖或重置工作区。
4. 既有任务恢复须保留登记的绝对路径及对应源码位置；将备份放在另一处不代表应用能自动迁移这些路径。用旧版本恢复时先仅在 loopback 核对，再决定后续入口。v3 不提供本阶段的设备鉴权，不能接回原远程入口。

恢复旧备份会失去备份之后的新任务、事件和设备变化，因此保留当前目录供后续处理。撤销单台设备应使用设备管理；停止入口或省略启动环境变量不会撤销既有会话，也不会移除持久配对策略。

## 后续实际验收

一次确认可使用以下清单，填写非敏感信息即可；仅选定机器或代理不等于允许所有配置动作：

| 待确认项 | 需要的决定 |
| --- | --- |
| 运行机器与源码 | 当前 Mac / M1 Mac mini / VM，以及目标源码绝对路径 |
| 数据 | 新目录，或原目录升级；数据与冷备份的绝对路径 |
| 入口 | 固定完整 HTTPS origin、免费方案及是否使用 Sites |
| 设备 | 首批要配对的手机和桌面浏览器名称 |
| 代理 | 现有反向代理 / Named Tunnel；本地或远程管理方式 |
| 动作范围 | 是否允许安装依赖/connector、账号登录、创建 Tunnel、绑定 DNS、修改既有代理/Tunnel 映射、前台运行、签发票据与实际配对；常驻服务单独决定 |

确认后按“安装构建 → 必要备份 → paired 本地服务 → 获准代理与 HTTPS 检查 → 本机 CLI 首次签发 → 指定设备配对”执行。真实验收需验证证书与代理 Host、关闭手机 Wi-Fi 的移动网络配对、下发任务、审批、掉线重连、接管、接收和设备撤销。隔离鉴权测试、当前机器预检或仅有构建成功都不能代替目标机与手机跨网证据。

Cookie 和同源处理依据 [MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)、[OWASP CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)；代理行为见 [Fastify trustProxy](https://fastify.dev/docs/latest/Reference/Server/#trustproxy)。
