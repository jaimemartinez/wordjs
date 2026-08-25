/**
 * F6 certification — outbox duplicates, retries and the degraded-cache dimension, on EVERY certified
 * SQL engine.
 *
 * WHY THIS FILE EXISTS AT ALL. F3 shipped the durable outbox and proved its guarantees, but every
 * phase suite (f0…f5) opens with the same two lines:
 *
 *     config.dbPath = TMP_DB;
 *     config.dbDriver = 'sqlite-native';
 *
 * so the phase guarantees are certified on ONE engine. F3's own exit criterion is "SQLite, PostgreSQL
 * and MySQL produce the same result", and `driver-conformance.test.ts` does carry the SQL *shapes*
 * (guarded lease claim, select-then-delete prune, pinned transaction) onto real Postgres and MySQL —
 * but it runs them against hand-built `conf_*` tables, not against the real module. Nothing anywhere
 * drives `core/content-outbox` itself on anything but SQLite. This file closes that: it parametrises
 * the outbox guarantee over `F6_CERTIFIED_ENGINES` and drives the REAL module, the REAL schema
 * bootstrap and the REAL effect (webhook fan-out), so "the phase holds on three engines" is executed
 * rather than inferred.
 *
 * WHAT EACH TEST IS HERE TO CATCH — the defect, not the happy path:
 *   · control            — a harness that connects, bootstraps and delivers nothing would make every
 *                          "exactly one effect" assertion below vacuously true. The control asserts a
 *                          delivery DID happen and an effect row DID appear before anything else runs.
 *   · duplicate delivery — at-least-once means a worker that dies after calling the hook but before
 *                          writing `processed` gets its lease expired and the event REPLAYED. If the
 *                          effect were keyed by anything but the immutable event_id (a timestamp, an
 *                          auto id, nothing at all) the subscriber would be charged/notified/queued
 *                          twice. The test replays the same row and requires the hook to fire AGAIN
 *                          while the effect count stays at one.
 *   · expired lease      — the retry must reuse the SAME event_id. A worker that minted a fresh id on
 *                          retry would defeat every downstream dedup key while looking healthy.
 *   · racing workers     — two nodes reclaiming one expired lease must produce one delivery, not two.
 *   · degraded cache     — the Redis leg of the certification matrix, in-process. A cache failure
 *                          during delivery must leave the event RETRYABLE (never lost, never marked
 *                          processed) and the eventual retry must not produce a second effect.
 *
 * NON-SQLITE ENGINES USE A DEDICATED DATABASE (`wordjs_f6cert`), never the shared `wordjs` one that
 * driver-conformance and migration-parity write into. Sharing it would have this file's core schema
 * collide with migration-parity's hand-rolled `options`/`notifications` tables in the same CI job.
 *
 * SKIP POLICY. Locally a missing engine is a graceful skip. Under WORDJS_CI_DB=1 the service
 * containers are wired precisely so the engine IS exercised, so an unreachable engine is a HARD
 * FAILURE — the same contract driver-conformance.test.ts and the integration suites already use. A
 * certification leg that self-skips and reports PASS is what this repository has had to fix twice.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_DB = path.join(os.tmpdir(), `wjs-f6-outbox-${STAMP}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const { dbAsync } = database;
const Post = require('../models/Post');
const Webhook = require('../models/Webhook');
const webhooks = require('../core/webhooks');
const cache = require('../core/cache');
const { addAction, removeAction } = require('../core/hooks');
const outbox = require('../core/content-outbox');

/**
 * F6_CERTIFIED_ENGINES — the engine matrix of the F6 certification.
 *
 * This literal is the single source of the matrix: `.github/workflows/f6-certification.yml` greps it
 * out of BOTH F6 test files and refuses to run unless (a) the two files agree and (b) every non-SQLite
 * engine named here has a service container in that workflow. Add an engine to this array and the
 * workflow gate goes red until a service exists for it; provision a service nothing here names and it
 * goes red the other way. That is the whole point: a matrix nobody can quietly shrink.
 */
const F6_CERTIFIED_ENGINES = ['sqlite-native', 'postgres', 'mysql'];

/** Dedicated certification database — never the shared `wordjs` one other suites mutate. */
const CERT_DB = 'wordjs_f6cert';

