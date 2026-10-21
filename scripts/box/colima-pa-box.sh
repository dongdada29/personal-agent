#!/usr/bin/env -S bash --noprofile --norc
# macOS：管理 personal-agent 专用的 Colima profile `pa-box` 与 box 镜像。
#
# 一律用不读取任何启动配置的 bash 运行（L0：用户 zsh 里 docker / grep / head 被 alias 成不存在的程序）：
#   bash --noprofile --norc scripts/box/colima-pa-box.sh <命令>
#
# 命令：
#   start    创建 / 启动 profile：vz、2 vCPU / 4GiB / 40GiB、--activate=false、--mount none
#   build    在 colima-pa-box 上下文里构建镜像 personal-agent/pa-box:0.1（deploy/box/Dockerfile）
#   verify   校验：默认 docker 上下文未改变、容器安全参数、宿主 47830 只监听 127.0.0.1
#   stop     停止 profile（卷 pa-box-home 与镜像保留）
#   status   打印 profile 与容器状态
#
# 本脚本从不执行 `docker context use`，从不操作 default profile，docker 命令一律显式 --context colima-pa-box。
set -euo pipefail
unset BASH_ENV ENV DOCKER_HOST DOCKER_CONTEXT
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PROFILE=pa-box
CONTEXT=colima-pa-box
IMAGE=personal-agent/pa-box:0.1
CONTAINER="${PA_BOX_CONTAINER:-pa-box-desktop}"
GATE_PORT=47830
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1：brew install colima docker" >&2; exit 69; }; }
docker_box() { docker --context "$CONTEXT" "$@"; }
current_context() { docker context show 2>/dev/null || true; }

arch_flag() {
  case "$(uname -m)" in
    arm64) echo aarch64 ;;
    x86_64) echo x86_64 ;;
    *) echo "" ;;
  esac
}

cmd_start() {
  need colima; need docker
  local before after arch
  before="$(current_context)"
  arch="$(arch_flag)"
  if colima list --json 2>/dev/null | grep -q "\"name\":\"${PROFILE}\""; then
    colima start "$PROFILE" --activate=false --mount none
  else
    colima start "$PROFILE" --vm-type vz --runtime docker --cpus 2 --memory 4 --disk 40 ${arch:+--arch "$arch"} --activate=false --mount none
  fi
  after="$(current_context)"
  if [ -n "$before" ] && [ "$before" != "$after" ]; then
    echo "默认 docker 上下文被改成了 ${after}，恢复为 ${before}" >&2
    docker context use "$before" >/dev/null
  fi
  echo "profile ${PROFILE} 已启动；默认 docker 上下文：$(current_context)"
}

cmd_build() {
  need docker
  docker_box build -t "$IMAGE" "$ROOT/deploy/box"
}

cmd_verify() {
  need docker
  local failed=0 inspect
  echo "默认 docker 上下文：$(current_context)"
  if ! inspect="$(docker_box inspect "$CONTAINER" --format '{{json .HostConfig.PortBindings}} {{.HostConfig.Privileged}} {{json .HostConfig.SecurityOpt}} {{json .Mounts}}' 2>/dev/null)"; then
    echo "容器 ${CONTAINER} 不存在（在 personal-agent 的「Linux 云电脑」页点击启动容器，或先 build）" >&2
    return 1
  fi
  case "$inspect" in *'"HostIp":"127.0.0.1","HostPort":"47830"'*) ;; *) echo "FAIL: 网关端口未只发布到 127.0.0.1:${GATE_PORT}" >&2; failed=1 ;; esac
  case "$inspect" in *'"HostIp":""'*|*'"HostIp":"0.0.0.0"'*) echo "FAIL: 有端口发布到所有网卡" >&2; failed=1 ;; esac
  case "$inspect" in *' true '*) echo "FAIL: 特权容器" >&2; failed=1 ;; esac
  case "$inspect" in *no-new-privileges*) ;; *) echo "FAIL: 缺少 no-new-privileges" >&2; failed=1 ;; esac
  case "$inspect" in *seccomp=*) ;; *) echo "FAIL: 缺少自定义 seccomp" >&2; failed=1 ;; esac
  case "$inspect" in *'"Type":"bind"'*) echo "FAIL: 存在 bind mount" >&2; failed=1 ;; esac
  if command -v lsof >/dev/null 2>&1; then
    local listeners
    listeners="$(lsof -nP -iTCP:${GATE_PORT} -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n//p' || true)"
    echo "宿主 ${GATE_PORT} 监听：${listeners:-（无）}"
    while IFS= read -r address; do
      [ -z "$address" ] && continue
      case "$address" in "127.0.0.1:${GATE_PORT}"|"[::1]:${GATE_PORT}") ;; *) echo "FAIL: 宿主在 ${address} 上监听" >&2; failed=1 ;; esac
    done <<<"$listeners"
  fi
  # 容器内除网关外不应有任何 TCP 监听（桌面只走 unix socket）。
  if ! docker_box exec "$CONTAINER" /bin/bash --noprofile --norc -c \
      'for p in $(pgrep -x Xvnc || true); do python3 -I /usr/local/lib/pa-box/no-tcp-listen.py "$p" || exit 1; done'; then
    echo "FAIL: 有桌面 Xvnc 在监听 TCP" >&2; failed=1
  fi
  if [ "$failed" = 0 ]; then echo "OK: 所有检查通过"; fi
  return "$failed"
}

cmd_stop() { need colima; colima stop "$PROFILE"; }

cmd_status() {
  need colima
  colima list --json | grep "\"name\":\"${PROFILE}\"" || echo "profile ${PROFILE} 不存在"
  docker_box ps -a --filter "name=^${CONTAINER}$" --format '{{.Names}} {{.Status}} {{.Ports}}' 2>/dev/null || true
}

case "${1:-}" in
  start) cmd_start ;;
  build) cmd_build ;;
  verify) cmd_verify ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  *) echo "用法：bash --noprofile --norc scripts/box/colima-pa-box.sh start|build|verify|stop|status" >&2; exit 64 ;;
esac
