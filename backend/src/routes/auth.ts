/**
 * WordJS - Auth Routes
 * /api/v1/auth/*
 */

import type { Request, Response, CookieOptions } from 'express';
const express = require('express');
const router = express.Router();
const User = require('../models/User');
// issueSessionCookie is the ONE door that mints the interactive session cookie: it refuses a request
// that arrived on a `wjt_` API token, so a leaked headless token can never be traded for a 7-day session
// (see middleware/auth.ts). sessionOnly lives there too, next to the headless mark it reads.
// sessionCookieOptions/clearSessionCookies live there too: the session cookie and its `wjs_csrf`
// double-submit partner must agree on secure/sameSite/path, so ONE module owns both halves.
const { authenticate, generateToken, verifyToken, issueSessionCookie, sessionOnly, sessionCookie, sessionCookieOptions, clearSessionCookies } = require('../middleware/auth');
const { isAdmin, can } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
// THE ROUTE-ID CONTRACT — see core/query-params: one definition of "a route id" for the whole tree.
const { routeIdOrNull } = require('../core/query-params');
const { getOption } = require('../core/options');
const config = require('../config/app');
const crypto = require('crypto');
const mfa = require('../core/mfa');
// Escalating per-(IP + account) login lockout — so one user's failures never lock out others behind
// the same public IP. Runs ALONGSIDE the account-wide lockout below (which is the AUTH-A3 backstop
// against distributed attacks on a single account); a login is refused if either trips.
const loginThrottle = require('../core/login-throttle');
const { clientIp } = require('../core/client-ip');
// The ONE self-service email-write rule (shared with routes/users.ts) — see core/mailbox.ts.
const { refuseSelfServiceEmailChange, isValidAddress } = require('../core/mailbox');
// Append-only audit trail. Every call here is best-effort by construction (recordAudit swallows its
// own errors) — an unwritable audit row must never turn a successful login into a 500.
const { recordAudit } = require('../core/audit');

/**
 * A caller-supplied string, bounded, for an audit `detail`.
 *
 * The attempted username on a FAILED login is attacker-controlled and unauthenticated: storing it raw
 * would let anyone who can reach /auth/login write megabytes per attempt into the one table that is
 * supposed to survive an incident. 64 characters is longer than any real login.
 */
function auditText(v: any, max = 64): string {
    return String(v == null ? '' : v).slice(0, max);
}

/**
 * A stable, non-reversible marker for an attempted identifier that names NO account.
 *
 * The audit trail records the attempted username on a failed login because half of "wrong password"
 * is knowing WHICH account is being guessed. But the single most common way a credential leaks into a
 * log is a password typed into the username box, and that string is exactly what an unknown-account
 * failure would otherwise persist in clear — in `detail` AND in `target_id`, readable by every
 * administrator through GET /audit, for the 365 days the retention window keeps.
 *
 * So an unknown identifier is recorded as a digest instead: an operator can still see that the SAME
 * unknown string is being tried a thousand times (which is the enumeration signal the row exists for)
 * without the string itself being in the table. KEYED with the server's own secret rather than a bare
 * sha256: a plain hash of a weak password is a dictionary attack away from the password, and the
 * reader we are protecting the user from here is an administrator who already has the log. The key
 * changes when the JWT secret is rotated, so digests correlate within a deployment's key lifetime,
 * which is far longer than any incident.
 */
function attemptDigest(value: any): string {
    return crypto.createHmac('sha256', String(config.jwt.secret || ''))
        .update(String(value == null ? '' : value))
        .digest('hex')
        .slice(0, 16);
}

// Per-account login lockout: the per-IP rate limiter is defeated by a botnet/proxy pool targeting a
// single account, and there was no account-level throttle. Lock an account for a cooldown after N
// consecutive failures.
//
// Multi-node (AUTH-A3): an in-process-only counter weakens to N× on a multi-replica deployment (an
// attacker spreading attempts across R replicas gets R×10 attempts) and is wiped by a node restart.
// So when Redis is configured we back the counter with the SHARED rate-limit client (the same
// cache.getClient() the IP limiters use), keyed by the normalized username, with the lock TTL in
// Redis. The in-memory Map remains the single-node path and the always-on fallback: any Redis error
// (or no client configured) degrades to in-process exactly as before — a Redis outage NEVER blocks
// login. Mirrors limiterStore()'s passOnStoreError philosophy.
const LOGIN_MAX_FAILS = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const _loginFails = new Map(); // key -> { count, firstFailAt, lockedUntil }
const _loginKey = (u: any) => String(u || '').trim().toLowerCase();

// SECURITY (audit MEDIUM — AUTH-A3 lockout bypass by concurrency): the account lock is armed by
// recordLoginFail only AFTER count>=LOGIN_MAX_FAILS, and isLoginLocked reads that armed flag, but the
// bcrypt compare between the two yields the event loop — so K near-simultaneous guesses for one account
// all pass isLoginLocked before any of them arms the lock, evaluating far more than 10 guesses per
// window (the per-(IP+account) throttle doesn't help against the distributed-IP threat this backstop
// exists for). Fix: cap the number of CONCURRENT in-flight authentications per account. This is additive
// (the failure counter/lock semantics are unchanged); it just bounds how many guesses can straddle the
// check→arm window to a small constant, so the lock still fires after ~LOGIN_MAX_FAILS + this cap.
const MAX_LOGIN_INFLIGHT = 3;
const _inflightMem = new Map(); // key -> { n, ts }
const _inflightRedisKey = (key: string) => `wjlock:inflight:${key}`;

// Resolve a submitted identifier (username OR email) to the account's canonical user_login, so the
// per-account lockout counter can't be DOUBLED by alternating the two forms — both authenticate the same
// account yet keyed two distinct buckets before (audit LOW). Falls back to the raw identifier when no
// account matches (a nonexistent-user probe is still rate-limited under its own key).
// ─── ONE STORE, PURPOSE-OWNED SUB-NAMESPACES ──────────────────────────────────────────────────────
/**
 * A PREFIX INSIDE A STRING IS NOT A NAMESPACE. Every throttle bucket in this store used to be spelled
 * `'<purpose>:' + identifier`, and exactly one of them — the interactive-login bucket — takes its subject
 * from the request body: `resolveLockIdentifier` hands the SUBMITTED identifier back verbatim when it
 * matches no account (deliberately, so a nonexistent-user probe is still counted). That one fail-open
 * subject made the WHOLE store writable from an anonymous POST /auth/login: twelve attempts with
 * `{username: 'mfa:owner'}`, spread over enough source addresses to outlast loginThrottle, armed the very
 * bucket that /auth/mfa/{enable,disable,backup-codes} read, and the owner — correct password, correct
 * TOTP — was answered 429 on all three. Locking someone out of their own 2FA without being able to log in.
 *
 * The fix is not a cleverer prefix. It is that the login bucket is now ONE PURPOSE AMONG SEVERAL rather
 * than the whole key space: every key is `<purpose>:<subject>` where the purpose is a literal from
 * LOCK_PURPOSES chosen by the CALL SITE and never by the caller. An attacker still chooses the subject of
 * the login bucket (pre-authentication, a submitted username is all there is), but no subject can move
 * the key out of `login:`, so no other purpose is reachable from it — by construction, for purposes that
 * do not exist yet.
 *
 * Adding a door, in order of preference:
 *   1. Do NOT use this store. Give the purpose its own key space keyed by the authenticated numeric id
 *      (routes/users.ts's `wjsudo:*` is the model, and it is the only shape that is safe by default).
 *   2. If it must share the store, add a purpose to LOCK_PURPOSES and go through lockBucket().
 * backend/src/tests/anonymous-entry-channels.test.ts derives the call sites from this file's SOURCE and
 * fails on a key that was not built by lockBucket().
 *
 * ─── A PURPOSE IS ALSO A READ/WRITE CONTRACT, NOT ONLY A KEY SPACE ────────────────────────────────
 * The first version of this namespacing separated the SUBJECTS and stopped there, and that was only half
 * the job. `mfa:<id>` stayed ONE purpose shared by four doors: the second factor of the interactive login
 * (which CHECKS the lock and refuses) and the three enrolment/management doors (which had their lock
 * check replaced by a bounded wait — but kept ARMING it). One reader, four writers, and three of those
 * writers needed nothing but the session cookie. Twelve wrong codes at POST /auth/mfa/disable therefore
 * locked the owner out of POST /auth/mfa — renewably, and with no recovery path (backup codes are checked
 * INSIDE verifyLoginCode, i.e. after the lock; reset-password clears no mfa_* key). A redesign that moves
 * the READ off a bucket and leaves the WRITE on it does not remove the weapon, it hands it to whoever can
 * reach the remaining writer.
 *
 * So each purpose now declares which half of the pair it supports:
 *   · LOCKING purposes are checked with isLoginLocked and refuse (429). Every door that can ARM one is a
 *     door that is itself refused by it — arming is self-inflicted, never inflicted on a neighbour.
 *   · every other purpose is COUNT-ONLY: recordLoginFail increments its counter and NEVER arms a lock,
 *     and isLoginLocked over it is false by construction. Its failures buy an escalating, bounded WAIT
 *     (payFailureDelay) — the shape routes/users.ts's sudo gate states, which can never take a hostage.
 * `CHANNEL 3 — every locking purpose is armed only by the doors it refuses` derives both sides of that
 * pair from the source and fails when a writer appears outside the reader's own handler.
 */
const LOCK_PURPOSES = ['login', 'mfa', 'mfa_manage', 'migrate'] as const;
type LockPurpose = (typeof LOCK_PURPOSES)[number];
/**
 * The purposes whose buckets a door READS with isLoginLocked in order to refuse. Everything not listed
 * here is count-only. Kept as data (and exported) so the gate can compare it against the readers it finds
 * in the source instead of restating it.
 */
const LOCKING_PURPOSES: readonly LockPurpose[] = ['login', 'mfa'];
function lockBucket(purpose: LockPurpose, subject: string | number): string {
    return `${purpose}:${subject}`;
}
/** The purpose a key was built under, or '' for a key that did not come from lockBucket(). */
function purposeOf(key: string): string {
    const i = String(key).indexOf(':');
    return i < 0 ? '' : String(key).slice(0, i);
}
const isLockingKey = (key: string) => (LOCKING_PURPOSES as readonly string[]).includes(purposeOf(_loginKey(key)));

