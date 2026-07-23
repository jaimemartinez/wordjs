/**
 * WordJS - Isolated Plugin Sandbox Entry (cross-platform, no native deps)
 *
 * Runs ONE plugin inside the sandbox. The host loads this entry in a SEPARATE OS PROCESS
 * (child_process.fork — own heap + OS memory cap; a crash/OOM is contained to the child) or, as a
 * legacy fallback, a worker_threads Worker; the transport abstraction below normalizes both. The
 * plugin reaches core ONLY through the injected `wordjs` bridge, whose calls are RPC'd to the host
 * and permission-checked THERE — the host's heap (secrets, DB handle, other plugins) is unreachable
 * from this isolate. The same runtime guards (secure-require / io-guard) are installed in-process
 * too, so the plugin's own fs/child_process are sandboxed even here.
 *
 * Protocol (JSON, structured-clone safe):
 *   worker -> host: {kind:'call', id, method, args}      // a wordjs.* bridge call
 *                   {kind:'register', hookType, hook, cbId, priority}
 *                   {kind:'invoke-reply', id, ok, value, error}
 *                   {kind:'ready'} | {kind:'init-error', error}
 *   host   -> worker: {kind:'reply', id, ok, value, error}   // reply to a call
 *                     {kind:'invoke', id, cbId, args}        // run a registered callback
 */
'use strict';
// Mark this V8 isolate as a plugin worker BEFORE any core module loads, so core code (e.g.
// config/app) can skip host-only, sandbox-blocked side-effects (reading/persisting
// wordjs-config.json, secret generation) — the worker reaches all of that via the bridge instead.
// Immutable (non-writable, non-configurable) so plugin code can't `delete`/reassign it to defeat the
// guards — getEffectivePlugin()/secure-require key trust decisions on these worker globals.
Object.defineProperty(global, '__WORDJS_ISOLATED__', { value: true, writable: false, configurable: false, enumerable: false });
const { parentPort, workerData } = require('worker_threads');
const path = require('path');

// Transport abstraction: this sandbox entry runs either in a worker_threads Worker (parentPort +
// workerData) OR in a child_process fork (process IPC + a JSON config blob in argv[2]). Normalize both
// to one API so the SAME entry + guards work for either host. child_process is the OS-isolation model
// (separate OS process + OS memory cap; a heap escape / OOM is contained to the child, not the host);
// worker_threads is the legacy/fallback host. The ternaries short-circuit, so parentPort.* is never
// touched when running as a child (parentPort is null there).
const IS_WORKER = !!parentPort;
const cfg = IS_WORKER ? (workerData || {}) : JSON.parse(process.argv[2] || '{}');
const send = IS_WORKER ? parentPort.postMessage.bind(parentPort) : (m) => { try { process.send(m); } catch { /* parent gone */ } };
const onMessage = IS_WORKER ? (cb) => parentPort.on('message', cb) : (cb) => process.on('message', cb);

const { slug, entryFile, coreDir } = cfg;

