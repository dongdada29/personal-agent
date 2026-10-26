import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DEVICE_CHANNEL, DEFAULT_ENTROPY, LLD12_UDID, packagedBridgePath, resolveDeviceConfig } from '../src/config.js';

describe('resolveDeviceConfig', () => {
  it('未设置环境变量时指向 M1 / LLD12 / 家目录下的 ios_act.py', () => {
    const home = join('/', 'tmp', 'pa-home');
    const config = resolveDeviceConfig({}, { home });
    expect(config.channel).toBe(DEFAULT_DEVICE_CHANNEL);
    expect(config.host).toBe('m1');
    expect(config.udid).toBe(LLD12_UDID);
    expect(config.entropy).toBe(DEFAULT_ENTROPY);
    expect(config.iosActScript).toBe(join(home, 'workspace', 'ios-ai-automation', 'scripts', 'ios_act.py'));
    expect(config.python).toBe('python3');
    expect(config.bridgeScript).toBe(packagedBridgePath());
    expect(config.leaseDir).toBe(join(home, '.personal-agent', 'device'));
  });

  it('真实 homedir 回退不含把 /Users/…/workspace 写死在源码里', () => {
    const config = resolveDeviceConfig({ PA_DEVICE_CHANNEL: 'm1' }, { home: homedir() });
    expect(config.iosActScript.endsWith(join('workspace', 'ios-ai-automation', 'scripts', 'ios_act.py'))).toBe(true);
  });
});
