import { describe, expect, it } from 'vitest';
import type { CommandOptions, CommandResult, CommandRunner } from '../src/box/command.js';
import { commandEnvironment } from '../src/box/command.js';
import { BOX_QUOTA, BoxError, boxRunArgs } from '../src/box/host-adapter.js';
import { ColimaAdapter, LinuxContainerAdapter, Wsl2Adapter, colimaStartArgs } from '../src/box/local-adapters.js';
import { CloudSshAdapter, sshInvocation } from '../src/box/cloud-adapters.js';
import { safeInspect } from './fixtures/box.js';

interface Call { file: string; args: string[]; options?: CommandOptions }
type Responder = (file: string, args: string[], options?: CommandOptions) => Partial<CommandResult> | undefined;

/** 记录所有调用并按规则回放输出；未匹配的命令一律失败（code 1）。 */
function fakeRunner(responder: Responder): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (file, args, options) => {
    calls.push({ file, args, options });
    const result = responder(file, args, options);
    return { code: 1, stdout: '', stderr: '', ...(result ?? {}) };
  };
  return { run, calls };
}

const ok = (stdout = ''): Partial<CommandResult> => ({ code: 0, stdout });
const token = 'A'.repeat(43);
const ctlStatus = '{"v":1,"max":3,"desktops":[{"id":"d1","running":false},{"id":"d2","running":false},{"id":"d3","running":false}]}';
const paBoxRunning = '{"name":"pa-box","status":"Running","arch":"aarch64","cpus":2,"memory":4294967296,"disk":42949672960,"runtime":"docker"}';

/** 一台“健康”的 Mac：colima 0.10.3、pa-box profile 运行中、容器安全且在运行、默认上下文是 orbstack。 */
function healthyMac(overrides: Responder = () => undefined) {
  return fakeRunner((file, args, options) => {
    const override = overrides(file, args, options);
    if (override) return override;
    const line = [file, ...args].join(' ');
    if (line === 'colima version') return ok('colima version 0.10.3\n');
    if (line === 'colima list --json') return ok(`${paBoxRunning}\n`);
    if (line === '/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level') return ok('1\n');
    if (line === 'docker context show') return ok('orbstack\n');
    if (line === 'colima stop pa-box') return ok();
    if (line.startsWith('docker --context colima-pa-box inspect pa-box')) return ok(safeInspect());
    if (line.startsWith('docker --context colima-pa-box stats')) return ok('{"CPUPerc":"1.5%","MemUsage":"472MiB / 3.5GiB"}');
    if (line === 'docker --context colima-pa-box exec pa-box /usr/local/sbin/pa-box-ctl status') return ok(ctlStatus);
    if (line.startsWith('docker --context colima-pa-box exec -i pa-box /usr/local/sbin/pa-box-ctl start')) return ok();
    if (line.startsWith('/usr/sbin/lsof')) return ok('p1\nn127.0.0.1:47830\n');
    return undefined;
  });
}

const dockerCalls = (calls: Call[]) => calls.filter(call => call.file === 'docker');

