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
function runWithContext(pluginSlug: string, callback: () => any) {
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
    const als = getCurrentPlugin();
    if (als) return als;

    // PERF: inside an isolated worker the answer is already known without walking a stack. The
    // worker runs exactly ONE plugin and contains no core code, so the isolation markers below are
    // authoritative — the stack scan could only ever agree with them. Consulting them FIRST skips a
    // 200-frame Error.captureStackTrace (plus a prepareStackTrace override and per-frame realpath
    // checks) on every ALS-less call in the child: option reads, env reads, detached callbacks.
    // Same value, same fail-closed guarantee, no walk. The markers are read off `globalThis` for the
    // reason spelled out below, and that reasoning is unchanged by consulting them earlier.
    const gEarly: any = (typeof globalThis !== 'undefined') ? globalThis : {};
    if (gEarly.__WORDJS_ISOLATED__ && typeof gEarly.__WORDJS_PLUGIN_SLUG__ === 'string') {
        return gEarly.__WORDJS_PLUGIN_SLUG__;
    }

    // MAIN THREAD (host): the stack scan stays exactly where it was. It is the defense-in-depth that
    // catches host-side theme/plugin frames, and removing it would rest on the claim that no
    // in-process plugin code can ever exist — a security argument that belongs with a full
    // adversarial re-run, not with a performance change.
    const ctx = getPluginFromStack();
    if (ctx) return ctx;
    // FAIL-CLOSED inside an isolated plugin worker: the worker runs ONE plugin and contains NO
    // legitimate "core" code (core lives on the host, reached only via the RPC bridge). So any code
    // with no ALS context AND no plugin stack frame — the entry's top-level, or a detached callback
    // (setImmediate / queueMicrotask / Promise.then, or one whose stack was deliberately stripped) —
    // is STILL the worker's plugin and must stay sandboxed, never fall through to unguarded "core"
    // access. On the MAIN thread, null genuinely means core, so we keep returning null there.
    // Read the isolation markers off `globalThis`, NOT the free identifier `global`: `global` is a
    // WRITABLE+CONFIGURABLE property of the global object, so a plugin doing `global = {}` (a bare
    // identifier assignment no scanner visitor flags) would swap what this reads and make the markers come
    // back `undefined` — collapsing this fail-closed backstop to `return null` (host context) and handing
    // the plugin the RAW fs. `globalThis` is non-writable/non-configurable per spec (unreassignable) and the
    // two markers are locked on it, so this reference cannot be defeated the same way.
    const g: any = (typeof globalThis !== 'undefined') ? globalThis : {};
    if (g.__WORDJS_ISOLATED__ && typeof g.__WORDJS_PLUGIN_SLUG__ === 'string') {
        return g.__WORDJS_PLUGIN_SLUG__;
    }
    return null;
}

/**
 * Check if current context has a specific permission
 */
function hasPermission(scope: string, access = 'read') {
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

    // (1) The manifest must DECLARE the capability (the plugin's request).
    const declared = manifest.permissions.some((p: any) =>
        p.scope === scope &&
        (p.access === access || p.access === 'admin')
    );
    if (!declared) {
        console.log(`[Security Block] Plugin '${pluginSlug}' attempted undeclared permission: ${scope}:${access}`);
        return false;
    }

    // (2) DEFAULT-DENY: a declared permission is only a REQUEST. An admin must GRANT it per-plugin in the
    // UI (Android-style) — there is no trust tier that bypasses this. Enforced host-side (the bridge runs
    // on the host, where grants are in memory).
    let granted = false;
    try { granted = require('./plugin-permissions').isGranted(pluginSlug, scope, access); } catch { granted = false; }
    if (!granted) {
        console.log(`[Security Block] Plugin '${pluginSlug}' permission ${scope}:${access} is declared but NOT granted by the admin (grant it in /admin/plugins).`);
    }
    return granted;
}

/**
 * Strong enforcement helper: Throws error if permission is missing
 */
