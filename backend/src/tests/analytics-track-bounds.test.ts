/**
 * #21 — POST /analytics/track: input bounds and retention.
 *
 * Drives the REAL router (../routes/analytics, mounted exactly as index.ts mounts it) over supertest
 * against a throwaway temp DB, and the REAL model (../models/Analytics) writes the rows — so what is
 * asserted is what a browser's beacon actually produces, not a hand-built call to track(). The
 * retention half runs the REAL prune against a real table with real rows.
 *
 * The bar this file pins is the one routes/forms.ts already sets for an anonymous public write
 * surface: an allowlist for the field that chooses meaning, hard length caps enforced IN CODE (the
 * DDL's VARCHAR(50)/VARCHAR(255) are decoration — SQLite ignores them, MySQL keeps `metadata` in
 * LONG_TEXT_COLUMNS, Postgres TEXT is unbounded), and a total-bytes ceiling on the free-form blob.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-analytics-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json({ limit: '10mb' })); // the same body cap index.ts applies
app.use('/api/v1/analytics', require('../routes/analytics'));

const analytics = require('../models/Analytics');
const { pruneAnalytics, DEFAULT_RETENTION_DAYS } = require('../core/analytics-retention');

let dbAsync: any;
const track = (body: any) => request(app).post('/api/v1/analytics/track').send(body);
const countRows = async () => (await dbAsync.get('SELECT COUNT(*) AS n FROM wordjs_analytics')).n;

// Top-level, NOT inside the first describe: node:test runs a suite's after() as soon as that suite
// finishes, which would close the database out from under the retention suite below.
before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await analytics.init();
});
after(() => {
    try { if (database.closeDatabase) database.closeDatabase(); } catch { /* ignore */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
});