// Network egress policy. The raw socket modules (net/tls/dns/http/https/...) are denied to plugins
// by secure-require, but the binding-backed globals `fetch`/`WebSocket`/`EventSource` are NOT
// reachable through the module loader, so a denylist there is useless against them — trap the globals
// here. The network grant is supplied by the HOST via cfg (re-resolved on every reload). Immutable so
// a plugin can't self-grant network. `netAllowed` opens ONLY the network gates (raw socket modules +
// fetch/WebSocket/EventSource) — child_process/fs/vm/etc. stay blocked for every plugin.
Object.defineProperty(global, '__WORDJS_PLUGIN_NETWORK__', { value: !!cfg.network, writable: false, configurable: false, enumerable: false });
// Per-plugin egress allowlist (host-resolved at spawn). Immutable so a plugin can't widen its own egress.
// Empty ⇒ allow-all-public (unchanged); non-empty ⇒ egress-guard default-denies unlisted hosts.
Object.defineProperty(global, '__WORDJS_PLUGIN_ALLOWED_HOSTS__', { value: Object.freeze(Array.isArray(cfg.allowedHosts) ? cfg.allowedHosts.slice() : []), writable: false, configurable: false, enumerable: false });
const netAllowed = !!global.__WORDJS_PLUGIN_NETWORK__;
if (!netAllowed) {
    for (const name of ['fetch', 'WebSocket', 'EventSource']) {
        try {
            Object.defineProperty(globalThis, name, {
                configurable: true,
                get() { throw new Error(`[sandbox] global '${name}' (network) is blocked for plugin '${slug}' — grant Network access in the admin UI`); }
            });
        } catch { /* best-effort: if a global is non-configurable, leave it */ }
    }
} else {
    // Network IS granted: enforce the public-only egress policy or a granted plugin can fetch
    // http://169.254.169.254/ (cloud metadata creds), loopback, and internal RFC1918 services.
    // egress-guard is required here (before secure-require installs) so it captures the real net/dns.
    // FAIL CLOSED: if it can't load, block the network globals entirely rather than leave them unfiltered.
    try {
        const eg = require(path.join(coreDir, 'egress-guard'));
        // Install this plugin's egress allowlist BEFORE the connect/dgram guards so the very first outbound
        // connection is already policy-checked. Empty list ⇒ no-op (allow-all-public), so no regression.
        try { eg.setAllowedHosts(global.__WORDJS_PLUGIN_ALLOWED_HOSTS__); } catch { /* best-effort */ }
        // PRIMARY enforcement: patch net.Socket.prototype.connect so EVERY outbound TCP connection in
        // this child is validated AT THE REAL CONNECT against the resolved IP — covers raw net/tls,
        // http/https (incl. custom agent/createConnection), the net.Stream alias, prototype-chain
        // bypasses, AND the connect that undici (global fetch / WebSocket / EventSource) performs. This
        // closes redirect-to-private and DNS-rebinding at the socket layer (the actual IP is checked).
        eg.installChildNetGuard();
        // Same chokepoint for UDP: patch dgram.Socket.prototype.send/.connect in place. Covers EVERY way
        // a plugin obtains a dgram socket — createSocket, `new dgram.Socket()`, AND `await import('dgram')`
        // (the ESM loader bypasses the CJS require proxy, but all instances share this one patched
        // prototype) — validating + pinning the destination IP so none can reach loopback/metadata/private
        // or DNS-rebind. dgram has no `lookup` option, so this is the only reliable UDP chokepoint.
        eg.installChildDgramGuard();
        // Defense-in-depth: fast, clear failures on the binding-backed globals. We DO NOT hand-roll
        // redirects anymore — native fetch follows them AND correctly strips Authorization/Cookie on a
        // cross-origin hop; each hop's connect is IP-validated by the prototype patch above.
        const realFetch = globalThis.fetch;
        if (typeof realFetch === 'function') {
            const guardedFetch = async (input, init) => {
                const url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
                await eg.assertUrlAllowed(url); // fast-fail on an obviously blocked initial host (connect patch is authoritative)
                return realFetch(input, init); // unchanged input/init → no body/header regressions; redirects handled natively + connect-guarded
            };
            Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: guardedFetch });
        }
        for (const wsName of ['WebSocket', 'EventSource']) {
            const Real = globalThis[wsName];
            if (typeof Real === 'function') {
                const Guarded = function (address, ...rest) {
                    eg.assertUrlAllowedSync(String(address)); // fast block of an IP-literal private target; hostname→private is caught at connect
                    return new Real(address, ...rest);
                };
                Guarded.prototype = Real.prototype;
                Object.defineProperty(globalThis, wsName, { configurable: true, writable: true, value: Guarded });
            }
        }
    } catch (e) {
        for (const name of ['fetch', 'WebSocket', 'EventSource']) {
            try {
                Object.defineProperty(globalThis, name, {
                    configurable: true,
                    get() { throw new Error(`[sandbox] network egress guard unavailable for '${slug}' — '${name}' blocked`); }
                });
            } catch { /* */ }
        }
    }
}

// Install the same capability guards inside this isolate (defense-in-depth: even after a heap
// escape the worker can't freely touch fs/child_process), then run the plugin in its context.
try {
    require(path.join(coreDir, 'io-guard'));
    require(path.join(coreDir, 'secure-require')).installSecureRequire();
} catch (e) {
    // FAIL CLOSED: if the in-isolate guards can't install, do NOT run the plugin with only the heap
    // boundary — a missing guard re-opens fs/child_process/network from inside the worker. Abort.
    try { send({ kind: 'fatal', error: `sandbox guard install failed: ${e && e.message}` }); } catch { /* parent gone */ }
    process.exit(1);
}

