/**
 * WordJS — Append-only audit trail (FRENTE C-3).
 *
 * A thin, best-effort recorder for security-relevant mutations: who (actor), what (action), on what
 * (target type + id), when (created_at), and a small JSON `detail`. The table (audit_log, migration
 * 0009) is APPEND-ONLY for the application — no route updates or deletes a row, and the only reader is
 * the admin GET /api/v1/audit endpoint. The ONE writer that removes rows is the retention prune at the
 * bottom of this file: age-based, scheduled by core/cron, and never selective about WHAT it removes.
 *
 * TWO HARD RULES the callers rely on:
 *   1. NEVER block or fail the mutation. recordAudit swallows every error (log-and-continue): a broken
 *      audit insert must never turn a successful role change into a 500. It is a single INSERT.
 *   2. NEVER persist secret material. `detail` is sanitized here — any key that looks like a
 *      secret/password/token is dropped, and only scalars (or arrays of scalars) survive, so a caller
 *      can't accidentally smuggle a password/hash/token into the log through a nested object.
 */

const { dbAsync } = require('../config/database');

/**
 * THE ACTION CATALOGUE — one place where every action name in the product is written down.
 *
 * A log whose vocabulary is invented at each call site cannot be searched: `auth.login.failed` and
 * `auth.login.failure` are two different things to a `WHERE action = ?`, and nothing would have caught
 * the difference. Every name that has EVER been stored is here, spelled exactly as it was stored — this
 * catalogue does not rename anything, so an operator's saved query keeps working across the upgrade.
 *
 * Call sites still pass string literals (the routers reach this module through an untyped
 * `require(...)`, so a constant read through that path would be `any` and a typo would silently record
 * `undefined`). What holds the two halves together is a gate in src/tests/audit-trail.test.ts: it reads
 * the action literal out of every recordAudit() call in the backend source and fails when one is not in
 * this object. So the list below is a DERIVED-AND-CHECKED inventory, not a comment that hopes.
 */
const AUDIT_ACTIONS = Object.freeze({
    // ── Authentication / credentials ────────────────────────────────────────────────────────────────
    LOGIN_SUCCESS: 'auth.login.success',
    LOGIN_FAILURE: 'auth.login.failure',
    LOGOUT: 'auth.logout',
    // Reserved for the self-service password change, whose handler is routes/users.ts (PUT /users/me
    // and PUT /users/:id). The name is fixed HERE so that call site adopts this one instead of
    // inventing 'user.password_change' next to the 'user.*' names that surround it.
    PASSWORD_CHANGE: 'auth.password.change',
    PASSWORD_RESET: 'auth.password.reset',
    MFA_ENABLE: 'auth.mfa.enable',
    MFA_DISABLE: 'auth.mfa.disable',
    MFA_BACKUP_CODES: 'auth.mfa.backup_codes',
    TOKEN_CREATE: 'auth.token.create',
    TOKEN_REVOKE: 'auth.token.revoke',

    // ── Users (already recorded before this batch — names preserved verbatim) ────────────────────────
    USER_CREATE: 'user.create',
    USER_DELETE: 'user.delete',
    USER_ROLE_CHANGE: 'user.role_change',
    USER_SESSIONS_REVOKED: 'user.sessions_revoked',
    // An admin resetting SOMEONE ELSE's second factor. It lives under `user.` (not `auth.`) because
    // that is the name it has been storing since FRENTE C-3 — renaming it would break saved queries.
    USER_MFA_RESET: 'user.mfa_reset',

    // ── Content ─────────────────────────────────────────────────────────────────────────────────────
    POST_CREATE: 'post.create',
    POST_UPDATE: 'post.update',
    POST_PUBLISH: 'post.publish',
    POST_TRASH: 'post.trash',
    POST_RESTORE: 'post.restore',
    POST_DELETE: 'post.delete',

    // ── Backups (a restore is the most destructive operation the product offers) ─────────────────────
    BACKUP_CREATE: 'backup.create',
    BACKUP_RESTORE: 'backup.restore',
    BACKUP_DELETE: 'backup.delete',

    // ── Extensions ──────────────────────────────────────────────────────────────────────────────────
    MARKETPLACE_INSTALL: 'marketplace.install',
    MARKETPLACE_UPDATE: 'marketplace.update',
    PLUGIN_ACTIVATE: 'plugin.activate',
    PLUGIN_DEACTIVATE: 'plugin.deactivate',
    THEME_ACTIVATE: 'theme.activate',
    THEME_MODS_IMPORT: 'theme.mods.import',

    // ── Configuration ───────────────────────────────────────────────────────────────────────────────
    SETTINGS_UPDATE: 'settings.update',

    // ── The log about the log ───────────────────────────────────────────────────────────────────────
    AUDIT_PRUNE: 'audit.prune'
} as const);

