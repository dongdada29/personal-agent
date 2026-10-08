import type { ApprovalRecord } from '@personal-agent/contracts';

/**
 * Union independent approval reads without treating absence as a state change.
 * An old snapshot cannot hide a new request or revive a handled request. For
 * duplicate terminal records, the later handling time wins; equal versions use
 * the last supplied record so a fuller snapshot can provide display evidence.
 * Inputs and their records are never modified.
 */
export function mergeApprovalRecords(...lists: ReadonlyArray<readonly ApprovalRecord[]>): ApprovalRecord[] {
  const records = new Map<string, ApprovalRecord>();
  for (const list of lists) {
    for (const incoming of list) {
      const previous = records.get(incoming.id);
      if (!previous) {
        records.set(incoming.id, incoming);
        continue;
      }
      const previousTerminal = previous.status !== 'pending';
      const incomingTerminal = incoming.status !== 'pending';
      if (previousTerminal && !incomingTerminal) continue;
      if (incomingTerminal && !previousTerminal) {
        records.set(incoming.id, incoming);
        continue;
      }
      const previousTime = previousTerminal ? previous.resolvedAt ?? '' : previous.createdAt;
      const incomingTime = incomingTerminal ? incoming.resolvedAt ?? '' : incoming.createdAt;
      if (incomingTime >= previousTime) records.set(incoming.id, incoming);
    }
  }
  return [...records.values()];
}
