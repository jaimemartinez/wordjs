/**
 * WordJS - Secure Require System
 * Runtime interception of sensitive Node.js modules for plugin sandboxing.
 * 
 * This module provides proxied versions of 'fs' and 'child_process' that
 * check permissions at RUNTIME, making the security system immune to code obfuscation.
 */

const { getEffectivePlugin, hasPermission } = require('./plugin-context');
const originalFs = require('fs');
const originalChildProcess = require('child_process');
const path = require('path');

// ============================================
// Security Configuration
// ============================================

const PLUGINS_DIR = path.resolve(__dirname, '../../plugins');
const THEMES_DIR = path.resolve(__dirname, '../../themes');

// Methods that require filesystem:read permission
const FS_READ_METHODS = [
    'readFile', 'readFileSync', 'readdir', 'readdirSync',
    'createReadStream', 'stat', 'statSync', 'lstat', 'lstatSync',
    'existsSync', 'access', 'accessSync', 'realpath', 'realpathSync',
    'readlink', 'readlinkSync', 'opendir', 'opendirSync'
];

// Methods that require filesystem:write permission
const FS_WRITE_METHODS = [
    'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
    'createWriteStream', 'mkdir', 'mkdirSync', 'rmdir', 'rmdirSync',
    'unlink', 'unlinkSync', 'rm', 'rmSync', 'rename', 'renameSync',
    'copyFile', 'copyFileSync', 'chmod', 'chmodSync', 'chown', 'chownSync',
    'truncate', 'truncateSync', 'utimes', 'utimesSync', 'link', 'linkSync',
    'symlink', 'symlinkSync', 'open', 'openSync', 'close', 'closeSync',
    'write', 'writeSync', 'ftruncate', 'ftruncateSync'
];

// Link-creating fs methods are DENIED for plugins entirely (even in their own dir): a plugin
// could create a symlink pointing outside its dir and then follow it, and they enable
// check-then-write TOCTOU races on containment. Plugins have no legitimate need for them.
const FS_LINK_DENIED = ['symlink', 'symlinkSync', 'link', 'linkSync'];

// All child_process methods are BLOCKED for plugins
const CHILD_PROCESS_BLOCKED = [
    'exec', 'execSync', 'execFile', 'execFileSync',
    'spawn', 'spawnSync', 'fork'
];

// ============================================
// Helper Functions
// ============================================

/**
 * Check if a path is within the plugin's own directory
 */
// Resolve a path through symlinks so a plugin cannot create a symlink inside its own
// directory pointing outside it and slip past containment. If the target doesn't exist
// yet, resolve its nearest existing parent dir instead. Falls back to the lexical path
// on any error so we never crash on a hostile/odd filesystem.
function realResolve(targetPath) {
    const resolved = path.resolve(targetPath);
    try {
        return originalFs.realpathSync(resolved);
    } catch {
        // Target doesn't exist (e.g. a file about to be written). Resolve the nearest
        // existing ancestor and re-append the remaining segment(s) lexically.
        try {
            let dir = path.dirname(resolved);
            let tail = path.basename(resolved);
            // Walk up until an existing ancestor is found.
            while (dir !== path.dirname(dir)) {
                try {
                    const realDir = originalFs.realpathSync(dir);
                    return path.join(realDir, tail);
                } catch {
                    tail = path.join(path.basename(dir), tail);
                    dir = path.dirname(dir);
                }
            }
        } catch { /* fall through */ }
        return resolved;
    }
}

function isPathWithinPluginDir(pluginSlug, targetPath) {
    if (!pluginSlug) return true;

    const resolvedPath = realResolve(targetPath);

    // Plugin can access its own directory. Use exact match or a trailing-separator
    // prefix so slug 'foo' does NOT match sibling '.../plugins/foo-bar'.
    const pluginDir = realResolve(path.join(PLUGINS_DIR, pluginSlug));
    if (resolvedPath === pluginDir || resolvedPath.startsWith(pluginDir + path.sep)) {
        return true;
    }

    // Theme can access its own directory
    if (pluginSlug.startsWith('theme:')) {
        const themeSlug = pluginSlug.replace('theme:', '');
        const themeDir = realResolve(path.join(THEMES_DIR, themeSlug));
        if (resolvedPath === themeDir || resolvedPath.startsWith(themeDir + path.sep)) {
            return true;
        }
    }

    return false;
}

