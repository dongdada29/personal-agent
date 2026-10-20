# 桌面客户端与 Linux 云电脑

Personal Agent 的 Electron 客户端（`apps/desktop`）和 Linux 云电脑（box）配套使用：本机或云端跑一个加固的 Linux 桌面容器，工作台经鉴权代理打开桌面，渲染进程永远看不到服务端口或启动令牌。

公开 demo 仍然是结构上的 fake-only：不构造 BoxService、不执行命令、不能打开桌面。CLI / `npm run dev` 默认也不启用 box；桌面客户端托管模式默认启用（可用 `PERSONAL_AGENT_BOX=0` 关掉）。

## 在 Mac 上运行

准备 Node.js **22.18 或更高**、npm、Git。Colima 使用独立 profile `pa-box`，**不会**改默认 docker 上下文（L0 那台 Mac 的默认上下文是 OrbStack，必须保持）。脚本一律用非登录 bash，避免加载用户的 zsh/bash profile。

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org --strict-ssl=true
npm run build
npm run desktop:build
```

开发（托管模式，启动内置服务）：

```sh
npm run desktop:dev
```

或先启动本机服务，再用连接模式打开已有实例：

```sh
npm run dev
# 另一个终端
npm run desktop:dev
# 菜单「模式 → 连接已有实例（http://127.0.0.1:47801）」
```

### Colima box（本机 Linux 桌面）

需要 [Colima](https://github.com/abiosoft/colima)（vz）和 docker CLI。推荐 `brew install docker colima`，不要用 OrbStack 自带的 docker 去操作 `pa-box` 上下文。

```sh
bash --noprofile --norc scripts/box/colima-pa-box.sh start
bash --noprofile --norc scripts/box/colima-pa-box.sh build
bash --noprofile --norc scripts/box/colima-pa-box.sh verify
```

`start` 等价于：

```sh
colima start pa-box --vm-type vz --runtime docker --cpus 2 --memory 4 --disk 40 \
  --arch aarch64 --activate=false --mount none
```

已存在的 profile 只追加 `--activate=false --mount none`。docker 命令一律带 `--context colima-pa-box`。停止：

```sh
bash --noprofile --norc scripts/box/colima-pa-box.sh stop
# 即 colima stop pa-box
```

未安装 / 未运行时，工作台「Linux 云电脑」页会显示对应状态和安装提示，不会对默认 Colima profile 或默认 docker 上下文做任何操作。

### 打开桌面客户端（已打包）

```sh
npm run desktop:dist
# macOS: apps/desktop/release/*.dmg（未签名，首次打开需在系统设置中放行）
```

## 托管模式与连接模式

| 模式 | 行为 |
| --- | --- |
| 托管（默认） | 主进程用 Electron 自带 Node（`ELECTRON_RUN_AS_NODE=1`）fork 打包后的 server；令牌只经 IPC 下发，不进 argv / env / 日志。server 只绑定 `127.0.0.1` 的随机端口，监听后再断言地址。数据目录默认 Electron `userData`（不是 `~/.personal-agent`）。渲染进程只加载 `app://personal-agent/`，`/api`（含 SSE）由主进程同源代理并注入 `Authorization: Bearer <token>`。 |
| 连接 | 不启动新 server，探测本机已有的 loopback 实例（默认 `http://127.0.0.1:47801`）。只接受 loopback 访问模式；paired 实例请用浏览器打开其 HTTPS 地址。属于另一个桌面客户端的实例（需要它的启动令牌）会被拒绝。 |

退出时先向 server 发 `shutdown`，等它关掉任务进程、数据库和实例锁后再结束。超时则强制结束 owner，下次启动由进程账本核实身份后清理。

自定义协议 `app://` 无法承载 WebSocket：打开桌面时由主进程先申请一张一次性桌面票，再代连 `ws://127.0.0.1:<port>/api/box/.../vnc`（带启动令牌与 `pa-dt.<ticket>` 子协议），经 MessagePort 把二进制帧交给 noVNC。主机守护进程接口 `/api/box/agent/*` 不能经渲染进程访问。

## 四层鉴权

对齐 OpenClaw Gateway 的思路：服务默认只监听本机；外网入口走 Tunnel / paired HTTPS；VNC 口令由服务端生成并在服务端完成 RFB 认证，浏览器只拿到已经认证过的、不需要口令的画面流。

