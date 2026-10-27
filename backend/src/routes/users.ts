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
// THE SECOND DOCTRINE, enforced the same way: a session started at a secondary address (an alias, an IP,
// a tunnel name) may write only its OWN account here — refuseBoundSessionOnOthers below, for every route.
const { authenticate, sessionOnly, refuseBoundSession } = require('../middleware/auth');
const { can, isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { getRoles } = require('../core/roles');
// The one self-service email-write rule (core/email-address) and the plugin-declared per-account grants
// only an `edit_users` caller may change (core/account-capabilities).
const { refuseSelfServiceEmailChange, isValidAddress } = require('../core/email-address');
const accountCapabilities = require('../core/account-capabilities');
// DEPRECATED: an outdated mail plugin's toggle field, folded into the same plan (core/legacy-account-flags.ts).
const { withLegacyBodyField, LEGACY_BODY_FIELD } = require('../core/legacy-account-flags');
const { recordAudit } = require('../core/audit');
const { protectsNetworkAdmin, refuseNetworkAdminTarget } = require('../core/network-auth');
const networkHandoff = require('../core/network-handoff');
// THE SCALAR QUERY RULE — see core/query-params.
const { requireScalarQuery, requireRouteId, routeIdOrNull, scalarQueryParam } = require('../core/query-params');
const { perPageParam, pageOffset } = require('../core/pagination');

// THE ROUTE-ID CONTRACT — see core/query-params. `:id` is a user id: `/users/abc` reached
// User.findById as NaN and was bound into `WHERE id = ?` — a 500 on Postgres/MySQL on read, edit and
// delete alike. Declared for the router in the same spirit as refuseHeadlessAccountSecurity below:
// a route added later inherits the contract instead of having to remember it. `/:id/mfa/reset` keeps
// its own explicit guard — that guard is now unreachable for a malformed id, which is the point.
router.param('id', requireRouteId({ code: 'rest_user_invalid_id', message: 'Invalid user ID.' }));

/**
 * Every query parameter GET /users reads, each a scalar in this API's contract. `order` is the one
 * that crashed: `?order=asc&order=desc` is an Array, an Array has no `.toLowerCase`, and the
 * TypeError surfaced as a 500 to any caller who could list users.
 */
const USER_LIST_QUERY_FIELDS: readonly string[] = Object.freeze([
    'page', 'per_page', 'search', 'role', 'exclude_role', 'orderby', 'order',
]);

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
//     users.ts (PUT /:id)  `req.body.accountCapabilities !== undefined` → planAccountCapabilityWrite
//                          (core/account-capabilities flagValue maps '' and null to '0' — a REVOCATION)
//
// So `{personalEmail: ''}` and `{accountCapabilities: {x: null}}` read as "not supplied" to the gate and as
// "write this" to the sink: an administrator's `wjt_` token could blank ANY account's recovery address
// (moving the reset link to the primary mailbox, which on this product may be hosted here) and revoke
// per-account grants — the exact operation the doctrine at the top of this file says a token cannot drive.
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
    accountCapabilities: 'presence', // the admin-owned per-account grants; blank/null = flagValue '0' = revoke
    [LEGACY_BODY_FIELD]: 'presence', // DEPRECATED alias of one of them, written by an outdated plugin's toggle
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

// ─── THE BOUND-SESSION DOCTRINE, ENFORCED ONCE FOR THE WHOLE ROUTER ───────────────────────────────
//
// A session started at a secondary address is bound to it and ends when the address is retired; an
// account it creates, or another account it re-credentials, would outlive that (middleware/auth.ts
// refuseBoundSession). It used to be asked route by route — POST / and PUT /:id asked, DELETE /:id and
// POST /:id/mfa/reset did not (lab findings M-23, N3) — the very drift the headless gate above was
// inverted to end. So it is inverted the same way: EVERY write in this router is refused to a bound
// session by default, a route added later inherits that, and the one exemption is a predicate over the
// target — the request names the caller's own account.

/**
 * Does this request name the caller's OWN account — `/me…`, or `/:id…` with the caller's id?
 *
 * Judged on the path this router receives, as the router will route it: case-insensitive like Express,
 * repeated separators collapsed. Only a plain id (the route-id contract, core/query-params) can match, so
 * an encoded or padded spelling that the router would decode into SOMEONE ELSE'S id is never "own" — the
 * failure mode is a refusal, never a pass.
 */
function targetsOwnAccount(req: Request): boolean {
    const first = String(req.path || '').toLowerCase().split('/').filter(Boolean)[0];
    if (first === 'me') return true;
    const id = routeIdOrNull(first);
    return id !== null && !!req.user && id === req.user.id;
}

function refuseBoundSessionOnOthers(req: Request, res: Response, next: NextFunction) {
    const method = String(req.method || '').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    if (targetsOwnAccount(req)) return next();
    if (refuseBoundSession(req, res)) return;
    next();
}

// `authenticate` is mounted here for the WHOLE router (every route below needs it), so the gates that
// follow can read the marks `authenticate` sets (headless, and the address a session is bound to).
// Individual routes therefore no longer repeat it — repeating it would authenticate twice per request.
router.use(authenticate, refuseHeadlessAccountSecurity, refuseBoundSessionOnOthers);


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
 *         description: Only users holding this role. A user with no stored role counts as a subscriber.
 *         schema:
 *           type: string
 *       - in: query
 *         name: exclude_role
 *         description: Leave out users holding this role (the admin's Team list asks for exclude_role=subscriber).
 *         schema:
 *           type: string
 *       - in: query
 *         name: orderby
 *         schema:
 *           type: string
 *           enum: [id, user_login, display_name, user_email, user_registered]
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *     responses:
 *       200:
 *         description: A list of users
 *         headers:
 *           X-WP-Total:
 *             schema:
 *               type: integer
 *           X-WP-TotalPages:
 *             schema:
 *               type: integer
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
 *       400:
 *         description: >-
 *           rest_invalid_param — a scalar query parameter was repeated or bracketed (e.g.
 *           ?order=asc&order=desc). The offending parameter is named in data.params.
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
 *         description: "rest_forbidden (the list_users capability is missing) or mfa_enrollment_required."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.get('/', can('list_users'), asyncHandler(async (req: Request, res: Response) => {
    // Refuse a repeated scalar before anything reads it — this is what turns the `?order=asc&
    // order=desc` 500 below into a 400 that names the parameter.
    requireScalarQuery(req.query, USER_LIST_QUERY_FIELDS);

    const {
        page = 1,
        per_page = 10,
        search,
        role,
        exclude_role: excludeRole,
        orderby = 'id',
        order = 'asc'
    } = req.query;

    // `parseInt` stringifies its argument before parsing, so `String(...)` here is the coercion the
    // untyped call already performed implicitly — a repeated `?per_page=5&per_page=7` still parses
    // "5,7" to 5, and a bracketed one still parses "[object Object]" to NaN and takes the default.
    const limit = perPageParam(per_page, 10);
    const offset = pageOffset(page, limit);

    // SECURITY: Whitelist allowed orderBy columns to prevent SQL injection
    const allowedOrderBy = ['id', 'user_login', 'display_name', 'user_email', 'user_registered'];
    // A query value is not necessarily a string: `?orderby=a&orderby=b` parses to an array. The
    // whitelist compares with ===, so a non-string has never matched an entry and has always fallen
    // through to 'id' — collapsing it to '' reproduces that outcome for every input.
    const requestedOrderBy = typeof orderby === 'string' ? orderby : '';
    const safeOrderBy = allowedOrderBy.includes(requestedOrderBy) ? requestedOrderBy : 'id';
    // `order` is ASSERTED rather than narrowed, and the assertion is now TRUE: requireScalarQuery at
    // the top of the handler refused every non-string shape before this line could be reached. It used
    // to be a lie — a repeated `?order=asc&order=desc` parsed to an array whose missing `.toLowerCase`
    // threw a TypeError and surfaced as a 500. Collapsing the array to '' instead would have answered
    // 200 sorted ASC for a request that asked for two different sorts; the caller is told instead.
    const requestedOrder = order as string;
    const safeOrder = ['asc', 'desc'].includes(requestedOrder.toLowerCase()) ? requestedOrder.toUpperCase() : 'ASC';

    const users = await User.findAll({
        search,
        role,
        excludeRole,
        limit,
        offset,
        orderBy: safeOrderBy,
        order: safeOrder
    });

    const total = await User.count({ search, role, excludeRole });
    const totalPages = Math.ceil(total / limit);

    res.set('X-WP-Total', total);
    res.set('X-WP-TotalPages', totalPages as any);

    res.json(users.map((user: any) => user.toJSON()));
}));

/**
 * GET /users/me
 * Get current user
 */
/**
 * @swagger
 * /users/me:
 *   get:
 *     summary: Get the authenticated user
 *     description: >-
 *       Declared before /users/{id} so the literal path is never captured by the parameterised route.
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The current user
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: "mfa_enrollment_required — the caller's role requires 2FA and the grace window has expired."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.get('/me', (req: Request, res: Response) => {
    res.json(req.user.toJSON());
});

/**
 * @swagger
 * /users/account-capabilities:
 *   get:
 *     summary: The per-account capabilities active plugins declare
 *     description: >-
 *       What the user screen renders as one toggle each. A plugin declares them in its manifest
 *       (`accountCapabilities`); an administrator grants them per account through POST /users and
 *       PUT /users/{id} (`accountCapabilities`, a map of slug → true/false), which requires edit_users.
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The declarations of the active plugins.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   slug:
 *                     type: string
 *                   plugin:
 *                     type: string
 *                   name:
 *                     type: string
 *                   description:
 *                     type: string
 *                   locksEmail:
 *                     type: boolean
 *                   defaultForNewAccounts:
 *                     type: boolean
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: "rest_forbidden — the edit_users capability is missing."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.get('/account-capabilities', can('edit_users'), asyncHandler(async (_req: Request, res: Response) => {
    res.json(await accountCapabilities.activeDeclarations());
}));

/**
 * GET /users/:id
 * Get single user
 */
/**
 * @swagger
 * /users/{id}:
 *   get:
 *     summary: Get one user
 *     description: A user may always read their own record; reading anyone else's needs the list_users capability.
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
 *         description: The user
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: "mfa_enrollment_required."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       404:
 *         description: >-
 *           rest_user_invalid_id — no such user, a user that is not you while you lack list_users (the same
 *           answer, so it cannot tell the two apart), or the id is not a well-formed route id (the router-level
 *           route-id contract answers 404 for a malformed id rather than letting NaN reach the database).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    // `String(...)` is the coercion `parseInt` already applied to this argument implicitly; it is here
    // only because a route param is typed `string | string[]`, and it parses identically either way.
    const userId = parseInt(String(req.params.id), 10);

    // Users can view themselves, admins can view anyone. Asked BEFORE the lookup, and answered with the
    // SAME 404 as a missing id: a 403 for "exists, not yours" next to a 404 for "no such id" told any
    // signed-in account which user ids exist.
    if (req.user.id !== userId && !req.user.can('list_users')) {
        return res.status(404).json({
            code: 'rest_user_invalid_id',
            message: 'Invalid user ID.',
            data: { status: 404 }
        });
    }

    const user = await User.findById(userId);
    if (!user) {
        return res.status(404).json({
            code: 'rest_user_invalid_id',
            message: 'Invalid user ID.',
            data: { status: 404 }
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
*               displayName:
 *                 type: string
 *               role:
 *                 type: string
 *                 description: A slug from the live role map. Defaults to subscriber.
 *                 enum: [administrator, editor, author, contributor, subscriber]
 *               personalEmail:
 *                 type: string
 *                 description: Optional recovery address, preferred over the primary one when a reset link is sent.
 *               accountCapabilities:
 *                 type: object
 *                 additionalProperties:
 *                   type: boolean
 *                 description: >-
 *                   Plugin-declared per-account grants (GET /users/account-capabilities), slug → on/off.
 *                   Only settable here and on PUT /users/{id} by a caller holding edit_users; never self-service.
 *               currentPassword:
 *                 type: string
 *                 description: >-
 *                   The caller's own password. Required when the new account gets a privileged role
 *                   (administrator, or a role holding user, role or settings management); without it the
 *                   answer is 403 rest_sudo_required.
 *               mfaCode:
 *                 type: string
 *                 description: A current code, with currentPassword, when the caller has two-factor authentication (403 rest_mfa_step_up_required).
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: >-
 *           Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie. Required when the
 *           request is authenticated by the session cookie; Bearer/API-token callers are exempt from the
 *           token gate, but see the 403 below — this route refuses API tokens outright.
 *     responses:
 *       201:
 *         description: User created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: >-
 *           rest_missing_param (username/email/password absent), rest_invalid_param (malformed primary
 *           email, or a username outside letters/digits/. _ - or longer than 60 characters, or an
 *           account capability no active plugin declares), rest_invalid_personal_email, or rest_user_exists.
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
 *           rest_forbidden (not an administrator), rest_csrf_token / rest_csrf_invalid,
 *           mfa_enrollment_required, the headless refusal — every POST in this router is an
 *           account-security operation, so a `wjt_` API token may not create accounts — or
 *           rest_account_bound_session (a session started at an address other than the main one).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
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

    if (rejectWeakPassword(res, password)) return;
    const shownName = displayNameOrRefuse(res, displayName);
    if (!shownName) return;

    // The username rule (models/User.ts) — User.create enforces it too; checked here for a clean 400.
    const usernameProblem = User.usernameError(username);
    if (usernameProblem) {
        return res.status(400).json({ code: 'rest_invalid_param', message: usernameProblem, data: { status: 400 } });
    }

    // The PRIMARY email must be a real address. User.create enforces the same rule (it is the model-level
    // backstop for the importers and self-registration), but reaching it here would surface as a raw 500;
    // answer the API's own 400 shape instead. One rule, expressed once — EMAIL_FORMAT_RE from core/email-address.
    if (!isValidAddress(email)) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid email format.', data: { status: 400 } });
    }

    // Optional personal/recovery email (coexists with the primary email; used for password recovery).
    if (personalEmail && !isValidAddress(personalEmail)) {
        return res.status(400).json({ code: 'rest_invalid_personal_email', message: 'Personal email format is invalid.', data: { status: 400 } });
    }

    // Plugin-declared per-account grants (core/account-capabilities). Safe to apply: this route is `isAdmin`.
    const capPlan = await accountCapabilities.planAccountCapabilityWrite(null, withLegacyBodyField(req.body));
    if (capPlan.error) return res.status(400).json(capPlan.error);

    // A new privileged account is authority handed out: the creator proves it is really them first.
    if (isPrivilegedRole(role) && await requireAccountStepUp(req, res)) return;

    try {
        const user = await User.create({
            username,
            email,
            password,
            displayName: shownName.value,
            role,
            personalEmail,
            // The user form's plugin toggles. Safe to forward: this route is `isAdmin`, so the caller is by
            // definition allowed to grant them. Self-registration (POST /auth/register) never reaches here.
            accountCapabilityChanges: capPlan.changes
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
 *               email:
 *                 type: string
 *               displayName:
 *                 type: string
 *               url:
 *                 type: string
 *               password:
 *                 type: string
 *                 minLength: 8
 *               currentPassword:
 *                 type: string
 *                 description: >-
 *                   Sudo re-auth. Required for a SELF edit that changes the password or a recovery-bearing
 *                   address, and for an edit of SOMEONE ELSE that changes a privileged account's password or
 *                   address, or moves an account into a privileged role (403 rest_sudo_required without it).
 *               mfaCode:
 *                 type: string
 *                 description: With currentPassword on an edit of someone else, a current code when the caller has two-factor authentication.
 *               role:
 *                 type: string
 *                 description: >-
 *                   Resending the target's CURRENT role is a no-op. A real change needs promote_users,
 *                   is refused on your own account, and may never grant capabilities beyond the caller's.
 *               personalEmail:
 *                 type: string
 *                 description: Recovery address. Supplying it blank CLEARS it — presence, not blankness, is the write.
 *               accountCapabilities:
 *                 type: object
 *                 additionalProperties:
 *                   type: boolean
 *                 description: >-
 *                   Plugin-declared per-account grants, slug → on/off. Changing one requires edit_users whoever
 *                   the target is; resending the current state is a no-op.
 *     responses:
 *       200:
 *         description: User updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: >-
 *           rest_weak_password (a new password under 8 characters), rest_invalid_email (malformed or already
 *           taken — one uniform message, so this is never an account-existence oracle),
 *           rest_invalid_personal_email, rest_invalid_role, or rest_invalid_param (an account capability
 *           change no active plugin declares).
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
 *           rest_forbidden (not you and no edit_users; a non-administrator editing a privileged account;
 *           changing an account capability without edit_users; assigning a role you may not grant),
 *           rest_cannot_edit_own_role, rest_bad_current_password (the sudo re-auth failed),
 *           rest_reserved_mail_domain / rest_mailbox_address_locked (a self-service caller claiming an
 *           address on the site's own email domain, or moving an address a granted capability binds),
 *           rest_csrf_token / rest_csrf_invalid,
 *           mfa_enrollment_required, the headless refusal when the body carries an account-security
 *           field (password, currentPassword, email, personalEmail, role, accountCapabilities) — a
 *           cosmetic-only PUT is still allowed on an API token — or rest_account_bound_session (another
 *           user's account, from a session started at an address other than the main one).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       404:
 *         description: "rest_user_invalid_id — no such user, or a malformed route id."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: "rest_login_throttled — too many simultaneous sudo re-auth attempts from this address."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
/**
 * @swagger
 * /users/me:
*   put:
 *     summary: Update current user profile
 *     description: >-
 *       Self-service only. The role and the account-capability grants are deliberately NOT read here —
 *       they are admin-owned and can only be written through PUT /users/{id} by a caller with the right
 *       capability.
 *     tags: [Users]
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
 *               email:
 *                 type: string
 *               displayName:
 *                 type: string
 *               url:
 *                 type: string
 *               password:
 *                 type: string
 *                 minLength: 8
 *               currentPassword:
 *                 type: string
 *                 description: >-
 *                   Sudo re-auth, required when the request changes the password or either recovery
 *                   address. Checked LAST, after the format and uniqueness refusals.
 *               personalEmail:
 *                 type: string
 *                 description: Recovery address. Supplying it blank CLEARS it.
 *     responses:
 *       200:
 *         description: Profile updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: >-
 *           rest_weak_password (under 8 characters), rest_invalid_email (malformed or already taken — one
 *           uniform message) or rest_invalid_personal_email.
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
 *           rest_bad_current_password (the sudo re-auth failed), rest_reserved_mail_domain /
 *           rest_mailbox_address_locked (the requested primary address is on the site's own email
 *           domain, or a granted capability binds the current one), rest_csrf_token / rest_csrf_invalid,
 *           mfa_enrollment_required, or the headless
 *           refusal when the body carries an account-security field.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: "rest_login_throttled — too many simultaneous sudo re-auth attempts from this address."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
// NOTE: must be declared BEFORE '/:id' — Express matches in order and '/:id' would otherwise
// capture the literal path 'me' (parseInt('me') → NaN → "Invalid user ID"). Mirrors GET /me / GET /:id.
// PRECONDITION for every password this router writes — self edit, an administrator's edit of another
// account and account creation: a new password must be long enough. (The admin paths used to accept «abc».) The sudo
// re-auth itself is no longer chained here — it is decided per TOUCHED FIELD by selfEditNeedsSudo below
// and applied ONCE, just before the write, by both self-service doors. Returns true if it already sent a
// response (caller must return), false to proceed.
/**
 * THE DISPLAY NAME, as every write of it stores it: text (anything else is a 400 — an object or an array
 * reached the database as "[object Object]"), without markup (tags removed by the HTML parser, never by a
 * pattern), whitespace trimmed and at most DISPLAY_NAME_MAX characters. undefined/null = not supplied.
 * Answers a 400 itself and returns undefined when the value is unusable; otherwise `{ value }`.
 */
const DISPLAY_NAME_MAX = 250;
function displayNameOrRefuse(res: Response, raw: any): { value: string | undefined } | undefined {
    if (raw === undefined || raw === null) return { value: undefined };
    if (typeof raw !== 'string') {
        res.status(400).json({ code: 'rest_invalid_param', message: 'displayName must be text.', data: { status: 400, params: ['displayName'] } });
        return undefined;
    }
    // The parser drops every tag and escapes what is left; the escapes are turned back into the characters
    // a name may contain, except the angle brackets, which a display name never needs.
    const text = String(require('../core/formatting').stripTags(raw) || '')
        .split('&lt;').join('').split('&gt;').join('')
        .split('&quot;').join('"').split('&#39;').join("'").split('&amp;').join('&')
        .replace(/\s+/g, ' ').trim();
    if (text.length > DISPLAY_NAME_MAX) {
        res.status(400).json({ code: 'rest_invalid_param', message: `displayName must be at most ${DISPLAY_NAME_MAX} characters.`, data: { status: 400, params: ['displayName'] } });
        return undefined;
    }
    return { value: text || undefined };
}

function rejectWeakPassword(res: Response, password: any): boolean {
    // A blank one (absent, empty, whitespace) is "not supplied": the sink skips it (ACCOUNT_SECURITY_FIELDS
    // declares password 'nonblank'), so it is not a weak password either.
    if (!password || !String(password).trim()) return false;
    if (String(password).length < 8) {
        res.status(400).json({ code: 'rest_weak_password', message: 'Password must be at least 8 characters.', data: { status: 400 } });
        return true;
    }
    // ...and short enough for bcrypt to read all of it (72 BYTES — User.passwordTooLong).
    if (User.passwordTooLong(String(password))) {
        res.status(400).json({ code: 'rest_password_too_long', message: User.PASSWORD_TOO_LONG_MESSAGE, data: { status: 400 } });
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
 * a presence check would 403 "rename my display name" — the same no-op-resend trap accountCapabilities,
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
const _sudoFails = new Map<string, { n: number; at: number }>();
/** The bucket of `userId` on the current site: user ids repeat across a multisite network (site 1: the bare id). */
const _sudoKey = (userId: number): string => require('../core/site-context').siteKeyPrefix() + String(userId);
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
const _sudoRedisKey = (userId: number) => `wjsudo:fails:${_sudoKey(userId)}`;

function _sudoFailCountMem(userId: number): number {
    const e = _sudoFails.get(_sudoKey(userId));
    if (!e) return 0;
    if (Date.now() - e.at > SUDO_WINDOW_MS) { _sudoFails.delete(_sudoKey(userId)); return 0; }
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
    _sudoFails.set(_sudoKey(userId), { n: _sudoFailCountMem(userId) + 1, at: Date.now() });
}

async function sudoClearFails(userId: number): Promise<void> {
    const client = _sudoStore();
    if (client) {
        try { await client.del(_sudoRedisKey(userId)); } catch { /* the TTL expires it anyway */ }
    }
    _sudoFails.delete(_sudoKey(userId));
}

function sudoBeginAttempt(rawKey: string): boolean {
    const key = require('../core/site-context').siteKeyPrefix() + rawKey;
    const now = Date.now();
    let e = _sudoInflight.get(key);
    if (!e || (now - e.at) > SUDO_INFLIGHT_STALE_MS) e = { n: 0, at: now };
    if (e.n >= SUDO_INFLIGHT_MAX) { _sudoInflight.set(key, e); return false; }
    e.n++; e.at = now;
    _sudoInflight.set(key, e);
    return true;
}

function sudoEndAttempt(rawKey: string): void {
    const key = require('../core/site-context').siteKeyPrefix() + rawKey;
    const e = _sudoInflight.get(key);
    if (!e) return;
    e.n = Math.max(0, e.n - 1);
    if (e.n === 0) _sudoInflight.delete(key); else _sudoInflight.set(key, e);
}

// Set on a request whose current password requireSudoPassword verified. requireStepUp (routes/network.ts)
// lets an account without two-factor authentication through on its password alone, and only when this is
// set, so no gated action can ever run with no re-authentication at all.
const SUDO_VERIFIED = Symbol.for('wordjs.sudoPasswordVerified');

/** Did requireSudoPassword verify this request's current password? */
function sudoPasswordVerified(req: Request): boolean {
    return Reflect.get(req, SUDO_VERIFIED) === true;
}

async function requireSudoPassword(req: Request, res: Response, currentPassword: any): Promise<boolean> {
    // The key comes from the RESOLVED session identity only. Nothing here is derived from a request
    // body, a query string or a header, which is what makes the bucket unreachable from outside.
    const userId = Number(req.user && req.user.id);
    // Per source: the address's rate-limit identity (an IPv6 caller is its /64 — core/client-ip ipBucket).
    const inflightKey = `${userId}|${require('../core/client-ip').clientIpBucket(req)}`;

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
        // Against the hash of the account this session belongs to (by id), never re-resolved by name.
        await User.verifyPassword(Number(req.user.id), String(currentPassword || ''));
        await sudoClearFails(userId);
        Object.defineProperty(req, SUDO_VERIFIED, { value: true, configurable: true });
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

/** The capabilities that make an account privileged (isPrivilegedTarget), asked of a ROLE before anyone holds it. */
const PRIVILEGED_CAPS = ['*', 'edit_users', 'promote_users', 'manage_options', 'manage_roles'];
function isPrivilegedRole(role: unknown): boolean {
    if (typeof role !== 'string' || !role) return false;
    if (role === 'administrator') return true;
    const def = (getRoles() || {})[role];
    const caps: string[] = (def && Array.isArray(def.capabilities)) ? def.capabilities : [];
    return caps.some((c) => PRIVILEGED_CAPS.includes(c));
}

/**
 * THE STEP-UP FOR AUTHORITY OVER OTHER PRIVILEGED ACCOUNTS: creating one, promoting someone into one,
 * changing another privileged account's password or sign-in/recovery address, and resetting anyone's
 * second factor. Each of these hands its caller a privileged account they did not have, so a session
 * alone (a stolen cookie, an unattended browser) is not enough: the caller re-enters their own password
 * (`currentPassword`) and, when their account has two-factor authentication, a current code (`mfaCode`)
 * — the same proof the network switch and Admin → Updates ask for (routes/network.ts requireStepUp).
 *
 * A request that carries no password at all is answered 403 `rest_sudo_required`, which the panel turns
 * into the password field (and then the code field on `rest_mfa_step_up_required`); it is not counted as
 * a failed attempt. Resolves true when it has answered the request.
 *
 * SUDO WINDOW: a successful step-up holds for ACCOUNT_STEP_UP_WINDOW_MS for the same signed-in session
 * (its `ses` id) on this process, so one confirmation covers a bulk role change — a one-time code cannot
 * be presented twice. Kept in this process only: a request that lands on another node, or a session
 * without an id, simply asks again.
 */
const ACCOUNT_STEP_UP_WINDOW_MS = 5 * 60 * 1000;
const _accountStepUps = new Map<string, number>();
function accountStepUpKey(req: Request): string | null {
    const ses = require('../middleware/auth').sessionIdOf(req);
    if (!ses || !req.user) return null;
    return `${require('../core/site-context').siteKeyPrefix()}${Number(req.user.id)}|${ses}`;
}
async function requireAccountStepUp(req: Request, res: Response): Promise<boolean> {
    const key = accountStepUpKey(req);
    const now = Date.now();
    if (key && (_accountStepUps.get(key) || 0) > now) return false;
    if (await requireSudoConfirmation(req, res)) return true;
    const proof = await require('./network').requireStepUp(req, res);
    if (proof === null) return true;
    if (key) {
        if (_accountStepUps.size > 1000) for (const [k, until] of _accountStepUps) if (until <= now) _accountStepUps.delete(k);
        _accountStepUps.set(key, now + ACCOUNT_STEP_UP_WINDOW_MS);
    }
    return false;
}

/**
 * requireSudoPassword for an action that only SOMETIMES needs it (the panel sends no password until it is
 * asked for one): no `currentPassword` at all is answered 403 `rest_sudo_required` without counting as a
 * failed attempt; a wrong one is a failed attempt like everywhere else. Resolves true when it answered.
 */
async function requireSudoConfirmation(req: Request, res: Response): Promise<boolean> {
    const pw = (req.body || {}).currentPassword;
    if (typeof pw !== 'string' || !pw) {
        res.status(403).json({
            code: 'rest_sudo_required',
            message: 'Confirm this change with your current password.',
            data: { status: 403 }
        });
        return true;
    }
    return requireSudoPassword(req, res, pw);
}

/**
 * The audit rows of a profile write (PUT /me and PUT /:id): one `user.update` naming the fields the
 * request wrote — names only, never values — and, when a new password was stored, the reserved
 * `auth.password.change`. The password is deliberately absent from the `user.update` field list: it has
 * its own action, so "who changed whose password" is one query. Consumers of these rows (the audit log,
 * outgoing webhooks) therefore never see a credential, only that one was set.
 *
 * A role change keeps its own `user.role_change` row (one row per role change). When the same request
 * also wrote other fields, `user.update` lists `role` among them and the role_change row says so with
 * `profileUpdate: true`, so a consumer that wants one event per profile write (core/webhooks) can tell
 * the two rows describe the same save; a role-ONLY change writes no `user.update` row at all.
 */
function profileWriteFields(updateData: any): string[] {
    const fields: string[] = [];
    for (const [k, v] of Object.entries(updateData || {})) {
        if (v === undefined || k === 'password') continue;
        if (k === 'meta') {
            if (v && typeof v === 'object') for (const m of Object.keys(v)) fields.push(m === 'personal_email' ? 'personalEmail' : m);
            continue;
        }
        fields.push(k);
    }
    return fields;
}

async function recordProfileWriteAudit(actorId: number, userId: number, updateData: any): Promise<void> {
    const fields = profileWriteFields(updateData);
    if (updateData && updateData.password) await recordAudit(actorId, 'auth.password.change', 'user', userId, {});
    if (fields.some((f) => f !== 'role')) await recordAudit(actorId, 'user.update', 'user', userId, { fields });
}

/**
 * THE PRIMARY-EMAIL CHECKS, IN TWO HALVES — and the half that reads OTHER accounts runs after the sudo gate.
 *
 * Both answer the same uniform 400 rest_invalid_email: User.update() used to throw 'Email already in use'
 * as a 500, an authenticated account-existence oracle (500 for a registered address, 200 for a free one),
 * and the single generic message does not say WHY an address is unusable.
 *
 * But the ORDER is part of the answer. The uniqueness lookup ran BEFORE the current-password gate, so
 * `PUT /users/me {email: <anyone's address>}` with no (or a wrong) currentPassword answered 400 for a taken
 * address and 403 rest_bad_current_password for a free one: a hijacked session, a same-origin script or a
 * borrowed browser enumerated accounts without the password. A changed address always demands the sudo
 * proof (selfRecoveryAddressChanged), so the lookup now runs after it, and only a caller who just proved
 * the password learns whether another account holds the address — which they would learn anyway, by the
 * change succeeding or not. The format check depends on nothing but the request and stays up front.
 */
function primaryEmailMalformed(email: any): boolean {
    if (email === undefined || email === null || String(email).trim() === '') return false;
    return !isValidAddress(String(email).trim().toLowerCase());
}

async function primaryEmailTakenByAnother(email: any, ownerId: number): Promise<boolean> {
    if (email === undefined || email === null || String(email).trim() === '') return false;
    // identifierInUse, not findByEmail: on a database that still holds duplicate emails findByEmail
    // answers "nobody", which would read here as "free".
    return await User.identifierInUse(String(email).trim().toLowerCase(), ownerId);
}

function unusableEmail(res: Response) {
    return res.status(400).json({ code: 'rest_invalid_email', message: "This email address can't be used.", data: { status: 400 } });
}

router.put('/me', networkHandoff.refuseHandoffSession, asyncHandler(async (req: Request, res: Response) => {
    const { email, displayName, password, url, personalEmail, currentPassword } = req.body;

    if (rejectWeakPassword(res, password)) return;

    // Optional personal/recovery email (coexists with the primary email; used for password recovery).
    // Validated on the NORMALIZED value — the one the write below stores (see personalEmailValue).
    if (personalEmailValue(personalEmail) && !isValidAddress(personalEmailValue(personalEmail))) {
        return res.status(400).json({ code: 'rest_invalid_personal_email', message: 'Personal email format is invalid.', data: { status: 400 } });
    }

    // SECURITY (self-assigned organisation address): this route is guarded by `authenticate` ONLY, and it
    // writes the PRIMARY email. Any subscriber could otherwise set theirs to me@<site email domain> — the
    // address a plugin delivering the site's mail matches inbound messages against — or move an address a
    // granted capability binds. A caller here never holds `edit_users` by construction (it is the
    // self-service profile route), so the self-service rule applies unconditionally. Same helper as
    // PUT /:id and /auth/register.
    const emailRefusal = await refuseSelfServiceEmailChange(req.user, email);
    if (emailRefusal) return res.status(403).json(emailRefusal);

    // The primary email's FORMAT up front; whether ANOTHER account holds it only after the sudo gate below
    // (see primaryEmailMalformed / primaryEmailTakenByAnother).
    if (primaryEmailMalformed(email)) return unusableEmail(res);

    // SINK CRITERION: 'nonblank' for both `email` and `password` (see ACCOUNT_SECURITY_FIELDS). The
    // password used to go through RAW, and `User.update` only skips a FALSY one — so `'   '` was truthy,
    // read as "not supplied" by the headless gate, and HASHED AND STORED by the sink. An administrator
    // API token could set any account's password to whitespace (a credential the attacker knows and the
    // owner does not), and `[]` reached bcrypt and came back as an unmapped 500. One normalizer, so the
    // value the gate judged is the value that is written.
    const shownName = displayNameOrRefuse(res, displayName);
    if (!shownName) return;
    const updateData: any = { email: suppliedText(email), displayName: shownName.value, password: suppliedText(password), url };
    // SINK CRITERION: 'presence' (see ACCOUNT_SECURITY_FIELDS) — supplying the field at all is a write,
    // and a blank one is how the address is CLEARED. The VALUE goes through the one normalizer, so what
    // is stored for null/'' is '' and never the string "null".
    if (personalEmail !== undefined) updateData.meta = { personal_email: personalEmailValue(personalEmail) };
    // NOTE: `accountCapabilities` is deliberately NOT read from the body here. Those are admin-owned
    // grants; a self-service route must never be able to set one. User.update() only acts on an explicit
    // plan, and their meta prefix is in its PROTECTED_META_PREFIXES, so the `meta` bag above cannot reach
    // them either.

    // SUDO — password OR either recovery address. After the refusals that depend on the request alone
    // (format, mail domain), so a request that was going to be rejected anyway never spends an attempt in
    // the sudo throttle; BEFORE the one that reads other accounts, so only the account owner learns it.
    const recoveryChanged = await selfRecoveryAddressChanged(req.user, req.body);
    // Judged on the SAME normalized value the sink stores (suppliedText): a whitespace-only password is
    // not a credential change, so it must not demand a sudo proof for a write that will not happen.
    if ((suppliedText(password) || recoveryChanged) && await requireSudoPassword(req, res, currentPassword)) return;

    // LAST GATE BEFORE THE WRITE: is the address another account's? Answered only to a caller who has just
    // proved the password (a changed address always demands it — see recoveryChanged).
    if (await primaryEmailTakenByAnother(email, req.user.id)) return unusableEmail(res);

    const updated = await User.update(req.user.id, updateData);
    // A changed recovery address invalidates any reset link already in flight to the old one.
    if (recoveryChanged) await invalidatePendingPasswordReset(req.user.id);
    await recordProfileWriteAudit(req.user.id, req.user.id, updateData);
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
/**
 * @swagger
 * /users/me/sessions/revoke:
 *   post:
 *     summary: Sign out everywhere
 *     description: >-
 *       Stamps the caller's JWT security epoch, so every session token issued so far — INCLUDING the
 *       calling session — stops authenticating. API tokens are left alone; revoke those individually
 *       with DELETE /auth/tokens/{id}. The client must send the user back to the login screen.
 *     tags: [Users]
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
 *                 description: Sudo re-auth — this is a state the owner cannot undo, so a cookie alone is not enough.
 *     responses:
 *       200:
 *         description: Every session of this account has been cut off
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 signedOut:
 *                   type: boolean
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: >-
 *           rest_bad_current_password (the sudo re-auth failed), the headless refusal (a leaked API token
 *           must not be able to knock the owner out of their browsers), rest_csrf_token /
 *           rest_csrf_invalid, or mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: "rest_login_throttled — too many simultaneous sudo re-auth attempts from this address."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
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
    // (A session bound to a secondary address never reaches here for another account: see
    // refuseBoundSessionOnOthers at the top of this router.)
    const isOwn = req.user.id === userId;
    if (!isOwn && !req.user.can('edit_users')) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You cannot edit this user.',
            data: { status: 403 }
        });
    }

    // MULTISITE: a network administrator is changed only by a network administrator (core/network-auth).
    if (!isOwn && protectsNetworkAdmin(req, userId)) return refuseNetworkAdminTarget(res);
    // ...and a network administrator's handoff account by nobody: the handoff manages it (core/network-handoff).
    if (networkHandoff.isHandoffAccount(user)) return networkHandoff.refuseHandoffAccountTarget(res);

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
    if (rejectWeakPassword(res, password)) return;

    // SINK CRITERION: 'nonblank' for both `email` and `password` (see ACCOUNT_SECURITY_FIELDS). The
    // password used to go through RAW, and `User.update` only skips a FALSY one — so `'   '` was truthy,
    // read as "not supplied" by the headless gate, and HASHED AND STORED by the sink. An administrator
    // API token could set any account's password to whitespace (a credential the attacker knows and the
    // owner does not), and `[]` reached bcrypt and came back as an unmapped 500. One normalizer, so the
    // value the gate judged is the value that is written.
    const shownName = displayNameOrRefuse(res, displayName);
    if (!shownName) return;
    const updateData: any = { email: suppliedText(email), displayName: shownName.value, password: suppliedText(password), url };

    // Uniform 400 for a malformed or already-taken primary email (target = the account being edited), the
    // same two halves as PUT /me (primaryEmailMalformed / primaryEmailTakenByAnother): the format here, the
    // lookup of other accounts after the sudo gate below — this route serves self-edits too, and its
    // lookup used to run before the current-password check exactly as PUT /me's did.
    if (primaryEmailMalformed(email)) return unusableEmail(res);

    // SECURITY (PLUGIN-DECLARED ACCOUNT CAPABILITIES). This route also serves SELF-edits — `isOwn` skips
    // the `edit_users` check above — so both the grants and the address they may bind must be re-gated on
    // the capability, not on ownership.
    //
    //  - A grant is admin-owned state: changing one requires `edit_users`, whoever the target is.
    //    Without this, a user editing their OWN record would grant themselves a plugin capability (for
    //    whatever that capability unlocks in its plugin).
    //  - A caller WITHOUT `edit_users` (i.e. a self-edit) is held to the same email rule as
    //    PUT /me — one helper, so the two self-service doors cannot drift apart. An `edit_users`
    //    delegate is unaffected: assigning corporate addresses is precisely their job.
    const canEditUsers = typeof req.user.can === 'function' && req.user.can('edit_users');
    // NO-OP RESEND IS NOT A WRITE. The admin user editor loads `accountCapabilities` into its form state
    // and PUTs the whole object back, so a plain "save my display name" from a non-`edit_users` user
    // carries the field unchanged — rejecting on PRESENCE 403'd every one of those legitimate saves. The
    // `role` field a few lines below is stripped for exactly this reason, and refuseSelfServiceEmailChange
    // does the same for `email`; this one was missed. Compare the VALUE and only treat a real change as a
    // privileged write. (Fail-closed either way, so this was availability, not a hole.)
    // SINK CRITERION: 'presence' (see ACCOUNT_SECURITY_FIELDS). `flagValue` maps '' and null to '0', so a
    // blank value here is a REVOCATION of the grant, not "left alone" — which is why the headless gate
    // judges this field by presence and not by blankness. The plan holds the CHANGES only.
    const capPlan = await accountCapabilities.planAccountCapabilityWrite(user, withLegacyBodyField(req.body));
    if (Object.keys(capPlan.changes).length || capPlan.error) {
        if (!canEditUsers) {
            return res.status(403).json({
                code: 'rest_forbidden',
                message: 'Only a user manager can grant or revoke an account capability.',
                data: { status: 403 }
            });
        }
        if (capPlan.error) return res.status(400).json(capPlan.error);
        updateData.accountCapabilityChanges = capPlan.changes;
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
    const recoveryChanged = await selfRecoveryAddressChanged(user, req.body);
    const selfRecoveryChanged = isOwn && recoveryChanged;
    // Same normalization as the sink a few lines up — see PUT /me.
    if (isOwn && (suppliedText(password) || selfRecoveryChanged) && await requireSudoPassword(req, res, req.body.currentPassword)) return;
    // ANOTHER privileged account's credentials or addresses, or promoting an account into a privileged
    // role: whoever does it ends up able to sign in as (or to be) a privileged account, so the caller
    // re-authenticates — see requireAccountStepUp.
    if (!isOwn && ((isPrivilegedTarget(user) && (suppliedText(password) || recoveryChanged))
        || (updateData.role !== undefined && isPrivilegedRole(updateData.role)))
        && await requireAccountStepUp(req, res)) return;

    // Last gate before the write, after sudo — see primaryEmailTakenByAnother.
    if (await primaryEmailTakenByAnother(email, userId)) return unusableEmail(res);

    const updated = await User.update(userId, updateData);
    // A reset link already sent to an address that is no longer the account's must die with it, whoever
    // changed the address.
    if (recoveryChanged) await invalidatePendingPasswordReset(userId);

    // AUDIT: exactly one row per security-relevant change — a role change. No secret material.
    if (updateData.role !== undefined) {
        const profileUpdate = profileWriteFields(updateData).some((f) => f !== 'role');
        await recordAudit(req.user.id, 'user.role_change', 'user', userId, { from: previousRole, to: updateData.role, profileUpdate });
    }
    await recordProfileWriteAudit(req.user.id, userId, updateData);
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
/**
 * @swagger
 * /users/{id}/mfa/reset:
 *   post:
 *     summary: Administrative two-factor reset
 *     description: >-
 *       The way OUT of a 2FA lockout — clears the target's mfa_* meta so they can log in with their
 *       password again and re-enroll. NEVER on your own account: disabling your own second factor still
 *       goes through POST /auth/mfa/disable, which demands a current code. The caller confirms with their own
 *       password (currentPassword, 403 rest_sudo_required without it) and, when the caller has two-factor
 *       authentication, a current code (mfaCode).
 *     tags: [Users]
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
 *         description: Two-factor authentication cleared for that account
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 reset:
 *                   type: boolean
 *                 id:
 *                   type: integer
 *       400:
 *         description: >-
 *           rest_cannot_reset_own_mfa (use POST /auth/mfa/disable with a current code), or
 *           rest_invalid_param for a malformed id.
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
 *           rest_forbidden (no edit_users capability, or a non-administrator acting on a privileged
 *           account), the headless refusal (a leaked API token must never strip a second factor),
 *           rest_account_bound_session (a session started at an address other than the main one),
 *           rest_csrf_token / rest_csrf_invalid, or mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       404:
 *         description: "rest_user_invalid_id — no such user, or a malformed route id."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.post('/:id/mfa/reset', can('edit_users'), asyncHandler(async (req: Request, res: Response) => {
    // THE ROUTE-ID CONTRACT — see core/query-params. The router-level `router.param('id', ...)` above
    // already refuses a malformed id with this router's 404, so for a bad id this branch is now
    // unreachable. It stays, and its predicate becomes the shared one, so that there is exactly ONE
    // definition of "a route id" in the tree: a local copy that disagreed with the contract is how
    // this class stayed open the last two rounds. The 400 body is untouched.
    const userId = routeIdOrNull(req.params.id);
    if (userId === null) {
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
    if (protectsNetworkAdmin(req, userId)) return refuseNetworkAdminTarget(res);
    if (networkHandoff.isHandoffAccount(user)) return networkHandoff.refuseHandoffAccountTarget(res);
    if (isPrivilegedTarget(user) && req.user.getRole() !== 'administrator') {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'Only an administrator can reset two-factor authentication on a privileged account.',
            data: { status: 403 }
        });
    }

    // Removing a second factor is how an account is opened to its password alone: the caller re-authenticates.
    if (await requireAccountStepUp(req, res)) return;

    // disable() deletes EVERY mfa_* key (secret, pending secret, backup-code hashes, enabled flag and the
    // anti-replay counter), so the account is left exactly as if it had never enrolled.
    await require('../core/mfa').disable(userId);
    // AUDIT: who removed whose second factor. No secret material.
    await recordAudit(req.user.id, 'user.mfa_reset', 'user', userId, { username: user.userLogin, role: user.getRole && user.getRole() });
    res.json({ reset: true, id: userId });
}));

// ─── Account self-service: profile picture, data export, deleting your own account ───────────────
// My Account had no avatar (the admin painted the first letter of the name), no way to take your data
// with you and no way to leave: an account opened through public sign-up could only be closed by asking
// an administrator. All three are the signed-in user's own and need no capability; the delete asks for
// the current password, like every other irreversible change to the account.

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_SIZE = 256;
const avatarUpload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: AVATAR_MAX_BYTES, files: 1 } });

/** The folder avatars live in (public uploads, `avatars/`), created on first use. */
function avatarDir(): string {
    const dir = require('path').join(require('../core/private-media').uploadsRootFor(false), 'avatars');
    require('fs').mkdirSync(dir, { recursive: true });
    return dir;
}

/** Remove the file a stored avatar_url names, if it is one of ours. Best-effort. */
function removeAvatarFile(url: unknown): void {
    if (typeof url !== 'string' || !/^\/uploads\/avatars\/[A-Za-z0-9_-]+\.webp$/.test(url)) return;
    try { require('fs').unlinkSync(require('path').join(avatarDir(), require('path').basename(url))); } catch { /* already gone */ }
}

/**
 * @swagger
 * /users/me/avatar:
 *   put:
 *     summary: Upload your profile picture
 *     description: >-
 *       multipart/form-data with one image under `avatar` (JPEG, PNG, WebP, GIF or AVIF, at most 5 MB). It is
 *       re-encoded server-side to a 256×256 WebP (metadata dropped) and shown instead of the initial.
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: The updated user (avatarUrl set)
 *       400:
 *         description: rest_avatar_invalid — no file, or not an image
 *       413:
 *         description: rest_upload_too_large
 *   delete:
 *     summary: Remove your profile picture
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: The updated user (avatarUrl null)
 */
router.put('/me/avatar', (req: Request, res: Response, next: any) => {
    avatarUpload.single('avatar')(req, res, (err: any) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ code: 'rest_upload_too_large', message: 'The picture is larger than 5 MB.', data: { status: 413, maxBytes: AVATAR_MAX_BYTES } });
        }
        if (err) return next(err);
        next();
    });
}, asyncHandler(async (req: Request, res: Response) => {
    const file = (req as Request & { file?: { buffer: Buffer } }).file;
    const invalid = () => res.status(400).json({ code: 'rest_avatar_invalid', message: 'Choose an image file (JPEG, PNG, WebP, GIF or AVIF).', data: { status: 400 } });
    if (!file || !file.buffer || !file.buffer.length) return invalid();
    const sharp = require('sharp');
    let webp: Buffer;
    try {
        // Decoding IS the check: anything sharp cannot read as an image is refused. The output is a fresh
        // encode (no EXIF/GPS; SVG, which could carry scripts, is not an accepted input).
        const meta = await sharp(file.buffer, { limitInputPixels: 40_000_000 }).metadata();
        if (!meta || !['jpeg', 'png', 'webp', 'gif', 'avif', 'heif'].includes(String(meta.format))) return invalid();
        webp = await sharp(file.buffer, { limitInputPixels: 40_000_000, animated: false })
            .rotate().resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
    } catch {
        return invalid();
    }
    const name = `${Number(req.user.id)}-${require('crypto').randomBytes(6).toString('hex')}.webp`;
    // A new file under a random name, created exclusively (never an existing path) and readable by this
    // process only — the backend itself serves /uploads.
    require('fs').writeFileSync(require('path').join(avatarDir(), name), webp, { flag: 'wx', mode: 0o600 });
    const previous = req.user.meta && req.user.meta.avatar_url;
    await User.updateMeta(req.user.id, 'avatar_url', `/uploads/avatars/${name}`);
    removeAvatarFile(previous);
    await recordAudit(req.user.id, 'user.avatar.update', 'user', req.user.id, {});
    const fresh = await User.findById(req.user.id);
    res.json(fresh.toJSON());
}));

router.delete('/me/avatar', asyncHandler(async (req: Request, res: Response) => {
    const previous = req.user.meta && req.user.meta.avatar_url;
    await User.deleteMeta(req.user.id, 'avatar_url');
    removeAvatarFile(previous);
    const fresh = await User.findById(req.user.id);
    res.json(fresh.toJSON());
}));

/**
 * @swagger
 * /users/me/export:
 *   get:
 *     summary: Download your data
 *     description: >-
 *       A JSON file with your profile (no password hash, no security material), the entries you wrote,
 *       the comments you posted while signed in and the media you uploaded. An interactive session only.
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: application/json attachment
 */
router.get('/me/export', sessionOnly, asyncHandler(async (req: Request, res: Response) => {
    const { dbAsync } = require('../config/database');
    const uid = Number(req.user.id);
    const entries = await dbAsync.all(
        "SELECT id, post_type, post_status, post_title, post_name, post_date, post_modified FROM posts " +
        "WHERE author_id = ? AND post_type NOT IN ('revision', 'attachment') ORDER BY post_date DESC LIMIT 5000", [uid]);
    const media = await dbAsync.all(
        "SELECT id, post_title, post_mime_type, post_date FROM posts WHERE author_id = ? AND post_type = 'attachment' ORDER BY post_date DESC LIMIT 5000", [uid]);
    const comments = await dbAsync.all(
        'SELECT comment_id, comment_post_id, comment_date, comment_content, comment_approved FROM comments WHERE user_id = ? ORDER BY comment_date DESC LIMIT 5000', [uid]);
    const profile = req.user.toJSON();
    const body = {
        exportedAt: new Date().toISOString(),
        profile: { id: profile.id, username: profile.username, email: profile.email, displayName: profile.displayName, role: profile.role, personalEmail: profile.personalEmail, avatarUrl: profile.avatarUrl, meta: profile.meta },
        entries: entries.map((r: any) => ({ id: r.id, type: r.post_type, status: r.post_status, title: r.post_title, slug: r.post_name, date: r.post_date, modified: r.post_modified })),
        comments: comments.map((r: any) => ({ id: r.comment_id, postId: r.comment_post_id, date: r.comment_date, status: r.comment_approved, content: r.comment_content })),
        media: media.map((r: any) => ({ id: r.id, title: r.post_title, mimeType: r.post_mime_type, date: r.post_date })),
    };
    await recordAudit(uid, 'user.export', 'user', uid, {});
    res.set('Cache-Control', 'no-store');
    res.set('Content-Disposition', `attachment; filename="account-${uid}.json"`);
    res.json(body);
}));

/**
 * @swagger
 * /users/me:
 *   delete:
 *     summary: Delete your own account
 *     description: >-
 *       Asks for the current password (`currentPassword`). Your entries stay on the site, unattributed (only an
 *       administrator can reassign them, from the Users screen). The last administrator cannot delete their
 *       account. The session ends with it.
 *     tags: [Users]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               currentPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ deleted: true }"
 *       403:
 *         description: rest_bad_current_password, or rest_last_administrator
 */
router.delete('/me', sessionOnly, asyncHandler(async (req: Request, res: Response) => {
    if (await requireSudoPassword(req, res, (req.body || {}).currentPassword)) return;
    const uid = Number(req.user.id);
    if (protectsNetworkAdmin(req, uid)) return refuseNetworkAdminTarget(res);
    if (isPrivilegedTarget(req.user)) {
        const admins = await User.count({ role: 'administrator' });
        if (Number(admins) <= 1) {
            return res.status(403).json({ code: 'rest_last_administrator', message: 'You are the only administrator: make someone else an administrator before deleting your account.', data: { status: 403 } });
        }
    }
    removeAvatarFile(req.user.meta && req.user.meta.avatar_url);
    const login = req.user.userLogin;
    await User.delete(uid);
    await recordAudit(uid, 'user.delete', 'user', uid, { username: login, self: true });
    require('../middleware/auth').clearSessionCookies(res);
    res.json({ deleted: true });
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
 *       - in: query
 *         name: reassign
 *         description: Attribute every entry of the deleted user (any type and status) to this other user first. Without it the entries stay, credited to the deleted account.
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
 *         description: User deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted:
 *                   type: boolean
 *                 previous:
 *                   $ref: '#/components/schemas/User'
 *                 reassigned:
 *                   type: integer
 *                   description: How many entries were attributed to the reassign user (0 without reassign).
 *       400:
 *         description: "rest_user_cannot_delete — you cannot delete yourself."
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
 *           rest_forbidden (not an administrator), the headless refusal (a `wjt_` API token may not
 *           destroy an account), rest_account_bound_session (a session started at an address other than
 *           the main one), rest_csrf_token / rest_csrf_invalid, or mfa_enrollment_required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       404:
 *         description: "rest_user_invalid_id — no such user, or a malformed route id."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
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
    if (protectsNetworkAdmin(req, userId)) return refuseNetworkAdminTarget(res);
    // A network administrator's handoff account is the network's, like every other write to it.
    if (networkHandoff.isHandoffAccount(user)) return networkHandoff.refuseHandoffAccountTarget(res);

    // `?reassign=<user id>`: the deleted account's content (every entry, any type and status) is
    // attributed to that user first, as WordPress offers. Without it the entries stay, credited to an
    // account that no longer exists — the old behaviour, kept so nothing is ever deleted implicitly.
    const reassignRaw = scalarQueryParam(req.query.reassign, 'reassign');
    let reassigned = 0;
    if (reassignRaw !== undefined && reassignRaw !== '') {
        const target = routeIdOrNull(reassignRaw);
        const targetUser = target ? await User.findById(target) : null;
        if (!targetUser || target === userId) {
            return res.status(400).json({
                code: 'rest_invalid_param',
                message: 'reassign must name another existing user.',
                data: { status: 400, params: { reassign: 'Invalid user ID.' } }
            });
        }
        reassigned = await require('../models/Post').reassignAuthor(userId, target);
    }

    await User.delete(userId);
    // AUDIT: admin deleted a user. Record who + the deleted account's login/role (no secret material).
    await recordAudit(req.user.id, 'user.delete', 'user', userId, { username: user.userLogin, role: user.getRole && user.getRole(), ...(reassigned ? { reassignedTo: Number(reassignRaw), reassigned } : {}) });
    res.json({ deleted: true, previous: user.toJSON(), reassigned });
}));

module.exports = router;
// Exposed so the OTHER surfaces that must not be reachable on an ambient cookie alone (MFA enrollment in
// routes/auth.ts) run the SAME throttled sudo check instead of re-implementing it — the drift this repo
// keeps paying for. Assigned after the export, exactly like routes/auth.ts does with its lockout helpers.
module.exports.requireSudoPassword = requireSudoPassword;
module.exports.sudoPasswordVerified = sudoPasswordVerified;
module.exports.requireAccountStepUp = requireAccountStepUp;
module.exports.displayNameOrRefuse = displayNameOrRefuse;
module.exports.requireSudoConfirmation = requireSudoConfirmation;
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