describe('POST /analytics/track — hard bounds on an anonymous public write', () => {
    it('accepts what the real beacon sends and stores one row with a hashed IP', async () => {
        const r = await track({ type: 'page_view', resource: '/hello-world' });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body, { success: true });
        const row = await dbAsync.get('SELECT * FROM wordjs_analytics WHERE resource = ?', ['/hello-world']);
        assert.ok(row, 'the row must be stored');
        assert.strictEqual(row.type, 'page_view');
        assert.notStrictEqual(row.visitor_ip, '0.0.0.0'); // salted hash, not the raw address
    });

    it('rejects an out-of-allowlist type and stores nothing', async () => {
        const before = await countRows();
        for (const type of ['x'.repeat(50), 'DROP', 'page_view ', 1234, {}, ['page_view']]) {
            const r = await track({ type, resource: '/' });
            assert.strictEqual(r.status, 400, `type=${JSON.stringify(type)} must be refused`);
        }
        assert.strictEqual(await countRows(), before, 'a refused event must never reach the table');
    });

    it('caps `resource` at the VARCHAR(255) by TRUNCATING — a campaign URL must not be dropped', async () => {
        // What AnalyticsTracker.tsx actually sends: `${pathname}?${searchParams}`. A normal ad link
        // (utm_* plus an fbclid) blows past 255 without any effort, and rejecting it deleted exactly
        // the paid traffic — silently, because the beacon ignores the response.
        const pathname = '/blog/2026/como-migrar-de-wordpress-a-wordjs-sin-perder-el-seo';
        const query = 'utm_source=facebook&utm_medium=paid_social&utm_campaign=lanzamiento-primavera-2026'
            + '&utm_content=carrusel-variante-b&utm_term=cms%20autoalojado'
            + '&fbclid=IwAR2' + 'x'.repeat(120);
        const url = `${pathname}?${query}`;
        assert.ok(url.length > 255, 'precondition: the producer really does exceed the column');

        const r = await track({ type: 'page_view', resource: url });
        assert.strictEqual(r.status, 200, 'a real campaign visit must be RECORDED, not refused');

        const row = await dbAsync.get(
            'SELECT resource FROM wordjs_analytics WHERE resource LIKE ?', [`${pathname}%`]
        );
        assert.ok(row, 'the visit is in the table');
        assert.strictEqual(row.resource.length, 255, 'stored at the column width MySQL would enforce');
        assert.strictEqual(row.resource, url.slice(0, 255), 'and truncated from the front, so the path survives');
    });

    it('still refuses a `resource` that is not a string at all', async () => {
        for (const resource of [{}, ['/a'], 42, true]) {
            const r = await track({ type: 'page_view', resource });
            assert.strictEqual(r.status, 400, `resource=${JSON.stringify(resource)} must be refused`);
        }
    });

    it('refuses the unbounded metadata blob that made the endpoint a disk filler', async () => {
        const before = await countRows();
        const cases: any[] = [
            { big: 'x'.repeat(9 * 1024 * 1024) },                 // the ~10 MB row express.json allowed
            { nested: { a: { b: 'c' } } },                        // objects are rejected, not stringified
            ['page_view'],                                        // arrays are not metadata
            'a string',
            Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'v'])), // too many keys
            { ['k'.repeat(120)]: 'v' },                           // key too long
            { k: 'v'.repeat(500) },                               // value too long
        ];
        for (const metadata of cases) {
            const r = await track({ type: 'page_view', resource: '/', metadata });
            assert.strictEqual(r.status, 400, `metadata ${JSON.stringify(metadata).slice(0, 40)} must be refused`);
        }
        assert.strictEqual(await countRows(), before, 'no oversized event may be persisted');
    });

    it('accepts a small, flat metadata object', async () => {
        const r = await track({ type: 'engagement', resource: '/post/1', metadata: { block: 'hero', visible: true, ms: 1200 } });
        assert.strictEqual(r.status, 200);
        const row = await dbAsync.get('SELECT metadata FROM wordjs_analytics WHERE resource = ?', ['/post/1']);
        assert.deepStrictEqual(JSON.parse(row.metadata), { block: 'hero', visible: true, ms: 1200 });
    });

    it('reports a storage failure as a failure (the catch used to answer 200)', async () => {
        await dbAsync.run('DROP TABLE wordjs_analytics');
        const r = await track({ type: 'page_view', resource: '/' });
        assert.strictEqual(r.status, 500, 'a broken analytics table must not look like a healthy one');
        await analytics.init(); // restore for the retention suite below
    });
});

/**
 * FIXTURE VERSUS PRODUCER, the retention half.
 *
 * The first version of these tests seeded `created_at` with `new Date(…).toISOString()` — the format
 * of the CUTOFF, not the one the producer writes. `Analytics.track` stamps the column with
 * `CURRENT_TIMESTAMP`, which SQLite renders as 'YYYY-MM-DD HH:MM:SS'. Comparing that against an
 * ISO-8601 'Z' string is lexicographic across two formats, and ' ' sorts before 'T', so rows still
 * INSIDE the window were deleted — up to a day of them. The homogeneous fixture hid it and the
 * assertion "exactly the two rows past the window" was green the whole time.
 *
 * So rows are created here by POSTing to the real route (the beacon's own call) and then MOVED IN TIME
 * with SQLite's own datetime() renderer, which produces the identical text CURRENT_TIMESTAMP does.
 * The format is never written by hand.
 */
