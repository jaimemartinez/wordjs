/**
 * WordJS - Users Routes
 * /api/v1/users/*
 */

import type { Request, Response, NextFunction } from 'express';

const express = require('express');
const router = express.Router();
const User = require('../models/User');
// THE DOCTRINE OF THIS ROUTER: an API token — even an administrator's — must never drive an
// account-security operation. It is enforced ONCE, for every route, by refuseHeadlessAccountSecurity
// below — never route by route, which is how it came to cover 2 routes out of 8.
const { authenticate, sessionOnly } = require('../middleware/auth');
const { can, isAdmin, ownerOrCan } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { getRoles } = require('../core/roles');
// ACTIVE CORPORATE MAILBOX: the admin-owned grant + the one self-service email-write rule.
const { refuseSelfServiceEmailChange, isValidAddress, mailboxFlagValue, hasProfessionalMailbox } = require('../core/mailbox');
const { recordAudit } = require('../core/audit');

// ─── DOCTRINE, ENFORCED ONCE FOR THE WHOLE ROUTER ──────────────────────────────────────────────────
//
// The rule is the one stated at the top of this file: an API token — even an administrator's — must
// never drive an account-security operation.
//
// THE CLASS: a doctrine applied ROUTE BY ROUTE covers exactly the routes somebody remembered. `sessionOnly`
// was pinned to 2 of this router's 8 routes, so a `wjt_` write token could still reset ANOTHER user's
// password and rewrite their recovery address (PUT /:id), mint a brand-new administrator (POST /) or
// delete an account (DELETE /:id) — which made the refusal on /:id/mfa/reset decorative: the same token
// simply created a clean administrator and carried on from there. Listing what a token may not touch is
// the wrong shape; the list is open-ended and one omission is a full bypass.
//
// So the gate is INVERTED, the same way `issueSessionCookie` inverted the cookie rule: EVERY write in
// this router is an account-security operation BY DEFAULT, and a route added later inherits the refusal
// without anyone having to remember. There is exactly one exemption, and it is a predicate over the
// FIELDS ACTUALLY TOUCHED rather than a list of paths — a profile PUT that carries nothing but cosmetics
// (display name, URL) is not account security, so headless clients keep that much.
//
// Extend ACCOUNT_SECURITY_FIELDS when a new credential-bearing or privilege-bearing field appears; do not
// re-introduce a per-route `sessionOnly`, which is how the coverage drifted in the first place.
//
// ─── WHY THIS IS A MAP AND NOT A LIST ──────────────────────────────────────────────────────────────
//
// THE CLASS, restated at the value level: a guard that judges a DIFFERENT VALUE from the one the sink
// writes is not a guard. The exemption used to read every field the same way — "blank or null means not
// supplied" — while two of the six sinks condition on mere PRESENCE:
//
//     users.ts (PUT /:id)  `if (personalEmail !== undefined) updateData.meta = { personal_email: … }`
//     users.ts (PUT /:id)  `req.body.professionalMailbox !== undefined && mailboxFlagValue(…) !== …`
//                          (core/mailbox mailboxFlagValue maps '' and null to '0' — a REVOCATION)
//
// So `{personalEmail: ''}` and `{professionalMailbox: null}` read as "not supplied" to the gate and as
// "write this" to the sink: an administrator's `wjt_` token could blank ANY account's recovery address
// (moving the reset link to the primary mailbox, which on this product may be hosted here) and revoke
// mailbox grants — the exact operation the doctrine at the top of this file says a token cannot drive.
//
// The repair is not "make the guard stricter"; it is to make the guard read the field the way its own
// sink reads it, and to keep the two statements NEXT TO EACH OTHER so they cannot drift apart again:
//
//     'presence'  the sink acts on `field !== undefined`; ANY value present, blank included, is a write.
//     'nonblank'  the sink acts on truthiness / suppliedText(); a blank value never reaches storage.
//
// The criterion is declared here and consumed by `fieldIsSupplied` below; the sinks are annotated with
// the criterion they implement. A field added to this map is refused headlessly by default.
type SuppliedCriterion = 'presence' | 'nonblank';
const ACCOUNT_SECURITY_FIELDS: Record<string, SuppliedCriterion> = {
    password: 'nonblank',            // the credential itself; sink = suppliedText() (see both PUT handlers)
    currentPassword: 'nonblank',     // …and the sudo proof for it — a blank proof proves nothing
    email: 'nonblank',               // recovery-bearing (recoveryTarget falls back to it); sink = suppliedText()
    personalEmail: 'presence',       // recovery-bearing (recoveryTarget PREFERS it); sink = `!== undefined`
    role: 'nonblank',                // privilege — the role guards below ignore a blank role
    professionalMailbox: 'presence', // the admin-owned mailbox grant; blank/null = mailboxFlagValue '0' = revoke
};

/**
 * Is `field` SUPPLIED by this body, judged by the criterion its own sink uses?
 *
 * Exported (module.exports at the bottom) so the class gate can iterate the real table instead of a
 * hand-written copy of it: the population of this class is "every account-security field", and it has to
 * come from the module, not from whoever remembered to add a row to a test.
 */
function fieldIsSupplied(field: string, body: any): boolean {
    const v = (body || {})[field];
    if (v === undefined) return false;                          // absent is absent under either criterion
    if (ACCOUNT_SECURITY_FIELDS[field] === 'presence') return true;
    return v !== null && String(v).trim() !== '';
}

function isAccountSecurityWrite(req: Request): boolean {
    const method = String(req.method || '').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
    if (method === 'PUT') {
        // A PUT is account security only when it actually carries one of the fields above — judged, per
        // field, exactly as that field's sink judges it. Never "did the value change": this gate decides
        // WHICH CREDENTIAL may drive the request and must not have to read the database to answer that.
        const body = (req.body || {}) as Record<string, unknown>;
        return Object.keys(ACCOUNT_SECURITY_FIELDS).some((f) => fieldIsSupplied(f, body));
    }
    // POST (create an account, cut every session, reset a second factor) and DELETE (destroy an account)
    // are account security unconditionally — including any POST/DELETE added to this router in future.
    return true;
}

