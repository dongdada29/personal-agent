// Original Node-only process owner. The control channel is private:
// POSIX uses fd 3 (stdout/stderr stay the engine child's streams); Windows uses
// Node IPC because extra anonymous-pipe fds are not inherited under detached
// spawn and net.Socket({ fd: 3 }) never becomes ready.
import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

/** Windows ESM loader treats `D:\file.mjs` as protocol `d:`; Node module args must be file://. */
function windowsNodeModuleArg(arg) {
  if (process.platform !== 'win32' || typeof arg !== 'string' || arg.startsWith('file:') || arg.startsWith('--')) return arg;
  if (!/^[A-Za-z]:[\\/]/.test(arg) || !/\.(mjs|cjs|js|ts)$/i.test(arg)) return arg;
  return pathToFileURL(arg).href;
}

const marker = process.argv[2];
if (process.argv.length !== 3 || !/^--personal-agent-owner=[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(marker ?? '')) process.exit(125);
const useIpc = process.env.PERSONAL_AGENT_OWNER_IPC === '1' && typeof process.send === 'function';
const gate = useIpc ? undefined : new Socket({ fd: 3, readable: true, writable: true });
let buffer = '';
const decoder = new StringDecoder('utf8');
let started = false;
let child;
let finished = false;
const startupTimer = setTimeout(() => { if (!started) process.exit(125); }, 30_000);
const send = (value) => {
  if (useIpc) {
    if (typeof process.send === 'function' && process.connected !== false) process.send(value);
    return;
  }
  if (gate && !gate.destroyed) gate.write(JSON.stringify(value) + '\n');
};
const finish = (result) => {
  if (finished) return;
  finished = true;
  clearTimeout(startupTimer);
  const payload = { type: 'EXIT', ...result };
  const code = result.exitCode ?? 0;
  if (useIpc) {
    if (typeof process.send !== 'function' || process.connected === false) { process.exit(code); return; }
    process.send(payload, () => process.exit(code));
    return;
  }
  if (!gate || gate.destroyed) process.exit(code);
  gate.end(JSON.stringify(payload) + '\n', () => process.exit(code));
};
const startChild = (request) => {
  if (started) return;
  if (request.type !== 'START' || typeof request.command !== 'string' || !request.command || request.command.includes('\0') ||
    !Array.isArray(request.args) || request.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) process.exit(125);
  started = true;
  clearTimeout(startupTimer);
  buffer = '';
  // Under Electron the owner itself runs as Node via ELECTRON_RUN_AS_NODE. Only a
  // child that is this same executable keeps it; any other program (including
  // other Electron apps) must not inherit the switch. NODE_CHANNEL_FD is the
  // owner's private IPC and must not leak into the engine/verification child.
  const env = { ...process.env };
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_UNIQUE_ID;
  delete env.PERSONAL_AGENT_OWNER_IPC;
  if (process.versions.electron && request.command !== process.execPath) delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(request.command, request.args.map(windowsNodeModuleArg), { detached: false, shell: false, windowsHide: true, env, stdio: ['inherit', 'inherit', 'inherit'] });
  // Windows has no process groups: the parent records this PID (and its creation
  // time) so orphaned descendants can still be found after this owner exits.
  if (child.pid !== undefined) send({ type: 'CHILD', pid: child.pid });
  child.once('error', (error) => finish({ exitCode: null, signal: null,
    spawnError: ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code) ? error.code : 'SPAWN_ERROR' }));
  child.once('exit', (exitCode, signal) => finish({ exitCode, signal }));
};
// TERM reaches the entire process group. Keep the owner identifiable while an
// active child ignores TERM, so recovery can safely escalate to group KILL.
process.on('SIGTERM', () => { if (!started) process.exit(0); });
process.on('SIGINT', () => { if (!started) process.exit(0); });
if (useIpc) {
  process.on('disconnect', () => { if (!started) process.exit(0); });
  process.on('message', (value) => {
    if (!value || typeof value !== 'object') process.exit(125);
    startChild(value);
  });
} else {
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
    startChild(request);
  });
}
send({ type: 'READY' });
