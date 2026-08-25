/**
 * WordJS - Forms Routes (Webflow "Forms + submissions" parity)
 * /api/v1/forms/*
 *
 * POST /submit is the PUBLIC endpoint a page's form block posts to (no auth — a visitor fills a
 * contact form). Everything else is the admin viewer: list/delete submissions and the DISTINCT
 * form-name picker, all gated on `manage_options` (the same capability the settings/fonts admin
 * surfaces use — a submission can contain visitor PII, so it is an operator-level read).
 *
 * Abuse posture on the public endpoint, in order:
 *   1. per-IP rate limit (formsSubmitLimiter in index.ts, 10/min — the pattern every other
 *      unauthenticated endpoint uses);
 *   2. HARD input bounds (≤30 fields, keys ≤60, values ≤5000, ≤64KB total) — validated BEFORE the
 *      honeypot check so a bot sees byte-identical behavior whether or not it tripped the trap;
 *   3. honeypot `_hp`: a hidden field humans never fill. Non-empty → respond with the EXACT success
 *      payload but store nothing (never reveal the trap);
 *   4. values are stored tag-stripped (stripTags — the same sanitizer guest comment authors go
 *      through), so a submission can never carry markup into the admin viewer.
 */

import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const FormSubmission = require('../models/FormSubmission');
const { authenticate } = require('../middleware/auth');
const { can } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { stripTags } = require('../core/formatting');

const MAX_FORM_NAME = 100;
const MAX_FIELDS = 30;
const MAX_KEY_LEN = 60;
const MAX_VALUE_LEN = 5000;
const MAX_TOTAL_BYTES = 64 * 1024;
const HONEYPOT_FIELD = '_hp';

// The one success payload of POST /submit. A single shared object keeps the honeypot path and the
// real path literally identical — nothing (id, timing-relevant fields, …) may ever distinguish them.
const SUBMIT_OK = { success: true };

function badRequest(res: Response, message: string) {
    return res.status(400).json({ code: 'rest_invalid_param', message, data: { status: 400 } });
}

/**
 * @swagger
 * tags:
 *   name: Forms
 *   description: Public form submissions and their admin viewer
 */

/**
 * @swagger
 * /forms/submit:
 *   post:
 *     summary: Submit a form (public)
 *     tags: [Forms]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [formName, fields]
 *             properties:
 *               formName:
 *                 type: string
 *                 maxLength: 100
 *               pageId:
 *                 type: integer
 *               fields:
 *                 type: object
 *                 additionalProperties:
 *                   type: string
 *     responses:
 *       200:
 *         description: Submission accepted
 *       400:
 *         description: Validation error
 */
router.post('/submit', asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};

    // ---- formName -------------------------------------------------------------------------------
    if (typeof body.formName !== 'string' || !body.formName.trim()) {
        return badRequest(res, 'A form name is required.');
    }
    if (body.formName.length > MAX_FORM_NAME) {
        return badRequest(res, `The form name must be at most ${MAX_FORM_NAME} characters.`);
    }
    const formName = stripTags(body.formName).trim();
    if (!formName) return badRequest(res, 'A form name is required.');

    // ---- pageId (optional soft reference to the page the form lives on) -------------------------
    let pageId: number | null = null;
    if (body.pageId !== undefined && body.pageId !== null) {
        const n = typeof body.pageId === 'number' ? body.pageId : parseInt(body.pageId, 10);
        if (!Number.isInteger(n) || n <= 0) return badRequest(res, 'pageId must be a positive integer.');
        pageId = n;
    }

    // ---- fields: a flat string→string map under HARD bounds --------------------------------------
    const rawFields = body.fields;
    if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) {
        return badRequest(res, 'fields must be an object of string values.');
    }
    const keys = Object.keys(rawFields);
    if (keys.length === 0) return badRequest(res, 'At least one field is required.');
    if (keys.length > MAX_FIELDS) return badRequest(res, `A submission may have at most ${MAX_FIELDS} fields.`);
    for (const key of keys) {
        if (key.length > MAX_KEY_LEN) return badRequest(res, `Field names must be at most ${MAX_KEY_LEN} characters.`);
        const value = rawFields[key];
        if (typeof value !== 'string') return badRequest(res, `Field "${key.slice(0, MAX_KEY_LEN)}" must be a string.`);
        if (value.length > MAX_VALUE_LEN) return badRequest(res, `Field values must be at most ${MAX_VALUE_LEN} characters.`);
    }
    if (Buffer.byteLength(JSON.stringify(rawFields), 'utf8') > MAX_TOTAL_BYTES) {
        return badRequest(res, 'The submission is too large.');
    }

    // ---- honeypot: AFTER validation so both paths behave identically up to this point ------------
    // The block renders `_hp` as a hidden input; humans leave it empty, naive bots fill every field.
    const hpValue = typeof rawFields[HONEYPOT_FIELD] === 'string' ? rawFields[HONEYPOT_FIELD] : '';
    if (hpValue.trim() !== '') {
        return res.status(200).json(SUBMIT_OK); // indistinguishable from success; nothing stored
    }

    // ---- sanitize + store ------------------------------------------------------------------------
    // Values are persisted tag-stripped: the admin viewer renders them, so markup must die here.
    // The (always-empty at this point) honeypot field is dropped — it is plumbing, not an answer.
    const fields: Record<string, string> = {};
    for (const key of keys) {
        if (key === HONEYPOT_FIELD) continue;
        const cleanKey = stripTags(key).trim();
        if (!cleanKey) continue;
        fields[cleanKey] = stripTags(rawFields[key]);
    }
    if (Object.keys(fields).length === 0) return badRequest(res, 'At least one field is required.');

    await FormSubmission.create({
        formName,
        pageId,
        fields,
        ip: req.ip || '',
        userAgent: req.get('User-Agent') || ''
    });

    res.status(200).json(SUBMIT_OK);
}));

