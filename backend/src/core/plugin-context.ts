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
const THEMES_DIR = path.join(__dirname, '../../themes');

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

// Regexes to detect a plugin/theme source frame in a V8 stack trace.
// Matches the real plugins/ and themes/ directories (e.g. ".../plugins/<slug>/index.js"),
// NOT core files like "src/core/plugins.ts" (which is "/core/plugins.ts", no trailing "/<slug>/").
const PLUGIN_FRAME_RE = /[\\/]plugins[\\/]([A-Za-z0-9_.-]+)[\\/]/;
const THEME_FRAME_RE = /[\\/]themes[\\/]([A-Za-z0-9_.-]+)[\\/]/;

/**
 * SECURITY: Fallback plugin detection via the call stack.
 *
 * The AsyncLocalStorage context (getCurrentPlugin) is only set while code runs inside
 * runWithContext (plugin init + hook callbacks). Plugin code that executes DETACHED from
 * that wrapper — Express route handlers registered by a plugin, setTimeout/setInterval
 * callbacks, sync hooks, or module top-level — has an empty context, which previously made
 * every runtime guard treat it as trusted core (an RCE bypass). This inspects the current
 * call stack and, if a plugin/theme source file is present, returns that slug so the guards
 * still apply. Accepts an optional `stack` string for testability.
 */
function getPluginFromStack(stack?: string): string | null {
    if (!stack) {
        const holder: any = {};
        // A malicious plugin can set Error.stackTraceLimit = 0 or override
        // Error.prepareStackTrace to blind this scan. Save and force safe values locally,
        // then restore in finally. We do NOT freeze these globally — ts-node /
        // source-map-support legitimately set prepareStackTrace.
        const savedLimit = Error.stackTraceLimit;
        const savedPrepare = Error.prepareStackTrace;
        try {
            Error.stackTraceLimit = 200;
            Error.prepareStackTrace = undefined;
            Error.captureStackTrace(holder, getPluginFromStack);
            stack = holder.stack || '';
        } finally {
            Error.stackTraceLimit = savedLimit;
            Error.prepareStackTrace = savedPrepare;
        }
    }
    const lines = String(stack).split('\n');
    for (const line of lines) {
        const p = line.match(PLUGIN_FRAME_RE);
        if (p) return p[1];
        const t = line.match(THEME_FRAME_RE);
        if (t) return 'theme:' + t[1];
    }
    return null;
}

/**
 * Resolve the effective plugin for a security decision: the AsyncLocalStorage context if
 * present, otherwise the nearest plugin/theme frame on the call stack. Used by the runtime
 * guards (secure-require, permission checks) so detached plugin code cannot escape the sandbox.
 */
function getEffectivePlugin(): string | null {
    return getCurrentPlugin() || getPluginFromStack();
}

/**
 * Check if current context has a specific permission
 */
function hasPermission(scope, access = 'read') {
    // Use the effective plugin (context OR call-stack) so detached plugin code (route
    // handlers, timers, sync hooks) is still subject to its manifest permissions.
    const pluginSlug = getEffectivePlugin();
    if (!pluginSlug) return true; // Core code (no context) has all permissions

    let manifest = manifestCache.get(pluginSlug);

    if (!manifest) {
        let manifestPath;

        if (pluginSlug.startsWith('theme:')) {
            const realSlug = pluginSlug.replace('theme:', '');
            manifestPath = path.join(THEMES_DIR, realSlug, 'manifest.json');
        } else {
            manifestPath = path.join(PLUGINS_DIR, pluginSlug, 'manifest.json');
        }

        if (fs.existsSync(manifestPath)) {
            try {
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                manifestCache.set(pluginSlug, manifest);
            } catch (e) {
                console.error(`[Security] Failed to parse manifest for ${pluginSlug}:`, e.message);
                return false;
            }
        } else if (pluginSlug.startsWith('theme:')) {
            // Default "Safe Mode" Theme Permissions
            // Themes generally only need to READ content and display options.
            // Writing settings should be done via the API/Admin Panel, not by backend logic implicitly.
            manifest = {
                permissions: [
                    { scope: 'settings', access: 'read' },
                    { scope: 'content', access: 'read' }
                ]
            };
            manifestCache.set(pluginSlug, manifest);
            console.log(`[Security] No manifest for theme '${pluginSlug}', applying RESTRICTED default permissions (Read-Only).`);
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
    // SECURITY: Block access to ANY secret-like environment variables
    const sensitiveKeys = [
        'JWT_SECRET',
        'GATEWAY_SECRET',
        'DATABASE_PASSWORD',
        'DB_PASSWORD',
        'SMTP_PASSWORD',
        'SECRET_KEY',
        'API_KEY',
        'POSTGRES_PASSWORD',
        'PRIVATE_KEY',
        'ACCESS_TOKEN',
        'REFRESH_TOKEN',
        'AUTH_SECRET',
        'ENCRYPTION_KEY',
        'SIGNING_KEY'
    ];

    // Also block any key containing these patterns
    const sensitivePatterns = ['_SECRET', '_PASSWORD', '_KEY', '_TOKEN', 'PRIVATE_', 'AUTH_'];

    const isSensitive = (key: any) => {
        const keyStr = key.toString().toUpperCase();
        if (sensitiveKeys.includes(keyStr)) return true;
        return sensitivePatterns.some(pattern => keyStr.includes(pattern));
    };

    const originalEnv = { ...process.env }; // Snapshot for basic security

    return new Proxy(process.env, {
        get(target: any, prop) {
            const pluginSlug = getEffectivePlugin();
            if (pluginSlug && isSensitive(prop)) {
                console.warn(`[Security] Plugin '${pluginSlug}' tried to access sensitive ENV: ${prop.toString()}`);
                return undefined; // Return undefined instead of masked string to mimic non-existence
            }
            return target[prop];
        },
        set(target: any, prop, value) {
            const pluginSlug = getEffectivePlugin();
            if (pluginSlug && isSensitive(prop)) {
                console.warn(`[Security] Plugin '${pluginSlug}' attempted to modify sensitive ENV: ${prop.toString()}`);
                return false;
            }
            target[prop] = value;
            return true;
        },
        // Hide keys from Object.keys(), for...in, JSON.stringify()
        ownKeys(target) {
            const pluginSlug = getEffectivePlugin();
            if (pluginSlug) {
                return Reflect.ownKeys(target).filter(key => !isSensitive(key));
            }
            return Reflect.ownKeys(target);
        },
        // Ensure hidden keys are reported as non-configurable/non-enumerable if accessed directly
        getOwnPropertyDescriptor(target, prop) {
            const pluginSlug = getEffectivePlugin();
            if (pluginSlug && isSensitive(prop)) {
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
    getPluginFromStack,
    getEffectivePlugin,
    hasPermission,
    verifyPermission
};
