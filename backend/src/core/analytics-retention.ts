/**
 * WordJS — analytics retention.
 *
 * (#21) `wordjs_analytics` is written by an ANONYMOUS public endpoint (POST /analytics/track) and, until
 * this file existed, nothing in the whole backend ever deleted a row from it. Input bounds and a per-IP
 * limiter slow the growth down; they do not make it stop. Storage that only ever grows, fed by a surface
 * with no account behind it, is a full disk with a date on it — and in monolith mode a full disk takes
 * down the backend, the frontend and the database together.
 *
 * So the table gets the one thing it was missing: an age. A daily cron prunes rows older than
 * `analytics_retention_days` (default 90; 0 disables pruning for an operator who really wants forever).
 * The delete is driven by `created_at`, which is exactly what `idx_analytics_date` already indexes, and
 * it is batched so a first run over a table that has been accumulating for months never holds one long
 * write transaction across every driver.
 *
 * Registration mirrors core/scheduled-publish and core/frontend-purge: an init() that only wires the
 * cron action, called unconditionally from index.ts; the scheduling itself happens next to the other
 * default cron events once the DB is up.
 */

const { dbAsync } = require('../config/database');
const { getOption } = require('./options');
const { addAction } = require('./hooks');

const TABLE = 'wordjs_analytics';
const HOOK = 'wordjs_analytics_prune';
const DEFAULT_RETENTION_DAYS = 90;
/** Rows removed per statement. Bounded so a long-neglected table is drained across several passes
 *  instead of one transaction that blocks every writer (SQLite takes a global write lock). */
const BATCH = 5000;

/**
 * THE PRUNE MUST BE ABLE TO OUTRUN THE INGEST, or "bounded storage" is a slogan.
 *
 * The first version removed BATCH × 20 = 100 000 rows per run and ran DAILY. The analytics limiter
 * (index.ts) allows 60 events/minute PER IP, i.e. 86 400 rows/day from a single address: one abusive
 * IP already consumed 86 % of the day's prune budget, and two made the table grow ~73 000 rows every
 * day, for ever — the same "full disk with a date on it" the finding says it closed, only with a
 * gentler slope and no signal at all, because the run logged how many rows it removed and never that
 * it had stopped short.
 *
 * So the ceiling is DERIVED from the write side instead of hand-written, with headroom for several
 * abusive sources at once, and a wall-clock budget keeps one catch-up run from monopolising the
 * database. Whatever is left over is REPORTED (retentionState) instead of vanishing.
 *
 * THE COUPLING IS CHECKED, NOT ANNOUNCED. This constant must equal the analyticsLimiter's `max` in
 * index.ts, and saying so in a comment is exactly what failed: the previous version of this note
 * claimed the limiter "is built from this number", and index.ts still said `max: 60` by hand — so
 * the whole 691 200-rows/run capacity argument rested on someone remembering two files at once.
 * `src/tests/analytics-retention-couplings.test.ts` now READS the limiter's max out of index.ts and
 * fails if the two numbers differ, whichever of them moves. (Importing the constant in index.ts is
 * the better shape and is still the right change; the test is what makes the invariant hold in the
 * meantime, and it keeps holding afterwards.)
 */
const INGEST_MAX_PER_MINUTE_PER_IP = 60;
const DAILY_INGEST_PER_IP = INGEST_MAX_PER_MINUTE_PER_IP * 60 * 24;   // 86 400 rows/day/IP
/** Headroom: the prune must still gain on a table fed by several abusive addresses at once. */
const INGEST_SOURCES_COVERED = 8;
const MAX_ROWS_PER_RUN = DAILY_INGEST_PER_IP * INGEST_SOURCES_COVERED; // 691 200 rows/run
/** …and never hold the database for longer than this in one run, however far behind it is. */
const MAX_RUN_MS = 60_000;

/** Last prune outcome, for /health/details and the cron log. `behind` is the one that matters: the
 *  run stopped at a cap and rows outside the window are still there. */
let state: { lastRunAt: number | null; lastRemoved: number; behind: boolean; lastError: string | null } = {
    lastRunAt: null, lastRemoved: 0, behind: false, lastError: null,
};

