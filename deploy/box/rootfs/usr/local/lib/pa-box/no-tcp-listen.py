"""校验给定进程没有任何处于 LISTEN 状态的 TCP socket（IPv4 / IPv6）。

用法：python3 -I no-tcp-listen.py <pid> [<pid>...]
退出码：0 = 没有 TCP 监听；1 = 至少一个进程在监听 TCP；2 = 参数或读取错误。

原理：/proc/net/tcp{,6} 中状态 0A 为 LISTEN，记录其 socket inode；
再对比 /proc/<pid>/fd 下指向 socket:[inode] 的链接。需要 root（读取其他用户的 fd）。
"""
import os
import sys


def listening_inodes():
    inodes = set()
    for name in ('/proc/net/tcp', '/proc/net/tcp6'):
        try:
            with open(name, encoding='ascii') as handle:
                next(handle, None)
                for line in handle:
                    fields = line.split()
                    if len(fields) > 9 and fields[3] == '0A':
                        inodes.add(fields[9])
        except FileNotFoundError:
            continue
    return inodes


def socket_inodes(pid):
    found = set()
    base = f'/proc/{pid}/fd'
    for entry in os.listdir(base):
        try:
            target = os.readlink(os.path.join(base, entry))
        except OSError:
            continue
        if target.startswith('socket:[') and target.endswith(']'):
            found.add(target[8:-1])
    return found


def main(argv):
    pids = argv[1:]
    if not pids or not all(pid.isdigit() for pid in pids):
        return 2
    listening = listening_inodes()
    try:
        for pid in pids:
            if socket_inodes(pid) & listening:
                return 1
    except OSError:
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