describe('Colima adapter (macOS)', () => {
  it('creates the profile exactly as measured: vz, 2 vCPU / 4GiB / 40GiB, --activate=false --mount none', () => {
    expect(colimaStartArgs(false, 'arm64')).toEqual(['start', 'pa-box', '--vm-type', 'vz', '--runtime', 'docker', '--cpus', '2', '--memory', '4', '--disk', '40',
      '--arch', 'aarch64', '--activate=false', '--mount', 'none']);
    expect(colimaStartArgs(false, 'x64')).toContain('x86_64');
    expect(colimaStartArgs(true)).toEqual(['start', 'pa-box', '--activate=false', '--mount', 'none']);
  });

  it('never touches the default docker context or the default colima profile', async () => {
    const { run, calls } = healthyMac();
    const adapter = new ColimaAdapter({ run, arch: 'arm64', seccompProfile: () => '/opt/pa/pa-box-seccomp.json' });
    const snapshot = await adapter.status();
    expect(snapshot).toMatchObject({ host: { state: 'running', profile: 'pa-box' }, gateReady: true, memoryPressure: 'normal' });
    expect(snapshot.desktops).toHaveLength(3);
    await adapter.perform('stop_vm');
    for (const call of dockerCalls(calls)) {
      // 唯一允许不带 --context 的 docker 调用是只读的 `docker context show`。
      if (call.args[0] === 'context') expect(call.args).toEqual(['context', 'show']);
      else expect(call.args.slice(0, 2)).toEqual(['--context', 'colima-pa-box']);
    }
    for (const call of calls.filter(item => item.file === 'colima' && ['start', 'stop', 'delete'].includes(item.args[0]))) {
      expect(call.args[1]).toBe('pa-box');
    }
    expect(calls.some(call => call.args.includes('default'))).toBe(false);
  });

  it('starts an existing profile with --activate=false --mount none and leaves orbstack as the current context', async () => {
    const { run, calls } = healthyMac((file, args) => (file === 'colima' && args[0] === 'start' ? ok() : undefined));
    await new ColimaAdapter({ run, arch: 'arm64', seccompProfile: () => '/x' }).perform('start_vm');
    expect(calls.find(call => call.file === 'colima' && call.args[0] === 'start')?.args).toEqual(['start', 'pa-box', '--activate=false', '--mount', 'none']);
    expect(calls.some(call => call.file === 'docker' && call.args[0] === 'context' && call.args[1] === 'use')).toBe(false);
  });

  it('restores the previous docker context if a colima start ever changes it', async () => {
    let started = false;
    const { run, calls } = healthyMac((file, args) => {
      if (file === 'colima' && args[0] === 'start') { started = true; return ok(); }
      if (file === 'docker' && args.join(' ') === 'context show') return ok(started ? 'colima-pa-box\n' : 'orbstack\n');
      if (file === 'docker' && args[0] === 'context' && args[1] === 'use') return ok();
      return undefined;
    });
    await new ColimaAdapter({ run, arch: 'arm64', seccompProfile: () => '/x' }).perform('start_vm');
    expect(calls.find(call => call.file === 'docker' && call.args[1] === 'use')?.args).toEqual(['context', 'use', 'orbstack']);
  });

  it('refuses old colima without --activate instead of retrying without it', async () => {
    const { run, calls } = healthyMac((file, args) => (file === 'colima' && args[0] === 'start' ? { code: 1, stderr: 'Error: unknown flag: --activate' } : undefined));
    await expect(new ColimaAdapter({ run, seccompProfile: () => '/x' }).perform('start_vm')).rejects.toMatchObject({ code: 'BOX_COLIMA_TOO_OLD' });
    expect(calls.filter(call => call.file === 'colima' && call.args[0] === 'start')).toHaveLength(1);
  });

  it('creates the container with the measured limits, loopback-only gate, seccomp and no-new-privileges', () => {
    const args = boxRunArgs({ seccompProfile: '/opt/pa/pa-box-seccomp.json' });
    const pairs = (flag: string) => args.flatMap((value, index) => (value === flag ? [args[index + 1]] : []));
    expect(pairs('--memory')).toEqual(['3.5g']);
    expect(pairs('--memory-swap')).toEqual(['3.5g']);
    expect(pairs('--cpus')).toEqual(['2']);
    expect(pairs('--shm-size')).toEqual(['1g']);
    expect(pairs('--security-opt')).toEqual(['seccomp=/opt/pa/pa-box-seccomp.json', 'no-new-privileges']);
    expect(pairs('-p')).toEqual(['127.0.0.1:47830:6080']);
    expect(pairs('-v')).toEqual(['pa-box-home:/home']);
    expect(args).not.toContain('--privileged');
    expect(args.some(arg => /no-sandbox|cap-add|docker\.sock/.test(arg))).toBe(false);
    expect(() => boxRunArgs({ seccompProfile: '' })).toThrow(BoxError);
  });

  it('verifies a freshly created container and deletes it if the publish is not loopback-only', async () => {
    let created = false;
    const { run, calls } = healthyMac((file, args) => {
      const line = args.join(' ');
      if (line.startsWith('--context colima-pa-box inspect pa-box')) {
        return created ? ok(safeInspect({}, { PortBindings: { '6080/tcp': [{ HostIp: '0.0.0.0', HostPort: '47830' }] } })) : { code: 1, stderr: 'Error: No such object: pa-box' };
      }
      if (line.startsWith('--context colima-pa-box image inspect')) return ok('sha256:abc');
      if (line.startsWith('--context colima-pa-box run')) { created = true; return ok('id'); }
      if (line.startsWith('--context colima-pa-box rm -f pa-box')) return ok();
      return undefined;
    });
    const adapter = new ColimaAdapter({ run, seccompProfile: () => '/opt/pa/pa-box-seccomp.json' });
    await expect(adapter.perform('start_container')).rejects.toMatchObject({ code: 'BOX_CONTAINER_UNSAFE' });
    expect(calls.some(call => call.args.join(' ') === '--context colima-pa-box rm -f pa-box')).toBe(true);
    // 只删除容器，不删除卷或镜像。
    expect(calls.some(call => call.args.includes('volume') || call.args.includes('rmi'))).toBe(false);
  });

  it('refuses to start an existing unsafe container', async () => {
    const { run, calls } = healthyMac((_file, args) => (args.join(' ').startsWith('--context colima-pa-box inspect')
      ? ok(safeInspect({ State: { Status: 'exited' } }, { Privileged: true })) : undefined));
    await expect(new ColimaAdapter({ run, seccompProfile: () => '/x' }).perform('start_container')).rejects.toMatchObject({ code: 'BOX_CONTAINER_UNSAFE' });
    expect(calls.some(call => call.args.includes('start') && call.file === 'docker')).toBe(false);
  });

  it('marks the gate unavailable when the running container fails safety checks', async () => {
    const { run } = healthyMac((_file, args) => (args.join(' ').startsWith('--context colima-pa-box inspect')
      ? ok(safeInspect({}, { PortBindings: { '6080/tcp': [{ HostIp: '', HostPort: '47830' }] } })) : undefined));
    const snapshot = await new ColimaAdapter({ run, seccompProfile: () => '/x' }).status();
    expect(snapshot.gateReady).toBe(false);
    expect(snapshot.desktops).toEqual([]);
    expect(snapshot.container.detail).toMatch(/安全校验/);
  });

  it('passes the per-desktop token on stdin, never in argv', async () => {
    const { run, calls } = healthyMac();
    await new ColimaAdapter({ run, seccompProfile: () => '/x' }).desktop('start', 'd2', token);
    const call = calls.find(item => item.args.includes('pa-box-ctl') || item.args.includes('/usr/local/sbin/pa-box-ctl'))!;
    expect(call.args).toEqual(['--context', 'colima-pa-box', 'exec', '-i', 'pa-box', '/usr/local/sbin/pa-box-ctl', 'start', 'd2']);
    expect(call.options?.input).toBe(`${token}\n`);
    expect(calls.some(item => item.args.some(arg => arg.includes(token)))).toBe(false);
  });

  it('stops the container and refuses streaming if the host listens on a non-loopback address', async () => {
    const { run, calls } = healthyMac((file, args) => {
      if (file === '/usr/sbin/lsof') return ok('p1\nn127.0.0.1:47830\nn*:47830\n');
      if (args.join(' ') === '--context colima-pa-box stop --time 20 pa-box') return ok();
      return undefined;
    });
    await expect(new ColimaAdapter({ run, seccompProfile: () => '/x' }).openGate()).rejects.toMatchObject({ code: 'BOX_PORT_EXPOSED' });
    expect(calls.some(call => call.args.join(' ') === '--context colima-pa-box stop --time 20 pa-box')).toBe(true);
  });

  it('reports not installed and not configured states gracefully', async () => {
    const missing = fakeRunner(file => (file === 'colima' ? { code: null, notFound: true } : undefined));
    expect((await new ColimaAdapter({ run: missing.run }).status()).host).toMatchObject({ state: 'not_installed', installHint: 'brew install colima docker' });
    const unconfigured = healthyMac((file, args) => (file === 'colima' && args[0] === 'list' ? ok('{"name":"default","status":"Running"}\n') : undefined));
    const adapter = new ColimaAdapter({ run: unconfigured.run });
    const snapshot = await adapter.status();
    expect(snapshot.host.state).toBe('not_configured');
    expect(adapter.actions(snapshot)).toEqual(['start_vm']);
  });

  it('reports macOS memory pressure warn from sysctl', async () => {
    const { run } = healthyMac(file => (file === '/usr/sbin/sysctl' ? ok('2\n') : undefined));
    expect((await new ColimaAdapter({ run, seccompProfile: () => '/x' }).status()).memoryPressure).toBe('warn');
  });
});

