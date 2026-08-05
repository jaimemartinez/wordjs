/**
 * WordJS - Composable Chrome Routes
 * /api/v1/chrome/*
 *
 * Writes the SITE-level chrome compositions (options site_chrome_header / site_chrome_footer,
 * stored as JSON strings) — the highest precedence level of the effective chrome, above the
 * active theme's chrome/*.json and the theme.json layout variant. chrome-validate is the write
 * AUTHORITY: nothing invalid is ever stored (the renderer's fail-closed fallback is a safety
 * net, not the contract). Reads travel through the public /api/v1/settings payload.
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { updateOption, deleteOption } = require('../core/options');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateChromeData } = require('../core/chrome-validate');
const { purgeFrontend } = require('../core/frontend-purge');

/**
 * @swagger
 * tags:
 *   name: Chrome
 *   description: Composable site chrome (header/footer compositions)
 */

const PARTS = ['header', 'footer'];

const invalidPart = (res: Response) => res.status(400).json({
    code: 'rest_invalid_param',
    message: `Invalid chrome part — expected one of: ${PARTS.join(', ')}.`,
    data: { status: 400 }
});

/**
 * @swagger
 * /chrome/{part}:
 *   put:
 *     summary: Validate and store a site chrome composition (Admin)
 *     tags: [Chrome]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: part
 *         required: true
 *         schema:
 *           type: string
 *           enum: [header, footer]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               data:
 *                 type: object
 *                 description: Puck Data JSON ({ root, content }) per the chrome contract v1
 *     responses:
 *       200:
 *         description: Composition stored
 *       400:
 *         description: Invalid part or composition (body carries the validator errors)
 */
router.put('/:part', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const { part } = req.params as { part: string };
    if (!PARTS.includes(part)) return invalidPart(res);

    const { data } = (req.body || {}) as { data?: any };
    const result = validateChromeData(data, { part });
    if (!result.ok) {
        return res.status(400).json({
            code: 'chrome_invalid',
            message: `The ${part} composition violates the chrome contract.`,
            errors: result.errors,
            data: { status: 400 }
        });
    }

    // Stored as a JSON string (the contract's storage form). The updated_option hook fires the
    // frontend purge — site_chrome_* is in frontend-purge's SETTINGS_OPTIONS.
    await updateOption('site_chrome_' + part, JSON.stringify(data));

    res.json({ part, saved: true });
}));

/**
 * @swagger
 * /chrome/{part}:
 *   delete:
 *     summary: Remove the site chrome composition — falls back to the theme's chrome/variant (Admin)
 *     tags: [Chrome]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: part
 *         required: true
 *         schema:
 *           type: string
 *           enum: [header, footer]
 *     responses:
 *       200:
 *         description: Composition removed (deleted=false when none was stored)
 *       400:
 *         description: Invalid part
 */
router.delete('/:part', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const { part } = req.params as { part: string };
    if (!PARTS.includes(part)) return invalidPart(res);

    const deleted = await deleteOption('site_chrome_' + part);
    // deleteOption fires no updated_option hook, so purge explicitly — the public pages must
    // re-render with the next precedence level (theme chrome / layout variant).
    if (deleted) purgeFrontend(['settings'], ['/']);

    res.json({ part, deleted: !!deleted });
}));

module.exports = router;
