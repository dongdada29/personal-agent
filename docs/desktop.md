# 桌面客户端与 Linux 云电脑

Personal Agent 的 Electron 客户端（`apps/desktop`）和 Linux 云电脑（box）配套使用：本机或云端跑一个加固的 Linux 桌面容器，工作台经鉴权代理打开桌面，渲染进程永远看不到服务端口或启动令牌。

公开 demo 仍然是结构上的 fake-only：不构造 BoxService、不执行命令、不能打开桌面。

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
| 托管（默认） | 主进程用 Electron 自带 Node（`ELECTRON_RUN_AS_NODE=1`）fork 打包后的 server；令牌只经 IPC 下发，不进 argv / env / 日志。server 只绑定 `127.0.0.1` 的随机端口，监听后再断言地址。渲染进程只加载 `app://personal-agent/`，`/api`（含 SSE）由主进程同源代理并注入 `Authorization: Bearer <token>`。 |
| 连接 | 不启动新 server，探测本机已有的 loopback 实例（默认 `http://127.0.0.1:47801`）。只接受 loopback 访问模式；paired 实例请用浏览器打开其 HTTPS 地址。属于另一个桌面客户端的实例（需要它的启动令牌）会被拒绝。 |

退出时先向 server 发 `shutdown`，等它关掉任务进程、数据库和实例锁后再结束。超时则强制结束 owner，下次启动由进程账本核实身份后清理。

自定义协议 `app://` 无法承载 WebSocket：打开桌面时由主进程代连 `ws://127.0.0.1:<port>/api/box/.../vnc`（带令牌），经 MessagePort 把二进制帧交给 noVNC。主机守护进程接口 `/api/box/agent/*` 不能经渲染进程访问。

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

- 每次打开生成 32 字节 base64url 令牌，经 `docker exec -i pa-box /usr/local/sbin/pa-box-ctl start dN` 的 **stdin** 下发（同 PID 命名空间里的其它 bot 看不到 argv）。
- 网关只接受 120 秒内写入的令牌；同一桌面的打开串行执行。
- Xvnc：`-rfbport -1 -localhost -rfbunixpath -rfbunixmode 0660 -SecurityTypes None`，外加 X11 MIT cookie。容器里没有 websockify。
- Chromium **从不**加 `--no-sandbox`。seccomp 基于 moby 默认 profile，额外放行 `clone` / `setns` / `unshare`；同时 `no-new-privileges`。
- 创建后的安全校验失败（特权、额外 cap、非回环端口、缺少 seccomp 等）会 `docker rm -f` 并报 `BOX_CONTAINER_UNSAFE`。

镜像与 rootfs 在 `deploy/box/`。seccomp 生成器：`node scripts/box/gen-seccomp.mjs`。

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

安装脚本安装 docker 或 rootless podman、box 镜像、seccomp、Node 22、systemd 单元 `pa-box-hostd`；守护进程只监听本机、用票据注册后改用 machine 凭据心跳。`--server` 必须是 **https**。本机 loopback 或 `app://` 桌面客户端无法让云主机回连，请改用 SSH，或先配置 paired 的 HTTPS 入口。

Cloudflare 可能不转发非 WebSocket 的 `pa-box-tunnel` 升级，生产更稳妥的是 Tailscale 或 SSH。

## 已知限制

- L0 那台 Mac 上 Lima 的 hostResolver 会在 VM 运行时监听 `*:53`（Colima 行为，不是本仓库改的）。
- 容器内 bot 共享 PID 命名空间，能看见彼此的进程列表；桌面端口不因此暴露，因为 VNC 只走 unix socket + 网关令牌。
- TigerVNC `-rfbport -1` 未在真实 Mac 上用实物显示器复核。
- 云主机上 docker 组等同 root。
- Windows 剩余缺口见 [windows-gaps.md](windows-gaps.md)。
