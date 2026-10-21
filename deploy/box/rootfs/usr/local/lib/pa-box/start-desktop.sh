#!/bin/bash
# 以 botN 身份运行一个桌面：Xvnc（只走 unix socket）+ openbox + Chromium。
# 由 pa-box-ctl 经 setpriv 降权、env -i 清空环境后调用；不读取任何 shell 配置。
#
# 环境（由 pa-box-ctl 传入）：
#   PA_BOX_DISPLAY  例如 :1
#   PA_BOX_SOCKET   例如 /run/pa-box/d1/vnc.sock
set -euo pipefail
umask 077

display="${PA_BOX_DISPLAY:?}"
socket="${PA_BOX_SOCKET:?}"
number="${display#:}"

mkdir -p "$HOME/.pa-box" "$HOME/.config/chromium-pa"
exec >>"$HOME/.pa-box/desktop.log" 2>&1
echo "$(date -u +%FT%TZ) starting desktop ${display}"

# X11 MIT cookie：其他 bot 即使能连到抽象命名空间的 X socket，也会因 cookie 不匹配被拒绝。
export XAUTHORITY="$HOME/.Xauthority"
rm -f "$XAUTHORITY"
: >"$XAUTHORITY"
cookie="$(python3 -I -c 'import secrets; print(secrets.token_hex(16))')"
xauth -q -f "$XAUTHORITY" add "$display" MIT-MAGIC-COOKIE-1 "$cookie"
unset cookie

rm -f "$socket"
# -rfbport -1：不监听 TCP；-rfbunixpath：只监听 unix socket，权限 0660（属组 pa-gate 来自目录 setgid）。
# -SecurityTypes None 只在 unix socket 上：访问控制由 socket 权限 + 网关令牌 + server 鉴权承担，
#  不使用弱的 VncAuth（8 位 DES 口令）。-localhost 是额外兜底。
Xvnc "$display" \
  -auth "$XAUTHORITY" \
  -nolisten tcp \
  -rfbport -1 \
  -localhost \
  -rfbunixpath "$socket" \
  -rfbunixmode 0660 \
  -SecurityTypes None \
  -AlwaysShared \
  -geometry 1600x900 \
  -depth 24 \
  -desktop "pa-box ${display}" &
xvnc=$!
trap 'kill -TERM 0 2>/dev/null || true' EXIT

for _ in $(seq 1 100); do
  [ -S "/tmp/.X11-unix/X${number}" ] && [ -S "$socket" ] && break
  kill -0 "$xvnc" 2>/dev/null || { echo "Xvnc exited during startup"; exit 70; }
  sleep 0.1
done

export DISPLAY="$display"
openbox &

# Chromium 使用自身的 user/pid namespace 沙箱（依赖 pa-box-seccomp.json），不加 --no-sandbox。
# --renderer-process-limit 控制多标签时的内存（L0：4 个重标签约 0.6–0.7GB/桌面）。
while kill -0 "$xvnc" 2>/dev/null; do
  chromium \
    --user-data-dir="$HOME/.config/chromium-pa" \
    --no-first-run \
    --no-default-browser-check \
    --password-store=basic \
    --renderer-process-limit=4 \
    --disable-features=Translate,MediaRouter \
    about:blank || true
  sleep 2
done
