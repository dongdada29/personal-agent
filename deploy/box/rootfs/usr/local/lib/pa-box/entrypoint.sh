#!/bin/bash
# pa-box 容器入口（root，tini 的子进程）。
#
# 1. 准备运行目录与权限：
#    /run/pa-box/gate     root:pa-gate 0750   每桌面令牌（root 写入，网关只读）
#    /run/pa-box/dN       botN:pa-gate 2750   Xvnc 的 unix socket；setgid 使 socket 属组为 pa-gate
#    其他 bot 既不能进入别人的 dN 目录，也读不到令牌。
# 2. 降权为 pa-gate，前台运行网关。桌面由 server 经 `docker exec pa-box-ctl start dN` 按需启动，
#    启动后的进程被 tini（PID 1）收养，容器重启后所有桌面都是停止状态。
set -euo pipefail
unset BASH_ENV ENV
umask 022
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

max="${PA_BOX_MAX_DESKTOPS:-3}"
if ! [[ "$max" =~ ^[1-9]$ ]]; then echo "pa-box: invalid PA_BOX_MAX_DESKTOPS" >&2; exit 64; fi

# 每次启动都清空运行目录：旧令牌与旧 socket 一律失效。
rm -rf /run/pa-box
install -d -m 0755 -o root -g root /run/pa-box
install -d -m 0750 -o root -g pa-gate /run/pa-box/gate
install -d -m 1777 -o root -g root /tmp/.X11-unix

for n in $(seq 1 "$max"); do
  user="bot${n}"
  if ! id -u "$user" >/dev/null 2>&1; then echo "pa-box: missing user ${user}" >&2; exit 65; fi
  # 命名卷首次挂载或被清空时补建 HOME；已有内容只校正属主与权限。
  install -d -m 0700 -o "$user" -g "$user" "/home/${user}"
  chown "$user:$user" "/home/${user}"
  chmod 0700 "/home/${user}"
  install -d -m 2750 -o "$user" -g pa-gate "/run/pa-box/d${n}"
done

exec setpriv --reuid=pa-gate --regid=pa-gate --init-groups \
  /usr/bin/python3 -I /usr/local/lib/pa-box/pa-box-gate.py