function verifyPermission(scope: string, access = 'read') {
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

    // Spawn/module-load-poisoning env vars are NEVER legitimately rewritten at runtime by the server, so
    // deny writes to them UNCONDITIONALLY (not merely in plugin/theme context). This closes the detached
    // main-thread callback hole where getEffectivePlugin() resolves to null and the context-gated denials
    // below don't fire — e.g. an in-process theme scheduling
    // setImmediate(Reflect.defineProperty.bind(Reflect, process.env, 'NODE_OPTIONS', {...})) (#17). Reads
    // are unaffected; only writes to this fixed denylist are blocked.
    // NOTE: intentionally BROAD and case-insensitive. Includes the Windows shell/loader vars (COMSPEC =
    // the cmd.exe path used by child_process shell:true; PATHEXT/ WINDIR/ SYSTEMROOT resolve executables;
    // NODE_PATH injects a module search dir) alongside the POSIX loader vars, since the deployment target
    // is win32 and any of these poisons the next spawn/module-load (#6/#17).
    const SPAWN_CRITICAL_ENV = /^(?:NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|NODE_ICU_DATA|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|DYLD_FRAMEWORK_PATH|BASH_ENV|ENV|PATH|PATHEXT|COMSPEC|WINDIR|SYSTEMROOT|PYTHONPATH|PERL5LIB|GIT_EXEC_PATH|OPENSSL_CONF|OPENSSL_ENGINES|OPENSSL_MODULES|SSL_CERT_FILE|SSL_CERT_DIR|ICU_DATA)$/i;

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
            if (SPAWN_CRITICAL_ENV.test(String(prop))) {
                console.warn(`[Security] Blocked write to spawn-critical ENV '${String(prop)}' (unconditional).`);
                return false;
            }
            const pluginSlug = getEffectivePlugin();
            // A plugin/theme has NO business mutating the host process env. Even a "non-sensitive" var —
            // PATH, NODE_OPTIONS, LD_PRELOAD, NODE_EXTRA_CA_CERTS — poisons the next child_process spawn or
            // module load (RCE). Deny ALL writes in plugin/theme context; host code (no context) is normal.
            if (pluginSlug) {
                console.warn(`[Security] Plugin '${pluginSlug}' attempted to modify ENV '${prop.toString()}' — denied.`);
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
        },
        // Object.defineProperty(process.env, k, {...}) and `delete process.env.k` are WRITE paths that a
        // Proxy WITHOUT these traps forwards straight to the target, bypassing the set() deny above and
        // re-opening NODE_OPTIONS/LD_PRELOAD/PATH poisoning → RCE (#17). Deny both in plugin/theme context.
        defineProperty(target, prop, desc) {
            if (SPAWN_CRITICAL_ENV.test(String(prop))) {
                console.warn(`[Security] Blocked defineProperty on spawn-critical ENV '${String(prop)}' (unconditional).`);
                return false;
            }
            const pluginSlug = getEffectivePlugin();
            if (pluginSlug) {
                console.warn(`[Security] Plugin '${pluginSlug}' attempted Object.defineProperty on ENV '${prop.toString()}' — denied.`);
                return false;
            }
            return Reflect.defineProperty(target, prop, desc);
        },
        deleteProperty(target, prop) {
            if (SPAWN_CRITICAL_ENV.test(String(prop))) {
                console.warn(`[Security] Blocked delete of spawn-critical ENV '${String(prop)}' (unconditional).`);
                return false;
            }
            const pluginSlug = getEffectivePlugin();
            if (pluginSlug) {
                console.warn(`[Security] Plugin '${pluginSlug}' attempted to delete ENV '${prop.toString()}' — denied.`);
                return false;
            }
            return Reflect.deleteProperty(target, prop);
        }
    });
}

// Replace global process.env with protected version
try {
    const protectedEnv = getProtectedEnv();
    Object.defineProperty(process, 'env', {
        value: protectedEnv,
        writable: false,
        // NON-configurable: a plugin/theme running in-process must NOT be able to
        // Object.defineProperty(process, 'env', {...}) to swap out this guard proxy wholesale and thereby
        // dodge the set/defineProperty/deleteProperty denials (#6). Loaded once per process; a duplicate
        // load's redefine throws and is swallowed by the catch below, leaving this proxy in place.
        configurable: false
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
