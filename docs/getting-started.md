# 首次运行与任务流程

先用 fake 演示本机工作台，再选择是否运行真实 Claude 开发 fixture。fake 不发模型请求；真实任务使用所在机器已有的模型认证，并可能产生费用。所有示例只使用本机 loopback 和专用演示目录。

## 安装与环境检查

需要 Node.js 22.18 或更高、npm、Git、可用磁盘空间，以及到官方 npm 注册表的正常 TLS 连接。运行需要 macOS/Linux POSIX 进程能力；macOS 历史证据与 [Linux 云端验收](linux-cloud-acceptance.md) 分开记录，Windows 当前返回 `PROCESS_UNSUPPORTED`。

本项目后续开发与验收在 Codex Linux 云端工作区完成，不依赖 MacBook 或 M1 在线。下文的 loopback 地址属于运行服务的机器；云端命令验收使用 `smoke` 与 `demo -- --check`，不表示用户电脑可以直接访问该地址。工作区会话不等于生产常驻部署；真实模型、HTTPS 和手机跨网仍需分别授权与实测。

```sh
node --version
npm --version
git --version
npm ci --ignore-scripts --registry=https://registry.npmjs.org --strict-ssl=true
npm run build
npm run doctor
npm run smoke
```

首次安装不承诺固定用时。下载失败后不要删除锁文件、关闭 TLS 校验或切换来源来凑成功；先排查网络，再用同一命令重试。独立空 npm 配置如有需要，user 和 global 必须使用两个不同的文件；使用同一路径会得到 `double-loading config`。

`doctor` 只检查环境；可增加 `--data-dir '<EXISTING_ABSOLUTE_DATA_DIR>'` 读取已有 SQLite 与锁概要，不创建目录、不迁移数据库、不恢复进程。`build` 包含共享工程和 Web 类型检查，并生成 Fastify 托管的 Web 文件。`smoke` 在临时目录通过 `app.inject` 检查任务创建和独立 stdio fake ACP，预期为 `PASS`、`completed`、13 条事件、1 项成果；它不验证 HTTP 监听或浏览器。

## 独立 HTTP demo

```sh
npm run demo
```

打开终端打印的地址，默认 <http://127.0.0.1:47811/?demo=fake>。demo 使用新临时数据目录，默认端口 47811，与正式实例的 47801 分开；预置成功任务、故障任务并核验命令重放。它只使用 fake，不加载模型认证、不产生配对访问、不自动打开浏览器。服务保持前台，按 Ctrl+C 关闭；确认进程收尾后清理本次创建的数据，清理阻断则保留临时目录与归属证据供检查。

端口冲突时选择其他空闲本机端口，例如 `npm run demo -- --port 47812`。不要为了运行 demo 停止正在使用的正式实例。

自动验收可以不保留服务：

```sh
npm run demo -- --check
```

检查模式使用系统分配的临时端口，检查真实 HTTP 创建、fake 成功与异常、命令重放、SQLite 事件/成果一致性，完成后退出并清理。它不等于真实模型、浏览器或手机跨网验收。

## 无模型工作台流程

1. 在“新建任务”确认显示 **fake · 演示任务**，目标填写“生成一份本地演示成果”，点击“创建演示任务”。独立 demo 固定使用 fake；fake 不需要登记工作区或验证命令。
2. 任务先排队，随后显示“已完成”。详情包含持久事件和 Markdown 成果；页面合并消息片段，可展开原始事件。
3. 点击“接收成果”，交付状态变为“已接收”。刷新后从列表选择原任务，仍可读取其接收状态与成果；独立 demo 退出清理后这些临时记录不再保留。
4. 查看预置故障任务，或创建目标含 `fake:error` 的任务，例如 `fake:error 演示故障处理`。该专用标记触发可控引擎错误，任务显示“执行失败”，没有伪造成功成果。
5. 点击故障任务的“重试任务”，确认记录保留且创建新的 attempt。`fake:error` 是固定故障输入，原目标没有改变，因此重试仍会失败；另创建正常目标，确认队列能继续完成新任务。
6. 中断恢复需使用自建测试实例：服务异常退出后，重新启动同一源码与数据目录，原活动任务应为 interrupted；明确点击“继续执行”或“重试任务”才建立新 attempt。固定 `fake:hang` 目标再次运行仍会挂起，可取消并查看进程收尾。不要对正式实例做崩溃演练。