// ONE implementation of the refusal (middleware/auth.ts), so the status and the error code cannot drift
// from the sibling gates on routes/auth.ts.
function refuseHeadlessAccountSecurity(req: Request, res: Response, next: NextFunction) {
    if (!isAccountSecurityWrite(req)) return next();
    return sessionOnly(req, res, next);
}

// `authenticate` is mounted here for the WHOLE router (every route below needs it), so the gate that
// follows can read the headless mark `authenticate` sets. Individual routes therefore no longer repeat
// it — repeating it would authenticate twice per request.
router.use(authenticate, refuseHeadlessAccountSecurity);


/**
 * @swagger
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         username:
 *           type: string
 *         email:
 *           type: string
 *         displayName:
 *           type: string
 *         role:
 *           type: string
 *
 * /users:
 *   get:
 *     summary: Retrieve a list of users
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: per_page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: A list of users
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
 */
router.get('/', can('list_users'), asyncHandler(async (req: Request, res: Response) => {
    const {
        page = 1,
        per_page = 10,
        search,
        role,
        orderby = 'id',
        order = 'asc'
    } = req.query;

    // `parseInt` stringifies its argument before parsing, so `String(...)` here is the coercion the
    // untyped call already performed implicitly — a repeated `?per_page=5&per_page=7` still parses
    // "5,7" to 5, and a bracketed one still parses "[object Object]" to NaN and takes the default.
    const limit = Math.min(parseInt(String(per_page), 10) || 10, 100);
    const offset = (Math.max(parseInt(String(page), 10) || 1, 1) - 1) * limit;

    // SECURITY: Whitelist allowed orderBy columns to prevent SQL injection
    const allowedOrderBy = ['id', 'user_login', 'display_name', 'user_email', 'user_registered'];
    // A query value is not necessarily a string: `?orderby=a&orderby=b` parses to an array. The
    // whitelist compares with ===, so a non-string has never matched an entry and has always fallen
    // through to 'id' — collapsing it to '' reproduces that outcome for every input.
    const requestedOrderBy = typeof orderby === 'string' ? orderby : '';
    const safeOrderBy = allowedOrderBy.includes(requestedOrderBy) ? requestedOrderBy : 'id';
    // `order` is ASSERTED rather than narrowed, deliberately. A repeated `?order=` parses to an array
    // whose missing `.toLowerCase` has always thrown and surfaced as a 500; narrowing it to '' would
    // quietly turn that into a 200 sorted ASC. That is a behaviour change, not a typing one, so the
    // pre-existing defect is reported rather than fixed under a type-only migration.
    const requestedOrder = order as string;
    const safeOrder = ['asc', 'desc'].includes(requestedOrder.toLowerCase()) ? requestedOrder.toUpperCase() : 'ASC';

    const users = await User.findAll({
        search,
        role,
        limit,
        offset,
        orderBy: safeOrderBy,
        order: safeOrder
    });

    const total = await User.count({ search, role });
    const totalPages = Math.ceil(total / limit);

    res.set('X-WP-Total', total);
    res.set('X-WP-TotalPages', totalPages as any);

    res.json(users.map((user: any) => user.toJSON()));
}));

/**
 * GET /users/me
 * Get current user
 */
router.get('/me', (req: Request, res: Response) => {
    res.json(req.user.toJSON());
});

/**
 * GET /users/:id
 * Get single user
 */
router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    // `String(...)` is the coercion `parseInt` already applied to this argument implicitly; it is here
    // only because a route param is typed `string | string[]`, and it parses identically either way.
    const userId = parseInt(String(req.params.id), 10);
    const user = await User.findById(userId);

    if (!user) {
        return res.status(404).json({
            code: 'rest_user_invalid_id',
            message: 'Invalid user ID.',
            data: { status: 404 }
        });
    }

    // Users can view themselves, admins can view anyone
    if (req.user.id !== userId && !req.user.can('list_users')) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You cannot view this user.',
            data: { status: 403 }
        });
    }

    res.json(user.toJSON());
}));

/**
 * @swagger
 * /users:
 *   post:
 *     summary: Create a new user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
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
 *               role:
 *                 type: string
 *                 enum: [administrator, editor, author, contributor, subscriber]
 *     responses:
 *       201:
 *         description: User created
 *       403:
 *         description: Forbidden
 */
