/**
 * WordJS - Persistent admin notices (the writer side)
 *
 * WHY THIS EXISTS. A degradation an operator never meets is a degradation that lasts forever. Both
 * conditions this module was written for — the database manager falling back to the pure-JS
 * `sqlite-legacy` driver (which has no FTS5, so ranked search silently becomes LIKE) and cgroup mode
 * running with `sandbox.cpuQuotaPercent = 0` (isolated plugins with NO CPU bound at all) — were
 * REAL, PERMANENT and, until now, announced exactly once: as a `console.warn` on a boot nobody was
 * watching. That is the same shape as the purge misconfiguration of audit 2026-08-18 #27, which
 * survived for months behind a rate-limited log line.
 *
 * The product already has the surface for this: the autoloaded `admin_notices` option, rendered by
 * /admin/notices (frontend/src/app/admin/notices) and served by routes/notices.ts. It had exactly ONE
 * writer — the plugin CrashGuard in core/plugins.ts — and this module is deliberately not a second
 * dialect of it: same option name, same lock name, same stored row shape, so the admin screen and the
 * DELETE endpoint keep working with no change at all.
 *
 * WHAT IS DIFFERENT FROM CrashGuard'S APPEND. CrashGuard reports an EVENT ("this plugin crashed three
 * times at 14:02"), so appending a uniquely-keyed row is right. These notices report a STATE that is
 * re-discovered on every single boot, so an append would grow the autoloaded option without bound and
 * bury the operator in copies of one fact. Hence:
 *
 *   · UPSERT BY `id` — the id IS the condition ('db.sqlite-legacy-fallback'), so a hundred restarts
 *     leave one row.
 *   · NO WRITE WHEN NOTHING CHANGED — an autoloaded option that is rewritten on every boot churns the
 *     boot cache for nothing, and (with the cross-node publish behind updateOption) every peer's too.
 *   · THE ORIGINAL `timestamp` SURVIVES an upsert. The condition is the same one, still unfixed;
 *     re-dating it each boot would sort a months-old fault to the top of the screen as if it were new.
 *   · `clearAdminNotice(id)` — the counterpart the append-only writer never needed. A notice that
 *     cannot retire itself trains an operator to ignore the screen (see the purge test's third case:
 *     "an operator who fixes the problem, refreshes the screen that told them to fix it, and is
 *     contradicted by it, learns to ignore that screen").
 *
 * SAFE BEFORE THE DATABASE EXISTS. Both callers can fire before options are reachable — the driver
 * fallback happens while the manager is still loading, and an isolated plugin can launch early. A
 * notice raised then is QUEUED in memory (by id, so repeats collapse) and written by
 * `flushPendingAdminNotices()`, which config/database.ts calls the moment initialiseDatabase()
 * finishes. Nothing here ever throws at its caller: losing a notice is acceptable, wedging boot or a
 * plugin launch is not.
 */

const { getOption, updateOption } = require('./options');

const OPTION_NAME = 'admin_notices';
// The SAME lock core/plugins.ts takes. This is a read-modify-write of the WHOLE array, so two nodes
// recovering at once would otherwise clobber each other's row — and a notice dropped by a race is a
// degradation nobody is told about, which is the exact failure this module exists to end.
const LOCK_NAME = 'wordjs:admin-notices';

type AdminNoticeLevel = 'warning' | 'error';

/** What a caller supplies. `since` is when the CONDITION was first observed, not when we wrote it. */
type AdminNoticeInput = {
    id: string;
    level: AdminNoticeLevel;
    title?: string;
    message: string;
    since?: number;
};

/** What actually lands in the option — the shape /admin/notices already normalises. */
type StoredNotice = {
    id: string;
    type: string;
    message: string;
    dismissible: boolean;
    timestamp: number;
};

type PendingOp = { kind: 'push'; notice: StoredNotice } | { kind: 'clear'; id: string };

// Queued while options are unreachable. Keyed by id so a condition re-raised twenty times before the
// database is up costs one entry, and a clear supersedes a queued push for the same id.
const pending = new Map<string, PendingOp>();

/**
 * The stored `message` is rendered as TEXT by the admin screen (noticeText strips tags), and
 * CrashGuard's rows already carry `<b>`/`<strong>`, so a bold lead-in is the house style. Angle
 * brackets are stripped from the CALLER's strings all the same: the only markup in the option should
 * be markup this file put there, whoever ends up calling it later.
 */
function plain(value: unknown): string {
    return String(value === undefined || value === null ? '' : value).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

function toStored(input: AdminNoticeInput): StoredNotice {
    const title = plain(input && input.title);
    const body = plain(input && input.message);
    const since = Number(input && input.since);
    return {
        id: plain(input && input.id),
        // Closed vocabulary: the admin screen maps `type` through a closed table and anything unknown
        // renders neutral — a degradation that renders as "neutral" is one nobody reads.
        type: input && input.level === 'warning' ? 'warning' : 'error',
        message: title ? `<b>${title}</b> ${body}` : body,
        dismissible: true,
        timestamp: Number.isFinite(since) && since > 0 ? Math.floor(since) : Date.now(),
    };
}

/** Same CONDITION, reported again? The timestamp is deliberately not part of the comparison. */
function sameNotice(stored: any, next: StoredNotice): boolean {
    return !!stored
        && stored.id === next.id
        && stored.type === next.type
        && stored.message === next.message
        && stored.dismissible === next.dismissible;
}

/**
 * Is there a database to write to AT ALL? This is the difference between "queue it" and "we just
 * wiped the notices array with an empty read": getOption swallows its own errors and answers with the
 * default, so a read that failed and an option that is genuinely empty look identical from here.
 * Gating on the driver keeps the pair honest — with no usable driver neither the read nor the write
 * can run, so we never write a list we did not really read.
 */
function optionsAvailable(): boolean {
    try {
        const database = require('../config/database');
        return typeof database.getDbAsync === 'function' && !!database.getDbAsync();
    } catch {
        return false;
    }
}

// One writer at a time WITHIN this process. The dist-lock serialises nodes; this serialises the two
// callers here, which can easily overlap (a plugin launching while the boot sequence flushes).
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.then(() => undefined, () => undefined);
    return next;
}

