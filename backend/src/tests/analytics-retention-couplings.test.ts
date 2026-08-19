/**
 * WordJS — the two invariants analytics retention RESTS ON, made checkable.
 *
 * Both were written down as prose and neither was enforced, which is the shape this whole wave is
 * about: a comment that says "these must stay equal" is documentation, and documentation does not
 * fail a build.
 *
 * INVARIANT 1 — CAPACITY. The prune's ceiling (MAX_ROWS_PER_RUN) is derived from the analytics
 *   limiter's per-IP rate: 60/min × 60 × 24 × 8 sources = 691 200 rows per run. The module said the
 *   limiter "is built from this number"; index.ts still wrote `max: 60` by hand and nothing compared
 *   them. Raise the limiter to 300/min for traffic reasons and the prune is silently 5× short — the
 *   unbounded-table failure the module exists to prevent, with a gentler slope. This test READS both
 *   numbers and demands they agree, so whichever one moves, the other has to move with it.
 *
 * INVARIANT 2 — ONE CLOCK. The cutoff is only meaningful if it is expressed in the same frame as
 *   `created_at`, and `created_at` is written by the SERVER (`CURRENT_TIMESTAMP`): UTC on SQLite,
 *   the SESSION zone on MySQL, the `TimeZone` GUC on PostgreSQL. A cutoff rendered from the Node
 *   process's UTC clock therefore lands hours away from the column on any server that is not on UTC,
 *   and the prune deletes rows still inside the retention window. The prune now asks the DATABASE
 *   what time it is; the engine renderings are iterated below, and the end-to-end test drives the
 *   real producer and the real prune with NO injected clock at all.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-retention-couplings-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const retention = require('../core/analytics-retention');
const { INGEST_MAX_PER_MINUTE_PER_IP, MAX_ROWS_PER_RUN, parseDbNow, pruneAnalytics } = retention;

let dbAsync: any;
let analytics: any;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.dbAsync;
    analytics = require('../models/Analytics');
    await analytics.init();
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* */ } }
});

// ── INVARIANT 1: the prune's ceiling and the limiter that feeds the table ────────────────────────
test('the prune ceiling and the analytics limiter are the SAME number (they cannot drift silently)', () => {
    const indexSrc = fs.readFileSync(path.resolve(__dirname, '../index.ts'), 'utf8');
    const block = indexSrc.match(/const\s+analyticsLimiter\s*=\s*rateLimit\(\{[\s\S]*?\n\}\);/);
    assert.ok(block, 'the analyticsLimiter declaration moved or was renamed — this coupling has to be re-pointed, not deleted');

    const max = (block[0].match(/\bmax\s*:\s*([A-Za-z0-9_]+)/) || [])[1];
    assert.ok(max, `the limiter declares no max — the prune is then sized against nothing:\n${block[0]}`);

    if (/^\d+$/.test(max)) {
        // Still a hand-written literal (index.ts is not this group's file to change). Then the two
        // numbers must at least be PROVED equal here, every run.
        assert.strictEqual(Number(max), INGEST_MAX_PER_MINUTE_PER_IP,
            `index.ts limits analytics ingest to ${max}/min per IP while core/analytics-retention sizes the prune for ` +
            `${INGEST_MAX_PER_MINUTE_PER_IP}/min. Whichever is right, the other is wrong: the prune's whole capacity ` +
            'argument (60 × 60 × 24 × 8) is derived from that rate. Import INGEST_MAX_PER_MINUTE_PER_IP in index.ts.');
    } else {
        assert.strictEqual(max, 'INGEST_MAX_PER_MINUTE_PER_IP',
            'the limiter takes its max from some other identifier — the coupling must be to THE constant, or it is not a coupling');
    }

    // And the derivation itself, so a change to the ceiling that forgets the rate is caught too.
    assert.strictEqual(MAX_ROWS_PER_RUN, INGEST_MAX_PER_MINUTE_PER_IP * 60 * 24 * 8,
        'MAX_ROWS_PER_RUN must stay a day of ingest from several abusive sources, not a hand-written round number');
});

