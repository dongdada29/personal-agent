# 运行维护

Personal Agent 当前是一台机器上的单实例服务，持久保存任务和恢复证据，用于减少断线、失败与重启造成的数据混乱。它尚未提供多节点容灾、服务冗余、自动故障切换或零停机升级；机器停机时浏览器无法访问。

后续开发与测试在 Codex Linux 云端工作区完成，不依赖 MacBook 或 M1 在线，也不自动升级或恢复旧 M1 实例。云端工作区会话用于开发和临时验收，不承诺生产永久在线、系统自启动或持续公网入口。验收版本、环境、完整命令与边界见 [Linux 云端验收](linux-cloud-acceptance.md)。

## 日常运行与健康

在已安装、已构建的源码目录前台启动：

```sh
PERSONAL_AGENT_DATA_DIR='<ABSOLUTE_DATA_DIR>' npm run dev
```

将占位值替换为本机完整路径，记录源码提交、Node 版本和数据目录。数据目录须位于登记源仓库之外；未设置时使用 `~/.personal-agent`。正式服务固定监听 `127.0.0.1:47801`，同机另一个数据目录也不能占用同一端口。

环境和已有目录的只读检查：

```sh
npm run doctor
npm run doctor -- --data-dir '<EXISTING_ABSOLUTE_DATA_DIR>'
```

doctor 不创建目录、不迁移数据库、不恢复或结束进程、不生成设备身份。运行实例存在锁属于可报告状态；不要把看到锁等同于可以删除锁。

本地 loopback 模式可检查：

```sh
curl --fail --silent --show-error http://127.0.0.1:47801/api/health
curl --fail --silent --show-error http://127.0.0.1:47801/api/session
```

健康返回 `status: "ok"`；清理或持久化阻断时 HTTP 503、`status: "blocked"`。`engines: ["fake", "claude"]` 是 adapter 名单，不验证模型认证。paired 模式的 health 也要求设备身份，未登录 401 不能单独判断服务故障。

FIFO 一次执行一个任务，双分析最多两个引擎会话。审批等待保持 pending，不因页面断线自动允许；关闭浏览器不取消任务。日志或分享材料不应包含 Cookie、票据、provider 配置和不必要的任务内容。

## 正常停止

前台服务终端按 Ctrl+C，等待 Agent、验证进程、SQLite 和锁收尾后再关闭终端或升级。后台启动方式应记录本实例 PID、源码与数据目录；发送 SIGINT/SIGTERM 前核验实际命令、Node executable 和工作目录属于该实例。不要按端口或模糊名称批量结束进程。

干净退出后 `service.lock` 应正常释放。清理失败、状态不能落库或锁仍在时保留数据目录与锁，检查安全诊断。强制停止和删除锁不属于正常停机流程。

独立 `npm run demo` 的 Ctrl+C 还会清理其自建临时数据；正式 `npm run dev` 保留数据。这两种停止流程不能混用来清理正式目录。

## 冷备份

数据库为 `<DATA_DIR>/personal-agent.sqlite`，可能伴随 WAL/SHM。完整备份还须包含 worktree、归属记录和任务文件；不能运行时只复制 `.sqlite` 充当一致备份。

先正常停止本实例并确认执行进程收尾，再执行：

```sh
npm run backup -- \
  --data-dir '<ABSOLUTE_DATA_DIR>' \
  --output '<NEW_ABSOLUTE_BACKUP_DIR>'
```

目标须是尚不存在、位于数据目录外的绝对目录。备份工具拒绝既有 `service.lock` / `recovery.lock` 及未关闭的持久进程记录；复制时仅创建并释放自己的排他锁。它不会自动停止服务、删除既有锁或替代恢复器。检测到锁时应先排查停机，不能为备份绕过归属核验。

成功输出在 `<BACKUP_DIR>/data/` 保存完整数据副本，根目录 `backup-manifest.json` 记录每个文件的 SHA-256。恢复时使用 `data/` 的内容；先核验清单，另存当前数据，再恢复原有路径。备份根目录权限为 700。工具拒绝符号链接、特殊文件和工作区锁，需先检查这些内容后选择适合的备份方式。

备份包含任务正文、补丁和可能存在的身份哈希，属于私有运维资料，不加入源码分享包。保护读取权限，留存匹配的源码提交、Node 版本、备份时间与核验结果。备份到同一块磁盘不防磁盘损坏，定期验证可读性和恢复流程。

worktree Git 元数据引用登记源仓库与绝对路径。运行恢复还依赖这些仓库、固定源码路径和记录的 executable；复制数据目录不等于跨机器迁移。应保留任务分支、对应 Git 对象，避免源仓库删分支、prune 或清理仍保留的 worktree。

## 隔离副本恢复演练

先用新建 fake 数据目录创建并接收任务，正常停止后运行上述冷备份。不要用正式数据练习故障注入。下面的校验只读备份，并核对文件大小、SHA-256、数据库完整性和关闭的进程账本：

