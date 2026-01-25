/**
 * WordJS - Settings Routes
 * /api/v1/settings/*
 */

const express = require('express');
const router = express.Router();
const { getOption, updateOption } = require('../core/options');
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
    'large_size_w',
    'large_size_h',
    'backup_schedule' // Backup Scheduler Frequency
];

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
router.get('/', asyncHandler(async (req, res) => {
    const settings = {};

    for (const key of PUBLIC_SETTINGS) {
        settings[key] = await getOption(key);
    }

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
router.get('/all', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const settings = {};

    for (const key of ALL_SETTINGS) {
        settings[key] = await getOption(key);
    }

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
router.get('/:key', asyncHandler(async (req, res) => {
    const { key } = req.params;

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
router.put('/', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const updates = req.body;
    const updated = {};

    for (const [key, value] of Object.entries(updates)) {
        if (ALL_SETTINGS.includes(key)) {
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
router.put('/:key', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { value } = req.body;

    if (!ALL_SETTINGS.includes(key)) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: 'Invalid setting key.',
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
router.get('/notices', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const notices = await getOption('admin_notices', []);
    res.json(notices);
}));

/**
 * DELETE /notices/:id
 * Dismiss a notice
 */
router.delete('/notices/:id', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    let notices = await getOption('admin_notices', []);

    // Filter out the dismissed notice
    const initialLength = notices.length;
    notices = notices.filter(n => n.id !== id);

    if (notices.length !== initialLength) {
        await updateOption('admin_notices', notices);
    }

    res.json({ success: true, remaining: notices.length });
}));

module.exports = router;
