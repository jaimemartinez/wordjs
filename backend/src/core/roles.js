/**
 * WordJS - Roles Manager
 * Handles dynamic role creation and capability management
 * Persists roles in the options table
 */

const { getOption, updateOption } = require('./options');
const config = require('../config/app');

const ROLES_OPTION_NAME = 'wordjs_user_roles';

// Cache roles in memory for synchronous access (required by User.toJSON)
let _rolesCache = null;

/**
 * Initialize roles from DB (Async)
 * Must be called on app startup
 */
async function loadRoles() {
    _rolesCache = await getOption(ROLES_OPTION_NAME);
    if (!_rolesCache || Object.keys(_rolesCache).length === 0) {
        _rolesCache = config.roles || {};
    }
    console.log(`DEBUG: Roles loaded into cache. Count: ${Object.keys(_rolesCache).length}`);
    return _rolesCache;
}

/**
 * Get all available roles (Synchronous from cache)
 */
function getRoles() {
    // If not loaded yet, fallback to config (safe for startup/tests)
    if (!_rolesCache) {
        // console.warn('Warning: getRoles() called before loadRoles(). Returning default config.');
        return config.roles || {};
    }
    return _rolesCache;
}

/**
 * Add or Update a role
 */
async function setRole(slug, roleData) {
    // Update cache immediately
    if (!_rolesCache) _rolesCache = {};

    _rolesCache[slug] = {
        name: roleData.name,
        capabilities: roleData.capabilities || []
    };

    // Persist to DB
    return await updateOption(ROLES_OPTION_NAME, _rolesCache);
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
async function removeRole(slug) {
    if (!_rolesCache) await loadRoles();

    if (_rolesCache[slug]) {
        delete _rolesCache[slug];
        return await updateOption(ROLES_OPTION_NAME, _rolesCache);
    }
    return false;
}

/**
 * Update capabilities for a specific role
 */
async function updateRoleCapabilities(slug, capabilities) {
    const role = getRole(slug);
    if (role) {
        role.capabilities = capabilities;
        return await setRole(slug, role);
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
        if (role.capabilities) {
            role.capabilities.forEach(cap => caps.add(cap));
        }
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
async function syncRoles(configRoles) {
    // Ensure cache is loaded first
    if (!_rolesCache) await loadRoles();

    const dbRoles = _rolesCache; // Work on reference
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
        _rolesCache = dbRoles; // Update cache
        await updateOption(ROLES_OPTION_NAME, dbRoles); // Persist
        return true;
    }
    return false;
}

module.exports = {
    loadRoles,
    getRoles,
    getRole,
    setRole,
    removeRole,
    updateRoleCapabilities,
    getAllAvailableCapabilities,
    syncRoles
};