// ── INVARIANT 2: one clock, whatever the engine renders ──────────────────────────────────────────
// One row per ENGINE RENDERING of `SELECT CURRENT_TIMESTAMP`. The property is the same for all of
// them: the reference instant is the WALL CLOCK the engine printed — the frame `created_at` is
// stored in — and never this process's zone.
const ENGINE_NOW_RENDERINGS: Array<{ engine: string; raw: any; wall: string }> = [
    { engine: 'SQLite (always UTC)', raw: '2026-08-18 20:00:00', wall: '2026-08-18 20:00:00' },
    { engine: 'MySQL, session zone +02:00', raw: '2026-08-18 22:00:00', wall: '2026-08-18 22:00:00' },
    { engine: 'MySQL, session zone -05:00', raw: '2026-08-18 15:00:00', wall: '2026-08-18 15:00:00' },
    { engine: 'MySQL with a fractional second', raw: '2026-08-18 22:00:00.123456', wall: '2026-08-18 22:00:00' },
    { engine: 'PostgreSQL timestamptz (+02)', raw: '2026-08-18 22:00:00.123456+02', wall: '2026-08-18 22:00:00' },
    { engine: 'PostgreSQL timestamptz (-05)', raw: '2026-08-18 15:00:00.987-05', wall: '2026-08-18 15:00:00' },
    { engine: 'a driver that returns ISO text', raw: '2026-08-18T20:00:00', wall: '2026-08-18 20:00:00' }
];

for (const { engine, raw, wall } of ENGINE_NOW_RENDERINGS) {
    test(`the reference instant is the DB's own wall clock — ${engine}`, () => {
        const ms = parseDbNow(raw, Date.parse('2000-01-01T00:00:00Z'));
        assert.strictEqual(retention.dbTimestamp(ms), wall,
            `the cutoff would be computed in the wrong frame for ${engine}: the column stores ${wall}`);
    });
}

test('an unreadable or missing database clock falls back to the process clock, never to zero', () => {
    const fallback = Date.parse('2026-08-18T20:00:00Z');
    for (const bad of [null, undefined, '', 'not a timestamp', 0, {}, []]) {
        assert.strictEqual(parseDbNow(bad, fallback), fallback,
            `a ${JSON.stringify(bad)} clock must degrade to the previous behaviour, not to 1970 (which would prune everything)`);
    }
    // A driver that hands back a real Date object is read as that instant.
    const d = new Date('2026-08-18T20:00:00Z');
    assert.strictEqual(parseDbNow(d, fallback), d.getTime());
});

test('END TO END: with NO injected clock, the prune uses the DB clock and keeps what is inside the window', async () => {
    const { updateOption } = require('../core/options');
    await updateOption('analytics_retention_days', 90);
    await dbAsync.run('DELETE FROM wordjs_analytics');

    // Rows written by the REAL producer (created_at = the server's CURRENT_TIMESTAMP), then aged
    // RELATIVE TO THE DATABASE'S OWN CLOCK — never to Date.now(), which is the assumption under test.
    await analytics.track({ type: 'page_view', resource: '/fresh' });
    await analytics.track({ type: 'page_view', resource: '/inside-by-1h' });
    await analytics.track({ type: 'page_view', resource: '/ancient' });
    await dbAsync.run(
        "UPDATE wordjs_analytics SET created_at = datetime(created_at, '-89 days', '-23 hours') WHERE resource = ?",
        ['/inside-by-1h']);
    await dbAsync.run(
        "UPDATE wordjs_analytics SET created_at = datetime(created_at, '-200 days') WHERE resource = ?",
        ['/ancient']);

    const removed = await pruneAnalytics();   // production call shape: no `now`, no limits

    const left = (await dbAsync.all('SELECT resource FROM wordjs_analytics ORDER BY resource'))
        .map((r: any) => r.resource);
    assert.deepStrictEqual(left, ['/fresh', '/inside-by-1h'],
        'a row one hour inside the window must survive a prune that took its reference from the database');
    assert.strictEqual(removed, 1);
});