// ESM dynamic import() guard. import('child_process') uses the V8/Node ESM loader, which does NOT go
// through the CommonJS require proxy (secure-require) — so without this a plugin could
// `await import('node:child_process')` and get the REAL module (host RCE). Install a module-resolution
// hook that rejects sensitive builtins for the plugin. FAIL CLOSED: if no hook API is available,
// refuse to run rather than leave the import() hole open. (require('module')/('url') here resolve to the
// real modules: secure-require is installed but no plugin slug is set yet, so its proxies are inactive.)
{
    const esmBlocked = new Set([
        'child_process', 'fs', 'fs/promises', 'net', 'tls', 'dgram', 'http', 'https', 'http2',
        'dns', 'dns/promises', 'worker_threads', 'vm', 'module', 'inspector', 'repl', 'test',
        'trace_events', 'cluster', 'async_hooks', 'v8'
    ]);
    // A network-granted plugin may import() the TCP/HTTP modules (net/tls/http/https/http2) —
    // installChildNetGuard locks net.Socket.prototype.connect, the single chokepoint every TCP path funnels
    // through, so import() of those is safe. dgram AND dns stay import-BLOCKED because their RAW modules sit
    // BELOW the JS chokepoints: import('dgram') exposes a `lookup`-honoring Socket ctor + the native udp_wrap
    // handle (#19/#22/#27); import('dns') exposes the c-ares Resolver surface (new Resolver().setServers(...)
    // + resolve*/resolveTxt) which egresses over cares_wrap's OWN native sockets — NOT net.Socket.prototype
    // .connect or the dgram prototype — so it bypasses BOTH the connect guard AND the per-plugin egress
    // allowlist (a covert-channel / SSRF hole). The guarded require('dgram')/require('dns') paths (secure-
    // require → egress-guard.getGuardedModule) strip `lookup` and deny the resolver surface while keeping
    // dns.lookup (getaddrinfo, IP-checked at connect), so a plugin loses no legitimate capability.
    if (netAllowed) for (const m of ['net', 'tls', 'http', 'https', 'http2']) esmBlocked.delete(m);
    let esmGuardInstalled = false;
    try {
        const nodeModule = require('module');
        if (typeof nodeModule.registerHooks === 'function') {
            // Node 22.15+/23.5+: synchronous, in-thread resolution hook.
            nodeModule.registerHooks({
                resolve(specifier, context, nextResolve) {
                    const bare = String(specifier).replace(/^node:/, '');
                    // Match the first path segment too, so submodules (inspector/promises, dns/promises) are caught.
                    if (esmBlocked.has(bare) || esmBlocked.has(bare.split('/')[0])) {
                        throw new Error(`[sandbox] import('${specifier}') is blocked for plugin '${slug}'`);
                    }
                    return nextResolve(specifier, context);
                }
            });
            esmGuardInstalled = true;
        } else if (typeof nodeModule.register === 'function') {
            // Node 18.19+/20.6+: async off-thread hooks via a data: URL module (no extra file to ship).
            const { pathToFileURL } = require('url');
            const hookSrc =
                'let blocked = new Set();\n' +
                'export async function initialize(d){ blocked = new Set(d.blocked); }\n' +
                'export async function resolve(spec, ctx, next){\n' +
                '  const bare = String(spec).replace(/^node:/, "");\n' +
                '  if (blocked.has(bare) || blocked.has(bare.split("/")[0])) throw new Error("[sandbox] import(\'" + spec + "\') is blocked for plugin");\n' +
                '  return next(spec, ctx);\n' +
                '}';
            nodeModule.register(
                'data:text/javascript,' + encodeURIComponent(hookSrc),
                pathToFileURL(__filename).href,
                { data: { blocked: [...esmBlocked] } }
            );
            esmGuardInstalled = true;
        }
    } catch {
        esmGuardInstalled = false;
    }
    if (!esmGuardInstalled) {
        try { send({ kind: 'fatal', error: 'sandbox ESM import() guard unavailable — Node >= 18.19 is required to safely run plugins' }); } catch { /* parent gone */ }
        process.exit(1);
    }
}

