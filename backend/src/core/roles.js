/**
 * WordJS - Roles Manager
 * Handles dynamic role creation and capability management
 * Persists roles in the options table
 */

const { getOption, updateOption } = require('./options');
const config = require('../config/app');

const ROLES_OPTION_NAME = 'wordjs_user_roles';

/**
 * Get all available roles
 */
function getRoles() {
    const roles = getOption(ROLES_OPTION_NAME);
    if (!roles || Object.keys(roles).length === 0) {
        return config.roles || {};
    }
    return roles;
}

/**
 * Add or Update a role
 */
function setRole(slug, roleData) {
    const roles = getRoles();
    roles[slug] = {
        name: roleData.name,
        capabilities: roleData.capabilities || []
    };
    return updateOption(ROLES_OPTION_NAME, roles);
}

/**
 * Get a single role by slug
 */
function getRole(slug) {
    const roles = getRoles();
    return roles[slug] || null;
}

/**
 * Remove a role
 */
function removeRole(slug) {
    const roles = getRoles();
    if (roles[slug]) {
        delete roles[slug];
        return updateOption(ROLES_OPTION_NAME, roles);
    }
    return false;
}

/**
 * Update capabilities for a specific role
 */
function updateRoleCapabilities(slug, capabilities) {
    const role = getRole(slug);
    if (role) {
        role.capabilities = capabilities;
        return setRole(slug, role);
    }
    return false;
}

/**
 * Get all unique capabilities currently defined across all roles
 */
function getAllAvailableCapabilities() {
    const roles = getRoles();
    const caps = new Set();
    Object.values(roles).forEach(role => {
        role.capabilities.forEach(cap => caps.add(cap));
    });

    // Add known core capabilities that might not be assigned yet
    const coreCaps = [
        'read', 'edit_posts', 'publish_posts', 'delete_posts',
        'edit_pages', 'publish_pages', 'delete_pages',
        'manage_categories', 'moderate_comments', 'upload_files',
        'list_users', 'edit_users', 'promote_users', 'delete_users',
        'activate_plugins', 'switch_themes', 'manage_options',
        'edit_theme_options'
    ];
    coreCaps.forEach(cap => caps.add(cap));

    // Add capabilities from registered menus (plugins)
    try {
        const { getAllRegisteredCapabilities } = require('./adminMenu');
        const pluginCaps = getAllRegisteredCapabilities();
        pluginCaps.forEach(cap => caps.add(cap));
    } catch (err) {
        console.warn('Could not load plugin capabilities:', err.message);
    }

    return Array.from(caps);
}

/**
 * Sync roles with configuration on startup
 * Ensures critical capabilities are present
 */
function syncRoles(configRoles) {
    const dbRoles = getRoles();
    let changed = false;

    // Check subscriber specifically for the new capability
    if (dbRoles.subscriber && configRoles.subscriber) {
        const dbCaps = dbRoles.subscriber.capabilities || [];
        const configCaps = configRoles.subscriber.capabilities || [];

        // If DB is missing access_admin_panel but Config has it, FORCE update
        if (!dbCaps.includes('access_admin_panel') && configCaps.includes('access_admin_panel')) {
            console.log('🔄 Syncing Subscriber roles: Adding access_admin_panel');
            dbRoles.subscriber.capabilities = configCaps;
            changed = true;
        }
    }

    // General sync for missing roles
    for (const [slug, role] of Object.entries(configRoles)) {
        if (!dbRoles[slug]) {
            console.log(`➕ Adding missing role: ${slug}`);
            dbRoles[slug] = role;
            changed = true;
        }
    }

    if (changed) {
        updateOption(ROLES_OPTION_NAME, dbRoles);
        return true;
    }
    return false;
}

module.exports = {
    getRoles,
    getRole,
    setRole,
    removeRole,
    updateRoleCapabilities,
    getAllAvailableCapabilities,
    syncRoles
};
