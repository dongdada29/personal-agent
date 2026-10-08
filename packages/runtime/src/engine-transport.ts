import type { AnyMessage, Stream } from '@agentclientprotocol/sdk';
import { EngineError } from './engine.js';

const MAX_LINE_LENGTH = 1_048_576;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const validId = (value: unknown): value is string | number | null => value === null || typeof value === 'string' || typeof value === 'number';

/**
 * ACP SDK 1.3's stock stream logs malformed raw input. This original transport
 * fails closed with fixed diagnostics, bounds lines, and normalizes the update
 * types consumed here before they reach the SDK notification schema/log path.
 */
export function safeAcpStdioStream(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>): Stream {
  const pending = new Set<string | number | null>();
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;

  function message(line: string): AnyMessage | undefined {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new EngineError('ENGINE_FAILED', 'Engine emitted invalid ACP data.'); }
    if (!record(value) || value.jsonrpc !== '2.0') throw new EngineError('ENGINE_FAILED', 'Engine emitted an invalid ACP envelope.');
    if ('method' in value) {
      if (typeof value.method !== 'string' || ('id' in value && !validId(value.id))) {
        throw new EngineError('ENGINE_FAILED', 'Engine emitted an invalid ACP request.');
      }
      if (!('id' in value) && value.method === 'session/update') {
        const params = value.params;
        if (!record(params) || typeof params.sessionId !== 'string' || !record(params.update)) {
          throw new EngineError('ENGINE_FAILED', 'Engine emitted an invalid session update.');
        }
        const update = params.update;
        let clean: Record<string, unknown>;
        if (update.sessionUpdate === 'agent_message_chunk') {
          if (!record(update.content) || update.content.type !== 'text') return undefined;
          if (typeof update.content.text !== 'string') throw new EngineError('ENGINE_FAILED', 'Engine emitted invalid message content.');
          clean = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: update.content.text } };
        } else if (update.sessionUpdate === 'current_mode_update') {
          if (typeof update.currentModeId !== 'string') throw new EngineError('ENGINE_FAILED', 'Engine emitted an invalid mode update.');
          clean = { sessionUpdate: 'current_mode_update', currentModeId: update.currentModeId };
        } else if (update.sessionUpdate === 'plan') {
          if (!Array.isArray(update.entries) || !update.entries.every((entry) => record(entry)
            && typeof entry.content === 'string' && typeof entry.priority === 'string' && ['high', 'medium', 'low'].includes(entry.priority)
            && typeof entry.status === 'string' && ['pending', 'in_progress', 'completed'].includes(entry.status))) {
            throw new EngineError('ENGINE_FAILED', 'Engine emitted an invalid plan update.');
          }
          clean = { sessionUpdate: 'plan', entries: update.entries.map((entry) => ({ content: entry.content, priority: entry.priority, status: entry.status })) };
        } else return undefined; // Stage one consumes these three update types only.
        return { jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: clean } };
      }
      return value as AnyMessage;
    }
    if (!('id' in value) || !validId(value.id) || !('result' in value || 'error' in value)) {
      throw new EngineError('ENGINE_FAILED', 'Engine emitted an invalid ACP response.');
    }
    // The SDK logs unknown response IDs; never pass untrusted IDs to that path.
    if (!pending.delete(value.id)) throw new EngineError('ENGINE_FAILED', 'Engine emitted an unexpected ACP response.');
    return value as AnyMessage;
  }

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      reader = input.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const enqueue = (line: string) => {
        if (line.length > MAX_LINE_LENGTH) throw new EngineError('ENGINE_FAILED', 'Engine ACP message exceeds the size limit.');
        if (line.trim()) { const parsed = message(line); if (parsed) controller.enqueue(parsed); }
      };
      try {
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (cancelled) return;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            enqueue(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
          if (buffer.length > MAX_LINE_LENGTH) throw new EngineError('ENGINE_FAILED', 'Engine ACP message exceeds the size limit.');
        }
        if (!cancelled) { enqueue(buffer + decoder.decode()); controller.close(); }
      } catch {
        if (!cancelled) controller.error(new EngineError('ENGINE_FAILED', 'Engine ACP stream failed. Raw diagnostics are withheld.'));
      } finally {
        reader.releaseLock();
        reader = undefined;
      }
    },
    cancel(reason) { cancelled = true; return reader?.cancel(reason); },
  });
  const writable = new WritableStream<AnyMessage>({
    async write(value) {
      if ('method' in value && 'id' in value) pending.add(value.id);
      const writer = output.getWriter();
      try { await writer.write(encoder.encode(`${JSON.stringify(value)}\n`)); }
      finally { writer.releaseLock(); }
    },
  });
  return { readable, writable };
}