router.post('/', isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const { username, email, password, displayName, role = 'subscriber', personalEmail } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Username, email, and password are required.',
            data: { status: 400 }
        });
    }

    // The PRIMARY email must be a real address. User.create enforces the same rule (it is the model-level
    // backstop for the importers and self-registration), but reaching it here would surface as a raw 500;
    // answer the API's own 400 shape instead. One rule, expressed once — EMAIL_FORMAT_RE from core/mailbox.
    if (!isValidAddress(email)) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid email format.', data: { status: 400 } });
    }

    // Optional personal/recovery email (coexists with the primary email; used for password recovery).
    if (personalEmail && !isValidAddress(personalEmail)) {
        return res.status(400).json({ code: 'rest_invalid_personal_email', message: 'Personal email format is invalid.', data: { status: 400 } });
    }

    try {
        const user = await User.create({
            username,
            email,
            password,
            displayName,
            role,
            personalEmail,
            // ACTIVE CORPORATE MAILBOX — the "Professional Mail Account" toggle on the admin user form.
            // Safe to forward unconditionally: this route is `isAdmin`, so the caller is by definition
            // allowed to provision mailboxes. Self-registration (POST /auth/register) never reaches here.
            professionalMailbox: req.body.professionalMailbox
        });

        // AUDIT: admin created a user. No secret material — just the login and assigned role.
        await recordAudit(req.user.id, 'user.create', 'user', user.id, { username, role });

        res.status(201).json(user.toJSON());
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
 * /users/{id}:
 *   put:
 *     summary: Update a user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               displayName:
 *                 type: string
 *               password:
 *                 type: string
 *               role:
 *                 type: string
 *     responses:
 *       200:
 *         description: User updated
 *       403:
 *         description: Forbidden
 *       404:
 *         description: User not found
 */
/**
 * @swagger
 * /users/me:
 *   put:
 *     summary: Update current user profile
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               displayName:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Profile updated
 */
// NOTE: must be declared BEFORE '/:id' — Express matches in order and '/:id' would otherwise
// capture the literal path 'me' (parseInt('me') → NaN → "Invalid user ID"). Mirrors GET /me / GET /:id.
// Password-change-specific PRECONDITION for a SELF edit: a new password must be long enough. The sudo
// re-auth itself is no longer chained here — it is decided per TOUCHED FIELD by selfEditNeedsSudo below
// and applied ONCE, just before the write, by both self-service doors. Returns true if it already sent a
// response (caller must return), false to proceed.
function rejectWeakSelfPassword(res: Response, password: any): boolean {
    if (!password) return false;
    if (String(password).length < 8) {
        res.status(400).json({ code: 'rest_weak_password', message: 'Password must be at least 8 characters.', data: { status: 400 } });
        return true;
    }
    return false;
}

/**
 * Which fields of a SELF edit may NOT be changed on an ambient cookie alone.
 *
 * The invariant the MFA gate states — "no operation that depends on a cookie alone may produce a state its
 * owner cannot undo" (routes/auth.ts) — had a live counterexample right here: sudo was chained to the
 * PASSWORD field only, so a hijacked session could not reset the password but COULD rewrite the recovery
 * address and then walk the account out through the front door:
 *   PUT /users/me {personalEmail} → POST /auth/forgot-password → the reset link arrives at the attacker →
 *   reset-password sets a new password AND stamps token_valid_after → the owner is locked out for good.
 * `recoveryTarget()` (routes/auth.ts) PREFERS personal_email and FALLS BACK to the primary address, so
 * BOTH are recovery-bearing state and both are reported as a change here. (The password field is the
 * other sudo trigger, decided at the two call sites: it is a change by mere presence.)
 *
 * Compares the VALUE, never mere presence: every profile form re-sends the whole object on every save, so
 * a presence check would 403 "rename my display name" — the same no-op-resend trap professionalMailbox,
 * `role` and refuseSelfServiceEmailChange each had to be taught separately. Case/whitespace-insensitive,
 * matching how those addresses are normalized before they are stored.
 */
function isRealEmailChange(currentEmail: any, submitted: any): boolean {
    if (submitted === undefined || submitted === null || String(submitted).trim() === '') return false;
    return String(submitted).trim().toLowerCase() !== String(currentEmail || '').trim().toLowerCase();
}

async function selfRecoveryAddressChanged(target: any, body: any): Promise<boolean> {
    if (isRealEmailChange(target.userEmail, body.email)) return true;
    if (body.personalEmail !== undefined) {
        // Read the stored value through the SAME accessor recoveryTarget() uses, so the value compared
        // here is the value the recovery flow will read — not a copy that may have gone stale.
        const current = String((await User.getMeta(target.id, 'personal_email')) || '').trim().toLowerCase();
        // Same normalizer as the two sinks (see personalEmailValue): the guard must not be comparing a
        // value the write will not produce.
        if (personalEmailValue(body.personalEmail) !== current) return true;
    }
    return false;
}

/**
 * A recovery address just changed: kill any password-reset token that is still outstanding.
 *
 * Without this the gate above can be raced from the other side — request a reset to the OLD address,
 * then change the address, and the old link still works (or vice versa). Same key pair reset-password
 * consumes (routes/auth.ts), cleared exactly the way that route clears it after a successful reset.
 */
async function invalidatePendingPasswordReset(userId: number): Promise<void> {
    try {
        await User.updateMeta(userId, 'password_reset_hash', '');
        await User.updateMeta(userId, 'password_reset_expires', '0');
    } catch { /* best-effort: the address change itself already required sudo */ }
}

/**
 * "BLANK MEANS NOT SUPPLIED" — the single reading of an absent value in this router.
 *
 * Every gate here already treats a blank address as "left alone" (the 400 validation block, the sudo
 * predicate, the headless gate above, and the two profile forms in the admin UI), because every profile
 * form re-sends its whole object on every save. The WRITE did not agree: `User.update` only skips a
 * FALSY email, so a whitespace-only one reached its format check and came back as an unmapped 500.
 * One helper, applied where the write is assembled, so the value that was judged is the value stored.
 */
function suppliedText(v: any): string | undefined {
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    return s === '' ? undefined : s;
}

/**
 * THE ONE reading of a submitted recovery address — used by the guard, by the validator and by BOTH
 * sinks, so that "the value judged is the value stored" holds by construction.
 *
 * Same class as the exemption above, one level down. `selfRecoveryAddressChanged` compared
 * `String(body.personalEmail || '').trim().toLowerCase()` (null → '') while the two writes stored
 * `String(personalEmail).trim().toLowerCase()` (null → the four-character string "null"). So
 * `{personalEmail: null}` was "unchanged" to the sudo guard and a WRITE to the database, and since
 * `recoveryTarget()` prefers personal_email, the account's reset link was aimed at garbage. The
 * format check did not catch it either: `if (personalEmail && …)` lets every falsy value through.
 *
 * Presence still means "write" (that is how the address is CLEARED, and it is what the headless gate
 * now judges); this only fixes WHAT gets written for a blank/null: the empty string, once.
 */
function personalEmailValue(v: any): string {
    if (v === undefined || v === null) return '';
    return String(v).trim().toLowerCase();
}

/**
 * ─── The sudo re-authentication gate ──────────────────────────────────────────────────────────────
 *
 * Prove you are the human holding the account by re-entering the CURRENT password. Shared with MFA
 * enrollment in routes/auth.ts (it requires this module) so the sudo rule cannot grow a second, drifting
 * copy. Returns true if it already sent a response (the caller must return), false to proceed.
 *
 * TWO CLASSES ARE ENCODED HERE. Extend THIS function; do not add a sibling guard beside it.
 *
 * CLASS 1 — A THROTTLE BUCKET MUST NOT BE ADDRESSABLE BY A STRING AN ATTACKER CAN SUPPLY.
 *   Every lockout bucket in this repo was spelled `'<purpose>:' + identifier` INSIDE the one key space
 *   of routes/auth.ts's login counter, and `resolveLockIdentifier` returns the SUBMITTED identifier raw
 *   whenever no account matches it. A prefix inside a string is not a namespace: an ANONYMOUS
 *   `POST /auth/login {username: 'sudo:victim'}` wrote its failures straight into the victim's sudo
 *   bucket, and ten of them froze every recovery action on that account for fifteen minutes — renewably,
 *   and invisibly, because the victim's own login kept working. So the sudo counter lives in its OWN key
 *   space (the module-private maps below: no route, and no other module, can address them) and is keyed
 *   by the AUTHENTICATED numeric user id — never by anything that arrived in a request.
 *   The rule to carry forward: derive a throttle key from RESOLVED identity, in a store dedicated to the
 *   purpose. Concatenating a purpose onto a fail-open identifier is the defect; the 'sudo:' spelling was
 *   only the symptom. Siblings still on that pattern, all OUTSIDE this file (see the handoff note):
 *     • routes/auth.ts    — `'mfa:' + req.user.userLogin` (4 sites)
 *     • routes/setup.ts   — `'migrate:' + await resolveLockIdentifier(username)`
 *     • routes/plugins.ts — no prefix at all: it writes the raw INTERACTIVE-LOGIN bucket, so a wrong
 *       password at the plugin door locks the owner out of logging in.
 *
 * CLASS 2 — A RE-AUTHENTICATION GATE MUST NEVER REFUSE A CORRECT PASSWORD.
 *   A lock the legitimate owner cannot clear is a denial of service wearing a security badge. The old
 *   shape checked `isLoginLocked` BEFORE authenticating, so while the bucket was armed the right
 *   password got the same 429 as the wrong one — and a hijacked session simply spent ten wrong passwords
 *   every fifteen minutes, after which the owner could no longer change their password, their recovery
 *   address, their 2FA, or their sessions: precisely the four actions that would have evicted the
 *   attacker. "Locked" and "the owner always gets in" are also incompatible in principle: if a lock let
 *   correct passwords through, the 200-vs-429 split would itself be the oracle the lock exists to deny.
 *   So this door has NO lock. Failures buy an escalating, BOUNDED delay (`sudoDelayMs`), paid before the
 *   password is checked; the answer is always the real answer, and a correct password always gets in and
 *   resets the counter. A per-(account, source) cap on CONCURRENT verifications stops one source from
 *   parallelising the delay away; it is keyed by IP as well as account precisely so that a remote
 *   hijacker cannot occupy the owner's own budget.
 *   Residual, stated honestly: an attacker who ALREADY holds a live session for the account and can
 *   spread requests over many addresses still buys back parallelism. The floor is then bcrypt plus the
 *   capped delay. That is the deliberate trade — the alternative, an account-wide refusal, is the
 *   hostage this replaced.
 */
const SUDO_FREE_ATTEMPTS = 3;          // failures that cost nothing (fat fingers, a stale password manager)
const SUDO_DELAY_STEP_MS = 250;        // each further failure adds this much
const SUDO_DELAY_MAX_MS = 8000;        // …up to here, and never beyond: bounded means never a hostage
const SUDO_WINDOW_MS = 15 * 60 * 1000; // failures older than this are forgotten
const SUDO_INFLIGHT_MAX = 3;           // concurrent verifications per (account, source address)
const SUDO_INFLIGHT_STALE_MS = 30000;  // a crashed request must not leak its slot for ever

/** account id -> consecutive failures within the window. Module-private: this IS the key space. */
const _sudoFails = new Map<number, { n: number; at: number }>();
/** `${account}|${ip}` -> in-flight verifications. Same key space, same privacy. */
const _sudoInflight = new Map<string, { n: number; at: number }>();

/**
 * How long this attempt must wait, given the failures already recorded. PURE and TOTAL: for EVERY input
 * it returns a finite number of milliseconds — there is no input for which it can mean "refuse". That is
 * the property the test asserts across the whole domain, not a table of the values it happens to emit.
 */
function sudoDelayMs(fails: any): number {
    const n = Number(fails);
    if (!Number.isFinite(n) || n <= SUDO_FREE_ATTEMPTS) return 0;
    return Math.min((n - SUDO_FREE_ATTEMPTS) * SUDO_DELAY_STEP_MS, SUDO_DELAY_MAX_MS);
}

/**
 * Multi-node: when Redis is configured the counter is backed by the SHARED rate-limit client, so an
 * attacker spreading attempts across replicas does not get R× the free attempts. Its key space is
 * `wjsudo:*`, disjoint from the login store's `wjlock:*` — the separation of Class 1 restated at the
 * storage layer, so even a bug that let something write `wjlock:sudo:x` could not reach this counter.
 * Any store error degrades to the in-process map exactly as routes/auth.ts does: a Redis outage must
 * never be able to refuse a legitimate re-authentication.
 */
function _sudoStore() {
    try { return require('../core/cache').getClient() || null; } catch { return null; }
}
const _sudoRedisKey = (userId: number) => `wjsudo:fails:${userId}`;

function _sudoFailCountMem(userId: number): number {
    const e = _sudoFails.get(userId);
    if (!e) return 0;
    if (Date.now() - e.at > SUDO_WINDOW_MS) { _sudoFails.delete(userId); return 0; }
    return e.n;
}

async function sudoFailCount(userId: number): Promise<number> {
    const client = _sudoStore();
    if (client) {
        try {
            const v = await client.get(_sudoRedisKey(userId));
            return Number(v) || 0;
        } catch { /* store hiccup → the in-process view below */ }
    }
    return _sudoFailCountMem(userId);
}

async function sudoRecordFail(userId: number): Promise<void> {
    const client = _sudoStore();
    if (client) {
        try {
            const k = _sudoRedisKey(userId);
            await client.incr(k);
            await client.expire(k, Math.ceil(SUDO_WINDOW_MS / 1000));
            return;
        } catch { /* store hiccup → record in-process so this node still slows down */ }
    }
    _sudoFails.set(userId, { n: _sudoFailCountMem(userId) + 1, at: Date.now() });
}

async function sudoClearFails(userId: number): Promise<void> {
    const client = _sudoStore();
    if (client) {
        try { await client.del(_sudoRedisKey(userId)); } catch { /* the TTL expires it anyway */ }
    }
    _sudoFails.delete(userId);
}

function sudoBeginAttempt(key: string): boolean {
    const now = Date.now();
    let e = _sudoInflight.get(key);
    if (!e || (now - e.at) > SUDO_INFLIGHT_STALE_MS) e = { n: 0, at: now };
    if (e.n >= SUDO_INFLIGHT_MAX) { _sudoInflight.set(key, e); return false; }
    e.n++; e.at = now;
    _sudoInflight.set(key, e);
    return true;
}

function sudoEndAttempt(key: string): void {
    const e = _sudoInflight.get(key);
    if (!e) return;
    e.n = Math.max(0, e.n - 1);
    if (e.n === 0) _sudoInflight.delete(key); else _sudoInflight.set(key, e);
}

async function requireSudoPassword(req: Request, res: Response, currentPassword: any): Promise<boolean> {
    // The key comes from the RESOLVED session identity only. Nothing here is derived from a request
    // body, a query string or a header, which is what makes the bucket unreachable from outside.
    const userId = Number(req.user && req.user.id);
    const inflightKey = `${userId}|${require('../core/client-ip').clientIp(req)}`;

    if (!sudoBeginAttempt(inflightKey)) {
        // Transient by construction (slots are released in `finally`) and scoped to ONE source address,
        // so it can never become the account-wide refusal Class 2 exists to remove.
        res.status(429).json({ code: 'rest_login_throttled', message: 'Too many simultaneous attempts. Try again in a moment.', data: { status: 429 } });
        return true;
    }
    try {
        // Pay the cost BEFORE the check and INSIDE the slot: outside it, a burst would sleep in parallel
        // and the delay would bound latency instead of throughput.
        const wait = sudoDelayMs(await sudoFailCount(userId));
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        await User.authenticate(req.user.userLogin, String(currentPassword || ''));
        await sudoClearFails(userId);
        return false;
    } catch {
        await sudoRecordFail(userId);
        res.status(403).json({ code: 'rest_bad_current_password', message: 'Current password is incorrect.', data: { status: 403 } });
        return true;
    } finally {
        sudoEndAttempt(inflightKey);
    }
}

/**
 * Is this account effectively omnipotent, so that only an administrator may act on it?
 *
 * Not just the literal 'administrator' role: a custom role carrying the '*' wildcard or the
 * user/role/options-management caps is just as dangerous (audit MEDIUM). Extracted from PUT /:id so
 * every admin-tier operation on ANOTHER account applies the SAME rule — the inline copy was about to be
 * duplicated for the MFA reset below, which is exactly how a hardened surface and its forgotten twin
 * come about.
 */
function isPrivilegedTarget(user: any): boolean {
    return !!(user && user.getRole && (
        user.getRole() === 'administrator' ||
        (typeof user.can === 'function' && (
            user.can('*') || user.can('edit_users') || user.can('promote_users') ||
            user.can('manage_options') || user.can('manage_roles')
        ))
    ));
}

router.put('/me', asyncHandler(async (req: Request, res: Response) => {
    const { email, displayName, password, url, personalEmail, currentPassword } = req.body;

    if (rejectWeakSelfPassword(res, password)) return;

    // Optional personal/recovery email (coexists with the primary email; used for password recovery).
    // Validated on the NORMALIZED value — the one the write below stores (see personalEmailValue).
    if (personalEmailValue(personalEmail) && !isValidAddress(personalEmailValue(personalEmail))) {
        return res.status(400).json({ code: 'rest_invalid_personal_email', message: 'Personal email format is invalid.', data: { status: 400 } });
    }

    // SECURITY (self-grant of a corporate mailbox): this route is guarded by `authenticate` ONLY, and it
    // writes the PRIMARY email. Before this, any subscriber could set theirs to me@<mailDomain> — which
    // is the address an inbound message is matched against, and which used to imply the whole
    // professional-mailbox grant. A caller here never holds `edit_users` by construction (it is the
    // self-service profile route), so the self-service rule applies unconditionally. Same helper as
    // PUT /:id and /auth/register.
    const emailRefusal = await refuseSelfServiceEmailChange(req.user, email);
    if (emailRefusal) return res.status(403).json(emailRefusal);

    // Validate the primary email UP FRONT and return a uniform 400 for both a malformed address and one
    // already taken by another account. Previously User.update() threw 'Email already in use' surfaced as
    // a 500, which (unlike the anti-enumeration posture everywhere else) was an authenticated
    // account-existence oracle: a distinct 500 for a registered address vs 200 for a free one. The single
    // generic message here does not reveal WHY the address is unusable.
    if (email !== undefined && email !== null && String(email).trim() !== '') {
        const normalized = String(email).trim().toLowerCase();
        let usable = isValidAddress(normalized);
        if (usable) {
            const existing = await User.findByEmail(normalized);
            if (existing && existing.id !== req.user.id) usable = false;
        }
        if (!usable) {
            return res.status(400).json({ code: 'rest_invalid_email', message: "This email address can't be used.", data: { status: 400 } });
        }
    }

    // SINK CRITERION: 'nonblank' for both `email` and `password` (see ACCOUNT_SECURITY_FIELDS). The
    // password used to go through RAW, and `User.update` only skips a FALSY one — so `'   '` was truthy,
    // read as "not supplied" by the headless gate, and HASHED AND STORED by the sink. An administrator
    // API token could set any account's password to whitespace (a credential the attacker knows and the
    // owner does not), and `[]` reached bcrypt and came back as an unmapped 500. One normalizer, so the
    // value the gate judged is the value that is written.
    const updateData: any = { email: suppliedText(email), displayName, password: suppliedText(password), url };
    // SINK CRITERION: 'presence' (see ACCOUNT_SECURITY_FIELDS) — supplying the field at all is a write,
    // and a blank one is how the address is CLEARED. The VALUE goes through the one normalizer, so what
    // is stored for null/'' is '' and never the string "null".
    if (personalEmail !== undefined) updateData.meta = { personal_email: personalEmailValue(personalEmail) };
    // NOTE: `professionalMailbox` is deliberately NOT read from the body here. It is the admin-owned
    // grant; a self-service route must never be able to set it. User.update() only acts on the explicit
    // field, and MAILBOX_META_KEY is in its PROTECTED_META list, so the `meta` bag above cannot reach it
    // either.

    // SUDO, LAST GATE BEFORE THE WRITE — password OR either recovery address. Placed here, after the
    // format/uniqueness/mail-domain refusals, so a request that was going to be rejected anyway never
    // spends an attempt in the sudo throttle, and so the answer for a bad address does not depend on
    // whether the caller knew the password.
    const recoveryChanged = await selfRecoveryAddressChanged(req.user, req.body);
    // Judged on the SAME normalized value the sink stores (suppliedText): a whitespace-only password is
    // not a credential change, so it must not demand a sudo proof for a write that will not happen.
    if ((suppliedText(password) || recoveryChanged) && await requireSudoPassword(req, res, currentPassword)) return;

    const updated = await User.update(req.user.id, updateData);
    // A changed recovery address invalidates any reset link already in flight to the old one.
    if (recoveryChanged) await invalidatePendingPasswordReset(req.user.id);
    res.json(updated.toJSON());
}));

/**
 * POST /users/me/sessions/revoke — "sign me out everywhere", the standalone session cut-off.
 *
 * The documented recovery step for a leaked machine token is "revoke it" (DELETE /auth/tokens/:id). On a
 * site UPGRADED into the headless/session split, that is not enough: `issueSessionCookie` stops a token
 * from being traded for a session from now on, but a 7-day cookie minted from that token BEFORE the
 * upgrade is still live, and single-token revocation deliberately does not stamp the JWT epoch (rotating
 * a CI token must not sign the owner out of their browsers). The only thing that reached those sessions
 * was changing the password — a heavier action, with its own consequences, that an operator should not be
 * forced into. This is the missing primitive: end every session of MY account, leave my API tokens alone.
 *
 * Gates: the router-wide headless refusal (a leaked token must never be able to knock the owner out of
 * their browsers — every POST in this router is account security by default) and
 * the same throttled sudo re-auth as every other "state the owner cannot undo" door. It signs out the
 * CALLING session too — that is what "everywhere" means; the client must send the user back to login.
 *
 * Declared before '/:id' so the literal path is never captured by the parameterised route.
 */
router.post('/me/sessions/revoke', asyncHandler(async (req: Request, res: Response) => {
    if (await requireSudoPassword(req, res, (req.body || {}).currentPassword)) return;
    // ONE implementation of the epoch stamp, shared with both token-revocation doors.
    await require('../models/ApiToken').stampSecurityEpoch(req.user.id);
    await recordAudit(req.user.id, 'user.sessions_revoked', 'user', req.user.id, {});
    res.json({ signedOut: true });
}));

router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
    const userId = parseInt(String(req.params.id), 10);
    const user = await User.findById(userId);

    if (!user) {
        return res.status(404).json({
            code: 'rest_user_invalid_id',
            message: 'Invalid user ID.',
            data: { status: 404 }
        });
    }

    // Users can edit themselves, admins can edit anyone
    const isOwn = req.user.id === userId;
    if (!isOwn && !req.user.can('edit_users')) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You cannot edit this user.',
            data: { status: 403 }
        });
    }

    // SECURITY (privilege hierarchy / account takeover): editing ANOTHER user mutates their email +
    // password below. `edit_users` is a delegable capability, so without this a non-administrator could
    // reset a privileged user's password/email and seize the account. See isPrivilegedTarget. (AUTH-1)
    if (!isOwn && isPrivilegedTarget(user) && req.user.getRole() !== 'administrator') {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'Only an administrator can edit a privileged account.',
            data: { status: 403 }
        });
    }

    const { email, displayName, password, url } = req.body;
    // SINK CRITERION: 'nonblank' (see ACCOUNT_SECURITY_FIELDS). Normalized ONCE, here, so the role guard
    // chain below reads the same value the headless gate judged: a whitespace-only role used to pass the
    // gate as "not supplied" and then reach the allow-list check as a real role change, answering 400
    // rest_invalid_role. Fail-closed, so it was availability rather than a hole — but it is the same
    // guard-vs-sink drift, and one normalizer removes the whole shape rather than this instance of it.
    let role = suppliedText(req.body.role);
    const personalEmail = req.body.personalEmail;

    // SECURITY: this route ALSO serves SELF-edits (isOwn skips the edit_users gate above), and it reaches
    // the same password AND recovery-address sinks as PUT /me. The sudo re-auth was on /me but not on this
    // self-edit sibling, so a hijacked session / same-origin XSS could silently reset the victim's password
    // via /users/:ownId and take the account over persistently. An `edit_users` delegate acting on ANOTHER
    // user is unaffected (isOwn is false → admin edit, as before, with its own capability gates).
    // The sudo call itself is the last gate before the write, below — same shape as PUT /me.
    if (isOwn && rejectWeakSelfPassword(res, password)) return;

    // SINK CRITERION: 'nonblank' for both `email` and `password` (see ACCOUNT_SECURITY_FIELDS). The
    // password used to go through RAW, and `User.update` only skips a FALSY one — so `'   '` was truthy,
    // read as "not supplied" by the headless gate, and HASHED AND STORED by the sink. An administrator
    // API token could set any account's password to whitespace (a credential the attacker knows and the
    // owner does not), and `[]` reached bcrypt and came back as an unmapped 500. One normalizer, so the
    // value the gate judged is the value that is written.
    const updateData: any = { email: suppliedText(email), displayName, password: suppliedText(password), url };

    // Uniform 400 for a malformed or already-taken primary email (target = the account being edited),
    // instead of the model's 500 'Email already in use'. Same anti-enumeration reasoning as PUT /me: a
    // distinct 500-vs-200 was an authenticated account-existence oracle. One generic message, no reason leak.
    if (email !== undefined && email !== null && String(email).trim() !== '') {
        const normalized = String(email).trim().toLowerCase();
        let usable = isValidAddress(normalized);
        if (usable) {
            const existing = await User.findByEmail(normalized);
            if (existing && existing.id !== userId) usable = false;
        }
        if (!usable) {
            return res.status(400).json({ code: 'rest_invalid_email', message: "This email address can't be used.", data: { status: 400 } });
        }
    }

    // SECURITY (ACTIVE CORPORATE MAILBOX). This route also serves SELF-edits — `isOwn` skips the
    // `edit_users` check above — so both the grant and the address it names must be re-gated on the
    // capability, not on ownership.
    //
    //  - The grant itself is admin-owned state: writing it requires `edit_users`, whoever the target is.
    //    Without this, a user editing their OWN record would set their own mailbox flag, which is the
    //    self-grant this whole change removes, just through a different door.
    //  - A caller WITHOUT `edit_users` (i.e. a self-edit) is held to the same email rule as
    //    PUT /me — one helper, so the two self-service doors cannot drift apart. An `edit_users`
    //    delegate is unaffected: assigning corporate addresses is precisely their job.
    const canEditUsers = typeof req.user.can === 'function' && req.user.can('edit_users');
    // NO-OP RESEND IS NOT A WRITE. The admin user editor loads `professionalMailbox` into its form state
    // and PUTs the whole object back, so a plain "save my display name" from a non-`edit_users` user
    // carries the field unchanged — rejecting on PRESENCE 403'd every one of those legitimate saves. The
    // `role` field a few lines below is stripped for exactly this reason, and refuseSelfServiceEmailChange
    // does the same for `email`; this one was missed. Compare the VALUE and only treat a real change as a
    // privileged write. (Fail-closed either way, so this was availability, not a hole.)
    // SINK CRITERION: 'presence' (see ACCOUNT_SECURITY_FIELDS). `mailboxFlagValue` maps '' and null to
    // '0', so a blank value here is a REVOCATION of the grant, not "left alone" — which is why the
    // headless gate judges this field by presence and not by blankness.
    const mailboxRequested = req.body.professionalMailbox !== undefined
        && mailboxFlagValue(req.body.professionalMailbox) !== mailboxFlagValue(hasProfessionalMailbox(user));
    if (mailboxRequested) {
        if (!canEditUsers) {
            return res.status(403).json({
                code: 'rest_forbidden',
                message: 'Only a user manager can enable or disable a professional mail account.',
                data: { status: 403 }
            });
        }
        updateData.professionalMailbox = req.body.professionalMailbox;
    }
    if (!canEditUsers) {
        const emailRefusal = await refuseSelfServiceEmailChange(user, email);
        if (emailRefusal) return res.status(403).json(emailRefusal);
    }

    // Optional personal/recovery email (coexists with the primary/professional email). Stored as meta;
    // update() forwards updateData.meta.personal_email via updateMeta.
    // SINK CRITERION: 'presence' (see ACCOUNT_SECURITY_FIELDS) — this `!== undefined` is precisely what
    // the headless gate now judges this field by, and the value goes through the one normalizer.
    if (personalEmail !== undefined) {
        const normalized = personalEmailValue(personalEmail);
        if (normalized && !isValidAddress(normalized)) {
            return res.status(400).json({ code: 'rest_invalid_personal_email', message: 'Personal email format is invalid.', data: { status: 400 } });
        }
        updateData.meta = { personal_email: normalized };
    }

    // SECURITY: role changes.
    //  - WordPress forbids editing your OWN role regardless of capability (otherwise a user holding the
    //    delegable `promote_users` cap could self-promote to administrator). Only apply role when this
    //    is NOT a self-edit AND the caller holds promote_users.
    //  - Validate the requested role against the known roles allow-list (no mass-assignment of a bogus
    //    or non-existent role).
    //  - Promoting someone to `administrator` is reserved for callers who are already administrators.
    //  - The user form ALWAYS resends the target's CURRENT role, even when the caller never touched it.
    //    Resending an unchanged role is a NO-OP, not a role change, so strip it here for EVERY edit —
    //    otherwise the guards below 403 legitimate saves: a self-edit hit "cannot change your own role"
    //    (blocking the admin from saving their own profile at all), and an edit_users delegate WITHOUT
    //    promote_users hit "not allowed to change user roles" when merely editing someone's display name.
    //    A genuinely CHANGED role still runs the full guard chain.
    if (role && user.getRole && role === user.getRole()) {
        role = undefined;
    }
    if (role !== undefined && role !== null && role !== '') {
        if (isOwn) {
            return res.status(403).json({
                code: 'rest_cannot_edit_own_role',
                message: 'You cannot change your own role.',
                data: { status: 403 }
            });
        }
        if (!req.user.can('promote_users')) {
            return res.status(403).json({
                code: 'rest_forbidden',
                message: 'You are not allowed to change user roles.',
                data: { status: 403 }
            });
        }
        const roles = getRoles() || {};
        if (!Object.prototype.hasOwnProperty.call(roles, role)) {
            return res.status(400).json({
                code: 'rest_invalid_role',
                message: 'Invalid role.',
                data: { status: 400 }
            });
        }
        if (role === 'administrator' && req.user.getRole() !== 'administrator') {
            return res.status(403).json({
                code: 'rest_forbidden',
                message: 'Only an administrator can assign the administrator role.',
                data: { status: 403 }
            });
        }
        // SECURITY (privilege amplification / AUTH-A1): guarding only the LITERAL 'administrator' role
        // string is insufficient — an admin can create a CUSTOM role whose capabilities include '*'
        // (all-caps) or admin-tier caps the delegate lacks. A non-administrator promote_users delegate
        // assigning such a role would mint a fully-privileged account without ever holding admin. So,
        // unless the caller is an administrator, refuse to assign any role that grants MORE than the
        // caller themselves holds: reject '*' (omnipotent) and reject any capability the caller does
        // not have. (Administrators are unrestricted; legit assignment of lesser roles still works.)
        if (req.user.getRole() !== 'administrator') {
            const targetCaps: string[] = (roles[role] && roles[role].capabilities) || [];
            const callerCaps: string[] = (req.user.getCapabilities && req.user.getCapabilities()) || [];
            const callerHasAll = callerCaps.includes('*');
            const grantsWildcard = targetCaps.includes('*');
            const amplifies = grantsWildcard || (!callerHasAll && targetCaps.some((c) => !callerCaps.includes(c)));
            if (amplifies) {
                return res.status(403).json({
                    code: 'rest_forbidden',
                    message: 'You cannot assign a role with capabilities beyond your own.',
                    data: { status: 403 }
                });
            }
        }
        updateData.role = role;
    }

    // Capture the pre-update role so a role change can be audited with from→to (before User.update
    // mutates the meta the cached user reads). Only a genuine change reaches here (an unchanged role was
    // stripped to undefined above), so updateData.role is present ONLY for a real role change.
    const previousRole = (user.getRole && user.getRole()) || undefined;

    // SUDO for a SELF edit — the twin of the gate in PUT /me, in the same position (last, just before the
    // write) and driven by the same helper, so the two self-service doors cannot drift again. Only a real
    // change to a recovery-bearing field (or a new password) demands it; an admin editing SOMEONE ELSE is
    // untouched, because that path is gated on capabilities, not on proving personal ownership.
    const selfRecoveryChanged = isOwn && await selfRecoveryAddressChanged(user, req.body);
    // Same normalization as the sink a few lines up — see PUT /me.
    if (isOwn && (suppliedText(password) || selfRecoveryChanged) && await requireSudoPassword(req, res, req.body.currentPassword)) return;

    const updated = await User.update(userId, updateData);
    if (selfRecoveryChanged) await invalidatePendingPasswordReset(userId);

    // AUDIT: exactly one row per security-relevant change — a role change. No secret material.
    if (updateData.role !== undefined) {
        await recordAudit(req.user.id, 'user.role_change', 'user', userId, { from: previousRole, to: updateData.role });
    }
    res.json(updated.toJSON());
}));