/**
 * The IN-FLIGHT cap and the FAILURE COUNTER are deliberately different keys on the doors that pay a wait.
 *
 * The counter must stay per-ACCOUNT — that is the throttle, and a distributed attacker must not get a
 * fresh ladder per source address. The concurrency slot must NOT, because the wait is now paid inside it
 * (see payFailureDelay): an account-wide slot held for seconds is a refusal anyone who can reach the door
 * can inflict on the owner, which is the hostage in a different costume. routes/users.ts's sudo gate keys
 * its slot `${userId}|${ip}` for exactly this reason; this mirrors it, through lockBucket so the key stays
 * inside its purpose.
 */
function inflightBucket(purpose: LockPurpose, subject: string | number, req: Request): string {
    return lockBucket(purpose, `${subject}|${clientIp(req)}`);
}

/**
 * The account a submitted identifier names, or null when it names none.
 *
 * Split out of resolveLockIdentifier because two call sites need the ANSWER, not just the bucket
 * subject: the throttle (which must count a probe for a nonexistent account too) and the failure
 * audit (which must not persist an identifier that matched nothing — see attemptDigest). Resolving
 * once and passing the account along keeps the pre-authentication database work an anonymous caller
 * can drive at exactly what it was.
 */
async function findAccountByIdentifier(identifier: any) {
    try {
        const User = require('../models/User');
        return (await User.findByLogin(identifier)) || (await User.findByEmail(identifier)) || null;
    } catch { return null; }
}

async function resolveLockIdentifier(identifier: any) {
    const u = await findAccountByIdentifier(identifier);
    return u ? u.userLogin : identifier;
}

// Lazily-resolved shared store client (null on single-node or if Redis isn't configured).
function _lockStore() {
    try {
        const cache = require('../core/cache');
        return cache.getClient() || null;
    } catch {
        return null;
    }
}
const _failsRedisKey = (key: string) => `wjlock:fails:${key}`;
const _lockedRedisKey = (key: string) => `wjlock:locked:${key}`;

function _isLoginLockedMem(key: string) {
    const e = _loginFails.get(key);
    return !!(e && e.lockedUntil && e.lockedUntil > Date.now());
}

async function isLoginLocked(u: any) {
    const key = _loginKey(u);
    // A count-only purpose HAS no lock: nothing arms one (see recordLoginFail), so reading one here would
    // be a reader pointing at nothing. Answering false rather than throwing keeps a mistaken call site
    // fail-OPEN — the direction that can only lose throttling, never take a hostage — and the derived gate
    // in anonymous-entry-channels.test.ts is what turns such a call site red instead.
    if (!isLockingKey(key)) return false;
    const client = _lockStore();
    if (client) {
        try {
            const locked = await client.get(_lockedRedisKey(key));
            return !!locked;
        } catch {
            // Redis hiccup → fall through to the in-memory view (fail-safe: still throttles single node).
        }
    }
    return _isLoginLockedMem(key);
}

async function recordLoginFail(u: any) {
    const key = _loginKey(u);
    // ARMING IS THE HALF THAT WAS LEFT BEHIND. On a count-only purpose this records the failure (so
    // payFailureDelay keeps escalating) and stops there: no lockedUntil, no `wjlock:locked:` key. A door
    // that only ever waits therefore cannot manufacture a refusal for anybody — not for itself, and above
    // all not for a neighbouring door that still reads a lock.
    const arms = isLockingKey(key);
    const now = Date.now();
    const client = _lockStore();
    if (client) {
        try {
            const failKey = _failsRedisKey(key);
            const lockTtlSec = Math.ceil(LOGIN_LOCK_MS / 1000);
            const count = await client.incr(failKey);
            // (Re)set the sliding-window expiry on the counter each failure.
            await client.expire(failKey, lockTtlSec);
            if (arms && count >= LOGIN_MAX_FAILS) {
                await client.set(_lockedRedisKey(key), '1', 'PX', LOGIN_LOCK_MS);
            }
            return;
        } catch {
            // Redis hiccup → record in-memory instead so this node still throttles.
        }
    }
    let e = _loginFails.get(key);
    if (!e || (now - e.firstFailAt) > LOGIN_LOCK_MS) e = { count: 0, firstFailAt: now, lockedUntil: 0 };
    e.count++;
    if (arms && e.count >= LOGIN_MAX_FAILS) e.lockedUntil = now + LOGIN_LOCK_MS;
    _loginFails.set(key, e);
    _sweepLoginFails();
}

/**
 * Bound `_loginFails`. Its keys are chosen by an anonymous caller (the login bucket's subject is the
 * submitted identifier, on purpose), and nothing ever removed an entry that was never read again — so a
 * spray of never-repeated usernames grew the map monotonically for the life of the process. Sweep lazily
 * and only when the map is already large, so the common path stays O(1); entries are dropped by their OWN
 * window, exactly as _loginFailCountMem would have dropped them on a read that never comes.
 */
const LOGIN_FAILS_SOFT_CAP = 5000;
function _sweepLoginFails(): void {
    if (_loginFails.size <= LOGIN_FAILS_SOFT_CAP) return;
    const now = Date.now();
    for (const [k, e] of _loginFails) {
        if ((now - e.firstFailAt) > LOGIN_LOCK_MS && !(e.lockedUntil > now)) _loginFails.delete(k);
    }
}

function _loginFailCountMem(key: string): number {
    const e = _loginFails.get(key);
    if (!e) return 0;
    if ((Date.now() - e.firstFailAt) > LOGIN_LOCK_MS) { _loginFails.delete(key); return 0; }
    return e.count;
}

/** Failures recorded for a bucket inside its window. Read-only view; same store precedence as the rest. */
async function loginFailCount(u: any): Promise<number> {
    const key = _loginKey(u);
    const client = _lockStore();
    if (client) {
        try { return Number(await client.get(_failsRedisKey(key))) || 0; } catch { /* hiccup → mem view */ }
    }
    return _loginFailCountMem(key);
}

/**
 * Pay for the failures already on a bucket with a bounded, escalating WAIT instead of refusing.
 *
 * A LOCK on a door whose only key is a correct second factor is a hostage: the owner cannot clear it and
 * has no recovery path, so "too many attempts" answers the right code exactly as it answers the wrong
 * one. That is the class routes/users.ts's sudo gate exists to state, and these doors are its neighbours.
 * The ladder is `sudoDelayMs` ITSELF (required lazily, as requireSudoPassword already is) rather than a
 * second copy of the same constants, so the two cannot drift apart.
 *
 * CALL IT INSIDE THE SLOT, NEVER BEFORE IT. routes/users.ts:634 states the rule and obeys it; the first
 * copy of this helper did not, and the difference is the whole point of the primitive: paid outside the
 * slot, 24 concurrent guesses all sleep in PARALLEL and finish in one delay's time (measured: 8.1 s for a
 * ladder that should have cost 64 s), so the wait bounds latency instead of throughput and buys nothing.
 * Paid inside it, at most MAX_LOGIN_INFLIGHT guesses are asleep at once, which is also the only thing
 * that bounds how many sleeping requests can pile up holding a socket and a timer.
 */
async function payFailureDelay(bucket: string): Promise<void> {
    const ms = require('./users').sudoDelayMs(await loginFailCount(bucket));
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearLoginFails(u: any) {
    const key = _loginKey(u);
    const client = _lockStore();
    if (client) {
        try {
            await client.del(_failsRedisKey(key), _lockedRedisKey(key));
        } catch {
            // ignore — clearing is best-effort; the TTL will expire the keys anyway.
        }
    }
    _loginFails.delete(key);
}

// Atomically reserve one in-flight authentication slot for this account BEFORE the bcrypt compare.
// Returns false when the account already has MAX_LOGIN_INFLIGHT authentications in flight — the caller
// must then reject WITHOUT running bcrypt. A short TTL (Redis) / timestamp (mem) is the safety net so a
// crashed request can't leak a slot permanently. Fail-open on a store hiccup (never hard-block login).
async function beginLoginAttempt(u: any): Promise<boolean> {
    const key = _loginKey(u);
    const client = _lockStore();
    if (client) {
        try {
            const k = _inflightRedisKey(key);
            const n = await client.incr(k);
            await client.expire(k, 30);
            if (n > MAX_LOGIN_INFLIGHT) { try { await client.decr(k); } catch { /* ignore */ } return false; }
            return true;
        } catch { /* Redis hiccup → mem */ }
    }
    const now = Date.now();
    let e = _inflightMem.get(key);
    if (!e || (now - e.ts) > 30000) e = { n: 0, ts: now }; // stale entry → reset (crash-leak safety)
    if (e.n >= MAX_LOGIN_INFLIGHT) { _inflightMem.set(key, e); return false; }
    e.n++; e.ts = now; _inflightMem.set(key, e);
    return true;
}

async function endLoginAttempt(u: any): Promise<void> {
    const key = _loginKey(u);
    const client = _lockStore();
    if (client) {
        try {
            const k = _inflightRedisKey(key);
            const n = await client.decr(k);
            if (n < 0) { try { await client.set(k, '0'); } catch { /* ignore */ } }
            return;
        } catch { /* Redis hiccup → mem */ }
    }
    const e = _inflightMem.get(key);
    if (!e) return;
    e.n = Math.max(0, e.n - 1);
    // DELETE at zero rather than rewrite (routes/users.ts's sudoEndAttempt is the model). Rewriting left
    // one entry per key ever seen, and these keys are attacker-chosen, so the map only ever grew.
    if (e.n === 0) _inflightMem.delete(key); else _inflightMem.set(key, e);
}

// Cookie configuration for secure HttpOnly tokens.
//
// The definition MOVED to middleware/auth.ts (sessionCookieOptions). It is not a style preference: the
// `wjs_csrf` double-submit cookie has to be set with exactly the same secure/sameSite/path as the
// session cookie, and the only way that cannot drift is for the CSRF options to be derived from the
// session options at the single door that issues both (issueSessionCookie). Keeping a second copy of
// the derivation here is what would let an operator's HTTPS site end up with a `secure` session cookie
// and a non-`secure` CSRF cookie. Called per request rather than snapshotted at module load, so a
// config change (installer, tests) is not frozen into the first require of this file.
const COOKIE_OPTIONS = (): CookieOptions => sessionCookieOptions();

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: User authentication and token management
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     RestError:
 *       type: object
 *       description: The uniform WordJS REST error envelope.
 *       properties:
 *         code:
 *           type: string
 *           description: Machine-readable error code, e.g. rest_invalid_param.
 *         message:
 *           type: string
 *         data:
 *           type: object
 *           properties:
 *             status:
 *               type: integer
 *     MfaStatus:
 *       type: object
 *       description: Compliance of one account against the admin-enforced MFA-by-role policy.
 *       properties:
 *         required:
 *           type: boolean
 *           description: The account's role is listed in the policy.
 *         enabled:
 *           type: boolean
 *           description: The account has TOTP enrolled.
 *         enforced:
 *           type: boolean
 *           description: Required, not enrolled and past the grace deadline — requests are refused with mfa_enrollment_required.
 *         withinGrace:
 *           type: boolean
 *         graceDeadline:
 *           type: integer
 *           nullable: true
 *           description: Epoch seconds, or null when the account is not subject to the policy.
 *     MfaPolicy:
 *       type: object
 *       properties:
 *         requiredRoles:
 *           type: array
 *           items:
 *             type: string
 *         graceDays:
 *           type: integer
 *         enforcedAt:
 *           type: integer
 *           nullable: true
 *           description: Epoch seconds at which enforcement started, or null while no role requires MFA.
 *         enforceForApiTokens:
 *           type: boolean
 *     ApiTokenSummary:
 *       type: object
 *       description: API token metadata. The secret itself is returned once, by POST /auth/tokens, and never again.
 *       properties:
 *         id:
 *           type: integer
 *         name:
 *           type: string
 *           nullable: true
 *         tokenPrefix:
 *           type: string
 *         scopes:
 *           type: array
 *           items:
 *             type: string
 *         lastUsedAt:
 *           type: integer
 *           nullable: true
 *         expiresAt:
 *           type: integer
 *           nullable: true
 *         revoked:
 *           type: boolean
 *         createdAt:
 *           type: string
 */
/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, email, password]
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *                 minLength: 8
 *               displayName:
 *                 type: string
