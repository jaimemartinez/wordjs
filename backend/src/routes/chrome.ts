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
const { legacyChromeComposition, migrateLegacyChrome } = require('../core/chrome-legacy');

/**
 * @swagger
 * tags:
 *   name: Chrome
 *   description: Composable site chrome (header/footer compositions)
 */

// header/footer are the masthead + footer landmarks; announcement is the optional top bar the public
// layout renders full-bleed above the header. All three are resolved by the layout itself (never a
// template part) and validated by chrome-validate at their own position — announcement bars ChromeNav
// because the header already mounts the one mobile drawer.
const PARTS = ['header', 'footer', 'announcement'];

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
 *           enum: [header, footer, announcement]
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
 *           enum: [header, footer, announcement]
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

/**
 * @swagger
 * /chrome/{part}/legacy:
 *   get:
 *     summary: The built-in (pre-composition) chrome for a part, converted to a composition (Admin)
 *     description: Read-only. What the editor opens when neither the site nor the theme has a composition.
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
 *         description: "{ part, data } — data is a valid composition"
 *       400:
 *         description: Invalid part (the announcement bar has no built-in form)
 */
router.get('/:part/legacy', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const { part } = req.params as { part: string };
    if (part !== 'header' && part !== 'footer') return invalidPart(res);
    res.json({ part, data: await legacyChromeComposition(part) });
}));

/**
 * @swagger
 * /chrome/migrate-legacy:
 *   post:
 *     summary: Convert the legacy footer settings into the site footer composition (Admin)
 *     description: >
 *       Lossless (the legacy options are kept) and idempotent (writes only when the site has no footer
 *       composition yet). Skips a site whose active theme ships its own chrome/footer.json — that file,
 *       not the legacy footer, is what renders there.
 *     tags: [Chrome]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ footer, header } — each one of migrated | site-composition | theme-composition | nothing-to-migrate"
 */
router.post('/migrate-legacy', authenticate, isAdmin, asyncHandler(async (_req: Request, res: Response) => {
    res.json(await migrateLegacyChrome());
}));

module.exports = router;
