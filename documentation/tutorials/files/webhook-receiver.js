// webhook-receiver.js: a minimal WordJS webhook receiver that verifies every delivery.
// Usage: WEBHOOK_SECRET=whsec_... node webhook-receiver.js
const http = require('http');
const crypto = require('crypto');

const SECRET = process.env.WEBHOOK_SECRET;
const PORT = Number(process.env.PORT || 8787);
if (!SECRET) { console.error('Set WEBHOOK_SECRET to the whsec_… signing secret.'); process.exit(1); }

function verify(headers, rawBody, toleranceSec = 300) {
  const ts = Number(headers['x-wordjs-timestamp']);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${rawBody}`).digest('hex');
  const got = String(headers['x-wordjs-signature-256'] || '');
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/hook') { res.writeHead(404).end(); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!verify(req.headers, raw)) {
      console.log('REJECTED: bad signature or stale timestamp');
      res.writeHead(401).end();
      return;
    }
    const event = JSON.parse(raw);
    console.log(`${event.event}  delivery=${req.headers['x-wordjs-delivery']}  data=${JSON.stringify(event.data)}`);
    res.writeHead(204).end();
  });
}).listen(PORT, () => console.log(`Listening on :${PORT}/hook`));