| 层 | 作用 | 现状 |
| --- | --- | --- |
| 1. 连接令牌 | 证明请求来自「这次启动的桌面客户端」或本机回环 | 托管模式：主进程每次启动用 `randomBytes(32)` 生成 43 字符令牌，只经 IPC 交给 `app://` 代理，注入 `Authorization: Bearer`。除 `/api/box/agent/*` 外所有请求和浏览器侧 WebSocket 升级都要校验。令牌从不进 argv / env / 日志 / 响应。连接模式没有启动令牌，走本机回环规则。CLI / `npm run dev` 也没有启动令牌，只接受 `127.0.0.1` / `localhost`。 |
| 2. 设备配对 | 每台客户端有稳定的 Ed25519 身份，第一次出现必须批准 | 设备 ID = SHA-256(32 字节公钥)。挑战 60 秒一次性。`kind=desktop` 且带启动令牌的托管桌面自动批准为 operator（它就是这台实例的所有者）。本机回环浏览器（`kind=browser`、无启动令牌）自动批准，否则没有已信任设备能点批准。连接模式的第二台桌面、经 Tunnel / 局域网出现的设备进入 pending。已批准列表存在 SQLite `client_devices`（schema v5）。工作台「设备管理」可批准（操作员 / 只读）、拒绝、撤销。未出示设备头的本机请求仍视为隐式 operator，保证 `npm run dev` 与既有测试。 |
| 3. 权限校验 | 只读 vs 操作，服务端按路由强制 | `observer` 只能 GET / 申请观看用桌面票；写操作、启停容器、批准设备返回 `PERMISSION_DENIED`。`/vnc` 打开停着的桌面也不会顺便启动（`allowStart=false`）。只读桌面的键鼠和剪贴板在服务端 `RfbViewOnlyFilter` 丢弃，不依赖前端 `viewOnly`。配对时指定 `operator` 或 `observer`。 |
| 4. 一次性桌面票 + VNC 口令 | 打开桌面必须先用已认证连接申请票；VNC 口令不离开服务端 | `POST /api/box/deployments/:id/desktops/dN/tickets` 签发 60 秒、一次性、绑定设备的票。WebSocket 用 `X-PA-Desktop-Ticket` 或子协议 `pa-dt.<ticket>` 出示。过期、已用、设备不匹配一律 `DESKTOP_TICKET_REQUIRED`。这取代了原先可复用 120 秒的网关令牌。网关令牌同样改为 60 秒且用一次即删。每个桌面的 VNC 口令由服务端随机 8 字符，只经 stdin 第二行交给 `vncpasswd -f`，存在内存和 `0600` 的 `box-vnc-secrets.json`，不进 URL / 前端 / API 响应 / 普通日志。服务端对 Xvnc 做 RFB 3.8 VncAuth，再向 noVNC 呈现 SecurityTypes None。容器内 Xvnc：`-SecurityTypes VncAuth -rfbauth`，只监听 unix socket（`-rfbport -1 -localhost`）。 |

### 时序（打开桌面）

```
浏览器 / 桌面渲染进程
        |  Ed25519 挑战 + 签名  (或隐式本机回环)
        v
   POST /api/device/connect  -->  pending? 等操作员批准
        |  已批准：下发设备会话
        v
   POST .../desktops/dN/tickets   （需要连接令牌 + 已批准设备）
        |  60s 一次性票
        v
   WS .../vnc  +  pa-dt.<ticket>  （Electron：主进程代连，带 Bearer）
        |
        v
   server 校验令牌 / Origin / 票 / 设备
        |  票用过即废
        v
   docker exec -i pa-box-ctl start dN
        |  stdin: <gateToken>\n<vncPassword>\n
        v
   pa-box-gate :6080  (60s 一次性网关令牌)
        v
   server 作为 VNC 客户端完成 VncAuth
        v
   向浏览器呈现 SecurityTypes None
        v
   noVNC 只收画面；observer 的 KeyEvent / PointerEvent 在服务端丢弃
```