let sequence = 0;
const unique = (prefix: string) => `${prefix}-${process.pid}-${++sequence}`;

// clearTimeout is load-bearing, not tidiness: a ref'd timer left armed after connect() rejects fast
// keeps this subprocess's event loop alive until it fires, and --test-force-exit then hard-kills the
// process mid-IPC. driver-conformance.test.ts documents the same trap.
const withTimeout = (promise: Promise<any>, ms: number) => {
    let timer: any;
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
};

function skipOrFail(t: any, reason: string): void {
    if (process.env.WORDJS_CI_DB === '1') assert.fail(`F6 certification cannot skip in CI: ${reason}`);
    return t.skip(reason);
}

function engineCoordinates(engine: string): Record<string, any> {
    if (engine === 'postgres') {
        return {
            host: process.env.PGHOST || '127.0.0.1',
            port: Number(process.env.PGPORT) || 5432,
            user: process.env.PGUSER || 'postgres',
            password: process.env.PGPASSWORD ?? 'password',
            name: process.env.PGDATABASE || 'wordjs',
        };
    }
    return {
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT) || 3306,
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD ?? 'password',
        name: process.env.MYSQL_DB || 'wordjs',
    };
}

/**
 * Point the singleton at `engine` and bootstrap the REAL core schema on it. Returns null on success
 * or a human reason on unavailability — never throws, so a missing engine degrades to one decision
 * (skip or hard-fail) taken per test instead of exploding a before() hook.
 */
async function bringUpEngine(engine: string): Promise<string | null> {
    if (engine === 'sqlite-native') {
        try { require('../drivers/sqlite-native-async').dbPath = TMP_DB; }
        catch (error: any) { return `better-sqlite3 not loadable: ${error && error.message}`; }
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        return null;
    }

    let driver: any;
    try { driver = require(`../drivers/${engine}`); }
    catch (error: any) { return `${engine} driver not loadable: ${error && error.message}`; }

    const base = engineCoordinates(engine);
    driver.config = { ...base };
    try { await withTimeout(driver.connect(), 8000); }
    catch (error: any) { return `no reachable ${engine}: ${error && error.message}`; }

    // CERT_DB is a module constant, never input — but CREATE DATABASE cannot be parameterised, so it
    // is spelled out literally here rather than interpolated from anything a caller controls.
    //
    // DROPPED FIRST, so every engine starts where sqlite already started. The sqlite leg gets a fresh
    // temp file each run; postgres and mysql were reusing a named database that was created if absent
    // and never cleaned. So the certification's result depended on how many times it had been run
    // before: on the second local run the fan-out found the previous run's webhook as well, and
    // `effectsFor` — which counts by source_event_id across every webhook — returned one row per
    // accumulated webhook. A fresh CI runner hides this completely, which is exactly why it survived:
    // the engine everyone runs locally is the one leg that was already isolated.
    //
    // Dropping is safe and is the point: this database exists only for this certification, is named by
    // a module constant, and is recreated on the next line.
    try {
        if (engine === 'postgres') {
            await driver.exec(`DROP DATABASE IF EXISTS ${CERT_DB}`);
            await driver.exec(`CREATE DATABASE ${CERT_DB}`);
        } else {
            await driver.exec(`DROP DATABASE IF EXISTS \`${CERT_DB}\``);
            await driver.exec(`CREATE DATABASE \`${CERT_DB}\``);
        }
    } catch (error: any) {
        try { await driver.close(); } catch { /* best effort */ }
        return `cannot provision the ${engine} certification database: ${error && error.message}`;
    }
    try { await driver.close(); } catch { /* best effort */ }

    driver.config = { ...base, name: CERT_DB };
    await database.init({ driver: engine });
    await database.initializeDatabase();
    return null;
}

async function scalar(sql: string, params: any[] = []): Promise<number> {
    const row = await dbAsync.get(sql, params);
    if (!row) return 0;
    const value = row.c ?? row.C ?? Object.values(row)[0];
    return Number(value) || 0;
}

/** The REAL downstream effect of one content event: durable webhook deliveries keyed by event id. */
async function effectsFor(eventId: string): Promise<number> {
    return await scalar('SELECT COUNT(*) AS c FROM webhook_deliveries WHERE source_event_id = ?', [eventId]);
}

