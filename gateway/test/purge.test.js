/**
 * WordJS Gateway — CROSS-MACHINE cache purge fan-out (src/purge.js).
 *
 * In separate mode the backend cannot purge the frontend's Next.js cache itself: its `frontendUrl` is
 * the gateway's public origin (whose /api prefix routes straight back to the backend), and a cluster may
 * run N frontend replicas. The gateway is the only party that knows where the frontends actually are —
 * its registry — so it resolves the targets and delivers the purge. These tests pin that behaviour:
 *
 *  - the SAME frontend node registers many route prefixes ('/', '/admin', '/_next', …), so the targets
 *    must be de-duplicated or one publish would purge each replica half a dozen times;
 *  - backend targets must never be purged (they have no /api/revalidate — and /api is the backend's own
 *    route, so hitting it would send the purge back where it came from);
 *  - every registered frontend gets the request, carrying the shared secret, and one dead replica must
 *    NOT hide the others (partial delivery is reported, never thrown).
 *
 * MUTATION PROOF: delete src/purge.js (the state before this feature) and every test here fails at
 * require. Drop the `urls` Set from collectFrontendTargets and the dedupe test sees 3 targets instead of
 * 1; forward the raw body instead of sanitizePurgePayload and the cap test sees 150 tags instead of 100.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { sanitizePurgePayload, collectFrontendTargets, fanOutPurge } = require('../src/purge');

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

// A stub frontend: records what it received on /api/revalidate and answers with `status`.
function stubFrontend(status = 200) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            seen.push({ url: req.url, method: req.method, secret: req.headers['x-revalidate-secret'], body });
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: status === 200 }));
        });
    });
    return { server, seen };
}

test('collectFrontendTargets: one node registering six routes is ONE purge target', () => {
    const registry = new Map([
        ['/', { name: 'frontend', targets: new Set(['https://10.0.0.7:3001']) }],
        ['/admin', { name: 'frontend', targets: new Set(['https://10.0.0.7:3001']) }],
        ['/_next', { name: 'frontend', targets: new Set(['https://10.0.0.7:3001']) }],
        ['/api', { name: 'backend', targets: new Set(['https://10.0.0.6:4000']) }],
        ['/uploads', { name: 'backend', targets: new Set(['https://10.0.0.6:4000']) }],
    ]);
    assert.deepStrictEqual(collectFrontendTargets(registry), ['https://10.0.0.7:3001']);
});

test('collectFrontendTargets: every replica is returned, and the backend never is', () => {
    const registry = new Map([
        ['/', { name: 'frontend', targets: new Set(['https://10.0.0.7:3001', 'https://10.0.0.8:3001']) }],
        ['/api', { name: 'backend', targets: new Set(['https://10.0.0.6:4000']) }],
    ]);
    const targets = collectFrontendTargets(registry);
    assert.deepStrictEqual(targets.sort(), ['https://10.0.0.7:3001', 'https://10.0.0.8:3001']);
});

test('collectFrontendTargets: accepts the persisted plain-object registry shape too', () => {
    const registry = {
        '/': { name: 'frontend', targets: ['https://10.0.0.7:3001'] },
        '/api': { name: 'backend', targets: ['https://10.0.0.6:4000'] },
    };
    assert.deepStrictEqual(collectFrontendTargets(registry), ['https://10.0.0.7:3001']);
});

test('collectFrontendTargets: an empty / missing registry is not an error', () => {
    assert.deepStrictEqual(collectFrontendTargets(new Map()), []);
    assert.deepStrictEqual(collectFrontendTargets(null), []);
});

test('sanitizePurgePayload: caps the list, drops non-strings and relative paths', () => {
    const payload = sanitizePurgePayload({
        tags: [...Array(150).keys()].map((i) => `post:${i}`).concat([null, 42, '']),
        paths: ['/', '/hello', 'not-a-path', '/'.padEnd(500, 'x')],
    });
    assert.strictEqual(payload.tags.length, 100, 'tags are capped at 100');
    assert.ok(payload.tags.every((t) => typeof t === 'string' && t.length));
    assert.deepStrictEqual(payload.paths, ['/', '/hello'], 'relative and over-long paths are dropped');
});

test('sanitizePurgePayload: a garbage body yields empty lists, never a throw', () => {
    assert.deepStrictEqual(sanitizePurgePayload(undefined), { tags: [], paths: [] });
    assert.deepStrictEqual(sanitizePurgePayload('nope'), { tags: [], paths: [] });
    assert.deepStrictEqual(sanitizePurgePayload({ tags: 'posts' }), { tags: [], paths: [] });
});

test('fanOutPurge: EVERY registered frontend receives the purge, with the shared secret', async () => {
    const a = stubFrontend(200);
    const b = stubFrontend(200);
    const portA = await listen(a.server);
    const portB = await listen(b.server);
    try {
        const out = await fanOutPurge({
            targets: [`http://127.0.0.1:${portA}`, `http://127.0.0.1:${portB}`],
            payload: { tags: ['posts', 'post:hello'], paths: ['/'] },
            secret: 's3cr3t',
        });
        assert.strictEqual(out.delivered, 2);
        assert.strictEqual(out.failed, 0);
        for (const stub of [a, b]) {
            assert.strictEqual(stub.seen.length, 1);
            assert.strictEqual(stub.seen[0].url, '/api/revalidate');
            assert.strictEqual(stub.seen[0].method, 'POST');
            assert.strictEqual(stub.seen[0].secret, 's3cr3t');
            assert.deepStrictEqual(JSON.parse(stub.seen[0].body), { tags: ['posts', 'post:hello'], paths: ['/'] });
        }
    } finally {
        await close(a.server);
        await close(b.server);
    }
});

test('fanOutPurge: a dead replica is reported, and does NOT stop the healthy one', async () => {
    const alive = stubFrontend(200);
    const port = await listen(alive.server);
    const dead = http.createServer(() => {});
    const deadPort = await listen(dead);
    await close(dead); // nothing is listening on deadPort any more
    try {
        const out = await fanOutPurge({
            targets: [`http://127.0.0.1:${port}`, `http://127.0.0.1:${deadPort}`],
            payload: { tags: ['posts'], paths: [] },
            secret: 's3cr3t',
            timeoutMs: 1500,
        });
        assert.strictEqual(out.delivered, 1, 'the reachable frontend was still purged');
        assert.strictEqual(out.failed, 1, 'the unreachable one is reported, not swallowed');
        assert.strictEqual(alive.seen.length, 1);
        assert.ok(out.results.find((r) => !r.ok).error, 'the failure carries a reason');
    } finally {
        await close(alive.server);
    }
});

test('fanOutPurge: a frontend that REFUSES the secret counts as failed (403 is not delivery)', async () => {
    const rejecting = stubFrontend(403);
    const port = await listen(rejecting.server);
    try {
        const out = await fanOutPurge({
            targets: [`http://127.0.0.1:${port}`],
            payload: { tags: ['settings'], paths: ['/'] },
            secret: 'wrong',
        });
        assert.strictEqual(out.delivered, 0);
        assert.strictEqual(out.failed, 1);
        assert.strictEqual(out.results[0].status, 403);
    } finally {
        await close(rejecting.server);
    }
});

test('fanOutPurge: a malformed target url fails that target only', async () => {
    const out = await fanOutPurge({ targets: ['not a url'], payload: { tags: ['posts'], paths: [] }, secret: 'x' });
    assert.strictEqual(out.failed, 1);
    assert.match(out.results[0].error, /invalid target url/);
});
