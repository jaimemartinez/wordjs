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
// Loaded EAGERLY here (at module init, before any plugin is on the stack / before installSecureRequire
// patches require) so egress-guard captures the REAL net/tls/dns/... modules, not our proxies. It hands
// back network builtins wrapped with a public-only egress filter for network-granted plugins.
const egressGuard = require('./egress-guard');

// ============================================
// Security Configuration
// ============================================

const PLUGINS_DIR = path.resolve(__dirname, '../../plugins');
const THEMES_DIR = path.resolve(__dirname, '../../themes');
const ROOT_DIR = path.resolve(__dirname, '../../');

// Dirs a plugin can WRITE to but must never LOAD CODE from. A plugin has no legitimate reason to
// require() a module out of uploads/data/os-tmp/logs — those hold attachments, the DB, logs and scratch,
// not modules — so requiring a resolved file under them is a scanner-evasion primitive (write a payload
// there, then load it). This is defence-in-depth alongside io-guard's executable-extension write block,
// which already stops such a .js from being created. Both lexical and realpath forms are recorded so a
// symlink or a symlinked ROOT can't dodge the prefix check. (themes/ and the plugin's OWN dir stay
// requirable — theme functions.js and a plugin's own modules are legitimate.)
const NON_REQUIRABLE_DIRS: string[] = (() => {
    const out = new Set<string>();
    for (const n of ['uploads', 'data', 'os-tmp', 'logs']) {
        const p = path.join(ROOT_DIR, n);
        out.add(p);
        try { out.add(originalFs.realpathSync(p)); } catch { /* dir may not exist yet */ }
    }
    return Array.from(out);
})();

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

// Methods that take TWO paths (source READ, dest WRITE) — both must be checked.
const FS_TWO_PATH = new Set(['copyfile', 'copyfilesync', 'cp', 'cpsync', 'rename', 'renamesync']);