/**
 * Create a security error with detailed message
 */
function createSecurityError(pluginSlug, action, details = '') {
    const msg = `🛡️ RUNTIME SECURITY BLOCK: Plugin '${pluginSlug}' attempted unauthorized action: ${action}${details ? ` (${details})` : ''}. Add the required permission to manifest.json.`;
    console.error(msg);
    return new Error(msg);
}

// ============================================
// FS Proxy
// ============================================

/**
 * Create a proxied version of the fs module that checks permissions
 */
function createSecureFs() {
    const handler = {
        get(target, prop) {
            // SECURITY: fs.promises is a non-function OBJECT, so without this it would be
            // returned raw and bypass every guard. Hand plugins the secured promises proxy.
            if (prop === 'promises') {
                return getEffectivePlugin() ? createSecureFsPromises() : target.promises;
            }

            const originalMethod = target[prop];

            // If it's not a function, return as-is
            if (typeof originalMethod !== 'function') {
                return originalMethod;
            }

            const pluginSlug = getEffectivePlugin();

            // Core code (no plugin context) has full access
            if (!pluginSlug) {
                return originalMethod;
            }

            // Link/symlink creation is denied for plugins outright (TOCTOU + escape vector).
            if (FS_LINK_DENIED.includes(prop)) {
                return function () {
                    throw createSecurityError(pluginSlug, `fs.${String(prop)}`, 'creating links/symlinks is not permitted for plugins');
                };
            }

            // Check if this is a read method
            if (FS_READ_METHODS.includes(prop)) {
                return function (...args) {
                    const targetPath = args[0];

                    // Allow access to own plugin directory without explicit permission
                    if (isPathWithinPluginDir(pluginSlug, targetPath)) {
                        return originalMethod.apply(target, args);
                    }

                    // Check filesystem:read permission
                    if (!hasPermission('filesystem', 'read')) {
                        throw createSecurityError(pluginSlug, `fs.${prop}`, targetPath);
                    }

                    return originalMethod.apply(target, args);
                };
            }

            // Check if this is a write method
            if (FS_WRITE_METHODS.includes(prop)) {
                return function (...args) {
                    const targetPath = args[0];

                    // Allow write to own plugin directory without explicit permission
                    if (isPathWithinPluginDir(pluginSlug, targetPath)) {
                        return originalMethod.apply(target, args);
                    }

                    // Check filesystem:write permission
                    if (!hasPermission('filesystem', 'write')) {
                        throw createSecurityError(pluginSlug, `fs.${prop}`, targetPath);
                    }

                    return originalMethod.apply(target, args);
                };
            }

            // DENY-BY-DEFAULT: any fs function not explicitly classified as a read or write
            // method (cpSync, openAsBlob, glob, fd-based ops, etc.) is blocked for plugins so
            // there is no un-guarded escape hatch. Non-function props already returned above.
            return function () {
                throw createSecurityError(pluginSlug, `fs.${String(prop)}`, 'is not permitted in the plugin sandbox');
            };
        }
    };

    return new Proxy(originalFs, handler);
}

// ============================================
// Child Process Proxy (Always Blocked for Plugins)
// ============================================

/**
 * Create a proxied version of child_process that ALWAYS blocks plugin access
 */
function createSecureChildProcess() {
    const handler = {
        get(target, prop) {
            const originalMethod = target[prop];

            // If it's not a function, return as-is
            if (typeof originalMethod !== 'function') {
                return originalMethod;
            }

            const pluginSlug = getEffectivePlugin();

            // Core code (no plugin context) has full access
            if (!pluginSlug) {
                return originalMethod;
            }

            // Check if this is a blocked method. HARD-BLOCKED for ALL plugins — no trust tier or
            // permission unlocks shell execution / process spawning from a plugin.
            if (CHILD_PROCESS_BLOCKED.includes(prop)) {
                return function () {
                    throw createSecurityError(
                        pluginSlug,
                        `child_process.${prop}`,
                        'Shell execution / process spawning is blocked for plugins.'
                    );
                };
            }

            // For other methods, return as-is
            return originalMethod.bind(target);
        }
    };

    return new Proxy(originalChildProcess, handler);
}

// ============================================
// Module Cache Interception
// ============================================

const secureFs = createSecureFs();
const secureChildProcess = createSecureChildProcess();

// Store original require
const Module = require('module');
const originalRequire = Module.prototype.require;

