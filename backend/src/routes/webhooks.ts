/**
 * WordJS - Webhooks admin API (/api/v1/webhooks).
 *
 * Administrator-only (webhooks can exfiltrate content changes, so this is not a per-user feature). All
 * MUTATIONS additionally require an interactive session (sessionOnly): a leaked admin API token must not
 * be able to plant an exfiltration endpoint or rotate a secret — token CRUD is blocked the same way.
 */

import type { NextFunction, Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const Webhook = require('../models/Webhook');
const WebhookDelivery = require('../models/WebhookDelivery');

// Whole resource is admin-only.
//
// THESE TWO LINES ARE PART OF EVERY OPERATION'S PUBLISHED CONTRACT. Router-level middleware is
// invisible from the @swagger block underneath it, and that is exactly how eight operations came to
// document 400/403/404 while an unauthenticated call answers 401 `rest_not_logged_in` — a status none
// of them named. A client that switches on the refusal code cannot handle a code the spec never
// mentions, so every block below declares the 401 this line produces, in the same words.
router.use(authenticate);
router.use(isAdmin);

// Block API-token callers from managing webhooks (anti-persistence — mirrors /auth/tokens sessionOnly).
// `apiToken` is the mark `authenticate` stamps on token-authenticated requests (middleware/auth.ts,
// markHeadless). It is declared on Request itself in src/types/globals.d.ts, so this gate reads the one
// shared declaration; the local copy this router used to carry was one of three hand-written
// declarations of the same runtime field, which TypeScript had no way to compare.
function sessionOnly(req: Request, res: Response, next: NextFunction) {
    if (req.apiToken) {
        return res.status(403).json({
            code: 'rest_token_management_forbidden',
            message: 'API tokens cannot manage webhooks. Sign in interactively.',
            data: { status: 403 }
        });
    }
    next();
}

const { routeIdOrNull } = require('../core/query-params');

/**
 * @swagger
 * components:
 *   schemas:
 *     Webhook:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         userId:
 *           type: integer
 *         name:
 *           type: string
 *         url:
 *           type: string
 *         events:
 *           type: array
 *           items:
 *             type: string
 *         secretPrefix:
 *           type: string
 *           description: The first characters of the signing secret. The secret itself is returned only by the create and rotate-secret operations.
 *         active:
 *           type: boolean
 *         failureCount:
 *           type: integer
 *           description: Consecutive failed deliveries. The endpoint is auto-paused at 20.
 *         lastDeliveryAt:
 *           type: integer
 *           nullable: true
 *           description: Unix seconds.
 *         createdAt:
 *           type: string
 *     WebhookDelivery:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         webhookId:
 *           type: integer
 *         event:
 *           type: string
 *         status:
 *           type: string
 *         attempts:
 *           type: integer
 *         responseStatus:
 *           type: integer
 *           nullable: true
 *         error:
 *           type: string
 *           nullable: true
 *         nextAttemptAt:
 *           type: integer
 *           nullable: true
 *         deliveredAt:
 *           type: integer
 *           nullable: true
 *         createdAt:
 *           type: string
 *         payload:
 *           type: string
 */
const MAX_WEBHOOKS = 100;

/**
 * The webhook/delivery id `v` denotes, or null when it denotes none — i.e. a 400 from every caller.
 *
 * THE STATUS IS UNCHANGED ON PURPOSE. This router has always answered 400 `rest_invalid_param` for an
 * id it cannot use, and that is part of its published contract; flipping it to the 404 the taxonomy
 * routers send would be a breaking change this defect does not justify. What changes is the
 * PREDICATE, which is now the single shared one from core/query-params.
 *
 * The local one was `Number.isInteger(n) && n > 0` over a `parseInt`, which checked integrality and
 * positivity and nothing else, so it admitted both spellings of "cannot be an id":
 *   · `9999999999` is an integer greater than zero, and wider than the 32-bit `webhooks.id` column —
 *     Postgres answers `22003 value out of range for type integer` and the caller gets a 500;
 *   · `12abc` parses to 12, so every webhook was addressable under an unbounded family of URLs.
 */
function parseId(v: any): number | null {
    return routeIdOrNull(v);
}

/**
 * @swagger
 * tags:
 *   name: Webhooks
 *   description: Administrator-only management of outgoing webhook subscriptions. WordJS POSTs a JSON body to each registered endpoint when a content event fires. Every delivery carries the headers X-WordJS-Event, X-WordJS-Delivery, X-WordJS-Timestamp and X-WordJS-Signature-256. The signature is the string sha256= followed by the hex HMAC-SHA256 of "<timestamp>.<rawBody>" keyed with that endpoint signing secret, so a receiver must recompute it before trusting a payload. SSRF policy - a target must be http or https, and any host that resolves to loopback, link-local, RFC1918 or cloud-metadata space is refused both at registration and again at delivery time; the connection is pinned to the validated address and redirects are never followed. Every mutation additionally requires an interactive session, so API-token callers are refused with rest_token_management_forbidden.
 */
// The event catalog (for building a subscription UI).
/**
 * @swagger
 * /webhooks/events:
 *   get:
 *     summary: List the event names a webhook can subscribe to
 *     description: The catalog is fixed. A subscription may also use a family wildcard such as post.* or a bare * for everything.
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The event catalog
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events:
 *                   type: array
 *                   items:
 *                     type: string
 *                     enum: [post.created, post.published, post.updated, post.deleted, comment.created, comment.deleted]
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 */
router.get('/events', (_req: Request, res: Response) => {
    res.json({ events: Webhook.EVENTS });
});

// Redeliver a specific delivery (literal prefix — declared before the /:id routes).
/**
 * @swagger
 * /webhooks/deliveries/{deliveryId}/redeliver:
 *   post:
 *     summary: Re-queue one past delivery for another attempt
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: deliveryId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Delivery re-queued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 requeued:
 *                   type: boolean
 *                 id:
 *                   type: integer
 *       400:
 *         description: Unusable delivery id (rest_invalid_param)
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator, or an API token tried to manage webhooks (rest_token_management_forbidden)
 *       404:
 *         description: Delivery not found (rest_not_found)
 */
router.post('/deliveries/:deliveryId/redeliver', sessionOnly, asyncHandler(async (req: Request, res: Response) => {
    const id = parseId(req.params.deliveryId);
    if (!id) return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid delivery id.', data: { status: 400 } });
    const ok = await WebhookDelivery.requeue(id, Math.floor(Date.now() / 1000));
    if (!ok) return res.status(404).json({ code: 'rest_not_found', message: 'Delivery not found.', data: { status: 404 } });
    res.json({ requeued: true, id });
}));

// List all webhooks.
/**
 * @swagger
 * /webhooks:
 *   get:
 *     summary: List every registered webhook
 *     description: Signing secrets are never returned here - each row carries only its non-secret prefix.
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The registered webhooks
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 webhooks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Webhook'
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 */
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    res.json({ webhooks: await Webhook.list() });
}));

