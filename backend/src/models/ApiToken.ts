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
// Recognized GLOBAL scopes. 'read' = safe methods on ANY resource; 'write' also permits mutations on any
// resource (and implies read). These are the coarse, all-resource grants.
const GLOBAL_SCOPES = ['read', 'write'];
// Backward-compatible alias (was the whole scope vocabulary before per-resource scopes existed).
const ALLOWED_SCOPES = GLOBAL_SCOPES;
// A per-resource scope is `<resource>:<action>`, e.g. `posts:write`, `media:read`. The resource is the
// first URL path segment after the API prefix (posts, pages, media, comments, users, …). A token carrying
// only resource scopes is confined to those resources — true least privilege for a headless client that
// should, say, publish posts but never touch users. Resource names are plain lowercase slugs.
const RESOURCE_SCOPE_RE = /^([a-z][a-z0-9-]*):(read|write)$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hashToken(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Split raw scope input (array or comma-string) into trimmed, lowercased, non-empty tokens. */
function scopeTokens(input: any): string[] {
    let parts: string[];
    if (Array.isArray(input)) parts = input.map((s) => String(s));
    else if (typeof input === 'string') parts = input.split(',');
    else parts = [];
    return parts.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Is a single scope token recognized (a global/shorthand, or a `<resource>:read|write`)? */
function isKnownScope(s: string): boolean {
    return s === '*' || s === 'all' || s === 'full' || GLOBAL_SCOPES.includes(s) || RESOURCE_SCOPE_RE.test(s);
}

/**
 * The supplied scope tokens that are NOT recognized. The create route rejects a request with any of these
 * (400) rather than silently dropping them — silent-drop is dangerous when it empties the set (see
 * normalizeScopes), and confusing when it merely narrows the grant below what was asked for.
 */
function invalidScopes(input: any): string[] {
    return scopeTokens(input).filter((s) => !isKnownScope(s));
}

/**
 * Coerce arbitrary scope input (array or comma-string, possibly with '*'/'all'/'full' shorthands) into
 * the canonical, deduped, ordered set. A token is NEVER granted more power than was explicitly requested:
 *   • no scopes supplied at all  → least-privilege ['read'] (the sensible default for an unspecified token);
 *   • scopes supplied but NONE valid → [] (no access), NOT global read — silently widening a typo like
 *     `posts:*` into an all-resource read token would break confinement. The create route 400s this case.
 */
function normalizeScopes(input: any): string[] {
    const parts = scopeTokens(input);
    const wanted = new Set<string>();
    for (const s of parts) {
        if (s === '*' || s === 'all' || s === 'full') { wanted.add('read'); wanted.add('write'); continue; }
        if (GLOBAL_SCOPES.includes(s)) { wanted.add(s); continue; }
        if (RESOURCE_SCOPE_RE.test(s)) { wanted.add(s); continue; }
        // Unrecognized tokens are dropped here (defense in depth); the route rejects them before we get here.
    }
    // 'write' implies 'read' at the same level so a write grant can also fetch: globally, and per-resource
    // (`posts:write` ⇒ `posts:read`).
    if (wanted.has('write')) wanted.add('read');
    for (const s of [...wanted]) {
        const m = RESOURCE_SCOPE_RE.exec(s);
        if (m && m[2] === 'write') wanted.add(`${m[1]}:read`);
    }
    if (wanted.size === 0) {
        // No VALID scopes resulted. Default to least-privilege read ONLY when nothing was supplied; if the
        // caller supplied scopes that were all unrecognized (e.g. `posts:*`), return [] (no access) rather
        // than silently widening to global read. (The create route rejects this before it can be stored.)
        return parts.length === 0 ? ['read'] : [];
    }
    // Stable order for deterministic storage/tests: global scopes first (read, write), then resource
    // scopes sorted alphabetically.
    const global = GLOBAL_SCOPES.filter((s) => wanted.has(s));
    const resource = [...wanted].filter((s) => !GLOBAL_SCOPES.includes(s)).sort();
    return [...global, ...resource];
}

/**
 * Does a token with `scopes` permit an HTTP `method` against `resource` (the URL's resource segment, e.g.
 * 'posts')? A request is allowed when the token holds EITHER the matching global scope OR the matching
 * per-resource scope:
 *   • safe method  → global 'read'/'write', or `<resource>:read`/`<resource>:write`
 *   • mutating     → global 'write', or `<resource>:write`
 * Self-contained (does not rely on normalizeScopes' write⇒read expansion) so it is correct for any stored
 * or hand-crafted scope list. An empty/unknown `resource` matches ONLY the global scopes — a resource-
 * scoped token is denied on a route we cannot classify (fail-closed / least privilege).
 */
function scopeAllows(scopes: string[] | string, method: string, resource: string): boolean {
    const list = Array.isArray(scopes)
        ? scopes
        : String(scopes || '').split(',').map((s) => s.trim()).filter(Boolean);
    const has = (s: string) => list.includes(s);
    const r = String(resource || '').toLowerCase();
    if (SAFE_METHODS.has(String(method).toUpperCase())) {
        return has('read') || has('write') || (!!r && (has(`${r}:read`) || has(`${r}:write`)));
    }
    return has('write') || (!!r && has(`${r}:write`));
}

/**
 * Back-compat shim: the old method-only gate, equivalent to scopeAllows with no resource context (global
 * scopes only). Retained for any caller that cannot supply a resource.
 */
function scopeAllowsMethod(scopes: string[], method: string): boolean {
    return scopeAllows(scopes, method, '');
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
            // A NULL column (legacy/defensive) means 'read'; a genuinely EMPTY string means no access — do
            // NOT let `|| 'read'` resurrect an empty scope set into a global-read token.
            scopes: (row.scopes == null ? 'read' : String(row.scopes)).split(',').filter(Boolean),
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

    /**
     * Revoke ALL of a user's still-active tokens at once. Called on password change/reset so that
     * compromise recovery actually invalidates every credential (the JWT `token_valid_after` epoch does
     * not reach the API-token path). Returns the number of tokens revoked.
     */
    static async revokeAllForUser(userId: number): Promise<number> {
        const result = await dbAsync.run(
            'UPDATE api_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0',
            [userId]
        );
        return (result && (result.changes ?? result.rowCount)) || 0;
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
    static invalidScopes = invalidScopes;
    static scopeAllows = scopeAllows;
    static scopeAllowsMethod = scopeAllowsMethod;
    static ALLOWED_SCOPES = ALLOWED_SCOPES;
    static GLOBAL_SCOPES = GLOBAL_SCOPES;
    static PREFIX = PREFIX;
}

module.exports = ApiToken;
