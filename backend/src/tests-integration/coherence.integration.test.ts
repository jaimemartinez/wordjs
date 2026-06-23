/**
 * Integration test for the cross-node coherence bus against a REAL Redis.
 *
 * Runs in `npm run test:integration` with REDIS_ENABLED=true. Skips when no Redis is reachable, so
 * it's a no-op locally and a real check in CI (which provisions a redis service). Verifies the
 * publish→subscribe round-trip that role invalidation and SSE fan-out rely on.
 */
const { test, after } = require('node:test');
const assert = require('node:assert');

require('../config/app');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Close the shared Redis connections ONCE after ALL tests. closeAll() quits the singleton
// connections, so a per-test close would break a later test in the same process (the bug this
// replaces). --test-force-exit is the backstop that exits even if a handle lingers.
after(async () => { try { await require('../core/cache').closeAll(); } catch { /* */ } });

test('coherence: Redis pub/sub round-trip (skipped if no Redis reachable)', async (t: any) => {
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
    // connections are closed once in the after() hook (not here) so later tests can still use them
});

test('coherence: wordjs:plugin-changed propagates across nodes via Redis (skipped if no Redis)', async (t: any) => {
    const cache = require('../core/cache');
    let up = false;
    for (let i = 0; i < 30; i++) { if (cache.pubsubAvailable()) { up = true; break; } await sleep(100); }
    if (!up) { await cache.closeAll(); return (t as any).skip('no reachable Redis (pubsubAvailable=false)'); }

    // Simulate the receiving node: subscribe the REAL coherence handler with stubbed plugin load/unload
    // so a published activate/deactivate (from a DIFFERENT origin) drives the cross-node dispatch.
    const coherence = require('../core/coherence');
    const plugins = require('../core/plugins');
    const seen: any[] = [];
    const origLoad = plugins.loadOnePlugin, origUnload = plugins.unloadOnePlugin;
    plugins.loadOnePlugin = (slug: string) => { seen.push(['load', slug]); return Promise.resolve(true); };
    plugins.unloadOnePlugin = (slug: string) => { seen.push(['unload', slug]); return true; };
    cache.subscribe('wordjs:plugin-changed', coherence.handlePluginChange);
    await sleep(400); // let SUBSCRIBE round-trip

    try {
        await cache.publish('wordjs:plugin-changed', JSON.stringify({ slug: 'demo-x', action: 'activate', origin: 'remote-node:9:zz' }));
        await cache.publish('wordjs:plugin-changed', JSON.stringify({ slug: 'demo-y', action: 'deactivate', origin: 'remote-node:9:zz' }));
        for (let i = 0; i < 40 && seen.length < 2; i++) await sleep(100);
        assert.ok(seen.some((c) => c[0] === 'load' && c[1] === 'demo-x'), 'remote activate → loadOnePlugin over Redis');
        assert.ok(seen.some((c) => c[0] === 'unload' && c[1] === 'demo-y'), 'remote deactivate → unloadOnePlugin over Redis');
    } finally {
        plugins.loadOnePlugin = origLoad; plugins.unloadOnePlugin = origUnload;
    }
});