// Create a webhook. Returns the signing secret ONCE.
/**
 * @swagger
 * /webhooks:
 *   post:
 *     summary: Register a webhook and return its signing secret once
 *     description: At most 100 webhooks may exist. The response is the only time the plaintext secret is shown; after that only its prefix is readable.
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url]
 *             properties:
 *               url:
 *                 type: string
 *                 description: http or https only. An internal address is refused here and again at delivery time.
 *               name:
 *                 type: string
 *                 description: Free-text label, truncated to 200 characters. Defaults to Webhook.
 *               events:
 *                 description: An array or a comma-separated string of event names, a family wildcard such as post.*, or a bare * for everything. An absent or empty value subscribes to everything; a non-empty value that matches nothing is refused rather than widened.
 *                 oneOf:
 *                   - type: array
 *                     items:
 *                       type: string
 *                   - type: string
 *               active:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       201:
 *         description: Webhook created. The body is the webhook plus the plaintext secret, shown exactly once.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Webhook'
 *                 - type: object
 *                   properties:
 *                     secret:
 *                       type: string
 *                     message:
 *                       type: string
 *       400:
 *         description: Missing url (rest_missing_param), an unusable url or unrecognised events (rest_invalid_webhook), or the 100-webhook ceiling (rest_webhook_limit)
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator, or an API token tried to manage webhooks (rest_token_management_forbidden)
 */
router.post('/', sessionOnly, asyncHandler(async (req: Request, res: Response) => {
    const { name, url, events, active } = req.body || {};
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ code: 'rest_missing_param', message: 'A webhook url is required.', data: { status: 400 } });
    }
    if ((await Webhook.list()).length >= MAX_WEBHOOKS) {
        return res.status(400).json({ code: 'rest_webhook_limit', message: `Maximum of ${MAX_WEBHOOKS} webhooks reached.`, data: { status: 400 } });
    }
    let created;
    try {
        created = await Webhook.create({ userId: req.user.id, name, url, events, active });
    } catch (e: any) {
        return res.status(400).json({ code: 'rest_invalid_webhook', message: e && e.message ? e.message : 'Invalid webhook.', data: { status: 400 } });
    }
    res.status(201).json({ ...created, message: 'Save this signing secret now — it will not be shown again.' });
}));

