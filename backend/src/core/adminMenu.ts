/**
 * WordJS - Admin Menu Registry
 * Allows plugins to register admin menu items
 */

const log = require('./module-logger').moduleLogger('core/adminMenu');

const adminMenuItems = new Map();

// Cap admin-menu items per plugin: the dedupe below is by `href`, which an untrusted plugin fully
// controls and can vary infinitely to grow this host-side Map unboundedly (memory DoS). 'core' (host
// code) is exempt. Generous enough for any legitimate plugin's menu.
const MAX_ADMIN_MENU_ITEMS = 50;

/**
 * Register an admin menu item
 * @param {string} pluginSlug - The plugin slug (used to remove menu when deactivated)
 * @param {object} item - Menu item { href, label, icon, order }
 */
// A plugin's admin-menu href is rendered as a sidebar link. adminMenu.add is reachable WITHOUT a grant,
// so an untrusted plugin can supply a `javascript:`/`data:` scheme, an off-site (`https://evil…`), or a
// protocol-relative (`//evil…`) URL → an admin-panel phishing / UI-spoof primitive. Require a same-origin,
// relative path: a single leading '/', not '//', and only safe URL-path characters. Matches every legit
// admin route (/admin, /admin/posts?type=x, /admin/plugin/cards). 'core' (host code) is exempt.
const SAFE_ADMIN_HREF = /^\/(?!\/)[\w\-./?=&%#]*$/;

/** `/admin/plugin/<slug>…` → the (decoded) slug of that plugin page; null for any other href. */
function pluginPageSlugOf(href: string): string | null {
    const m = /^\/admin\/plugin\/([^/?#]+)/.exec(href);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

const PLUGIN_FOLDER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** The admin page slug a manifest declares (`frontend.adminPage.slug`), or null when it has none. */
function adminPageSlugOf(manifest: any): string | null {
    const slug = manifest && manifest.frontend && manifest.frontend.adminPage && manifest.frontend.adminPage.slug;
    return typeof slug === 'string' && slug ? slug : null;
}

/**
 * Every installed plugin folder (a directory of PLUGINS_DIR holding a manifest.json or a main file), with
 * the admin page slug its manifest declares (null: none, or an unreadable manifest). Read from disk on
 * every call — it decides who owns an admin page, and an install a moment ago must count. Read as the
 * HOST (plugin-context runAsHost): a plugin's menu item is registered from its bridged call, where io-guard
 * attributes every filesystem access to that plugin and refuses it the plugins directory. Only fixed paths
 * are read — PLUGINS_DIR, the folders it lists, their manifest.json and main file names.
 */
function installedAdminPages(): Map<string, string | null> {
    return require('./plugin-context').runAsHost(readInstalledAdminPages);
}

function readInstalledAdminPages(): Map<string, string | null> {
    const out = new Map<string, string | null>();
    try {
        const fs = require('fs');
        const path = require('path');
        const { PLUGINS_DIR } = require('./plugins');
        for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
            if (!entry.isDirectory() || !PLUGIN_FOLDER_RE.test(entry.name)) continue;
            const dir = path.join(PLUGINS_DIR, entry.name);
            const manifestPath = path.join(dir, 'manifest.json');
            if (fs.existsSync(manifestPath)) {
                let page: string | null = null;
                try { page = adminPageSlugOf(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))); } catch { /* unreadable: no page */ }
                out.set(entry.name, page);
            } else if (['index.js', 'main.js', 'plugin.js'].some((f) => fs.existsSync(path.join(dir, f)))) {
                out.set(entry.name, null);
            }
        }
    } catch { /* no plugins directory: nothing is installed */ }
    return out;
}

/**
 * The installed plugin whose screen `/admin/plugin/<page>` opens — the same order the admin page's bundle
 * is resolved in (routes/plugin-bundles.ts resolvePluginDir): the plugin installed in the folder of that
 * name; otherwise the ONE installed plugin whose manifest declares `page` as its admin page. null when
 * none does, or when several claim it (then the page is nobody's).
 */
function adminPageOwner(page: string, installed: Map<string, string | null> = installedAdminPages()): string | null {
    if (installed.has(page)) return page;
    const claimants = Array.from(installed).filter(([, own]) => own === page).map(([folder]) => folder);
    return claimants.length === 1 ? claimants[0] : null;
}

/**
 * Why plugin `pluginSlug` (installed, or being installed, in the folder of that name) may not take the
 * admin page its manifest declares, or null when it may. Two installed plugins never answer to the same
 * `/admin/plugin/<slug>`: the page a manifest declares must not be another installed plugin's folder or
 * declared page, and the plugin's own folder name must not be another installed plugin's declared page.
 * Checked at install and at activation (a menu item may only point at its own page — registerAdminMenu —
 * and the admin layout opens a plugin page to whoever has a menu item there).
 */
function adminPageConflict(pluginSlug: string, manifest: any): string | null {
    const page = adminPageSlugOf(manifest);
    const others = Array.from(installedAdminPages()).filter(([folder]) => folder !== pluginSlug);
    if (page !== null && page !== pluginSlug) {
        const folder = others.find(([f]) => f === page);
        if (folder) return `Its admin page "${page}" (frontend.adminPage.slug) is the page of the installed plugin "${folder[0]}". Choose another admin page slug.`;
    }
    if (page !== null) {
        const claimant = others.find(([, own]) => own === page);
        if (claimant) return `Its admin page "${page}" (frontend.adminPage.slug) is already the admin page of the installed plugin "${claimant[0]}". Choose another admin page slug.`;
    }
    const squatter = others.find(([, own]) => own === pluginSlug);
    if (squatter) return `The installed plugin "${squatter[0]}" declares "${pluginSlug}" as its admin page, so /admin/plugin/${pluginSlug} cannot also be this plugin's page.`;
    return null;
}

function registerAdminMenu(pluginSlug: string, item: any) {
    item = item || {};
    // SECURITY: validate the plugin-controlled href BEFORE it can enter the registry. Drop the item on a
    // non-relative / dangerous-scheme href rather than register a phishable link (host 'core' is trusted).
    if (pluginSlug !== 'core' && !SAFE_ADMIN_HREF.test(typeof item.href === 'string' ? item.href : '')) {
        log.warn({ pluginSlug }, `[Security] admin-menu item from plugin '${pluginSlug}' rejected: unsafe href ${JSON.stringify(item.href)} (must be a relative /admin path, no scheme).`);
        return;
    }
    // A plugin's menu item may point at ITS OWN admin page only: the page whose owner (adminPageOwner — the
    // plugin the page's bundle is resolved to) is this plugin. The admin layout opens /admin/plugin/<slug> to
    // whoever has a menu item there (frontend lib/adminAccess.ts), so an item of plugin X pointing at
    // /admin/plugin/<Y> would hand Y's screen — and the landing after sign-in — to X's role holders: a
    // plugin's roles must only ever affect that plugin. Ownership is decided by what is installed, never by
    // X's own manifest alone: X naming Y's page as its own admin page does not make it X's.
    if (pluginSlug !== 'core') {
        const target = pluginPageSlugOf(item.href);
        if (target !== null && adminPageOwner(target) !== pluginSlug) {
            log.warn({ pluginSlug }, `[Security] admin-menu item from plugin '${pluginSlug}' rejected: ${JSON.stringify(item.href)} is not this plugin's own admin page.`);
            return;
        }
    }

    // Clear existing items for this plugin to avoid duplicates on hot reload
    if (!adminMenuItems.has(pluginSlug)) {
        adminMenuItems.set(pluginSlug, []);
    }

    // Check if this exact href is already registered for this plugin
    const existingItems = adminMenuItems.get(pluginSlug);
    // Bound per-plugin accumulation (the href dedupe below is attacker-defeatable). 'core' is host code.
    if (pluginSlug !== 'core' && existingItems.length >= MAX_ADMIN_MENU_ITEMS) {
        log.warn({ pluginSlug }, `[Security] admin-menu cap reached for plugin '${pluginSlug}' (${MAX_ADMIN_MENU_ITEMS}); ignoring further items.`);
        return;
    }
    const alreadyExists = existingItems.some((existing: any) => existing.href === item.href);

    if (!alreadyExists) {
        // Clamp plugin-controlled strings so a giant label/icon can't bloat the sidebar payload / host Map.
        const clamp = (v: any, n: number) => (typeof v === 'string' ? v.slice(0, n) : v);
        existingItems.push({
            href: item.href,
            label: pluginSlug === 'core' ? item.label : clamp(item.label, 200),
            icon: (pluginSlug === 'core' ? item.icon : clamp(item.icon, 64)) || 'fa-puzzle-piece',
            order: item.order || 100,
            cap: item.cap || item.capability || null,
            section: item.section || 'core',
            // Generic visibility flag: mark an item that is only meaningful to a user for whom an
            // ADMINISTRATOR has enabled a professional mailbox (e.g. a per-user webmail inbox). Core's
            // GET /plugins/menus hides it from everyone else, reading the same admin-owned grant the
            // plugin's own route gate reads (user_meta.professional_mailbox — see core/mailbox.ts; it
            // is deliberately NOT derived from the account's email domain, which the account itself can
            // write). Slug-agnostic — ANY plugin can set it, so it is not tied to the bundled mail-server.
            requiresProfessionalMailbox: !!item.requiresProfessionalMailbox
        });
    }
}

/**
 * Unregister all menu items for a plugin
 * @param {string} pluginSlug
 */
function unregisterAdminMenu(pluginSlug: string) {
    adminMenuItems.delete(pluginSlug);
}

/**
 * Get all registered admin menu items
 * @returns {Array} Array of menu items
 */
function getAdminMenuItems() {
    const items: any[] = [];
    for (const [slug, menus] of adminMenuItems) {
        for (const menu of menus) {
            items.push({ ...menu, plugin: slug });
        }
    }
    return items.sort((a, b) => {
        // Primary: Order (ASC)
        const orderDiff = (a.order || 100) - (b.order || 100);
        if (orderDiff !== 0) return orderDiff;

        // Secondary: Label (ABC)
        return a.label.localeCompare(b.label);
    });
}

/**
 * Get all unique capabilities required by registered items
 */
/**
 * Initialize Core Admin Menus (Dashboard, Posts, Settings, etc.)
 */
function initCoreMenus() {
    const { getPostTypes } = require('./post-types');

    // 1. Dashboard
    registerAdminMenu('core', {
        href: '/admin',
        label: 'Dashboard',
        icon: 'fa-gauge',
        order: 0,
        capability: 'read'
    });

    // 2. Post Types (Posts, Pages, etc.)
    const types = getPostTypes({ showInMenu: true });
    types.forEach((type: any) => {
        registerAdminMenu('core', {
            href: `/admin/posts?type=${type.name}`,
            label: type.label || type.name, // Use Plural label ideally
            icon: type.menuIcon || 'fa-thumbtack',
            order: type.menuPosition || 5,
            capability: type.capability_type ? `edit_${type.capability_type}s` : 'edit_posts'
        });
    });

    // 3. Media
    registerAdminMenu('core', {
        href: '/admin/media',
        label: 'Media',
        icon: 'fa-images',
        order: 10,
        capability: 'upload_files'
    });

    // 4. Comments
    registerAdminMenu('core', {
        href: '/admin/comments',
        label: 'Comments',
        icon: 'fa-comments',
        order: 25,
        capability: 'moderate_comments'
    });

    // 5. Appearance (Themes, Menus)
    registerAdminMenu('core', {
        href: '/admin/appearance',
        label: 'Appearance',
        icon: 'fa-paintbrush',
        order: 60,
        capability: 'switch_themes'
    });

    // 6. Plugins
    registerAdminMenu('core', {
        href: '/admin/plugins',
        label: 'Plugins',
        icon: 'fa-plug',
        order: 65,
        capability: 'activate_plugins'
    });

    // 7. Users
    registerAdminMenu('core', {
        href: '/admin/users',
        label: 'Users',
        icon: 'fa-users',
        order: 70,
        capability: 'list_users'
    });

    // 8. Settings
    registerAdminMenu('core', {
        href: '/admin/settings',
        label: 'Settings',
        icon: 'fa-sliders',
        order: 80,
        capability: 'manage_options'
    });

    // 9. Tools (Hooks Registry)
    registerAdminMenu('core', {
        href: '/admin/hooks',
        label: 'Hooks Registry',
        icon: 'fa-microscope',
        order: 90,
        capability: 'manage_options'
    });
}

function getAllRegisteredCapabilities() {
    const caps = new Set();
    for (const [slug, menus] of adminMenuItems) {
        for (const menu of menus) {
            if (menu.cap) caps.add(menu.cap);
        }
    }
    return Array.from(caps);
}

module.exports = {
    registerAdminMenu,
    unregisterAdminMenu,
    getAdminMenuItems,
    initCoreMenus, // Export new function
    getAllRegisteredCapabilities,
    adminPageOwner,
    adminPageConflict,
};
