/**
 * SESSION REVOCATION — one session, or all of them.
 *
 * Sessions are stateless JWTs. Until now the only way to end one was the account's security epoch
 * (user meta `token_valid_after`): every token issued at or before it is dead. Logout stamped that epoch,
 * so signing out in one browser signed the user out of every browser and device, without a word —
 * "Sign out" behaved as "Sign out everywhere".
 *
 * Now every session carries a random id (`ses`) from the moment it is signed in, kept across the sliding
 * refresh. Logout revokes THAT id only, by listing it in the user meta below
 * (`{ "<ses>": <exp seconds> }`, key `revoked_session_tokens`); an entry is pruned once the token it names has expired anyway, and the
 * list is bounded. The epoch is unchanged and still ends every session at once: password changes, an
 * administrator's reset, and the explicit «sign out of all sessions» action
 * (POST /users/me/sessions/revoke). A token minted before this existed has no `ses`; logging it out
 * falls back to the epoch, which is what happened before.
 *
 * The list is account-security meta: only this module writes it (models/User protects it from
 * every profile write).
 */
const crypto = require('crypto');

// The name contains "token" on purpose: User.toJSON strips such keys from every serialized user.
const REVOKED_SESSIONS_META = 'revoked_session_tokens';
const SESSION_ID_CLAIM = 'ses';
/** Bound on the list: past it the oldest-expiring entries go first (they are the next to die anyway). */
const MAX_REVOKED_SESSIONS = 200;

function newSessionId(): string {
    return crypto.randomBytes(16).toString('base64url');
}

/** The `{ ses: exp }` map stored in user meta, defensively parsed. */
function readRevokedSessions(user: any): Record<string, number> {
    const raw = user && user.meta ? user.meta[REVOKED_SESSIONS_META] : undefined;
    if (!raw) return {};
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw); } catch { return {}; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = Object.create(null);
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const exp = Number(v);
        if (typeof k === 'string' && k && Number.isFinite(exp)) out[k] = exp;
    }
    return out;
}

/**
 * Is this decoded session token revoked for this user? The epoch (`token_valid_after`, inclusive: JWT
 * `iat` is whole seconds and the epoch is stamped as floor(now/1000)) or its own id in the list.
 */
function isSessionRevoked(user: any, decoded: any): boolean {
    if (!user || !decoded) return true;
    const validAfter = parseInt(user.meta && user.meta.token_valid_after, 10);
    if (validAfter && decoded.iat && decoded.iat <= validAfter) return true;
    const ses = decoded[SESSION_ID_CLAIM];
    if (typeof ses === 'string' && ses) {
        const revoked = readRevokedSessions(user);
        if (Object.prototype.hasOwnProperty.call(revoked, ses)) return true;
    }
    return false;
}

/** The list with `ses` added and everything already expired (or over the bound) dropped. */
function withRevokedSession(current: Record<string, number>, ses: string, exp: number, nowSeconds: number): Record<string, number> {
    const entries = Object.entries(current).filter(([, e]) => e > nowSeconds);
    entries.push([ses, exp]);
    entries.sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(entries.slice(0, MAX_REVOKED_SESSIONS));
}

/**
 * End one session. `decoded` is the live session token being signed out. Returns 'session' when only
 * that session was revoked, 'all' when the token predates session ids and the epoch had to be used.
 */
async function revokeSession(userId: number, decoded: any): Promise<'session' | 'all'> {
    const User = require('../models/User');
    const now = Math.floor(Date.now() / 1000);
    const ses = decoded && decoded[SESSION_ID_CLAIM];
    if (typeof ses !== 'string' || !ses) {
        await User.updateMeta(userId, 'token_valid_after', String(now));
        return 'all';
    }
    const user = await User.findById(userId);
    const exp = Number(decoded.exp) > now ? Number(decoded.exp) : now + 7 * 24 * 3600;
    const next = withRevokedSession(readRevokedSessions(user), ses, exp, now);
    await User.updateMeta(userId, REVOKED_SESSIONS_META, JSON.stringify(next));
    return 'session';
}

module.exports = {
    REVOKED_SESSIONS_META,
    SESSION_ID_CLAIM,
    newSessionId,
    readRevokedSessions,
    isSessionRevoked,
    withRevokedSession,
    revokeSession,
};
