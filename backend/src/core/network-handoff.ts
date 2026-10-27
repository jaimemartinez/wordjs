/**
 * WordJS — the network administrator's "open as administrator" handoff into a site (multisite).
 *
 * A network administrator signs in on the main site. Their account lives in the main site's database and
 * means nothing on any other site (user ids repeat across a network), so they reach another site's admin
 * only through this explicit, audited, short-lived handoff:
 *
 *   1. ISSUE (main site, POST /network/sites/:id/handoff). The network administrator re-authenticates
 *      with their password. The main site signs a one-time token WITH THE TARGET SITE'S KEY
 *      (core/site-keys, `sid` = the target) that names the network administrator (id and login), the
 *      target's main address (`aud`) and a random id (`jti`), valid for HANDOFF_TOKEN_SECONDS. The `jti`
 *      is written to the network store (network_handoffs). Recorded in the network audit log
 *      (site.handoff.issued). The answer is the URL the browser follows: the site's main address,
 *      /login/handoff, the token in the FRAGMENT (never sent to a server, never in a log or a Referer).
 *   2. REDEEM (the target site, POST /auth/handoff, from that page). The token must verify with this
 *      site's key and name this site, have been sent to the address it names, and its `jti` must still
 *      be in the network store: deleting the row is the redemption, so a token works once, on whichever
 *      node receives it. The site must be active and the network administrator still listed. The site's
 *      handoff account for that network administrator (below) gets a session marked as a handoff (`hof`:
 *      who, from which address, until when) that ends after HANDOFF_SESSION_SECONDS and cannot be
 *      refreshed beyond it. Recorded in BOTH logs: the site's own (auth.network_handoff) and the
 *      network's (site.handoff.redeemed). A refused redemption whose token verified is recorded in the
 *      network log too (site.handoff.refused), so a replay or a token used on the wrong address is seen.
 *
 * THE HANDOFF ACCOUNT. Everything a session writes is attributed to a row of the SITE's users table: a
 * post's author, a revision, an upload, a comment moderation, an edit lock, the actor of an audit row.
 * The network administrator's own id belongs to the main site's table and, on this site, to whichever
 * site user happens to hold the same id — acting under it would attribute their writes to that person.
 * A synthetic user with no row breaks every model that looks the actor up. So each network administrator
 * gets ONE dedicated account per site, created by their first handoff into it and reused afterwards:
 *   · it is marked in user_meta (`network_handoff_of` = "<network admin id>:<login>"), a key no request
 *     can write (models/User PROTECTED_META);
 *   · it has a random password nobody knows and an address under the reserved `.invalid` domain, and it
 *     can never sign in by itself: the password sign-in refuses it, and a session for it that does not
 *     carry the `hof` claim of a live handoff is no session (handoffSessionRefusal);
 *   · nothing may change it but the handoff: the site's administrators cannot edit it, reset its
 *     second factor, delete it or rewrite it through a site import, and a handoff session
 *     cannot mint credentials that would outlive it (API tokens, agent connections, two-factor
 *     enrolment, a profile write of its own account) — refuseHandoffSession;
 *   · its role is set back to administrator on every handoff.
 * The site's administrators therefore see exactly who came in (Users and the audit log), and the
 * account carries no standing access of its own.
 */
import type { Request, Response, NextFunction } from 'express';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const siteContext = require('./site-context');
const network = require('./network');
const { siteSigningKey } = require('./site-keys');
const log = require('./module-logger').moduleLogger('core/network-handoff');

const HANDOFF_PURPOSE = 'network_handoff';
/** How long the one-time token lives: long enough for a redirect, not for a copy-paste session. */
const HANDOFF_TOKEN_SECONDS = 60;
/** How long the session it starts lives. A refresh never extends it. */
const HANDOFF_SESSION_SECONDS = 30 * 60;
/** The user_meta key that marks a site account as a network administrator's handoff account. */
const HANDOFF_META = 'network_handoff_of';
/** The path on the target site that redeems a token (frontend/src/app/login/handoff). */
const HANDOFF_PATH = '/login/handoff';

