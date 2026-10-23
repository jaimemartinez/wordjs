/**
 * WordJS — Admin → Updates (core/updater): is a newer WordJS out, what it changes, and installing it from
 * the panel (zero config; `npx create-wordjs upgrade` stays the terminal path).
 *
 *   GET  /system/update          the version, the newer releases with their notes, whether the panel may
 *                                update here (and what to do instead), and the progress of a running update
 *   POST /system/update/check    read the releases again now (they are cached for six hours)
 *   POST /system/update          install a release: backup, the official CLI, restart, rollback on
 *                                failure (password, + a code with 2FA)
 *
 * Who: administrators of a single site, network administrators of a network; the main site only
 * (routes/index.ts); an interactive session at the main address for the install itself — it replaces
 * the server's code, so it is never driven by an API token. Audited (system.update.start).
 */
import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { authenticate, sessionOnly, accountAuthorityOnly } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireSudoPassword } = require('./users');

router.use(authenticate, isAdmin, sessionOnly);

function updater(): any { return require('../core/updater'); }

/**
 * @swagger
 * /system/update:
 *   get:
 *     summary: Admin → Updates - the version, newer releases and their notes, and a running update's progress
 *     description: environment.canUpdate says whether the panel may install here; when it may not (a container, a git checkout, split mode, files this process cannot write, no supervisor) environment.how says what to do instead. Releases come from the project's GitHub releases, cached for six hours.
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ current, latest, newer: [{ tag, version, name, publishedAt, notes, url, hasChecksum }], environment: { canUpdate, reason, how }, state, output, running, error, checkedAt }"
 *       403:
 *         description: Not an administrator, or an API token
 *   post:
 *     summary: Install a newer release
 *     description: Takes a backup, runs the official create-wordjs upgrade for that tag (it verifies the bundle's SHA-256 before extracting), and restarts. A failed update puts the previous version back; a new version that does not start is rolled back by the supervisor. The tag must be a newer release the project published with a bundle. The password (and a current two-factor code when the account has 2FA); an interactive session at the main address; audited.
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tag, currentPassword]
 *             properties:
 *               tag:
 *                 type: string
 *                 example: v2.8.0
 *               currentPassword:
 *                 type: string
 *               mfaCode:
 *                 type: string
 *                 description: A current two-factor code. Required only when the account has two-factor authentication; without it the password alone confirms.
 *     responses:
 *       202:
 *         description: "{ to } — the update runs in the background; GET follows it"
 *       400:
 *         description: Not a release tag (update_invalid_tag) or not one the project published (update_unknown_release), or a wrong code
 *       403:
 *         description: Not an administrator, a wrong password, or no code from an account with two-factor authentication
 *       409:
 *         description: The panel may not update here (update_docker, update_source_checkout, update_split_mode, update_not_writable, update_no_supervisor, update_not_a_release), an update is running (update_busy), or the release is not newer (update_not_newer)
 * /system/update/check:
 *   post:
 *     summary: Read the releases again now
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The same answer as GET
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ...(await updater().overview()), ...updater().status() });
}));

router.post('/check', asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ...(await updater().overview({ force: true })), ...updater().status() });
}));

router.post('/', accountAuthorityOnly, asyncHandler(async (req: Request, res: Response) => {
    const b = req.body || {};
    if (await requireSudoPassword(req, res, b.currentPassword)) return;
    const reauth = await require('./network').requireStepUp(req, res);
    if (!reauth) return;
    try {
        const r = await updater().startUpdate({ tag: b.tag, actorUserId: Number(req.user.id), reauth });
        res.status(202).json(r);
    } catch (e: any) {
        if (e && typeof e.code === 'string' && e.code.startsWith('update_')) {
            return res.status(e.status || 400).json({ code: e.code, message: e.message, data: { status: e.status || 400 } });
        }
        throw e;
    }
}));

module.exports = router;
