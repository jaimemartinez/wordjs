/**
 * WordJS - Option Model
 * Equivalent to wp-includes/option.php
 */

const { dbAsync } = require('../config/database');
const { verifyPermission, runWithContext } = require('./plugin-context');
const { doAction } = require('./hooks');
const cache = require('./cache');

// Core-level backstop for the security-critical option-NAME denylist that otherwise lives ONLY in the
// bridge (createPluginApi.isProtectedOption). Scoped to THEME context specifically — isolated plugins never
// reach here (bridge/RPC only), and core code invoked on behalf of a normal plugin has a plugin (not
// 'theme:') context. Applied to EVERY option writer (update/add/delete) so none is a write-side escalation
// path (#9). (Post theme-isolation this is largely defense-in-depth — themes no longer run in-process.)
function assertThemeOptionWritable(name: string): void {
    const eff = require('./plugin-context').getEffectivePlugin();
    if (eff && String(eff).startsWith('theme:')) {
        const n = String(name).toLowerCase();
        // marketplace_(sources|theme_sources) included: letting a theme rewrite the CATALOG source
        // lists would be a supply-chain primitive (point installs at a hostile origin).
        const PROTECTED_NAME = /^(wordjs_user_roles|user_roles|roles|active_plugins|default_role|users_can_register|plugin_grants|cron|plugin_strikes|plugin_health|trusted_plugins?|trustedsystemplugins|template|stylesheet|active_theme_layout|active_theme_mods|theme_mods|siteurl|site_url|home|admin_email|marketplace_(sources?|theme_sources|url|catalog_url))$/;
        if (PROTECTED_NAME.test(n) || /secret|passw|priv[_-]?key|privatekey|\bkey\b|[_-]key\b|token|jwt|credential|encryption|dkim|\bsalt\b|api[_-]?key|signing|certificate/.test(n)) {
            throw new Error(`🛡️ Option '${name}' is not writable from theme context.`);
        }
    }
}

/**
 * Get an option value
 * Equivalent to get_option()
 */
async function getOption(name: string, defaultValue: any = null) {
    // Only verify if we are in a plugin context
    verifyPermission('settings', 'read');

    return runWithContext(null, async () => {
        try {
            // 1. Try Cache first.
            // Values are stored wrapped as { v: value } so that a real cached
            // value of null/false/0/'' is distinguishable from a cache miss
            // (cache.get returns null only on a genuine miss/disabled cache).
            const cacheKey = `option:${name}`;
            const cachedWrapper = await cache.get(cacheKey);
            if (cachedWrapper !== null && typeof cachedWrapper === 'object' && 'v' in cachedWrapper) {
                return cachedWrapper.v;
            }

            // 2. Fallback to DB
            const row = await dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', [name]);

            if (!row) return defaultValue;

            // Try to parse JSON
            let finalValue;
            try {
                finalValue = JSON.parse(row.option_value);
            } catch {
                finalValue = row.option_value;
            }

            // 3. Store in cache for next time (wrapped so null/false/0/'' cache correctly)
            await cache.set(cacheKey, { v: finalValue });

            return finalValue;
        } catch (e) {
            console.error(`Error getting option ${name}:`, e.message);
            return defaultValue;
        }
    });
}

/**
 * Update an option value
 * Equivalent to update_option()
 */
async function updateOption(name: string, value: any, autoload = 'yes') {
    verifyPermission('settings', 'write');
    assertThemeOptionWritable(name); // #9

    return runWithContext(null, async () => {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);

        // Atomic UPSERT instead of SELECT-then-(UPDATE|INSERT): the old check-then-write raced the
        // options(option_name) UNIQUE index — two concurrent first-writes both saw no row, both
        // INSERTed, and the loser surfaced a raw UNIQUE violation / 500. ON CONFLICT collapses both
        // paths into one atomic statement. Supported by SQLite ≥3.24 and Postgres; the legacy sql.js
        // driver strips RETURNING but honors ON CONFLICT.
        await dbAsync.run(
            `INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)
             ON CONFLICT (option_name) DO UPDATE SET option_value = excluded.option_value, autoload = excluded.autoload`,
            [name, serialized, autoload]
        );

        // Invalidate Cache (shared Redis del is cluster-wide). Also publish a cross-node signal so
        // each node can refresh in-process state that isn't read through the option cache (e.g. the
        // roles cache). No-op when Redis isn't configured (single node).
        await cache.del(`option:${name}`);
        cache.publish('wordjs:option-changed', name);

        // Update Dynamic Cache State
        if (name === 'redis_cache_enabled') {
            cache.setEnabled(value);
        }

        // Trigger reactive hooks
        await doAction('updated_option', name, value);

        return true;
    });
}

