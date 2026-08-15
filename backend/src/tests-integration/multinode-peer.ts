/**
 * Multi-node coherence PEER — "node B".
 *
 * Forked as a SEPARATE OS PROCESS by multinode-coherence.integration.ts. It is deliberately NOT named
 * `*.test.ts`, so neither the `test:integration` nor the `test` glob ever collects it as a test file.
 *
 * It runs the REAL backend coherence stack — core/cache (Redis pub/sub) + core/options (reads through
 * the shared cache, falls back to the shared database) + the Postgres driver — in its own process, with
 * its own memory and its own DB connection pool. It subscribes to the cross-node option bus
 * (`wordjs:option-changed`, the same channel role/capability edits ride) and, when node A writes the
 * probe option, reads the value back from the SHARED Postgres and reports it to the parent over IPC.
 *
 * Because this process shares NOTHING with the parent except Postgres + Redis, observing node A's write
 * here can only have travelled through that shared infrastructure — which is exactly the multi-node
 * coherence property (documentation/multi-node.md). A single-node install has no second process to
 * observe anything, so this can never pass by accident on the in-process path.
 */

const KEY = process.env.WJ_MN_KEY || 'wordjs_multinode_probe';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function send(msg: any): void {
    if (typeof process.send === 'function') process.send(msg);
}

async function shutdown(): Promise<void> {
    try { await require('../core/cache').closeAll(); } catch { /* already closing */ }
    try { await require('../config/database').closeDatabase(); } catch { /* already closing */ }
    process.exit(0);
}

async function main(): Promise<void> {
    process.env.REDIS_ENABLED = 'true';
    const cache = require('../core/cache');
    const database = require('../config/database');

    // Node B connects to the SAME shared Postgres (config.db defaults match the CI postgres:16 service,
    // exactly like driver-conformance.test.ts). This is an INDEPENDENT connection from node A's.
    await database.init({ driver: 'postgres' });

    // Wait for this process's own Redis pub/sub connection to come up.
    let up = false;
    for (let i = 0; i < 50; i++) { if (cache.pubsubAvailable()) { up = true; break; } await sleep(100); }
    if (!up) { send({ type: 'error', error: 'peer: no reachable Redis (pubsubAvailable=false)' }); return shutdown(); }

    const { getOption } = require('../core/options');

    // Subscribe to the cross-node option bus. When node A's updateOption() publishes the probe key,
    // read the value back from the SHARED Postgres and report it. getOption reads through the cache
    // (which node A invalidated cluster-wide via cache.del → 'wordjs:cache-del'), so a stale peer L1
    // cannot mask a broken write.
    cache.subscribe('wordjs:option-changed', (name: string) => {
        if (name !== KEY) return;
        Promise.resolve(getOption(KEY))
            .then((value: any) => send({ type: 'observed', name, value }))
            .catch((e: any) => send({ type: 'error', error: 'peer getOption failed: ' + (e && e.message) }));
    });

    await sleep(600); // let the SUBSCRIBE round-trip complete before signaling readiness to node A
    send({ type: 'ready', pid: process.pid });
}

process.on('message', (m: any) => { if (m === 'shutdown') void shutdown(); });
process.on('SIGTERM', () => void shutdown());

main().catch((e: any) => { send({ type: 'error', error: String((e && e.message) || e) }); void shutdown(); });