*     responses:
 *       201:
 *         description: >-
 *           Account created. A session cookie is issued unless email verification is required, in which
 *           case the account stays inactive until POST /auth/verify-email consumes the emailed token.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *                 verificationRequired:
 *                   type: boolean
 *                   description: Present and true only when the account must verify its email before logging in.
 *                 message:
 *                   type: string
 *       400:
 *         description: >-
 *           rest_missing_param (username/email/password absent), rest_invalid_param (bad email format,
 *           password shorter than 8 or longer than 72 characters) or rest_user_exists.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_cannot_register (self-registration is disabled site-wide), or
 *           rest_reserved_mail_domain / rest_mailbox_address_locked when the requested address belongs to
 *           the site's own mail domain — those are provisioned by an administrator, never claimed here.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: Rate limited by the strict per-IP auth limiter.
 *     security: []
 */
router.post('/register', asyncHandler(async (req: Request, res: Response) => {
    // ... (rest of the function)
    const registrationAllowed = await getOption('users_can_register', 0);
    if (!registrationAllowed || registrationAllowed == '0') {
        return res.status(403).json({
            code: 'rest_cannot_register',
            message: 'User registration is currently disabled.',
            data: { status: 403 }
        });
    }

    const { username, email, password, displayName } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Username, email, and password are required.',
            data: { status: 400 }
        });
    }

    // Validate email format — shared, length-capped validator (ReDoS-safe on unbounded input)
    if (!isValidAddress(email)) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: 'Invalid email format.',
            data: { status: 400 }
        });
    }

    // SECURITY (anonymous self-grant of a corporate mailbox). This handler is UNAUTHENTICATED, and when
    // the operator turns `users_can_register` on it took the address verbatim. An attacker could
    // register ceo@<mailDomain> and, under the old email-derived rule, walk straight into the mail
    // surface — and, worse, become the delivery target that inbound mail for that address is matched
    // against. Corporate addresses are provisioned by an administrator, never claimed at the door. Same
    // helper as the two self-service PUT routes (`null` target: there is no account yet).
    const emailRefusal = await refuseSelfServiceEmailChange(null, email);
    if (emailRefusal) return res.status(403).json(emailRefusal);

    // Validate password strength
    if (password.length < 8) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: 'Password must be at least 8 characters.',
            data: { status: 400 }
        });
    }

    if (password.length > 72) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: 'Password must not exceed 72 characters.',
            data: { status: 400 }
        });
    }

    try {
        const defaultRole = await getOption('default_role', 'subscriber');
        const user = await User.create({
            username,
            email,
            password,
            displayName: displayName || username,
            role: defaultRole
        });

        // EMAIL VERIFICATION (opt-in, fail-closed). When required, the account is created UNVERIFIED and
        // may NOT log in until it confirms via a tokenized link (the login route refuses on the
        // `email_verification_pending` meta). We do NOT issue a session cookie here — verifying is the
        // gate. The admin-creates-user path (routes/users.ts) never sets the pending flag, so those
        // accounts stay pre-verified. Reuses the SAME single-use token machinery as password reset and
        // the SAME email:provider capability (global.wordjs_send_mail).
        if (await emailVerificationRequired()) {
            const { raw, hash } = mintSingleUseToken();
            await User.updateMeta(user.id, 'email_verification_hash', hash);
            await User.updateMeta(user.id, 'email_verification_expires', String(Date.now() + VERIFY_TTL_MS));
            await User.updateMeta(user.id, 'email_verification_pending', '1');

            const base = String((await getOption('siteurl', await getOption('home', config.siteUrl || 'http://localhost'))) || 'http://localhost').replace(/\/+$/, '');
            const link = `${base}/verify-email?uid=${user.id}&token=${raw}`;
            const siteName = await getOption('blogname', 'WordJS');
            try {
                (global as any).wordjs_send_mail({
                    to: String(email).trim().toLowerCase(),
                    subject: `Verify your email for ${siteName}`,
                    text: `Welcome to ${siteName}! Please confirm this email address to activate your account (${user.userLogin}).\n\nVerify your email (this link is valid for 24 hours):\n${link}\n\nIf you did not create this account, you can safely ignore this email.`,
                    html: `<p>Welcome to <strong>${siteName}</strong>! Please confirm this email address to activate your account (<code>${user.userLogin}</code>).</p>`
                        + `<p><a href="${link}">Verify your email</a> — this link is valid for 24 hours.</p>`
                        + `<p>If you did not create this account, you can safely ignore this email.</p>`
                });
            } catch { /* swallow send errors — the account still exists and can request a new link */ }

            // No session cookie: the user must verify before logging in.
            return res.status(201).json({ user: user.toJSON(), verificationRequired: true, message: 'Account created. Check your email for a verification link before logging in.' });
        }

        const token = generateToken(user);
        if (issueSessionCookie(req, res, token, COOKIE_OPTIONS())) return;

        res.status(201).json({ user: user.toJSON() });
    } catch (error) {
        if (error.message.includes('already exists')) {
            return res.status(400).json({
                code: 'rest_user_exists',
                message: error.message,
                data: { status: 400 }
            });
        }
        throw error;
    }
}));

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username:
 *                 type: string
 *               password:
 *                 type: string
*     responses:
 *       200:
 *         description: >-
 *           Either the login COMPLETED (a session cookie was issued and the body carries the user), or a
 *           second factor is owed — in which case the body is only mfaRequired plus a short-lived
 *           mfaToken that must be exchanged at POST /auth/mfa. Both cases are 200.
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   title: Session issued
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     mfa:
 *                       $ref: '#/components/schemas/MfaStatus'
 *                 - type: object
 *                   title: Second factor required
 *                   required: [mfaRequired, mfaToken]
 *                   properties:
 *                     mfaRequired:
 *                       type: boolean
 *                     mfaToken:
 *                       type: string
 *                       description: Short-lived signed challenge proving the password step passed.
 *       400:
 *         description: "rest_missing_param — username or password absent."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       401:
 *         description: "rest_invalid_credentials — deliberately identical for an unknown user and a wrong password."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_email_unverified — the password was correct but the account has not confirmed its email
 *           address yet.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: >-
 *           rest_login_throttled (escalating per-IP-and-account lockout, or too many simultaneous
 *           attempts for this account) or rest_account_locked (account-wide backstop). Carries Retry-After.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *     security: []
 */
