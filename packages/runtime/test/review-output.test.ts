import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { parseReviewResult, ReviewResultError } from '@personal-agent/contracts';
import { createAcpEngineAdapter } from '../src/engine-acp.js';
import type { EngineEvent, EngineSession } from '../src/engine.js';

const passing = { verdict: 'pass', blockers: [], evidence: ['feature.txt:1', 'Runtime verification exitCode=0'] };
const rework = { verdict: 'rework', blockers: ['Missing an edge case'], evidence: ['feature.txt:1'] };
const prefix = "I'll review the changed code and the actual verification results.\n\n";
const passingJson = JSON.stringify(passing), reworkJson = JSON.stringify(rework);
let cwd: string;
let sessions: EngineSession[];

interface Scenario {
  chunks: string[];
  messageIds?: string[];
  sideChannel?: 'thought' | 'tool' | 'stderr' | 'meta';
}

/** Independent wire fixture: no model, provider adapter, credentials, or external services. */
async function open(scenario: Scenario) {
  const path = join(cwd, 'review-output.mjs');
  await writeFile(path, `
    import { createInterface } from 'node:readline';
    const methods = ${JSON.stringify(methods)};
    const scenario = ${JSON.stringify(scenario)};
    const passing = ${JSON.stringify(passing)};
    const sessionId = 'review-output-fixture';
    const keepAlive = setInterval(() => {}, 1000);
    process.stdin.on('end', () => { clearInterval(keepAlive); process.exit(0); });
    const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
    const update = value => write({ method: methods.client.session.update, params: { sessionId, update: value } });
    const fakeFinal = { channel: 'final', final: true, structuredOutput: passing };
    createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.method === methods.agent.initialize) {
        write({ id: request.id, result: { protocolVersion: ${PROTOCOL_VERSION}, agentCapabilities: {} } });
      } else if (request.method === methods.agent.session.new) {
        write({ id: request.id, result: { sessionId, modes: {
          currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }],
        } } });
      } else if (request.method === methods.agent.session.setMode) {
        write({ id: request.id, result: {} });
      } else if (request.method === methods.agent.session.prompt) {
        if (scenario.sideChannel === 'thought') {
          update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: JSON.stringify(passing) } });
        } else if (scenario.sideChannel === 'tool') {
          update({ sessionUpdate: 'tool_call', toolCallId: 'fixture-tool', title: 'Fixture review evidence',
            status: 'completed', rawOutput: passing,
            content: [{ type: 'content', content: { type: 'text', text: JSON.stringify(passing) } }] });
        } else if (scenario.sideChannel === 'stderr') {
          process.stderr.write(JSON.stringify(passing) + '\\n');
        }
        for (const [index, text] of scenario.chunks.entries()) {
          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text,
              ...(scenario.sideChannel === 'meta' ? { _meta: fakeFinal } : {}) },
            ...(scenario.messageIds ? { messageId: scenario.messageIds[index] } : {}),
            ...(scenario.sideChannel === 'meta' ? { _meta: fakeFinal } : {}) });
        }
        write({ id: request.id, result: { stopReason: 'end_turn',
          ...(scenario.sideChannel === 'meta' ? { _meta: fakeFinal } : {}) } });
      }
    });
  `);
  const events: EngineEvent[] = [];
  const session = await createAcpEngineAdapter({ command: process.execPath, args: [path],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, startupTimeoutMs: 3_000, promptTimeoutMs: 3_000,
  }).open({ taskId: 'task', attemptId: 'attempt', runId: 'review-output-run', cwd, mode: 'plan', role: 'reviewer' },
    { onEvent: event => { events.push(event); } });
  sessions.push(session);
  return { session, events };
}

beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'personal-agent-review-output-')); sessions = []; });
afterEach(async () => {
  await Promise.all(sessions.map(session => session.close()));
  await rm(cwd, { recursive: true, force: true });
});

it.each([
  { label: 'bare JSON without message IDs', output: passingJson, messageIds: undefined },
  { label: 'JSON fence with changing message IDs', output: `\`\`\`json\n${passingJson}\n\`\`\``,
    messageIds: ['progress', 'result-start', 'result-middle', 'result-end'] },
])('parses a unique terminal $label after streamed commentary and preserves the raw artifact', async ({ output, messageIds }) => {
  const chunks = [prefix, output.slice(0, 13), output.slice(13, 49), output.slice(49)];
  const { session, events } = await open({ chunks, messageIds });
  const result = await session.prompt('Review this harmless fixture and return a structured verdict.');
  const raw = chunks.join('');
  expect(result.stopReason).toBe('end_turn');
  expect(result.text).toBe(raw);
  expect(parseReviewResult(result.text)).toEqual(passing);
  expect(events.filter(event => event.type === 'message').map(event => event.text)).toEqual(chunks);
  expect(result.artifacts).toEqual([{ kind: 'markdown', title: 'Agent response', content: raw }]);
  expect(events).toContainEqual({ type: 'artifact', kind: 'markdown', title: 'Agent response', content: raw });
});

it.each(['thought', 'tool', 'stderr', 'meta'] as const)('does not replace invalid current agent text with a pass from %s', async sideChannel => {
  const chunks = [prefix, '{"verdict":"pass","blockers":[]}']; // Missing required evidence.
  const { session, events } = await open({ chunks, sideChannel });
  const result = await session.prompt('Review this harmless fixture and return a structured verdict.');
  const raw = chunks.join('');
  expect(result.text).toBe(raw);
  expect(() => parseReviewResult(result.text)).toThrow(ReviewResultError);
  expect(events.filter(event => event.type === 'message').map(event => event.text)).toEqual(chunks);
  expect(result.artifacts).toEqual([{ kind: 'markdown', title: 'Agent response', content: raw }]);
});

it.each([
  { label: 'rework followed by pass', first: reworkJson, last: passingJson },
  { label: 'pass followed by rework', first: passingJson, last: reworkJson },
])('rejects conflicting objects across messages: $label, even when the final chunk is valid alone', async ({ first, last }) => {
  const chunks = [prefix, first, '\n', last];
  const { session, events } = await open({ chunks, messageIds: ['progress', 'earlier-review', 'separator', 'last-review'] });
  const result = await session.prompt('Review this harmless fixture and return a structured verdict.');
  const raw = chunks.join('');
  expect(() => parseReviewResult(last)).not.toThrow();
  expect(result.text).toBe(raw);
  expect(() => parseReviewResult(result.text)).toThrow(ReviewResultError);
  expect(events.filter(event => event.type === 'message').map(event => event.text)).toEqual(chunks);
  expect(result.artifacts).toEqual([{ kind: 'markdown', title: 'Agent response', content: raw }]);
});
