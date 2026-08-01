/**
 * WordJS - Users Routes
 * /api/v1/users/*
 */

import type { Response } from 'express';

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { can, isAdmin, ownerOrCan } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { getRoles } = require('../core/roles');
// ACTIVE CORPORATE MAILBOX: the admin-owned grant + the one self-service email-write rule.
const { refuseSelfServiceEmailChange, isValidAddress, mailboxFlagValue, hasProfessionalMailbox } = require('../core/mailbox');

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
router.get('/', authenticate, can('list_users'), asyncHandler(async (req: any, res: Response) => {
    const {
        page = 1,
        per_page = 10,
        search,
        role,
        orderby = 'id',
        order = 'asc'
    } = req.query;

    const limit = Math.min(parseInt(per_page, 10) || 10, 100);
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

    // SECURITY: Whitelist allowed orderBy columns to prevent SQL injection
    const allowedOrderBy = ['id', 'user_login', 'display_name', 'user_email', 'user_registered'];
    const safeOrderBy = allowedOrderBy.includes(orderby) ? orderby : 'id';
    const safeOrder = ['asc', 'desc'].includes(order.toLowerCase()) ? order.toUpperCase() : 'ASC';

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
router.get('/me', authenticate, (req: any, res: Response) => {
    res.json(req.user.toJSON());
});

/**
 * GET /users/:id
 * Get single user
 */
router.get('/:id', authenticate, asyncHandler(async (req: any, res: Response) => {
    const userId = parseInt(req.params.id, 10);
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
router.post('/', authenticate, isAdmin, asyncHandler(async (req: any, res: Response) => {
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
// Shared sudo re-authentication for a SELF password change. Changing your OWN password requires your
// CURRENT password — defends against a hijacked session / CSRF / same-origin XSS silently resetting it
// (User.update stamps token_valid_after, revoking all sessions + API tokens). Applied to BOTH self-service
// password doors — PUT /me AND the isOwn branch of PUT /:id — via ONE helper so they cannot drift; the
// /:id self-edit sibling used to skip this entirely, turning a transient session compromise into a
// persistent takeover with victim lockout. Returns true if it already sent a response (caller must return),
// false to proceed. Gated with the SAME per-account lockout + inflight cap as /auth/login so the current
// password can't be brute-forced through this oracle (audit #26 / AUTH-A3).
async function requireSelfPasswordReauth(req: any, res: any, password: any, currentPassword: any): Promise<boolean> {
    if (!password) return false;
    if (String(password).length < 8) {
        res.status(400).json({ code: 'rest_weak_password', message: 'Password must be at least 8 characters.', data: { status: 400 } });
        return true;
    }
    const auth = require('./auth');
    const lockId = await auth.resolveLockIdentifier(req.user.userLogin);
    if (await auth.isLoginLocked(lockId)) {
        res.status(429).json({ code: 'rest_account_locked', message: 'Too many failed attempts. Try again later.', data: { status: 429 } });
        return true;
    }
    if (!(await auth.beginLoginAttempt(lockId))) {
        res.status(429).json({ code: 'rest_login_throttled', message: 'Too many simultaneous attempts. Try again in a moment.', data: { status: 429 } });
        return true;
    }
    try {
        await User.authenticate(req.user.userLogin, String(currentPassword || ''));
        await auth.clearLoginFails(lockId);
        return false;
    } catch {
        await auth.recordLoginFail(lockId);
        res.status(403).json({ code: 'rest_bad_current_password', message: 'Current password is incorrect.', data: { status: 403 } });
        return true;
    } finally {
        await auth.endLoginAttempt(lockId);
    }
}

router.put('/me', authenticate, asyncHandler(async (req: any, res: Response) => {
    const { email, displayName, password, url, personalEmail, currentPassword } = req.body;

    if (await requireSelfPasswordReauth(req, res, password, currentPassword)) return;

    // Optional personal/recovery email (coexists with the primary email; used for password recovery).
    if (personalEmail && !isValidAddress(personalEmail)) {
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

    const updateData: any = { email, displayName, password, url };
    if (personalEmail !== undefined) updateData.meta = { personal_email: String(personalEmail).trim().toLowerCase() };
    // NOTE: `professionalMailbox` is deliberately NOT read from the body here. It is the admin-owned
    // grant; a self-service route must never be able to set it. User.update() only acts on the explicit
    // field, and MAILBOX_META_KEY is in its PROTECTED_META list, so the `meta` bag above cannot reach it
    // either.

    const updated = await User.update(req.user.id, updateData);
    res.json(updated.toJSON());
}));

router.put('/:id', authenticate, asyncHandler(async (req: any, res: Response) => {
    const userId = parseInt(req.params.id, 10);
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
    // reset a privileged user's password/email and seize the account. Protect ANY effectively-omnipotent
    // target — not just the literal 'administrator' role: a custom role carrying the '*' wildcard or the
    // user/role/options-management caps is just as dangerous (audit MEDIUM). Only an administrator (or the
    // account's owner) may edit such an account. (AUTH-1)
    const targetIsPrivileged = !!(user.getRole && (
        user.getRole() === 'administrator' ||
        (typeof user.can === 'function' && (
            user.can('*') || user.can('edit_users') || user.can('promote_users') ||
            user.can('manage_options') || user.can('manage_roles')
        ))
    ));
    if (!isOwn && targetIsPrivileged && req.user.getRole() !== 'administrator') {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'Only an administrator can edit a privileged account.',
            data: { status: 403 }
        });
    }

    const { email, displayName, password, url } = req.body;
    let role = req.body.role;
    const personalEmail = req.body.personalEmail;

    // SECURITY: this route ALSO serves SELF-edits (isOwn skips the edit_users gate above), and it reaches
    // the same password sink as PUT /me. Changing your OWN password therefore requires your CURRENT
    // password here too — the sudo re-auth was on /me but not on this self-edit sibling, so a hijacked
    // session / same-origin XSS could silently reset the victim's password via /users/:ownId and take the
    // account over persistently. An `edit_users` delegate resetting ANOTHER user's password is unaffected
    // (isOwn is false → admin reset, as before).
    if (isOwn && await requireSelfPasswordReauth(req, res, password, req.body.currentPassword)) return;

    const updateData: any = { email, displayName, password, url };

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
    if (personalEmail !== undefined) {
        if (personalEmail && !isValidAddress(personalEmail)) {
            return res.status(400).json({ code: 'rest_invalid_personal_email', message: 'Personal email format is invalid.', data: { status: 400 } });
        }
        updateData.meta = { personal_email: String(personalEmail).trim().toLowerCase() };
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

    const updated = await User.update(userId, updateData);
    res.json(updated.toJSON());
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
router.delete('/:id', authenticate, isAdmin, asyncHandler(async (req: any, res: Response) => {
    const userId = parseInt(req.params.id, 10);
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
    res.json({ deleted: true, previous: user.toJSON() });
}));

module.exports = router;
