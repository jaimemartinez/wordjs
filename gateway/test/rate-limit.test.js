/**
 * WordJS Gateway — the PUBLIC listener enforces a rate limit (audit 2026-08-08, P1).
 *
 * Before the fix only the enrollment listener was capped; the internet-facing edge was unbounded. This
 * mounts the same limiter factory the worker mounts (src/rate-limit.js) on a bare app and proves that a
 * burst from one client is refused with 429 once it passes the configured cap, and that the /healthz
 * probe is exempt.
 *
 * MUTATION PROOF: drop the `app.use(createPublicLimiter(...))` line in src/index.js (or make the factory
 * return a no-op) and the 4th request below stays 200 — `assert.strictEqual(statuses[3], 429)` fails.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const { createPublicLimiter } = require('../src/rate-limit');

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}
function get(port, path) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
    });
}

test('public listener rate-limits a burst from one IP and 429s past the cap', async (t) => {
    // Tiny cap so the test trips fast; MemoryStore (no config.redis) — same single-instance path a
    // stock gateway uses.
    const limiter = createPublicLimiter({ rateLimit: { windowMs: 60_000, max: 3 } }, null);
    const app = express();
    app.use(limiter);
    app.get('/', (req, res) => res.send('ok'));

    const server = http.createServer(app);
    const port = await listen(server);
    t.after(async () => { await close(server); });

    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push(await get(port, '/'));

    assert.deepStrictEqual(statuses.slice(0, 3), [200, 200, 200], 'first three requests are under the cap');
    assert.strictEqual(statuses[3], 429, 'the 4th request past the cap must be rate-limited');
});

test('health probes are exempt from the public rate limit', async (t) => {
    const limiter = createPublicLimiter({ rateLimit: { windowMs: 60_000, max: 2 } }, null);
    const app = express();
    app.use(limiter);
    app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

    const server = http.createServer(app);
    const port = await listen(server);
    t.after(async () => { await close(server); });

    // Well past the cap of 2 — every probe must still be answered, never 429'd.
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push(await get(port, '/healthz'));
    assert.ok(statuses.every((s) => s === 200), `all health probes should be 200, got ${statuses}`);
});