/** Configured retention in days, or 0 when the operator has switched pruning off. */
async function retentionDays(): Promise<number> {
    const raw = await getOption('analytics_retention_days', DEFAULT_RETENTION_DAYS);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_RETENTION_DAYS;
    return Math.floor(n);
}

/**
 * The cutoff, IN THE FORMAT THE PRODUCER WRITES.
 *
 * `created_at` is written by `Analytics.track` as `CURRENT_TIMESTAMP`, which on SQLite renders
 * 'YYYY-MM-DD HH:MM:SS' in UTC — no 'T', no milliseconds, no 'Z'. Comparing that column against
 * `new Date(…).toISOString()` is a LEXICOGRAPHIC comparison between two different formats, and the
 * space (0x20) sorts before the 'T' (0x54): a row stamped '2026-05-20 23:59:59' compares as SMALLER
 * than the cutoff '2026-05-20T10:00:00.000Z' although it is fourteen hours NEWER, so the prune ate up
 * to a whole extra day of analytics on every run. (The old test could not see it: it seeded rows with
 * toISOString(), i.e. in the CUTOFF's format, which made the comparison homogeneous — fixture versus
 * producer, inside the fix for the finding.)
 *
 * The same rendering is valid input for a Postgres TIMESTAMP and a MySQL TIMESTAMP, so one format
 * serves all three engines. Rows written in some other shape (an older ISO one) can only compare as
 * NEWER than they are, so the failure mode of any leftover is "pruned a little late", never "deleted
 * while still inside the window".
 */
