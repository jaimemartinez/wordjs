/**
 * WordJS - Reserved plugin slugs (one policy for every entry point).
 *
 * A plugin's slug is its identity everywhere the host keys something to a plugin: the admin-menu
 * registry, its route prefix (/api/v1/plugin/<slug>), its cookie namespace, its table prefix
 * (wjp_<slug>_), its grants record. Some of those names are already taken by the host itself:
 *
 *  - `core` is the owner the host uses for its OWN admin-menu items, shortcodes and hooks
 *    (core/adminMenu.ts treats it as trusted host code). A plugin carrying that slug must never exist.
 *  - `theme-<x>` / `theme_<x>` / `theme.<x>` normalize onto the identity of the theme `<x>`
 *    (`theme:<x>` → route prefix /api/v1/plugin/theme-<x>, cookie and table namespace wjp_theme_<x>_).
 *    A plugin with such a slug would share those namespaces with the theme.
 *  - anything starting with `@` is the host's own registry namespace (`@host`, `@themes`, `@<table>`
 *    keys in the prefix registry).
 *
 * The comparison is made on the SAME normalization the table-prefix code uses
 * (slug.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()), so a spelling that maps onto a reserved
 * namespace is reserved too. Every path that brings a plugin into existence or loads one — the zip
 * upload, the marketplace install (same installer), and the boot-time scan of plugins/ — asks this
 * module, so there is one rule and one place to change it.
 */

/** The normalization the per-plugin table prefix, role and cookie names are derived from. */
function normalizePluginSlug(slug: string): string {
    return String(slug).normalize('NFC').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();
}

/**
 * Why `slug` may not be used as a plugin slug, or null when it may. A non-string is reported as
 * reserved (fail closed); charset validation is the callers' own SLUG_RE and is not repeated here.
 */
function reservedPluginSlugReason(slug: unknown): string | null {
    if (typeof slug !== 'string' || slug.length === 0) return 'a plugin slug must be a non-empty string';
    const raw = slug.normalize('NFC');
    if (raw.startsWith('@')) return `'${raw}' starts with '@', which is reserved for the host's own registry keys`;
    const norm = normalizePluginSlug(raw);
    if (norm === 'core') return `'${raw}' is reserved for the WordJS core`;
    // `theme`, `theme-x`, `theme_x`, `theme.x`, `Theme--X` … all land in the theme namespace.
    if (norm === 'theme' || norm.startsWith('theme_')) {
        return `'${raw}' is reserved: plugin slugs starting with 'theme-' share the identity of a theme (theme:<name>)`;
    }
    return null;
}

function isReservedPluginSlug(slug: unknown): boolean {
    return reservedPluginSlugReason(slug) !== null;
}

module.exports = { normalizePluginSlug, reservedPluginSlugReason, isReservedPluginSlug };