describe('analytics retention — the table finally has an age', () => {
    const DAY = 86400000;
    // Pinned so the cutoff and the "inside the window, same calendar day" row cannot drift with the
    // hour the suite happens to run at.
    const NOW = Date.parse('2026-08-18T20:00:00.000Z');

    /** One row, written by the REAL producer, then aged to an exact instant in the producer's format. */
    const seedAt = async (tag: string, instantMs: number) => {
        const r = await track({ type: 'page_view', resource: `/r/${tag}` });
        assert.strictEqual(r.status, 200);
        await dbAsync.run(
            `UPDATE wordjs_analytics SET created_at = datetime(?, 'unixepoch') WHERE resource = ?`,
            [Math.floor(instantMs / 1000), `/r/${tag}`]
        );
    };
    const survivors = async () =>
        (await dbAsync.all('SELECT resource FROM wordjs_analytics ORDER BY resource')).map((r: any) => r.resource);

    it('the producer stamps created_at as the DB renders it — no T, no milliseconds, no Z', async () => {
        await dbAsync.run('DELETE FROM wordjs_analytics');
        const r = await track({ type: 'page_view', resource: '/format-probe' });
        assert.strictEqual(r.status, 200);
        const row = await dbAsync.get('SELECT created_at FROM wordjs_analytics WHERE resource = ?', ['/format-probe']);
        assert.match(
            String(row.created_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
            'if this ever becomes ISO-8601, the prune comparison must move with it'
        );
    });

    it('prunes what is past the window and KEEPS what is inside it, to the hour', async () => {
        await dbAsync.run('DELETE FROM wordjs_analytics');
        await seedAt('fresh', NOW - DAY);
        // Three hours NEWER than the cutoff, i.e. inside the window — but on the same calendar day, so
        // an ISO-vs-space comparison sorts it as older and deletes it. This row is the whole point.
        await seedAt('inside-by-3h', NOW - DEFAULT_RETENTION_DAYS * DAY + 3 * 3600000);
        await seedAt('old', NOW - (DEFAULT_RETENTION_DAYS + 5) * DAY);
        await seedAt('ancient', NOW - DEFAULT_RETENTION_DAYS * 4 * DAY);

        const removed = await pruneAnalytics(NOW);

        assert.deepStrictEqual(await survivors(), ['/r/fresh', '/r/inside-by-3h'],
            'a row inside the retention window must survive, whatever the hour of day');
        assert.strictEqual(removed, 2, 'exactly the two rows past the retention window');
    });

    it('honours a shorter operator-configured window', async () => {
        const { updateOption } = require('../core/options'); // the real writer, so the option cache agrees
        await updateOption('analytics_retention_days', 7);
        assert.strictEqual(await pruneAnalytics(NOW), 1, "'inside-by-3h' is inside 90 days but outside 7");
        assert.deepStrictEqual(await survivors(), ['/r/fresh']);
    });

    it('reports being BEHIND the ingest instead of stopping short in silence', async () => {
        const { updateOption } = require('../core/options');
        const { retentionState } = require('../core/analytics-retention');
        await updateOption('analytics_retention_days', 7);
        for (const tag of ['b1', 'b2', 'b3', 'b4', 'b5']) await seedAt(tag, NOW - 30 * DAY);

        // The production caps are sized against the limiter's own daily ceiling (60/min/IP × 1440 ×
        // headroom), which no test can seed; the caps themselves are the seam. Two rows of budget
        // against five rows of backlog is the same situation as 100 000 against 172 800.
        const removed = await pruneAnalytics(NOW, { batch: 2, maxRows: 2 });
        assert.strictEqual(removed, 2, 'it removes what it can');
        assert.strictEqual(retentionState().behind, true, 'and SAYS that rows are still outside the window');

        // Given room, it drains — and then stops claiming to be behind.
        assert.strictEqual(await pruneAnalytics(NOW, { batch: 2 }), 3);
        assert.strictEqual(retentionState().behind, false);
        assert.deepStrictEqual(await survivors(), ['/r/fresh']);
    });

    it('does nothing when the operator sets retention to 0 (keep forever)', async () => {
        const { updateOption } = require('../core/options');
        await updateOption('analytics_retention_days', 0);
        // A row far outside ANY window: if 0 were mishandled as "prune everything", this would vanish.
        await seedAt('very-old', NOW - 3650 * DAY);
        assert.strictEqual(await pruneAnalytics(NOW), 0);
        assert.deepStrictEqual(await survivors(), ['/r/fresh', '/r/very-old']);
    });
});