### 新增 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/device/challenge` | 60 秒一次性签名挑战 |
| POST | `/api/device/connect` | 出示公钥与签名；自动批准或进入 pending |
| GET | `/api/device/status?deviceId=` | 查询 pending / approved / rejected |
| GET | `/api/devices` | 增加 `clientDevices`（Cookie 配对设备仍在 `devices`） |
| POST | `/api/client-devices/:id/approve` | `{ commandId, role: "operator" \| "observer" }` |
| POST | `/api/client-devices/:id/reject` | `{ commandId }` |
| DELETE | `/api/client-devices/:id` | 撤销 `{ commandId }` |
| POST | `/api/box/deployments/:id/desktops/dN/tickets` | 一次性桌面票（observer 也可申请，`control: false`） |

设备身份头：`X-PA-Device-Id`、`X-PA-Device-Session`。桌面票头：`X-PA-Desktop-Ticket` 或子协议 `pa-dt.<ticket>`。

没有新的生产环境变量。`PERSONAL_AGENT_BOX`、demo、`127.0.0.1` 绑定语义不变。数据库自动迁到 schema v5（`client_devices` / `client_device_sessions`）。独立端口实弹检查：`PERSONAL_AGENT_VERIFY_PORT=47991 npm run verify:auth`（假 box，不碰 Docker / 47801 / 47811）。Linux 上对真实镜像做 VncAuth：`docker build -t personal-agent/pa-box:0.1 deploy/box && npm run verify:box-vnc`（容器名带 pid，不碰 `pa-box-desktop`）。镜像必须装 `tigervnc-tools`（提供 `/usr/bin/vncpasswd`）。服务端口令文件丢失时，操作员再次打开会轮换口令并重启该桌面。

## L0 配额与准入（M1 16GB 实测）

| 项 | 值 |
| --- | --- |
| VM | 2 vCPU / 4 GiB / 40 GiB 磁盘 |
| 容器 | `--memory 3.5g --memory-swap 3.5g --cpus 2 --shm-size 1g` |
| 桌面并发 | 默认 2，硬上限 3（环境变量 `PA_BOX_CONCURRENT_DESKTOPS`） |
| 每桌面预算 | 0.7 GiB |
| 空闲停止 | 无人查看 15 分钟（`PA_BOX_DESKTOP_IDLE_MINUTES`） |
| 内存压力 | macOS `kern.memorystatus_vm_pressure_level`；Linux/WSL/SSH 读 PSI `some avg10`。warn/critical 时拒绝启动**尚未运行**的桌面。 |

端口只发布 `127.0.0.1:47830→6080`。Colima 会把容器里 `0.0.0.0` 的端口转到宿主所有网卡，所以适配器必须显式 `127.0.0.1`，并在创建后用 `lsof` 复核；非回环监听会停掉容器并报 `BOX_PORT_EXPOSED`。

## 桌面串流路径

浏览器或桌面客户端 → server（终结 WebSocket，子协议 `binary`）→ 宿主 `127.0.0.1:47830`（或 `ssh -W` / 主机守护进程反连隧道）→ 容器内 `pa-box-gate`（`:6080`）→ 每桌面 unix socket `/run/pa-box/dN/vnc.sock`。

- 每次打开生成 32 字节 base64url **网关令牌** 和每桌面一份 **VNC 口令**，经 `docker exec -i <容器名> /usr/local/sbin/pa-box-ctl start dN` 的 **stdin 两行**下发（同 PID 命名空间里的其它 bot 看不到 argv）。本地容器名默认 `pa-box-desktop`（`PA_BOX_CONTAINER` 可改），避免与本机已有的 `pa-box` 容器冲突。
- 打开桌面前必须先申请一张 **60 秒、一次性、绑定设备** 的桌面票；没有票或票已用过 / 过期 / 不匹配会被拒绝。
- 网关只接受 **60 秒内写入、尚未用过的令牌**（握手成功后删除文件）。再次打开桌面会轮换新令牌。同一桌面的打开串行执行。
- Xvnc：`-rfbport -1 -localhost -rfbunixpath -rfbunixmode 0660 -SecurityTypes VncAuth -rfbauth`，外加 X11 MIT cookie。VNC 口令由服务端生成，服务端完成 RFB 认证后再向浏览器呈现 None。容器里没有 websockify。
- Chromium **从不**加 `--no-sandbox`。seccomp 基于 moby 默认 profile，额外放行 `clone` / `setns` / `unshare`；同时 `no-new-privileges`。
- 创建后的安全校验失败（特权、额外 cap、非回环端口、缺少 seccomp 等）会 `docker rm -f` 并报 `BOX_CONTAINER_UNSAFE`。

