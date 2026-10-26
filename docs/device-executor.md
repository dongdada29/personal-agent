# 设备执行器层（Phase 1）

把「点屏 / 截图 / 启动 App」从技能正文里抽出来，变成可插拔的 `DeviceExecutor`。编排与通道解耦：今天默认走 M1 上的 LLD12 Appium 真机，以后 M4 / ESP32 / 网页只加 Adapter，不改外卖流程。

本层 **不改变** 生产实例 `127.0.0.1:47801` 的启动、监听或部署。本地烟测可与 demo 口 `47811` 并存。

## 默认通道

| 通道 | 角色 | Phase 1 |
| --- | --- | --- |
| **M1 · Appium/WDA** | 生产默认写控。宿主 `m1`，真机 LLD12 UDID `00008101-001E28A10CE0001E` | `M1Adapter` 包装 `ios_act.py` |
| M4 · Appium | 同栈备份 | 仅占位，`CHANNEL_NOT_IMPLEMENTED` |
| ESP32 · HID | 实验旁路，`canPay=false` | 不进主路径 |
| 网页 / H5 | 只读浏览 | 不进主路径 |
| fake | 测试与 CI 烟测 | `FakeDeviceExecutor` |

禁止多通道同时写控。全局 `WriteLease`（`write.lock`）同一时刻只允许一个通道的一个 holder。

支付、验证码、Face ID、解锁一律 `human_gate`：执行器暂停并抛 `HumanGateError`，由意图层等人。`canPay=true` 仍必须先 `requirePaymentGate()`，禁止无人下单。

## 契约

技能 / Bot 只依赖 `@personal-agent/device`，不要 import Appium，也不要直接拼 `ios_act.py` 命令行。

```ts
import { createDeviceOrchestrator, requirePaymentGate } from '@personal-agent/device';

const orch = createDeviceOrchestrator(); // 默认 M1
const health = await orch.health();
const shot = await orch.observe({ includeTree: true });
const session = await orch.acquire({ holder: 'skill:meituan' });
try {
  await orch.executor().act({ type: 'tap', x: 120, y: 480 }, session);
  requirePaymentGate(); // 支付前必须停
} finally {
  await orch.release(session);
}
```

接口覆盖：

- `observe`：截图，可选 UI 树 → `Observation`
- `act`：tap / swipe / type / launch / clipboard；tap/swipe 带拟人熵档位 `off|low|medium|high`
- `acquire` / `release`：单写控租约
- `capabilities`：`canPay` / `needsUnlock` / `visionOnly` / `uiTree` / `entropy`
- `health`：设备在线、WDA、脚本是否存在；失败返回 `ok:false`，不抛（方便以后切备份）
- `HumanGateError`：`captcha` / `payment` / `face_id` / `unlock` / `confirm`

## M1Adapter 怎么包现有脚本

默认脚本（运行时拼 `$HOME`，源码不写死家目录）：

`$HOME/workspace/ios-ai-automation/scripts/ios_act.py`

同目录若有 `human_entropy.py`，桥接会 import 并在 tap/swipe 上应用档位。

调用链：

`DeviceExecutor` → `python3 packages/device/python/m1_bridge.py --script <ios_act.py> --udid <LLD12> --json` → stdin 一条 JSON → stdout 一条 JSON。

桥接优先调用 `ios_act` 模块上的 `health` / `screenshot` / `tap` 等函数；没有对应函数时再回退到 `python ios_act.py <subcommand>`。M1Adapter 自己不发 Appium HTTP。

覆盖方式（均须绝对路径）：

```sh
export PA_DEVICE_IOS_ACT=/absolute/path/to/ios_act.py
export PA_DEVICE_UDID=00008101-001E28A10CE0001E
export PA_DEVICE_PYTHON=python3
export PA_DEVICE_ENTROPY=medium
export PA_DEVICE_LEASE_DIR=/absolute/path/to/lease-dir
```

## 烟测（health + observe）

不启动 47801，不部署，不打 tag。

```sh
# CI / 无真机：fake 通道，期望 PASS
npm run device:smoke

# 可选 UI 树
npm run device:smoke -- --tree

# M1 真机（LLD12 USB + ios_act.py + WDA）
npm run device:smoke -- --real
```

单元测试（注入假 `ios_act`，不上真机）：

```sh
npx vitest run packages/device/test
```

`--real` 在脚本或 WDA 未就绪时打印 `NEEDS_ACTION` 并退出 1，属于探测结果，不是生产故障。

## 技能迁移（本 PR 不做）

`ios-lld12-control` / `ios-life-*` 仍可当 runbook。后续把「点美团外卖」正文改成通道无关技能包，只调本接口；本 PR 只留这个 TODO，不改技能文本。

## 明确不做（Phase 1）

- ESP32 / Safari Harness 进主路径
- 改 47801 生产部署、launchd、Tunnel
- 多通道同时写控
- 把 Harness 当外卖支付执行器