async function outboxRow(id: number): Promise<any> {
    return await dbAsync.get('SELECT * FROM content_outbox WHERE id = ?', [id]);
}

/** Put a row back into the exact state a worker that died mid-delivery leaves behind. */
async function expireLease(id: number): Promise<void> {
    const now = await outbox.databaseNowSeconds();
    await dbAsync.run(
        `UPDATE content_outbox
         SET status = 'processing', claim_token = 'f6-dead-worker', claimed_until = ?, processed_at = NULL
         WHERE id = ?`,
        [now - 1, id]
    );
}

for (const engine of F6_CERTIFIED_ENGINES) {
    describe(`F6 outbox certification on ${engine}`, () => {
        let unavailable: string | null = 'engine not brought up';
        let webhookId = 0;
        let hookCalls = 0;
        const countingListener = async () => { hookCalls++; };

        before(async () => {
            try { unavailable = await bringUpEngine(engine); }
            catch (error: any) { unavailable = `${engine} bootstrap failed: ${error && error.message}`; }
            if (unavailable) return;
            webhooks.registerListeners();
            addAction('wp_insert_post', countingListener);
            const created = await Webhook.create({
                userId: 1,
                name: `f6-cert-${engine}`,
                url: 'https://example.com/f6-certification',
                events: 'post.created',
            });
            webhookId = created.id;
        });

        after(async () => {
            try { removeAction('wp_insert_post', countingListener); } catch { /* best effort */ }
            try { webhooks.unregisterListeners(); } catch { /* best effort */ }
            // Close on EVERY engine, not just SQLite: a live Postgres/MySQL pool keeps the event loop
            // alive and --test-force-exit then hard-kills the subprocess mid-IPC (the intermittent
            // deserialization failure driver-conformance.test.ts documents).
            try { await database.closeDatabase(); } catch { /* best effort */ }
            if (engine === 'sqlite-native') {
                for (const file of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
                    try { if (fs.existsSync(file)) fs.rmSync(file, { force: true }); } catch { /* best effort */ }
                }
            }
        });

        /**
         * ANTI-VACUITY CONTROL. Every assertion below counts effects and expects the count to stay at
         * one. If the harness never delivered anything, all of them would pass while proving nothing —
         * the "self-skips and counts as PASS" failure this programme has already shipped twice. This
         * test fails unless a real mutation produced a real event AND a real effect row.
         */
        test('control: one committed mutation produces one delivered event and one effect', async (t: any) => {
            if (unavailable) return skipOrFail(t, unavailable);
            assert.ok(webhookId > 0, 'the certification webhook must exist or the effect can never appear');

            const before = hookCalls;
            const post = await Post.create({ authorId: 1, title: unique('f6-control'), content: 'body', status: 'draft' });
            const row = await dbAsync.get('SELECT * FROM content_outbox WHERE aggregate_id = ?', [post.id]);

            assert.ok(row, 'the mutation persisted a content event in its own transaction');
            assert.strictEqual(row.status, 'processed', 'the post-commit kick delivered it');
            assert.strictEqual(Number(row.attempts), 1);
            assert.strictEqual(hookCalls, before + 1, 'the content hook ran exactly once for one mutation');
            assert.strictEqual(await effectsFor(row.event_id), 1, 'exactly one durable effect for one event');
        });

        test('a replayed delivery calls the hook again but does not duplicate the effect', async (t: any) => {
            if (unavailable) return skipOrFail(t, unavailable);
            const post = await Post.create({ authorId: 1, title: unique('f6-duplicate'), content: 'body', status: 'draft' });
            const first = await dbAsync.get('SELECT * FROM content_outbox WHERE aggregate_id = ?', [post.id]);
            assert.strictEqual(first.status, 'processed');
            assert.strictEqual(await effectsFor(first.event_id), 1);

            const before = hookCalls;
            await expireLease(Number(first.id));
            assert.strictEqual(await outbox.dispatchOne(Number(first.id)), true, 'an expired lease is reclaimed by the next worker');

            const replayed = await outboxRow(Number(first.id));
            assert.strictEqual(replayed.status, 'processed');
            assert.strictEqual(
                hookCalls,
                before + 1,
                'delivery is genuinely at-least-once — the hook really did run a SECOND time'
            );
            assert.strictEqual(
                await effectsFor(first.event_id),
                1,
                'the effect is keyed by the immutable event id, so the duplicate delivery changed nothing'
            );
        });

        test('a retry carries the same immutable event id and a higher attempt count', async (t: any) => {
            if (unavailable) return skipOrFail(t, unavailable);
            const post = await Post.create({ authorId: 1, title: unique('f6-immutable'), content: 'body', status: 'draft' });
            const first = await dbAsync.get('SELECT * FROM content_outbox WHERE aggregate_id = ?', [post.id]);
            const eventId = first.event_id;
            const attempts = Number(first.attempts);

            await expireLease(Number(first.id));
            assert.strictEqual(await outbox.dispatchOne(Number(first.id)), true);

            const retried = await outboxRow(Number(first.id));
            assert.strictEqual(retried.event_id, eventId, 'a fresh id on retry would defeat every downstream dedup key');
            assert.strictEqual(Number(retried.attempts), attempts + 1, 'the retry is counted, so a poison event can still reach the dead letter');
        });

        test('two workers reclaiming one expired lease produce exactly one delivery', async (t: any) => {
            if (unavailable) return skipOrFail(t, unavailable);
            const post = await Post.create({ authorId: 1, title: unique('f6-race'), content: 'body', status: 'draft' });
            const row = await dbAsync.get('SELECT * FROM content_outbox WHERE aggregate_id = ?', [post.id]);
            await expireLease(Number(row.id));

            const before = hookCalls;
            const results = await Promise.all([
                outbox.dispatchOne(Number(row.id)),
                outbox.dispatchOne(Number(row.id)),
            ]);

            assert.strictEqual(results.filter(Boolean).length, 1, 'the guarded claim is atomic on this engine');
            assert.strictEqual(hookCalls, before + 1, 'the loser never entered delivery');
            assert.strictEqual(await effectsFor(row.event_id), 1);
        });

        /**
         * The Redis leg of the certification matrix, in-process. `.github/workflows/f6-certification.yml`
         * runs this whole file twice — once with a reachable Redis and once with Redis configured but
         * dead — so the outer matrix covers "connected AND degraded". This test covers the sharper
         * inner case: a cache layer that FAILS rather than degrades quietly. The event must not be lost
         * and must not be marked processed, and the eventual retry must not produce a second effect.
         */
        test('a failing cache leaves the event retryable and the retry adds no second effect', async (t: any) => {
            if (unavailable) return skipOrFail(t, unavailable);
            const post = await Post.create({ authorId: 1, title: unique('f6-degraded'), content: 'body', status: 'draft' });
            const row = await dbAsync.get('SELECT * FROM content_outbox WHERE aggregate_id = ?', [post.id]);
            assert.strictEqual(await effectsFor(row.event_id), 1, 'the first delivery landed while the cache was healthy');

            const realDel = cache.del;
            const realError = console.error;
            cache.del = async () => { throw new Error('F6_CACHE_UNAVAILABLE'); };
            console.error = () => { /* the dispatcher logs the injected failure on purpose */ };
            try {
                await expireLease(Number(row.id));
                assert.strictEqual(await outbox.dispatchOne(Number(row.id)), false, 'a broken cache fails the delivery');
                const failed = await outboxRow(Number(row.id));
                assert.strictEqual(failed.status, 'pending', 'the event stays durable and retryable — never processed, never dropped');
                assert.match(String(failed.last_error || ''), /F6_CACHE_UNAVAILABLE/);
            } finally {
                cache.del = realDel;
                console.error = realError;
            }

            const before = hookCalls;
            await dbAsync.run('UPDATE content_outbox SET available_at = 0 WHERE id = ?', [row.id]);
            assert.strictEqual(await outbox.dispatchOne(Number(row.id)), true, 'the recovered cache lets the retry through');
            assert.strictEqual((await outboxRow(Number(row.id))).status, 'processed');
            assert.strictEqual(hookCalls, before + 1, 'the retry really re-ran the hook');
            assert.strictEqual(await effectsFor(row.event_id), 1, 'and still produced no second effect');
        });
    });
}