// Single source of truth for fs PATH containment, shared by the callback/sync proxy AND the fs.promises
// proxy so they can't diverge (audit CRITICAL: fs.promises dropped the grant check + link-deny, and
// open()/openSync() — NOT patched by io-guard — skipped isPathSafe entirely). For each path arg it
// enforces: link/symlink deny, reject fd/pathless args, isPathSafe (zones + secret/DB/exec blocks), and
// the own-dir-OR-grant permission gate. Throws on any violation; returns normally when allowed.
function guardFsCall(pluginSlug: string, prop: string, args: any[]): void {
    const p = String(prop).toLowerCase();
    if (FS_LINK_DENIED.includes(prop)) {
        throw createSecurityError(pluginSlug, `fs.${String(prop)}`, 'creating links/symlinks is not permitted for plugins');
    }
    // createReadStream/createWriteStream accept an { fd } that makes Node IGNORE the path arg, so a path
    // check would validate a decoy while the real I/O rides the fd. Deny the pathless form, and defeat a
    // STATEFUL `fd` getter (returns null to this check but a real fd to Node's later read — TOCTOU, #4) by
    // STRIPPING fd from a fresh plain-object snapshot so Node can never observe it regardless of the getter.
    if (p === 'createreadstream' || p === 'createwritestream') {
        if (args[0] == null) {
            throw createSecurityError(pluginSlug, `fs.${String(prop)}`, 'fd-based / pathless stream creation is not permitted for plugins');
        }
        const o = args[1];
        if (o && typeof o === 'object') {
            const safe: any = {};
            for (const k of Object.keys(o)) safe[k] = (o as any)[k]; // read each getter ONCE
            delete safe.fd;                                          // Node now cannot receive an fd
            args[1] = safe;
        }
    }
    const { isPathSafe } = require('./io-guard');
    // [path, isWriteForThatPath] pairs: two-path ops read arg0 + write arg1; everything else is arg0.
    const pairs: [any, boolean][] = FS_TWO_PATH.has(p)
        ? [[args[0], false], [args[1], true]]
        : [[args[0], FS_WRITE_METHODS.includes(prop as string)]];
    for (const [targetPath, isWrite] of pairs) {
        if (targetPath == null) continue;
        const pathy = typeof targetPath === 'string' || Buffer.isBuffer(targetPath) || (typeof targetPath === 'object' && typeof (targetPath as any).href === 'string');
        if (!pathy) {
            // A non-path first arg means an fd/pathless op ({fd} stream, numeric fd) that sidesteps the
            // path check — deny it. A plugin must go through a path-checked open()/read()/write().
            throw createSecurityError(pluginSlug, `fs.${String(prop)}`, 'fd-based / pathless file access is not permitted for plugins');
        }
        if (!isPathSafe(targetPath, isWrite)) {
            throw createSecurityError(pluginSlug, `fs.${String(prop)}`, targetPath);
        }
        if (!isPathWithinPluginDir(pluginSlug, targetPath) && !hasPermission('filesystem', isWrite ? 'write' : 'read')) {
            throw createSecurityError(pluginSlug, `fs.${String(prop)}`, targetPath);
        }
    }
}

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
function realResolve(targetPath: string) {
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

function isPathWithinPluginDir(pluginSlug: any, targetPath: any) {
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
function createSecurityError(pluginSlug: any, action: any, details = '') {
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
        get(target: any, prop: any) {
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

            // Read / write / link fs methods: confine via the shared guard (link-deny + fd/pathless-deny +
            // isPathSafe zones/secret/DB/exec + the own-dir-OR-grant permission gate). Crucially this also
            // covers open()/openSync(), which io-guard's method-patch does NOT wrap (audit CRITICAL #4).
            if (FS_LINK_DENIED.includes(prop) || FS_READ_METHODS.includes(prop) || FS_WRITE_METHODS.includes(prop)) {
                return function (...args: any[]) {
                    guardFsCall(pluginSlug, prop, args);
                    return originalMethod.apply(target, args);
                };
            }

            // DENY-BY-DEFAULT: any fs function not explicitly classified as a read or write
            // method (cpSync, openAsBlob, glob, fd-based ops, etc.) is blocked for plugins so
            // there is no un-guarded escape hatch. Non-function props already returned above.
            return function () {
                throw createSecurityError(pluginSlug, `fs.${String(prop)}`, 'is not permitted in the plugin sandbox');
            };
        },
        // Mirror the get-trap guard on [[GetOwnProperty]] so Object.getOwnPropertyDescriptor(proxy, prop) /
        // Reflect.getOwnPropertyDescriptor / getOwnPropertyDescriptors can't hand back the RAW method (or the
        // raw fs.promises object) and bypass the get trap entirely (audit: get-only proxy hole).
        defineProperty(target: any, prop: any, descriptor: any) {
            // Without this trap, Object.defineProperty(proxy, p, {configurable:false}) forwards to the TARGET
            // and makes the real property non-configurable, so the getOwnPropertyDescriptor mirror below
            // (guarded on desc.configurable) falls through and returns the RAW method — a plugin recovers the
            // unguarded fn and bypasses guardFsCall (#3/#4/#10/#18 round-7 flip-configurable escape). A plugin
            // has no legitimate reason to redefine a property on a guarded module: deny it in plugin context.
            const s = getEffectivePlugin();
            if (s) throw createSecurityError(s, 'defineProperty', 'redefining a guarded module property is not permitted');
            return Reflect.defineProperty(target, prop, descriptor);
        },
        getOwnPropertyDescriptor(target: any, prop: any) {
            const desc = Object.getOwnPropertyDescriptor(target, prop);
            if (desc && desc.configurable) {
                // Data property → swap in the GUARDED value. ACCESSOR property (crucially fs.promises is a
                // GETTER, not a data prop!) → return a getter that yields the guarded value, so
                // Object.getOwnPropertyDescriptor(proxy, p).get.call(proxy) can't recover the RAW method/
                // object and bypass the get trap entirely (#3/#4/#11 — the get-only proxy hole, accessor form).
                if ('value' in desc) return { ...desc, value: (handler as any).get(target, prop) };
                if (typeof desc.get === 'function') return { ...desc, get: () => (handler as any).get(target, prop) };
            }
            return desc;
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
        get(target: any, prop: any) {
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

            // DEFAULT-DENY every remaining function (deny-list → allow-list): child_process has NO
            // plugin-safe function, and the old block-list missed the `ChildProcess` CONSTRUCTOR —
            // `new cp.ChildProcess().spawn({file,args,stdio})` spawned an arbitrary process, bypassing
            // every named block (#10) — and would miss any future spawn-capable export. Non-function
            // props (constants) already returned above, so only callable exports are denied here.
            return function () {
                throw createSecurityError(
                    pluginSlug,
                    `child_process.${String(prop)}`,
                    'Shell execution / process spawning is blocked for plugins.'
                );
            };
        },
        // Mirror the get-trap on [[GetOwnProperty]]: without this,
        // Object.getOwnPropertyDescriptor(cp,'spawn').value / ('ChildProcess').value returns the RAW
        // function/constructor and the plugin spawns arbitrary processes, skipping the get trap (#10).
        defineProperty(target: any, prop: any, descriptor: any) {
            // Without this trap, Object.defineProperty(proxy, p, {configurable:false}) forwards to the TARGET
            // and makes the real property non-configurable, so the getOwnPropertyDescriptor mirror below
            // (guarded on desc.configurable) falls through and returns the RAW method — a plugin recovers the
            // unguarded fn and bypasses guardFsCall (#3/#4/#10/#18 round-7 flip-configurable escape). A plugin
            // has no legitimate reason to redefine a property on a guarded module: deny it in plugin context.
            const s = getEffectivePlugin();
            if (s) throw createSecurityError(s, 'defineProperty', 'redefining a guarded module property is not permitted');
            return Reflect.defineProperty(target, prop, descriptor);
        },
        getOwnPropertyDescriptor(target: any, prop: any) {
            const desc = Object.getOwnPropertyDescriptor(target, prop);
            if (desc && desc.configurable) {
                // Data property → swap in the GUARDED value. ACCESSOR property (crucially fs.promises is a
                // GETTER, not a data prop!) → return a getter that yields the guarded value, so
                // Object.getOwnPropertyDescriptor(proxy, p).get.call(proxy) can't recover the RAW method/
                // object and bypass the get trap entirely (#3/#4/#11 — the get-only proxy hole, accessor form).
                if ('value' in desc) return { ...desc, value: (handler as any).get(target, prop) };
                if (typeof desc.get === 'function') return { ...desc, get: () => (handler as any).get(target, prop) };
            }
            return desc;
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

function createBlockedModuleProxy(pluginSlug: any, norm: any) {
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

function secureModuleFor(id: any) {
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
        if (netGranted) {
            // Network is granted — but confine egress to PUBLIC destinations (block loopback / private /
            // link-local / 169.254.169.254 metadata) so the grant isn't a full SSRF + exfil surface.
            // getGuardedModule returns the wrapped builtin, or undefined for dns (resolution is fine; the
            // connect is the sink) → fall through to the real module. Fail CLOSED if the guard errors.
            try {
                const guarded = egressGuard.getGuardedModule(base);
                return guarded !== undefined ? guarded : undefined;
            } catch { return createBlockedModuleProxy(pluginSlug, norm); }
        }
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
    'plugin-context', 'secure-require', 'io-guard', 'crash-guard', 'configManager',
    // Authorization internals: an in-process theme could require these and mutate live authz state to
    // self-escalate — roles.ts getRoles() hands back the _rolesCache BY REFERENCE (a theme flips a role's
    // caps to ['*'], #9); plugin-permissions holds the grant map. 'cache' EXPORTS getClient() which returns
    // a LIVE ioredis client built with host config → a plugin/theme could run arbitrary Redis commands and
    // poison the option cache (#20). No plugin/theme has a legitimate reason to load any of these (they use
    // the RPC bridge / options API). Defense-in-depth alongside the function-level gates.
    'roles', 'plugin-permissions', 'cache'
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

function extractSqlTables(sql: any): string[] {
    const out: string[] = [];
    const re = /\b(?:from|join|into|update|table(?:\s+if\s+not\s+exists)?)\s+["'`\[]?([a-z_][a-z0-9_]*)/gi;
    let m;
    while ((m = re.exec(String(sql || '')))) out.push(m[1].toLowerCase());
    return out;
}

function guardPluginSql(sql: any) {
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
function corePolicyFor(request: any, mod: any): any {
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

function isUnderNonRequirableDir(resolvedPath: string): boolean {
    return NON_REQUIRABLE_DIRS.some(dir => resolvedPath === dir || resolvedPath.startsWith(dir + path.sep));
}

// Fix #3 (scanner-evasion): a plugin/theme module must not require() code out of a writable data dir
// (uploads/data/os-tmp/logs). Keyed on the REQUIRING module (like corePolicyFor) so core code is
// unaffected. Only relative/absolute specifiers can reach an on-disk data dir — a bare specifier
// ('fs', 'lodash') resolves via builtins/node_modules, so skip the resolve cost for those. Defensive:
// never throws on a resolution failure (falls through to normal loading, where io-guard still applies).
function guardPluginRequirePath(request: any, mod: any): void {
    if (typeof request !== 'string') return;
    const slug = requirerSlug(mod && mod.filename);
    if (!slug) return; // core (non-plugin) requirer is unrestricted
    const isTheme = slug.startsWith('theme:');
    // A bare specifier can't reach a writable data dir, so for PLUGINS it's fine here (builtins/core are
    // already handled upstream by secureModuleFor/corePolicyFor). But a THEME requiring a bare PACKAGE pulls
    // UNSCANNED node_modules code into the host process (#8) — resolve and check those too.
    if (request[0] !== '.' && !path.isAbsolute(request) && !isTheme) return;
    let resolved: string;
    try { resolved = Module._resolveFilename(request, mod); } catch { return; }
    if (!path.isAbsolute(resolved)) return; // resolved to a builtin/bare id, not a file
    let real = resolved;
    try { real = originalFs.realpathSync(resolved); } catch { /* not yet on disk — check lexical form */ }
    if (isUnderNonRequirableDir(resolved) || isUnderNonRequirableDir(real)) {
        throw createSecurityError(slug, `require('${request}')`, 'loading code from a writable data directory (uploads/data/os-tmp/logs) is not permitted');
    }
    // Node runs a file of ANY (or no) extension as JavaScript via the default '.js' compiler, so a plugin
    // could write JS to '<owndir>/payload.log' (a DATA extension the executable-write block doesn't match)
    // and require('./payload.log') to run code the install-time AST scan never vetted (#4 variant 2). A
    // legitimate plugin only ever requires .js/.cjs/.mjs/.json/.node — refuse any other resolved extension.
    // .ts/.cts/.mts included because in DEV the whole backend (incl. the core modules a plugin legitimately
    // requires) runs through ts-node; the DATA extensions the exploit needs (.log/.txt/.dat/…) stay blocked.
    // NOTE: also blocks the EMPTY extension — Node's LOAD_AS_FILE tries the exact path FIRST and compiles an
    // extension-LESS file (`require('./payload')` where `payload` has no ext) as JavaScript (#4). A legit
    // require always resolves to one of the listed extensions; a bare/planted file never does.
    const ext = path.extname(resolved).toLowerCase();
    if (!['.js', '.cjs', '.mjs', '.json', '.node', '.ts', '.cts', '.mts'].includes(ext)) {
        throw createSecurityError(slug, `require('${request}')`, `requiring a '${ext || '(no-extension)'}' file is not permitted for plugins (only .js/.cjs/.mjs/.json/.node)`);
    }
    // A THEME runs in-process and its node_modules is NOT AST-scanned; requiring a package (whose code can
    // eval/Function past the static scan) is an unvettable code-injection surface. Themes are presentation-
    // only with no legitimate runtime package dep — block requiring from ANY node_modules (#8).
    if (isTheme && /(^|[\\/])node_modules[\\/]/.test(real)) {
        throw createSecurityError(slug, `require('${request}')`, "requiring package code from a theme's node_modules is not permitted");
    }
}

function installSecureRequire() {
    // 1. Patch Module.prototype.require (the normal `require('fs')` path).
    Module.prototype.require = function (id: any) {
        const secure = secureModuleFor(id);
        if (secure !== undefined) return secure;
        const core = corePolicyFor(id, this);
        if (core !== undefined) return core;
        guardPluginRequirePath(id, this);
        return originalRequire.apply(this, arguments);
    };

    // 2. Patch the lower-level Module._load too. Obfuscation paths like
    //    `require('module').constructor._load('child_process')` bypass Module.prototype.require
    //    but still go through _load, so guard it identically.
    const originalLoad = Module._load;
    Module._load = function (request: any, _parent: any, _isMain: any) {
        const secure = secureModuleFor(request);
        if (secure !== undefined) return secure;
        const core = corePolicyFor(request, _parent);
        if (core !== undefined) return core;
        guardPluginRequirePath(request, _parent);
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
            (process as any)[m] = function (...args: any[]) {
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
        (process as any).dlopen = function (...args: any[]) {
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
            (process as any)[m] = function (...args: any[]) {
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
            rep.writeReport = function (...args: any[]) {
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
        (global as any)[m] = function (cb: any, ...rest: any[]) {
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

    // 4b. Anchor the async-DEFER schedulers a plugin/theme can use to run code on a LATER tick
    //     (setImmediate / queueMicrotask / process.nextTick) — the same sandbox-strip vector as the timers
    //     above: e.g. an in-process theme's `queueMicrotask(()=>require('child_process').execSync(...))` or
    //     code in a never-scanned dist/ that defers its require past the load frame (#8). Cheap ALS-only
    //     check (getCurrentPlugin) captured AT SCHEDULE time (context is live then) — core hot-path
    //     schedules with no plugin context are untouched; only in-context schedules are wrapped to re-enter.
    for (const m of ['setImmediate', 'queueMicrotask']) {
        const orig = (global as any)[m];
        if (typeof orig !== 'function') continue;
        (global as any)[m] = function (cb: any, ...rest: any[]) {
            const slug = typeof cb === 'function' ? timerCtx.getCurrentPlugin() : null;
            if (slug) {
                const wrapped = function (this: any, ...a: any[]) { return timerCtx.runWithContext(slug, () => cb.apply(this, a)); };
                return orig.call(this, wrapped, ...rest);
            }
            return orig.apply(this, arguments);
        };
    }
    {
        const origNextTick = (process as any).nextTick;
        if (typeof origNextTick === 'function') {
            (process as any).nextTick = function (cb: any, ...rest: any[]) {
                const slug = typeof cb === 'function' ? timerCtx.getCurrentPlugin() : null;
                if (slug) {
                    const wrapped = function (this: any, ...a: any[]) { return timerCtx.runWithContext(slug, () => cb.apply(this, a)); };
                    return origNextTick.call(this, wrapped, ...rest);
                }
                return origNextTick.apply(this, arguments);
            };
        }
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
        EventEmitter.prototype[m] = function (event: any, listener: any) {
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
        EventEmitter.prototype[m] = function (event: any, listener: any) {
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

    // 6. Eagerly initialize io-guard NOW, in this core context. io-guard's module top-level does
    //    `const fs = require('fs')` and patches its methods — but secureModuleFor hands back the fs PROXY
    //    whenever getEffectivePlugin() is truthy. If io-guard is first loaded LAZILY (guardFsCall requires
    //    it on the first fs call, which can happen inside a plugin request), it captures the proxy and its
    //    `fs.method = fn` patch trips the proxy's defineProperty trap (a [[Set]] routes through
    //    [[DefineOwnProperty]]) → the whole guard init throws. installSecureRequire always runs at boot with
    //    NO plugin on the stack, so loading io-guard here guarantees it patches the RAW fs — mirroring the
    //    eager `require('./io-guard')` in index.ts / plugin-worker.js, and coupling the two guards so they
    //    can never be initialized out of order. Defensive: never let an io-guard load failure abort install.
    try { require('./io-guard'); } catch (e) { console.error('io-guard eager init failed:', (e as any)?.message); }

    console.log('🛡️ Secure Require: Runtime security hooks installed for fs and child_process');
}

/**
 * Create secure version of fs/promises
 */
// Per-plugin disk write quota for the fs.promises path. io-guard's patch() only wraps the callback/sync
// fs methods, so fs.promises.writeFile/appendFile (and FileHandle.write) would otherwise bypass the disk
// quota and re-open the raw-fs disk-fill DoS. Meter them against io-guard's SAME per-plugin budget.
function meterPromiseWrite(slug: string, prop: string, args: any[]): void {
    let io: any = null;
    try { io = require('./io-guard'); } catch { return; }
    if (!io || typeof io.enforceGrowQuota !== 'function') return;
    // fs.promises.writeFile/appendFile (unlike the callback API) accept an AsyncIterable | Iterable | Stream
    // and stream ALL of it to disk — byteLenOf can't measure that, so it would go UNMETERED and re-open the
    // disk-fill DoS (#14/#24). Require measurable data (string / Buffer / TypedArray / DataView) from plugins.
    if (prop === 'writeFile' || prop === 'appendFile') {
        const d = args[1];
        if (d != null && typeof d !== 'string' && !Buffer.isBuffer(d) && !ArrayBuffer.isView(d)) {
            throw createSecurityError(slug, `fs.promises.${prop}`, 'streaming/iterable write data is not permitted in the sandbox (use a string or Buffer)');
        }
    }
    if (prop === 'appendFile') { io.enforceGrowQuota(slug, io.byteLenOf(args[1])); return; }
    if (prop === 'truncate') { io.enforceGrowQuota(slug, Math.max(0, Number(args[1]) || 0)); return; } // truncate(path,len): len allocates (#24)
    if (prop === 'copyFile' || prop === 'cp') {
        // copyFile/cp DUPLICATE a file (a genuine byte-writer the fix must meter) → charge the SOURCE size
        // to the rolling grow quota (#14). Use the RAW fs to stat so it isn't re-gated as a plugin read.
        let sz = 0; try { sz = originalFs.statSync(args[0]).size; } catch { /* src unstattable */ }
        io.enforceGrowQuota(slug, sz);
        return;
    }
    if (prop === 'writeFile') {
        // EVERY writeFile accumulates against the rolling grow-quota (which itself enforces the per-call
        // single cap first), so a distinct-filename flood via fs.promises can't fill the disk either —
        // matching io-guard's callback-path fix. Append ({flag:'a'} or numeric O_APPEND) is the same
        // growth path; overwrite-writes to distinct names must accumulate too (#14). Floor at one FS block
        // so a 0-byte distinct-filename flood (inode/dir-entry exhaustion) still accrues quota.
        io.enforceGrowQuota(slug, Math.max(io.byteLenOf(args[1]), 4096));
    }
}
// A FileHandle (from fs.promises.open) exposes write/writeFile/appendFile that also skip io-guard — meter
// them too so `const fh = await fsp.open(p,'a'); fh.write(hugeBuf)` can't dodge the quota.
// The write methods live on FileHandle.PROTOTYPE, not the instance — so instance-shadowing (fh[name]=…)
// is trivially bypassed via Object.getPrototypeOf(fh).write.call(fh) (#24). Patch the shared prototype ONCE
// instead: the wrapper meters (and denies createWriteStream) ONLY when a plugin is in context, so host
// FileHandle use (getEffectivePlugin()===null) is byte-for-byte unchanged. Covers every FileHandle,
// including prototype-reached calls, because there is a single prototype object per process.
let _fhProtoPatched = false;
function patchFileHandleProto(fh: any): void {
    if (_fhProtoPatched) return;
    const proto = Object.getPrototypeOf(fh);
    if (!proto) return;
    let io: any = null;
    try { io = require('./io-guard'); } catch { return; }
    if (!io || typeof io.enforceGrowQuota !== 'function') return;
    const ctx = require('./plugin-context');
    for (const name of ['write', 'writeFile', 'appendFile', 'writev', 'truncate']) {
        const orig = proto[name];
        if (typeof orig !== 'function') continue;
        proto[name] = function (this: any, ...a: any[]) {
            const slug = ctx.getEffectivePlugin();
            if (slug) {
                // FileHandle.writeFile/appendFile also accept Stream/Iterable data (unmeasurable) → deny (#14/#24).
                if ((name === 'writeFile' || name === 'appendFile') && a[0] != null && typeof a[0] !== 'string' && !Buffer.isBuffer(a[0]) && !ArrayBuffer.isView(a[0])) {
                    throw createSecurityError(slug, `FileHandle.${name}`, 'streaming/iterable write data is not permitted in the sandbox (use a string or Buffer)');
                }
                let bytes: number;
                if (name === 'writev') bytes = Array.isArray(a[0]) ? a[0].reduce((s: number, b: any) => s + io.byteLenOf(b), 0) : io.byteLenOf(a[0]);
                else if (name === 'truncate') bytes = Math.max(0, Number(a[0]) || 0);
                else bytes = io.byteLenOf(a[0]);
                io.enforceGrowQuota(slug, bytes);
            }
            return orig.apply(this, a);
        };
    }
    // FileHandle.createWriteStream returns a WriteStream writing to the fd, bypassing the metered methods
    // above → unmetered own-dir disk-fill. Deny it for plugins (they can use fh.write/writev/appendFile).
    const origCWS = proto.createWriteStream;
    if (typeof origCWS === 'function') {
        proto.createWriteStream = function (this: any, ...a: any[]) {
            if (ctx.getEffectivePlugin()) throw new Error('🛡️ FileHandle.createWriteStream is not permitted in the plugin sandbox.');
            return origCWS.apply(this, a);
        };
    }
    _fhProtoPatched = true;
}
function wrapFileHandle(slug: string, fh: any): any {
    if (!fh || typeof fh !== 'object') return fh;
    patchFileHandleProto(fh); // one-time prototype patch (metering is context-gated)
    return fh;
}

function createSecureFsPromises() {
    // Use the captured RAW fs (not require('fs'), which returns the proxy in plugin context
    // and would make secureFs.promises -> createSecureFsPromises -> require('fs').promises recurse).
    const originalFsPromises = originalFs.promises;

    const handler = {
        get(target: any, prop: any) {
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
                return async function (...args: any[]) {
                    // SECURITY: confine EXACTLY like the callback/sync proxy via the SHARED guardFsCall so the
                    // two fs surfaces CANNOT diverge — link/symlink hard-deny (#3/#5/#11), fd/pathless deny
                    // (#4), isPathSafe (safe zones + secret/DB/exec blocks), AND the own-dir-OR-grant gate
                    // (#13/#18). The prior inline version ran isPathSafe only: it dropped the link-deny
                    // (fs.promises.link overwrote host code → RCE) and the filesystem grant check (ungranted
                    // plugin read/wrote shared uploads/data/themes) — both fixed by delegating here.
                    guardFsCall(pluginSlug, String(prop), args);
                    // Meter disk writes (own-dir writes bypass the callback-fs io-guard patch). Throws past
                    // the budget. 'open' writes no data here — its FileHandle is metered via wrapFileHandle.
                    if (isWrite && prop !== 'open' && prop !== 'openSync') meterPromiseWrite(pluginSlug, String(prop), args);
                    const r = await originalMethod.apply(target, args);
                    return prop === 'open' ? wrapFileHandle(pluginSlug, r) : r;
                };
            }

            // DENY-BY-DEFAULT for plugins (same rationale as createSecureFs).
            return function () {
                throw createSecurityError(pluginSlug, `fs.promises.${String(prop)}`, 'is not permitted in the plugin sandbox');
            };
        },
        // Mirror the guard on [[GetOwnProperty]] — fs.promises methods are OWN DATA PROPERTIES, so
        // Object.getOwnPropertyDescriptor(fsp,'readFile').value would otherwise return the RAW, unguarded
        // method and skip guardFsCall + the grant gate entirely (audit CRITICAL: get-only proxy hole).
        defineProperty(target: any, prop: any, descriptor: any) {
            // Without this trap, Object.defineProperty(proxy, p, {configurable:false}) forwards to the TARGET
            // and makes the real property non-configurable, so the getOwnPropertyDescriptor mirror below
            // (guarded on desc.configurable) falls through and returns the RAW method — a plugin recovers the
            // unguarded fn and bypasses guardFsCall (#3/#4/#10/#18 round-7 flip-configurable escape). A plugin
            // has no legitimate reason to redefine a property on a guarded module: deny it in plugin context.
            const s = getEffectivePlugin();
            if (s) throw createSecurityError(s, 'defineProperty', 'redefining a guarded module property is not permitted');
            return Reflect.defineProperty(target, prop, descriptor);
        },
        getOwnPropertyDescriptor(target: any, prop: any) {
            const desc = Object.getOwnPropertyDescriptor(target, prop);
            if (desc && desc.configurable) {
                // Data property → swap in the GUARDED value. ACCESSOR property (crucially fs.promises is a
                // GETTER, not a data prop!) → return a getter that yields the guarded value, so
                // Object.getOwnPropertyDescriptor(proxy, p).get.call(proxy) can't recover the RAW method/
                // object and bypass the get trap entirely (#3/#4/#11 — the get-only proxy hole, accessor form).
                if ('value' in desc) return { ...desc, value: (handler as any).get(target, prop) };
                if (typeof desc.get === 'function') return { ...desc, get: () => (handler as any).get(target, prop) };
            }
            return desc;
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