```sh
python3 - '<ABSOLUTE_BACKUP_DIR>' <<'PY'
from pathlib import Path
import hashlib, json, sqlite3, sys
root = Path(sys.argv[1]).resolve()
manifest = json.loads((root / 'backup-manifest.json').read_text())
data = (root / 'data').resolve()
for item in manifest['files']:
    path = (data / item['path']).resolve()
    assert path.is_relative_to(data) and path.is_file()
    content = path.read_bytes()
    assert len(content) == item['size']
    assert hashlib.sha256(content).hexdigest() == item['sha256']
for directory in manifest['directories']:
    path = (data / directory).resolve()
    assert path.is_relative_to(data) and path.is_dir()
db = sqlite3.connect((data / 'personal-agent.sqlite').as_uri() + '?mode=ro', uri=True)
assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
assert db.execute("SELECT count(*) FROM owned_processes WHERE status != 'closed'").fetchone()[0] == 0
db.close()
print('PASS: backup manifest, SQLite and process records')
PY
```

选择尚不存在的隔离数据目录，复制备份的 `data/` 内容；不要覆盖当前数据或直接在备份原件上启动服务：

```sh
RESTORE_DIR='<NEW_ABSOLUTE_RESTORE_DIR>'
test ! -e "$RESTORE_DIR" && mkdir -m 700 "$RESTORE_DIR" && \
  cp -R '<ABSOLUTE_BACKUP_DIR>/data/.' "$RESTORE_DIR/"
```

目录复制成功后，在匹配源码中执行 `npm run doctor -- --data-dir "$RESTORE_DIR"`。确认本机 47801 空闲、原演示进程已正常结束，再运行 `PERSONAL_AGENT_DATA_DIR="$RESTORE_DIR" npm run dev`。检查 health、原任务、完整事件/成果和 accepted 状态，创建一个新 fake 任务确认可继续执行，最后 Ctrl+C 正常停止。记录前后快照、命令、退出码和停机结果；哈希一致只证明副本完整，不替代实际恢复启动。

上述新目录演练适用于 fake 数据。真实开发 worktree 还依赖原 Git 仓库和绝对路径；其恢复必须另行确认路径与对象，不把 fake 演练称作真实 worktree 迁移。

## 故障定位

| 现象 | 下一步 |
| --- | --- |
| npm 下载失败 | 保存退出码与 npm 错误日志，确认官方注册表连接后用原命令加 `--prefer-offline` 重试；已成功安装且无运行进程时继续检查，避免重复安装 |
| `double-loading config` | 独立 user/global npm 配置使用不同空文件；不要改用户的全局配置 |
| doctor 非 READY / 页面 404 | 核对 Node 版本、锁定依赖和 Web 构建；在当前源码目录重新执行 build，按 doctor 给出的缺项处理 |
| `BACKUP_BUSY` | 先确认正常停机及进程账本；保留现有锁，不删除锁绕过检查 |
| `BACKUP_TARGET` | 使用已有父目录下尚不存在、位于数据目录外的目标；不覆盖旧备份 |
| `BACKUP_SYMLINK` / `BACKUP_VERIFY` | 保留源数据与失败输出，检查链接、特殊文件或并发人工编辑；失败输出不作为可恢复备份 |
| HTTP 503 / interrupted | 读取安全错误码、锁和进程归属记录；仅在恢复检查通过后明确继续或重试，不自动重放原工具 |
| CLI 会话失效 | 先查真实进程与监听端口，再决定恢复；会话 ID 失效不等于所有子进程已退出 |

## 升级与回滚

1. 记录当前提交、Node 版本、源码/数据路径及登记仓库路径。已有外网入口时先停止入口，避免恢复中接收请求。
2. 正常停止服务并确认收尾，保存完整冷备份与匹配源码。不覆盖未提交工作或复用他人的工作区。
3. 在新源码目录安装锁定依赖并构建，先以临时数据执行 demo 和测试。旧账本可能依赖原 wrapper 的绝对路径，不移动源码后跳过恢复。
4. 核对兼容性后用原数据启动新版本，检查健康、既有任务、事件/成果、审批和工作区。启动失败也可能已完成迁移，保留所有数据和日志。
5. 回滚前先另存当前完整数据；停机后恢复升级前的匹配源码与冷备份。恢复原路径前保留现目录到另一处，不覆盖或直接删除它。
6. 先在本机验证恢复结果，再处理获准的外网入口。旧 v3 没有 v4 鉴权，不能连回原公网入口。

数据库当前为 v4 增量迁移，不自动降级。回退 v3 必须恢复 v3 完整冷备份；仅切 Git tag 或将旧代码指向 v4 数据不是有效回滚。恢复旧备份会舍弃其后的新任务、事件、代码与设备变化，另存当前目录供后续处理。

同版本恢复也须使用匹配的仓库与路径。临时查看拷贝时不启动会写库、恢复进程和调度的正式服务，可使用只读 SQLite 或 doctor。

## 启动恢复与异常处理

实例先取得独占目录锁，再核验持久执行进程账本，最后协调任务和开始调度：