// Off-heap memory (Buffer / ArrayBuffer / native) is NOT bounded by the Worker's V8 resourceLimits
// (maxOldGenerationSizeMb only caps the JS heap), so a plugin could allocate gigabytes and OOM-crash
// the WHOLE host process. Watchdog: periodically check rss/external and self-terminate if over budget
// (the host treats a worker exit as plugin death and tears it down cleanly). Applies to ALL plugins.
{
    const MEM_BUDGET_BYTES = 512 * 1024 * 1024; // 512 MB rss/external ceiling per plugin
    const memWatch = setInterval(() => {
        try {
            const m = process.memoryUsage();
            if (m.rss > MEM_BUDGET_BYTES || (m.external || 0) > MEM_BUDGET_BYTES) {
                try { send({ kind: 'fatal', error: `[sandbox] plugin '${slug}' exceeded memory budget (rss=${m.rss}, external=${m.external})` }); } catch { /* parent gone */ }
                process.exit(1);
            }
        } catch { /* memoryUsage unavailable — ignore */ }
    }, 2000);
    if (memWatch.unref) memWatch.unref();
}

const { runWithContext } = require(path.join(coreDir, 'plugin-context'));

let _id = 0;
const pending = new Map();         // id -> {resolve,reject} for our calls to the host
const callbacks = new Map();       // cbId -> function (hook/filter callbacks living in this isolate)
const routeHandlers = new Map();   // routeId -> route handler (req,res) living in this isolate
const shortcodeHandlers = new Map(); // scId -> shortcode handler (attrs,content,tag)=>string living here
let mailProvider = null;           // the send(msg) function this isolate provides, if any
const notifyTransports = new Map(); // transport name -> handler(notification) living here

function callHost(method, args) {
    return new Promise((resolve, reject) => {
        const id = ++_id;
        pending.set(id, { resolve, reject });
        send({ kind: 'call', id, method, args });
    });
}

function registerCallback(hookType, hook, cb, priority) {
    const cbId = `${hookType}:${hook}:${++_id}`;
    callbacks.set(cbId, cb);
    send({ kind: 'register', hookType, hook, cbId, priority });
}