/**
 * @swagger
 * /forms/submissions:
 *   get:
 *     summary: List form submissions
 *     tags: [Forms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: formName
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: per_page
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of submissions
 */
router.get('/submissions', authenticate, can('manage_options'), asyncHandler(async (req: Request, res: Response) => {
    const { formName, page = 1, per_page = 20 } = req.query;

    // `?page=1&page=2` and `?page[x]=1` reach here as an array / an object, not a string, and the
    // defaults above are numbers. The explicit `String()` is what `parseInt` already does to its first
    // argument (ToString), so every one of those inputs still yields exactly the number it yielded
    // before: ['1','2'] stringifies to "1,2" and parses to 1, an object to "[object Object]" and so to
    // NaN, which falls through to the `||` default.
    const limit = Math.min(parseInt(String(per_page), 10) || 20, 100);
    const offset = (Math.max(parseInt(String(page), 10) || 1, 1) - 1) * limit;
    const filter = formName !== undefined ? { formName: String(formName) } : {};

    const submissions = await FormSubmission.findAll({ ...filter, limit, offset });
    const total = await FormSubmission.count(filter);
    const totalPages = Math.ceil(total / limit);

    // `res.set` stringifies its value itself (express/lib/response.js), so these are the same bytes
    // on the wire as passing the numbers — the header API just asks for the string it would build.
    res.set('X-WP-Total', String(total));
    res.set('X-WP-TotalPages', String(totalPages));

    res.json(submissions);
}));

/**
 * @swagger
 * /forms/submissions/{id}:
 *   delete:
 *     summary: Delete a form submission
 *     tags: [Forms]
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
 *         description: Submission deleted
 *       404:
 *         description: Submission not found
 */
// `Request<{ id: string }>`: the default params dictionary is `string | string[]` because express 5
// route syntax can repeat a parameter, but a plain `:id` segment yields a single string on every
// express version. Naming the shape keeps `parseInt` reading the value it actually receives.
router.delete('/submissions/:id', authenticate, can('manage_options'), asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
        return badRequest(res, 'Invalid submission ID.');
    }

    const submission = await FormSubmission.findById(id);
    if (!submission) {
        return res.status(404).json({
            code: 'rest_submission_invalid_id',
            message: 'Invalid submission ID.',
            data: { status: 404 }
        });
    }

    await FormSubmission.delete(id);
    res.json({ deleted: true, previous: submission });
}));

/**
 * @swagger
 * /forms/names:
 *   get:
 *     summary: List distinct form names with submission counts
 *     tags: [Forms]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Form names and counts
 */
router.get('/names', authenticate, can('manage_options'), asyncHandler(async (_req: Request, res: Response) => {
    res.json({ names: await FormSubmission.names() });
}));

module.exports = router;
