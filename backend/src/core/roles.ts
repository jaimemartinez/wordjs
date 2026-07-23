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
// Kept short so a missed cross-node revocation (the unsafe, fail-OPEN direction for authorization)
// is corrected quickly. The dedupe is handled by the in-flight flag, not by pre-bumping the stamp,
// so a FAILED background reload does NOT extend staleness for another full TTL.
const ROLES_CACHE_TTL_MS = 10_000; // 10s
let _rolesCacheLoadedAt = 0;
let _rolesRefreshInFlight = false;

// Monotonic local-write epoch (DATA-05). Bumped whenever a LOCAL setRole/updateRoleCapabilities/
// syncRoles mutates _rolesCache. The background TTL refresh captures this epoch before its DB read and
// applies the result ONLY if the epoch is unchanged when the read returns — so a stale read (e.g. from
// a lagging replica, or one that started before a local updateOption commit landed) can never clobber a
// just-applied local edit (the fail-OPEN direction for a capability revocation). The genuine self-heal
// for cross-node changes is preserved: when NO local write raced the refresh, the fresh DB value is
// applied exactly as before.
let _localWriteEpoch = 0;

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
    return _rolesCache;
}

/**
 * Background, non-blocking refresh when the cache has gone stale. Single-flight guarded so a burst of
 * stale reads triggers at most one DB re-read. Errors are swallowed (the current cache stays usable).
 *
 * DATA-05: unlike the startup loadRoles() (which always applies), this background path is a
 * compare-and-set on _localWriteEpoch — it reads the DB and applies the result ONLY if no LOCAL write
 * (setRole/updateRoleCapabilities/syncRoles) landed while the read was in flight. That closes the
 * lost-update window where a stale DB read could overwrite a just-applied local revocation. When no
 * local write raced it, the fresh value is applied exactly as the old loadRoles()-based path did.
 */
function maybeRefreshStaleRoles() {
    if (_rolesRefreshInFlight) return;
    if (Date.now() - _rolesCacheLoadedAt < ROLES_CACHE_TTL_MS) return;
    // The in-flight flag alone dedupes concurrent refreshes — do NOT pre-bump _rolesCacheLoadedAt.
    // The stamp is advanced ONLY on a successful, applied read below. If this background reload FAILS
    // (or is superseded by a local write), the stamp stays old so the very next sync access re-attempts
    // the refresh immediately, instead of believing the cache is fresh and extending stale (over-broad)
    // capabilities for another full TTL (a fail-open authorization window).
    _rolesRefreshInFlight = true;
    const epochAtStart = _localWriteEpoch;
    Promise.resolve()
        .then(() => getOption(ROLES_OPTION_NAME))
        .then((stored: any) => {
            // A local write landed while we were reading — it is strictly fresher than this DB snapshot
            // (which may even predate the local write's commit), so DROP the read and keep the local
            // value. The local write already stamped _rolesCacheLoadedAt, so the cache is fresh.
            if (_localWriteEpoch !== epochAtStart) return;
            if (stored && Object.keys(stored).length > 0) {
                _rolesCache = stored;
                _rolesCacheLoadedAt = Date.now();
            }
            // Empty/missing option: leave the current in-memory cache (which already holds the seeded
            // defaults) untouched — matching loadRoles()'s "never return an empty map" guarantee. We do
            // NOT re-seed/backfill the option here; the startup loadRoles() owns that.
        })
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
async function setRole(slug: string, roleData: any) {
    // Update cache immediately
    if (!_rolesCache) _rolesCache = {};

    _rolesCache[slug] = {
        name: roleData.name,
        capabilities: roleData.capabilities || []
    };
    _rolesCacheLoadedAt = Date.now(); // local write is fresh — reset the TTL clock
    _localWriteEpoch++;               // DATA-05: an in-flight background refresh must not clobber this

    // Persist to DB
    return await updateOption(ROLES_OPTION_NAME, _rolesCache);
}

/**
 * Get a single role by slug
 */
function getRole(slug: string) {
    const roles = getRoles();
    return roles[slug] || null;
}

/**
 * Remove a role
 */
async function removeRole(slug: string) {
    if (!_rolesCache) await loadRoles();

    if (_rolesCache![slug]) {
        delete _rolesCache![slug];
        _rolesCacheLoadedAt = Date.now(); // local write is fresh — reset the TTL clock
        _localWriteEpoch++;               // DATA-05: protect this deletion from a stale background read
        return await updateOption(ROLES_OPTION_NAME, _rolesCache);
    }
    return false;
}

/**
 * Update capabilities for a specific role
 */
async function updateRoleCapabilities(slug: string, capabilities: any[]) {
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
            role.capabilities.forEach((cap: any) => caps.add(cap));
        }
    });

    // Add known core capabilities that might not be assigned yet
    const coreCaps = [
        'read', 'edit_posts', 'publish_posts', 'delete_posts',
        'edit_pages', 'publish_pages', 'delete_pages',
        'manage_categories', 'moderate_comments', 'upload_files',
        'list_users', 'edit_users', 'promote_users', 'delete_users',
        'activate_plugins', 'switch_themes', 'manage_options',
        'edit_theme_options',
        // API tokens are no longer self-service for every logged-in user: creating/listing/revoking a
        // personal API token now requires this capability. Administrators hold it via the '*' wildcard;
        // grant it to another role in Users → Roles to let those users mint their own scoped tokens.
        'manage_api_tokens'
    ];
    coreCaps.forEach(cap => caps.add(cap));

    // Add capabilities from registered menus (plugins)
    try {
        const { getAllRegisteredCapabilities } = require('./adminMenu');
        const pluginCaps = getAllRegisteredCapabilities();
        pluginCaps.forEach((cap: any) => caps.add(cap));
    } catch (err) {
        console.warn('Could not load plugin capabilities:', err.message);
    }

    return Array.from(caps);
}

/**
 * Sync roles with configuration on startup
 * Ensures critical capabilities are present
 */
async function syncRoles(configRoles: any) {
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
        _localWriteEpoch++;               // DATA-05: protect this local sync from a stale background read
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