// The `wordjs` bridge as seen INSIDE the isolate. Data methods RPC to the host; hook registration
// keeps the callback local and tells the host to install a shim that calls back in.
const wordjs = {
    slug,
    options: { get: (k, d) => callHost('options.get', [k, d]), set: (k, v) => callHost('options.set', [k, v]) },
    db: {
        // Per-plugin table prefix the plugin must use for its own tables (host enforces it). Mirrors
        // the host-side createPluginApi.db.tablePrefix so an isolated plugin can build its table names.
        tablePrefix: ('wjp_' + slug.replace(/[^A-Za-z0-9]+/g, '_') + '_').toLowerCase(),
        all: (sql, p = []) => callHost('db.all', [sql, p]),
        get: (sql, p = []) => callHost('db.get', [sql, p]),
        run: (sql, p = []) => callHost('db.run', [sql, p]),
        createTable: (name, cols) => callHost('db.createTable', [name, cols]),
        getType: () => callHost('db.getType', [])
    },
    hooks: {
        addAction: (hook, cb, priority) => registerCallback('action', hook, cb, priority),
        addFilter: (hook, cb, priority) => registerCallback('filter', hook, cb, priority),
        doAction: (hook, ...args) => callHost('hooks.doAction', [hook, ...args])
    },
    fs: { read: (p, enc) => callHost('fs.read', [p, enc]), write: (p, d) => callHost('fs.write', [p, d]) },
    mail: (msg) => callHost('mail', [msg]),
    // Provide the host-wide mail send function from THIS isolate. The host installs a shim that
    // RPCs back here whenever anything calls wordjs.mail / global.wordjs_send_mail.
    provideMail(handler) {
        mailProvider = handler;
        send({ kind: 'register-mail-provider' });
    },
    notify: Object.assign((n) => callHost('notify', [n]), {
        // Register a notification transport (e.g. 'email') whose handler lives in this isolate.
        registerTransport(name, handler) {
            notifyTransports.set(name, handler);
            send({ kind: 'register-notify-transport', name });
        }
    }),
    adminMenu: { add: (item) => callHost('adminMenu.add', [item]) },
    cron: { schedule: (ts, rec, hook, args) => callHost('cron.schedule', [ts, rec, hook, args]) },
    // CSPRNG bridge — the static validator blocks crypto/globalThis in plugin CODE, so a plugin that
    // needs UNGUESSABLE tokens/codes must get them here (host-backed) instead of Math.random (whose
    // xorshift128+ state is reconstructable from a few outputs). Async (RPC): `await wordjs.crypto.…`.
    crypto: {
        randomToken: (bytes) => callHost('crypto.randomToken', [bytes]),
        randomInt: (min, max) => callHost('crypto.randomInt', [min, max]),
    },

    // Load a script/style from inside your plugin dir onto public pages (needs the 'assets' grant).
    // spec = { handle, src (relative path in your plugin), inFooter?, strategy?:'async'|'defer', media? }
    assets: {
        enqueueScript: (spec) => callHost('assets.enqueueScript', [spec]),
        enqueueStyle: (spec) => callHost('assets.enqueueStyle', [spec]),
    },

    // SAFE user lookups (gated host-side on users:read). Return a SAFE projection
    // {id,userLogin,username,userEmail,displayName,role,hasProfessionalMailbox} — never user_pass.
    // `hasProfessionalMailbox` is the ADMIN-OWNED corporate-mailbox grant (core/mailbox.ts): a plugin
    // must read that boolean, never re-derive it from userEmail, which the account itself can write.
    users: {
        findByEmail: (e) => callHost('users.findByEmail', [e]),
        findByLogin: (l) => callHost('users.findByLogin', [l]),
        findById: (i) => callHost('users.findById', [i]),
        search: (t, lim) => callHost('users.search', [t, lim])
    },
    // SAFE site info (gated host-side on settings:read).
    site: {
        url: () => callHost('site.url', []),
        domain: () => callHost('site.domain', []),
        adminEmail: () => callHost('site.adminEmail', [])
    },
    // Host-mediated DNS (gated host-side on the `network` grant). The isolate denies the raw c-ares
    // resolver surface (dns.resolve*) because it bypasses egress filtering; a mail server reaches MX/TXT
    // records through here. The host strips private-IP A/AAAA answers. Async (RPC): `await wordjs.dns.…`.
    dns: {
        resolveMx: (domain) => callHost('dns.resolveMx', [domain]),
        resolveTxt: (name) => callHost('dns.resolveTxt', [name]),
        resolve4: (host) => callHost('dns.resolve4', [host]),
        resolve6: (host) => callHost('dns.resolve6', [host]),
        resolve: (host) => callHost('dns.resolve', [host])
    },

    // Register a JSON route. `opts` (optional): { auth, admin } -> host applies the real auth
    // middleware before forwarding. The handler runs HERE with a mock (req,res) over RPC: it gets
    // {method,path,query,params,body,user} and replies via res.status().json()/send()/end().
    http: {
        route(method, routePath, opts, handler) {
            if (typeof opts === 'function') { handler = opts; opts = {}; }
            const routeId = `route:${method}:${routePath}:${++_id}`;
            routeHandlers.set(routeId, handler);
            send({ kind: 'register-route', method, routePath, opts: opts || {}, routeId });
        }
    },

    // Register a shortcode. The handler runs HERE (may be async / use the bridge) and returns the
    // HTML string; the host expands it via doShortcodeAsync, forwarding {attrs,content,tag} over RPC.
    shortcodes: {
        add(tag, handler) {
            const scId = `sc:${tag}:${++_id}`;
            shortcodeHandlers.set(scId, handler);
            send({ kind: 'register-shortcode', tag, scId });
        }
    }
};

// Bound a reply payload BEFORE postMessage so a huge object/array can't be structured-cloned onto the
// HOST heap (the host-side cap runs only AFTER the clone). Cheap bounded node-count walk.
function replyTooLarge(v) {
    let n = 0;
    const stack = [v];
    while (stack.length) {
        const cur = stack.pop();
        if (++n > 2000000) return true;
        if (cur && typeof cur === 'object') { for (const k in cur) stack.push(cur[k]); }
    }
    return false;
}

