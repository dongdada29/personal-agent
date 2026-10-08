// Original non-sensitive ACP fixture. All writes stay in its temporary Git worktree.
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
const write = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const text = (sessionId, value) => write({ method: methods.client.session.update, params: {
  sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } },
} });
const keep = setInterval(() => {}, 1000);
process.stdin.on('end', () => { clearInterval(keep); process.exit(0); });
let sessionId = 'restart-fixture';
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === methods.agent.initialize) write({ id: request.id, result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} } });
  if (request.method === methods.agent.session.new) {
    sessionId = `fixture-${process.pid}`;
    write({ id: request.id, result: { sessionId, modes: { currentModeId: 'default', availableModes: [
      { id: 'plan', name: 'Plan' }, { id: 'default', name: 'Default' },
    ] } } });
  }
  if (request.method === methods.agent.session.setMode) write({ id: request.id, result: {} });
  if (request.method === methods.agent.session.prompt) {
    const input = request.params.prompt.filter(item => item.type === 'text').map(item => item.text).join('');
    const stage = /\n\nStage: (\w+)/u.exec(input)[1];
    const role = /^Personal Agent role: (\w+)/u.exec(input)[1];
    appendFileSync('fixture-executions.log', `${stage}:${role}\n`);
    if (stage === 'development') {
      if (input.includes('restart-permission')) {
        write({ id: 1001, method: methods.client.session.requestPermission, params: {
          sessionId, toolCall: { toolCallId: 'fixture-read', title: 'Read temporary fixture', kind: 'read' },
          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }],
        } });
        return;
      }
      writeFileSync('feature.txt', 'after\n');
    }
    text(sessionId, stage === 'review' ? '{"verdict":"pass","blockers":[],"evidence":["fixture verification"]}' : `${role} ${stage} fixture`);
    write({ id: request.id, result: { stopReason: 'end_turn' } });
  }
  if (request.method === methods.agent.session.cancel) process.exit(0);
});
