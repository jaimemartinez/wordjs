/**
 * WordJS - Settings Routes
 * /api/v1/settings/*
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { getOption, updateOption } = require('../core/options');
const { getActiveThemeVersion, isActiveThemeMissing } = require('../core/themes');
// Plugin-sandbox hardening state, surfaced to admins (see DERIVED_ADMIN_SETTINGS below). Required lazily
// inside the compute functions so a load error there can never break the settings route at import time.
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { recordAudit } = require('../core/audit');

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
    'site_chrome_announcement', // optional top/announcement bar, full-bleed above the header
    'users_can_register',
    // 'admin_email' - SECURITY: Removed from public to prevent email harvesting
    'default_role',
    'comment_registration',
    'WPLANG',               // site locale — drives <html lang> (and the RSS <language>, see routes/seo)
    'site_text_direction'   // explicit <html dir> override: '' (derive from WPLANG) | ltr | rtl | auto
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
    'backup_day',      // Backup Day (0-6)
    // Opt-in email verification on self-registration (FRENTE C-3). '1' requires a newly self-registered
    // user to confirm their email via a tokenized link before they can log in; the auth layer fails this
    // CLOSED (treats it as OFF) when no mail provider can deliver. Admin-only (not in PUBLIC_SETTINGS).
    'require_email_verification'
];

// Publicly readable, but NOT writable through the generic settings writers: these have a
// dedicated API that validates before storing (chrome-validate is the write authority for
// site_chrome_* — see routes/chrome.ts). Writing them here would bypass that validation.
// 'template'/'stylesheet' name the ACTIVE THEME, and switching one is far more than an option write:
// switchTheme also republishes the new theme's `layout`, clears the previous theme's customizer mods,
// re-initializes the theme engine (which retires the outgoing theme's isolated functions.js child) and
// fires the switch_theme hook that purges the frontend. Written through here the option moved alone —
// the site then served the new theme's CSS with the old theme's structure and token overrides, and the
// replaced theme's code kept running. Their dedicated API is POST /themes/:slug/activate.
// 'active_theme_layout' is DERIVED: switchTheme publishes the active theme.json's `layout` block, and
// nothing reconciles a value written by hand — the site would render a structure the theme never
// declared, until the next activation silently replaced it. ('active_theme_mods' is deliberately NOT
// here: the customizer saves through this very API, and the overlay sanitizes it at render time.)
const DEDICATED_WRITE_API = new Set([
    'site_chrome_header', 'site_chrome_footer', 'site_chrome_announcement',
    'template', 'stylesheet', 'active_theme_layout',
]);

// Public settings that are DERIVED, not stored. Computed per request from the memoized theme scan
// (core/themes), so they add no SQL and no fs to the read path — and deliberately absent from
// ALL_SETTINGS, because an option row for one of these could only ever drift from the theme on disk.
const DERIVED_PUBLIC_SETTINGS: Record<string, () => Promise<any>> = {
    // theme.json `version` of the ACTIVE theme. The frontend appends it to the theme stylesheet URL
    // so an in-place theme edit (PUT /api/v1/themes/:slug bumps the patch) busts the browser/CDN
    // copy — the build-time asset version cannot see that edit. That route purges the 'settings' tag.
    active_theme_version: getActiveThemeVersion,
    // TRUE when the `template` option names a theme that is not on disk. The site keeps rendering —
    // the framework's own :root tokens in public/css/wordjs-ui.css are the floor, and that fallback is
    // correct — but nothing used to SAY so, so a deleted or renamed theme looked like a styling bug.
    // Consumed by the admin themes screen (frontend/src/app/admin/themes/page.tsx), which renders a
    // banner naming the missing slug, and mirrored by a boot-time warning in index.ts.
    // Boolean, not a string: `Boolean("false")` is true, and a health flag that reads backwards when
    // stringified is worse than no flag. Derived, so it can never drift from the directory on disk.
    active_theme_missing: isActiveThemeMissing
};

// Admin-ONLY derived settings: computed per request, never stored, and returned only from GET
// /settings/all (behind authenticate + isAdmin). Same shape as DERIVED_PUBLIC_SETTINGS, but deliberately
// NOT public — the plugin-sandbox hardening posture is a security-internal signal (telling an anonymous
// visitor "this host's OS backstop is off" only helps an attacker), so it rides the admin payload the
// audit's item 6 asks for, mirroring the active_theme_missing derived-boolean pattern.
//
// State is read from core/plugin-isolate (populated by the boot-time probe, or lazily on first isolate
// load). 'unknown' until the probe resolves; 'degraded' is the dangerous "looks secure but isn't" state.
const DERIVED_ADMIN_SETTINGS: Record<string, () => Promise<any>> = {
    // Raw hardening state enum: 'unknown' | 'unsupported' | 'disabled' | 'active' | 'degraded'.
    sandbox_hardening_state: async () => {
        try { return require('../core/plugin-isolate').getSandboxHardeningState(); } catch { return 'unknown'; }
    },
    // Derived BOOLEAN (not a string — `Boolean("false")` is true): TRUE only when hardening is 'degraded',
    // i.e. kernel hardening was enabled but the bwrap probe failed and plugins run without the OS backstop.
    sandbox_hardening_degraded: async () => {
        try { return require('../core/plugin-isolate').isSandboxHardeningDegraded() === true; } catch { return false; }
    },
    // Derived BOOLEAN: TRUE only while a mail-PROVIDER plugin has registered a host-wide send function
    // (email:provider capability → global.wordjs_send_mail). The core cannot send email itself, so when
    // this is FALSE password recovery fails closed and silently — a fresh install with no mail plugin has
    // NO self-service password reset. Surfacing it here lets the admin UI say so instead of leaving a
    // dead "Forgot password?" flow. Live/fail-closed: the host deletes the global when the provider
    // unloads. Mirrors the active_theme_missing / sandbox_hardening_degraded derived-boolean pattern.
    email_provider_available: async () => {
        try { return require('../core/mail-provider').isEmailProviderAvailable() === true; } catch { return false; }
    }
};

const derivedSetting = (key: string) =>
    // hasOwnProperty, not `in`: `constructor`/`toString` must not resolve through the prototype.
    Object.prototype.hasOwnProperty.call(DERIVED_PUBLIC_SETTINGS, key) ? DERIVED_PUBLIC_SETTINGS[key] : null;

// ---------------------------------------------------------------------------
// Per-key write validation
// ---------------------------------------------------------------------------
// Most options are free text that only ever renders as TEXT. These two do not: they are written
// verbatim into the `lang` and `dir` ATTRIBUTES of <html>, i.e. they choose document structure
// rather than content. So they are validated here, at the write, against a closed shape — the same
// posture as chrome-validate and template-validate, and a second independent gate in front of the
// frontend's own fail-closed resolver (frontend/src/lib/documentLanguage.ts). A key with no entry
// here keeps its existing unvalidated behaviour; adding one is opt-in and fail-closed.
//
// `site_text_direction` admits '' as the DERIVE sentinel: no override, take the direction from the
// locale. The three real values are exactly HTML's `dir` enum.
const TEXT_DIRECTIONS = ['', 'ltr', 'rtl', 'auto'];
// language [ - script ] [ - region ]. Underscore form ('es_ES') is what the WPLANG option has
// always used (core/i18n keys the translation files by it), so it is accepted and normalized to a
// BCP 47 tag on READ by whoever renders it — core/language-tag for the RSS <language>, the frontend
// resolver for <html lang>. Both hyphenate; neither rewrites the stored value. Deliberately
// narrower than full BCP 47: extensions/variants/private-use have no consumer here and every
// character admitted ends up in an attribute.
const LOCALE_RE = /^[A-Za-z]{2,3}([-_][A-Za-z]{4})?([-_]([A-Za-z]{2}|[0-9]{3}))?$/;

const SETTING_VALIDATORS: Record<string, (v: any) => string | null> = {
    WPLANG: (v: any) => {
        if (v === '' || v === null || v === undefined) return null; // unset → the resolver's "en"
        if (typeof v !== 'string' || !LOCALE_RE.test(v)) {
            return 'WPLANG must be a language tag like "en", "es_ES" or "ar-SA".';
        }
        return null;
    },
    site_text_direction: (v: any) => {
        const s = v === null || v === undefined ? '' : v;
        if (typeof s !== 'string' || !TEXT_DIRECTIONS.includes(s)) {
            return 'site_text_direction must be one of "", "ltr", "rtl", "auto".';
        }
        return null;
    },
};

/** null when the value is acceptable (or the key carries no validator), else the reason. */
const settingWriteProblem = (key: string, value: any): string | null =>
    Object.prototype.hasOwnProperty.call(SETTING_VALIDATORS, key) ? SETTING_VALIDATORS[key](value) : null;

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

    await Promise.all([
        ...ALL_SETTINGS.map(async (key) => {
            settings[key] = await getOption(key);
        }),
        // Admin-only derived flags (sandbox hardening posture) — computed, never stored.
        ...Object.entries(DERIVED_ADMIN_SETTINGS).map(async ([key, compute]) => {
            settings[key] = await compute();
        })
    ]);

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

    // Validate the WHOLE payload before writing any of it: a bulk save that stored half its keys and
    // then 400'd would leave the site in a state the admin never asked for.
    for (const [key, value] of Object.entries(updates)) {
        if (!ALL_SETTINGS.includes(key) || DEDICATED_WRITE_API.has(key)) continue;
        const problem = settingWriteProblem(key, value);
        if (problem) {
            return res.status(400).json({
                code: 'rest_invalid_param',
                message: problem,
                data: { status: 400, params: [key] }
            });
        }
    }

    for (const [key, value] of Object.entries(updates)) {
        if (ALL_SETTINGS.includes(key) && !DEDICATED_WRITE_API.has(key)) {
            await updateOption(key, value);
            updated[key] = value;
        }
    }

    // AUDIT: record WHICH settings changed — the key names only, never their values (a value could be
    // admin_email / other sensitive config). One row per bulk save.
    const changedKeys = Object.keys(updated);
    if (changedKeys.length) {
        await recordAudit((req as any).user && (req as any).user.id, 'settings.update', 'settings', '', { keys: changedKeys });
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

    const problem = settingWriteProblem(key, value);
    if (problem) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: problem,
            data: { status: 400, params: [key] }
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
