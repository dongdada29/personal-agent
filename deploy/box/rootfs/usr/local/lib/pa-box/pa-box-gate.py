"""pa-box-gate：box 内唯一的 TCP 监听（0.0.0.0:6080，用户 pa-gate）。

为什么需要它（L0 问题 2）：容器内所有 bot 共享网络命名空间，任何 TCP 端口都能被其他 bot 连上，
而 VncAuth 口令只有 8 位 DES，形同虚设。所以桌面的 Xvnc 只监听 0660 的 unix socket，
而网关是唯一入口：

  客户端 → "PA-BOX-GATE 1 dN <43 字符令牌>\\n"
  网关   → 校验令牌（每桌面一个、由 root 写在 /run/pa-box/gate/dN.token、最长 120 秒内有效）
         → 连接 /run/pa-box/dN/vnc.sock，回复 "OK\\n"，之后双向透传 RFB 字节
         → 失败回复 "ERR <CODE>\\n" 并关闭

宿主侧只发布到 127.0.0.1，令牌只有 server（经 `docker exec -i pa-box-ctl start`）知道，
所以桌面只能经 server 的鉴权代理访问。网关从不记录令牌。
"""
import asyncio
import hmac
import os
import re
import sys
import time

# 环境变量覆盖只用于仓库里的集成测试（在临时目录、127.0.0.1 随机端口上运行）。
RUN_DIR = os.environ.get('PA_BOX_RUN_DIR', '/run/pa-box')
LISTEN_HOST = os.environ.get('PA_BOX_GATE_HOST', '0.0.0.0')
LISTEN_PORT = int(os.environ.get('PA_BOX_GATE_PORT', '6080'))
TOKEN_DIR = os.path.join(RUN_DIR, 'gate')
SOCKET_PATH = os.path.join(RUN_DIR, '{desktop}', 'vnc.sock')
# 令牌在写入后 120 秒内可用于建立新连接；已建立的连接不受影响。server 每次打开桌面都会轮换令牌。
TOKEN_TTL_SECONDS = 120
PREAMBLE = re.compile(rb'^PA-BOX-GATE 1 (d[1-9]) ([A-Za-z0-9_-]{43})\n$')
PREAMBLE_TIMEOUT = 5
MAX_CONNECTIONS = 32
CHUNK = 64 * 1024

active = 0


def log(message):
    print(f'pa-box-gate: {message}', file=sys.stderr, flush=True)


def expected_token(desktop):
    path = os.path.join(TOKEN_DIR, f'{desktop}.token')
    try:
        stat = os.stat(path)
        if time.time() - stat.st_mtime > TOKEN_TTL_SECONDS:
            return None
        with open(path, 'rb') as handle:
            value = handle.read(64).strip()
    except OSError:
        return None
    return value if re.fullmatch(rb'[A-Za-z0-9_-]{43}', value) else None


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(CHUNK)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def refuse(writer, code, delay=0.0):
    if delay:
        await asyncio.sleep(delay)
    try:
        writer.write(f'ERR {code}\n'.encode('ascii'))
        await writer.drain()
    except ConnectionError:
        pass
    writer.close()


async def handle(reader, writer):
    global active
    if active >= MAX_CONNECTIONS:
        await refuse(writer, 'BUSY')
        return
    active += 1
    try:
        try:
            line = await asyncio.wait_for(reader.readline(), PREAMBLE_TIMEOUT)
        except (asyncio.TimeoutError, ValueError, ConnectionError):
            await refuse(writer, 'BAD_PREAMBLE')
            return
        match = PREAMBLE.match(line)
        if not match:
            await refuse(writer, 'BAD_PREAMBLE', 0.5)
            return
        desktop = match.group(1).decode('ascii')
        expected = expected_token(desktop)
        if expected is None or not hmac.compare_digest(expected, match.group(2)):
            log(f'{desktop}: rejected')
            await refuse(writer, 'UNAUTHORIZED', 0.5)
            return
        try:
            upstream_reader, upstream_writer = await asyncio.open_unix_connection(SOCKET_PATH.format(desktop=desktop))
        except OSError:
            await refuse(writer, 'DESKTOP_DOWN')
            return
        writer.write(b'OK\n')
        await writer.drain()
        log(f'{desktop}: stream opened')
        await asyncio.gather(pipe(reader, upstream_writer), pipe(upstream_reader, writer))
        log(f'{desktop}: stream closed')
    finally:
        active -= 1


async def main():
    server = await asyncio.start_server(handle, LISTEN_HOST, LISTEN_PORT, limit=256)
    log(f'listening on {server.sockets[0].getsockname()[1]}')
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    asyncio.run(main())
