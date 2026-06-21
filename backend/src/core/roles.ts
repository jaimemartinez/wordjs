/**
 * WordJS - Roles Manager
 * Handles dynamic role creation and capability management
 * Persists roles in the options table
 */

const { getOption, updateOption } = require('./options');
const config = require('../config/app');

const ROLES_OPTION_NAME = 'wordjs_user_roles';

// Built-in WordPress-style roles. These are the source of truth when the stored wordjs_user_roles
// option is empty/missing — which it was on every install, because options seeded it from the
// hardcoded-empty config.roles, leaving every role (administrator included) with NO capabilities
// and the admin Roles page showing nothing. config.roles, when an operator sets it, still wins.
const DEFAULT_ROLES: Record<string, { name: string; capabilities: string[] }> = {
    administrator: {
        name: 'Administrator',
        // '*' is the all-capabilities wildcard understood by User.can() / the frontend can() helper.
        capabilities: ['*']
    },
    editor: {
        name: 'Editor',
        capabilities: [
            'read', 'access_admin_panel', 'upload_files',
            'edit_posts', 'edit_others_posts', 'edit_published_posts', 'publish_posts',
            'delete_posts', 'delete_others_posts', 'delete_published_posts',
            'edit_pages', 'edit_others_pages', 'edit_published_pages', 'publish_pages',
            'delete_pages', 'delete_others_pages', 'delete_published_pages',
            'manage_categories', 'moderate_comments'
        ]
    },
    author: {
        name: 'Author',
        capabilities: [
            'read', 'access_admin_panel', 'upload_files',
            'edit_posts', 'edit_published_posts', 'publish_posts',
            'delete_posts', 'delete_published_posts'
        ]
    },
    contributor: {
        name: 'Contributor',
        capabilities: ['read', 'access_admin_panel', 'edit_posts', 'delete_posts']
    },
    subscriber: {
        name: 'Subscriber',
        capabilities: ['read', 'access_admin_panel']
    }
};

// Deep clone so callers/mutations (updateRoleCapabilities, syncRoles) never alter the constant.
const defaultRoles = (): Record<string, any> => JSON.parse(JSON.stringify(DEFAULT_ROLES));

// Cache roles in memory for synchronous access (required by User.toJSON)
let _rolesCache: Record<string, any> | null = null;

// Freshness fallback (multi-node safety net): the primary invalidation path is the Redis pub/sub
// signal handled in coherence.ts. But if Redis is down (or a publish is missed), a role/capability
// REVOCATION on another node would never reach this in-process cache, leaving stale (over-broad)
// capabilities until restart. So we stamp when the cache was loaded and, on synchronous access,
// trigger a background re-read once the cache is older than ROLES_CACHE_TTL_MS. This bounds staleness
// to the TTL (+ one request) and self-heals a missed invalidation, WITHOUT slowing the sync fast path
// (we never block getRoles(); the refresh applies to subsequent calls). The pub/sub fast path still
// invalidates instantly when available.
const ROLES_CACHE_TTL_MS = 30_000; // 30s
let _rolesCacheLoadedAt = 0;
let _rolesRefreshInFlight = false;

/**
 * Initialize roles from DB (Async)
 * Must be called on app startup
 */
async function loadRoles() {
    const stored = await getOption(ROLES_OPTION_NAME);
    if (stored && Object.keys(stored).length > 0) {
        _rolesCache = stored;
    } else {
        // Empty/missing option: fall back to the built-in defaults (operator config.roles overrides)
        // and backfill the option so the roles are durable and visible to anything reading the DB.
        _rolesCache = { ...defaultRoles(), ...(config.roles || {}) };
        try {
            await updateOption(ROLES_OPTION_NAME, _rolesCache);
        } catch (e: any) {
            console.warn('Could not persist default roles:', e?.message);
        }
    }
    _rolesCacheLoadedAt = Date.now(); // stamp freshness on every (re)load
    console.log(`DEBUG: Roles loaded into cache. Count: ${Object.keys(_rolesCache || {}).length}`);
    return _rolesCache;
}

/**
 * Background, non-blocking refresh when the cache has gone stale. Single-flight guarded so a burst of
 * stale reads triggers at most one DB re-read. Errors are swallowed (the current cache stays usable).
 */
function maybeRefreshStaleRoles() {
    if (_rolesRefreshInFlight) return;
    if (Date.now() - _rolesCacheLoadedAt < ROLES_CACHE_TTL_MS) return;
    _rolesRefreshInFlight = true;
    // Bump the stamp NOW so we don't queue another refresh while this one is in flight even if it's
    // slow; loadRoles() will stamp again with the real load time on completion.
    _rolesCacheLoadedAt = Date.now();
    Promise.resolve()
        .then(() => loadRoles())
        .catch((e: any) => console.warn('[roles] background TTL refresh failed:', e && e.message))
        .finally(() => { _rolesRefreshInFlight = false; });
}

/**
 * Get all available roles (Synchronous from cache)
 */
function getRoles() {
    // If not loaded yet, fall back to the built-in defaults merged with operator config (safe for
    // startup/tests). Never return an empty map — that strips every user of their capabilities.
    if (!_rolesCache) {
        return { ...defaultRoles(), ...(config.roles || {}) };
    }
    // Bound staleness: kick a background re-read if the cache aged past the TTL (self-heals a missed
    // cross-node invalidation). Non-blocking — returns the current cache immediately.
    maybeRefreshStaleRoles();
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
    _rolesCacheLoadedAt = Date.now(); // local write is fresh — reset the TTL clock

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

    if (_rolesCache![slug]) {
        delete _rolesCache![slug];
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
    Object.values(roles).forEach((role: any) => {
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

    const dbRoles = _rolesCache!; // Work on reference
    let changed = false;

    // Built-in defaults guarantee the core roles always exist; operator config.roles overrides them.
    const effective = { ...defaultRoles(), ...(configRoles || {}) };

    // Check subscriber specifically for the access_admin_panel capability
    if (dbRoles.subscriber && effective.subscriber) {
        const dbCaps = dbRoles.subscriber.capabilities || [];
        const effCaps = effective.subscriber.capabilities || [];

        // If DB is missing access_admin_panel but the effective definition has it, FORCE update
        if (!dbCaps.includes('access_admin_panel') && effCaps.includes('access_admin_panel')) {
            console.log('🔄 Syncing Subscriber roles: Adding access_admin_panel');
            dbRoles.subscriber.capabilities = effCaps;
            changed = true;
        }
    }

    // General sync for missing roles (seeds the core roles on existing installs whose stored map
    // predates them).
    for (const [slug, role] of Object.entries(effective)) {
        if (!dbRoles[slug]) {
            console.log(`➕ Adding missing role: ${slug}`);
            dbRoles[slug] = role;
            changed = true;
        }
    }

    if (changed) {
        _rolesCache = dbRoles; // Update cache
        _rolesCacheLoadedAt = Date.now(); // local write is fresh — reset the TTL clock
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
