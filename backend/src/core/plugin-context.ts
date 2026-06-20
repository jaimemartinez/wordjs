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

// Regexes to detect a plugin/theme source frame in a V8 stack trace (string fallback only).
const PLUGIN_FRAME_RE = /[\\/]plugins[\\/]([A-Za-z0-9_.-]+)[\\/]/;
const THEME_FRAME_RE = /[\\/]themes[\\/]([A-Za-z0-9_.-]+)[\\/]/;

// Real (symlink-resolved) plugin/theme dirs — the slug is only trusted if a stack frame's file
// actually resolves to a real file UNDER these dirs (defeats sourceURL/path-substring spoofing).
let REAL_PLUGINS_DIR: string;
let REAL_THEMES_DIR: string;
try { REAL_PLUGINS_DIR = fs.realpathSync(PLUGINS_DIR); } catch { REAL_PLUGINS_DIR = path.resolve(PLUGINS_DIR); }
try { REAL_THEMES_DIR = fs.realpathSync(THEMES_DIR); } catch { REAL_THEMES_DIR = path.resolve(THEMES_DIR); }

// Resolve a stack frame's file to a plugin/theme slug ONLY if it is a real file under the real
// dir. Returns null for non-existent (eval/sourceURL-spoofed) or out-of-dir files.
function slugForFile(fileName: string, baseDir: string, prefix = ''): string | null {
    if (!fileName) return null;
    let real: string;
    try { real = fs.realpathSync(fileName); } catch { return null; } // unverifiable → do not attribute
    const baseWithSep = baseDir + path.sep;
    if (!real.startsWith(baseWithSep)) return null;
    const seg = real.slice(baseWithSep.length).split(path.sep)[0];
    return seg ? prefix + seg : null;
}

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
        // Authoritative path: read structured CallSites and resolve each frame's real file under
        // the real plugins/themes dir. A malicious plugin can set Error.stackTraceLimit = 0 or
        // override Error.prepareStackTrace to blind this — save/force/restore locally (NOT frozen
        // globally; ts-node/source-map-support legitimately set prepareStackTrace).
        const savedLimit = Error.stackTraceLimit;
        const savedPrepare = Error.prepareStackTrace;
        try {
            Error.stackTraceLimit = 200;
            Error.prepareStackTrace = (_e: any, frames: any) => frames; // raw CallSite[]
            const holder: any = {};
            Error.captureStackTrace(holder, getPluginFromStack);
            const frames = holder.stack;
            if (Array.isArray(frames)) {
                for (const f of frames) {
                    let fileName: string | null = null;
                    try { fileName = f.getFileName ? f.getFileName() : null; } catch { fileName = null; }
                    if (!fileName) continue;
                    // Cheap pre-filter so core frames don't pay a realpath syscall.
                    if (fileName.indexOf('plugins') === -1 && fileName.indexOf('themes') === -1) continue;
                    const p = slugForFile(fileName, REAL_PLUGINS_DIR);
                    if (p) return p;
                    const t = slugForFile(fileName, REAL_THEMES_DIR, 'theme:');
                    if (t) return t;
                }
                return null;
            }
        } catch {
            /* fall through to string scan */
        } finally {
            Error.stackTraceLimit = savedLimit;
            Error.prepareStackTrace = savedPrepare;
        }
    }
    // String fallback (only when a stack string is passed in, e.g. tests): regex scan.
    const lines = String(stack || '').split('\n');
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
    const ctx = getCurrentPlugin() || getPluginFromStack();
    if (ctx) return ctx;
    // FAIL-CLOSED inside an isolated plugin worker: the worker runs ONE plugin and contains NO
    // legitimate "core" code (core lives on the host, reached only via the RPC bridge). So any code
    // with no ALS context AND no plugin stack frame — the entry's top-level, or a detached callback
    // (setImmediate / queueMicrotask / Promise.then, or one whose stack was deliberately stripped) —
    // is STILL the worker's plugin and must stay sandboxed, never fall through to unguarded "core"
    // access. On the MAIN thread, null genuinely means core, so we keep returning null there.
    const g: any = (typeof global !== 'undefined') ? global : {};
    if (g.__WORDJS_ISOLATED__ && typeof g.__WORDJS_PLUGIN_SLUG__ === 'string') {
        return g.__WORDJS_PLUGIN_SLUG__;
    }
    return null;
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
