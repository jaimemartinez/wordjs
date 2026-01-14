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

    // Check if this exact href is already registered for this plugin
    const existingItems = adminMenuItems.get(pluginSlug);
    const alreadyExists = existingItems.some(existing => existing.href === item.href);

    if (!alreadyExists) {
        existingItems.push({
            href: item.href,
            label: item.label,
            icon: item.icon || 'fa-puzzle-piece',
            order: item.order || 100,
            cap: item.cap || item.capability || null
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
    return items.sort((a, b) => a.order - b.order);
}

module.exports = {
    registerAdminMenu,
    unregisterAdminMenu,
    getAdminMenuItems
};
