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

// The event catalog (for building a subscription UI).
router.get('/events', (_req: Request, res: Response) => {
    res.json({ events: Webhook.EVENTS });
});

// Redeliver a specific delivery (literal prefix — declared before the /:id routes).
router.post('/deliveries/:deliveryId/redeliver', sessionOnly, asyncHandler(async (req: Request, res: Response) => {
    const id = parseId(req.params.deliveryId);
    if (!id) return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid delivery id.', data: { status: 400 } });
    const ok = await WebhookDelivery.requeue(id, Math.floor(Date.now() / 1000));
    if (!ok) return res.status(404).json({ code: 'rest_not_found', message: 'Delivery not found.', data: { status: 404 } });
    res.json({ requeued: true, id });
}));

// List all webhooks.
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    res.json({ webhooks: await Webhook.list() });
}));

// Create a webhook. Returns the signing secret ONCE.
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
router.get('/:id/deliveries', asyncHandler(async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid id.', data: { status: 400 } });
    if (!(await Webhook.findById(id))) return res.status(404).json({ code: 'rest_not_found', message: 'Webhook not found.', data: { status: 404 } });
    res.json({ deliveries: await WebhookDelivery.listForWebhook(id, 50) });
}));

// Rotate the signing secret. Returns the new secret ONCE.
router.post('/:id/rotate-secret', sessionOnly, asyncHandler(async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid id.', data: { status: 400 } });
    const rotated = await Webhook.rotateSecret(id);
    if (!rotated) return res.status(404).json({ code: 'rest_not_found', message: 'Webhook not found.', data: { status: 404 } });
    res.json({ ...rotated, message: 'Save this signing secret now — it will not be shown again.' });
}));

// Get one webhook.
router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid id.', data: { status: 400 } });
    const wh = await Webhook.findById(id);
    if (!wh) return res.status(404).json({ code: 'rest_not_found', message: 'Webhook not found.', data: { status: 404 } });
    res.json(wh);
}));

// Update a webhook (name/url/events/active).
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
router.delete('/:id', sessionOnly, asyncHandler(async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid id.', data: { status: 400 } });
    const ok = await Webhook.delete(id);
    if (!ok) return res.status(404).json({ code: 'rest_not_found', message: 'Webhook not found.', data: { status: 404 } });
    res.json({ deleted: true, id });
}));

module.exports = router;