fake 是单阶段演示，不实际修改仓库，也不执行目标中的自然语言要求。它展示状态、事件、成果和控制接口；真实多 Agent 开发、工具审批和代码验证使用下文的 Claude 流水线。

页面断线时显示重连或轮询进度。关闭标签页不取消任务；重新打开并选择同一任务可补读进度。需要停止执行时使用“取消任务”或“立即接管”。

## 保留任务的本机实例

要保留任务记录，使用正式启动入口和独立数据目录，先确认 47801 空闲：

```sh
DEMO_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/personal-agent-demo.XXXXXX")"
printf 'Demo data: %s\n' "$DEMO_DATA_DIR"
PERSONAL_AGENT_DATA_DIR="$DEMO_DATA_DIR" npm run dev
```

打开 <http://127.0.0.1:47801>。按 Ctrl+C 正常停止；这里的数据目录不会自动删除。记下打印的目录，以相同 `PERSONAL_AGENT_DATA_DIR` 再次启动可查看保留记录。长期使用时选自有的持久绝对目录；不传该变量时默认使用 `~/.personal-agent`。

同一机器另一个数据目录仍共用 47801，不能同时启动两个正式实例。已有服务可以直接使用，无需重复启动。复用旧目录会自动迁移 SQLite，报错也不表示没有迁移；先按 [运行维护](operations.md) 停机与冷备份，不用现有正式数据练习首次安装。

## 真实 Claude 探针

adapter 使用锁定的 Claude ACP 0.65.0 和 ACP SDK 1.3.0。引擎使用当前运行机器已有的原生认证/provider；不要复制其他机器的认证目录，不要把 API key、密码或 token 放进任务、仓库或聊天。

```sh
# 只验证 ACP 初始化、会话和 plan 模式，不发模型请求
npm run probe:claude
```

输出 `protocolReady`、`sessionReady`、`planModeSupported` 等状态；`authenticatedPrompt: "not_checked"` 表示未验证模型往返。健康接口中的引擎列表也不表示 Claude 已认证。

只有明确允许真实模型调用后，再执行以下任一受限探针：

```sh
# 隔离用户设置；原生认证是否可用取决于当前机器
npm run probe:claude -- --prompt
# 使用当前机器已有的用户 provider 设置
npm run probe:claude -- --prompt --user-settings
```

探针只请求固定文本，临时目录无项目内容；禁用工具、客户端文件/终端能力、hooks、MCP、插件、自动更新和会话持久化。它不登录、不生成认证、不转存 provider 值，输出固定状态和安全错误码。用户设置模式发现认证 helper 则拒绝。认证不足时继续 fake；协议成功不能替代 `authenticatedPrompt: "passed"`。

## 最小真实开发 fixture

