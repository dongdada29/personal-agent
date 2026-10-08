import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { securityConfigFromEnv } from './access-control.js';

const dataDir = resolve(process.env.PERSONAL_AGENT_DATA_DIR ?? `${homedir()}/.personal-agent`);

function startupDiagnostic(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'CLEANUP_FAILED': case 'EVENT_FAILURE':
      return `[${code}] Startup recovery could not verify process ownership or persist closure. Scheduling is stopped; preserve the data directory and locks for inspection.`;
    case 'PROCESS_UNSUPPORTED':
      return '[PROCESS_UNSUPPORTED] Persistent process recovery requires macOS or Linux.';
    case 'SECURITY_CONFIG_INVALID': case 'SECURITY_POLICY_CONFLICT':
      return `[${code}] Paired access configuration is invalid or conflicts with the retained policy. Check explicit paired mode and its exact HTTPS origin; preserve the data directory.`;
    case 'INSTANCE_LOCKED':
      return '[INSTANCE_LOCKED] This data directory has a service owner or recovery lock. Inspect the owning instance and use it or stop it normally; do not delete locks to bypass recovery.';
    case 'EADDRINUSE':
      return '[EADDRINUSE] Port 47801 is already in use. Open the existing instance or stop its confirmed owner normally before starting another service.';
    case 'EACCES': case 'EPERM':
      return `[${code}] The service cannot access a required file or inspect a process. Check source/data directory access and process inspection permissions; preserve existing data and locks.`;
    case 'ENOSPC': case 'SQLITE_FULL':
      return '[ENOSPC] Storage is full. Make space on the data volume and retry; preserve the database, task files and locks.';
    case 'EROFS':
      return '[EROFS] The data volume is read-only. Use a writable data location; preserve existing data and verify its backup before moving it.';
    case 'ERR_SQLITE_ERROR': case 'SQLITE_CANTOPEN': case 'SQLITE_CORRUPT': case 'SQLITE_NOTADB':
      return '[DATABASE_STARTUP_FAILED] The database could not be opened or initialized. Preserve the complete data directory and check storage, access and the matching source/backup version.';
    default:
      return '[STARTUP_FAILED] Could not start the loopback service. Check port 47801, source dependencies and data directory access; preserve existing data and locks.';
  }
}

let app: Awaited<ReturnType<typeof buildApp>>['app'] | undefined;
try {
  ({ app } = await buildApp({ dataDir, security: securityConfigFromEnv(process.env) }));
  await app.listen({ host: '127.0.0.1', port: 47801 });
  console.log('Personal Agent phase 4: loopback listener at http://127.0.0.1:47801 (paired policy is retained by its data directory)');
} catch (error) {
  console.error(startupDiagnostic(error));
  try { await app?.close(); }
  catch { console.error('[SHUTDOWN_CLEANUP_FAILED] Service cleanup needs inspection; preserve the complete data directory and locks.'); }
  process.exitCode = 1;
}
let shutdown: Promise<void> | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // npm/terminals can deliver the same signal twice while cleanup is pending.
  process.on(signal, () => {
    shutdown ??= (async () => {
      try { await app?.close(); process.exitCode = 0; }
      catch { console.error('[SHUTDOWN_CLEANUP_FAILED] Service cleanup needs inspection; preserve the complete data directory and locks.'); process.exitCode = 1; }
    })();
  });
}