/**
 * POST /users/:id/mfa/reset — administrative two-factor reset (the way OUT of a 2FA lockout).
 *
 * Enrollment is a state a user can be pushed into by whoever holds their session, and until now the only
 * exits were the victim's own /auth/mfa/disable (which needs a code they no longer have) or deleting and
 * recreating the account — losing every row that references the user id. This is the escape hatch: a user
 * manager clears the target's mfa_* meta so they can log in with their password again and re-enroll.
 *
 * The gates, and why each one is there:
 *   • `edit_users` — this is account administration, not self-service.
 *   • the router-wide headless refusal — same rule as /auth/mfa/*: a leaked headless token must never
 *     be able to strip a second factor. Applied to the whole router, not pinned to this route.
 *   • isPrivilegedTarget — `edit_users` is delegable, so without it a delegate could disarm an
 *     administrator's 2FA and then attack their password offline/online. Same rule as PUT /:id.
 *   • NOT self: an admin disabling their OWN 2FA must still go through /auth/mfa/disable, which demands a
 *     current TOTP or backup code. Allowing self here would hand a hijacked admin session exactly the
 *     "turn the second factor off with only a cookie" power that route deliberately refuses. A sole
 *     administrator who loses their authenticator therefore still needs another admin — that residual is
 *     inherent to being the only account with the keys.
 */
