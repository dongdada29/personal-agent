import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { absoluteArgument, failCli, isMain } from './cli.js';
import { inspectDataDirectory } from './doctor.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

function refuse(code: string): never { throw Object.assign(new Error(code), { code }); }
function hashFile(path: string): string {
  const descriptor = openSync(path, 'r');
  try {
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let bytes: number;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally { closeSync(descriptor); }
}
function entries(directory: string, ownedLock: string, prefix = ''): { path: string; size: number; directory?: true }[] {
  const files: { path: string; size: number; directory?: true }[] = [];
  for (const name of readdirSync(join(directory, prefix)).sort()) {
    const path = join(prefix, name);
    const info = lstatSync(join(directory, path));
    if (info.isSymbolicLink()) refuse('BACKUP_SYMLINK');
    if (path === 'service.lock' && readFileSync(join(directory, path), 'utf8') === ownedLock) continue;
    if (name === 'service.lock' || name === 'recovery.lock' || name.endsWith('.lock')) refuse('BACKUP_BUSY');
    if (info.isDirectory()) { files.push({ path, size: 0, directory: true }); files.push(...entries(directory, ownedLock, path)); }
    else if (info.isFile()) files.push({ path, size: info.size });
    else refuse('BACKUP_SYMLINK');
  }
  return files;
}

export function coldBackup(dataDir: string, output: string) {
  if (!existsSync(dataDir) || !lstatSync(dataDir).isDirectory() || lstatSync(dataDir).isSymbolicLink()) refuse('BACKUP_SOURCE');
  const source = realpathSync(dataDir);
  if (existsSync(output) || !existsSync(dirname(output))) refuse('BACKUP_TARGET');
  const target = join(realpathSync(dirname(output)), output.split(sep).at(-1)!);
  const within = relative(source, target);
  if (!within || !within.startsWith(`..${sep}`) && within !== '..') refuse('BACKUP_TARGET');
  if (existsSync(join(source, 'service.lock')) || existsSync(join(source, 'recovery.lock'))) refuse('BACKUP_BUSY');
  // Take ownership before reading any database or filesystem snapshot. A live
  // backup PID blocks the production starter through the normal instance lock.
  const guard = join(source, 'service.lock');
  const owner = JSON.stringify({ pid: process.pid, id: randomUUID(), startedAt: new Date().toISOString() });
  let acquired = false;
  try {
    try { writeFileSync(guard, owner, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') refuse('BACKUP_BUSY'); throw error; }
    acquired = true;
    if (existsSync(join(source, 'recovery.lock'))) refuse('BACKUP_BUSY');
    const instance = inspectDataDirectory(source);
    if (instance.activeOwnedProcesses > 0) refuse('BACKUP_BUSY');
    const db = new DatabaseSync(join(source, 'personal-agent.sqlite'), { readOnly: true });
    try { if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') refuse('BACKUP_VERIFY'); }
    finally { db.close(); }
    const snapshot = entries(source, owner);
    const files = snapshot.filter(entry => !entry.directory);
    mkdirSync(target, { mode: 0o700 });
    mkdirSync(join(target, 'data'), { mode: 0o700 });
    const directories = snapshot.filter(entry => entry.directory).map(entry => entry.path);
    for (const directory of directories) mkdirSync(join(target, 'data', directory), { recursive: true, mode: 0o700 });
    const manifest = files.map(file => {
      const origin = join(source, file.path), destination = join(target, 'data', file.path);
      if (!lstatSync(origin).isFile() || lstatSync(origin).isSymbolicLink()) refuse('BACKUP_SYMLINK');
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(origin, destination);
      const hash = hashFile(origin);
      if (hash !== hashFile(destination)) refuse('BACKUP_VERIFY');
      return { path: file.path, size: file.size, sha256: hash };
    });
    // Manual worktree edits are also detected rather than silently producing
    // a successful backup from a changing source directory.
    const after = entries(source, owner);
    if (JSON.stringify(after) !== JSON.stringify(snapshot) || manifest.some(file => hashFile(join(source, file.path)) !== file.sha256)) refuse('BACKUP_VERIFY');
    writeFileSync(join(target, 'backup-manifest.json'), JSON.stringify({ format: 1, createdAt: new Date().toISOString(), schemaVersion: instance.schemaVersion,
      restoreScope: 'same-host data backup; source Git repositories and absolute worktree dependencies must remain available', directories, files: manifest }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { result: 'PASS', schemaVersion: instance.schemaVersion, files: manifest.length,
      restoreScope: 'same-host', sourceDataPreserved: true, credentialsPrinted: false };
  } finally {
    if (acquired) {
      // The exclusively created lock is the only source file this tool changes.
      if (readFileSync(guard, 'utf8') === owner) unlinkSync(guard);
      else refuse('BACKUP_BUSY');
    }
  }
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--data-dir' || args[2] !== '--output') refuse('CLI_ARGUMENT');
    console.log(JSON.stringify(coldBackup(absoluteArgument(args[1], '--data-dir'), absoluteArgument(args[3], '--output')), null, 2));
  } catch (error) { failCli(error); }
}
