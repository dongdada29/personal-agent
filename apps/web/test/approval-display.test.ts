import { describe, expect, it } from 'vitest';
import type { ApprovalRecord } from '@personal-agent/contracts';
import { mergeApprovalRecords } from '../src/approval-display';

function approval(id: string, patch: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id, taskId: 'selected-task', attemptId: 'current-attempt', runId: 'developer-run', title: 'Edit fixture',
    options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    status: 'pending', createdAt: '2026-10-02T12:00:00.000Z', resolvedAt: null, selectedOptionId: null,
    ...patch,
  };
}

describe('approval display reconciliation', () => {
  it('keeps a fresh metadata request when the selected snapshot predates the request', () => {
    const newRequest = approval('new-request');
    expect(mergeApprovalRecords([newRequest], [])).toEqual([newRequest]);
    expect(mergeApprovalRecords([], [newRequest])).toEqual([newRequest]);
  });

  it.each(['resolved', 'expired'] as const)('never revives a %s request from a stale pending read', (status) => {
    const pending = approval('request');
    const handled = approval('request', {
      status, resolvedAt: '2026-10-02T12:01:00.000Z', selectedOptionId: status === 'resolved' ? 'allow-once' : null,
    });
    expect(mergeApprovalRecords([handled], [pending])).toEqual([handled]);
    expect(mergeApprovalRecords([pending], [handled])).toEqual([handled]);
  });

  it('chooses the later handling time when independently read terminal records conflict', () => {
    const resolved = approval('request', { status: 'resolved', selectedOptionId: 'allow-once', resolvedAt: '2026-10-02T12:01:00.000Z' });
    const expired = approval('request', { status: 'expired', resolvedAt: '2026-10-02T12:02:00.000Z' });
    expect(mergeApprovalRecords([resolved], [expired])).toEqual([expired]);
    expect(mergeApprovalRecords([expired], [resolved])).toEqual([expired]);
  });

  it('prefers an available handling time over a terminal record missing that time', () => {
    const undated = approval('request', { status: 'expired' });
    const dated = approval('request', { status: 'resolved', resolvedAt: '2026-10-02T12:01:00.000Z', selectedOptionId: 'allow-once' });
    expect(mergeApprovalRecords([undated], [dated])).toEqual([dated]);
    expect(mergeApprovalRecords([dated], [undated])).toEqual([dated]);
  });

  it('retains other tasks, old attempt history and every new pending id', () => {
    const otherTask = approval('other-task-request', { taskId: 'other-task' });
    const oldAttempt = approval('old-attempt-request', { attemptId: 'old-attempt', status: 'expired', resolvedAt: '2026-10-02T12:01:00.000Z' });
    const first = approval('first-current-request');
    const second = approval('second-current-request');
    expect(mergeApprovalRecords([otherTask, oldAttempt], [first, second], [oldAttempt, first])).toEqual([otherTask, oldAttempt, first, second]);
  });

  it('uses fuller display evidence from an equal version without changing membership or order', () => {
    const initial = approval('request');
    const fuller = approval('request', { toolCall: { kind: 'edit', rawInput: { path: 'fixture.txt' } } });
    const other = approval('other-request');
    expect(mergeApprovalRecords([initial, other], [fuller])).toEqual([fuller, other]);
  });

  it('does not mutate frozen source arrays, records or evidence', () => {
    const request = approval('request', { toolCall: { kind: 'read', rawInput: { path: 'fixture.txt' } } });
    Object.freeze(request.options[0]);
    Object.freeze(request.options);
    Object.freeze(request.toolCall);
    Object.freeze(request);
    const input = Object.freeze([request]);
    const before = JSON.stringify(input);
    const output = mergeApprovalRecords(input, input);
    expect(output).toEqual([request]);
    expect(output).not.toBe(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('returns an empty union for empty or absent sources', () => {
    expect(mergeApprovalRecords()).toEqual([]);
    expect(mergeApprovalRecords([], [])).toEqual([]);
  });
});
