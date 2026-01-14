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
    'site_icon'
];

// All settings that can be modified
const ALL_SETTINGS = [
    ...PUBLIC_SETTINGS,
    'admin_email',
    'users_can_register',
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
    'large_size_h'
];

/**
 * GET /settings
 * Get all public settings
 */
router.get('/', asyncHandler(async (req, res) => {
    const settings = {};

    for (const key of PUBLIC_SETTINGS) {
        settings[key] = getOption(key);
    }

    res.json(settings);
}));

/**
 * GET /settings/all
 * Get all settings (admin only)
 */
router.get('/all', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const settings = {};

    for (const key of ALL_SETTINGS) {
        settings[key] = getOption(key);
    }

    res.json(settings);
}));

/**
 * GET /settings/:key
 * Get single setting
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

    const value = getOption(key);

    res.json({
        key,
        value
    });
}));

/**
 * PUT /settings
 * Update multiple settings (admin only)
 */
router.put('/', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const updates = req.body;
    const updated = {};

    for (const [key, value] of Object.entries(updates)) {
        if (ALL_SETTINGS.includes(key)) {
            updateOption(key, value);
            updated[key] = value;
        }
    }

    res.json(updated);
}));

/**
 * PUT /settings/:key
 * Update single setting (admin only)
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

    updateOption(key, value);

    res.json({
        key,
        value: getOption(key)
    });
}));

module.exports = router;
