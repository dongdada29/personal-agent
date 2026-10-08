import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absoluteArgument, failCli, isMain } from './cli.js';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
export function inspectDataDirectory(dataDir: string) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const database = join(dataDir, 'personal-agent.sqlite');
  if (!existsSync(database) || !lstatSync(database).isFile() || lstatSync(database).isSymbolicLink()) {
    throw Object.assign(new Error('Not an existing instance'), { code: 'BACKUP_SOURCE' });
  }
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
    const schemaVersion = tables.has('schema_migrations') ? Number(db.prepare('SELECT max(version) AS version FROM schema_migrations').get()?.version ?? 0) : 0;
    const tasks = tables.has('tasks') ? db.prepare('SELECT status, count(*) AS count FROM tasks GROUP BY status ORDER BY status').all() : [];
    const activeOwnedProcesses = tables.has('owned_processes') ? Number(db.prepare("SELECT count(*) AS count FROM owned_processes WHERE status != 'closed'").get()?.count ?? 0) : 0;
    const policy = tables.has('security_policy') ? db.prepare('SELECT payload_json FROM security_policy LIMIT 1').get() : undefined;
    const mode = policy ? (JSON.parse(String(policy.payload_json)) as { mode?: string }).mode : 'loopback';
    return { schemaVersion, tasks, activeOwnedProcesses, mode: mode === 'paired' ? 'paired' : 'loopback',
      serviceLockPresent: existsSync(join(dataDir, 'service.lock')), recoveryLockPresent: existsSync(join(dataDir, 'recovery.lock')) };
  } finally { db.close(); }
}

export function doctor(dataDir?: string) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeSupported = major > 22 || major === 22 && minor >= 18;
  const processManagementSupported = process.platform === 'darwin' || process.platform === 'linux';
  let gitAvailable = false;
  try { execFileSync('git', ['--version'], { timeout: 5000, stdio: 'pipe' }); gitAvailable = true; } catch { /* report only */ }
  const require = createRequire(import.meta.url);
  const dependencies: Record<string, boolean> = {};
  for (const dependency of ['tsx', 'fastify', '@agentclientprotocol/sdk', 'claude-code-acp-ts']) {
    try { require.resolve(dependency === 'claude-code-acp-ts' ? `${dependency}/dist/index.js` : dependency); dependencies[dependency] = true; } catch { dependencies[dependency] = false; }
  }
  const webBuilt = existsSync(join(projectDir, 'apps/web/dist/index.html'));
  const ready = nodeSupported && processManagementSupported && gitAvailable && webBuilt && Object.values(dependencies).every(Boolean);
  return { result: ready ? 'READY' : 'NEEDS_ACTION', node: process.versions.node, platform: process.platform, architecture: process.arch,
    checks: { nodeSupported, processManagementSupported, gitAvailable, webBuilt, dependencies },
    ...(dataDir ? { instance: inspectDataDirectory(dataDir) } : {}),
    engineAuthentication: 'not_checked', publicAccess: 'not_checked',
    nextActions: [!nodeSupported && 'Use Node >=22.18.', !processManagementSupported && 'Use macOS or Linux; Windows process recovery is not supported.',
      !gitAvailable && 'Install Git.', !Object.values(dependencies).every(Boolean) && 'Run npm ci --ignore-scripts using the official registry.',
      !webBuilt && 'Run npm run build.'].filter(Boolean) };
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--data-dir')) throw Object.assign(new Error('Usage'), { code: 'CLI_ARGUMENT' });
    const result = doctor(args.length ? absoluteArgument(args[1], '--data-dir') : undefined);
    console.log(JSON.stringify(result, null, 2));
    if (result.result !== 'READY') process.exitCode = 1;
  } catch (error) { failCli(error); }
}
