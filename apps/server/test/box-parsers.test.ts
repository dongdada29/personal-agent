import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boxSafetyIssues, loopbackListenAddress, parseColimaList, parseColimaVersion, parseCtlStatus, parseDockerInspect, parseDockerStats,
  parseLinuxMemoryPressure, parseLsofListenAddresses, parseMacMemoryPressure, parseSize, parseWslList, type ContainerInspection,
} from '../src/box/parsers.js';
import { decodeCommandOutput } from '../src/box/command.js';
import { admitDesktop, desktopPolicyFromEnv, DEFAULT_DESKTOP_POLICY, DESKTOP_BUDGET_BYTES } from '../src/box/policy.js';
import type { BoxSnapshot } from '../src/box/host-adapter.js';
import { safeInspect } from './fixtures/box.js';

const expectation = { gateHostPort: 47830, volume: 'pa-box-home', volumeDestination: '/home' };
const issuesOf = (stdout: string) => boxSafetyIssues(parseDockerInspect(stdout) as ContainerInspection, expectation);

describe('colima / docker / wsl output parsing', () => {
  it('parses colima 0.10 version and JSON-lines list output', () => {
    expect(parseColimaVersion('colima version 0.10.3\ngit commit: abc\n')).toBe('0.10.3');
    const list = [
      JSON.stringify({ name: 'default', status: 'Stopped', arch: 'aarch64', cpus: 4, memory: 8589934592, disk: 107374182400, runtime: 'docker' }),
      'WARN[0000] some warning line',
      JSON.stringify({ name: 'pa-box', status: 'Running', arch: 'aarch64', cpus: 2, memory: 4294967296, disk: 42949672960, runtime: 'docker', address: '' }),
    ].join('\n');
    const profiles = parseColimaList(list);
    expect(profiles.map(item => item.name)).toEqual(['default', 'pa-box']);
    expect(profiles[1]).toMatchObject({ state: 'running', cpus: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 40 * 1024 ** 3, arch: 'aarch64' });
    // 旧版本以 GiB 数字输出。
    expect(parseColimaList('[{"name":"pa-box","status":"Stopped","memory":4,"disk":40}]')[0]).toMatchObject({ state: 'stopped', memoryBytes: 4 * 1024 ** 3 });
  });

  it('parses docker stats sizes and percentages', () => {
    expect(parseSize('1.47GiB')).toBe(Math.round(1.47 * 1024 ** 3));
    expect(parseSize('884MiB')).toBe(884 * 1024 ** 2);
    expect(parseSize('12kB')).toBe(12_000);
    expect(parseSize('weird')).toBeUndefined();
    expect(parseDockerStats('{"CPUPerc":"12.04%","MemUsage":"1.47GiB / 3.5GiB"}')).toEqual({ cpuPercent: 12.04, memoryUsedBytes: Math.round(1.47 * 1024 ** 3), memoryLimitBytes: 3.5 * 1024 ** 3 });
  });

  it('parses localized UTF-16LE `wsl.exe -l -v` output by column position', () => {
    const text = '  名称      状态           版本\r\n* Ubuntu    Running         2\r\n  pa-box    Stopped         2\r\n';
    const decoded = decodeCommandOutput(Buffer.from(`\uFEFF${text}`, 'utf16le'), 'auto');
    expect(parseWslList(decoded)).toEqual([
      { name: 'Ubuntu', isDefault: true, version: 2, state: 'running' },
      { name: 'pa-box', isDefault: false, version: 2, state: 'stopped' },
    ]);
  });

  it('parses pa-box-ctl status strictly', () => {
    expect(parseCtlStatus('{"v":1,"max":3,"desktops":[{"id":"d1","running":true},{"id":"d2","running":false},{"id":"d3","running":false}]}\n'))
      .toEqual({ max: 3, desktops: [{ id: 'd1', running: true }, { id: 'd2', running: false }, { id: 'd3', running: false }] });
    expect(parseCtlStatus('{"v":2,"max":3,"desktops":[]}')).toBeUndefined();
    expect(parseCtlStatus('{"v":1,"max":3,"desktops":[{"id":"d4","running":true}]}')).toBeUndefined();
    expect(parseCtlStatus('{"v":1,"max":9,"desktops":[]}')).toBeUndefined();
    expect(parseCtlStatus('not json')).toBeUndefined();
  });

  it('maps macOS and Linux memory pressure', () => {
    expect(['1', '2', '4', '0'].map(parseMacMemoryPressure)).toEqual(['normal', 'warn', 'critical', 'unknown']);
    expect(parseLinuxMemoryPressure('some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')).toBe('normal');
    expect(parseLinuxMemoryPressure('some avg10=12.50 avg60=3.00 avg300=1.00 total=99\n')).toBe('warn');
    expect(parseLinuxMemoryPressure('some avg10=55.10 avg60=3.00 avg300=1.00 total=99\n')).toBe('critical');
    expect(parseLinuxMemoryPressure('')).toBe('unknown');
  });

  it('reads host listen addresses from lsof -F output', () => {
    const loopbackOnly = 'p4242\ncssh\nf9\nn127.0.0.1:47830\n';
    const exposed = 'p4242\ncssh\nf9\nn127.0.0.1:47830\nf10\nn*:47830\n';
    expect(parseLsofListenAddresses(loopbackOnly, 47830).every(loopbackListenAddress)).toBe(true);
    expect(parseLsofListenAddresses(exposed, 47830)).toEqual(['127.0.0.1', '*']);
    expect(parseLsofListenAddresses(exposed, 47830).every(loopbackListenAddress)).toBe(false);
  });
});