onMessage(async (msg) => {
    if (msg.kind === 'reply') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error));
    } else if (msg.kind === 'invoke') {
        // Host is firing a hook/filter callback that lives in this isolate.
        const cb = callbacks.get(msg.cbId);
        try {
            const value = cb ? await cb(...msg.args) : (msg.args[0]);
            if (replyTooLarge(value)) { send({ kind: 'invoke-reply', id: msg.id, ok: false, error: 'reply payload too large' }); return; }
            send({ kind: 'invoke-reply', id: msg.id, ok: true, value });
        } catch (e) {
            send({ kind: 'invoke-reply', id: msg.id, ok: false, error: String(e && e.message || e) });
        }
    } else if (msg.kind === 'invoke-route') {
        // Host forwarded an HTTP request for a route handler living in this isolate.
        const handler = routeHandlers.get(msg.routeId);
        const reqData = msg.req || {};
        let settled = false;
        const reply = (status, body, headers, cookies) => {
            if (settled) return; settled = true;
            if (replyTooLarge(body)) { send({ kind: 'route-reply', id: msg.id, ok: false, error: 'response body too large' }); return; }
            send({ kind: 'route-reply', id: msg.id, ok: true, response: { status, body, headers, cookies } });
        };
        const res = {
            _status: 200, _headers: undefined, _cookies: undefined,
            status(s) { this._status = s; return this; },
            set(h) { this._headers = Object.assign({}, this._headers, h); return this; },
            // Record cookies; the host replays res.cookie()/clearCookie() on the real response.
            cookie(name, value, options) { (this._cookies = this._cookies || []).push({ name, value, options, clear: false }); return this; },
            clearCookie(name, options) { (this._cookies = this._cookies || []).push({ name, options, clear: true }); return this; },
            json(b) { reply(this._status, b, this._headers, this._cookies); return this; },
            send(b) { reply(this._status, b, this._headers, this._cookies); return this; },
            end() { reply(this._status, undefined, this._headers, this._cookies); return this; }
        };
        try {
            if (!handler) throw new Error('No such route handler');
            await handler(reqData, res);
            if (!settled) reply(res._status, undefined, res._headers);
        } catch (e) {
            send({ kind: 'route-reply', id: msg.id, ok: false, error: String(e && e.stack || e) });
        }
    } else if (msg.kind === 'invoke-shortcode') {
        // Host is expanding a shortcode whose handler lives in this isolate.
        const handler = shortcodeHandlers.get(msg.scId);
        try {
            const out = handler ? await handler(msg.attrs || {}, msg.content || '', msg.tag) : '';
            send({ kind: 'shortcode-reply', id: msg.id, ok: true, value: out == null ? '' : String(out) });
        } catch (e) {
            send({ kind: 'shortcode-reply', id: msg.id, ok: false, error: String(e && e.message || e) });
        }
    } else if (msg.kind === 'invoke-mail') {
        // Host (on behalf of another plugin/core calling wordjs.mail) asks THIS provider to send.
        try {
            const out = mailProvider ? await mailProvider(msg.msg) : (() => { throw new Error('No mail provider'); })();
            send({ kind: 'mail-reply', id: msg.id, ok: true, value: out });
        } catch (e) {
            send({ kind: 'mail-reply', id: msg.id, ok: false, error: String(e && e.message || e) });
        }
    } else if (msg.kind === 'invoke-notify-transport') {
        // Core's notification loop is dispatching through a transport this isolate registered.
        const handler = notifyTransports.get(msg.name);
        try {
            const out = handler ? await handler(msg.notification) : undefined;
            send({ kind: 'notify-transport-reply', id: msg.id, ok: true, value: out });
        } catch (e) {
            send({ kind: 'notify-transport-reply', id: msg.id, ok: false, error: String(e && e.message || e) });
        }
    }
});

// Load + initialize the plugin inside its context.
(async () => {
    try {
        // Fail-closed attribution: from here on, any code in this worker with no ALS context and no
        // plugin stack frame (the entry's top-level, or a detached setImmediate/queueMicrotask/
        // Promise.then callback) is still attributed to THIS plugin by getEffectivePlugin(), so the
        // runtime guards never treat it as unguarded "core". Set only NOW so the worker's own core
        // bootstrap above loaded its modules unproxied.
        // Immutable: this is the fail-closed attribution backstop — plugin code must not be able to
        // `delete global.__WORDJS_PLUGIN_SLUG__` to make getEffectivePlugin() return null (= core).
        Object.defineProperty(global, '__WORDJS_PLUGIN_SLUG__', { value: slug, writable: false, configurable: false, enumerable: false });
        // Require AND init the entry INSIDE the plugin context (ALS), so even the entry's top-level
        // code is sandboxed (previously require(entryFile) ran with an empty context).
        await runWithContext(slug, async () => {
            const plugin = require(entryFile);
            if (typeof plugin === 'function') {
                // Theme functions.js style: `module.exports = (wordjs) => {…}` (a bare function).
                await plugin(wordjs);
            } else if (plugin && typeof plugin.init === 'function') {
                // Plugin style: `exports.init = (wordjs) => {…}`.
                await plugin.init(wordjs);
            }
        });
        send({ kind: 'ready' });
    } catch (e) {
        send({ kind: 'init-error', error: String(e && e.stack || e) });
    }
})();
