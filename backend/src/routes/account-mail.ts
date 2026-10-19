/**
 * WordJS — /account-mail: how password-reset and verification email is delivered (core/account-mail).
 *
 * authenticate → isAdmin → sessionOnly for everything (an API token never re-routes account mail), and
 * every WRITE re-authenticates with the administrator's password (requireSudoPassword, the shared door of
 * routes/users.ts) and is audited: choosing who may carry reset links is choosing who may take over
 * accounts. The relay password is write-only — reads answer `hasPassword`.
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { authenticate, sessionOnly } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireSudoPassword } = require('./users');
const { recordAudit } = require('../core/audit');
const accountMail = require('../core/account-mail');

router.use(authenticate, isAdmin, sessionOnly);

function sendError(res: Response, e: any): void {
    if (e && e instanceof accountMail.AccountMailError) {
        res.status(e.status).json({ code: e.code, message: e.message, data: { status: e.status } });
        return;
    }
    throw e;
}

/**
 * @swagger
 * tags:
 *   - name: Account email
 *     description: How password-reset and verification email is delivered.
 * /account-mail:
 *   get:
 *     summary: How account email is delivered
 *     description: >-
 *       The built-in SMTP transport's settings (never its password), the mail provider plugin that is
 *       live, whether it is allowed to carry account email, and which route a reset link would take now
 *       (core = built-in transport, provider = an allowed plugin, none = not delivered). Administrators only.
 *     tags: [Account email]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The current routing.
 */
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await accountMail.getStatus());
}));

/**
 * @swagger
 * /account-mail/smtp:
 *   put:
 *     summary: Configure the built-in SMTP transport for account email
 *     description: >-
 *       Host, port, security (tls, starttls, or none — none only to a server on this machine), username,
 *       password (only changed when sent), from address and name. `clear: true` removes the transport.
 *       Requires the current password. Audited.
 *     tags: [Account email]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword]
 *             properties:
 *               host: { type: string }
 *               port: { type: integer }
 *               security: { type: string, enum: [tls, starttls, none] }
 *               username: { type: string }
 *               password: { type: string }
 *               fromAddress: { type: string }
 *               fromName: { type: string }
 *               clear: { type: boolean }
 *               currentPassword: { type: string }
 *     responses:
 *       200:
 *         description: The new routing.
 *       400:
 *         description: An invalid value, or a relay address this site may not use.
 *       403:
 *         description: Wrong current password, or not an administrator.
 */
router.put('/smtp', asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    if (await requireSudoPassword(req, res, body.currentPassword)) return;
    try {
        const result = await accountMail.saveSmtpSettings(body);
        await recordAudit(req.user.id, 'account_mail.smtp', 'settings', 0, { configured: result.configured, host: result.host, passwordChanged: result.passwordChanged });
        res.json(await accountMail.getStatus());
    } catch (e) {
        sendError(res, e);
    }
}));

/**
 * @swagger
 * /account-mail/test:
 *   post:
 *     summary: Send a test message through the built-in SMTP transport
 *     description: Never through a plugin. Administrators only.
 *     tags: [Account email]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [to]
 *             properties:
 *               to: { type: string }
 *     responses:
 *       200:
 *         description: The relay accepted the message.
 *       409:
 *         description: The built-in transport is not configured.
 *       502:
 *         description: The relay refused the message or could not be reached.
 */
router.post('/test', asyncHandler(async (req: Request, res: Response) => {
    try {
        await accountMail.sendTest(String((req.body || {}).to || ''));
        res.json({ sent: true });
    } catch (e) {
        sendError(res, e);
    }
}));

/**
 * @swagger
 * /account-mail/provider:
 *   put:
 *     summary: Allow (or stop allowing) a mail provider plugin to carry account email
 *     description: >-
 *       A plugin allowed here receives password-reset and verification links, so it can take over any
 *       account, administrators included. Used only while the built-in transport is not configured.
 *       Requires the current password. Audited.
 *     tags: [Account email]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [slug, allowed, currentPassword]
 *             properties:
 *               slug: { type: string }
 *               allowed: { type: boolean }
 *               currentPassword: { type: string }
 *     responses:
 *       200:
 *         description: The new routing.
 *       400:
 *         description: Invalid plugin name or flag.
 *       403:
 *         description: Wrong current password, or not an administrator.
 */
router.put('/provider', asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    if (typeof body.allowed !== 'boolean') {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'allowed must be true or false.', data: { status: 400 } });
    }
    if (await requireSudoPassword(req, res, body.currentPassword)) return;
    try {
        const allowedList = await accountMail.setProviderAllowed(String(body.slug || ''), body.allowed);
        await recordAudit(req.user.id, 'account_mail.provider', 'plugin', 0, { plugin: String(body.slug), allowed: body.allowed, allowedProviders: allowedList });
        res.json(await accountMail.getStatus());
    } catch (e) {
        sendError(res, e);
    }
}));

module.exports = router;