/**
 * Read-modify-write the option under the shared lock.
 *
 * `apply` returns the NEW array, or `null` to mean "already in the desired state" — the caller is
 * told the state is correct (true) and no write happens. Returns false only when the option could not
 * be reached, which is the signal to queue.
 */
async function mutate(apply: (notices: any[]) => any[] | null): Promise<boolean> {
    if (!optionsAvailable()) return false;
    let lock: any = null;
    try {
        // THE HEALTHY PATH TAKES NO LOCK. Every boot re-asserts every condition, and on a correctly
        // configured site every one of those is a no-op — so the common case must not cost a
        // distributed lock (on Postgres/MySQL that is an INSERT, a heartbeat timer and a DELETE) just
        // to confirm there is nothing to write. This read is ADVISORY: it decides only whether to
        // bother, and the authoritative read happens under the lock below.
        //
        // Its one way to be wrong is benign and self-healing: getOption answers with the default when
        // the read itself failed, so a retirement asked for while the database is briefly unreachable
        // reports success against an empty list. The stale row then survives until the next boot
        // re-asserts the condition — a notice shown slightly too long, never one silently lost.
        const preread = await getOption(OPTION_NAME, []);
        if (Array.isArray(preread) && apply(preread) === null) return true;

        const { acquireBlocking } = require('./dist-lock');
        lock = await acquireBlocking(LOCK_NAME, { ttlMs: 15000, timeoutMs: 15000 });
        if (!lock.held) return false;
        const stored = await getOption(OPTION_NAME, []);
        const notices: any[] = Array.isArray(stored) ? stored : [];
        const next = apply(notices);
        if (next === null) return true;
        await updateOption(OPTION_NAME, next);
        return true;
    } catch (e: any) {
        console.warn(`[admin-notices] '${OPTION_NAME}' could not be updated (queued for retry): ${e && e.message}`);
        return false;
    } finally {
        if (lock && lock.held) {
            try { await lock.release(); } catch { /* best-effort: the lease expires on its own */ }
        }
    }
}

function pushApply(notice: StoredNotice) {
    return (notices: any[]): any[] | null => {
        const index = notices.findIndex((n: any) => n && n.id === notice.id);
        if (index === -1) return notices.concat([notice]);
        const current = notices[index];
        if (sameNotice(current, notice)) return null; // idempotent across restarts — no write at all
        const next = notices.slice();
        next[index] = {
            ...notice,
            timestamp: typeof current.timestamp === 'number' && Number.isFinite(current.timestamp)
                ? current.timestamp
                : notice.timestamp,
        };
        return next;
    };
}

function clearApply(id: string) {
    return (notices: any[]): any[] | null => {
        const remaining = notices.filter((n: any) => !n || n.id !== id);
        return remaining.length === notices.length ? null : remaining;
    };
}

async function applyOp(op: PendingOp): Promise<boolean> {
    const key = op.kind === 'push' ? op.notice.id : op.id;
    if (!key) return false;
    const ok = await serial(() => mutate(op.kind === 'push' ? pushApply(op.notice) : clearApply(op.id)));
    if (ok) pending.delete(key);
    else pending.set(key, op);
    return ok;
}

/**
 * Raise (or refresh) a persistent notice. Idempotent by `id`: calling it on every boot for a
 * condition that is still true leaves exactly one row, with its original date.
 *
 * Never rejects. `false` means "not written yet" — it is queued, and the boot sequence flushes it.
 */
async function pushAdminNotice(input: AdminNoticeInput): Promise<boolean> {
    return applyOp({ kind: 'push', notice: toStored(input) });
}

/**
 * Retire a notice by id — the boot that finds the condition FIXED calls this. Writes nothing when the
 * notice is not there, so the healthy path never touches the autoloaded option.
 */
async function clearAdminNotice(id: string): Promise<boolean> {
    return applyOp({ kind: 'clear', id: plain(id) });
}

/**
 * Drain everything raised before the database was reachable. Called from config/database.ts the
 * moment initialiseDatabase() completes. Re-queues whatever still cannot be written.
 */
async function flushPendingAdminNotices(): Promise<number> {
    if (!pending.size) return 0;
    const queued = Array.from(pending.values());
    pending.clear();
    let applied = 0;
    for (const op of queued) {
        if (await applyOp(op)) applied++;
    }
    return applied;
}

/** Diagnostic: which conditions are raised but not yet durable. */
function pendingAdminNoticeIds(): string[] {
    return Array.from(pending.keys());
}

module.exports = {
    pushAdminNotice,
    clearAdminNotice,
    flushPendingAdminNotices,
    pendingAdminNoticeIds,
    ADMIN_NOTICES_OPTION: OPTION_NAME,
    ADMIN_NOTICES_LOCK: LOCK_NAME,
};