/**
 * Add an option (only if it doesn't exist)
 * Equivalent to add_option()
 */
async function addOption(name: string, value: any, autoload = 'yes') {
    verifyPermission('settings', 'write');
    assertThemeOptionWritable(name); // #9 — same backstop as updateOption

    return runWithContext(null, async () => {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
        // Atomic insert-if-absent: ON CONFLICT DO NOTHING avoids the check-then-insert race against the
        // options(option_name) UNIQUE index (two concurrent first-writes / two nodes seeding the same
        // default). changes/rowCount === 0 means the row already existed (no insert happened).
        const result = await dbAsync.run(
            `INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)
             ON CONFLICT (option_name) DO NOTHING`,
            [name, serialized, autoload]
        );
        return !!(result && (result.changes || 0) > 0);
    });
}

/**
 * Delete an option
 * Equivalent to delete_option()
 */
async function deleteOption(name: string) {
    verifyPermission('settings', 'write');
    assertThemeOptionWritable(name); // #9 — same backstop as updateOption

    return runWithContext(null, async () => {
        const result = await dbAsync.run('DELETE FROM options WHERE option_name = ?', [name]);
        const success = result.changes > 0;
        if (success) {
            await cache.del(`option:${name}`);
            cache.publish('wordjs:option-changed', name);
        }
        return success;
    });
}

/**
 * Get all autoloaded options
 */
async function getAutoloadedOptions() {
    return runWithContext(null, async () => {
        const rows = await dbAsync.all('SELECT option_name, option_value FROM options WHERE autoload = ?', ['yes']);

        const options: Record<string, any> = {};
        for (const row of rows) {
            try {
                options[row.option_name] = JSON.parse(row.option_value);
            } catch {
                options[row.option_name] = row.option_value;
            }
        }
        return options;
    });
}

/**
 * Initialize default options
 * WARNING: This is called during init, ensure DB is ready.
 */
async function initDefaultOptions(fullConfig: any) {
    const defaults = {
        siteurl: fullConfig.site.url,
        home: fullConfig.site.url,
        blogname: fullConfig.site.name || 'WordJS',
        blogdescription: fullConfig.site.description || 'Just another WordJS site',
        users_can_register: 0,
        admin_email: 'admin@example.com',
        start_of_week: 1,
        date_format: 'Y-m-d',
        time_format: 'H:i',
        timezone_string: 'UTC',
        posts_per_page: 10,
        default_category: 1,
        default_post_format: '',
        show_on_front: 'posts',
        page_on_front: 0,
        page_for_posts: 0,
        blog_public: 1,
        default_pingback_flag: 0,
        default_ping_status: 'open',
        default_comment_status: 'open',
        comments_notify: 1,
        moderation_notify: 1,
        comment_moderation: 0,
        comment_registration: 0,
        require_name_email: 1,
        comment_previously_approved: 1,
        comment_max_links: 2,
        permalink_structure: '/%postname%/',
        active_plugins: [],
        template: 'default',
        stylesheet: 'default',
        thumbnail_size_w: 150,
        thumbnail_size_h: 150,
        medium_size_w: 300,
        medium_size_h: 300,
        large_size_w: 1024,
        large_size_h: 1024,
        default_role: 'subscriber',
        redis_cache_enabled: 0,
        wordjs_user_roles: fullConfig.roles || {}
    };

    for (const [name, value] of Object.entries(defaults)) {
        await addOption(name, value);
    }
}

/**
 * Initialize Cache Setting
 */
async function initCacheSetting() {
    try {
        const enabled = await getOption('redis_cache_enabled', 0);
        cache.setEnabled(enabled);
    } catch (e) {
        console.error('[Options] Failed to init cache setting:', e.message);
    }
}

// NOTE: initCacheSetting() is intentionally NOT called at import time to avoid a
// startup race where the DB driver may not yet be initialized. It is invoked from
// the app startup sequence in src/index.ts after the database/options are ready.

module.exports = {
    getOption,
    updateOption,
    addOption,
    deleteOption,
    getAutoloadedOptions,
    initDefaultOptions,
    initCacheSetting
};