本节使用上文的 [保留任务的本机实例](#保留任务的本机实例)，其默认端口为 47801。临时 HTTP demo 只支持 fake；先正常关闭 demo，再启动或使用持久实例，然后登记 fixture。

```sh
npm run fixture
```

只新建或读取 `.data/phase2-fixture/repo`，拒绝覆盖已有非空目录来创建 fixture。首次建立无第三方依赖的 greeting Git 仓库，并故意保留宿主 README 的未提交 WIP。输出完整仓库路径、基线 SHA、目标和验证命令。3 项基线测试有 2 项故意失败，这是任务输入。

在工作台选择 **Claude · 真实执行**：

1. 展开“登记 Git 工作区”，填演示名称和 fixture 输出的完整 `path`，点击“登记并选择”。必须登记有 HEAD 提交的非 bare 仓库根目录；数据目录必须位于该源仓库之外。
2. 填写输出的 `goal`：trim 名称、空白名称使用 Guest，并新增 CHANGELOG；保留无关文件，不提交、合并或推送。
3. “可执行程序”使用输出中 `verificationCommands[0].command` 的 Node 绝对路径。“参数”填写以下合法 JSON：

   ```json
   ["--test", "test/greet.test.js"]
   ```

4. 确认允许该验证命令和模型调用后创建真实任务。验证使用参数数组和 `shell:false`，不要把整段 shell 命令填进可执行程序字段。
5. 查看双分析、开发、实际验证、审查和汇总。planner/reviewer 使用 plan，developer 使用 default；Runtime 保存真实 exitCode/stdout/stderr，模型“通过”不能覆盖实际验证失败。
6. 出现工具审批时先检查完整输入、路径和 diff，再明确允许或拒绝。可以暂停、接管或取消等待中的任务，无需先允许工具。
7. 核对补丁、验证、汇总及保留的 worktree，再接收或退回。宿主 README 的 WIP 不应被修改；接收只改变交付状态。

reviewer 的当前完整回复可以先有纯说明文字，最后必须只有一个完整 JSON 对象或 `json` 代码围栏，字段严格为 `verdict`、`blockers`、`evidence`。前面另有结构化候选、多个对象、重复字段、截断、字段不合法或结果后的说明都会使审查无效；不会从工具日志或成果中寻找一个 pass。合法 pass 仍须满足 Runtime 的实际命令和补丁一致性核验。

审查不合法或一次自动返工后仍未通过，会进入等待处理。worktree 与补丁保留，合并、推送、清理由用户另行操作。文本补丁上限 1 MiB，二进制或过大成果明确失败。worktree 只隔离 Git 修改，不能限制进程对系统的访问，先用自己的非敏感 fixture。

## 暂停、接管与交付

| 操作 | 何时使用 | 实际行为 |
| --- | --- | --- |
| 保存补充要求 | 活动任务需要后续约束 | 立即持久化，默认从下一阶段生效 |
| 阶段结束后暂停 | 希望当前阶段先完成 | 成功收尾后暂停，双分析一起收尾 |
| 立即接管 | 当前阶段需要马上停止 | 停止全部 Agent 与验证，确认退出后 paused；可同时保存要求 |
| 继续执行 | paused / interrupted | 保留代码与历史，从未完成阶段建立新 attempt |
| 重试任务 | failed / interrupted / 可返工的审查等待 | 保留 worktree，创建新 attempt；审查等待回到开发 |
| 取消任务 | 不再需要执行 | 确认进程停止后 cancelled |
| 接收成果 | completed 且待接收 | deliveryStatus 变为 accepted，不合并代码 |
| 退回返工 | completed 且待接收 | 必填退回要求，从开发阶段返工 |

评审或汇总时补充代码修改要求不会自动退回开发；先接管处理，或交付后退回。人工修改 worktree 后继续会重新验证和审查；旧验证不能覆盖新代码。旧 attempt 的事件和审批回执不能污染新 attempt。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 官方依赖下载慢、ECONNRESET / ETIMEDOUT | 首次下载时间取决于网络和缓存；确认官方 npm 注册表可正常访问，再重试原 `npm ci`。可加 `--prefer-offline` 复用已校验缓存，仍保留锁文件、官方注册表与 TLS 校验 |
| 端口占用 | 确认原实例及其源码/数据目录，继续使用原服务；demo 改用空闲端口，不随意结束占端口进程 |
| INSTANCE_LOCKED / 恢复阻断 | 保留锁和账本，按 [恢复指引](operations.md#启动恢复与异常处理) 排查 |
| 页面 404 | 先 `npm run build`；确认在运行服务的同一机器访问 loopback |
| 任务列表连接失败 | 查服务终端、health 和连接状态，使用“重试连接”，不重复创建任务排查网络 |
| 验证参数无效 | 填 JSON 字符串数组，例如 `["test"]`；无参数使用 `[]` |
| Claude 认证失败 | 使用该机已有合法认证，不搬运或生成凭据绕过限制，改用 fake |
| 页面要求配对 / API 401 | 数据目录已持久启用 paired，省略环境变量不能取消；按 [设备访问说明](device-access.md) 使用正确 origin |
| 跨平台行为不同 | Linux 在目标环境复验，Windows 当前不支持；构建通过不等于运行通过 |

开发 Web 可另开终端 `npm run dev:web`，使用 Vite 输出的 loopback 地址，API 代理到 47801。paired 模式使用 Fastify 托管的同源构建，不额外放行 Vite Origin。
