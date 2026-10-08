import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { AuthStore } from '@personal-agent/runtime';
import { validateSecurityConfig } from '../apps/server/src/access-control.js';

// Inspection is the default. Issuing a bearer ticket is an explicit local action.
const args = process.argv.slice(2);
let dataDir = resolve(process.env.PERSONAL_AGENT_DATA_DIR ?? `${homedir()}/.personal-agent`);
let issue = false;
try {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--issue-ticket') issue = true;
    else if (args[index] === '--data-dir' && args[index + 1]) dataDir = resolve(args[++index]);
    else throw new Error('Usage: npm run pair -- [--data-dir PATH] [--issue-ticket]');
  }
  const filename = resolve(dataDir, 'personal-agent.sqlite');
  if (!existsSync(filename)) throw new Error('Start an explicitly configured paired instance before inspecting or issuing a ticket');
  const store = new AuthStore(filename);
  try {
    const policy = store.policy();
    if (!policy) throw new Error('This instance is still loopback-only; pairing is not enabled');
    validateSecurityConfig(policy);
    if (!issue) {
      console.log(JSON.stringify({ mode: policy.mode, publicOrigin: policy.publicOrigin, cookieSecure: new URL(policy.publicOrigin).protocol === 'https:',
        nextAction: 'After approving device access, rerun with --issue-ticket in a private local terminal.' }));
    } else {
      const result = store.issueTicket();
      console.log(`One-use pairing link (expires ${result.expiresAt}):\n${policy.publicOrigin}/pair#ticket=${result.ticket}`);
      console.log('Treat this link as a secret. Share it only with your chosen browser; it is not written to a file.');
    }
  } finally { store.close(); }
} catch {
  console.error('Pairing command did not run. Check the arguments, existing data directory and explicitly enabled paired policy. No credentials are shown on failure.');
  process.exitCode = 1;
}