- 旧服务 PID 明确已不存在，或 Linux 已确认其为没有活动线程的僵尸时，启动器可通过排他 `recovery.lock` 回收旧 `service.lock`。活进程、PID 复用、锁畸形、EPERM 或归属不明确均阻止启动。
- 固定 Node executable、owner wrapper 路径、owner UUID、PID/PGID 等一致时，恢复器才停止对应执行进程。保存一个 PID 不足以证明归属。
- Linux 通过只读 `/proc` 检查区分僵尸与活动进程。僵尸已停止执行，但可能因容器 init 未回收仍占有 PID/PGID；只确认进程组没有活动成员后才认定执行已结束。owner 已成为僵尸而组内仍有活动成员，或状态/归属无法核验时，继续保留恢复门禁，不放宽 `unsafe` 检查。
- Linux 检查要求 `/proc` 与当前 PID 命名空间一致、进程列表完整可见。过滤进程的 `hidepid` 挂载、PID 目录的额外挂载或不可读取的状态会阻断僵尸组判定；僵尸主线程仍有其他线程时也视作活动。最终回收僵尸由父进程/init 负责，长期容器运行仍应使用能回收孤儿的 init。
- 清理确认后原活动任务进入 `interrupted`，旧审批过期；不会自动重放工具。用户选择“继续执行”才从 checkpoint 创建新 attempt。原 queued 任务仍按 FIFO 调度。
- 旧版活动 attempt 没有账本，或进程树未退出、归属不匹配、检查权限不足、关闭状态不能落库时，启动和调度停止并保留锁与证据。

阻断时保留完整目录、记录安全错误码，核对旧服务是否仍活着及其源码版本，再检查该实例的进程账本和核验权限。不要 `pkill node`，不要删除 `service.lock` / `recovery.lock`，不要清空 `owned_processes` 或篡改任务状态跳过恢复。无法确认时保持停止，针对归属证据处理。

接管保留 worktree。人工修改后继续会重新验证和审查，验证证据绑定完整补丁 SHA-256；不会将用户编辑自动重置回旧 checkpoint。

## HTTP 与事件接口

变更用 `commandId` 标识一次意图：同 ID 同请求返回首次结果，复用 ID 改任务、动作或内容返回冲突。丢失响应时用原 ID 重试，最新状态从快照读取。状态和事件同事务提交，仅在 COMMIT 后通知。

| 接口 | 用途 |
| --- | --- |
| `GET /api/health`、`GET /api/session` | 调度健康与访问模式 |
| `GET/POST /api/workspaces` | 列表；登记 `{commandId,name,path}` |
| `GET/POST /api/tasks` | 列表；fake `{commandId,goal,engine:"fake"}`；Claude 增加 workspaceId、verificationCommands |
| `GET /api/tasks/:id` | 一致任务/事件/成果快照及 cursor；Claude 增加阶段、运行、验证、审批 |
| `GET /api/tasks/:id/events?after=N` | JSON 补读；SSE 使用 Accept 或 `stream=1` |
| `GET /api/tasks/:id/artifacts` | 成果列表 |
| `POST /api/tasks/:id/control` | `{commandId,action,requirements?}`；动作见 [任务流程](getting-started.md#暂停接管与交付) |
| `GET /api/approvals`、`POST /api/approvals/:id/resolve` | 待决审批；`{commandId,optionId}` 处理当前 attempt |
| `GET/PATCH /api/settings` | 默认引擎、Agent 活跃预算和验证超时，PATCH 带 commandId |
| `GET/POST /api/agents`、`PATCH /api/agents/:id` | 角色档案、提示词和模型标识，不管理凭据 |
| 配对与设备接口 | 见 [设备访问说明](device-access.md)，需要显式启用 |

SSE 示例仅针对本地模式：

```sh
curl -N -H 'Accept: text/event-stream' \
  'http://127.0.0.1:47801/api/tasks/<TASK_ID>/events?after=0'
```

先读快照再从 `cursor` 订阅，补齐两次请求之间的事件。事件名 `task_event`，`id` 为持久化全局 seq，`data` 是 TaskEvent JSON。单任务 seq 可有空洞，cursor 只用于对应任务。支持 `Last-Event-ID`，与 after 同时存在时取较大值；超出任务最新 seq 返回 409，重新读取快照。

默认重连建议 1 秒、注释心跳 15 秒、每连接待写上限 256 KiB。超限或出错时关闭连接，客户端可补读；断开不取消任务，关闭服务会清理订阅。paired 模式还需精确同源与设备 Cookie，不能沿用无身份示例。

## 定期验收

```sh
npm run typecheck
PERSONAL_AGENT_SSE_REAL_SOCKETS=1 \
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 \
npm test -- --maxWorkers=1 --minWorkers=1
npm run smoke
npm run demo -- --check
npm run build
git diff --check
```

全量含临时进程崩溃、归属核验、真实 loopback SSE 和虚拟设备认证测试。信号只针对测试自建进程，不对运行实例做崩溃演练；会生成并销毁临时身份，不给真实设备配对。单 worker 控制资源，保留版本、命令、数量、退出码和跳过项，不能将子集或 socket 模拟写成目标机全量实测。

真实模型、开发任务、HTTPS 和手机跨网需独立证据。系统自启动、Cloudflare/DNS/Tunnel/持久 token 和电源设置属于额外部署操作，本指南不自动更改它们。
