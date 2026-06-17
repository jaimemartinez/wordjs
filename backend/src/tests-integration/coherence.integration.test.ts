/**
 * Integration test for the cross-node coherence bus against a REAL Redis.
 *
 * Runs in `npm run test:integration` with REDIS_ENABLED=true. Skips when no Redis is reachable, so
 * it's a no-op locally and a real check in CI (which provisions a redis service). Verifies the
 * publish→subscribe round-trip that role invalidation and SSE fan-out rely on.
 */
const { test } = require('node:test');
const assert = require('node:assert');

require('../config/app');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('coherence: Redis pub/sub round-trip (skipped if no Redis reachable)', async (t) => {
    const cache = require('../core/cache');

    // Wait for the publisher connection to come up (config.redis.enabled must be set, e.g. REDIS_ENABLED=true).
    let up = false;
    for (let i = 0; i < 30; i++) { if (cache.pubsubAvailable()) { up = true; break; } await sleep(100); }
    if (!up) { await cache.closeAll(); return (t as any).skip('no reachable Redis (pubsubAvailable=false)'); }

    const CH = `test:coherence:${process.pid}`;
    let received: any = null;
    cache.subscribe(CH, (msg: string) => { received = msg; });
    await sleep(400); // let the SUBSCRIBE round-trip complete before publishing

    const ok = await cache.publish(CH, { hello: 'world', pid: process.pid });
    assert.strictEqual(ok, true, 'publish should succeed when Redis is up');

    for (let i = 0; i < 40 && received === null; i++) await sleep(100);
    assert.ok(received !== null, 'subscriber should receive the published message');
    const parsed = JSON.parse(received);
    assert.strictEqual(parsed.hello, 'world', 'payload round-trips intact');
    assert.strictEqual(parsed.pid, process.pid);

    await cache.closeAll(); // release connections so the test process can exit
});
