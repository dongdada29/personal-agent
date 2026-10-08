import { expect, it } from 'vitest';
import { TaskStore } from '../src/store.js';

it('replays structurally identical public configuration commands regardless of JSON object key order', () => {
  const store = new TaskStore(':memory:');
  try {
    const settings = store.updateSettings({ commandId: 'settings-order', defaultEngine: 'fake', agentRunTimeoutMs: 1234 });
    store.updateSettings({ commandId: 'other-settings', defaultEngine: 'claude' });
    expect(store.updateSettings({ agentRunTimeoutMs: 1234, defaultEngine: 'fake', commandId: 'settings-order' })).toEqual(settings);
    expect(store.settings().defaultEngine).toBe('claude');
    const profile = store.saveProfile({ commandId: 'profile-order', role: 'planner', name: 'Fixture planner', instructions: 'First', model: 'public-model' });
    expect(store.saveProfile({ model: 'public-model', instructions: 'First', name: 'Fixture planner', role: 'planner', commandId: 'profile-order' })).toEqual(profile);
    expect(store.profiles()).toHaveLength(4);
    expect(() => store.updateSettings({ commandId: 'settings-order', defaultEngine: 'fake', agentRunTimeoutMs: 1235 })).toThrowError(expect.objectContaining({ code: 'COMMAND_CONFLICT' }));
  } finally { store.close(); }
});
