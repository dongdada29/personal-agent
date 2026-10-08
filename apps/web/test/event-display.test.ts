import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '@personal-agent/contracts';
import { groupTaskEvents } from '../src/event-display';

function message(seq: number, text: string, runId = 'planner', attemptId = 'attempt-1'): TaskEvent {
  return { seq, taskId: 'task', attemptId, type: 'engine.message', data: { text, runId, type: 'message' }, createdAt: '2026-10-02T00:00:00Z' };
}

describe('persisted event display', () => {
  it('reconstructs streamed text and retains every original record without mutating it', () => {
    const events = [message(1, 'Hello'), message(2, ' '), message(3, 'world')];
    const before = JSON.stringify(events);
    const groups = groupTaskEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].message).toBe('Hello world');
    expect(groups[0].event.seq).toBe(1);
    expect(groups[0].lastSeq).toBe(3);
    expect(groups[0].events).toEqual(events);
    expect(JSON.stringify(events)).toBe(before);
  });

  it('keeps interleaved planner and reviewer streams separate', () => {
    const groups = groupTaskEvents([message(1, 'Plan ', 'planner'), message(2, 'Review ', 'reviewer'), message(3, 'ready', 'planner'), message(4, 'ready', 'reviewer')]);
    expect(groups.map((group) => group.message)).toEqual(['Plan ready', 'Review ready']);
    expect(groups.map((group) => group.events.map((event) => event.seq))).toEqual([[1, 3], [2, 4]]);
  });

  it('preserves tool and status boundaries in the timeline', () => {
    const tool: TaskEvent = { ...message(2, ''), type: 'engine.tool', data: { title: 'Read file' } };
    const groups = groupTaskEvents([message(1, 'Before'), tool, message(3, 'After')]);
    expect(groups.map((group) => group.event.seq)).toEqual([1, 2, 3]);
    expect(groups[1].events).toEqual([tool]);
    expect(groups.map((group) => group.message)).toEqual(['Before', null, 'After']);
  });

  it('does not join output from different attempts or channels', () => {
    const thought: TaskEvent = { ...message(3, 'Thinking'), data: { ...message(3, '').data, text: 'Thinking', channel: 'thought' } };
    expect(groupTaskEvents([message(1, 'Old', 'planner', 'attempt-1'), message(2, 'New', 'planner', 'attempt-2'), thought])).toHaveLength(3);
  });

  it('keeps non-message records and incomplete message payloads independently visible', () => {
    const incomplete: TaskEvent = { ...message(1, ''), data: { runId: 'planner' } };
    const status: TaskEvent = { ...message(2, ''), type: 'task.failed', data: { message: 'Validation failed' } };
    const groups = groupTaskEvents([incomplete, status]);
    expect(groups).toHaveLength(2);
    expect(groups[0].message).toBeNull();
    expect(groups[1].message).toBe('Validation failed');
  });
});
