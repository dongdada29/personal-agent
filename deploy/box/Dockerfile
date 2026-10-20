# syntax=docker/dockerfile:1
#
# personal-agent 的 Linux 云电脑 / 远程电脑镜像（pa-box）。
#
# 本地（Colima pa-box / WSL2 / Podman）与云端主机使用同一个镜像。构建：
#   bash --noprofile --norc scripts/box/colima-pa-box.sh build      # macOS，构建到 colima-pa-box 上下文
#   docker build -t personal-agent/pa-box:0.1 deploy/box             # 云端主机 / Linux
#
# 设计要点（L0 实测，见 docs/desktop.md「box 加固」）：
# - 每个桌面一个 Linux 用户（bot1..bot3），HOME 0700，各自的 Chromium profile；
# - Xvnc 只监听每桌面的 unix socket（/run/pa-box/dN/vnc.sock，0660，属组 pa-gate），
#   不监听任何 TCP；X11 使用 MIT cookie；
# - 容器内唯一的 TCP 监听是 pa-box-gate（6080，用户 pa-gate）：连接必须先发送
#   “每桌面、短时有效”的令牌，令牌由 server 经 `docker exec -i pa-box-ctl` 从 stdin 写入；
#   宿主侧只发布到 127.0.0.1:47830，由 server 的鉴权代理访问；
# - 不使用 websockify / noVNC 页面：WebSocket 由 server 终结，noVNC 由 web 前端提供；
# - Chromium 使用 user namespace 沙箱，从不加 --no-sandbox；运行时需要
#   `--security-opt seccomp=pa-box-seccomp.json --security-opt no-new-privileges`。
FROM debian:bookworm-slim

ARG PA_BOX_MAX_DESKTOPS=3
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PA_BOX_MAX_DESKTOPS=${PA_BOX_MAX_DESKTOPS}

# Debian 的 chromium 是 deb 包（不是 snap）；procps 提供 pgrep/pkill，util-linux 提供 setpriv。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates chromium fonts-dejavu-core fonts-noto-cjk openbox procps python3 \
      tigervnc-standalone-server tini util-linux xauth \
 && rm -rf /var/lib/apt/lists/*

# 固定 UID/GID：命名卷 pa-box-home 在重建容器后仍保留，属主必须稳定。
RUN groupadd --system --gid 990 pa-gate \
 && useradd --system --uid 990 --gid pa-gate --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin pa-gate \
 && for n in $(seq 1 "${PA_BOX_MAX_DESKTOPS}"); do \
      groupadd --gid "$((1000 + n))" "bot${n}" \
   && useradd --uid "$((1000 + n))" --gid "bot${n}" --home-dir "/home/bot${n}" --create-home --shell /bin/bash "bot${n}" \
   && chmod 0700 "/home/bot${n}"; \
    done

COPY --chmod=0755 rootfs/usr/local/lib/pa-box/ /usr/local/lib/pa-box/
COPY --chmod=0755 rootfs/usr/local/sbin/pa-box-ctl /usr/local/sbin/pa-box-ctl

EXPOSE 6080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["python3", "-I", "-c", "import socket; socket.create_connection(('127.0.0.1', 6080), 2).close()"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/lib/pa-box/entrypoint.sh"]