router.post('/:id/mfa/reset', can('edit_users'), asyncHandler(async (req: Request, res: Response) => {
    const userId = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid user ID.', data: { status: 400 } });
    }
    const user = await User.findById(userId);
    if (!user) {
        return res.status(404).json({ code: 'rest_user_invalid_id', message: 'Invalid user ID.', data: { status: 404 } });
    }
    if (req.user.id === userId) {
        return res.status(400).json({
            code: 'rest_cannot_reset_own_mfa',
            message: 'Use two-factor disable with a current code to turn off your own 2FA.',
            data: { status: 400 }
        });
    }
    if (isPrivilegedTarget(user) && req.user.getRole() !== 'administrator') {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'Only an administrator can reset two-factor authentication on a privileged account.',
            data: { status: 403 }
        });
    }

    // disable() deletes EVERY mfa_* key (secret, pending secret, backup-code hashes, enabled flag and the
    // anti-replay counter), so the account is left exactly as if it had never enrolled.
    await require('../core/mfa').disable(userId);
    // AUDIT: who removed whose second factor. No secret material.
    await recordAudit(req.user.id, 'user.mfa_reset', 'user', userId, { username: user.userLogin, role: user.getRole && user.getRole() });
    res.json({ reset: true, id: userId });
}));

/**
 * @swagger
 * /users/{id}:
 *   delete:
 *     summary: Delete a user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: User deleted
 *       400:
 *         description: Cannot delete self
 *       403:
 *         description: Forbidden
 *       404:
 *         description: User not found
 */
