/**
 * Multi-node coherence integration test — "node A" (the driver).
 *
 * Proves the ONE property that only holds across multiple nodes: an option (e.g. a role/capability
 * change) written on node A is observed on node B — a SEPARATE OS PROCESS — via the shared Postgres +
 * Redis coherence path, with no restart and no shared memory. This is the property
 * documentation/multi-node.md promises ("Role/permission edits — propagated across nodes over Redis
 * `wordjs:option-changed`").
 *
 * What this proves precisely:
 *   - Node A calls core/options.updateOption(), which writes the value to the SHARED Postgres, deletes
 *     the cache key cluster-wide, and publishes `wordjs:option-changed` over Redis.
 *   - Node B (multinode-peer.ts, forked as its own process with its own DB pool and its own Redis
 *     connections) receives that publish and reads the value back from the SHARED Postgres.
 *   - The value node B reads equals the exact value node A wrote.
 * The write value is a fresh random UUID per run, so node B cannot have it except through the shared
 * infrastructure. Break the publish, the Postgres sharing, or the invalidation and node B never sees
 * the value → the test times out and FAILS.
 *
 * What this does NOT prove (kept honest): it does not stand up two gateway-fronted, mTLS-enrolled full
 * app stacks. Two *backend cores* sharing Postgres + Redis IS the multi-node unit (the gateway is a
 * single, non-replicated node and the frontend is stateless SSR — see multi-node.md), and the coherence
 * bus lives entirely in the backend core, so replicating that core is what exercises the property. The
 * gateway/frontend/TLS layers add no coherence surface for this test to cover.
 *
 * Runs via `npm run test:multinode` (a dedicated CI leg with its own Postgres 16 + Redis 7). Locally,
 * with no Postgres/Redis reachable, it SKIPS. In CI (WORDJS_CI_DB=1) the services are wired up, so an
 * unreachable Postgres/Redis is a HARD failure — never a silent green skip (mirrors
 * driver-conformance.test.ts and coherence.integration.test.ts).
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');

process.env.REDIS_ENABLED = 'true'; // must be set before core/cache loads config
require('../config/app');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEY = 'wordjs_multinode_probe';

const skipOrFail = (t: any, reason: string) => {
    if (process.env.WORDJS_CI_DB === '1') assert.fail(reason);
    return (t as any).skip(reason);
};

let child: any = null;

after(async () => {
    try { if (child) { child.send('shutdown'); await sleep(300); child.kill('SIGKILL'); } } catch { /* */ }
    try { await require('../core/cache').closeAll(); } catch { /* */ }
    try { await require('../config/database').closeDatabase(); } catch { /* */ }
});

test('multi-node: an option written on node A is observed by node B (separate process) via shared Postgres + Redis', async (t: any) => {
    const cache = require('../core/cache');
    const database = require('../config/database');

    // Node A connects to the shared Postgres. connect() falls back to config.db, whose defaults
    // (localhost:5432, user postgres, password 'password', db 'wordjs') match the CI postgres:16 service.
    try {
        await database.init({ driver: 'postgres' });
    } catch (e: any) {
        return skipOrFail(t, `no reachable Postgres: ${e && e.message}`);
    }

    // Node A's own Redis pub/sub must be live too — otherwise this isn't a multi-node run.
    let up = false;
    for (let i = 0; i < 50; i++) { if (cache.pubsubAvailable()) { up = true; break; } await sleep(100); }
    if (!up) return skipOrFail(t, 'no reachable Redis (pubsubAvailable=false)');

    // Ensure the shared `options` table exists (idempotent; column shape + unique index match
    // config/database.ts initializeSchema so the ON CONFLICT (option_name) upsert in updateOption works).
    const { dbAsync } = database;
    try {
        await dbAsync.exec(
            "CREATE TABLE IF NOT EXISTS options (option_id SERIAL PRIMARY KEY, option_name TEXT NOT NULL DEFAULT '', option_value TEXT NOT NULL DEFAULT '', autoload TEXT NOT NULL DEFAULT 'yes')"
        );
        await dbAsync.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_options_name ON options (option_name)');
    } catch (e: any) {
        return skipOrFail(t, `could not ensure shared options schema: ${e && e.message}`);
    }

    // Fork node B as a SEPARATE process sharing the same Postgres + Redis. Explicit execArgv so the
    // child does NOT inherit the parent's `--test`/`--test-force-exit` flags (which would turn it into
    // a second test runner); ts-node/register lets it require the backend's .ts modules.
    const peerPath = path.join(__dirname, 'multinode-peer.ts');
    child = fork(peerPath, [], {
        execArgv: ['-r', 'ts-node/register'],
        cwd: path.join(__dirname, '..', '..'), // backend/ — parity with `cd backend && npm start`
        env: { ...process.env, REDIS_ENABLED: 'true', WJ_MN_KEY: KEY },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    const uniqueVal = 'v-' + crypto.randomUUID();
    const { updateOption } = require('../core/options');

    const result: any = await new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('timeout: node B never observed node A\'s option write (30s)')),
            30000
        );
        child.on('message', async (m: any) => {
            if (!m || typeof m !== 'object') return;
            if (m.type === 'ready') {
                // Node B is subscribed. Node A writes the option now.
                await sleep(200);
                try { await updateOption(KEY, uniqueVal); }
                catch (e: any) { clearTimeout(timer); reject(e); }
            } else if (m.type === 'observed') {
                clearTimeout(timer); resolve(m);
            } else if (m.type === 'error') {
                clearTimeout(timer); reject(new Error(m.error));
            }
        });
        child.on('exit', (code: number) => { clearTimeout(timer); reject(new Error(`peer exited early (code ${code})`)); });
    });

    assert.strictEqual(result.name, KEY, 'node B must report the probe key it observed');
    assert.strictEqual(
        result.value,
        uniqueVal,
        'node B (a separate process) must read node A\'s exact written value from shared Postgres'
    );
});