/**
 * Install the secure require hook
 * This intercepts require() calls and returns secure versions of sensitive modules
 */
// Resolve the secure replacement for a sensitive module id when a plugin is effective
// (context OR call stack). Returns undefined for non-sensitive ids / core code, so callers
// fall through to the original loader. Only sensitive ids pay the effective-plugin cost.
// Modules whose entire surface is unsafe for plugins (worker spawning, arbitrary code
// compilation, internal Module machinery, debugger control). We return a Proxy that
// resolves fine but throws on ANY use, so require() succeeds but the module is inert.
// NOTE: keep in sync with the ESM import() blocklist in plugin-worker.js (esmBlocked). 'cluster' is
// critical: cluster.fork() spawns a host node process through plumbing it captured at load time —
// it never re-enters the patched require/_load, so it bypasses the child_process proxy entirely.
const BLOCKED_PLUGIN_MODULES = ['worker_threads', 'vm', 'module', 'inspector', 'repl', 'test', 'trace_events', 'cluster', 'async_hooks', 'v8'];

// Raw network/socket modules enable data exfiltration + SSRF straight out of an isolated worker
// (the worker has full Node net access; the isolate boundary is heap-only). Deny them by default and
// allow ONLY when an admin granted the Network permission — a plugin gets no outbound sockets
// otherwise. NOT self-declarable.
const NETWORK_MODULES = new Set(['net', 'tls', 'dgram', 'http', 'https', 'http2', 'dns', 'dns/promises']);

function createBlockedModuleProxy(pluginSlug, norm) {
    // Regular (non-arrow) function so it is usable as both a call target and a
    // constructor (new X()) — both paths throw our security error.
    function thrower(): never {
        throw createSecurityError(pluginSlug, `require('${norm}')`, `module '${norm}' is not permitted in the plugin sandbox`);
    }
    return new Proxy(function () {}, {
        get() { return thrower; },
        apply() { return thrower(); },
        construct() { return thrower(); }
    });
}

function secureModuleFor(id) {
    // Normalize the 'node:' prefix, then match on the FIRST PATH SEGMENT so SUBMODULES of a blocked
    // builtin are caught too — e.g. require('inspector/promises') (its Session.connectToMainThread() is
    // a worker->host escape) or 'dns/promises'. Exact-string matching missed these.
    const norm = String(id).replace(/^node:/, '');
    const base = norm.split('/')[0];
    const isNet = NETWORK_MODULES.has(norm) || NETWORK_MODULES.has(base);
    const isBlocked = BLOCKED_PLUGIN_MODULES.includes(norm) || BLOCKED_PLUGIN_MODULES.includes(base);
    if (base !== 'fs' && base !== 'child_process' && !isBlocked && !isNet) return undefined;
    const pluginSlug = getEffectivePlugin();
    if (!pluginSlug) return undefined;
    if (norm === 'fs/promises') return createSecureFsPromises();
    if (base === 'fs') return secureFs;
    if (base === 'child_process') return secureChildProcess;
    if (isNet) {
        // Raw sockets are allowed ONLY when an admin granted the Network permission. Inside the isolate
        // the grant comes from the bootstrap (cfg → __WORDJS_PLUGIN_NETWORK__) because the DB/config
        // isn't reachable there; on the main thread, fall back to plugin-permissions.
        const isolated = (typeof global !== 'undefined' && (global as any).__WORDJS_ISOLATED__);
        let netGranted = false;
        if (isolated) netGranted = !!(global as any).__WORDJS_PLUGIN_NETWORK__;
        else { try { netGranted = require('./plugin-permissions').isNetworkGranted(pluginSlug); } catch { netGranted = false; } }
        if (netGranted) return undefined;
        return createBlockedModuleProxy(pluginSlug, norm);
    }
    // worker_threads / vm / module / inspector
    return createBlockedModuleProxy(pluginSlug, norm);
}

// ============================================
// Core-module access policy for plugins
// ============================================
// A plugin that loads a core module which itself holds raw fs/child_process or secrets can
// escape the proxies entirely (the core module captured the real modules at load time, before
// any plugin was on the stack). So plugins are DENIED these core modules, and
// config/app is handed back with secrets redacted. Plugin-API modules (options, hooks,
// appRegistry, adminMenu, shortcodes, widgets, middleware/*, config/database) are NOT blocked.
const CORE_DIR = __dirname;
const CONFIG_APP = path.join(CORE_DIR, '../config', 'app');
const BLOCKED_CORE = new Set([
    'plugin-test-runner', 'import-export', 'backup', 'cert-manager', 'certManager',
    'embedded-db', 'plugin-context', 'secure-require', 'io-guard', 'crash-guard', 'configManager'
].map(n => path.join(CORE_DIR, n)));