describe('WSL2, Linux and SSH adapters', () => {
  it('detects the pa-box WSL2 distro and drives docker inside it', async () => {
    const { run, calls } = fakeRunner((file, args) => {
      const line = [file, ...args].join(' ');
      if (line === 'wsl.exe -l -v') return ok('  NAME      STATE           VERSION\n* Ubuntu    Stopped         2\n  pa-box    Running         2\n');
      if (line.startsWith('wsl.exe -d pa-box --exec docker inspect')) return ok(safeInspect());
      if (line.startsWith('wsl.exe -d pa-box --exec docker exec pa-box')) return ok(ctlStatus);
      if (line === 'wsl.exe -d pa-box --exec cat /proc/pressure/memory') return ok('some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
      return undefined;
    });
    const snapshot = await new Wsl2Adapter({ run }).status();
    expect(snapshot).toMatchObject({ host: { state: 'running', profile: 'pa-box' }, gateReady: true, memoryPressure: 'normal' });
    expect(calls.find(call => call.args[0] === '-l')?.options?.encoding).toBe('auto');
  });

  it('reports WSL not installed / distro missing', async () => {
    expect((await new Wsl2Adapter({ run: fakeRunner(() => ({ code: null, notFound: true })).run }).status()).host.state).toBe('not_installed');
    const noDistro = fakeRunner(() => ok('  NAME      STATE           VERSION\n* Ubuntu    Running         2\n'));
    expect((await new Wsl2Adapter({ run: noDistro.run }).status()).host.state).toBe('not_configured');
  });

  it('uses podman first on Linux with the bundled seccomp profile and host PSI', async () => {
    const { run, calls } = fakeRunner((file, args) => {
      if (file === 'podman' && args[0] === 'version') return ok('5.0.1\n');
      if (file === 'podman' && args[0] === 'inspect') return { code: 1, stderr: 'Error: no container with name or ID "pa-box" found' };
      if (file === 'podman' && args[0] === 'image') return ok('id');
      if (file === 'podman' && args[0] === 'run') return ok('id');
      return undefined;
    });
    const adapter = new LinuxContainerAdapter({ run, seccompProfile: () => '/srv/pa/pa-box-seccomp.json', readPressure: async () => 'some avg10=11.00 avg60=0 avg300=0 total=1\n' });
    const snapshot = await adapter.status();
    expect(snapshot).toMatchObject({ host: { state: 'running', runtime: 'podman' }, container: { state: 'missing' }, memoryPressure: 'warn' });
    await expect(adapter.perform('start_container')).rejects.toMatchObject({ code: 'BOX_CONTAINER_UNSAFE' });
    const runCall = calls.find(call => call.args[0] === 'run')!;
    expect(runCall.file).toBe('podman');
    expect(runCall.args).toContain('seccomp=/srv/pa/pa-box-seccomp.json');
  });

  it('quotes remote ssh commands and keeps the token on stdin', async () => {
    expect(sshInvocation('pa-cloud', ['docker', 'inspect', 'pa-box', '--format', '{{json .}}'])).toEqual(['ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '--', 'pa-cloud',
      "docker inspect pa-box --format '{{json .}}'"]]);
    const { run, calls } = fakeRunner(() => ok());
    await new CloudSshAdapter('pa-cloud', run).desktop('start', 'd1', token);
    expect(calls[0].args.at(-1)).toBe('docker exec -i pa-box /usr/local/sbin/pa-box-ctl start d1');
    expect(calls[0].options?.input).toBe(`${token}\n`);
  });

  it('maps ssh failure to offline', async () => {
    const { run } = fakeRunner(() => ({ code: 255 }));
    expect((await new CloudSshAdapter('pa-cloud', run).status()).host.state).toBe('offline');
  });

  it('maps pa-box-ctl exit codes to fixed errors', async () => {
    const limit = fakeRunner(() => ({ code: 66 }));
    await expect(new CloudSshAdapter('pa-cloud', limit.run).desktop('start', 'd3', token)).rejects.toMatchObject({ code: 'BOX_DESKTOP_LIMIT' });
    const unsafe = fakeRunner(() => ({ code: 71 }));
    await expect(new CloudSshAdapter('pa-cloud', unsafe.run).desktop('start', 'd3', token)).rejects.toMatchObject({ code: 'BOX_DESKTOP_UNSAFE' });
    await expect(new CloudSshAdapter('pa-cloud', limit.run).desktop('start', 'd3', 'short')).rejects.toMatchObject({ code: 'BOX_INPUT_INVALID' });
    await expect(new CloudSshAdapter('pa-cloud', limit.run).desktop('start', 'd4', token)).rejects.toMatchObject({ code: 'BOX_DESKTOP_NOT_FOUND' });
  });
});

describe('host command environment', () => {
  it('drops variables that redirect docker or make bash read user startup files', () => {
    const env = commandEnvironment({ PATH: '/usr/bin', DOCKER_HOST: 'tcp://x', DOCKER_CONTEXT: 'orbstack', BASH_ENV: '/home/u/.bashrc', ENV: '/home/u/.shrc',
      NODE_OPTIONS: '--require x', ELECTRON_RUN_AS_NODE: '1', HOME: '/home/u' }, 'darwin');
    for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'BASH_ENV', 'ENV', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) expect(env[key], key).toBeUndefined();
    expect(env.PATH?.split(':')).toContain('/opt/homebrew/bin');
    expect(env.HOME).toBe('/home/u');
  });

  it('keeps the gate host port fixed', () => {
    expect(BOX_QUOTA.gateHostPort).toBe(47830);
  });
});
