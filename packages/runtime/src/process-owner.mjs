// Original Node-only process owner. fd 3 is a private startup/control channel;
// stdout/stderr remain exclusively the engine or verification child's streams.
import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

const marker = process.argv[2];
if (process.argv.length !== 3 || !/^--personal-agent-owner=[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(marker ?? '')) process.exit(125);
const gate = new Socket({ fd: 3, readable: true, writable: true });
let buffer = '';
const decoder = new StringDecoder('utf8');
let started = false;
let child;
let finished = false;
const startupTimer = setTimeout(() => { if (!started) process.exit(125); }, 30_000);
const send = (value) => { if (!gate.destroyed) gate.write(JSON.stringify(value) + '\n'); };
const finish = (result) => {
  if (finished) return;
  finished = true;
  clearTimeout(startupTimer);
  if (gate.destroyed) process.exit(result.exitCode ?? 0);
  gate.end(JSON.stringify({ type: 'EXIT', ...result }) + '\n', () => process.exit(result.exitCode ?? 0));
};
// TERM reaches the entire process group. Keep the owner identifiable while an
// active child ignores TERM, so recovery can safely escalate to group KILL.
process.on('SIGTERM', () => { if (!started) process.exit(0); });
process.on('SIGINT', () => { if (!started) process.exit(0); });
gate.on('error', () => { if (!started) process.exit(125); });
gate.on('end', () => { if (!started) process.exit(0); });
gate.on('data', (chunk) => {
  if (started) return;
  buffer += decoder.write(chunk);
  if (Buffer.byteLength(buffer, 'utf8') > 8 * 1024 * 1024) process.exit(125);
  const newline = buffer.indexOf('\n');
  if (newline < 0) return;
  let request;
  try { request = JSON.parse(buffer.slice(0, newline)); } catch { process.exit(125); }
  if (request.type !== 'START' || typeof request.command !== 'string' || !request.command || request.command.includes('\0') ||
    !Array.isArray(request.args) || request.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) process.exit(125);
  started = true;
  clearTimeout(startupTimer);
  buffer = '';
  child = spawn(request.command, request.args, { detached: false, shell: false, stdio: ['inherit', 'inherit', 'inherit'] });
  child.once('error', (error) => finish({ exitCode: null, signal: null,
    spawnError: ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code) ? error.code : 'SPAWN_ERROR' }));
  child.once('exit', (exitCode, signal) => finish({ exitCode, signal }));
});
send({ type: 'READY' });
