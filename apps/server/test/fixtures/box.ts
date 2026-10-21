/** box 测试共用的录制输出。 */

/** 与 L0 实测一致的安全容器：只发布 127.0.0.1:47830→6080，自定义 seccomp + no-new-privileges，只挂 pa-box-home:/home。 */
export function safeInspect(overrides: Record<string, unknown> = {}, hostConfig: Record<string, unknown> = {}) {
  return JSON.stringify({
    State: { Status: 'running', Running: true },
    Config: { Image: 'personal-agent/pa-box:0.1' },
    HostConfig: {
      Memory: 3.5 * 1024 ** 3, Privileged: false, CapAdd: null, NetworkMode: 'bridge', PidMode: '', IpcMode: 'private',
      SecurityOpt: ['seccomp={"defaultAction":"SCMP_ACT_ERRNO"}', 'no-new-privileges'],
      PortBindings: { '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '47830' }] },
      ...hostConfig,
    },
    Mounts: [{ Type: 'volume', Name: 'pa-box-home', Source: '/var/lib/docker/volumes/pa-box-home/_data', Destination: '/home' }],
    ...overrides,
  });
}