// Recent deliveries for a webhook (audit log).
/**
 * @swagger
 * /webhooks/{id}/deliveries:
 *   get:
 *     summary: Read the 50 most recent delivery attempts for one webhook
 *     tags: [Webhooks]
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
 *         description: The delivery audit log, newest first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deliveries:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/WebhookDelivery'
 *       400:
 *         description: Unusable id (rest_invalid_param)
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 *       404:
 *         description: Webhook not found (rest_not_found)
 */
router.get('/:id/deliveries', asyncHandler(async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid id.', data: { status: 400 } });
    if (!(await Webhook.findById(id))) return res.status(404).json({ code: 'rest_not_found', message: 'Webhook not found.', data: { status: 404 } });
    res.json({ deliveries: await WebhookDelivery.listForWebhook(id, 50) });
}));

// Rotate the signing secret. Returns the new secret ONCE.
/**
 * @swagger
 * /webhooks/{id}/rotate-secret:
 *   post:
 *     summary: Issue a new signing secret for one webhook
 *     description: The new secret is returned once. Deliveries signed with the old secret stop verifying immediately, so update the receiver in the same window.
 *     tags: [Webhooks]
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
 *         description: Secret rotated. The body is the webhook plus the new plaintext secret, shown exactly once.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Webhook'
 *                 - type: object
 *                   properties:
 *                     secret:
 *                       type: string
 *                     message:
 *                       type: string
 *       400:
 *         description: Unusable id (rest_invalid_param)
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator, or an API token tried to manage webhooks (rest_token_management_forbidden)
 *       404:
 *         description: Webhook not found (rest_not_found)
 */
router.post('/:id/rotate-secret', sessionOnly, asyncHandler(async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid id.', data: { status: 400 } });
    const rotated = await Webhook.rotateSecret(id);
    if (!rotated) return res.status(404).json({ code: 'rest_not_found', message: 'Webhook not found.', data: { status: 404 } });
    res.json({ ...rotated, message: 'Save this signing secret now — it will not be shown again.' });
}));

// Get one webhook.
/**
 * @swagger
 * /webhooks/{id}:
 *   get:
 *     summary: Read one webhook
 *     tags: [Webhooks]
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
 *         description: The webhook
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Webhook'
 *       400:
 *         description: Unusable id (rest_invalid_param)
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 *       404:
 *         description: Webhook not found (rest_not_found)
 */
router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid id.', data: { status: 400 } });
    const wh = await Webhook.findById(id);
    if (!wh) return res.status(404).json({ code: 'rest_not_found', message: 'Webhook not found.', data: { status: 404 } });
    res.json(wh);
}));

// Update a webhook (name/url/events/active).
/**
 * @swagger
 * /webhooks/{id}:
 *   patch:
 *     summary: Update a webhook name, target, events or active flag
 *     description: Only the fields present in the body are changed. The signing secret is not touched - rotate it with the dedicated operation.
 *     tags: [Webhooks]
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
 *               name:
 *                 type: string
 *               url:
 *                 type: string
 *               events:
 *                 oneOf:
 *                   - type: array
 *                     items:
 *                       type: string
 *                   - type: string
 *               active:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: The updated webhook
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Webhook'
 *       400:
 *         description: Unusable id (rest_invalid_param), or an unusable url or unrecognised events (rest_invalid_webhook)
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator, or an API token tried to manage webhooks (rest_token_management_forbidden)
 *       404:
 *         description: Webhook not found (rest_not_found)
 */
router.patch('/:id', sessionOnly, asyncHandler(async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid id.', data: { status: 400 } });
    if (!(await Webhook.findById(id))) return res.status(404).json({ code: 'rest_not_found', message: 'Webhook not found.', data: { status: 404 } });
    const { name, url, events, active } = req.body || {};
    try {
        const updated = await Webhook.update(id, { name, url, events, active });
        res.json(updated);
    } catch (e: any) {
        res.status(400).json({ code: 'rest_invalid_webhook', message: e && e.message ? e.message : 'Invalid webhook.', data: { status: 400 } });
    }
}));

// Delete a webhook.
/**
 * @swagger
 * /webhooks/{id}:
 *   delete:
 *     summary: Delete a webhook
 *     tags: [Webhooks]
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
 *         description: Webhook deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted:
 *                   type: boolean
 *                 id:
 *                   type: integer
 *       400:
 *         description: Unusable id (rest_invalid_param)
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator, or an API token tried to manage webhooks (rest_token_management_forbidden)
 *       404:
 *         description: Webhook not found (rest_not_found)
 */
router.delete('/:id', sessionOnly, asyncHandler(async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid id.', data: { status: 400 } });
    const ok = await Webhook.delete(id);
    if (!ok) return res.status(404).json({ code: 'rest_not_found', message: 'Webhook not found.', data: { status: 404 } });
    res.json({ deleted: true, id });
}));

module.exports = router;