// Realpath-resolved plugin/theme dirs, used to classify the REQUIRING module by its filename.
let REAL_PLUGINS_DIR: string;
let REAL_THEMES_DIR: string;
try { REAL_PLUGINS_DIR = originalFs.realpathSync(PLUGINS_DIR); } catch { REAL_PLUGINS_DIR = path.resolve(PLUGINS_DIR); }
try { REAL_THEMES_DIR = originalFs.realpathSync(THEMES_DIR); } catch { REAL_THEMES_DIR = path.resolve(THEMES_DIR); }

// Extract the plugin/theme slug from a requiring module's filename, or null if it is NOT
// plugin/theme code (i.e. core). The policy keys on WHO requires (the immediate requirer),
// not the ambient effective plugin — so core modules can require core modules even while
// running inside a plugin's async context.
function requirerSlug(filename: string): string | null {
    if (!filename) return null;
    let real: string;
    try { real = originalFs.realpathSync(filename); } catch { real = filename; }
    if (real.startsWith(REAL_PLUGINS_DIR + path.sep)) {
        return real.slice(REAL_PLUGINS_DIR.length + 1).split(path.sep)[0];
    }
    if (real.startsWith(REAL_THEMES_DIR + path.sep)) {
        return 'theme:' + real.slice(REAL_THEMES_DIR.length + 1).split(path.sep)[0];
    }
    return null;
}

let _secureConfig: any = null;
function secureConfig() {
    if (!_secureConfig) {
        const real: any = originalRequire.call(module, '../config/app');
        const SECRET = new Set(['jwtSecret', 'gatewaySecret', 'dbPassword']);
        // Strip secret-ish keys from any nested config object (defense against field-blocklist rot:
        // redis.password, smtp pass, etc. — anything whose key name looks like a credential).
        const SECRET_KEY_RE = /pass|secret|key|token|credential/i;
        const scrub = (obj: any): any => {
            if (!obj || typeof obj !== 'object') return obj;
            const out: any = Array.isArray(obj) ? [] : {};
            for (const k of Object.keys(obj)) {
                if (SECRET_KEY_RE.test(k)) continue;          // drop credential-like fields
                out[k] = (obj[k] && typeof obj[k] === 'object') ? scrub(obj[k]) : obj[k];
            }
            return out;
        };
        _secureConfig = new Proxy(real, {
            get(t: any, p) {
                if (SECRET.has(p as string)) return undefined;
                const v = t[p];
                // Return a scrubbed deep copy of nested objects so no credential leaks through.
                return (v && typeof v === 'object') ? scrub(v) : v;
            },
            set() { return false; } // read-only view for plugins
        });
    }
    return _secureConfig;
}

const CONFIG_DB = path.join(CORE_DIR, '../config', 'database');

// Core tables holding credentials / roles / secrets. Plugins get a SCOPED dbAsync that refuses
// raw SQL touching these, so `database` permission can't be abused to read password hashes
// (users), self-escalate (user_meta role), or steal stored secrets (options). Plugins use their
// OWN tables (and the getOption/User APIs) for legitimate needs; this applies to every plugin.
const PROTECTED_CORE_TABLES = new Set([
    'users', 'user_meta', 'usermeta', 'options', 'user_roles', 'roles', 'sessions'
]);

