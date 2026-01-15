/**
 * WordJS - Plugin Context
 * Uses AsyncLocalStorage to track which plugin is currently executing.
 */

const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const path = require('path');
const storage = new AsyncLocalStorage();

// Internal cache for manifests to avoid repeated JS parsing
const manifestCache = new Map();
const PLUGINS_DIR = path.join(__dirname, '../../plugins');

/**
 * Run a function within a specific plugin context
 */
function runWithContext(pluginSlug, callback) {
    return storage.run({ pluginSlug }, callback);
}

/**
 * Get the current plugin slug from context
 */
function getCurrentPlugin() {
    const context = storage.getStore();
    return context ? context.pluginSlug : null;
}

/**
 * Check if current context has a specific permission
 */
function hasPermission(scope, access = 'read') {
    const pluginSlug = getCurrentPlugin();
    if (!pluginSlug) return true; // Core code (no context) has all permissions

    let manifest = manifestCache.get(pluginSlug);

    if (!manifest) {
        const manifestPath = path.join(PLUGINS_DIR, pluginSlug, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            try {
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                manifestCache.set(pluginSlug, manifest);
            } catch (e) {
                console.error(`[Security] Failed to parse manifest for ${pluginSlug}:`, e.message);
                return false;
            }
        }
    }

    if (!manifest || !manifest.permissions) {
        // If manifest doesn't exist or has no permissions, it's a block for plugins
        return false;
    }

    // Check if any permission matches scope and access
    const allowed = manifest.permissions.some(p =>
        p.scope === scope &&
        (p.access === access || p.access === 'admin')
    );

    if (!allowed) {
        console.log(`[Security Block] Plugin '${pluginSlug}' attempted unauthorized: ${scope}:${access}`);
    }

    return allowed;
}

/**
 * Strong enforcement helper: Throws error if permission is missing
 */
function verifyPermission(scope, access = 'read') {
    if (!hasPermission(scope, access)) {
        const slug = getCurrentPlugin();
        const error = `🛡️ Security Block: Plugin '${slug}' tried to access '${scope}' (${access}) without permission. Declare it in manifest.json first.`;
        console.error(error);
        throw new Error(error);
    }
}

/**
 * Protect sensitive environment variables from plugins
 */
function getProtectedEnv() {
    const sensitiveKeys = ['JWT_SECRET', 'DATABASE_PASSWORD', 'SMTP_PASSWORD', 'SECRET_KEY', 'API_KEY', 'POSTGRES_PASSWORD'];
    const originalEnv = { ...process.env }; // Snapshot for basic security

    return new Proxy(process.env, {
        get(target, prop) {
            const pluginSlug = getCurrentPlugin();
            if (pluginSlug && sensitiveKeys.includes(prop.toString())) {
                console.warn(`[Security] Plugin '${pluginSlug}' tried to access sensitive ENV: ${prop.toString()}`);
                return undefined; // Return undefined instead of masked string to mimic non-existence
            }
            return target[prop];
        },
        set(target, prop, value) {
            const pluginSlug = getCurrentPlugin();
            if (pluginSlug && sensitiveKeys.includes(prop.toString())) {
                console.warn(`[Security] Plugin '${pluginSlug}' attempted to modify sensitive ENV: ${prop.toString()}`);
                return false;
            }
            target[prop] = value;
            return true;
        },
        // Hide keys from Object.keys(), for...in, JSON.stringify()
        ownKeys(target) {
            const pluginSlug = getCurrentPlugin();
            if (pluginSlug) {
                return Reflect.ownKeys(target).filter(key => !sensitiveKeys.includes(key.toString()));
            }
            return Reflect.ownKeys(target);
        },
        // Ensure hidden keys are reported as non-configurable/non-enumerable if accessed directly
        getOwnPropertyDescriptor(target, prop) {
            const pluginSlug = getCurrentPlugin();
            if (pluginSlug && sensitiveKeys.includes(prop.toString())) {
                return undefined;
            }
            return Reflect.getOwnPropertyDescriptor(target, prop);
        }
    });
}

// Replace global process.env with protected version
try {
    const protectedEnv = getProtectedEnv();
    Object.defineProperty(process, 'env', {
        value: protectedEnv,
        writable: false,
        configurable: true // Allow us to fix it if we break it during dev
    });
} catch (e) {
    console.error('[Security] Failed to install process.env proxy:', e.message);
}

module.exports = {
    runWithContext,
    getCurrentPlugin,
    hasPermission,
    verifyPermission
};
