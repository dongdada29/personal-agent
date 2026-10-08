// Original deterministic ACP test fixture; stdout contains only ACP NDJSON.
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError, type PromptResponse } from '@agentclientprotocol/sdk';

const flags = new Set(process.argv.slice(2));
let sessionCounter = 0;
let stubborn = false;
let active: ((response: PromptResponse) => void) | undefined;
let clientSafe = false;
const keepAlive = setInterval(() => {}, 1_000);
process.stdin.on('end', () => {
  if (!stubborn) { clearInterval(keepAlive); process.exit(0); }
});
process.on('SIGTERM', () => { if (!stubborn) process.exit(0); });

const app = agent({ name: 'personal-agent-fake' })
  .onRequest(methods.agent.initialize, async ({ params }) => {
    if (flags.has('--startup-hang')) return new Promise<never>(() => {});
    clientSafe = params.clientCapabilities?.fs?.readTextFile === false
      && params.clientCapabilities.fs.writeTextFile === false && params.clientCapabilities.terminal === false;
    return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'fake-acp', version: '1' }, agentCapabilities: {} };
  })
  .onRequest(methods.agent.session.new, ({ params }) => {
    if (flags.has('--require-safe-probe')) {
      const meta = params._meta as { disableBuiltInTools?: boolean; claudeCode?: { options?: Record<string, unknown> } } | undefined;
      const options = meta?.claudeCode?.options;
      const sources = JSON.stringify(options?.settingSources);
      const settings = options?.settings as Record<string, unknown> | undefined;
      if (!clientSafe || params.mcpServers.length !== 0 || meta?.disableBuiltInTools !== true
        || JSON.stringify(options?.tools) !== '[]' || JSON.stringify(options?.allowedTools) !== '[]'
        || JSON.stringify(options?.mcpServers) !== '{}' || (sources !== '[]' && sources !== '["user"]')
        || JSON.stringify(options?.skills) !== '[]' || JSON.stringify(options?.plugins) !== '[]'
        || options?.persistSession !== false || options.strictMcpConfig !== true
        || settings?.disableAllHooks !== true || JSON.stringify(options.hooks) !== '{}'
        || (options.env as Record<string, unknown>)?.DISABLE_AUTOUPDATER !== '1'
        || (settings.env as Record<string, unknown>)?.DISABLE_AUTOUPDATER !== '1') {
        throw new Error('Unsafe probe options were delivered on ACP wire');
      }
      if (sources === '["user"]' && Object.values((settings?.enabledPlugins ?? {}) as Record<string, unknown>).some((value) => value !== false)) {
        throw new Error('User plugins must all be disabled in the probe');
      }
    }
    return {
      sessionId: `fake-${++sessionCounter}`,
      modes: {
        currentModeId: 'default',
        availableModes: flags.has('--no-plan')
          ? [{ id: 'default', name: 'Default' }]
          : [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }],
      },
    };
  })
  .onRequest(methods.agent.session.setMode, async ({ params, client }) => {
    if (flags.has('--mode-failure')) throw new Error('Simulated mode-switch failure');
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: params.modeId },
    });
    return {};
  })
  .onNotification(methods.agent.session.cancel, () => {
    if (!stubborn) { active?.({ stopReason: 'cancelled' }); active = undefined; }
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const text = params.prompt.filter((item) => item.type === 'text').map((item) => item.text).join('');
    const emit = (text: string) => client.notify(methods.client.session.update, {
      sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    if (text.includes('fake:error')) {
      process.stderr.write('Simulated crash; SECRET_TEST_TOKEN=must-not-be-exposed\n');
      process.exit(23);
    }
    if (text.includes('fake:malformed')) {
      process.stdout.write('SECRET_TEST_TOKEN=must-not-be-exposed\n');
      return new Promise<never>(() => {});
    }
    if (text.includes('fake:bad-update') || text.includes('fake:coerced-update')) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'plan', entries: [{ content: 'SECRET_TEST_TOKEN=must-not-be-exposed',
          priority: text.includes('fake:coerced-update') ? ['high'] : 'invalid', status: ['completed'] }] },
      } }) + '\n');
      return new Promise<never>(() => {});
    }
    if (text.includes('fake:unknown-response')) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'SECRET_TEST_TOKEN=must-not-be-exposed', result: {} }) + '\n');
      return new Promise<never>(() => {});
    }
    if (text.includes('fake:auth')) throw RequestError.authRequired({ token: 'must-not-be-exposed' });
    if (text.includes('fake:stubborn') || text.includes('fake:spawn-grandchild')) stubborn = true;
    if (text.includes('fake:spawn-grandchild')) {
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'], { stdio: 'ignore' });
      await emit(`grandchild:${child.pid}`);
    }
    if (text.includes('fake:hang') || stubborn) return new Promise<PromptResponse>((resolve) => { active = resolve; });
    if (text.includes('fake:permission')) {
      const decision = await client.request(methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'fake-tool', title: 'Fake harmless tool', kind: 'read' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
      });
      const selected = decision.outcome.outcome === 'selected' ? decision.outcome.optionId : 'cancelled';
      await emit(`Permission: ${selected}\n`);
      return { stopReason: selected === 'allow-once' ? 'end_turn' : 'refusal' };
    }
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId, update: { sessionUpdate: 'plan', entries: [
        { content: 'Complete the fake ACP task', priority: 'high', status: 'completed' },
      ] },
    });
    await emit('# Fake ACP result\n\n');
    await emit('This artifact came from an independent ACP process.\n');
    return { stopReason: 'end_turn' };
  });

const connection = app.connect(ndJsonStream(
  Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
));
await connection.closed;
if (!stubborn) clearInterval(keepAlive);