router.delete('/:id', isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const userId = parseInt(String(req.params.id), 10);
    const user = await User.findById(userId);

    if (!user) {
        return res.status(404).json({
            code: 'rest_user_invalid_id',
            message: 'Invalid user ID.',
            data: { status: 404 }
        });
    }

    // Prevent deleting yourself
    if (req.user.id === userId) {
        return res.status(400).json({
            code: 'rest_user_cannot_delete',
            message: 'You cannot delete yourself.',
            data: { status: 400 }
        });
    }

    await User.delete(userId);
    // AUDIT: admin deleted a user. Record who + the deleted account's login/role (no secret material).
    await recordAudit(req.user.id, 'user.delete', 'user', userId, { username: user.userLogin, role: user.getRole && user.getRole() });
    res.json({ deleted: true, previous: user.toJSON() });
}));

module.exports = router;
// Exposed so the OTHER surfaces that must not be reachable on an ambient cookie alone (MFA enrollment in
// routes/auth.ts) run the SAME throttled sudo check instead of re-implementing it — the drift this repo
// keeps paying for. Assigned after the export, exactly like routes/auth.ts does with its lockout helpers.
module.exports.requireSudoPassword = requireSudoPassword;
// The sudo delay POLICY, exported so a test can assert the property that matters — that for EVERY
// failure count it returns a finite, bounded wait and can never mean "refused" — across the whole
// domain instead of the handful of counts a route-driven test could afford to reach.
module.exports.sudoDelayMs = sudoDelayMs;
// THE POPULATION OF THE HEADLESS-EXEMPTION CLASS, exported so its gate can DERIVE the members instead of
// carrying a hand-written copy that goes stale the moment a field is added. The gate drives one request
// per (field × blank-ish value) and demands "refused, or nothing changed" — an assertion that holds
// whatever criterion a future field declares, so adding a row here without teaching the router is red.
module.exports.ACCOUNT_SECURITY_FIELDS = ACCOUNT_SECURITY_FIELDS;
module.exports.fieldIsSupplied = fieldIsSupplied;
module.exports.personalEmailValue = personalEmailValue;