function extractSqlTables(sql): string[] {
    const out: string[] = [];
    const re = /\b(?:from|join|into|update|table(?:\s+if\s+not\s+exists)?)\s+["'`\[]?([a-z_][a-z0-9_]*)/gi;
    let m;
    while ((m = re.exec(String(sql || '')))) out.push(m[1].toLowerCase());
    return out;
}

function guardPluginSql(sql) {
    for (const t of extractSqlTables(sql)) {
        if (PROTECTED_CORE_TABLES.has(t)) {
            throw createSecurityError(getEffectivePlugin() || 'plugin', `dbAsync(${t})`,
                'plugins may not access core credential/role/option tables via raw SQL');
        }
    }
}

let _secureDb: any = null;
function secureDatabase() {
    if (!_secureDb) {
        const real: any = originalRequire.call(module, '../config/database');
        const rawDb = real && real.dbAsync;
        if (!rawDb) { _secureDb = real; return _secureDb; }
        const QUERY_METHODS = new Set(['run', 'get', 'all', 'exec', 'each']);
        const guardedDb = new Proxy(rawDb, {
            get(t: any, p) {
                // Run the table-scope guard BEFORE resolving the underlying method. Accessing t[p]
                // can itself throw — the dbAsync proxy resolves the LIVE driver on every property
                // access, which errors if the DB isn't initialized — so resolving it first would mask
                // the security guard with an unrelated DB-state error. A plugin's SQL against a core
                // table (users/options/…) must be blocked regardless of driver readiness.
                if (typeof p === 'string' && QUERY_METHODS.has(p)) {
                    return function (sql: any, ...rest: any[]) {
                        guardPluginSql(sql);
                        const v = t[p];
                        return typeof v === 'function' ? v.call(t, sql, ...rest) : v;
                    };
                }
                return t[p];
            }
        });
        _secureDb = new Proxy(real, {
            get(t: any, p) { return p === 'dbAsync' ? guardedDb : t[p]; },
            set() { return false; }
        });
    }
    return _secureDb;
}

// Returns a replacement module (sanitized config / scoped db), THROWS for blocked core modules, or
// undefined to fall through. Keys on the REQUIRING module: only a plugin/theme file's OWN
// requires are policed (core->core requires are always allowed, even inside a plugin context).
function corePolicyFor(request, mod): any {
    if (typeof request !== 'string' || request[0] !== '.') return undefined;
    const requirer = mod && mod.filename;
    if (!requirer) return undefined;
    const slug = requirerSlug(requirer);
    if (!slug) return undefined; // core (non-plugin requirer) is unrestricted; plugins are policed uniformly
    let resolved: string;
    try { resolved = Module._resolveFilename(request, mod); } catch { return undefined; }
    const noExt = resolved.replace(/\.[cm]?[jt]s$/, '');
    if (noExt === CONFIG_APP) return secureConfig();
    if (noExt === CONFIG_DB) return secureDatabase();
    if (BLOCKED_CORE.has(noExt)) {
        throw createSecurityError(slug, `require('${request}')`, 'this core module is not accessible to plugins');
    }
    return undefined;
}

function installSecureRequire() {
    // 1. Patch Module.prototype.require (the normal `require('fs')` path).
    Module.prototype.require = function (id) {
        const secure = secureModuleFor(id);
        if (secure !== undefined) return secure;
        const core = corePolicyFor(id, this);
        if (core !== undefined) return core;
        return originalRequire.apply(this, arguments);
    };

    // 2. Patch the lower-level Module._load too. Obfuscation paths like
    //    `require('module').constructor._load('child_process')` bypass Module.prototype.require
    //    but still go through _load, so guard it identically.
    const originalLoad = Module._load;
    Module._load = function (request, _parent, _isMain) {
        const secure = secureModuleFor(request);
        if (secure !== undefined) return secure;
        const core = corePolicyFor(request, _parent);
        if (core !== undefined) return core;
        // Block native .node addons for plugins: compiled bindings hand out raw syscalls
        // and bypass every JS-level guard. Resolve the request to catch indirect paths.
        if (typeof request === 'string' && request.endsWith('.node')) {
            const pluginSlug = getEffectivePlugin();
            if (pluginSlug) {
                throw createSecurityError(pluginSlug, `require('${request}')`, 'native .node addons are blocked for plugins');
            }
        }
        return originalLoad.apply(this, arguments);
    };

    // 3. Block raw native bindings for plugins. process.binding('fs')/('spawn_sync') and
    //    _linkedBinding hand out unproxied syscalls, escaping the require-based guards entirely.
    //    (dlopen is intentionally NOT blocked — legitimate native addons load through it.)
    for (const m of ['binding', '_linkedBinding']) {
        const orig = (process as any)[m];
        if (typeof orig === 'function') {
            (process as any)[m] = function (...args) {
                const pluginSlug = getEffectivePlugin();
                if (pluginSlug) {
                    throw createSecurityError(pluginSlug, `process.${m}`, 'native bindings are blocked for plugins');
                }
                return orig.apply(this, args);
            };
        }
    }

    // 3b. Block process.dlopen for ALL plugins. A native .node addon runs outside every JS-level guard
    //     (require proxies, ALS context) — a direct sandbox escape. No trust tier unlocks it.
    const origDlopen = (process as any).dlopen;
    if (typeof origDlopen === 'function') {
        (process as any).dlopen = function (...args) {
            const pluginSlug = getEffectivePlugin();
            if (pluginSlug) {
                throw createSecurityError(pluginSlug, 'process.dlopen', 'loading native addons is not permitted for plugins');
            }
            return origDlopen.apply(this, args);
        };
    }

    // 3c. process.getBuiltinModule(id) (Node >=22.3) is a DIRECT C++-backed accessor that returns the
    //     fully-formed builtin WITHOUT routing through Module._load / Module.prototype.require / the ESM
    //     loader / process.binding — bypassing every other guard. Route it through the same module
    //     policy for plugins: secure proxy for fs/child_process, inert blocked proxy for
    //     worker_threads/vm/module/net/... Non-sensitive ids fall through to the real builtin.
    const origGetBuiltin = (process as any).getBuiltinModule;
    if (typeof origGetBuiltin === 'function') {
        (process as any).getBuiltinModule = function (id: string) {
            const pluginSlug = getEffectivePlugin();
            if (pluginSlug) {
                const secure = secureModuleFor(id);
                if (secure !== undefined) return secure;
            }
            return origGetBuiltin.apply(this, arguments);
        };
    }

    // 3d. Host-lifecycle / privilege process methods. process.kill/abort can crash the WHOLE host
    //     process from a worker (workers share the host PID), and chdir/umask/setuid/setgid change host
    //     process state — DoS / containment bypass. Throw for any plugin context.
    const PROC_BLOCKED = ['kill', 'abort', 'exit', 'chdir', 'umask', 'setuid', 'setgid', 'seteuid', 'setegid', 'setgroups', 'initgroups', '_kill'];
    for (const m of PROC_BLOCKED) {
        const orig = (process as any)[m];
        if (typeof orig === 'function') {
            (process as any)[m] = function (...args) {
                const pluginSlug = getEffectivePlugin();
                if (pluginSlug) {
                    throw createSecurityError(pluginSlug, `process.${m}`, 'host process control is not permitted in the plugin sandbox');
                }
                return orig.apply(this, args);
            };
        }
    }
    // 3e. process.report.writeReport() writes a diagnostic JSON to an arbitrary host path (file write +
    //     worker-state/secret disclosure), bypassing io-guard. Block it for plugin context.
    try {
        const rep = (process as any).report;
        if (rep && typeof rep.writeReport === 'function') {
            const origWriteReport = rep.writeReport.bind(rep);
            rep.writeReport = function (...args) {
                const pluginSlug = getEffectivePlugin();
                if (pluginSlug) {
                    throw createSecurityError(pluginSlug, 'process.report.writeReport', 'is not permitted in the plugin sandbox');
                }
                return origWriteReport(...args);
            };
        }
    } catch { /* process.report unavailable */ }

    // 4. Anchor plugin-scheduled timers. Capture the effective plugin AT SCHEDULE time (its frame
    //    is on the stack then) and re-enter its context when the callback fires — so a plugin can't
    //    strip its sandbox by deferring fs/exec to a later tick where ALS + the stack frame are gone.
    //    Core schedulers (no effective plugin) are untouched; in-context schedules keep the same
    //    context they already inherit via ALS (no behavior change).
    // setImmediate / queueMicrotask are intentionally NOT wrapped: they're hot paths and the
    // per-call effective-plugin resolution would tax core throughput for narrow gain. The
    // common deliberate-defer vectors (setTimeout/setInterval) are anchored.
    const timerCtx = require('./plugin-context');
    for (const m of ['setTimeout', 'setInterval']) {
        const orig = (global as any)[m];
        if (typeof orig !== 'function') continue;
        (global as any)[m] = function (cb, ...rest) {
            if (typeof cb === 'function') {
                const slug = timerCtx.getEffectivePlugin();
                if (slug) {
                    const wrapped = function (this: any, ...a: any[]) { return timerCtx.runWithContext(slug, () => cb.apply(this, a)); };
                    return orig.call(this, wrapped, ...rest);
                }
            }
            return orig.apply(this, arguments);
        };
    }

    // 5. Anchor EventEmitter listeners a plugin registers. emit() does NOT propagate ALS, so a
    //    listener a plugin attaches to ANY emitter (process, the hooks monitor, a dep's server
    //    socket, SSE responses) would otherwise run DETACHED when core fires it — the seed of the
    //    detached-listener -> bare-fn-microtask RCE. Capture the plugin at REGISTRATION (cheap ALS
    //    check; only wraps when a plugin is in context, so core/dep listeners are untouched) and
    //    re-enter runWithContext on fire, so the listener and its microtasks carry the plugin context.
    const EventEmitter = require('events');
    const emCtx = require('./plugin-context');
    for (const m of ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']) {
        const orig = EventEmitter.prototype[m];
        if (typeof orig !== 'function') continue;
        EventEmitter.prototype[m] = function (event, listener) {
            const slug = emCtx.getCurrentPlugin();
            if (slug && typeof listener === 'function') {
                // PER-SLUG cache: the SAME listener function may be registered by different plugins (or
                // by the same plugin under different ALS contexts). A single cached closure would bind
                // every registration to the FIRST plugin's slug, leaking one plugin's context into
                // another's listener. Key the wrapper by slug on a Map stored on the listener.
                let cache: Map<string, any> = (listener as any).__wordjsWrappedBySlug;
                if (!cache) {
                    cache = new Map();
                    try { Object.defineProperty(listener, '__wordjsWrappedBySlug', { value: cache, configurable: true, enumerable: false }); }
                    catch (e) { return orig.call(this, event, listener); }
                }
                let wrapped = cache.get(slug);
                if (!wrapped) {
                    wrapped = function (this: any, ...a: any[]) { return emCtx.runWithContext(slug, () => listener.apply(this, a)); };
                    cache.set(slug, wrapped);
                }
                return orig.call(this, event, wrapped);
            }
            return orig.apply(this, arguments);
        };
    }
    // removeListener/off must resolve the wrapped form so plugin listeners can still be removed.
    for (const m of ['removeListener', 'off']) {
        const orig = EventEmitter.prototype[m];
        if (typeof orig !== 'function') continue;
        EventEmitter.prototype[m] = function (event, listener) {
            const slug = emCtx.getCurrentPlugin();
            const cache: Map<string, any> | undefined = listener && (listener as any).__wordjsWrappedBySlug;
            // Prefer the wrapper for the CURRENT slug; fall back to the sole cached wrapper if there is
            // exactly one (the common case where add and remove happen in the same plugin context).
            let w: any;
            if (cache) {
                w = (slug && cache.get(slug)) || (cache.size === 1 ? cache.values().next().value : undefined);
            }
            return orig.call(this, event, w || listener);
        };
    }

    console.log('🛡️ Secure Require: Runtime security hooks installed for fs and child_process');
}

/**
 * Create secure version of fs/promises
 */
function createSecureFsPromises() {
    // Use the captured RAW fs (not require('fs'), which returns the proxy in plugin context
    // and would make secureFs.promises -> createSecureFsPromises -> require('fs').promises recurse).
    const originalFsPromises = originalFs.promises;

    const handler = {
        get(target, prop) {
            const originalMethod = target[prop];

            if (typeof originalMethod !== 'function') {
                return originalMethod;
            }

            const pluginSlug = getEffectivePlugin();

            if (!pluginSlug) {
                return originalMethod;
            }

            // Determine if read or write
            const isRead = FS_READ_METHODS.includes(prop);
            const isWrite = FS_WRITE_METHODS.includes(prop);

            if (isRead || isWrite) {
                return async function (...args) {
                    const targetPath = args[0];

                    if (isPathWithinPluginDir(pluginSlug, targetPath)) {
                        return originalMethod.apply(target, args);
                    }

                    const permission = isWrite ? 'write' : 'read';
                    if (!hasPermission('filesystem', permission)) {
                        throw createSecurityError(pluginSlug, `fs.promises.${prop}`, targetPath);
                    }

                    return originalMethod.apply(target, args);
                };
            }

            // DENY-BY-DEFAULT for plugins (same rationale as createSecureFs).
            return function () {
                throw createSecurityError(pluginSlug, `fs.promises.${String(prop)}`, 'is not permitted in the plugin sandbox');
            };
        }
    };

    return new Proxy(originalFsPromises, handler);
}

// ============================================
// Exports
// ============================================

module.exports = {
    installSecureRequire,
    createSecureFs,
    createSecureChildProcess,
    // Export for testing
    secureFs,
    secureChildProcess
};
