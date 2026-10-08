import type { TaskEvent } from '@personal-agent/contracts';

export interface DisplayEvent {
  event: TaskEvent;
  /** Original persisted records are retained for the expandable details. */
  events: TaskEvent[];
  message: string | null;
  lastSeq: number;
}

/** Merge streamed chunks between other events without mixing concurrent runs. */
export function groupTaskEvents(events: TaskEvent[]): DisplayEvent[] {
  const result: DisplayEvent[] = [];
  const currentMessages = new Map<string, DisplayEvent>();
  for (const event of events) {
    const text = typeof event.data.text === 'string' ? event.data.text : null;
    if (event.type === 'engine.message' && text !== null) {
      const key = JSON.stringify([event.taskId, event.attemptId, event.data.runId, event.data.stageId, event.data.channel, event.data.type]);
      const current = currentMessages.get(key);
      if (current) {
        current.events.push(event);
        current.message = (current.message ?? '') + text;
        current.lastSeq = event.seq;
      } else {
        const item: DisplayEvent = { event, events: [event], message: text, lastSeq: event.seq };
        currentMessages.set(key, item);
        result.push(item);
      }
    } else {
      currentMessages.clear();
      result.push({ event, events: [event], message: text ?? (typeof event.data.message === 'string' ? event.data.message : null), lastSeq: event.seq });
    }
  }
  return result;
}
