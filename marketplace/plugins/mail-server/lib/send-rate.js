'use strict';

/**
 * The general queue's sending rate: at most N outbound messages per minute, for the whole install.
 *
 * One message counts once, however many external recipients it has, and only when it is handed to the
 * outside world (a relay or a remote MX); mail delivered to a local mailbox never counts. The count is
 * kept per calendar minute in a table of the plugin's own, so every node that runs the plugin shares
 * the same budget: a minute's row is claimed with one conditional UPDATE (`used < limit`), which the
 * database applies atomically. Two nodes inserting the same minute at once can leave two rows; each
 * claim then advances every row of that minute, so the cap stays at N (it can only run stricter).
 *
 * `limit` 0 means no cap: every claim succeeds and nothing is counted.
 */
const MINUTE_MS = 60 * 1000;

function createSendRate(db, table, readLimit) {
    const minuteOf = (now) => Math.floor(now / MINUTE_MS);

    async function used(minute) {
        const row = await db.get(`SELECT MAX(used) AS used FROM ${table} WHERE window_start = ?`, [minute]);
        return row && row.used != null ? Number(row.used) || 0 : 0;
    }

    /**
     * Claim one message of the current minute.
     * - `force`: account mail, the delivery test, an administrator's "Retry now" — always goes out,
     *   but still counts, so the rest of the queue waits for it.
     * Answers { ok, limit, retryAt } — retryAt (ms) is the start of the next minute when refused.
     */
    async function claim({ force = false, now = Date.now() } = {}) {
        const limit = await readLimit();
        if (!(limit > 0)) return { ok: true, limit: 0, retryAt: null };
        const minute = minuteOf(now);
        const retryAt = (minute + 1) * MINUTE_MS;
        const bumped = force
            ? await db.run(`UPDATE ${table} SET used = used + 1 WHERE window_start = ?`, [minute])
            : await db.run(`UPDATE ${table} SET used = used + 1 WHERE window_start = ? AND used < ?`, [minute, limit]);
        if (bumped && Number(bumped.changes) > 0) return { ok: true, limit, retryAt: null };
        // No row for this minute yet (the first message of the minute), or the minute is full.
        const existing = await db.get(`SELECT id FROM ${table} WHERE window_start = ?`, [minute]);
        if (!existing) {
            await db.run(`INSERT INTO ${table} (window_start, used) VALUES (?, 1)`, [minute]);
            return { ok: true, limit, retryAt: null };
        }
        return { ok: false, limit, retryAt };
    }

    /** What the queue screen shows: the cap, this minute's and last minute's count. */
    async function status({ now = Date.now() } = {}) {
        const limit = await readLimit();
        const minute = minuteOf(now);
        return {
            perMinute: limit > 0 ? limit : 0,
            sentThisMinute: await used(minute),
            sentLastMinute: await used(minute - 1),
        };
    }

    /** Forget minutes older than a day (called from the queue's slow sweep). */
    async function sweep({ now = Date.now() } = {}) {
        await db.run(`DELETE FROM ${table} WHERE window_start < ?`, [minuteOf(now) - 24 * 60]);
    }

    return { claim, status, sweep, MINUTE_MS };
}

/** The setting as stored: a whole number of messages per minute, 0 (no cap) when unset or invalid. */
function parsePerMinute(raw) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, 100000);
}

module.exports = { createSendRate, parsePerMinute, MINUTE_MS };
