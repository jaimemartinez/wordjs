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
// Option NAMES whose VALUES are secrets (JWT/DKIM keys, API tokens, passwords, salts, certificates, …).
// Reused to (a) block theme writes and (b) REDACT the value carried by the reactive `updated_option`
// hook (see updateOption) so a zero-permission isolated plugin that subscribes to that hook can't observe
// a secret it is forbidden to read via options.get (audit F-02). Kept as a single source of truth.
const SECRET_OPTION_NAME_RE = /secret|passw|priv[_-]?key|privatekey|\bkey\b|[_-]key\b|token|jwt|credential|encryption|dkim|\bsalt\b|api[_-]?key|signing|certificate/;

function assertThemeOptionWritable(name: string): void {
    const eff = require('./plugin-context').getEffectivePlugin();
    if (eff && String(eff).startsWith('theme:')) {
        const n = String(name).toLowerCase();
        // ONE LIST, not a copy of it. This used to be its own regex of the bridge's names, and it drifted:
        // the bridge had since protected mfa_policy, admin_notices, the site chrome, the enqueue registry
        // and the browser:script upgrade marker, none of which a theme was refused. The bridge's predicate
        // also canonicalises the name the way the database compares it (see plugin-api isProtectedOption).
        // Required lazily: plugin-api is a heavy module, and this branch only runs in a theme's context.
        const { isProtectedOption } = require('./plugin-api');
        if (isProtectedOption(name) || SECRET_OPTION_NAME_RE.test(n)) {
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
            if (cachedWrapper !== null && typeof cachedWrapper === 'object') {
                if ('v' in cachedWrapper) return cachedWrapper.v;
                // Cached ABSENCE (`{m:1}`): the DB had no row moments ago. Each caller still applies
                // its own defaultValue — only the miss is shared, never a default.
                if (cachedWrapper.m === 1) return defaultValue;
            }

            // 2. Fallback to DB
            const row = await dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', [name]);

            if (!row) {
                // Negative cache, short TTL: repeated reads of absent options (probes, misconfigured
                // callers, crawls) were a SELECT each. addOption/updateOption del() this key on the
                // write path, so creation is visible immediately.
                await cache.set(cacheKey, { m: 1 }, 10);
                return defaultValue;
            }

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
 * THE OPTION AS STORED — one SELECT, STRAIGHT FROM THE DATABASE: no cache tier is consulted or filled, and
 * a database error is THROWN instead of being answered with a default.
 *
 * getOption() is the right reader for almost everything, and both of its properties are wrong for a
 * decision that must rest on what the database holds NOW — the security-policy loaders and writers
 * (plugin_grants / plugin_egress_hosts in core/plugin-permissions.ts), the shared active set:
 *   · it answers a DB failure with the default — `{}` for the two policy options, which reads as "a
 *     valid, empty policy": every grant dropped, or the egress allowlist "successfully" loaded as
 *     allow-all. A caller has to be able to tell "no policy" from "could not read the policy", and to
 *     fail closed on the second.
 *   · it serves the in-process L1 first. On a multi-node cluster a peer's write is only visible here
 *     once its cache-invalidation broadcast arrives (core/cache bounds a missed one at 30 s); a loader
 *     whose whole job is to catch up after a LOST broadcast cannot read through that same cache, and a
 *     read-modify-write through it silently undoes the peer's change.
 *
 * Also returns the exact stored text, `raw` (null when there is no row), which persistOption() takes as
 * its guard (`expectedRaw`) so a decision taken on this read is never written over a row that changed in
 * between. Same deserialization as getOption (JSON.parse, raw string on failure).
 */
async function readStoredOption(name: string): Promise<{ raw: string | null; value: any }> {
    verifyPermission('settings', 'read');
    return runWithContext(null, async () => {
        const row = await dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', [name]);
        if (!row) return { raw: null, value: null };
        const raw = row.option_value === null || row.option_value === undefined ? '' : String(row.option_value);
        let value: any;
        try { value = JSON.parse(raw); } catch { value = raw; }
        return { raw, value };
    });
}

/**
 * readStoredOption() for a caller that only needs the VALUE: absent row ⇒ `defaultValue`, a database
 * error is thrown. Goes through the module's export, so there is one fresh read to instrument.
 */
async function getOptionFresh(name: string, defaultValue: any = null) {
    const { raw, value } = await module.exports.readStoredOption(name);
    return raw === null ? defaultValue : value;
}

/**
 * Update an option value
 * Equivalent to update_option()
 */
async function updateOption(name: string, value: any, autoload = 'yes') {
    const { announce } = await persistOption(name, value, autoload);
    await announce();
    return true;
}

const NO_ANNOUNCE = async (): Promise<void> => { /* nothing was written: nothing to announce */ };

/**
 * updateOption() in its two halves, for a writer that keeps an IN-MEMORY MIRROR of the option and has to
 * bring it up to date between them. This writes the row, invalidates the cache and publishes the
 * cross-node signal, then hands the reactive `updated_option` fan-out back as `announce` — for the caller
 * to run, exactly once, once its mirror is current. Same permission and theme gates as updateOption.
 *
 * The fan-out is not instant: it reaches every isolated plugin that subscribed over IPC, one after another,
 * each bounded only by its RPC timeout. core/plugin-permissions.ts persists a grant / egress-allowlist
 * change first and mirrors it into the maps the host gates read second; with updateOption() in between,
 * that second step waited for the whole fan-out, so a REVOKED grant stayed in force on the very node that
 * wrote the revoke for as long as the plugins took to hear about it.
 *
 * GUARDED WRITE. With `guard`, the value is written only if the row still holds exactly
 * `guard.expectedRaw` (readStoredOption's `raw`): one guarded UPDATE, so a decision taken on that read is
 * never applied over a write another request or another node made in between. `expectedRaw === null` is
 * "there was no row": the write is then an insert that happens only while there is still no row (ON
 * CONFLICT DO NOTHING), never an upsert, so a row created in between is not overwritten. `written: false`
 * leaves the row as it was — re-read and decide again. A value whose text equals `expectedRaw` writes
 * nothing (MySQL would report 0 affected rows for it, which must not read as "somebody else wrote it") and
 * is `written: true` only while the row still holds it. Without `guard`, the write is the plain upsert.
 */
async function persistOption(name: string, value: any, autoload = 'yes', guard?: { expectedRaw: string | null }): Promise<{ written: boolean; announce: () => Promise<void> }> {
    verifyPermission('settings', 'write');
    assertThemeOptionWritable(name); // #9

    return runWithContext(null, async () => {
        const serialized = serializeOptionValue(value);
        const affected = (r: any) => !!(r && (r.changes > 0 || r.rowCount > 0));

        if (!guard) {
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
        } else if (guard.expectedRaw === null) {
            const inserted = await dbAsync.run(
                `INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)
                 ON CONFLICT (option_name) DO NOTHING`,
                [name, serialized, autoload]);
            if (!affected(inserted)) return { written: false, announce: NO_ANNOUNCE };
        } else if (serialized === guard.expectedRaw) {
            const row = await dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', [name]);
            return { written: !!row && String(row.option_value ?? '') === guard.expectedRaw, announce: NO_ANNOUNCE };
        } else {
            const result = await dbAsync.run(
                'UPDATE options SET option_value = ? WHERE option_name = ? AND option_value = ?',
                [serialized, name, guard.expectedRaw]);
            if (!affected(result)) return { written: false, announce: NO_ANNOUNCE };
        }

        return { written: true, announce: await afterOptionWrite(name, value) };
    });
}

/**
 * The text an option value is stored as. An absent value stores as EMPTY, never as the text
 * "undefined"/"null". String(undefined) is the literal "undefined", and options are rendered straight into
 * pages — a missing tagline shipped "My site — undefined" into <title>, og:title and twitter:title. Guarded
 * at the writer so no call site can reintroduce it.
 */
function serializeOptionValue(value: any): string {
    return (value === undefined || value === null)
        ? ''
        : (typeof value === 'object' ? JSON.stringify(value) : String(value));
}

/**
 * What every successful option write does once the row changed: invalidate the cache, publish the
 * cross-node signal, update the dynamic cache state — and hand back the reactive `updated_option` fan-out
 * for the writer to run (persistOption's `announce`).
 */
async function afterOptionWrite(name: string, value: any): Promise<() => Promise<void>> {
    // Invalidate Cache (shared Redis del is cluster-wide). Also publish a cross-node signal so
    // each node can refresh in-process state that isn't read through the option cache (e.g. the
    // roles cache). No-op when Redis isn't configured (single node).
    await cache.del(`option:${name}`);
    cache.publish('wordjs:option-changed', name);

    // Update Dynamic Cache State
    if (name === 'redis_cache_enabled') {
        cache.setEnabled(value);
    }

    // Trigger reactive hooks. The reactive `updated_option` hook fans out to isolated plugins through
    // the hook shim, so a plugin with NO permissions could subscribe and observe the RAW value of
    // EVERY option — including secret-named ones it may not read via options.get (audit F-02). Redact
    // secret values at the source. The only in-core listener (cron) reacts to backup_* names, never a
    // secret, and the cross-node cache signal above carries the NAME only, so this is transparent.
    const hookValue = SECRET_OPTION_NAME_RE.test(String(name).toLowerCase()) ? '[redacted]' : value;
    return () => runWithContext(null, () => doAction('updated_option', name, hookValue));
}

/**
 * Add an option (only if it doesn't exist)
 * Equivalent to add_option()
 */
async function addOption(name: string, value: any, autoload = 'yes') {
    verifyPermission('settings', 'write');
    assertThemeOptionWritable(name); // #9 — same backstop as updateOption

    return runWithContext(null, async () => {
        // Same absent-value guard as updateOption — never persist the text "undefined"/"null".
        const serialized = serializeOptionValue(value);
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
 * Prime the option cache with every autoload row in ONE query (called once at boot). getOption
 * then answers /settings and the other hot readers without touching the DB at all.
 * Deserialization mirrors getOption's exactly (JSON.parse, raw string on failure) — never a
 * separate re-implementation that could drift.
 */
async function preloadAutoloadedOptions(): Promise<number> {
    try {
        const rows = await dbAsync.all('SELECT option_name, option_value FROM options WHERE autoload = ?', ['yes']);
        for (const row of rows) {
            let finalValue;
            try {
                finalValue = JSON.parse(row.option_value);
            } catch {
                finalValue = row.option_value;
            }
            await cache.set(`option:${row.option_name}`, { v: finalValue });
        }
        return rows.length;
    } catch (e: any) {
        console.warn('[Options] autoload preload skipped:', e && e.message);
        return 0;
    }
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
        // Site locale + writing direction. WPLANG already existed (routes/seo
        // puts it in the RSS <language>); it now also drives <html lang>. site_text_direction is the
        // explicit <html dir> override — '' means "derive from WPLANG", which is what an Arabic or
        // Hebrew locale needs and what nothing in the tree could express before.
        WPLANG: 'en_US',
        site_text_direction: '',
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
    getOptionFresh,
    updateOption,
    persistOption,
    readStoredOption,
    addOption,
    deleteOption,
    getAutoloadedOptions,
    preloadAutoloadedOptions,
    initDefaultOptions,
    initCacheSetting,
    assertThemeOptionWritable
};
