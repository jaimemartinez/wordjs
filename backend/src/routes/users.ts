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
const { refuseSelfServiceEmailChange, EMAIL_FORMAT_RE } = require('../core/mailbox');

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
    if (!EMAIL_FORMAT_RE.test(String(email).trim().normalize('NFC').toLowerCase())) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid email format.', data: { status: 400 } });
    }

    // Optional personal/recovery email (coexists with the primary email; used for password recovery).
    if (personalEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(personalEmail).trim())) {
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
router.put('/me', authenticate, asyncHandler(async (req: any, res: Response) => {
    const { email, displayName, password, url, personalEmail, currentPassword } = req.body;

    // Changing your OWN password requires your CURRENT password — defends against a hijacked session /
    // CSRF silently resetting it. User.update() stamps token_valid_after (revoking all sessions), so a
    // caller who doesn't know the current password must never reach that.
    if (password) {
        if (String(password).length < 8) {
            return res.status(400).json({ code: 'rest_weak_password', message: 'Password must be at least 8 characters.', data: { status: 400 } });
        }
        // Gate this sudo re-auth with the SAME shared per-account lockout as /auth/login — otherwise a
        // hijacked session brute-forces the current password unthrottled (only the loose apiLimiter applies)
        // (audit #26 — unthrottled password oracle). This path is authenticated/session-scoped, so RECORDING
        // failures here correctly throttles the oracle without the unauthenticated-DoS of #25.
        const auth = require('./auth');
        const lockId = await auth.resolveLockIdentifier(req.user.userLogin);
        if (await auth.isLoginLocked(lockId)) {
            return res.status(429).json({ code: 'rest_account_locked', message: 'Too many failed attempts. Try again later.', data: { status: 429 } });
        }
        try { await User.authenticate(req.user.userLogin, String(currentPassword || '')); await auth.clearLoginFails(lockId); }
        catch { await auth.recordLoginFail(lockId); return res.status(403).json({ code: 'rest_bad_current_password', message: 'Current password is incorrect.', data: { status: 403 } }); }
    }

    // Optional personal/recovery email (coexists with the primary email; used for password recovery).
    if (personalEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(personalEmail).trim())) {
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

    const updateData: any = { email, displayName, password, url };

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
    if (req.body.professionalMailbox !== undefined) {
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
        if (personalEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(personalEmail).trim())) {
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