router.post('/login', asyncHandler(async (req: Request, res: Response) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Username and password are required.',
            data: { status: 400 }
        });
    }

    // Resolved ONCE: the throttle bucket needs the account below, and so does the failure audit in the
    // catch — where whether the identifier named a real account decides whether it is safe to store.
    const account = await findAccountByIdentifier(username);
    // lockBucket, not the bare identifier: this is the ONE bucket whose subject the caller chooses, so it
    // must be confined to its own purpose or it IS the whole store (see the note above lockBucket).
    // The subject is resolveLockIdentifier's, unchanged: the account's canonical login when the
    // identifier names one, and the submitted string when it does not — deliberately, so a probe for a
    // nonexistent account is still counted.
    const lockId = lockBucket('login', account ? account.userLogin : username);
    // Honest client IP: the TCP peer unless a proxy is genuinely trusted (core/client-ip). Keying the
    // per-(IP+account) throttle on req.ip let a monolith client rotate X-Forwarded-For to mint a fresh
    // bucket every attempt and evade this lockout entirely (audit 2026-08-08 P1).
    const ip = clientIp(req);

    // Per-(IP + account) escalating gate (5→10→30→60→60 min by default). Refuses THIS IP for THIS
    // account only, so other users on a shared IP are unaffected.
    const gate = await loginThrottle.check(ip, lockId);
    if (gate.blocked) {
        const mins = Math.ceil(gate.retryAfterMs / 60000);
        res.set('Retry-After', String(Math.ceil(gate.retryAfterMs / 1000)));
        return res.status(429).json({
            code: 'rest_login_throttled',
            message: `Too many failed attempts for this account from your location. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
            data: { status: 429, retryAfterMs: gate.retryAfterMs }
        });
    }

    // Account-wide backstop (AUTH-A3: distributed attack on one account from many IPs).
    if (await isLoginLocked(lockId)) {
        return res.status(429).json({
            code: 'rest_account_locked',
            message: 'Account temporarily locked due to too many failed attempts. Try again later.',
            data: { status: 429 }
        });
    }

    // Concurrency backstop for the check→arm race above: cap simultaneous in-flight authentications for
    // this account so a burst of parallel guesses can't all clear isLoginLocked before the lock arms.
    if (!(await beginLoginAttempt(lockId))) {
        res.set('Retry-After', '1');
        return res.status(429).json({
            code: 'rest_login_throttled',
            message: 'Too many simultaneous login attempts for this account. Try again in a moment.',
            data: { status: 429 }
        });
    }

    try {
        const user = await User.authenticate(username, password);
        await clearLoginFails(lockId);
        // Successful password → reset the escalation ladder for this IP+account.
        await loginThrottle.succeed(ip, lockId);

        // EMAIL VERIFICATION gate: a self-registered account created while verification was required
        // carries `email_verification_pending='1'` until it confirms its email. The password is correct
        // (so this is NOT a brute-force attempt — the throttle was already cleared above), but the
        // account is not yet active. Refuse with a distinct code the login UI can act on. Admin-created
        // and pre-feature accounts never carry this flag, so they are unaffected.
        if (String(await User.getMeta(user.id, 'email_verification_pending')) === '1') {
            return res.status(403).json({
                code: 'rest_email_unverified',
                message: 'Please verify your email address before logging in. Check your inbox for the verification link.',
                data: { status: 403 }
            });
        }

        // Second factor: if the account has MFA enabled, do NOT issue the session yet. Return a short-lived
        // challenge token; the client must call POST /auth/mfa with a valid TOTP or backup code to finish.
        if (await mfa.isEnabled(user.id)) {
            return res.json({ mfaRequired: true, mfaToken: mfa.signChallenge(user.id) });
        }

        // A COMPLETED login — recorded where the session is actually issued, never where the password
        // merely checked out. The MFA branch above returns a challenge, not a session; its success is
        // recorded by POST /auth/mfa, which is the handler that finishes that login.
        await recordAudit(user.id, 'auth.login.success', 'user', user.id, {
            username: auditText(user.userLogin), method: 'password', ip: auditText(ip, 45)
        });

        const token = generateToken(user);
        if (issueSessionCookie(req, res, token, COOKIE_OPTIONS())) return;
        res.json({ user: user.toJSON(), mfa: await mfa.evaluate(user) });
    } catch (error) {
        await recordLoginFail(lockId);
        // THE ATTEMPTED ACCOUNT, NEVER THE PASSWORD — the whole point of recording a failure is to see
        // WHICH account is being guessed, and half of "wrong password" reports is the account name. The
        // password is not passed to recordAudit at all (rather than relying on sanitizeDetail's
        // secret-key filter to catch it downstream), and the actor is null: nobody authenticated here.
        //
        // ...AND NOT A PASSWORD TYPED INTO THE USERNAME BOX. "Never the password" was true of the
        // `password` FIELD and false of the row: an identifier that matches no account is very often a
        // credential in the wrong box, and it used to be stored verbatim in `detail` and in `target_id`,
        // where every administrator can read it for the 365 days retention keeps. So the raw string is
        // recorded only when it resolves to a real account (in which case it is that account's own
        // login, which the log may name); anything else is recorded as a keyed digest, which still
        // answers "is the same unknown identifier being tried over and over?" — see attemptDigest.
        //
        // ONLY THE CREDENTIAL CHECK IS RECORDED, not the 429s above it. The throttle refusals are the
        // branch an attacker can drive at will; keeping them out means the audit write rate for a
        // brute-force run is bounded by the lockout ladder rather than by the attacker.
        const knownLogin = account ? auditText(account.userLogin) : null;
        const digest = knownLogin ? null : attemptDigest(username);
        await recordAudit(
            null, 'auth.login.failure', 'user',
            knownLogin || `hmac:${digest}`,
            knownLogin
                ? { username: knownLogin, ip: auditText(ip, 45) }
                // NOT `usernameHash`: sanitizeDetail drops any key matching /hash/ as secret-named, so
                // that spelling would silently store nothing at all.
                : { usernameDigest: digest, unknownAccount: true, ip: auditText(ip, 45) }
        );
        // Advance the per-(IP+account) escalation ladder; this attempt still answers 401 (a later
        // attempt gets the 429), matching the account-lockout flow above.
        await loginThrottle.fail(ip, lockId);
        return res.status(401).json({
            code: 'rest_invalid_credentials',
            message: 'Invalid username or password.',
            data: { status: 401 }
        });
    } finally {
        // Release the in-flight slot whether we succeeded, failed, or threw — never leak a slot.
        await endLoginAttempt(lockId);
    }
}));

/**
 * GET /auth/me
 * Get current user
 */
/**
 * @swagger
 * /auth/me:
 *   get:
 *     summary: Get the authenticated user
 *     description: >-
 *       The user object is returned UNWRAPPED, with one extra top-level `mfa` key describing the
 *       account's two-factor status.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The current user plus two-factor status
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/User'
 *                 - type: object
 *                   properties:
 *                     mfa:
 *                       $ref: '#/components/schemas/MfaStatus'
 *       401:
 *         description: "rest_not_logged_in — no valid session cookie, session JWT or API token."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.get('/me', authenticate, asyncHandler(async (req: Request, res: Response) => {
    // mfa is an EXTRA top-level key (the client reads /auth/me as the user object directly — do not re-wrap).
    res.json({ ...req.user.toJSON(), mfa: await mfa.evaluate(req.user) });
}));

/**
 * POST /auth/validate
 * Validate token
 */
/**
 * @swagger
 * /auth/validate:
 *   post:
 *     summary: Validate the caller's credentials
 *     description: Answers 200 when the presented session cookie, session JWT or API token still authenticates.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie; Bearer/API-token callers are exempt.
 *     responses:
 *       200:
 *         description: The credential is valid
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid:
 *                   type: boolean
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       401:
 *         description: "rest_not_logged_in — the credential is missing, expired or revoked."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_csrf_token / rest_csrf_invalid (double-submit token or same-origin check failed), or
 *           mfa_enrollment_required when the caller's role requires 2FA and the grace window has expired.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.post('/validate', authenticate, (req: Request, res: Response) => {
    res.json({
        valid: true,
        user: req.user.toJSON()
    });
});

/**
 * POST /auth/refresh
 * Refresh token
 *
 * `authenticate` accepts a `wjt_` API token as readily as a session JWT, so this route used to convert a
 * leaked machine token into a 7-day interactive session cookie — a session that no longer carried
 * req.apiToken and therefore walked straight past `sessionOnly` on /auth/tokens and /auth/mfa/*, and that
 * revoking the token did not cut off. issueSessionCookie refuses the exchange (403) for any headless
 * request; a genuine cookie/JWT session refreshes exactly as before.
 */
/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Refresh the interactive session
 *     description: >-
 *       Mints a fresh session JWT and re-issues the session cookie together with its `wjs_csrf` partner.
 *       A HEADLESS caller is refused — a leaked `wjt_` API token can never be traded for a 7-day
 *       interactive session.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie.
 *     responses:
 *       200:
 *         description: Session refreshed; a new session cookie is set
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           The caller is headless (an API token may not obtain a session cookie), rest_csrf_token /
 *           rest_csrf_invalid, or mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.post('/refresh', authenticate, (req: Request, res: Response) => {
    const token = generateToken(req.user);

    // Update HttpOnly cookie
    if (issueSessionCookie(req, res, token, COOKIE_OPTIONS())) return;

    res.json({
        user: req.user.toJSON()
    });
});

/**
 * POST /auth/logout
 * Clear auth cookie
 */
/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Log out
 *     description: >-
 *       Clears the session cookie and its `wjs_csrf` partner, and — when a valid token was presented —
 *       stamps the account's security epoch so every previously issued session JWT stops authenticating.
 *       Succeeds even with no credential at all, in which case nothing is revoked.
 *     tags: [Auth]
 *     security: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when a
 *           VALID session cookie is attached; a request with no cookie (or an unverifiable one) is exempt.
 *     responses:
 *       200:
 *         description: Logged out
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       403:
 *         description: "rest_csrf_token / rest_csrf_invalid — the anti-CSRF checks refused the request."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.post('/logout', asyncHandler(async (req: Request, res: Response) => {
    // Best-effort revocation: stamp the user's security epoch so the just-cleared token (and any
    // stolen copy of it) can no longer authenticate. Logout still succeeds without a valid token.
    // Who logged out, when it is knowable. A logout with no valid token revokes nothing and is not an
    // event: recording an anonymous 'auth.logout' on every unauthenticated POST would hand an
    // unauthenticated caller a free row in the audit table.
    let actorId: any = null;
    try {
        const ah = req.headers.authorization;
        let token = (ah && ah.startsWith('Bearer ')) ? ah.substring(7) : null;
        // sessionCookie(), not req.cookies directly: cookie-parser JSON-decodes any `j:`-prefixed value,
        // so the raw bag can hand back an Array/Object and verifyToken would throw on it.
        if (!token) token = sessionCookie(req);
        if (token) {
            const decoded = verifyToken(token);
            if (decoded && decoded.userId) {
                await User.updateMeta(decoded.userId, 'token_valid_after', String(Math.floor(Date.now() / 1000)));
                actorId = decoded.userId;
            }
        }
    } catch { /* invalid/expired token — nothing to revoke */ }
    if (actorId !== null) {
        await recordAudit(actorId, 'auth.logout', 'user', actorId, { ip: auditText(clientIp(req), 45) });
    }
    // Clears BOTH the session cookie and its `wjs_csrf` double-submit partner — one helper, in the same
    // module that issues them, so a future third cookie cannot be left behind here.
    clearSessionCookies(res);
    res.json({ success: true, message: 'Logged out successfully' });
}));

// ---------------------------------------------------------------------------------------------------
// Password recovery ("olvidé mi contraseña")
//
// Self-service reset is offered ONLY when a mail provider is active AND declares itself able to deliver
// — an operator without working outbound mail can't deliver the link, so the flow would strand users.
// The reset link is delivered to the user's RECOVERY address: their personal_email, or their primary
// email when that is external (and therefore reachable). A professional @site-domain mailbox is NEVER
// used — a locked-out user can't read their own WordJS inbox. All responses are uniform (anti-enum).
// ---------------------------------------------------------------------------------------------------
const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
// Email-verification links live longer than a reset link — a new user may not open their mail for a while.
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Single-use token machinery (SHARED by password reset AND email verification) ──────────────────
// One scheme, expressed once: mint a random token, persist only its SHA-256 hash + an expiry, and later
// validate by constant-time hash compare. Both flows store the hash/expiry in user_meta under their own
// keys and consume (blank) them on success, so a link is single-use and never replayable.
function mintSingleUseToken(): { raw: string; hash: string } {
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return { raw, hash };
}
// True IFF `given` matches `storedHash` and has not expired. Constant-time over the hashes (no timing
// oracle on the token). An empty storedHash (already consumed) or a past expiry is always false.
function singleUseTokenValid(given: string, storedHash: string, expiresMs: number): boolean {
    if (!storedHash || !given || !(Date.now() <= expiresMs)) return false;
    const givenHash = crypto.createHash('sha256').update(String(given)).digest('hex');
    let a: Buffer, b: Buffer;
    try { a = Buffer.from(givenHash, 'hex'); b = Buffer.from(storedHash, 'hex'); } catch { return false; }
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Readiness is checked GENERICALLY — no mail plugin slug is hardcoded, so swapping mail-server for any
// other provider keeps recovery working without touching core. A plugin becomes the provider by calling
// wordjs.provideMail() (which sets global.wordjs_send_mail, and which the host DELETES when that plugin
// unloads — so this fails closed on deactivation), and declares itself configured to deliver externally
// by setting the shared `mail_delivery_ready` option to '1' (a self-hosted MTA sets it once its DNS
// verifies; an external SMTP/relay would set it once its credentials validate).
async function mailReady(): Promise<boolean> {
    try {
        if (typeof (global as any).wordjs_send_mail !== 'function') return false;
        return String(await getOption('mail_delivery_ready', '0')) === '1';
    } catch {
        return false;
    }
}

// EMAIL VERIFICATION on self-registration is OPT-IN and FAIL-CLOSED. It can only be *required* when a
// mail provider can actually deliver the link — exactly the same readiness the reset flow depends on.
// So `require_email_verification=1` resolves to ON only when mailReady(); with no provider it degrades
// to OFF (a newly registered user is created active, as before), because a verification we can never
// deliver would strand every new account. Mirrors password reset's degrade-to-unavailable posture.
async function emailVerificationRequired(): Promise<boolean> {
    try {
        if (String(await getOption('require_email_verification', '0')) !== '1') return false;
        return await mailReady();
    } catch {
        return false;
    }
}

async function siteDomainName(): Promise<string> {
    try { return new URL(await getOption('siteurl', await getOption('home', 'http://localhost'))).hostname.toLowerCase(); }
    catch { return ''; }
}

// The address we can actually reach for recovery, or '' if none (professional mailbox is unreachable
// while locked out, so it is never a target).
async function recoveryTarget(user: any): Promise<string> {
    const personal = String((await User.getMeta(user.id, 'personal_email')) || '').trim().toLowerCase();
    if (personal) return personal;
    const primary = String(user.userEmail || '').trim().toLowerCase();
    const dom = primary.split('@')[1] || '';
    const site = await siteDomainName();
    if (dom && dom !== site) return primary; // external primary address → reachable
    return '';
}

/**
 * GET /auth/password-reset-available
 * Public probe so the login page shows "Forgot password?" only when self-service reset can actually work.
 */
/**
 * @swagger
 * /auth/password-reset-available:
 *   get:
 *     summary: Can self-service password reset actually work?
 *     description: >-
 *       Public probe so the login page shows "Forgot password?" only when a mail provider is loaded AND
 *       declares itself able to deliver. Reveals nothing about any account.
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       200:
 *         description: Availability of the self-service reset flow
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 available:
 *                   type: boolean
 */
router.get('/password-reset-available', asyncHandler(async (_req: Request, res: Response) => {
    res.json({ available: await mailReady() });
}));

/**
 * POST /auth/forgot-password
 * Body: { login } (username or account email). ALWAYS 200 — never reveals whether the account exists
 * or has a reachable recovery address (anti-enumeration). Rate-limited by authLimiter in index.ts.
 */
/**
 * @swagger
 * /auth/forgot-password:
 *   post:
 *     summary: Request a password-reset link
 *     description: >-
 *       ALWAYS answers 200 with the same body — whether the account exists, has a reachable recovery
 *       address, or mail is unavailable. That uniformity is the anti-enumeration control, so there is no
 *       failure status to document. The link is delivered to the account's personal_email, or to its
 *       primary address when that is external; a mailbox on the site's own domain is never used.
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [login]
 *             properties:
 *               login:
 *                 type: string
 *                 description: Username or account email address.
 *     responses:
 *       200:
 *         description: Uniform acknowledgement
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       403:
 *         description: "rest_csrf_invalid — the same-origin check refused the request."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: Rate limited by the strict per-IP auth limiter.
 */
router.post('/forgot-password', asyncHandler(async (req: Request, res: Response) => {
    const login = String((req.body && req.body.login) || '').trim();
    const ok = () => res.json({ ok: true, message: 'If an account with a recovery email exists, a reset link has been sent.' });
    if (!login) return ok();
    if (!(await mailReady())) return ok();

    let user: any;
    try { user = await User.findByLogin(login); } catch { user = null; }
    if (!user && login.includes('@')) { try { user = await User.findByEmail(login); } catch { user = null; } }
    if (!user) return ok();

    const to = await recoveryTarget(user);
    if (!to) return ok();

    // Mint a single-use token; persist only its SHA-256 hash + expiry (never the raw token).
    const { raw, hash } = mintSingleUseToken();
    await User.updateMeta(user.id, 'password_reset_hash', hash);
    await User.updateMeta(user.id, 'password_reset_expires', String(Date.now() + RESET_TTL_MS));

    const base = String((await getOption('siteurl', await getOption('home', config.siteUrl || 'http://localhost'))) || 'http://localhost').replace(/\/+$/, '');
    const link = `${base}/reset-password?uid=${user.id}&token=${raw}`;
    const siteName = await getOption('blogname', 'WordJS');

    try {
        (global as any).wordjs_send_mail({
            to,
            subject: `Password reset for ${siteName}`,
            text: `Someone requested a password reset for your ${siteName} account (${user.userLogin}).\n\nReset your password (this link is valid for 30 minutes):\n${link}\n\nIf you did not request this, you can safely ignore this email — your password will not change.`,
            html: `<p>Someone requested a password reset for your <strong>${siteName}</strong> account (<code>${user.userLogin}</code>).</p>`
                + `<p><a href="${link}">Reset your password</a> — this link is valid for 30 minutes.</p>`
                + `<p>If you did not request this, you can safely ignore this email; your password will not change.</p>`
        });
    } catch { /* swallow send errors — keep the response uniform, don't leak mail-infra state */ }

    return ok();
}));

/**
 * POST /auth/reset-password
 * Body: { uid, token, password }. Consumes the single-use token and revokes all existing sessions.
 * Rate-limited by authLimiter in index.ts.
 */
/**
 * @swagger
 * /auth/reset-password:
 *   post:
 *     summary: Consume a reset link and set a new password
 *     description: >-
 *       The token is single-use and valid for 30 minutes. A successful reset revokes every existing
 *       session of the account.
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [uid, token, password]
 *             properties:
 *               uid:
 *                 type: integer
 *               token:
 *                 type: string
 *               password:
 *                 type: string
 *                 minLength: 8
 *                 maxLength: 72
 *     responses:
 *       200:
 *         description: Password reset
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: >-
 *           rest_invalid_reset (missing, unknown, expired or already-consumed link — one uniform answer,
 *           so a bad token never reveals whether the account exists), rest_weak_password (under 8
 *           characters) or rest_invalid_param (over 72 characters).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: "rest_csrf_invalid — the same-origin check refused the request."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: Rate limited by the strict per-IP auth limiter.
 */
router.post('/reset-password', asyncHandler(async (req: Request, res: Response) => {
    const uid = parseInt((req.body && req.body.uid), 10);
    const token = String((req.body && req.body.token) || '');
    const password = String((req.body && req.body.password) || '');

    const bad = () => res.status(400).json({ code: 'rest_invalid_reset', message: 'This reset link is invalid or has expired. Please request a new one.', data: { status: 400 } });
    if (!uid || !token || !password) return bad();
    if (password.length < 8) return res.status(400).json({ code: 'rest_weak_password', message: 'Password must be at least 8 characters.', data: { status: 400 } });
    if (password.length > 72) return res.status(400).json({ code: 'rest_invalid_param', message: 'Password must not exceed 72 characters.', data: { status: 400 } });

    let user: any;
    try { user = await User.findById(uid); } catch { user = null; }
    if (!user) return bad();

    const storedHash = String((await User.getMeta(uid, 'password_reset_hash')) || '');
    const expires = parseInt(String((await User.getMeta(uid, 'password_reset_expires')) || '0'), 10) || 0;
    // Single-use token: constant-time hash compare + expiry (shared helper — same scheme as verify-email).
    if (!singleUseTokenValid(token, storedHash, expires)) return bad();

    // User.update() bcrypt-hashes the password AND stamps token_valid_after (revokes every session);
    // then consume the single-use token so the link cannot be replayed.
    await User.update(uid, { password });
    await User.updateMeta(uid, 'password_reset_hash', '');
    await User.updateMeta(uid, 'password_reset_expires', '0');

    // A credential replaced through the anonymous recovery flow, and it revoked every session of that
    // account. The actor IS the account: possession of the emailed single-use token is the only proof
    // this route ever has. Never the password, nor the token — only that the reset happened.
    await recordAudit(uid, 'auth.password.reset', 'user', uid, {
        username: auditText(user.userLogin), via: 'recovery_link', ip: auditText(clientIp(req), 45)
    });

    res.json({ ok: true, message: 'Your password has been reset. You can now log in with your new password.' });
}));

/**
 * POST /auth/verify-email
 * Body: { uid, token }. Consumes the single-use email-verification token minted at registration and
 * flips the account to verified (clears `email_verification_pending`), after which login works. Uniform
 * failure for a bad/expired/consumed token. Rate-limited by authLimiter in index.ts.
 */
/**
 * @swagger
 * /auth/verify-email:
 *   post:
 *     summary: Confirm an email address after registration
 *     description: >-
 *       Consumes the single-use token minted at registration (valid for 24 hours) and clears the
 *       pending flag, after which the account can log in.
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [uid, token]
 *             properties:
 *               uid:
 *                 type: integer
 *               token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Email verified
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: >-
 *           rest_invalid_verification — missing, unknown, expired or already-consumed link. One uniform
 *           answer for every failure.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: "rest_csrf_invalid — the same-origin check refused the request."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: Rate limited by the strict per-IP auth limiter.
 */
router.post('/verify-email', asyncHandler(async (req: Request, res: Response) => {
    const uid = parseInt((req.body && req.body.uid), 10);
    const token = String((req.body && req.body.token) || '');

    const bad = () => res.status(400).json({ code: 'rest_invalid_verification', message: 'This verification link is invalid or has expired. Please request a new one.', data: { status: 400 } });
    if (!uid || !token) return bad();

    let user: any;
    try { user = await User.findById(uid); } catch { user = null; }
    if (!user) return bad();

    const storedHash = String((await User.getMeta(uid, 'email_verification_hash')) || '');
    const expires = parseInt(String((await User.getMeta(uid, 'email_verification_expires')) || '0'), 10) || 0;
    if (!singleUseTokenValid(token, storedHash, expires)) return bad();

    // Flip to verified and consume the single-use token so the link cannot be replayed.
    await User.updateMeta(uid, 'email_verification_pending', '0');
    await User.updateMeta(uid, 'email_verification_hash', '');
    await User.updateMeta(uid, 'email_verification_expires', '0');

    res.json({ ok: true, message: 'Your email has been verified. You can now log in.' });
}));

// ─── Scoped API tokens (personal access tokens for headless/machine clients) ───────────────────────
// Self-service: a user manages their OWN tokens. Token management MUST be driven by an interactive
// session (JWT/cookie), never by an API token itself — otherwise a single leaked write-scoped token
// could mint fresh tokens (persistence) or revoke others. `sessionOnly` enforces that.
const ApiToken = require('../models/ApiToken');
const MAX_ACTIVE_TOKENS_PER_USER = 100;
// `sessionOnly` now comes from middleware/auth.ts (imported at the top of this file). It used to be a
// second, local copy of the same `req.apiToken` check — the very shape that let /auth/refresh drift away
// from the boundary it belongs to. One implementation, consumed by every surface that needs it.

/**
 * GET /auth/tokens
 * List the current user's API tokens (metadata only — the secret is never returned after creation).
 */
/**
 * @swagger
 * /auth/tokens:
 *   get:
 *     summary: List the caller's API tokens
 *     description: >-
 *       Metadata only — a token's secret is shown once, at creation, and is unrecoverable afterwards.
 *       Requires an INTERACTIVE session (cookie or session JWT) and the manage_api_tokens capability; a
 *       `wjt_` API token may not manage tokens.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The caller's tokens
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tokens:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ApiTokenSummary'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           The caller is headless (an API token may not manage tokens), rest_forbidden (the
 *           manage_api_tokens capability is missing), or mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.get('/tokens', authenticate, sessionOnly, can('manage_api_tokens'), asyncHandler(async (req: Request, res: Response) => {
    const tokens = await ApiToken.listForUser(req.user.id);
    res.json({ tokens });
}));

/**
 * POST /auth/tokens
 * Mint a new API token for the current user. The plaintext token is returned ONCE and is unrecoverable.
 * Body: { name?, scopes?, expiresInDays?: number }
 *   scopes: a global 'read'|'write'|'*' (all resources), and/or per-resource grants like
 *   'posts:write','media:read' (comma-string or array). write implies read; a token holding only
 *   resource scopes is confined to those resources. Unrecognized scopes are REJECTED (400).
 */
/**
 * @swagger
 * /auth/tokens:
 *   post:
 *     summary: Mint an API token
 *     description: >-
 *       The plaintext token is returned ONCE and can never be shown again. Requires an interactive
 *       session and the manage_api_tokens capability. At most 100 active tokens per user.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Human label for the token.
 *               scopes:
 *                 description: >-
 *                   A comma-separated string or an array. A global "read", "write" or "*", and/or
 *                   per-resource grants such as "posts:write" / "media:read". write implies read. An
 *                   unrecognized scope is rejected rather than silently dropped.
 *                 oneOf:
 *                   - type: string
 *                   - type: array
 *                     items:
 *                       type: string
 *               expiresInDays:
 *                 type: number
 *                 description: Positive number of days until expiry; omit for a token that never expires.
 *     responses:
 *       201:
 *         description: Token created — this is the only time the secret is disclosed
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiTokenSummary'
 *                 - type: object
 *                   properties:
 *                     token:
 *                       type: string
 *                       description: The plaintext secret. Save it now.
 *                     message:
 *                       type: string
 *       400:
 *         description: >-
 *           rest_token_limit (100 active tokens already), rest_invalid_param (expiresInDays is not a
 *           positive number) or rest_invalid_scope.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           The caller is headless, rest_forbidden (no manage_api_tokens), rest_csrf_token /
 *           rest_csrf_invalid, mfa_enrollment_required, or rest_mfa_required_for_tokens — the account's
 *           role requires 2FA and it has not enrolled, so it may not mint a token even during grace.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.post('/tokens', authenticate, sessionOnly, can('manage_api_tokens'), asyncHandler(async (req: Request, res: Response) => {
    const { name, scopes, expiresInDays } = req.body || {};

    // Soft cap on active (non-revoked, unexpired) tokens to bound abuse / accidental runaway creation.
    const existing = await ApiToken.listForUser(req.user.id);
    const activeCount = existing.filter((t: any) => !t.revoked && (t.expiresAt == null || t.expiresAt * 1000 > Date.now())).length;
    if (activeCount >= MAX_ACTIVE_TOKENS_PER_USER) {
        return res.status(400).json({
            code: 'rest_token_limit',
            message: `You have reached the maximum of ${MAX_ACTIVE_TOKENS_PER_USER} active API tokens. Revoke one first.`,
            data: { status: 400 }
        });
    }

    if (expiresInDays != null && (!Number.isFinite(Number(expiresInDays)) || Number(expiresInDays) <= 0)) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: 'expiresInDays must be a positive number of days.',
            data: { status: 400 }
        });
    }

    // Reject unrecognized scopes rather than silently dropping them: a dropped scope either empties the set
    // (which must NOT become a global-read token) or narrows the grant below what the caller asked for — a
    // typo like `posts:*` should fail loudly, not mint a surprising token.
    const badScopes = ApiToken.invalidScopes(scopes);
    if (badScopes.length) {
        return res.status(400).json({
            code: 'rest_invalid_scope',
            message: `Unrecognized token scope(s): ${badScopes.join(', ')}. Use "read", "write", "*", or "<resource>:read" / "<resource>:write" (e.g. posts:write).`,
            data: { status: 400 }
        });
    }

    // If the account is subject to the enforced-MFA-by-role policy but hasn't enrolled, refuse to mint a
    // token — even DURING the grace window. Otherwise a required-role user could mint a `wjt_` token while
    // still in grace and keep using it forever (API tokens are exempt from the compliance gate), permanently
    // sidestepping the policy. They must enable 2FA first.
    const mfaStatus = await mfa.evaluate(req.user);
    if (mfaStatus.required && !mfaStatus.enabled) {
        return res.status(403).json({
            code: 'rest_mfa_required_for_tokens',
            message: 'Your role requires two-factor authentication. Enable 2FA on your account before creating API tokens.',
            data: { status: 403 }
        });
    }

    const created = await ApiToken.generate({
        userId: req.user.id,
        name,
        scopes,
        expiresInDays: expiresInDays != null ? Number(expiresInDays) : null
    });

    // A new long-lived credential exists. The plaintext and the `tokenPrefix` are deliberately NOT in
    // the detail — what an investigator needs is WHICH token id, minted by whom, with what reach.
    await recordAudit(req.user.id, 'auth.token.create', 'api_token', created.id, {
        label: auditText(created.name), scopes: created.scopes, expiresAt: created.expiresAt
    });

    // `token` is the plaintext — surface it now; it can never be shown again.
    res.status(201).json({
        id: created.id,
        token: created.token,
        tokenPrefix: created.tokenPrefix,
        name: created.name,
        scopes: created.scopes,
        expiresAt: created.expiresAt,
        message: 'Save this token now — it will not be shown again.'
    });
}));

/**
 * DELETE /auth/tokens/:id
 * Revoke one of the current user's tokens. Idempotent-ish: 404 if it isn't the caller's or is already gone.
 */
/**
 * @swagger
 * /auth/tokens/{id}:
 *   delete:
 *     summary: Revoke one of the caller's API tokens
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie.
 *     responses:
 *       200:
 *         description: Token revoked
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 revoked:
 *                   type: boolean
 *                 id:
 *                   type: integer
 *       400:
 *         description: "rest_invalid_param — the id is not a well-formed route id."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           The caller is headless, rest_forbidden (no manage_api_tokens), rest_csrf_token /
 *           rest_csrf_invalid, or mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       404:
 *         description: "rest_token_not_found — not the caller's token, or already revoked."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.delete('/tokens/:id', authenticate, sessionOnly, can('manage_api_tokens'), asyncHandler(async (req: Request, res: Response) => {
    // THE ROUTE-ID CONTRACT — see core/query-params. The 400 and its body are this route's published
    // answer and are unchanged; the PREDICATE is now the single shared one. The local test was
    // `parseInt` + `Number.isInteger(id) && id > 0`: integrality and positivity, no upper bound and no
    // shape check, so `/auth/tokens/9999999999` reached `ApiToken.revoke` and became
    // `22003 value out of range for type integer` — a 500 — on Postgres, and `/auth/tokens/12abc`
    // revoked token 12.
    const id = routeIdOrNull(req.params.id);
    if (id === null) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid token id.', data: { status: 400 } });
    }
    const ok = await ApiToken.revoke(id, req.user.id);
    if (!ok) {
        return res.status(404).json({
            code: 'rest_token_not_found',
            message: 'Token not found or already revoked.',
            data: { status: 404 }
        });
    }
    await recordAudit(req.user.id, 'auth.token.revoke', 'api_token', id, {});
    res.json({ revoked: true, id });
}));

// ─── Multi-factor auth (TOTP) ──────────────────────────────────────────────────────────────────────
// The login step (POST /mfa) is public — it's the 2nd half of authentication, gated by the short-lived
// challenge token that /auth/login issues only after the password check. Management routes are session-
// only (an API token, even one leaked, must never be able to enroll/disable MFA or mint backup codes).

/**
 * POST /auth/mfa — complete a login that requires a second factor. Body: { mfaToken, code }.
 * The challenge token proves the password step passed; verify a TOTP/backup code, then issue the session.
 */
/**
 * @swagger
 * /auth/mfa:
 *   post:
 *     summary: Complete a login that requires a second factor
 *     description: >-
 *       Public by design — this is the second half of authentication, gated by the short-lived challenge
 *       token POST /auth/login issues only after the password check. Accepts a TOTP code or a backup
 *       code; on success the session cookie is issued.
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mfaToken, code]
 *             properties:
 *               mfaToken:
 *                 type: string
 *                 description: The challenge token returned by POST /auth/login.
 *               code:
 *                 type: string
 *                 description: A current TOTP code, or one of the account's backup codes.
 *     responses:
 *       200:
 *         description: Login complete; a session cookie is set
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *                 mfa:
 *                   $ref: '#/components/schemas/MfaStatus'
 *       401:
 *         description: >-
 *           rest_mfa_challenge_invalid (the challenge is missing, malformed or expired),
 *           rest_user_invalid (the account behind the challenge no longer exists) or rest_mfa_invalid
 *           (wrong code).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: "rest_csrf_invalid — the same-origin check refused the request."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: >-
 *           rest_account_locked (too many wrong codes for this account) or rest_login_throttled (too many
 *           simultaneous attempts; carries Retry-After).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.post('/mfa', asyncHandler(async (req: Request, res: Response) => {
    const { mfaToken, code } = req.body || {};
    const challenge = mfa.verifyChallenge(mfaToken);
    if (!challenge) {
        return res.status(401).json({ code: 'rest_mfa_challenge_invalid', message: 'Your login session expired. Please sign in again.', data: { status: 401 } });
    }
    const user = await User.findById(challenge.userId);
    if (!user) return res.status(401).json({ code: 'rest_user_invalid', message: 'User not found.', data: { status: 401 } });

    // Throttle code guesses under a SEPARATE 'mfa:' lockout bucket. Crucially this is NOT the password
    // bucket (user.userLogin) that /login clears on a correct password — otherwise an attacker who knows
    // the password could reset the throttle and brute-force the 6-digit code.
    // Keyed by the numeric id resolved from the SIGNED challenge, in the 'mfa' purpose. `'mfa:' + login`
    // put this bucket in the login store's flat space, where an anonymous /auth/login could arm it.
    // This door KEEPS its lock, unlike the three enrolment doors below: it is pre-authentication and the
    // thing it throttles is a 6-digit code, so a hard stop is the point. Arming it still requires a valid
    // challenge — i.e. the password — which is the same bar as the login lock it sits beside.
    // AND IT IS THE ONLY WRITER. That is the half the first redesign lost: the three doors below moved to
    // 'mfa_manage' precisely so that no door a mere session cookie can reach is able to arm the bucket
    // this one refuses on. Reader and writer of `mfa:<id>` are both this handler; the gate derives that
    // pair from the source rather than trusting this comment.
    const lockKey = lockBucket('mfa', user.id);
    if (await isLoginLocked(lockKey)) {
        return res.status(429).json({ code: 'rest_account_locked', message: 'Account temporarily locked due to too many failed attempts. Try again later.', data: { status: 429 } });
    }
    // Same concurrency backstop as /login (audit AUTH-A3): isLoginLocked is check-then-arm and
    // mfa.verifyLoginCode yields the event loop (DB reads), so a burst of parallel guesses for one account
    // would all clear the lock before recordLoginFail arms it — brute-forcing the 6-digit TOTP and
    // defeating 2FA. Cap concurrent in-flight verifications for this 'mfa:' bucket; release in finally.
    if (!(await beginLoginAttempt(lockKey))) {
        res.set('Retry-After', '1');
        return res.status(429).json({ code: 'rest_login_throttled', message: 'Too many simultaneous attempts for this account. Try again in a moment.', data: { status: 429 } });
    }
    try {
        if (!(await mfa.verifyLoginCode(user.id, code))) {
            await recordLoginFail(lockKey);
            return res.status(401).json({ code: 'rest_mfa_invalid', message: 'Invalid authentication code.', data: { status: 401 } });
        }
        await clearLoginFails(lockKey);
        // The second half of a 2FA login: THIS is where the session is issued, so this is where the
        // completed login is recorded (POST /auth/login only handed out a challenge).
        await recordAudit(user.id, 'auth.login.success', 'user', user.id, {
            username: auditText(user.userLogin), method: 'mfa', ip: auditText(clientIp(req), 45)
        });
        const token = generateToken(user);
        if (issueSessionCookie(req, res, token, COOKIE_OPTIONS())) return;
        res.json({ user: user.toJSON(), mfa: await mfa.evaluate(user) });
    } finally {
        await endLoginAttempt(lockKey);
    }
}));

/** GET /auth/mfa/status — is MFA on for the current user + how many backup codes remain. */
/**
 * @swagger
 * /auth/mfa/status:
 *   get:
 *     summary: Two-factor status for the caller
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Whether TOTP is on, and how many backup codes remain
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                 backupCodesRemaining:
 *                   type: integer
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.get('/mfa/status', authenticate, asyncHandler(async (req: Request, res: Response) => {
    res.json({ enabled: await mfa.isEnabled(req.user.id), backupCodesRemaining: await mfa.backupCount(req.user.id) });
}));

// SUDO RE-AUTH for enrollment. The MFA routes were asymmetric: turning 2FA OFF, regenerating backup
// codes and changing the password all demand extra proof, while turning it ON demanded nothing beyond
// the ambient cookie. A hijacked session (same-origin XSS calling fetch with credentials — the cookie is
// httpOnly, it is never "stolen" — or an unlocked laptop) could therefore enroll the ATTACKER's
// authenticator and lock the owner out for good: forgot-password/reset-password change the password but
// clear no mfa_* key, so the victim can never pass the second factor again. The throttle did not help
// either — the attacker gets the code right first time, because /mfa/setup handed them the secret.
// The invariant this encodes: no operation that depends on a cookie alone may produce a state its owner
// cannot undo. Same helper as the two self-service password doors in routes/users.ts, so the sudo rule
// (per-account lockout bucket + in-flight cap) cannot drift between them. Required lazily, mirroring how
// routes/users.ts requires this module, so the two routers never form a load-time cycle.
function requireSudoPassword(req: Request, res: Response): Promise<boolean> {
    return require('./users').requireSudoPassword(req, res, (req.body || {}).currentPassword);
}

/** POST /auth/mfa/setup — begin enrollment: returns a new secret + otpauth URI (for the QR). */
/**
 * @swagger
 * /auth/mfa/setup:
 *   post:
 *     summary: Begin two-factor enrollment
 *     description: >-
 *       Mints a pending TOTP secret and returns it with an otpauth URI for the QR code. Because this is
 *       the door that DISCLOSES the secret, it demands the account password again (sudo re-auth) — an
 *       ambient session cookie alone must never be able to enroll an attacker's authenticator. Requires
 *       an interactive session; an API token is refused.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword]
 *             properties:
 *               currentPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: Pending secret issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 secret:
 *                   type: string
 *                 otpauthUri:
 *                   type: string
 *       400:
 *         description: "rest_mfa_already_enabled — disable the existing second factor before re-enrolling."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_bad_current_password (the sudo re-auth failed), the caller is headless, or
 *           rest_csrf_token / rest_csrf_invalid.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: "rest_login_throttled — too many simultaneous sudo attempts from this address."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.post('/mfa/setup', authenticate, sessionOnly, asyncHandler(async (req: Request, res: Response) => {
    // Before the pending secret is minted or disclosed: /mfa/setup is what hands the caller the TOTP
    // secret, so it is the first door that must prove the password, not just the second one.
    if (await requireSudoPassword(req, res)) return;
    if (await mfa.isEnabled(req.user.id)) {
        return res.status(400).json({ code: 'rest_mfa_already_enabled', message: 'MFA is already enabled. Disable it first to re-enroll.', data: { status: 400 } });
    }
    const { secret, otpauthUri } = await mfa.beginEnroll(req.user.id, req.user.userEmail || req.user.userLogin);
    res.json({ secret, otpauthUri });
}));

/** POST /auth/mfa/enable — verify a code against the pending secret, activate, return backup codes once. */
/**
 * @swagger
 * /auth/mfa/enable:
 *   post:
 *     summary: Activate two-factor authentication
 *     description: >-
 *       Verifies a code against the pending secret from POST /auth/mfa/setup, turns 2FA on and returns
 *       the backup codes ONCE. Also demands the account password (sudo re-auth), because activating is
 *       the step that actually locks the account. Requires an interactive session.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, code]
 *             properties:
 *               currentPassword:
 *                 type: string
 *               code:
 *                 type: string
 *                 description: A TOTP code generated from the pending secret.
 *     responses:
 *       200:
 *         description: Two-factor enabled; backup codes are shown once
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                 backupCodes:
 *                   type: array
 *                   items:
 *                     type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: "rest_mfa_invalid — the code did not verify against the pending secret."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_bad_current_password (the sudo re-auth failed), the caller is headless, or
 *           rest_csrf_token / rest_csrf_invalid.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: "rest_login_throttled — too many simultaneous attempts from this address."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.post('/mfa/enable', authenticate, sessionOnly, asyncHandler(async (req: Request, res: Response) => {
    // Both halves of enrollment are gated, not just /setup: a pending secret may already exist (minted
    // before this guard shipped, or by the legitimate owner who then walked away), and activating it is
    // the step that actually locks the account. Checked BEFORE the 'mfa:' bucket is entered so a wrong
    // password never holds one of its in-flight slots.
    if (await requireSudoPassword(req, res)) return;
    // 'mfa_manage', NOT 'mfa'. The three enrolment/management doors had their lock CHECK replaced by a
    // wait but kept writing the 'mfa' bucket — the one POST /auth/mfa still reads and refuses on. A door
    // that needs only the session cookie could therefore lock the owner out of their own second factor,
    // permanently. This purpose is count-only (see LOCKING_PURPOSES): its failures buy the wait below and
    // arm nothing, here or anywhere else.
    const lk = lockBucket('mfa_manage', req.user.id);
    const slot = inflightBucket('mfa_manage', req.user.id, req);
    // Concurrency backstop (AUTH-A3 class): completeEnroll yields the event loop, so cap parallel guesses.
    // TAKE THE SLOT FIRST, then pay inside it — outside, the waits run in parallel and bound latency
    // instead of throughput (see payFailureDelay).
    if (!(await beginLoginAttempt(slot))) return res.status(429).json({ code: 'rest_login_throttled', message: 'Too many simultaneous attempts. Try again in a moment.', data: { status: 429 } });
    try {
        await payFailureDelay(lk);
        const result = await mfa.completeEnroll(req.user.id, (req.body || {}).code);
        if (!result.ok) {
            await recordLoginFail(lk);
            return res.status(400).json({ code: 'rest_mfa_invalid', message: 'Invalid code. Check your device clock and try again.', data: { status: 400 } });
        }
        await clearLoginFails(lk);
        // The backup codes themselves are in `result` and go nowhere near the log.
        await recordAudit(req.user.id, 'auth.mfa.enable', 'user', req.user.id, {});
        res.json({ enabled: true, backupCodes: result.backupCodes, message: 'Save these backup codes now — they will not be shown again.' });
    } finally {
        await endLoginAttempt(slot);
    }
}));

/** POST /auth/mfa/disable — turn MFA off (requires a current TOTP or backup code). */
/**
 * @swagger
 * /auth/mfa/disable:
 *   post:
 *     summary: Turn two-factor authentication off
 *     description: >-
 *       Requires a current TOTP or backup code. Idempotent — 200 with disabled=true when 2FA was already
 *       off. Repeated wrong codes buy an escalating bounded WAIT, never a lockout, so this door can never
 *       be used to lock the owner out of their own second factor. Requires an interactive session.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code:
 *                 type: string
 *                 description: A current TOTP code, or one of the account's backup codes.
 *     responses:
 *       200:
 *         description: Two-factor disabled
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 disabled:
 *                   type: boolean
 *       400:
 *         description: "rest_mfa_invalid — wrong authentication code."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: "The caller is headless, or rest_csrf_token / rest_csrf_invalid."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: "rest_login_throttled — too many simultaneous attempts from this address."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.post('/mfa/disable', authenticate, sessionOnly, asyncHandler(async (req: Request, res: Response) => {
    if (!(await mfa.isEnabled(req.user.id))) return res.json({ disabled: true });
    // 'mfa_manage' (count-only), never 'mfa'. This door needs `authenticate` + `sessionOnly` and NOT the
    // sudo password, so it is the cheapest door in the file to reach with a hijacked session — and while
    // it wrote the 'mfa' bucket, twelve wrong codes here answered the owner's CORRECT code at POST
    // /auth/mfa with 429, renewably and with no recovery path.
    const lk = lockBucket('mfa_manage', req.user.id);
    const slot = inflightBucket('mfa_manage', req.user.id, req);
    // Concurrency backstop (AUTH-A3 class): a hijacked session must not brute-force the code to turn MFA OFF.
    if (!(await beginLoginAttempt(slot))) return res.status(429).json({ code: 'rest_login_throttled', message: 'Too many simultaneous attempts. Try again in a moment.', data: { status: 429 } });
    try {
        await payFailureDelay(lk); // bounded wait INSIDE the slot, never a refusal — see payFailureDelay
        if (!(await mfa.verifyLoginCode(req.user.id, (req.body || {}).code))) {
            await recordLoginFail(lk);
            return res.status(400).json({ code: 'rest_mfa_invalid', message: 'Invalid authentication code.', data: { status: 400 } });
        }
        await clearLoginFails(lk);
        await mfa.disable(req.user.id);
        // Turning the second factor OFF is the direction that weakens the account — and this is the
        // cheapest door in the file to reach with a hijacked session (no sudo password). It leaves a row.
        await recordAudit(req.user.id, 'auth.mfa.disable', 'user', req.user.id, {});
        res.json({ disabled: true });
    } finally {
        await endLoginAttempt(slot);
    }
}));

/** POST /auth/mfa/backup-codes — regenerate backup codes (requires a current code); returns them once. */
/**
 * @swagger
 * /auth/mfa/backup-codes:
 *   post:
 *     summary: Regenerate the backup codes
 *     description: >-
 *       Requires a current TOTP or backup code. The new set REPLACES the previous one and is returned
 *       once. Requires an interactive session.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code:
 *                 type: string
 *     responses:
 *       200:
 *         description: A fresh set of backup codes, shown once
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 backupCodes:
 *                   type: array
 *                   items:
 *                     type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: "rest_mfa_not_enabled (2FA is off) or rest_mfa_invalid (wrong code)."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: "The caller is headless, or rest_csrf_token / rest_csrf_invalid."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: "rest_login_throttled — too many simultaneous attempts from this address."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.post('/mfa/backup-codes', authenticate, sessionOnly, asyncHandler(async (req: Request, res: Response) => {
    if (!(await mfa.isEnabled(req.user.id))) {
        return res.status(400).json({ code: 'rest_mfa_not_enabled', message: 'MFA is not enabled.', data: { status: 400 } });
    }
    // 'mfa_manage' (count-only), never 'mfa' — see POST /auth/mfa/disable above.
    const lk = lockBucket('mfa_manage', req.user.id);
    const slot = inflightBucket('mfa_manage', req.user.id, req);
    // Concurrency backstop (AUTH-A3 class): a hijacked session must not brute-force the code to regenerate
    // backup codes (which would grant persistent 2FA access).
    if (!(await beginLoginAttempt(slot))) return res.status(429).json({ code: 'rest_login_throttled', message: 'Too many simultaneous attempts. Try again in a moment.', data: { status: 429 } });
    try {
        await payFailureDelay(lk); // bounded wait INSIDE the slot, never a refusal — see payFailureDelay
        if (!(await mfa.verifyLoginCode(req.user.id, (req.body || {}).code))) {
            await recordLoginFail(lk);
            return res.status(400).json({ code: 'rest_mfa_invalid', message: 'Invalid authentication code.', data: { status: 400 } });
        }
        await clearLoginFails(lk);
        const backupCodes = await mfa.regenerateBackupCodes(req.user.id);
        // Regenerating backup codes grants a fresh set of second factors — persistence, in an attacker's
        // hands. The codes are never passed to the log; only the fact and the count.
        await recordAudit(req.user.id, 'auth.mfa.backup_codes', 'user', req.user.id, {
            count: Array.isArray(backupCodes) ? backupCodes.length : 0
        });
        res.json({ backupCodes, message: 'Save these backup codes now — they replace your previous set.' });
    } finally {
        await endLoginAttempt(slot);
    }
}));

// ─── Admin-enforced MFA-by-role policy ─────────────────────────────────────────────────────────────
// sessionOnly (not just isAdmin): the policy governs interactive-login security, so a headless API token
// — even an admin's — must never reconfigure it. NOT on the mfaComplianceGate exempt list, so an enforced
// (un-enrolled, past-grace) admin must enroll before they can change the policy, closing the "disable the
// requirement instead of enrolling" bypass.

/** GET /auth/mfa/policy — read the enforcement policy (admin only). */
/**
 * @swagger
 * /auth/mfa/policy:
 *   get:
 *     summary: Read the MFA-by-role enforcement policy
 *     description: >-
 *       Administrator only, and interactive-session only — a headless API token, even an administrator's,
 *       may not read or change interactive-login security. This route is NOT on the enrollment allowlist,
 *       so an enforced administrator must enroll before reaching it.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The current policy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 policy:
 *                   $ref: '#/components/schemas/MfaPolicy'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_forbidden (not an administrator), the caller is headless, or mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.get('/mfa/policy', authenticate, sessionOnly, isAdmin, asyncHandler(async (_req: Request, res: Response) => {
    res.json({ policy: await mfa.getPolicy() });
}));

/**
 * PUT /auth/mfa/policy — set which roles require MFA + the grace period (admin only).
 * Body: { requiredRoles, graceDays, enforceForApiTokens }.
 */
/**
 * @swagger
 * /auth/mfa/policy:
 *   put:
 *     summary: Set the MFA-by-role enforcement policy
 *     description: >-
 *       FULL REPLACE — an omitted field means "off", not "unchanged". Role slugs are validated against
 *       the live role map and unknown ones are dropped. Administrator only, interactive-session only, and
 *       not on the enrollment allowlist.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               requiredRoles:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Role slugs that must have 2FA. An empty list turns enforcement off.
 *               graceDays:
 *                 type: number
 *                 minimum: 0
 *               enforceForApiTokens:
 *                 type: boolean
 *                 description: >-
 *                   Must be a real boolean — "false", 0 and "on" are REJECTED rather than coerced,
 *                   because this flag can start refusing existing headless clients.
 *     responses:
 *       200:
 *         description: The stored policy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 policy:
 *                   $ref: '#/components/schemas/MfaPolicy'
 *       400:
 *         description: >-
 *           rest_invalid_param — requiredRoles is not an array, graceDays is negative or not a number, or
 *           enforceForApiTokens is not a boolean.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_forbidden (not an administrator), the caller is headless, rest_csrf_token /
 *           rest_csrf_invalid, or mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.put('/mfa/policy', authenticate, sessionOnly, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const { requiredRoles, graceDays, enforceForApiTokens } = req.body || {};
    if (requiredRoles != null && !Array.isArray(requiredRoles)) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'requiredRoles must be an array of role slugs.', data: { status: 400 } });
    }
    if (graceDays != null && (!Number.isFinite(Number(graceDays)) || Number(graceDays) < 0)) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'graceDays must be a non-negative number.', data: { status: 400 } });
    }
    // Rejected rather than coerced: this flag can start REFUSING existing headless clients, so a caller that
    // sends "false"/0/"on" must be told it was mis-typed instead of having a truthiness rule guessed for it.
    if (enforceForApiTokens != null && typeof enforceForApiTokens !== 'boolean') {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'enforceForApiTokens must be a boolean.', data: { status: 400 } });
    }
    // setPolicy validates role slugs against the live role map + manages enforcedAt.
    res.json({ policy: await mfa.setPolicy({ requiredRoles, graceDays, enforceForApiTokens }) });
}));

module.exports = router;
// Exposed so other credential-checking endpoints (e.g. /setup/migrate) share the SAME per-account
// lockout — otherwise they become an unthrottled password oracle that bypasses this one (audit MEDIUM).
module.exports.isLoginLocked = isLoginLocked;
module.exports.recordLoginFail = recordLoginFail;
module.exports.clearLoginFails = clearLoginFails;
module.exports.resolveLockIdentifier = resolveLockIdentifier;
// Shared so every OTHER credential/second-factor endpoint that check-then-arms the same per-account
// lockout (POST /auth/mfa, POST /setup/migrate, DELETE /plugins/:slug) gets the SAME concurrency backstop
// — otherwise a burst of parallel guesses clears the lock check before it arms, bypassing the per-account
// cap on that endpoint exactly as it did on /login before MAX_LOGIN_INFLIGHT (audit AUTH-A3, class fix).
module.exports.beginLoginAttempt = beginLoginAttempt;
module.exports.endLoginAttempt = endLoginAttempt;
// The cap itself, so the gate that proves the wait bounds THROUGHPUT (and not merely latency) derives the
// number it asserts instead of restating it.
module.exports.MAX_LOGIN_INFLIGHT = MAX_LOGIN_INFLIGHT;
// The namespacing primitive and its closed purpose set — exported so a door in another module can join
// the store correctly instead of inventing a prefix, and so the gate test can derive the purpose set
// (rather than restate it) when it proves no purpose is reachable from another's subject.
module.exports.lockBucket = lockBucket;
module.exports.LOCK_PURPOSES = LOCK_PURPOSES;
// Which purposes have a lock at all. Exported so the gate can compare this declaration against the
// isLoginLocked readers it finds in the source, instead of restating either half.
module.exports.LOCKING_PURPOSES = LOCKING_PURPOSES;
module.exports.loginFailCount = loginFailCount;
// The bounded wait itself, so a credential door in another module (POST /setup/migrate) throttles with the
// SAME primitive instead of the check-then-refuse that made it a hostage. See payFailureDelay.
module.exports.payFailureDelay = payFailureDelay;
