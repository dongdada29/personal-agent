// server-supervisor 测试用的假 server：按 desktop-main 的 IPC 协议应答。
// 行为由 argv[2] 控制：ready | error | hang | ignore-shutdown | crash-after-ready | echo-env
import { createServer } from 'node:http';

const behavior = process.argv[2] ?? 'ready';
let server;
process.on('message', (message) => {
  if (message?.type === 'start') {
    if (behavior === 'error') { process.send({ type: 'error', code: 'INSTANCE_LOCKED' }); setTimeout(() => process.exit(1), 10); return; }
    if (behavior === 'hang') return;
    server = createServer((request, response) => {
      const ok = request.headers.authorization === `Bearer ${message.token}`;
      response.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      response.end(JSON.stringify(behavior === 'echo-env' ? { env: process.env, argv: process.argv } : { ok }));
    });
    server.listen(0, '127.0.0.1', () => {
      process.send({ type: 'ready', port: server.address().port });
      if (behavior === 'crash-after-ready') setTimeout(() => process.exit(3), 50);
    });
  }
  if (message?.type === 'shutdown' && behavior !== 'ignore-shutdown') {
    server?.close(() => process.send({ type: 'stopped', exitCode: 0 }, () => process.exit(0)));
  }
});