describe('box container safety verification', () => {
  it('accepts the L0-hardened container', () => {
    expect(issuesOf(safeInspect())).toEqual([]);
    // podman 以数组输出，并且 seccomp 只出现在 SeccompProfilePath。
    expect(issuesOf(`[${safeInspect({ SeccompProfilePath: '/etc/pa-box/seccomp.json' }, { SecurityOpt: ['no-new-privileges'] })}]`)).toEqual([]);
  });

  it('flags any publish that is not 127.0.0.1 (Colima forwards guest 0.0.0.0 to every host NIC)', () => {
    expect(issuesOf(safeInspect({}, { PortBindings: { '6080/tcp': [{ HostIp: '', HostPort: '47830' }] } }))).toContain('PORT_NOT_LOOPBACK');
    expect(issuesOf(safeInspect({}, { PortBindings: { '6080/tcp': [{ HostIp: '0.0.0.0', HostPort: '47830' }] } }))).toContain('PORT_NOT_LOOPBACK');
    expect(issuesOf(safeInspect({}, { PortBindings: { '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '47830' }, { HostIp: '::', HostPort: '47830' }] } }))).toContain('PORT_NOT_LOOPBACK');
  });

  it('flags extra published ports, including the old per-desktop websockify ports', () => {
    expect(issuesOf(safeInspect({}, { PortBindings: {
      '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '47830' }], '6081/tcp': [{ HostIp: '127.0.0.1', HostPort: '6081' }],
    } }))).toEqual(['UNEXPECTED_PORT']);
    expect(issuesOf(safeInspect({}, { PortBindings: {} }))).toEqual(['GATE_PORT_MISSING']);
  });

  it('flags privilege, capability, seccomp, no-new-privileges, namespace and mount violations', () => {
    expect(issuesOf(safeInspect({}, { Privileged: true }))).toContain('PRIVILEGED');
    expect(issuesOf(safeInspect({}, { CapAdd: ['SYS_ADMIN'] }))).toContain('CAP_ADD');
    expect(issuesOf(safeInspect({}, { SecurityOpt: ['seccomp=unconfined', 'no-new-privileges'] }))).toContain('NO_SECCOMP');
    expect(issuesOf(safeInspect({}, { SecurityOpt: ['no-new-privileges'] }))).toContain('NO_SECCOMP');
    expect(issuesOf(safeInspect({}, { SecurityOpt: ['seccomp={}'] }))).toContain('NO_NEW_PRIVILEGES_MISSING');
    expect(issuesOf(safeInspect({}, { NetworkMode: 'host' }))).toContain('HOST_NAMESPACE');
    expect(issuesOf(safeInspect({}, { PidMode: 'host' }))).toContain('HOST_NAMESPACE');
    expect(issuesOf(safeInspect({ Mounts: [{ Type: 'bind', Source: '/Users/someone', Destination: '/host' }] }))).toContain('UNEXPECTED_MOUNT');
    expect(issuesOf(safeInspect({ Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }] }))).toContain('UNEXPECTED_MOUNT');
  });
});

describe('desktop admission policy (L0 measurements)', () => {
  const snapshot = (overrides: Partial<BoxSnapshot> = {}): BoxSnapshot => ({
    host: { state: 'running' }, gateReady: true, memoryPressure: 'normal',
    container: { state: 'running', name: 'pa-box', memoryUsedBytes: 500 * 1024 ** 2, memoryLimitBytes: 3.5 * 1024 ** 3 },
    desktops: [{ id: 'd1', running: false }, { id: 'd2', running: false }, { id: 'd3', running: false }],
    ...overrides,
  });

  it('defaults to 0.7GB per desktop, 2 concurrent, hard maximum 3, 15 minute idle stop', () => {
    expect(DEFAULT_DESKTOP_POLICY).toEqual({ concurrent: 2, max: 3, budgetBytesPerDesktop: DESKTOP_BUDGET_BYTES, idleStopMinutes: 15 });
    expect(DESKTOP_BUDGET_BYTES).toBe(Math.round(0.7 * 1024 ** 3));
    expect(desktopPolicyFromEnv({ PA_BOX_CONCURRENT_DESKTOPS: '3', PA_BOX_DESKTOP_IDLE_MINUTES: '30' })).toMatchObject({ concurrent: 3, idleStopMinutes: 30 });
    // 超过硬上限或格式错误的配置被忽略。
    expect(desktopPolicyFromEnv({ PA_BOX_CONCURRENT_DESKTOPS: '4' }).concurrent).toBe(2);
    expect(desktopPolicyFromEnv({ PA_BOX_CONCURRENT_DESKTOPS: '-1' }).concurrent).toBe(2);
    expect(desktopPolicyFromEnv({}, { concurrent: 9 }).concurrent).toBe(3);
  });

  it('admits up to the concurrency limit and refuses the next one', () => {
    expect(admitDesktop(snapshot(), 'd1', DEFAULT_DESKTOP_POLICY)).toBeUndefined();
    const two = snapshot({ desktops: [{ id: 'd1', running: true }, { id: 'd2', running: true }, { id: 'd3', running: false }] });
    expect(admitDesktop(two, 'd3', DEFAULT_DESKTOP_POLICY)?.code).toBe('BOX_DESKTOP_LIMIT');
    expect(admitDesktop(two, 'd3', { ...DEFAULT_DESKTOP_POLICY, concurrent: 3 })).toBeUndefined();
    // 已在运行的桌面总能重新打开。
    expect(admitDesktop(two, 'd1', DEFAULT_DESKTOP_POLICY)).toBeUndefined();
  });

  it('refuses new desktops at memory pressure warn or above, but reopening a running one is allowed', () => {
    expect(admitDesktop(snapshot({ memoryPressure: 'warn' }), 'd1', DEFAULT_DESKTOP_POLICY)?.code).toBe('BOX_MEMORY_PRESSURE');
    expect(admitDesktop(snapshot({ memoryPressure: 'critical' }), 'd1', DEFAULT_DESKTOP_POLICY)?.code).toBe('BOX_MEMORY_PRESSURE');
    expect(admitDesktop(snapshot({ memoryPressure: 'unknown' }), 'd1', DEFAULT_DESKTOP_POLICY)).toBeUndefined();
    expect(admitDesktop(snapshot({ memoryPressure: 'warn', desktops: [{ id: 'd1', running: true }] }), 'd1', DEFAULT_DESKTOP_POLICY)).toBeUndefined();
  });

  it('refuses when the container cannot fit another 0.7GB desktop', () => {
    const full = snapshot({ container: { state: 'running', name: 'pa-box', memoryUsedBytes: 3 * 1024 ** 3, memoryLimitBytes: 3.5 * 1024 ** 3 } });
    expect(admitDesktop(full, 'd1', DEFAULT_DESKTOP_POLICY)?.code).toBe('BOX_MEMORY_BUDGET');
  });

  it('refuses when the gate is not ready or the desktop is unknown', () => {
    expect(admitDesktop(snapshot({ gateReady: false }), 'd1', DEFAULT_DESKTOP_POLICY)?.code).toBe('BOX_DESKTOP_UNAVAILABLE');
    expect(admitDesktop(snapshot(), 'd4', DEFAULT_DESKTOP_POLICY)?.code).toBe('BOX_DESKTOP_NOT_FOUND');
  });
});

describe('pa-box seccomp profile', () => {
  const profile = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'deploy', 'box', 'pa-box-seccomp.json'), 'utf8'));

  it('is exactly the pinned moby default plus one unconditional clone/setns/unshare allow rule', () => {
    const added = profile.syscalls.at(-1);
    expect(added).toMatchObject({ names: ['clone', 'setns', 'unshare'], action: 'SCMP_ACT_ALLOW' });
    expect(added.args).toBeUndefined();
    expect(added.includes).toBeUndefined();
    const base = { ...profile, syscalls: profile.syscalls.slice(0, -1) };
    // scripts/box/gen-seccomp.mjs 打印的“规范化基础配置”哈希（moby/profiles seccomp/v0.2.4）。
    expect(createHash('sha256').update(JSON.stringify(base)).digest('hex')).toBe('4dc1298afa7676147c1320afa42d72691fc55379ae762b392b56853574a7a38a');
  });

  it('keeps the default deny posture and does not open other dangerous syscalls', () => {
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
    const unconditional = new Set(profile.syscalls.filter((rule: any) => rule.action === 'SCMP_ACT_ALLOW' && !rule.args && !rule.includes)
      .flatMap((rule: any) => rule.names));
    for (const name of ['mount', 'umount2', 'pivot_root', 'kexec_load', 'init_module', 'bpf', 'open_by_handle_at', 'reboot']) {
      expect(unconditional.has(name), name).toBe(false);
    }
  });
});
