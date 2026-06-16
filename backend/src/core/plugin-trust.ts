/**
 * WordJS - Plugin Trust Registry
 *
 * A plugin is "trusted" (granted the PRIVILEGED bridge tier: unscoped DB incl. core tables, secret
 * options, absolute routes, mail provider, notification transport) if EITHER:
 *   - it is a shipped first-party default (config.trustedSystemPlugins), OR
 *   - an operator has flipped its trust toggle in the admin UI.
 *
 * The admin-toggled set is stored SERVER-SIDE (the `trusted_plugins` option) — a plugin can NEVER
 * self-declare trust; only an authenticated admin can grant it (and the UI warns what it grants).
 * It is mirrored in memory so the security gates (plugin-api / plugin-isolate) can read it
 * synchronously. loadTrusted() is called once at boot, after the DB is up.
 */

const config = require('../config/app');

const adminTrusted = new Set<string>();
let loaded = false;

async function loadTrusted(): Promise<void> {
    try {
        const { getOption } = require('./options');
        const list = await getOption('trusted_plugins', []);
        adminTrusted.clear();
        if (Array.isArray(list)) for (const s of list) adminTrusted.add(String(s));
        loaded = true;
    } catch (e: any) {
        console.warn('[PluginTrust] Failed to load trusted_plugins option:', e && e.message);
    }
}

/** Synchronous trust check used by the bridge security gates. */
function isTrusted(slug: string): boolean {
    if (!slug) return false;
    const shipped = config.trustedSystemPlugins || [];
    return shipped.includes(slug) || adminTrusted.has(slug);
}

/** Grant/revoke operator trust for a plugin (admin action). Persists to the `trusted_plugins` option. */
async function setTrusted(slug: string, trusted: boolean): Promise<void> {
    if (trusted) adminTrusted.add(slug); else adminTrusted.delete(slug);
    const { updateOption } = require('./options');
    await updateOption('trusted_plugins', Array.from(adminTrusted));
}

/** Whether trust for this slug is shipped-by-default (can't be revoked via the UI). */
function isShippedTrusted(slug: string): boolean {
    return (config.trustedSystemPlugins || []).includes(slug);
}

module.exports = { loadTrusted, isTrusted, setTrusted, isShippedTrusted };