/** What a handoff session carries about itself (the `hof` claim). */
export type HandoffClaim = { uid: number; by: string; from: string; exp: number };

function codedError(code: string, message: string, status: number): Error & { code: string; status: number } {
    const e = new Error(message) as Error & { code: string; status: number };
    e.code = code;
    e.status = status;
    return e;
}

const accountKey = (uid: number, login: string) => `${uid}:${login}`;

function isHandoffClaim(v: any): v is HandoffClaim {
    return !!v && typeof v === 'object'
        && Number.isSafeInteger(v.uid) && v.uid > 0
        && typeof v.by === 'string' && v.by.length > 0 && v.by.length <= 255
        && typeof v.from === 'string' && v.from.length <= 255
        && Number.isSafeInteger(v.exp);
}

/** The value of the handoff mark on a loaded user, or null. */
function handoffMarkOf(user: any): string | null {
    const v = user && user.meta ? user.meta[HANDOFF_META] : null;
    return typeof v === 'string' && v ? v : null;
}

/** Is this user a network administrator's handoff account? */
function isHandoffAccount(user: any): boolean {
    return handoffMarkOf(user) !== null;
}

/** The main site's own address (where every handoff comes from): its hostname. */
function mainHost(): string {
    const primary = network.getSite(siteContext.PRIMARY_SITE_ID);
    return primary ? String(primary.mainHost) : '';
}

/**
 * ISSUE a handoff into `siteId` for the network administrator `admin` (runs on the main site, after the
 * route re-authenticated them). Resolves to the URL to follow and when the token expires.
 */
