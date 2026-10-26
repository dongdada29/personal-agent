import { describe, expect, it } from 'vitest';
import { runDeviceSmoke } from '../device-smoke.js';

describe('device executor smoke', () => {
  it('fake 通道的 health + observe 在无真机时 PASS，且不谈 47801', async () => {
    const result = await runDeviceSmoke({ includeTree: true });
    expect(result).toMatchObject({
      result: 'PASS',
      smoke: 'health+observe',
      channel: 'fake',
      productionPortUntouched: 47801,
      demoPortOk: 47811,
      health: { ok: true, channel: 'fake' },
      observation: { hasScreenshot: true, hasTree: true, channel: 'fake' },
    });
  });
});
