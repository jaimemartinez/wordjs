/**
 * WordJS - Admin Menu Registry
 * Allows plugins to register admin menu items
 */

const adminMenuItems = new Map();

/**
 * Register an admin menu item
 * @param {string} pluginSlug - The plugin slug (used to remove menu when deactivated)
 * @param {object} item - Menu item { href, label, icon, order }
 */
function registerAdminMenu(pluginSlug, item) {
    // Clear existing items for this plugin to avoid duplicates on hot reload
    if (!adminMenuItems.has(pluginSlug)) {
        adminMenuItems.set(pluginSlug, []);
    }
    console.log(`DEBUG: Registering menu for ${pluginSlug}: ${item.label}`);

    // Check if this exact href is already registered for this plugin
    const existingItems = adminMenuItems.get(pluginSlug);
    const alreadyExists = existingItems.some(existing => existing.href === item.href);

    if (!alreadyExists) {
        existingItems.push({
            href: item.href,
            label: item.label,
            icon: item.icon || 'fa-puzzle-piece',
            order: item.order || 100,
            cap: item.cap || item.capability || null,
            section: item.section || 'core'
        });
    }
}

/**
 * Unregister all menu items for a plugin
 * @param {string} pluginSlug
 */
function unregisterAdminMenu(pluginSlug) {
    adminMenuItems.delete(pluginSlug);
}

/**
 * Get all registered admin menu items
 * @returns {Array} Array of menu items
 */
function getAdminMenuItems() {
    const items = [];
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
    console.log('DEBUG: initCoreMenus() called');
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
    types.forEach(type => {
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
    getAllRegisteredCapabilities
};
