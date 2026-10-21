#!/usr/bin/env -S bash --noprofile --norc
# 在一台 Debian / Ubuntu（arm64 或 x86_64）云主机上安装 personal-agent 的 box：
#   - 容器运行时：docker（默认，Debian 的 docker.io）或 rootless podman；
#   - box 镜像 personal-agent/pa-box:0.1（deploy/box/Dockerfile）与 seccomp 配置 /etc/pa-box/seccomp.json；
#   - 主机守护进程 pa-box-hostd（systemd 单元，用户 pa-box），用一次性票据注册后主动外连 server；
#   - 不开放任何入站端口：box 网关只发布到 127.0.0.1:47830，守护进程不监听端口。
#
# 用法（root，在仓库检出目录里运行）：
#   sudo bash --noprofile --norc scripts/box/install-cloud-host.sh \
#     --server https://agent.example.com --ticket-file /root/pa-box.ticket [--engine docker|podman] [--node /usr/bin/node] [--dry-run]
#
# 票据在 personal-agent 的「Linux 云电脑」页点击“签发注册票据”获得，10 分钟内有效、只能用一次。
# 请把票据写进文件（权限 0600）再传入，不要放在命令行参数里（会进入 shell 历史与进程列表）。
# 注册成功后票据文件会被删除；machine 凭据保存在 /var/lib/pa-box/credential（0600，属主 pa-box）。
#
# 提示：docker 组成员等同 root。需要更强隔离时使用 --engine podman（rootless）。
set -euo pipefail
unset BASH_ENV ENV
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 022

NODE_VERSION=22.20.0
SERVER=""
TICKET_FILE=""
ENGINE=docker
NODE_BIN=""
DRY_RUN=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFIX=/opt/pa-box
STATE=/var/lib/pa-box
CONFIG_DIR=/etc/pa-box
SERVICE_USER=pa-box

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 64; }

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --ticket-file) TICKET_FILE="${2:-}"; shift 2 ;;
    --engine) ENGINE="${2:-}"; shift 2 ;;
    --node) NODE_BIN="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数：$1" >&2; usage ;;
  esac
done

run() { if [ "$DRY_RUN" = 1 ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }
as_user() { run runuser -u "$SERVICE_USER" -- env -i HOME="$STATE" PATH="$PATH" XDG_RUNTIME_DIR="/run/user/$(id -u "$SERVICE_USER" 2>/dev/null || echo 0)" "$@"; }

[[ "$SERVER" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]] || { echo "--server 必须是 https:// 地址（只含主机名与端口）" >&2; exit 64; }
[ -n "$TICKET_FILE" ] && [ -r "$TICKET_FILE" ] || { echo "--ticket-file 不可读" >&2; exit 64; }
[[ "$ENGINE" =~ ^(docker|podman)$ ]] || { echo "--engine 只能是 docker 或 podman" >&2; exit 64; }
if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then echo "需要 root 运行" >&2; exit 77; fi

. /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in *" debian "*|*" ubuntu "*) ;; *) echo "只支持 Debian / Ubuntu（当前：${ID:-unknown}）" >&2; exit 69 ;; esac
case "$(uname -m)" in
  aarch64|arm64) NODE_ARCH=arm64 ;;
  x86_64|amd64) NODE_ARCH=x64 ;;
  *) echo "只支持 arm64 / x86_64" >&2; exit 69 ;;
esac

echo "== 1/7 安装容器运行时（${ENGINE}）"
run apt-get update
if [ "$ENGINE" = docker ]; then
  run apt-get install -y --no-install-recommends docker.io ca-certificates curl xz-utils
  run systemctl enable --now docker
else
  run apt-get install -y --no-install-recommends podman uidmap slirp4netns fuse-overlayfs dbus-user-session ca-certificates curl xz-utils
fi

echo "== 2/7 创建服务用户 ${SERVICE_USER}"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  run useradd --system --create-home --home-dir "$STATE" --shell /bin/bash "$SERVICE_USER"
fi
run install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE"
if [ "$ENGINE" = docker ]; then
  run usermod -aG docker "$SERVICE_USER"
