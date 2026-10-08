import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isMain(meta: string): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(meta)); }
  catch { return false; }
}

export function absoluteArgument(value: string | undefined, name: string): string {
  if (!value || !isAbsolute(value)) throw Object.assign(new Error(`${name} requires an absolute path.`), { code: 'CLI_ARGUMENT' });
  return resolve(value);
}

export function failCli(error: unknown): void {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'CLI_FAILED';
  // Never print raw subprocess diagnostics, environment, database rows or secrets.
  const messages: Record<string, string> = {
    CLI_ARGUMENT: 'Check the command usage and use explicit absolute paths.',
    BACKUP_BUSY: 'Stop the instance normally and resolve ownership or recovery records before backing up. Preserve the data and locks.',
    BACKUP_SOURCE: 'Choose an existing Personal Agent data directory with its SQLite database.',
    BACKUP_TARGET: 'Choose a new backup directory outside the source data directory.',
    BACKUP_SYMLINK: 'The data contains a symbolic link or special file. Inspect it before choosing a backup method.',
    BACKUP_VERIFY: 'Backup verification failed. The original data is preserved; inspect the private incomplete output.',
    EACCES: 'The current account cannot access the requested files. Check ownership and permissions.',
    ENOSPC: 'There is insufficient disk space. The original data is preserved.',
    EADDRINUSE: 'The demo port is occupied. Select a different loopback port with --port.',
    DEMO_FAILED: 'The isolated fake demo did not complete its checks. Run the tests and inspect the safe status output.',
    DEMO_CLEANUP_FAILED: 'Demo process cleanup is not confirmed. Preserve its temporary data, ownership records and locks for inspection.',
  };
  console.error(`${code}: ${messages[code] ?? 'The command did not complete. Check its arguments and the documented prerequisites.'}`);
  process.exitCode = 1;
}
