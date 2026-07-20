/**
 * WordJS - API Token model (scoped, revocable personal access tokens for headless/machine clients).
 *
 * A token authenticates AS the issuing user through the `Authorization: Bearer wjt_<secret>` path, which
 * is CSRF-exempt (a machine client carries no ambient session cookie). It is bounded by BOTH:
 *   • the user's live role capabilities — every downstream `req.user.can(...)` / isAdmin check still runs,
 *     so a token can NEVER do more than the user could in the browser; and
 *   • the token's own read/write scope — a coarse gate on top (a `read` token cannot mutate anything).
 * Effective permission = user capabilities ∩ token scope (least privilege).
 *
 * We store ONLY a sha256 of the full token. The plaintext is returned exactly once (at creation) and is
 * unrecoverable afterwards — a leaked database yields no usable tokens. sha256 (not bcrypt) is correct
 * here: the token itself is 256 bits of CSPRNG entropy, so it is not brute-forceable; slow hashing is for
 * low-entropy passwords, not high-entropy secrets (this mirrors how GitHub/GitLab store PATs).
 */

const { dbAsync } = require('../config/database');
const crypto = require('crypto');

const PREFIX = 'wjt_';
// Recognized scopes. 'read' = safe methods only; 'write' also permits mutations (and implies read).
const ALLOWED_SCOPES = ['read', 'write'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hashToken(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Coerce arbitrary scope input (array or comma-string, possibly with '*'/'all'/'full' shorthands) into
 * the canonical, deduped, ordered set. Falls back to the least-privilege ['read'] when nothing valid is
 * given — a token is never created with more power than was explicitly requested.
 */
function normalizeScopes(input: any): string[] {
    let parts: string[];
    if (Array.isArray(input)) parts = input.map((s) => String(s));
    else if (typeof input === 'string') parts = input.split(',');
    else parts = [];
    const wanted = new Set<string>();
    for (const raw of parts) {
        const s = raw.trim().toLowerCase();
        if (!s) continue;
        if (s === '*' || s === 'all' || s === 'full') { wanted.add('read'); wanted.add('write'); continue; }
        if (ALLOWED_SCOPES.includes(s)) wanted.add(s);
    }
    // 'write' implies 'read' so a full token can also fetch.
    if (wanted.has('write')) wanted.add('read');
    if (wanted.size === 0) wanted.add('read');
    // Stable order (read before write) for deterministic storage/tests.
    return ALLOWED_SCOPES.filter((s) => wanted.has(s));
}

/**
 * Does a token with `scopes` permit an HTTP `method`? Safe methods need 'read'; anything mutating needs
 * 'write'. (normalizeScopes guarantees 'write' ⇒ 'read', so a write token also passes the read gate.)
 */
function scopeAllowsMethod(scopes: string[], method: string): boolean {
    const list = Array.isArray(scopes) ? scopes : String(scopes || '').split(',');
    if (SAFE_METHODS.has(String(method).toUpperCase())) return list.includes('read');
    return list.includes('write');
}

// last_used_at is best-effort telemetry, so throttle the write to at most once/minute per token to avoid
// a DB round-trip on every single API request. In-process only; a multi-node deploy just writes per node.
const _touchedAt = new Map<number, number>();
const TOUCH_THROTTLE_MS = 60 * 1000;

class ApiToken {
    /**
     * Mint a new token for a user. Returns the PLAINTEXT token exactly once (never stored/recoverable),
     * plus display metadata. `expiresInDays` is optional (null = never expires until revoked).
     */
    static async generate(opts: { userId: number; name?: string; scopes?: any; expiresInDays?: number | null }) {
        const { userId } = opts;
        const name = String(opts.name || '').slice(0, 200).trim() || 'API token';
        const scopes = normalizeScopes(opts.scopes);
        const secret = crypto.randomBytes(32).toString('base64url'); // 256 bits, URL/header-safe
        const raw = PREFIX + secret;
        const tokenHash = hashToken(raw);
        // A short, non-secret prefix so a user can recognize a token in the list without ever seeing the
        // full value again. It is not enough to authenticate with (the secret is 256 bits).
        const tokenPrefix = raw.slice(0, 12);

        let expiresAt: number | null = null;
        if (opts.expiresInDays != null) {
            const days = Number(opts.expiresInDays);
            if (Number.isFinite(days) && days > 0) {
                expiresAt = Math.floor(Date.now() / 1000) + Math.floor(days) * 86400;
            }
        }

        const result = await dbAsync.run(
            `INSERT INTO api_tokens (user_id, name, token_hash, token_prefix, scopes, expires_at, revoked)
             VALUES (?, ?, ?, ?, ?, ?, 0) RETURNING id`,
            [userId, name, tokenHash, tokenPrefix, scopes.join(','), expiresAt]
        );
        return {
            id: result.lastID,
            token: raw, // shown ONCE — the caller must surface it now
            tokenPrefix,
            name,
            scopes,
            expiresAt
        };
    }

    /**
     * Resolve a raw `wjt_...` token to its (non-secret) record, or null if it is not a valid, active,
     * unexpired token. This is the hot path on every API-token-authenticated request.
     */
    static async findByRawToken(raw: string): Promise<null | {
        id: number; userId: number; name: string; scopes: string[]; tokenPrefix: string; expiresAt: number | null;
    }> {
        if (typeof raw !== 'string' || !raw.startsWith(PREFIX)) return null;
        const row = await dbAsync.get('SELECT * FROM api_tokens WHERE token_hash = ?', [hashToken(raw)]);
        if (!row) return null;
        if (row.revoked) return null;
        if (row.expires_at != null && Number(row.expires_at) * 1000 <= Date.now()) return null;
        return {
            id: row.id,
            userId: row.user_id,
            name: row.name,
            scopes: String(row.scopes || 'read').split(',').filter(Boolean),
            tokenPrefix: row.token_prefix,
            expiresAt: row.expires_at != null ? Number(row.expires_at) : null
        };
    }

    /** List a user's tokens for display — metadata only, NEVER the hash. */
    static async listForUser(userId: number) {
        const rows = await dbAsync.all(
            `SELECT id, name, token_prefix, scopes, last_used_at, expires_at, revoked, created_at
             FROM api_tokens WHERE user_id = ? ORDER BY id DESC`,
            [userId]
        );
        return (rows || []).map((r: any) => ({
            id: r.id,
            name: r.name,
            tokenPrefix: r.token_prefix,
            scopes: String(r.scopes || '').split(',').filter(Boolean),
            lastUsedAt: r.last_used_at != null ? Number(r.last_used_at) : null,
            expiresAt: r.expires_at != null ? Number(r.expires_at) : null,
            revoked: !!r.revoked,
            createdAt: r.created_at
        }));
    }

    /** Revoke a token the user owns. Returns true if a matching, still-active token was revoked. */
    static async revoke(id: number, userId: number): Promise<boolean> {
        const result = await dbAsync.run(
            'UPDATE api_tokens SET revoked = 1 WHERE id = ? AND user_id = ? AND revoked = 0',
            [id, userId]
        );
        return !!(result && (result.changes > 0 || result.rowCount > 0));
    }

    /** Best-effort, throttled last-used stamp (epoch seconds). Never throws — telemetry, not correctness. */
    static touch(id: number): void {
        const now = Date.now();
        const last = _touchedAt.get(id) || 0;
        if (now - last < TOUCH_THROTTLE_MS) return;
        _touchedAt.set(id, now);
        Promise.resolve(
            dbAsync.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [Math.floor(now / 1000), id])
        ).catch(() => { /* telemetry write failed — ignore */ });
    }

    static normalizeScopes = normalizeScopes;
    static scopeAllowsMethod = scopeAllowsMethod;
    static ALLOWED_SCOPES = ALLOWED_SCOPES;
    static PREFIX = PREFIX;
}

module.exports = ApiToken;
