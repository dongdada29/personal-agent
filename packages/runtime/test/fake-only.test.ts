import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../src/runner.js';
import { TaskStore } from '../src/store.js';
import type { EngineAdapter } from '../src/engine.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'personal-agent-fake-only-'));
  directories.push(dir);
  return dir;
}

function repository(dir: string) {
  const path = join(dir, 'repository');
  mkdirSync(path);
  writeFileSync(join(path, 'answer.txt'), 'before');
  execFileSync('git', ['init', '--quiet', path]);
  execFileSync('git', ['-C', path, 'add', 'answer.txt']);
  execFileSync('git', ['-C', path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Baseline']);
  return { path, baseline: execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
}

describe('fake-only store', () => {
  it('rejects real tasks, workspace registration and a claude default engine without writing', () => {
    const dir = temporary();
    const store = new TaskStore(join(dir, 'tasks.sqlite'), { fakeOnly: true });
    try {
      const marker = join(dir, 'marker');
      const commands = [{ command: '/usr/bin/touch', args: [marker] }];
      expect(() => store.create({ commandId: 'claude', goal: 'x', engine: 'claude', workspaceId: 'w', verificationCommands: commands }, '0'.repeat(40)))
        .toThrow(expect.objectContaining({ code: 'DEMO_FAKE_ONLY', statusCode: 403 }));
      expect(() => store.create({ commandId: 'fake-commands', goal: 'x', verificationCommands: commands })).toThrow(expect.objectContaining({ code: 'DEMO_FAKE_ONLY' }));
      expect(() => store.create({ commandId: 'fake-baseline', goal: 'x' }, '0'.repeat(40))).toThrow(expect.objectContaining({ code: 'DEMO_FAKE_ONLY' }));
      expect(() => store.registerWorkspace(dir, 'Visitor')).toThrow(expect.objectContaining({ code: 'DEMO_FAKE_ONLY' }));
      expect(() => store.updateSettings({ commandId: 'settings', defaultEngine: 'claude' })).toThrow(expect.objectContaining({ code: 'DEMO_FAKE_ONLY' }));
      expect(store.list()).toHaveLength(0);
      expect(store.workspaces()).toHaveLength(0);
      expect(store.settings().defaultEngine).toBe('fake');
      expect(store.create({ commandId: 'fake', goal: 'x', engine: 'fake' }).created).toBe(true);
      expect(store.updateSettings({ commandId: 'fake-default', defaultEngine: 'fake' }).defaultEngine).toBe('fake');
    } finally { store.close(); }
  });
});

describe('fake-only runner', () => {
  it('fails a pre-existing claude task without opening the real adapter, creating a worktree or running verification', async () => {
    const dir = temporary();
    const store = new TaskStore(join(dir, 'tasks.sqlite'));
    const repo = repository(dir);
    const marker = join(dir, 'pa-demo-poc-marker');
    const workspace = store.registerWorkspace(repo.path, 'Visitor repository');
    const task = store.create({ commandId: 'claude-poc', goal: 'x', engine: 'claude', workspaceId: workspace.id,
      verificationCommands: [{ command: '/usr/bin/touch', args: [marker] }] }, repo.baseline).task;
    const open = vi.fn<EngineAdapter['open']>(async () => { throw new Error('real adapter must not be opened'); });
    const realAdapter: EngineAdapter = { probe: vi.fn(), open };
    const runner = new TaskRunner(store, dir, undefined, realAdapter, { fakeOnly: true });
    try {
      expect(runner.isFakeOnly).toBe(true);
      runner.enqueue(task.id);
      await runner.idle();
      expect(store.require(task.id).status).toBe('failed');
      expect(store.events(task.id).at(-1)?.data).toMatchObject({ status: 'failed', reason: 'REAL_ENGINE_DISABLED' });
      expect(open).not.toHaveBeenCalled();
      expect(existsSync(marker)).toBe(false);
      expect(store.require(task.id).worktreePath).toBeUndefined();
      expect(execFileSync('git', ['-C', repo.path, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).match(/^worktree /gm)).toHaveLength(1);
    } finally { await runner.close(); store.close(); }
  });

  it('inherits fake-only from the store even when no runner option is passed', () => {
    const dir = temporary();
    const store = new TaskStore(join(dir, 'tasks.sqlite'), { fakeOnly: true });
    try { expect(new TaskRunner(store, dir).isFakeOnly).toBe(true); }
    finally { store.close(); }
  });
});