function dbTimestamp(ms: number): string {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * NOW, ON THE CLOCK THAT WROTE THE COLUMN — not on this process's clock.
 *
 * THE CLASS: a comparison is only meaningful when BOTH sides come from the same frame, and half of
 * this one is produced by the SERVER. `created_at` is filled by `Analytics.track` with a literal
 * `CURRENT_TIMESTAMP`, which is UTC on SQLite, the SESSION time zone on MySQL and the `TimeZone`
 * GUC on PostgreSQL. A cutoff rendered from `Date.now()` in UTC therefore lands hours away from the
 * column's frame on any server that is not on UTC, and the prune deletes rows that are still inside
 * the retention window — the same damage as the ISO-vs-space format bug, from the other axis.
 *
 * Asking the database for its own `CURRENT_TIMESTAMP` removes the assumption instead of documenting
 * it: whatever frame the producer writes in, the cutoff is computed in THAT frame. The offset a
 * Postgres `timestamptz` renders is dropped on purpose — the column is a `TIMESTAMP` (no zone), so
 * its wall-clock reading is what the comparison sees. (The MySQL driver additionally pins every
 * session to `time_zone='+00:00'`, so on that engine the two agree by construction as well.)
 *
 * A database that cannot answer, or answers in a shape this cannot read, falls back to the process
 * clock — the previous behaviour, never worse than it.
 */
function parseDbNow(raw: any, fallbackMs: number): number {
    if (raw == null) return fallbackMs;
    if (raw instanceof Date) return raw.getTime();
    const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return fallbackMs;
    // Read as the wall clock the engine printed. Date.UTC is the FRAME-NEUTRAL reader here: the same
    // rendering goes back out through dbTimestamp, so whatever zone the server is in cancels out —
    // what must not happen is this process's local zone leaking in (`new Date('…')` would do exactly
    // that for the space-separated form on some engines).
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

async function databaseNowMs(fallbackMs: number): Promise<number> {
    try {
        const row = await dbAsync.get('SELECT CURRENT_TIMESTAMP AS now_ts');
        return parseDbNow(row && (row.now_ts ?? row.NOW_TS ?? row.now ?? row.NOW), fallbackMs);
    } catch {
        return fallbackMs;
    }
}

/**
 * Delete analytics rows older than the configured retention. Returns how many were removed.
 * Exported for the test, which drives it against a real table rather than asserting on a fixture.
 *
 * @param limits test seam ONLY — the production caps are the module constants above.
 */
async function pruneAnalytics(
    now: number | null = null,
    limits: { batch?: number; maxRows?: number; maxMs?: number } = {}
): Promise<number> {
    const batch = limits.batch || BATCH;
    const maxRows = limits.maxRows || MAX_ROWS_PER_RUN;
    const maxMs = limits.maxMs || MAX_RUN_MS;
    const startedAt = Date.now();

    const days = await retentionDays();
    if (days <= 0) { state = { ...state, lastRunAt: startedAt, lastRemoved: 0, behind: false }; return 0; }
    // The cutoff is computed in JS and bound as a parameter — the same driver-agnostic shape
    // Analytics.getStats uses, so this works identically on SQLite, MySQL and Postgres instead of
    // relying on SQLite-only datetime('now', …) — and in the producer's own format (see dbTimestamp).
    // `now` is a TEST SEAM. Production passes nothing and the reference instant comes from the
    // database, i.e. from the same clock that stamped `created_at` (see databaseNowMs).
    const reference = typeof now === 'number' ? now : await databaseNowMs(Date.now());
    const cutoff = dbTimestamp(reference - days * 86400000);

    let removed = 0;
    let cappedOut = false;
    for (;;) {
        const room = maxRows - removed;
        if (room <= 0) { cappedOut = true; break; }
        if (Date.now() - startedAt > maxMs) { cappedOut = true; break; }
        const want = Math.min(batch, room);
        // No LIMIT on DELETE: MySQL and SQLite support it, Postgres does not. A bounded subselect on
        // the PRIMARY KEY is the portable form, and the inner scan is served by idx_analytics_date.
        const doomed = await dbAsync.all(
            `SELECT id FROM ${TABLE} WHERE created_at < ? ORDER BY created_at ASC LIMIT ?`,
            [cutoff, want]
        );
        if (!doomed || doomed.length === 0) break;
        const placeholders = doomed.map(() => '?').join(',');
        await dbAsync.run(
            `DELETE FROM ${TABLE} WHERE id IN (${placeholders})`,
            doomed.map((r: any) => r.id)
        );
        removed += doomed.length;
        if (doomed.length < want) break;   // the window is drained
    }

    // Stopping at a cap is not the same as finishing. Ask the table, rather than infer it from the
    // last batch size: "is there still anything outside the window?" is one indexed lookup, and it is
    // the difference between "retention is working" and "retention is losing the race".
    let behind = false;
    if (cappedOut) {
        const leftover = await dbAsync.all(
            `SELECT id FROM ${TABLE} WHERE created_at < ? LIMIT 1`, [cutoff]
        );
        behind = !!(leftover && leftover.length);
    }

    state = { lastRunAt: Date.now(), lastRemoved: removed, behind, lastError: null };
    return removed;
}

/**
 * What the last prune did — for /health/details and for the cron log.
 *
 * `behind: true` means the run stopped at a cap with rows still outside the retention window, i.e.
 * the table is growing faster than it is being drained. That is the failure this whole module exists
 * to prevent, so it must be a readable STATE, not an absence of log lines.
 */
function retentionState() {
    return { ...state };
}

/** Wire the cron handler. Passive — safe to call before the DB exists. */
function initAnalyticsRetention(): void {
    addAction(HOOK, async () => {
        try {
            const removed = await pruneAnalytics();
            if (removed > 0) console.log(`⏰ analytics: pruned ${removed} row(s) past the retention window`);
            if (state.behind) {
                console.warn(
                    `⚠️  analytics retention is BEHIND the ingest: ${removed} row(s) removed and the table ` +
                    'still holds rows outside the window. Lower analytics_retention_days, tighten the ' +
                    'per-IP analytics limiter, or run the prune more often — otherwise the table grows for ever.'
                );
            }
        } catch (e: any) {
            state = { ...state, lastRunAt: Date.now(), lastError: String(e && e.message) };
            console.error('Analytics retention prune failed:', e && e.message);
        }
    });
}

module.exports = {
    initAnalyticsRetention, pruneAnalytics, retentionState, dbTimestamp, databaseNowMs, parseDbNow,
    HOOK, DEFAULT_RETENTION_DAYS, INGEST_MAX_PER_MINUTE_PER_IP, MAX_ROWS_PER_RUN,
};
