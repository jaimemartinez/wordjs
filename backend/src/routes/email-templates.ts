/**
 * WordJS — /email-templates: Settings → Emails (core/email-templates).
 *
 * authenticate → isAdmin → sessionOnly for everything (an API token never rewrites what the site mails).
 * Editing or resetting a SECURITY message (sign-in mail, the site-address notice) re-authenticates with the
 * administrator's password (requireSudoPassword, the shared door of routes/users.ts). Every write is
 * audited with the message and the language — never the text.
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { authenticate, sessionOnly } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireSudoPassword } = require('./users');
const { recordAudit } = require('../core/audit');
const emailTemplates = require('../core/email-templates');

router.use(authenticate, isAdmin, sessionOnly);

function sendError(res: Response, e: any): void {
    if (e && e instanceof emailTemplates.EmailTemplateError) {
        res.status(e.status).json({ code: e.code, message: e.message, data: { status: e.status } });
        return;
    }
    throw e;
}

function draftOf(body: any) {
    const d = body && body.draft;
    if (!d || typeof d !== 'object') return undefined;
    return {
        subject: typeof d.subject === 'string' ? d.subject : undefined,
        body: typeof d.body === 'string' ? d.body : undefined,
        actionLabel: typeof d.actionLabel === 'string' ? d.actionLabel : undefined,
    };
}

/**
 * @swagger
 * tags:
 *   - name: Emails
 *     description: The words and the layout of the messages the site sends.
 * /email-templates:
 *   get:
 *     summary: List the site's messages and the email layout
 *     description: >-
 *       Every message in the registry (core and plugin), with its placeholders and the languages an
 *       administrator edited, plus the layout settings and the site's language. Administrators only.
 *     tags: [Emails]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The messages and the layout.
 */
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
        templates: await emailTemplates.listSummaries(),
        layout: await emailTemplates.getLayout(),
        languages: emailTemplates.EMAIL_LANGS,
        siteLanguage: await emailTemplates.siteLang(),
    });
}));

/**
 * @swagger
 * /email-templates/layout:
 *   put:
 *     summary: Change the layout every message is sent in
 *     description: >-
 *       Button colour and background (#rrggbb, empty = the theme's primary colour / the default), whether
 *       the header shows the site logo, and one plain-text footer line. Audited.
 *     tags: [Emails]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               accentColor: { type: string }
 *               backgroundColor: { type: string }
 *               showLogo: { type: boolean }
 *               footerText: { type: string }
 *     responses:
 *       200:
 *         description: The saved layout.
 *       400:
 *         description: An invalid colour.
 */
router.put('/layout', asyncHandler(async (req: Request, res: Response) => {
    try {
        const layout = await emailTemplates.saveLayout(req.body || {});
        await recordAudit(req.user.id, 'email_layout.update', 'settings', 0, { accentColor: layout.accentColor, backgroundColor: layout.backgroundColor, showLogo: layout.showLogo });
        res.json(await emailTemplates.getLayout());
    } catch (e) {
        sendError(res, e);
    }
}));

/**
 * @swagger
 * /email-templates/{id}:
 *   get:
 *     summary: One message in every language
 *     description: The text in use per language (the administrator's edit or the default) and the defaults.
 *     tags: [Emails]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: The message.
 *       404:
 *         description: No such message.
 */
router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
        res.json(await emailTemplates.describeTemplate(String(req.params.id)));
    } catch (e) {
        sendError(res, e);
    }
}));

/**
 * @swagger
 * /email-templates/{id}/{lang}:
 *   put:
 *     summary: Edit one message in one language
 *     description: >-
 *       Subject (one plain line), body (HTML, kept to the mail allowlist) and, for a message with a button,
 *       the button text. The button's link is always added by the site and cannot be edited. A sign-in or
 *       site-address message also requires the current password. Audited.
 *     tags: [Emails]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: lang, required: true, schema: { type: string, enum: [en, es, pt] } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subject, body]
 *             properties:
 *               subject: { type: string }
 *               body: { type: string }
 *               actionLabel: { type: string }
 *               currentPassword: { type: string }
 *     responses:
 *       200:
 *         description: The message after the edit.
 *       400:
 *         description: An empty subject, body or button text, or an unknown language.
 *       403:
 *         description: Wrong current password, or not an administrator.
 *       404:
 *         description: No such message.
 */
