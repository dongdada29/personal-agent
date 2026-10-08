# 许可证与源码分享范围

项目当前在 [LICENSE](../LICENSE) 与 package metadata 中声明 Apache-2.0；公开发布待用户批准，本轮仅准备本地源码材料，未发布或改变许可。第三方依赖保留各自的许可证或使用条款；项目许可不重新授权这些依赖、模型服务或第三方执行文件。

本轮检查日期为 2026-10-06，依据本工程 `package-lock.json` 和已安装包的许可文件。以下内容用于准备本地源码分享材料；尚未公开发布源码、安装包或网站。

## 固定移植来源

本项目窄范围移植了 `nuwax-ai/nuwa-cli` 的进程树收尾实现，归属记录见 [NOTICE](../NOTICE)：

- 上游仓库：<https://github.com/nuwax-ai/nuwa-cli>。
- 固定 commit：`39cc8a50b81763297573bdba65fd606262253f76`。
- 原文件：`src/core/processes/killTree.ts`。
- 本工程文件：`packages/runtime/src/engine-process.ts`。
- 上游许可：Apache 2.0；固定版本的该源文件没有单独版权头，仓库根没有 NOTICE。
- 修改声明保留在本工程文件头：有界异步清理、较短收尾期限、明确失败报告，以及不输出进程参数或 stderr。

分享时保留 `LICENSE`、`NOTICE` 和上述文件头。没有移植上游商业隧道、云账号系统、平台执行文件或相邻工作区的未提交修改。[Apache 2.0 第 4 条](https://www.apache.org/licenses/LICENSE-2.0)规定分发时的许可证、修改声明和相关归属通知要求。

## ACP、Claude 引擎与模型条款

| 组件 | 锁定版本 | 许可或条款 |
| --- | --- | --- |
| `@agentclientprotocol/sdk` | 1.3.0 | Apache-2.0 |
| `claude-code-acp-ts` | 0.65.0 | Apache-2.0；其许可不覆盖它调用的 Anthropic 执行引擎 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.220 | 包内为 `SEE LICENSE IN README.md`；LICENSE.md 指向 Anthropic 独立法律条款 |
| `@anthropic-ai/claude-agent-sdk-*` 平台执行包 | 0.3.220 | `SEE LICENSE IN LICENSE.md`；Anthropic 独立法律条款 |

Anthropic SDK 及平台包的现有许可文件注明版权归 Anthropic PBC。官方 [Agent SDK 许可说明](https://code.claude.com/docs/en/agent-sdk/overview#license-and-terms)说明 SDK 使用适用 Anthropic Commercial Terms，个别组件另有许可时依其 LICENSE 文件处理。不能将整个依赖树描述为“全部 Apache 2.0”或把 Claude 执行文件称为本项目自有开源代码。

模型服务访问还受用户与对应服务商的协议约束。本工程不附带模型凭据、订阅或免费额度，不代收或转存用户的 Claude 账号认证。产品中使用原版 Claude 执行文件和用户认证、计费的条件见 [Anthropic 官方法律说明](https://code.claude.com/docs/en/legal-and-compliance)。源码许可与模型调用资格是两件独立事项。

## 其他依赖核对

锁文件中 415 个第三方下载项均指向 `https://registry.npmjs.org`，另有 4 个本工程 workspace link。这些下载项包括不同平台的可选包，不代表每台主机都会安装全部 415 项。

| 锁文件中的许可字段 | 第三方包项数 |
| --- | ---: |
| MIT | 365 |
| ISC | 18 |
| Apache-2.0 | 5 |
| BSD-3-Clause | 7 |
| BSD-2-Clause | 1 |
| BlueOak-1.0.0 | 8 |
| Unlicense | 1 |
| CC-BY-4.0 | 1 |
| `SEE LICENSE IN README.md` / `SEE LICENSE IN LICENSE.md` | 9 |

`caniuse-lite` 的数据使用 CC-BY-4.0，不能统一标为 MIT。上述统计是锁文件元数据检查，不能替代实际分发内容的许可文件与归属通知核对；更新依赖后需要重新检查。

本轮主机安装了 336 个第三方包，其中 8 个包没有顶层 LICENSE 文件：`@ant-design/icons-svg`、两种已安装版本的 `@esbuild/darwin-arm64`、`@rollup/rollup-darwin-arm64`、`abstract-logging`、`stackback`、`standardwebhooks`、`toggle-selection`。这些包的 package metadata 标注 MIT，但未来若分发包含它们代码的产物，需要从对应固定版本的原始来源补齐许可和归属材料，不能仅凭 metadata 判定材料齐备。

## 当前可分享材料

当前分享材料限定为本项目源码、测试、使用文档、`package.json`、`package-lock.json`、`LICENSE` 和 `NOTICE`。接收者按 README 自行从官方注册表安装依赖，并按对应条款使用第三方组件。

源码包不包含：

- `node_modules`、Web `dist`、打包后的第三方代码或任何 Anthropic 平台执行文件。
- Git 历史、运行数据库、任务正文、成果、工作区副本、日志和部署证据。
- SSH 文件、模型认证、Cloudflare 凭据、设备会话、配对票据或本机私有配置。

归档应从已审核的 commit 导出，仅纳入该 commit 的项目文件，并附 commit、文件清单及 SHA-256 校验值；检查没有个人绝对路径、真实基础设施值、秘密、符号链接或越界路径。`.gitignore` 不是分享包内容审核的替代品。

当前说明没有完成 `node_modules`、预构建 Web、单文件可执行程序或容器镜像的再分发审核。如果将来提供这些形式，先针对实际产物补齐第三方许可文本与版权归属、复核 Anthropic 执行引擎条款，并另行记录审核结果。
