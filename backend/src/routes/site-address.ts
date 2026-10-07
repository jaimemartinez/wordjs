/**
 * WordJS — /api/v1/site-address: where the site lives.
 *
 * The admin screen (frontend/src/app/admin/settings/site-address) reads and changes the site's main
 * address, the other addresses it answers on and the IP-literal policy here. The model and every rule
 * live in core/site-address; this router is the door, and the door is the point:
 *
 *   EVERY route — reads included (REDTEAM R8: the answer lists the origin's own IPs, a CDN/WAF bypass for
 *   anyone else, and the hosts being probed):
 *     authenticate → isAdmin (role administrator) → sessionOnly (an API token never moves the site)
 *   and, mounted globally at the API prefix, the CSRF origin check + double-submit token and the MFA
 *   compliance gate. EVERY write additionally:
 *     requireSudoPassword (`currentPassword`, the shared re-authentication door of routes/users.ts)
 *     → `rev` compare-and-swap (409 when someone else changed the address meanwhile).
 *
 * No value here is ever taken from the request's Host or forwarded headers: a new main address comes
 * from the body only, and "connected via" is what the host gate attached (informational).
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { authenticate, sessionOnly, siteHostOf } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireSudoPassword } = require('./users');
const siteAddress = require('../core/site-address');

router.use(authenticate, isAdmin, sessionOnly);

/** The revision the client read; required on every write, so a stale screen can never overwrite. */
function revFrom(body: any): number | null {
    const rev = body ? body.rev : undefined;
    return Number.isInteger(rev) && rev >= 0 ? rev : null;
}

function sendError(res: Response, e: any): void {
    if (e && e.name === 'SiteAddressError') {
        res.status(e.status).json({ code: e.code, message: e.message, data: { status: e.status, ...e.data } });
        return;
    }
    throw e;
}

function missingRev(res: Response): void {
    res.status(400).json({ code: 'rest_invalid_param', message: 'rev (the revision you read) is required.', data: { status: 400, params: ['rev'] } });
}

/**
 * @swagger
 * tags:
 *   name: Site address
 *   description: >-
 *     The site's main address (the base of every link and email), the other addresses it answers on,
 *     and the IP-literal policy. Administrator, browser session only; every write re-authenticates.
 */

