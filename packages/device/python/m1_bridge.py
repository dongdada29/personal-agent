#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""JSON 门面：把现有 ios_act.py（及可选 human_entropy）接到 DeviceExecutor。

M1Adapter 从不直连 Appium。本进程从 stdin 读一条 JSON 请求，向 stdout 写一条 JSON 应答。
优先 import ios_act 上的函数；没有对应函数时再按 argv 子命令回退。

请求：
  {"v":1,"op":"health"|"observe"|"act","includeTree":false,"action":{...},"entropy":"medium"}

应答始终含 ok: bool。失败时 error.code 为固定英文码，message 为中文短句，不含本机路径。
"""
from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import random
import subprocess
import sys
import traceback
from types import ModuleType
from typing import Any

PROTOCOL = 1
GATE_HINTS = {
    "captcha": ("captcha", "验证码"),
    "payment": ("payment", "收银台", "支付", "付款"),
    "face_id": ("face id", "faceid", "face_id", "面容"),
    "unlock": ("passcode", "unlock", "锁屏", "解锁"),
}


def emit(payload: dict[str, Any], exit_code: int = 0) -> None:
    payload.setdefault("v", PROTOCOL)
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    raise SystemExit(exit_code)


def fail(code: str, message: str, reason: str | None = None, exit_code: int = 1) -> None:
    error: dict[str, Any] = {"code": code, "message": message}
    if reason:
        error["reason"] = reason
    emit({"v": PROTOCOL, "ok": False, "error": error}, exit_code)


def load_module(path: str, name: str) -> ModuleType | None:
    if not path or not os.path.isfile(path):
        return None
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
        return module
    except Exception:
        sys.modules.pop(name, None)
        return None


def first_callable(module: ModuleType | None, names: tuple[str, ...]):
    if module is None:
        return None
    for name in names:
        fn = getattr(module, name, None)
        if callable(fn):
            return fn
    return None


def apply_entropy(x: int, y: int, gear: str, entropy_mod: ModuleType | None) -> tuple[int, int]:
    if gear in ("", "off"):
        return x, y
    if entropy_mod is not None:
        for name in ("jitter", "apply", "offset"):
            fn = getattr(entropy_mod, name, None)
            if callable(fn):
                try:
                    result = fn(x, y, gear)
                    if isinstance(result, (tuple, list)) and len(result) >= 2:
                        return int(result[0]), int(result[1])
                except Exception:
                    break
    mag = {"low": 2, "medium": 5, "high": 12}.get(gear, 0)
    if mag <= 0:
        return x, y
    return x + random.randint(-mag, mag), y + random.randint(-mag, mag)


def detect_gate(text: str) -> str | None:
    lowered = text.lower()
    for reason, hints in GATE_HINTS.items():
        if any(hint in lowered for hint in hints):
            return reason
    return None


def call_argv(script: str, args: list[str], timeout: int = 25) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, script, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def png_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def encode_screenshot(raw: Any) -> tuple[str, str, int, int]:
    if isinstance(raw, str) and os.path.isfile(raw):
        with open(raw, "rb") as handle:
            data = handle.read()
    elif isinstance(raw, (bytes, bytearray)):
        data = bytes(raw)
    elif isinstance(raw, str) and raw.strip():
        try:
            data = base64.b64decode(raw)
        except Exception:
            fail("OBSERVE_FAILED", "截图无法解码。")
    else:
        fail("OBSERVE_FAILED", "观察结果缺少截图。")
    mime = "image/png"
    if data[:2] == b"\xff\xd8":
        mime = "image/jpeg"
    size = png_size(data)
    width, height = size if size else (1, 1)
    return base64.b64encode(data).decode("ascii"), mime, width, height


def op_health(script: str, ios_act: ModuleType | None, entropy_mod: ModuleType | None) -> dict[str, Any]:
    script_found = os.path.isfile(script)
    payload: dict[str, Any] = {
        "ok": False,
        "scriptFound": script_found,
        "entropyModule": entropy_mod is not None,
        "deviceOnline": False,
        "wdaReady": False,
        "detail": "ios_act.py 不存在。" if not script_found else "尚未探测到设备。",
    }
    if not script_found:
        payload["error"] = {"code": "SCRIPT_MISSING", "message": "未找到 ios_act.py。"}
        return payload
    fn = first_callable(ios_act, ("health", "status", "check_health", "probe"))
    if fn is not None:
        result = fn()
        if isinstance(result, dict):
            payload.update({k: result[k] for k in result if k in payload or k in ("detail", "width", "height", "bundleId")})
            payload["ok"] = bool(result.get("ok", payload.get("deviceOnline") and payload.get("wdaReady")))
            if "deviceOnline" not in result and payload["ok"]:
                payload["deviceOnline"] = True
                payload["wdaReady"] = True
            payload["detail"] = str(result.get("detail") or ("M1 真机通道就绪。" if payload["ok"] else "M1 真机通道未就绪。"))
            return payload
        if result is True:
            payload.update(ok=True, deviceOnline=True, wdaReady=True, detail="M1 真机通道就绪。")
            return payload
    probed = call_argv(script, ["health", "--json"], timeout=20)
    if probed.returncode == 0 and probed.stdout.strip().startswith("{"):
        try:
            body = json.loads(probed.stdout)
            if isinstance(body, dict):
                payload.update(body)
                payload["scriptFound"] = True
                payload["ok"] = bool(body.get("ok", False))
                return payload
        except json.JSONDecodeError:
            pass
    payload["detail"] = "已找到 ios_act.py，但 health 探测未成功。"
    return payload


def op_observe(script: str, ios_act: ModuleType | None, include_tree: bool) -> dict[str, Any]:
    screenshot_fn = first_callable(ios_act, ("observe", "screenshot", "take_screenshot", "capture"))
    raw = None
    extra: dict[str, Any] = {}
    if screenshot_fn is not None:
        raw = screenshot_fn()
        if isinstance(raw, dict):
            extra = raw
            raw = raw.get("screenshot") or raw.get("png") or raw.get("path") or raw.get("base64")
    if raw is None:
        probed = call_argv(script, ["screenshot", "--json"], timeout=25)
        if probed.returncode != 0 or not probed.stdout.strip().startswith("{"):
            fail("OBSERVE_FAILED", "截图失败。")
        body = json.loads(probed.stdout)
        extra.update(body if isinstance(body, dict) else {})
        raw = extra.get("screenshotBase64") or extra.get("screenshot") or extra.get("png")
    b64, mime, width, height = encode_screenshot(raw)
    tree = extra.get("tree")
    if include_tree and tree is None:
        tree_fn = first_callable(ios_act, ("page_source", "dump_tree", "source", "ui_tree", "dump_xml"))
        if tree_fn is not None:
            tree = tree_fn()
    return {
        "ok": True,
        "width": int(extra.get("width") or width),
        "height": int(extra.get("height") or height),
        "screenshotBase64": extra.get("screenshotBase64") or b64,
        "screenshotMime": extra.get("screenshotMime") or mime,
        **({"tree": tree} if tree is not None else {}),
        **({"bundleId": extra["bundleId"]} if extra.get("bundleId") else {}),
        **({"notes": extra["notes"]} if extra.get("notes") else {}),
    }


def op_act(script: str, ios_act: ModuleType | None, entropy_mod: ModuleType | None, request: dict[str, Any]) -> dict[str, Any]:
    action = request.get("action")
    if not isinstance(action, dict) or "type" not in action:
        fail("INPUT_INVALID", "缺少 act.action。", exit_code=2)
    kind = action["type"]
    gear = str(request.get("entropy") or "off")
    if kind == "tap":
        x, y = apply_entropy(int(action["x"]), int(action["y"]), gear, entropy_mod)
        fn = first_callable(ios_act, ("tap", "click", "touch"))
        if fn is not None:
            fn(x, y)
        else:
            ran = call_argv(script, ["tap", str(x), str(y), "--entropy", gear])
            if ran.returncode != 0:
                fail("ACT_FAILED", "点击失败。")
        return {"ok": True, "notes": [f"tap:{x},{y}"]}
    if kind == "swipe":
        start = action["from"]
        end = action["to"]
        x1, y1 = apply_entropy(int(start["x"]), int(start["y"]), gear, entropy_mod)
        x2, y2 = apply_entropy(int(end["x"]), int(end["y"]), gear, entropy_mod)
        fn = first_callable(ios_act, ("swipe", "drag"))
        if fn is not None:
            fn(x1, y1, x2, y2)
        else:
            ran = call_argv(script, ["swipe", str(x1), str(y1), str(x2), str(y2), "--entropy", gear])
            if ran.returncode != 0:
                fail("ACT_FAILED", "滑动失败。")
        return {"ok": True, "notes": [f"swipe:{x1},{y1}->{x2},{y2}"]}
    if kind == "type":
        text = str(action.get("text") or "")
        fn = first_callable(ios_act, ("type_text", "type", "send_keys", "input_text"))
        if fn is not None:
            fn(text)
        else:
            ran = call_argv(script, ["type", text])
            if ran.returncode != 0:
                fail("ACT_FAILED", "输入失败。")
        return {"ok": True, "notes": [f"type:{len(text)}"]}
    if kind == "launch":
        bundle = str(action.get("bundleId") or "")
        if not bundle:
            fail("INPUT_INVALID", "launch 缺少 bundleId。", exit_code=2)
        fn = first_callable(ios_act, ("launch", "launch_app", "activate", "activate_app"))
        if fn is not None:
            fn(bundle)
        else:
            ran = call_argv(script, ["launch", bundle])
            if ran.returncode != 0:
                fail("ACT_FAILED", "启动应用失败。")
        return {"ok": True, "notes": [f"launch:{bundle}"]}
    if kind == "clipboard":
        op = action.get("op")
        if op == "get":
            fn = first_callable(ios_act, ("clipboard_get", "get_clipboard"))
            text = fn() if fn is not None else ""
            if fn is None:
                ran = call_argv(script, ["clipboard-get"])
                text = ran.stdout.strip() if ran.returncode == 0 else ""
            return {"ok": True, "clipboardText": str(text or "")}
        if op == "set":
            text = str(action.get("text") or "")
            fn = first_callable(ios_act, ("clipboard_set", "set_clipboard"))
            if fn is not None:
                fn(text)
            else:
                ran = call_argv(script, ["clipboard-set", text])
                if ran.returncode != 0:
                    fail("ACT_FAILED", "写入剪贴板失败。")
            return {"ok": True}
        fail("INPUT_INVALID", "clipboard.op 必须是 get 或 set。", exit_code=2)
    fail("INPUT_INVALID", f"不支持的动作 {kind}。", exit_code=2)


def main() -> None:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--script", required=True, help="ios_act.py 的绝对路径")
    parser.add_argument("--udid", default="")
    parser.add_argument("--host", default="m1")
    parser.add_argument("--entropy", default="medium")
    parser.add_argument("--json", action="store_true", default=True)
    args = parser.parse_args()
    try:
        raw = sys.stdin.read()
        request = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        fail("INPUT_INVALID", "stdin 不是 JSON。", exit_code=2)
    if not isinstance(request, dict) or request.get("op") not in {"health", "observe", "act"}:
        fail("INPUT_INVALID", "请求缺少有效的 op。", exit_code=2)
    request.setdefault("v", PROTOCOL)
    request.setdefault("entropy", args.entropy)
    os.environ.setdefault("IOS_UDID", args.udid)
    os.environ.setdefault("PA_DEVICE_UDID", args.udid)
    os.environ.setdefault("PA_DEVICE_HOST", args.host)
    script = os.path.abspath(args.script)
    scripts_dir = os.path.dirname(script)
    if scripts_dir and scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    ios_act = load_module(script, "ios_act")
    entropy_mod = load_module(os.path.join(scripts_dir, "human_entropy.py"), "human_entropy")
    try:
        op = request["op"]
        if op == "health":
            emit(op_health(script, ios_act, entropy_mod))
        if op == "observe":
            emit(op_observe(script, ios_act, bool(request.get("includeTree"))))
        emit(op_act(script, ios_act, entropy_mod, request))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — 桥接层必须把任意脚本异常折成固定错误码
        reason = detect_gate(f"{exc}\n{traceback.format_exc()}")
        if reason:
            fail("HUMAN_GATE", "需要人工确认后才能继续。", reason=reason, exit_code=2)
        fail("ACT_FAILED" if request.get("op") == "act" else "OBSERVE_FAILED", "设备通道执行失败。")


if __name__ == "__main__":
    main()