type AuditAction = typeof AUDIT_ACTIONS[keyof typeof AUDIT_ACTIONS];

// Keys whose VALUES would be secrets — mirrors options.SECRET_OPTION_NAME_RE in spirit. Any detail key
// matching this is dropped WHOLE (we never store the value, and the key name itself signals intent).
const SECRET_KEY_RE = /secret|passw|priv[_-]?key|privatekey|\bkey\b|[_-]key\b|token|jwt|credential|encryption|dkim|\bsalt\b|api[_-]?key|signing|certificate|hash/i;

function isScalar(v: any): boolean {
    return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

// THE "SMALL" IN THE CONTRACT BELOW, AS NUMBERS.
//
// 'secret-free' and 'scalar-only' were enforced; 'small' was not. There was no bound on a string
// value, on an array's length or on the number of keys, so the size of an audit row rested on every
// call site remembering to bound its own strings — 33 call sites' discipline standing in for one
// function's guarantee, in the one table whose unbounded growth is why the retention prune below had
// to be written at all. These are that guarantee, and they hold for a call site that does not exist
// yet.
//
// OVERFLOW IS TRUNCATED AND SAYS SO. A value silently cut short reads as the whole value, which in a
// security log is worse than no value: the marker is what tells a reader they are looking at a
// fragment.
const MAX_DETAIL_STRING = 512;
const MAX_DETAIL_ARRAY = 32;
const MAX_DETAIL_KEYS = 32;
/** The one key sanitizeDetail adds itself, when it had to drop keys to stay inside MAX_DETAIL_KEYS. */
const TRUNCATED_KEYS_MARKER = '_truncated';

function boundString(v: string): string {
    return v.length <= MAX_DETAIL_STRING
        ? v
        : `${v.slice(0, MAX_DETAIL_STRING)}[+${v.length - MAX_DETAIL_STRING} chars]`;
}

function boundArray(v: any[]): any[] {
    const scalars = v.filter(isScalar).map((e: any) => (typeof e === 'string' ? boundString(e) : e));
    return scalars.length <= MAX_DETAIL_ARRAY
        ? scalars
        : scalars.slice(0, MAX_DETAIL_ARRAY).concat([`[+${scalars.length - MAX_DETAIL_ARRAY} more]`]);
}

/**
 * Reduce an arbitrary detail object to a SMALL, secret-free, scalar-only JSON-able map. Drops:
 *   - any key that looks like a secret (SECRET_KEY_RE),
 *   - any non-scalar value (nested objects — the classic place a secret hides),
 *   - array elements that are not scalars.
 * And BOUNDS what survives: every string to MAX_DETAIL_STRING characters, every array to
 * MAX_DETAIL_ARRAY elements, and the map itself to MAX_DETAIL_KEYS keys — plus, when anything had to
 * be dropped for the key cap, one `_truncated` marker saying how many.
 * A non-object input yields {}.
 */
function sanitizeDetail(detail: any): Record<string, any> {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return {};
    const out: Record<string, any> = {};
    let droppedKeys = 0;
    for (const [k, v] of Object.entries(detail)) {
        if (SECRET_KEY_RE.test(k)) continue;                 // never store a secret-named field
        let value: any;
        if (isScalar(v)) {
            value = typeof v === 'string' ? boundString(v) : v;
        } else if (Array.isArray(v)) {                       // keep only scalar elements
            const arr = boundArray(v);
            if (!arr.length) continue;
            value = arr;
        } else {
            continue;  // Nested object / function / etc. — dropped (keeps the blob small and secret-safe).
        }
        // The cap counts only keys that SURVIVED the filters above, so a detail object padded with
        // secret-named or nested junk cannot push a real field out.
        if (!(k in out) && Object.keys(out).length >= MAX_DETAIL_KEYS) { droppedKeys++; continue; }
        out[k] = value;
    }
    if (droppedKeys) out[TRUNCATED_KEYS_MARKER] = `${droppedKeys} more key(s) dropped`;
    return out;
}

/**
 * Record one audit event. Never throws.
 * @param actorId  acting user's id, or null/undefined for a system action.
 * @param action   one of AUDIT_ACTIONS, e.g. 'user.role_change', 'auth.login.failure'.
 * @param targetType  'user' | 'settings' | 'plugin' | 'theme' | 'post' | 'backup' | ...
 * @param targetId    the target's id or slug or option key (stringified).
 * @param detail   optional small object; sanitized before storage.
 */
async function recordAudit(actorId: any, action: AuditAction, targetType: string, targetId: any, detail?: any): Promise<void> {
    try {
        const actor = (actorId === null || actorId === undefined || actorId === '') ? null : Number(actorId);
        const clean = sanitizeDetail(detail);
        await dbAsync.run(
            `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)`,
            [
                Number.isFinite(actor) ? actor : null,
                String(action || ''),
                String(targetType || ''),
                targetId === null || targetId === undefined ? '' : String(targetId),
                JSON.stringify(clean)
            ]
        );
    } catch (e: any) {
        // Log-and-continue: the mutation already happened (or is about to answer) — auditing must not
        // change its outcome.
        console.warn(`[audit] failed to record '${action}': ${e && e.message}`);
    }
}

/**
 * Read a page of the audit log, newest-first. Admin-only at the route layer.
 * @returns { rows, total, limit, offset }
 */
async function listAudit(opts: { limit?: any; offset?: any } = {}): Promise<any> {
    const limit = Math.min(Math.max(parseInt(String(opts.limit), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(opts.offset), 10) || 0, 0);
    const rows = (await dbAsync.all(
        `SELECT id, actor_id, action, target_type, target_id, detail, created_at
         FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`,
        [limit, offset]
    )) || [];
    const totalRow = await dbAsync.get(`SELECT COUNT(*) AS c FROM audit_log`);
    const total = totalRow ? Number(totalRow.c) || 0 : 0;
    return {
        rows: rows.map((r: any) => ({
            id: r.id,
            actorId: r.actor_id,
            action: r.action,
            targetType: r.target_type,
            targetId: r.target_id,
            detail: safeParse(r.detail),
            createdAt: r.created_at
        })),
        total,
        limit,
        offset
    };
}

function safeParse(s: any): any {
    if (!s) return {};
    try { return JSON.parse(String(s)); } catch { return {}; }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// RETENTION
//
// Nothing in the product had ever deleted an audit row, and this batch multiplies the write rate by an
// order of magnitude: every login attempt — including the failed ones an attacker generates for free —
// now lands here. "Append-only" describes the ABSENCE OF TAMPERING, not an obligation to keep a failed
// login from 2021 until the disk fills; a table that only grows, fed by an unauthenticated surface, is
// a full disk with a date on it (the same finding core/analytics-retention closed for wordjs_analytics).
//
// So the log gets an age: rows older than `audit_retention_days` (default 365; 0 = keep for ever) go,
// once a day, driven by core/cron — which already runs its tick under a distributed leader lease, so on
// N nodes the prune executes on exactly one of them per tick.
//
// TWO DETAILS THAT ARE NOT DECORATION:
//   · The cutoff is rendered and the reference instant is read THROUGH core/analytics-retention's
//     helpers rather than re-derived here. Both halves of that comparison — 'YYYY-MM-DD HH:MM:SS'
//     against a CURRENT_TIMESTAMP-stamped column, in the DATABASE's clock frame — were real bugs there
//     (an ISO 'T' sorts after a space; a non-UTC server shifts the window by hours). Deriving a second
//     copy of that reasoning is how the two would drift apart.
//   · The delete walks the PRIMARY KEY, not `created_at` (which carries no index, and adding one means
//     a migration). The table is append-only, so id order IS insertion order: the oldest rows are the
//     lowest ids, the bounded subselect stops as soon as it leaves the window, and the form is portable
//     (Postgres has no DELETE ... LIMIT).
// ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Cron hook the prune is registered under (see core/cron.initDefaultCronEvents). */
const AUDIT_PRUNE_HOOK = 'wordjs_audit_prune';
/** A year of history by default — long enough to investigate an incident nobody noticed for months. */
const DEFAULT_AUDIT_RETENTION_DAYS = 365;
/** Rows removed per statement: bounded so a long-neglected table drains over several passes instead of
 *  one transaction that holds SQLite's global write lock. */
const PRUNE_BATCH = 1000;
/** …and a ceiling per run, so a first prune over years of rows never monopolises the database. */
const PRUNE_MAX_ROWS_PER_RUN = 200_000;
const PRUNE_MAX_RUN_MS = 30_000;

/**
 * Last prune outcome. `behind` means the run hit a cap with rows still outside the window, i.e.
 * retention is losing the race against the write side — the one value here that is a call to action.
 * `retentionDays` is the window the LAST run actually used (null before the first run of this
 * process), not what the option says now: the two differ exactly when an operator has just changed it.
 * Read by routes/health.ts, which reports it next to the other degradations an operator would
 * otherwise only meet as a console line on a boot nobody watches.
 */
let pruneState: {
    lastRunAt: number | null;
    lastRemoved: number;
    behind: boolean;
    lastError: string | null;
    retentionDays: number | null;
} = {
    lastRunAt: null, lastRemoved: 0, behind: false, lastError: null, retentionDays: null
};

/** Configured retention in days, or 0 when the operator has switched pruning off. */
async function auditRetentionDays(): Promise<number> {
    const { getOption } = require('./options');
    const raw = await getOption('audit_retention_days', DEFAULT_AUDIT_RETENTION_DAYS);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_AUDIT_RETENTION_DAYS;
    return Math.floor(n);
}

/**
 * Delete audit rows older than the configured retention. Returns how many were removed.
 * Exported so the test drives it against a real table instead of asserting on a fixture.
 *
 * @param now     TEST SEAM ONLY. Production passes nothing and takes the database's own clock.
 * @param limits  TEST SEAM ONLY. Production uses the module constants above.
 */
async function pruneAuditLog(
    now: number | null = null,
    limits: { batch?: number; maxRows?: number; maxMs?: number } = {}
): Promise<number> {
    const batch = limits.batch || PRUNE_BATCH;
    const maxRows = limits.maxRows || PRUNE_MAX_ROWS_PER_RUN;
    const maxMs = limits.maxMs || PRUNE_MAX_RUN_MS;
    const startedAt = Date.now();

    const days = await auditRetentionDays();
    if (days <= 0) {
        pruneState = { ...pruneState, lastRunAt: startedAt, lastRemoved: 0, behind: false, retentionDays: days };
        return 0;
    }

    // One implementation of "the cutoff, in the producer's format and the producer's clock frame".
    const { dbTimestamp, databaseNowMs } = require('./analytics-retention');
    const reference = typeof now === 'number' ? now : await databaseNowMs(Date.now());
    const cutoff = dbTimestamp(reference - days * 86400000);

    let removed = 0;
    let cappedOut = false;
    for (;;) {
        const room = maxRows - removed;
        if (room <= 0) { cappedOut = true; break; }
        if (Date.now() - startedAt > maxMs) { cappedOut = true; break; }
        const want = Math.min(batch, room);
        const doomed = await dbAsync.all(
            `SELECT id FROM audit_log WHERE created_at < ? ORDER BY id ASC LIMIT ?`,
            [cutoff, want]
        );
        if (!doomed || doomed.length === 0) break;
        const placeholders = doomed.map(() => '?').join(',');
        await dbAsync.run(`DELETE FROM audit_log WHERE id IN (${placeholders})`, doomed.map((r: any) => r.id));
        removed += doomed.length;
        if (doomed.length < want) break;   // the window is drained
    }

    // Stopping at a cap is not finishing: ask the table whether anything outside the window survived.
    if (cappedOut) {
        const leftover = await dbAsync.all(`SELECT id FROM audit_log WHERE created_at < ? LIMIT 1`, [cutoff]);
        cappedOut = !!(leftover && leftover.length);
    }

    pruneState = { lastRunAt: Date.now(), lastRemoved: removed, behind: cappedOut, lastError: null, retentionDays: days };
    return removed;
}

/** What the last prune did — for the cron log and for anyone asking whether retention is keeping up. */
function auditRetentionState() {
    return { ...pruneState };
}

/**
 * The cron handler, as a plain function so core/cron can register it and a test can call it.
 * Never throws: a failing prune must not abort the cron tick that also runs the backup.
 */
async function runAuditRetention(): Promise<number> {
    try {
        const removed = await pruneAuditLog();
        if (removed > 0) {
            console.log(`⏰ audit: pruned ${removed} row(s) past the retention window`);
            // The prune is the ONE thing that removes evidence, so it leaves evidence of itself: an
            // operator reading a thin log must be able to tell "nothing happened" from "it was pruned".
            await recordAudit(null, AUDIT_ACTIONS.AUDIT_PRUNE, 'audit_log', '', {
                removed, retentionDays: await auditRetentionDays()
            });
        }
        if (pruneState.behind) {
            console.warn(
                `⚠️  audit retention is BEHIND: ${removed} row(s) removed and the table still holds rows ` +
                'outside the window. Lower audit_retention_days or run the prune more often.'
            );
        }
        return removed;
    } catch (e: any) {
        pruneState = { ...pruneState, lastRunAt: Date.now(), lastError: String(e && e.message) };
        console.error('Audit retention prune failed:', e && e.message);
        return 0;
    }
}

module.exports = {
    recordAudit, listAudit, sanitizeDetail,
    AUDIT_ACTIONS,
    pruneAuditLog, runAuditRetention, auditRetentionState, auditRetentionDays,
    AUDIT_PRUNE_HOOK, DEFAULT_AUDIT_RETENTION_DAYS,
    MAX_DETAIL_STRING, MAX_DETAIL_ARRAY, MAX_DETAIL_KEYS
};
