// Stand-ins for the WhatsApp worker gateway (:4998) and the alert/heartbeat endpoints (:4999).
// Everything received is appended to events.jsonl for the E2E script to inspect.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const log = (kind, body) =>
  appendFileSync(
    new URL('./events.jsonl', import.meta.url),
    JSON.stringify({ kind, at: Date.now(), body }) + '\n',
  );
const read = (req) =>
  new Promise((r) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => r(b));
  });
createServer(async (req, res) => {
  const body = await read(req);
  if (req.url === '/internal/session') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ state: 'ready' }));
  }
  if (req.url === '/internal/send') {
    log('whatsapp', JSON.parse(body));
    res.writeHead(202);
    return res.end('{}');
  }
  res.writeHead(404);
  res.end();
}).listen(4998, '127.0.0.1');
createServer(async (req, res) => {
  const body = await read(req);
  log(req.url === '/heartbeat' ? 'heartbeat' : 'alert', { title: req.headers.title ?? null, body });
  res.writeHead(200);
  res.end('ok');
}).listen(4999, '127.0.0.1');
console.log('catcher ready');
