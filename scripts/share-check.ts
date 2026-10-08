import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failCli, isMain } from './cli.js';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
export function inspectShareFile(path: string, content: string): { path: string; category: string; line?: number }[] {
  const findings: { path: string; category: string; line?: number }[] = [];
  if (/(^|\/)(?:node_modules|dist|\.data|\.git|\.deployment|\.ssh|\.claude|\.codex|\.cloudflared)(\/|$)|\.(?:sqlite(?:-wal|-shm)?|db|log|tar|gz|zip)$|(^|\/)\.env(?:\..*)?$/.test(path) && !path.endsWith('.env.example')) {
    findings.push({ path, category: 'runtime-or-secret-file' });
  }
  const rules: [string, RegExp][] = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    ['provider-token', /\b(?:sk-ant-[A-Za-z0-9_-]{25,}|sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/],
    ['personal-home-path', /\/Users\/[A-Za-z0-9._-]+\/(?:workspace|\.personal-agent|\.ssh|\.claude)(?:\/|\b)/],
  ];
  for (const [index, line] of content.split('\n').entries()) for (const [category, pattern] of rules) {
    if (pattern.test(line)) findings.push({ path, category, line: index + 1 });
  }
  return findings;
}

export function checkShare() {
  const git = (args: string[]) => execFileSync('git', ['-C', projectDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, timeout: 10_000 });
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const findings = files.flatMap(path => {
    const info = lstatSync(join(projectDir, path));
    if (!info.isFile() || info.isSymbolicLink()) return [{ path, category: 'non-regular-file' }];
    return inspectShareFile(path, readFileSync(join(projectDir, path), 'utf8'));
  });
  for (const file of ['LICENSE', 'NOTICE', 'docs/third-party-licenses.md']) if (!files.includes(file)) findings.push({ path: file, category: 'missing-license-material' });
  const lock = JSON.parse(readFileSync(join(projectDir, 'package-lock.json'), 'utf8')) as { packages: Record<string, { resolved?: string; link?: boolean }> };
  for (const [path, pkg] of Object.entries(lock.packages)) if (pkg.resolved && !pkg.link && !pkg.resolved.startsWith('https://registry.npmjs.org/')) findings.push({ path, category: 'nonofficial-dependency-source' });
  const dirty = git(['status', '--porcelain']).trim().length > 0;
  return { result: findings.length ? 'NEEDS_ACTION' : 'PASS', scope: 'tracked source files only; heuristic inspection is not proof of absence of secrets',
    checkedFiles: files.length, findings, committedSourceReady: !dirty,
    thirdPartyDistribution: 'not included; do not package node_modules or dist under the project license',
    archiveNextAction: dirty ? 'Review and commit the intended source locally before using git archive.' : 'Use git archive for the reviewed commit; inspect the archive before sharing.' };
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw Object.assign(new Error('Usage'), { code: 'CLI_ARGUMENT' });
    const result = checkShare();
    console.log(JSON.stringify(result, null, 2));
    if (result.result !== 'PASS') process.exitCode = 1;
  } catch (error) { failCli(error); }
}