/**
 * @swagger
 * /site-address:
 *   get:
 *     summary: Read the site's addresses
 *     description: >-
 *       The main address, the other addresses (with when each was last used), the addresses accepted by
 *       rule (environment, the IPs `own` answers — this server's, or behind a gateway the gateway's, as it
 *       reported them — and development origins), the address this request came in on, recently refused
 *       hosts (each saying whether the gateway's edge, this backend's gate or both refused it), and any
 *       unresolved conflict. Administrator, browser session only.
 *     tags: [Site address]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The current state, with `rev` to send back on a write
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 rev:
 *                   type: integer
 *                 canonical:
 *                   type: string
 *                   nullable: true
 *                 aliases:
 *                   type: array
 *                   items:
 *                     type: object
 *                 ipLiterals:
 *                   type: string
 *                   enum: [any, own, none]
 *                 ownAddresses:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: The IP literals `own` answers.
 *                 ownAddressesFrom:
 *                   type: string
 *                   enum: [gateway, server]
 *                   description: The gateway's report (split and separate mode), or this server's interfaces.
 *                 ownAddressesReportedAt:
 *                   type: string
 *                   format: date-time
 *                   nullable: true
 *                   description: When the gateway's report arrived; null for this server's own interfaces.
 *       401:
 *         description: "rest_not_logged_in — no valid credential."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: "rest_forbidden (not an administrator), rest_token_management_forbidden (API token) or mfa_enrollment_required."
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
    await siteAddress.ensureStarted();
    res.set('Cache-Control', 'no-store');
    res.json(await siteAddress.describeState(siteHostOf(req)));
}));

/**
 * @swagger
 * /site-address/canonical:
 *   put:
 *     summary: Change the main address
 *     description: >-
 *       The new address comes from the body only. The previous main address is kept as another address
 *       by default (`oldAddress`: keep | redirect | drop). Dropping an address something still uses
 *       (the gateway or frontend URL, or a signed-in session in the last ten minutes) answers 409 with
 *       `data.dependents` unless `force` is true, which is audited.
 *     tags: [Site address]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url, currentPassword, rev]
 *             properties:
 *               url:
 *                 type: string
 *               oldAddress:
 *                 type: string
 *                 enum: [keep, redirect, drop]
 *               currentPassword:
 *                 type: string
 *               rev:
 *                 type: integer
 *               force:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Saved (or `unchanged`); the new revision and any non-fatal warnings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 rev:
 *                   type: integer
 *                 unchanged:
 *                   type: boolean
 *                 warnings:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: rest_invalid_param / rest_invalid_site_address — the value itself.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: rest_bad_current_password, rest_forbidden, rest_token_management_forbidden, or a CSRF refusal.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       409:
 *         description: rest_site_address_stale (reload and retry) or rest_site_address_in_use (`data.dependents`).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       500:
 *         description: rest_site_address_rollback — the database refused the change, which was undone.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       503:
 *         description: rest_config_unreadable — wordjs-config.json cannot be read right now; nothing changed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.put('/canonical', asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    if (await requireSudoPassword(req, res, body.currentPassword)) return;
    const rev = revFrom(body);
    if (rev === null) return missingRev(res);
    await siteAddress.ensureStarted();
    try {
        const result = await siteAddress.commit(
            (cfg: any) => siteAddress.planCanonical(cfg, { url: body.url, oldAddress: body.oldAddress, actorId: req.user.id, via: 'ui', now: Date.now() }),
            { expectRev: rev, via: 'ui', actorId: req.user.id, force: body.force === true });
        res.json(result);
    } catch (e) {
        sendError(res, e);
    }
}));

/**
 * @swagger
 * /site-address/aliases:
 *   put:
 *     summary: Replace the list of other addresses
 *     description: >-
 *       The full list (it replaces the stored one). Each entry is `{url, mode?, label?, signIn?, expiresAt?}`.
 *       A new tunnel name expires after seven days unless `expiresAt` says otherwise; a new `.local` name
 *       needs `confirmLocal: true`. Removing an address something still uses answers 409 with
 *       `data.dependents` unless `force` is true. Sessions started on a removed address stop working.
 *     tags: [Site address]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [aliases, currentPassword, rev]
 *             properties:
 *               aliases:
 *                 type: array
 *                 items:
 *                   type: object
 *               currentPassword:
 *                 type: string
 *               rev:
 *                 type: integer
 *               force:
 *                 type: boolean
 *               confirmLocal:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Saved (or `unchanged`)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 rev:
 *                   type: integer
 *                 unchanged:
 *                   type: boolean
 *                 warnings:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: rest_invalid_param, rest_invalid_site_address or rest_site_address_confirm_local.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: rest_bad_current_password, rest_forbidden, rest_token_management_forbidden, or a CSRF refusal.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       409:
 *         description: rest_site_address_stale or rest_site_address_in_use (`data.dependents`).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       500:
 *         description: rest_site_address_rollback.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       503:
 *         description: rest_config_unreadable.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.put('/aliases', asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    if (await requireSudoPassword(req, res, body.currentPassword)) return;
    const rev = revFrom(body);
    if (rev === null) return missingRev(res);
    await siteAddress.ensureStarted();
    try {
        const result = await siteAddress.commit(
            (cfg: any) => siteAddress.planAliases(cfg, { aliases: body.aliases, confirmLocal: body.confirmLocal, actorId: req.user.id, via: 'ui', now: Date.now() }),
            { expectRev: rev, via: 'ui', actorId: req.user.id, force: body.force === true });
        res.json(result);
    } catch (e) {
        sendError(res, e);
    }
}));

/**
 * @swagger
 * /site-address/policy:
 *   put:
 *     summary: Change which IP addresses the site answers on
 *     description: >-
 *       `ipLiterals`: any (every IP literal, the default), own (this server's addresses only) or none.
 *       `ipSignIn` lets sessions be started on IP addresses in production (off by default). The
 *       WORDJS_IP_HOSTS environment variable overrides `ipLiterals` and is reported as a warning.
 *     tags: [Site address]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-CSRF-Token
 *         schema:
 *           type: string
 *         description: Double-submit CSRF token — the value of the non-HttpOnly `wjs_csrf` cookie.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ipLiterals, currentPassword, rev]
 *             properties:
 *               ipLiterals:
 *                 type: string
 *                 enum: [any, own, none]
 *               ipSignIn:
 *                 type: boolean
 *               currentPassword:
 *                 type: string
 *               rev:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Saved (or `unchanged`)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 rev:
 *                   type: integer
 *                 unchanged:
 *                   type: boolean
 *                 warnings:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: rest_invalid_param.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       403:
 *         description: rest_bad_current_password, rest_forbidden, rest_token_management_forbidden, or a CSRF refusal.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       409:
 *         description: rest_site_address_stale.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       503:
 *         description: rest_config_unreadable.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.put('/policy', asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    if (await requireSudoPassword(req, res, body.currentPassword)) return;
    const rev = revFrom(body);
    if (rev === null) return missingRev(res);
    await siteAddress.ensureStarted();
    try {
        const result = await siteAddress.commit(
            (cfg: any) => siteAddress.planPolicy(cfg, { ipLiterals: body.ipLiterals, ipSignIn: body.ipSignIn }),
            { expectRev: rev, via: 'ui', actorId: req.user.id });
        res.json(result);
    } catch (e) {
        sendError(res, e);
    }
}));

module.exports = router;