async function issueHandoff(siteId: number, admin: { id: number; login: string }, opts: { mfa?: boolean; ip?: string } = {}) {
    const site = network.getSite(siteId);
    if (!site) throw codedError('network_site_not_found', 'No such site.', 404);
    if (site.id === siteContext.PRIMARY_SITE_ID) {
        throw codedError('network_primary_site', 'The main site is administered directly, not through a handoff.', 400);
    }
    if (site.status !== 'active') throw codedError('network_site_suspended', 'A suspended site cannot be opened.', 409);
    if (!site.mainHost) throw codedError('network_site_not_found', 'The site has no address.', 404);

    const nowSec = Math.floor(Date.now() / 1000);
    const exp = nowSec + HANDOFF_TOKEN_SECONDS;
    const jti = crypto.randomBytes(24).toString('base64url');
    // Expired rows of every site go first: a token nobody redeemed leaves nothing behind for long.
    await network.storeRun('DELETE FROM network_handoffs WHERE expires_at < ?', [nowSec]);
    await network.storeRun('INSERT INTO network_handoffs (jti, site_id, admin_user_id, expires_at) VALUES (?, ?, ?, ?)',
        [jti, site.id, admin.id, exp]);
    const claims: Record<string, unknown> = {
        purpose: HANDOFF_PURPOSE,
        sid: site.id,
        jti,
        uid: admin.id,
        by: admin.login,
        aud: site.mainHost,
        from: mainHost(),
        iat: nowSec,
        exp,
    };
    if (opts.mfa) claims.amr = ['mfa'];
    // Signed with the TARGET's key: the token is worthless on every other site, the main one included.
    const token = jwt.sign(claims, siteSigningKey(site.id), { algorithm: 'HS256' });
    await network.audit('site.handoff.issued', {
        actor: admin.id,
        siteId: site.id,
        detail: { login: admin.login, host: site.mainHost, ip: opts.ip || null, expiresAt: new Date(exp * 1000).toISOString() },
    });
    const base = String(site.mainUrl).replace(/\/+$/, '');
    return { url: `${base}${HANDOFF_PATH}#token=${encodeURIComponent(token)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** A refusal at redemption: recorded in the network log when the token named its network administrator. */
async function refuse(code: string, message: string, status: number, decoded: any, detail: Record<string, unknown>): Promise<never> {
    if (decoded && Number.isSafeInteger(decoded.uid)) {
        try {
            await network.audit('site.handoff.refused', { actor: decoded.uid, siteId: siteContext.currentSiteIdOrNull(), detail: { reason: code, ...detail } });
        } catch (e: any) {
            log.warn({ err: e }, '[network-handoff] the refusal could not be recorded');
        }
    }
    throw codedError(code, message, status);
}

/**
 * REDEEM a token on the current site (POST /auth/handoff). `hostname` is the address the request was
 * actually sent to. Resolves to the handoff account and the `hof` claim its session carries; the route
 * mints the session (generateToken + issueSessionCookie) and records the site's audit row.
 */
async function redeemHandoff(rawToken: unknown, hostname: string | null, opts: { ip?: string } = {}) {
    const siteId = siteContext.currentSiteIdOrNull();
    if (!siteContext.multisiteEnabled() || siteId === null || siteId === siteContext.PRIMARY_SITE_ID) {
        throw codedError('rest_no_route', 'No route was found matching the URL and request method.', 404);
    }
    if (typeof rawToken !== 'string' || !rawToken || rawToken.length > 4096) {
        throw codedError('network_handoff_invalid', 'This link is not valid.', 401);
    }
    let decoded: any;
    try {
        // This site's key, HS256 only; `sid` must name this site (core/site-keys verifyForSite).
        decoded = require('./site-keys').verifyForSite(rawToken);
    } catch (e: any) {
        if (e && e.name === 'TokenExpiredError') throw codedError('network_handoff_expired', 'This link has expired. Open the site again from the network screen.', 401);
        throw codedError('network_handoff_invalid', 'This link is not valid.', 401);
    }
    if (!decoded || decoded.purpose !== HANDOFF_PURPOSE || typeof decoded.jti !== 'string'
        || !Number.isSafeInteger(decoded.uid) || typeof decoded.by !== 'string' || !decoded.by || typeof decoded.aud !== 'string') {
        throw codedError('network_handoff_invalid', 'This link is not valid.', 401);
    }

    // ONE use, whatever happens next: the row is deleted before anything else is judged, so a token that
    // was refused (another address, a suspended site) cannot be tried again either.
    const consumed = await network.storeRun('DELETE FROM network_handoffs WHERE jti = ? AND site_id = ? AND admin_user_id = ?',
        [decoded.jti, siteId, decoded.uid]);
    if (consumed !== 1) {
        return refuse('network_handoff_used', 'This link has already been used.', 401, decoded, { host: hostname });
    }
    if (!hostname || hostname.toLowerCase() !== String(decoded.aud).toLowerCase()) {
        return refuse('network_handoff_wrong_host', 'This link belongs to another address.', 401, decoded, { host: hostname, expected: decoded.aud });
    }
    const site = network.getSite(siteId);
    if (!site || site.status !== 'active') {
        return refuse('network_site_suspended', 'This site is suspended.', 409, decoded, { host: hostname });
    }
    if (!network.isNetworkAdmin(decoded.uid, decoded.by)) {
        return refuse('network_handoff_not_admin', 'Only a network administrator can open a site this way.', 403, decoded, { host: hostname });
    }

    const account = await ensureHandoffAccount(decoded.uid, decoded.by);
    const nowSec = Math.floor(Date.now() / 1000);
    const handoff: HandoffClaim = {
        uid: decoded.uid,
        by: decoded.by,
        from: typeof decoded.from === 'string' ? decoded.from.slice(0, 255) : '',
        exp: nowSec + HANDOFF_SESSION_SECONDS,
    };
    const expiresAt = new Date(handoff.exp * 1000).toISOString();
    await network.audit('site.handoff.redeemed', {
        actor: decoded.uid,
        siteId,
        detail: { login: decoded.by, host: hostname, account: account.id, ip: opts.ip || null, expiresAt },
    });
    return { user: account, handoff, mfa: Array.isArray(decoded.amr) && decoded.amr.includes('mfa'), expiresAt };
}

/** The login a new handoff account gets: `network.<login>`, made unique on this site. */
async function freeLogin(User: any, login: string, uid: number): Promise<string> {
    const base = `network.${String(login).replace(/[^A-Za-z0-9_.-]/g, '_')}`.slice(0, 40);
    for (const candidate of [base, `${base}-${uid}`]) {
        if (!(await User.identifierInUse(candidate))) return candidate;
    }
    return `${base}-${uid}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * The current site's handoff account for network administrator (uid, login): found by its mark, or
 * created. Never an existing account of the site without the mark, whatever its login.
 */
async function ensureHandoffAccount(uid: number, login: string) {
    const User = require('../models/User');
    const { dbAsync } = require('../config/database');
    const key = accountKey(uid, login);
    const row = await dbAsync.get(`SELECT user_id FROM user_meta WHERE meta_key = ? AND meta_value = ? ORDER BY user_id LIMIT 1`, [HANDOFF_META, key]);
    if (row) {
        const existing = await User.findById(Number(row.user_id));
        if (existing) {
            if (existing.getRole() !== 'administrator') {
                await User.updateMeta(existing.id, 'role', 'administrator');
                await require('./cache').del(`user:${existing.id}`);
                return User.findById(existing.id);
            }
            return existing;
        }
    }
    const created = await User.create({
        username: await freeLogin(User, login, uid),
        email: `network-${uid}-${crypto.randomBytes(6).toString('hex')}@handoff.invalid`,
        // Nobody knows it, and the password sign-in refuses the account anyway.
        password: crypto.randomBytes(32).toString('base64url'),
        displayName: `${login} (network administrator)`,
        role: 'administrator',
    });
    await User.updateMeta(created.id, HANDOFF_META, key);
    await require('./cache').del(`user:${created.id}`);
    return User.findById(created.id);
}

/**
 * Why a session JWT may NOT authenticate `user` as far as the handoff is concerned, or null when it may.
 * Every verifier of a session asks (middleware/auth authenticate and optionalAuth, routes/collab):
 *   · a session WITHOUT the `hof` claim never authenticates a handoff account;
 *   · a session WITH it authenticates only the handoff account it names, on a site other than the main
 *     one, before its end, while that network administrator is still listed.
 */
function handoffSessionRefusal(decoded: any, user: any): string | null {
    const mark = handoffMarkOf(user);
    const hof = decoded ? decoded.hof : undefined;
    if (hof === undefined) return mark ? 'handoff_account' : null;
    if (!isHandoffClaim(hof)) return 'malformed';
    if (!mark || mark !== accountKey(hof.uid, hof.by)) return 'account_mismatch';
    if (hof.exp <= Math.floor(Date.now() / 1000)) return 'expired';
    const siteId = siteContext.currentSiteIdOrNull();
    if (!siteContext.multisiteEnabled() || siteId === null || siteId === siteContext.PRIMARY_SITE_ID) return 'not_a_site';
    try {
        if (!network.isNetworkAdmin(hof.uid, hof.by)) return 'not_network_admin';
    } catch {
        return 'store_unavailable';
    }
    return null;
}

/**
 * Route guard: a handoff session (or a handoff account) creates no credential that would outlive it and
 * never changes its own account. 403 rest_network_handoff_session.
 */
function refuseHandoffSession(req: Request, res: Response, next: NextFunction) {
    if (req.user && isHandoffAccount(req.user)) {
        return res.status(403).json({
            code: 'rest_network_handoff_session',
            message: 'A network administrator\'s handoff session cannot create credentials or change its own account.',
            data: { status: 403 },
        });
    }
    return next();
}

/** The one answer for an action on a handoff account by anyone: 403 rest_network_handoff_account. */
function refuseHandoffAccountTarget(res: Response) {
    return res.status(403).json({
        code: 'rest_network_handoff_account',
        message: 'This account belongs to a network administrator\'s handoff and is managed by the network.',
        data: { status: 403 },
    });
}

module.exports = {
    HANDOFF_PURPOSE,
    HANDOFF_TOKEN_SECONDS,
    HANDOFF_SESSION_SECONDS,
    HANDOFF_META,
    HANDOFF_PATH,
    issueHandoff,
    redeemHandoff,
    ensureHandoffAccount,
    isHandoffAccount,
    isHandoffClaim,
    handoffSessionRefusal,
    refuseHandoffSession,
    refuseHandoffAccountTarget,
};
