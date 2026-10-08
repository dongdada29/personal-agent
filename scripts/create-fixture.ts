import { mkdir, writeFile, realpath, stat, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { inspectWorkspace, verificationEnvironment } from '@personal-agent/runtime';

const root = resolve('.data', 'phase2-fixture', 'repo');
await mkdir(root, { recursive: true });
const directory = await realpath(root);
const run = promisify(execFile);
try { await stat(join(directory, '.git')); }
catch {
  if ((await readdir(directory)).length) throw new Error('Refusing to overwrite a non-empty fixture directory');
  await mkdir(join(directory, 'test'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'personal-agent-safe-fixture', private: true, type: 'module' }, null, 2) + '\n');
  await writeFile(join(directory, 'greet.js'), "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n");
  await writeFile(join(directory, 'test', 'greet.test.js'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../greet.js';\ntest('normal name', () => assert.equal(greet('Ada'), 'Hello, Ada!'));\ntest('trim name', () => assert.equal(greet('  Ada  '), 'Hello, Ada!'));\ntest('empty name', () => assert.equal(greet('   '), 'Hello, Guest!'));\n");
  await writeFile(join(directory, 'README.md'), '# Safe fixture\n\nLocal, dependency-free greeting task. Two tests intentionally fail before the requested change.\n');
  const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Personal Agent Fixture', '-c', 'user.email=fixture@example.invalid'];
  for (const command of [['init', '-b', 'main'], ['add', '.'], ['commit', '-m', 'test: preserve safe fixture baseline']]) {
    await run('git', [...args, ...command], { cwd: directory, env: verificationEnvironment() });
  }
  await writeFile(join(directory, 'README.md'), '# Safe fixture\n\nHost fixture WIP: this uncommitted text must stay outside the task worktree.\n');
}
const inspected = await inspectWorkspace(directory);
console.log(JSON.stringify({ path: inspected.path, baselineSha: inspected.headSha,
  goal: 'Update greet.js so greet trims surrounding whitespace and uses Guest for a blank name. Add CHANGELOG.md describing this small change. Preserve unrelated files; do not commit, merge or push.',
  verificationCommands: [{ command: process.execPath, args: ['--test', 'test/greet.test.js'] }],
}, null, 2));