router.put('/:id/:lang', asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    try {
        const t = emailTemplates.getTemplate(String(req.params.id));
        if (t.security && await requireSudoPassword(req, res, body.currentPassword)) return;
        await emailTemplates.saveTemplate(t.id, String(req.params.lang), { subject: body.subject, body: body.body, actionLabel: body.actionLabel });
        await recordAudit(req.user.id, 'email_template.update', 'email_template', t.id, { template: t.id, lang: String(req.params.lang) });
        res.json(await emailTemplates.describeTemplate(t.id));
    } catch (e) {
        sendError(res, e);
    }
}));

/**
 * @swagger
 * /email-templates/{id}/reset:
 *   post:
 *     summary: Go back to a message's default text
 *     description: >-
 *       Drops the administrator's edit for one language (`lang`) or for every language (no `lang`). A
 *       sign-in or site-address message also requires the current password. Audited.
 *     tags: [Emails]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               lang: { type: string, enum: [en, es, pt] }
 *               currentPassword: { type: string }
 *     responses:
 *       200:
 *         description: The message with its defaults.
 *       403:
 *         description: Wrong current password, or not an administrator.
 *       404:
 *         description: No such message.
 */
router.post('/:id/reset', asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    try {
        const t = emailTemplates.getTemplate(String(req.params.id));
        if (t.security && await requireSudoPassword(req, res, body.currentPassword)) return;
        const lang = typeof body.lang === 'string' && body.lang ? body.lang : undefined;
        await emailTemplates.resetTemplate(t.id, lang);
        await recordAudit(req.user.id, 'email_template.reset', 'email_template', t.id, { template: t.id, lang: lang || 'all' });
        res.json(await emailTemplates.describeTemplate(t.id));
    } catch (e) {
        sendError(res, e);
    }
}));

/**
 * @swagger
 * /email-templates/{id}/preview:
 *   post:
 *     summary: Render a message with sample values
 *     description: >-
 *       The full layout, the subject and the plain-text part, for the stored text or for an unsaved
 *       `draft` ({subject, body, actionLabel}) and an unsaved `layout`. Nothing is stored or sent.
 *     tags: [Emails]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               lang: { type: string, enum: [en, es, pt] }
 *               draft: { type: object }
 *               layout: { type: object }
 *     responses:
 *       200:
 *         description: The rendered message.
 *       404:
 *         description: No such message.
 */
router.post('/:id/preview', asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    res.setHeader('Cache-Control', 'private, no-store');
    try {
        const layout = body.layout && typeof body.layout === 'object' ? body.layout : undefined;
        res.json(await emailTemplates.renderSample(String(req.params.id), String(body.lang || ''), draftOf(body), layout));
    } catch (e) {
        sendError(res, e);
    }
}));

/**
 * @swagger
 * /email-templates/{id}/test:
 *   post:
 *     summary: Send a message with sample values to yourself
 *     description: >-
 *       Renders the stored text (or a `draft`) with sample values and a harmless sample link, and sends it
 *       to the signed-in administrator's own address through the message's transport (account email for
 *       sign-in messages, the site's mail provider for the others).
 *     tags: [Emails]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               lang: { type: string, enum: [en, es, pt] }
 *               draft: { type: object }
 *     responses:
 *       200:
 *         description: The message was accepted by the transport.
 *       409:
 *         description: No transport can carry this message, or the account has no email address.
 *       502:
 *         description: The mail server refused the message.
 */
router.post('/:id/test', asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    try {
        const to = String((req.user && (req.user.userEmail || req.user.email)) || '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
            return res.status(409).json({ code: 'email_no_address', message: 'Your account has no email address to send the test to.', data: { status: 409 } });
        }
        await emailTemplates.sendSample(String(req.params.id), String(body.lang || ''), to, draftOf(body));
        res.json({ sent: true, to });
    } catch (e) {
        sendError(res, e);
    }
}));

module.exports = router;
