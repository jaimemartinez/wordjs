/**
 * WordJS - Settings Routes
 * /api/v1/settings/*
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { getOption, updateOption } = require('../core/options');
const { getActiveThemeVersion } = require('../core/themes');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * @swagger
 * tags:
 *   name: Settings
 *   description: Site configuration
 */

// Public settings that can be viewed without authentication
const PUBLIC_SETTINGS = [
    'blogname',
    'blogdescription',
    'siteurl',
    'home',
    'timezone_string',
    'date_format',
    'time_format',
    'start_of_week',
    'posts_per_page',
    'site_logo',
    'homepage_id',
    'footer_text',
    'footer_copyright',
    'footer_socials',
    'comments_enabled',
    'site_icon',
    'template',             // active theme SLUG (getActiveTheme) — lets the SSR public layout render
                            // the theme stylesheet <link> on first paint (no FOUC). Already public:
                            // the slug is visible in the /themes/<slug>/style.css URL anyway.
    'active_theme_layout',  // active theme's structure config (JSON) for the SSR public layout
    'active_theme_mods',    // active theme's live token overrides (JSON) from the customizer
    'site_chrome_header',   // site-level composable chrome (JSON, contract v1) — the SSR public
    'site_chrome_footer',   //   layout renders these; written ONLY via PUT /api/v1/chrome/:part
    'users_can_register',
    // 'admin_email' - SECURITY: Removed from public to prevent email harvesting
    'default_role',
    'comment_registration'
];

// All settings that can be modified
const ALL_SETTINGS = [
    ...PUBLIC_SETTINGS,
    'admin_email', // SECURITY: Admin-only access
    'default_category',
    'default_post_format',
    'show_on_front',
    'page_on_front',
    'page_for_posts',
    'blog_public',
    'default_pingback_flag',
    'default_ping_status',
    'default_comment_status',
    'comments_notify',
    'moderation_notify',
    'comment_moderation',
    'require_name_email',
    'comment_previously_approved',
    'comment_max_links',
    'permalink_structure',
    'thumbnail_size_w',
    'thumbnail_size_h',
    'medium_size_w',
    'medium_size_h',
    'large_size_w',
    'large_size_h',
    'backup_schedule', // Backup Scheduler Frequency
    'backup_time',     // Backup Time of Day (HH:mm)
    'backup_day'       // Backup Day (0-6)
];

// Publicly readable, but NOT writable through the generic settings writers: these have a
// dedicated API that validates before storing (chrome-validate is the write authority for
// site_chrome_* — see routes/chrome.ts). Writing them here would bypass that validation.
const DEDICATED_WRITE_API = new Set(['site_chrome_header', 'site_chrome_footer']);

// Public settings that are DERIVED, not stored. Computed per request from the memoized theme scan
// (core/themes), so they add no SQL and no fs to the read path — and deliberately absent from
// ALL_SETTINGS, because an option row for one of these could only ever drift from the theme on disk.
const DERIVED_PUBLIC_SETTINGS: Record<string, () => Promise<any>> = {
    // theme.json `version` of the ACTIVE theme. The frontend appends it to the theme stylesheet URL
    // so an in-place theme edit (PUT /api/v1/themes/:slug bumps the patch) busts the browser/CDN
    // copy — the build-time asset version cannot see that edit. That route purges the 'settings' tag.
    active_theme_version: getActiveThemeVersion
};

const derivedSetting = (key: string) =>
    // hasOwnProperty, not `in`: `constructor`/`toString` must not resolve through the prototype.
    Object.prototype.hasOwnProperty.call(DERIVED_PUBLIC_SETTINGS, key) ? DERIVED_PUBLIC_SETTINGS[key] : null;

/**
 * @swagger
 * /settings:
 *   get:
 *     summary: Get public site settings
 *     tags: [Settings]
 *     responses:
 *       200:
 *         description: Key-value map of public settings
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const settings: Record<string, any> = {};

    await Promise.all([
        ...PUBLIC_SETTINGS.map(async (key) => {
            settings[key] = await getOption(key);
        }),
        ...Object.entries(DERIVED_PUBLIC_SETTINGS).map(async ([key, compute]) => {
            settings[key] = await compute();
        })
    ]);

    res.json(settings);
}));

/**
 * @swagger
 * /settings/all:
 *   get:
 *     summary: Get all settings (Admin)
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Key-value map of all settings
 *       403:
 *         description: Forbidden
 */
router.get('/all', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const settings: Record<string, any> = {};

    await Promise.all(ALL_SETTINGS.map(async (key) => {
        settings[key] = await getOption(key);
    }));

    res.json(settings);
}));

/**
 * @swagger
 * /settings/{key}:
 *   get:
 *     summary: Get a single setting
 *     tags: [Settings]
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Setting value
 *       403:
 *         description: Forbidden (if private)
 */
router.get('/:key', asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params as { key: string };

    const compute = derivedSetting(key);
    if (compute) {
        return res.json({ key, value: await compute() });
    }

    // Check if it's a public setting
    if (!PUBLIC_SETTINGS.includes(key)) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'This setting is not publicly accessible.',
            data: { status: 403 }
        });
    }

    const value = await getOption(key);

    res.json({
        key,
        value
    });
}));

/**
 * @swagger
 * /settings:
 *   put:
 *     summary: Update multiple settings
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             example:
 *               blogname: "My Awesome Site"
 *               posts_per_page: 10
 *     responses:
 *       200:
 *         description: Settings updated
 */
router.put('/', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const updates = req.body;
    const updated: Record<string, any> = {};

    for (const [key, value] of Object.entries(updates)) {
        if (ALL_SETTINGS.includes(key) && !DEDICATED_WRITE_API.has(key)) {
            await updateOption(key, value);
            updated[key] = value;
        }
    }

    res.json(updated);
}));

/**
 * @swagger
 * /settings/{key}:
 *   put:
 *     summary: Update a single setting
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               value:
 *                 type: string
 *     responses:
 *       200:
 *         description: Setting updated
 */
router.put('/:key', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params as { key: string };
    const { value } = req.body;

    if (!ALL_SETTINGS.includes(key) || DEDICATED_WRITE_API.has(key)) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: DEDICATED_WRITE_API.has(key)
                ? 'This setting is managed by its dedicated API (PUT /api/v1/chrome/:part).'
                : 'Invalid setting key.',
            data: { status: 400 }
        });
    }

    await updateOption(key, value);

    res.json({
        key,
        value: await getOption(key)
    });
}));

/**
 * GET /notices
 * Get admin notices (admin only)
 */
router.get('/notices', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const notices = await getOption('admin_notices', []);
    res.json(notices);
}));

/**
 * DELETE /notices/:id
 * Dismiss a notice
 */
router.delete('/notices/:id', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    let notices = await getOption('admin_notices', []);

    // Filter out the dismissed notice
    const initialLength = notices.length;
    notices = notices.filter((n: any) => n.id !== id);

    if (notices.length !== initialLength) {
        await updateOption('admin_notices', notices);
    }

    res.json({ success: true, remaining: notices.length });
}));

module.exports = router;
