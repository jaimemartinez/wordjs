/**
 * WordJS - Admin Notices Routes
 * /api/v1/notices/*
 *
 * WHY ITS OWN ROUTER (audit 2026-08-18 #30): admin notices are not a setting. They only ever lived
 * under /settings because of the namespace they happened to share, and that accident is exactly what
 * broke them: `GET /settings/:key` is a wildcard, it was registered above `GET /settings/notices`,
 * and Express matches in registration order — so every list request was answered by the wildcard with
 * key='notices', which is not public and never consults the session → 403 even for an administrator.
 * A router with no wildcard of its own cannot regress that way.
 *
 * `admin_notices` is written by the plugin CrashGuard (core/plugins.ts) when a plugin is auto-disabled
 * after three consecutive boot crashes. Until this router (and the /admin/notices screen that calls
 * it) existed, nothing in the product ever READ that option: the administrator saw the plugin vanish
 * from `active_plugins` and never learned why. The option is autoloaded, so an unprunable list is also
 * dead weight in the boot cache on every start.
 *
 * The legacy /settings/notices paths still work — routes/settings.ts mounts THIS router under its own
 * /notices prefix, so there is one implementation, not two that can drift.
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { getOption } = require('../core/options');
// THE DISMISSAL IS A WRITER LIKE THE OTHERS, NOT A SECOND DIALECT OF ONE. `admin_notices` is a whole
// array rewritten by a read-modify-write, and it now has three writers: the plugin CrashGuard
// (core/plugins.ts), core/admin-notices.ts — which fires on EVERY boot and every isolated-plugin
// launch — and this route. The other two take the `wordjs:admin-notices` lock and re-read under it;
// this one used to read at one line and write at the next with no lock at all, so an administrator
// dismissing a notice could silently drop a degradation raised a millisecond earlier. That is the
// exact failure core/admin-notices.ts exists to end, so the route calls ITS writer instead of owning
// a copy of the sequence.
const { clearAdminNotice } = require('../core/admin-notices');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * @swagger
 * tags:
 *   name: Notices
 *   description: Persistent admin notices (plugin CrashGuard and friends)
 */

/**
 * @swagger
 * /notices:
 *   get:
 *     summary: List persistent admin notices
 *     tags: [Notices]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The notices array (may be empty)
 *       401:
 *         description: Unauthenticated
 *       403:
 *         description: Forbidden (non-admin)
 */
router.get('/', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const notices = await getOption('admin_notices', []);
    // Defensive: the option is a plain JSON blob. If anything ever wrote a non-array there, answer with
    // an empty list instead of handing the admin screen something it cannot map over.
    res.json(Array.isArray(notices) ? notices : []);
}));

/**
 * @swagger
 * /notices/{id}:
 *   delete:
 *     summary: Dismiss a notice
 *     tags: [Notices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dismissed (idempotent); returns how many notices remain
 *       503:
 *         description: >-
 *           rest_notice_not_dismissed — the shared writer could not take the admin-notices lock (or the
 *           option was unreachable), so nothing was written. The dismissal is queued and the request is
 *           safe to repeat.
 */
router.delete('/:id', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    // One locked read-modify-write, shared with the two writers that raise notices. It is idempotent
    // and it only writes when something actually changed, so dismissing an already-gone notice still
    // does not churn an autoloaded option (and invalidate its boot cache) for nothing.
    const dismissed = await clearAdminNotice(id);
    if (!dismissed) {
        // Never answer 200 for a write that did not happen: the screen would remove the row and the
        // next refresh would put it back, which is how an operator learns to distrust the screen.
        return res.status(503).json({
            code: 'rest_notice_not_dismissed',
            message: 'The notice could not be dismissed right now. Please try again.',
            data: { status: 503 }
        });
    }

    const stored = await getOption('admin_notices', []);
    res.json({ success: true, remaining: Array.isArray(stored) ? stored.length : 0 });
}));

module.exports = router;