else
  grep -q "^${SERVICE_USER}:" /etc/subuid 2>/dev/null || run usermod --add-subuids 200000-265535 --add-subgids 200000-265535 "$SERVICE_USER"
  run loginctl enable-linger "$SERVICE_USER"
fi

echo "== 3/7 安装 Node.js ${NODE_VERSION}（只供 pa-box-hostd 使用）"
if [ -z "$NODE_BIN" ]; then
  tarball="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  work="$(mktemp -d)"
  run curl -fsSLo "$work/$tarball" "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
  run curl -fsSLo "$work/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  if [ "$DRY_RUN" = 0 ]; then (cd "$work" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -); fi
  run install -d -m 0755 "$PREFIX/node"
  run tar -xJf "$work/$tarball" -C "$PREFIX/node" --strip-components=1
  run rm -rf "$work"
  NODE_BIN="$PREFIX/node/bin/node"
fi

echo "== 4/7 安装 seccomp 配置、守护进程与配置文件"
run install -d -m 0755 "$CONFIG_DIR" "$PREFIX"
run install -m 0644 "$ROOT/deploy/box/pa-box-seccomp.json" "$CONFIG_DIR/seccomp.json"
run install -m 0755 "$ROOT/scripts/box/pa-box-hostd.mjs" "$PREFIX/pa-box-hostd.mjs"
run rm -rf "$PREFIX/box-image"
run cp -R "$ROOT/deploy/box" "$PREFIX/box-image"
config_json="{\"server\":\"${SERVER%/}\",\"engine\":\"${ENGINE}\",\"credentialFile\":\"${STATE}/credential\",\"seccompProfile\":\"${CONFIG_DIR}/seccomp.json\"}"
if [ "$DRY_RUN" = 1 ]; then echo "+ write ${CONFIG_DIR}/hostd.json: ${config_json}"; else printf '%s\n' "$config_json" >"$CONFIG_DIR/hostd.json"; chmod 0644 "$CONFIG_DIR/hostd.json"; fi

echo "== 5/7 构建 box 镜像（约 2 分钟）"
as_user "$ENGINE" build -t personal-agent/pa-box:0.1 "$PREFIX/box-image"

echo "== 6/7 用一次性票据注册"
install_ticket="$STATE/ticket"
run install -m 0600 -o "$SERVICE_USER" -g "$SERVICE_USER" "$TICKET_FILE" "$install_ticket"
as_user PA_BOX_HOSTD_CONFIG="$CONFIG_DIR/hostd.json" "$NODE_BIN" "$PREFIX/pa-box-hostd.mjs" register --ticket-file "$install_ticket"
run rm -f "$install_ticket" "$TICKET_FILE"

echo "== 7/7 安装并启动 systemd 单元 pa-box-hostd"
uid="$(id -u "$SERVICE_USER" 2>/dev/null || echo 0)"
unit="[Unit]
Description=personal-agent box host daemon (outbound only)
After=network-online.target ${ENGINE}.service
Wants=network-online.target

[Service]
User=${SERVICE_USER}
Group=${SERVICE_USER}
Environment=PA_BOX_HOSTD_CONFIG=${CONFIG_DIR}/hostd.json
Environment=XDG_RUNTIME_DIR=/run/user/${uid}
ExecStart=${NODE_BIN} ${PREFIX}/pa-box-hostd.mjs run
Restart=on-failure
RestartSec=10
# 凭据被 server 拒绝（主机被移除）时以 78 退出，不再重启。
RestartPreventExitStatus=78
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=full
ReadWritePaths=${STATE}
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
"
if [ "$DRY_RUN" = 1 ]; then echo "+ write /etc/systemd/system/pa-box-hostd.service"; else printf '%s' "$unit" >/etc/systemd/system/pa-box-hostd.service; fi
run systemctl daemon-reload
run systemctl enable --now pa-box-hostd.service

echo "完成。回到 personal-agent 的「Linux 云电脑」页，该主机应在 15 秒内显示为在线；点击“启动容器”创建 box。"
echo "校验只监听 localhost：ss -ltn | grep 47830   （应只看到 127.0.0.1:47830）"
