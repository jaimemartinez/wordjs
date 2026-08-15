/**
 * WordJS — Append-only audit trail (FRENTE C-3).
 *
 * A thin, best-effort recorder for security-relevant mutations: who (actor), what (action), on what
 * (target type + id), when (created_at), and a small JSON `detail`. The table (audit_log, migration
 * 0009) is APPEND-ONLY — there is no update/delete path in the app, and the only reader is the admin
 * GET /api/v1/audit endpoint.
 *
 * TWO HARD RULES the callers rely on:
 *   1. NEVER block or fail the mutation. recordAudit swallows every error (log-and-continue): a broken
 *      audit insert must never turn a successful role change into a 500. It is a single INSERT.
 *   2. NEVER persist secret material. `detail` is sanitized here — any key that looks like a
 *      secret/password/token is dropped, and only scalars (or arrays of scalars) survive, so a caller
 *      can't accidentally smuggle a password/hash/token into the log through a nested object.
 */

const { dbAsync } = require('../config/database');

// Keys whose VALUES would be secrets — mirrors options.SECRET_OPTION_NAME_RE in spirit. Any detail key
// matching this is dropped WHOLE (we never store the value, and the key name itself signals intent).
const SECRET_KEY_RE = /secret|passw|priv[_-]?key|privatekey|\bkey\b|[_-]key\b|token|jwt|credential|encryption|dkim|\bsalt\b|api[_-]?key|signing|certificate|hash/i;

function isScalar(v: any): boolean {
    return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * Reduce an arbitrary detail object to a SMALL, secret-free, scalar-only JSON-able map. Drops:
 *   - any key that looks like a secret (SECRET_KEY_RE),
 *   - any non-scalar value (nested objects — the classic place a secret hides),
 *   - array elements that are not scalars.
 * A non-object input yields {}.
 */
function sanitizeDetail(detail: any): Record<string, any> {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return {};
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(detail)) {
        if (SECRET_KEY_RE.test(k)) continue;                 // never store a secret-named field
        if (isScalar(v)) { out[k] = v; continue; }
        if (Array.isArray(v)) {                              // keep only scalar elements
            const arr = v.filter(isScalar);
            if (arr.length) out[k] = arr;
            continue;
        }
        // Nested object / function / etc. — dropped (keeps the blob small and secret-safe).
    }
    return out;
}

/**
 * Record one audit event. Never throws.
 * @param actorId  acting user's id, or null/undefined for a system action.
 * @param action   dotted action name, e.g. 'user.role_change', 'plugin.activate'.
 * @param targetType  'user' | 'settings' | 'plugin' | 'theme' | ...
 * @param targetId    the target's id or slug or option key (stringified).
 * @param detail   optional small object; sanitized before storage.
 */
async function recordAudit(actorId: any, action: string, targetType: string, targetId: any, detail?: any): Promise<void> {
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

module.exports = { recordAudit, listAudit, sanitizeDetail };