镜像与 rootfs 在 `deploy/box/`。seccomp 生成器：`node scripts/box/gen-seccomp.mjs`。

## 启用 box（默认关闭）

CLI / `npm run dev` **默认不创建 BoxService、不挂载 `/api/box/*`**（包括主机守护进程的 `register` / `heartbeat` / `poll` 与隧道）。需要本机或云端云电脑时：

```sh
PERSONAL_AGENT_BOX=1 npm run dev
```

桌面客户端托管模式默认开启 box（可用 `PERSONAL_AGENT_BOX=0` 关闭）。显式传入 `box: { ... }` 的测试同样开启。

### `/api/box/agent/*` 经隧道的公网暴露风险

这些路径**不用**浏览器 Cookie、CSRF 或桌面启动令牌，只靠一次性注册票据和 machine 凭据。若把 paired 实例经 Cloudflare Tunnel / Tailscale funnel / 其它反向代理公开，同时又开了 box，则公网可以打到：

- `POST /api/box/agent/register`
- `POST /api/box/agent/heartbeat`
- `POST /api/box/agent/poll`
- `Upgrade: pa-box-tunnel`（`/api/box/agent/tunnel/:streamId`）

票据或凭据一旦泄露，攻击者可以注册进该部署、领取启停命令、把网关隧道接到自己这边。默认关闭 box 时这些路由根本不存在。开启 box 的 paired 入口请只放在受信网络（例如私有 Tailscale），不要暴露到未加额外访问控制的公网。

### 数据目录与容器名

- 桌面托管模式的数据目录默认是 Electron `userData`（macOS `~/Library/Application Support/Personal Agent`，Windows `%APPDATA%/Personal Agent`），**不再**使用 `~/.personal-agent`，以免与正在运行的 `npm run dev` 抢 `INSTANCE_LOCKED`。可用设置里的 `dataDir` 或 `PERSONAL_AGENT_DATA_DIR` 覆盖。
- 本地 Docker 容器名默认 `pa-box-desktop`（环境变量 `PA_BOX_CONTAINER` / hostd.json 的 `container`）。Colima profile 与 docker context 仍叫 `pa-box` / `colima-pa-box`。

## 云端主机

工作台「Linux 云电脑」把本机与云端并排列出。添加云端主机时：

- **SSH**：填写本机 `~/.ssh/config` 的 Host 别名（或 `user@host`），可选凭据引用如 `ssh-config:pa-cloud`。不要把密钥或密码填进表单或仓库。
- **主机守护进程**：签发一次性票据（10 分钟、只显示一次）。在 Debian/Ubuntu（arm64/x86_64）云主机上，先把仓库拷过去，再：

```sh
printf '%s' '<ticket>' | sudo tee /root/pa-box.ticket >/dev/null
sudo bash --noprofile --norc scripts/box/install-cloud-host.sh \
  --server https://<PAIRED_HOST> --ticket-file /root/pa-box.ticket
sudo rm -f /root/pa-box.ticket
```

安装脚本安装 docker 或 rootless podman、box 镜像、seccomp、Node 22、systemd 单元 `pa-box-hostd`；守护进程只监听本机、用票据注册后改用 machine 凭据心跳。`--server` 必须是 **https**。本机 loopback 或 `app://` 桌面客户端无法让云主机回连，请改用 SSH，或先配置 paired 的 HTTPS 入口。hostd.json 可用 `"container"` 覆盖容器名（默认 `pa-box-desktop`）。

Cloudflare 可能不转发非 WebSocket 的 `pa-box-tunnel` 升级，生产更稳妥的是 Tailscale 或 SSH。

## 已知限制

- L0 那台 Mac 上 Lima 的 hostResolver 会在 VM 运行时监听 `*:53`（Colima 行为，不是本仓库改的）。
- 容器内 bot 共享 PID 命名空间，能看见彼此的进程列表；桌面端口不因此暴露，因为 VNC 只走 unix socket + 网关令牌。
- TigerVNC `-rfbport -1` 未在真实 Mac 上用实物显示器复核。
- 云主机上 docker 组等同 root。
- Windows 剩余缺口见 [windows-gaps.md](windows-gaps.md)。
