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
// Per-spawn frame nonce (see plugin-isolate.ts): the host authenticates every inbound control frame by
// this secret. Read it into a CLOSURE, then SCRUB it from the places plugin code can read — process.argv
// (fork: the cfg blob lives at argv[2], which plugin code can read) and the parsed cfg object — so a plugin
// that writes raw bytes to the inherited IPC fd can never produce a frame the host will accept. Plugin code
// never sees this binding; only this file's `send` (below) stamps frames with it.
const FRAME_NONCE = (cfg && cfg.frameNonce) || '';
try { delete cfg.frameNonce; } catch { /* frozen — best effort */ }
// Rewrite argv[2] to the cfg WITHOUT the nonce (do not blank it: io-guard re-reads argv[2] for its own
// fsRead/fsWrite/storage config on load — see io-guard.ts). Plugin code that reads process.argv[2] now
// gets everything except the secret.
try { if (!IS_WORKER && typeof process.argv[2] === 'string') process.argv[2] = JSON.stringify(cfg); } catch { /* frozen argv — best effort */ }
// THE WORKER'S OWN CHANNEL, captured before secure-require wraps process.send. Plugin code gets a
// guarded process.send that refuses; the worker keeps the original, so only code in this file can
// emit control frames (ready / fatal / register). See secure-require PROC_BLOCKED for why.
const rawSend = (!IS_WORKER && typeof process.send === 'function') ? process.send.bind(process) : null;
const _post = IS_WORKER ? parentPort.postMessage.bind(parentPort) : (m) => { try { rawSend && rawSend(m); } catch { /* parent gone */ } };
// Stamp every outbound frame with the per-spawn nonce so the host accepts it as worker-origin. Plugin code
// cannot read FRAME_NONCE (closure-only, scrubbed from argv/cfg above), so a frame it writes directly to
// the IPC fd is unstamped and the host drops it. (IPC-FORGE)
const send = (m) => _post((m && typeof m === 'object' && FRAME_NONCE) ? { ...m, __wjn: FRAME_NONCE } : m);
const onMessage = IS_WORKER ? (cb) => parentPort.on('message', cb) : (cb) => process.on('message', cb);

const { slug, entryFile, coreDir } = cfg;

/**
 * THE WORKER'S OWN WAY OUT, captured before anything can take it away.
 *
 * secure-require replaces `process.exit` with a guard that throws whenever an effective plugin is on
 * the stack — correct for plugin code, which must never be able to kill the process. But THIS FILE
 * calls process.exit too, in its own lifecycle paths: guard-install failure, the ESM-guard
 * unavailability abort, and the 512 MB memory watchdog. Timer callbacks are deliberately re-entered in
 * the plugin's context (so a plugin cannot strip its sandbox by deferring work to a later tick), so the
 * watchdog's exit runs as if the PLUGIN had called it, and the guard refuses it.
 *
 * Observed on macOS, where a heavy plugin crossed the RSS budget:
 *
 *     RUNTIME SECURITY BLOCK: process.exit (host process control is not permitted in the plugin sandbox)
 *     Error: ... at secure-require.ts:960
 *
 * The child still died — an uncaught throw ends it — but with exit code 7 instead of 1, and with a
 * message that reads as a plugin violating the sandbox when it was the sandbox's own watchdog trying to
 * enforce a limit. A safety mechanism that cannot fire cleanly, and that blames the thing it was
 * protecting against, is worse than one that reports honestly.
 *
 * Bound here, at the top, before any guard is installed. Plugin code never sees this reference.
 */
const hardExit = process.exit.bind(process);

/**
 * REPORT WHAT ACTUALLY WENT WRONG — the guard was replacing it with a lie.
 *
 * With no uncaughtException handler, Node's default path runs `process._fatalException`, and THAT calls
 * `process.exit()`. secure-require has replaced process.exit with a guard that throws whenever a plugin
 * context is on the stack — so the guard fires during Node's own crash handling, and the error the
 * operator sees is:
 *
 *     RUNTIME SECURITY BLOCK: process.exit (host process control is not permitted in the plugin sandbox)
 *         at process._fatalException
 *
 * The original exception is gone. Every uncaught error in any plugin, on any platform, was reported as
 * the plugin attacking the sandbox — and the real cause was never printed. That is how one macOS
 * fixture stayed unexplained through an entire investigation: the message named the wrong thing with
 * total confidence, and there was nothing else to read.
 *
 * Handling it here means Node's fatal path is never reached, so the guard cannot intercept it. The
 * stack goes to stderr, which attachLogLimiter already forwards to the operator's log, and the host is
 * told through the same `fatal` channel the other lifecycle aborts use.
 *
 * The guard itself is unchanged: plugin code calling process.exit is still refused.
 */
// The `fatal` frame's error text is plugin-derived and the host keeps it as operator-facing state
// (health.lastError). Bound it and strip control characters here so a plugin cannot inject forged log
// lines (embedded newlines) or a multi-KB message into that surface. The host also logSafe()s it on the
// way to the log, so this is the belt to that suspenders — the health surface stores the bounded form.
function sanitizeFatal(s) {
    return String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 500);
}
function reportFatalAndExit(what, err) {
    const detail = (err && err.stack) || String((err && err.message) || err);
    try { process.stderr.write(`[sandbox] uncaught ${what} in plugin '${slug}':\n${detail}\n`); } catch { /* stderr gone */ }
    try { send({ kind: 'fatal', error: `[sandbox] uncaught ${what} in plugin '${slug}': ${sanitizeFatal((err && err.message) || err)}` }); } catch { /* parent gone */ }
    hardExit(1);
}
process.on('uncaughtException', (e) => reportFatalAndExit('exception', e));
process.on('unhandledRejection', (e) => reportFatalAndExit('rejection', e));

// THE ENVIRONMENT ALLOW-LIST IS NOT HONOURED BY THE PLATFORM — FINISH IT HERE.
//
// The host spawns this process with an explicit, secret-free env allow-list (SAFE_ENV_KEYS in
// plugin-isolate.ts) rather than inheriting its own environment. On Linux and macOS that is what the
// child gets. ON WINDOWS IT IS NOT: libuv's uv_spawn merges a set of "required" variables into every
// environment block it builds, whatever the caller passed. Measured on this platform, an isolated
// plugin therefore saw five variables nobody granted it:
//
//     LOGONSERVER, SYSTEMDRIVE, USERDOMAIN, USERNAME, USERPROFILE
//
// No secret leaks — a marker set only in the host's environment does NOT survive, so the allow-list
// does hold for everything WordJS or the operator defines. What leaks is the host's identity: the OS
// account name, its home directory path, the AD domain and the domain controller that authenticated it.
// That is reconnaissance handed to untrusted third-party code, and it silently falsified the guarantee
// the host side documents.
//
// The spawn cannot be fixed from the host — the injection is below it. The child CAN fix it, because
// process.env is ours the moment we run and this executes before any plugin code is loaded. The
// allow-list travels in cfg so there is ONE list; a copy here would agree with itself while the host's
// drifted.
if (Array.isArray(cfg.envAllow)) {
    const allowed = new Set(cfg.envAllow.map((k) => String(k).toLowerCase()));
    for (const key of Object.keys(process.env)) {
        if (allowed.has(key.toLowerCase())) continue;
        try { delete process.env[key]; } catch { /* non-configurable: nothing else to try */ }
    }
}

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
// Fail-CLOSED egress signal from the host (audit F-06): the per-plugin egress policy could not be loaded,
// so this network-granted plugin must reach NO public host (private/loopback already blocked) until it
// reloads. Immutable so a plugin can't clear it.
Object.defineProperty(global, '__WORDJS_PLUGIN_EGRESS_DENY_ALL__', { value: !!cfg.egressDenyAll, writable: false, configurable: false, enumerable: false });
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
        // Install this plugin's egress policy BEFORE the connect/dgram guards so the very first outbound
        // connection is already policy-checked. Deny-all (fail-closed, F-06) WINS over the allowlist; an
        // empty allowlist ⇒ no-op (allow-all-public), so no regression for plugins without a configured list.
        try {
            if (global.__WORDJS_PLUGIN_EGRESS_DENY_ALL__) eg.setDenyAllEgress();
            else eg.setAllowedHosts(global.__WORDJS_PLUGIN_ALLOWED_HOSTS__);
        } catch { /* best-effort */ }
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
    const sr = require(path.join(coreDir, 'secure-require'));
    sr.installSecureRequire();
    // Neutralise os's recon surface (networkInterfaces / userInfo / hostname / homedir) on the shared
    // singleton, so BOTH require('os') and import('os') hand the plugin scrubbed values. The worker runs
    // only this one untrusted plugin, so an unconditional scrub after bootstrap is correct here (never
    // done on the host main thread, where core reads the real interfaces).
    if (typeof sr.installOsSandboxScrub === 'function') sr.installOsSandboxScrub();
} catch (e) {
    // FAIL CLOSED: if the in-isolate guards can't install, do NOT run the plugin with only the heap
    // boundary — a missing guard re-opens fs/child_process/network from inside the worker. Abort.
    try { send({ kind: 'fatal', error: `sandbox guard install failed: ${e && e.message}` }); } catch { /* parent gone */ }
    hardExit(1);
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
        'trace_events', 'cluster', 'async_hooks', 'v8',
        // node:sqlite — DatabaseSync opens/creates arbitrary files via native code (bypasses the fs guard)
        // and loadExtension() maps native addons (host RCE). node:wasi — WASI preopens map host dirs into a
        // WASM instance whose native fd_read/fd_write/path_open bypass the fs guard.
        // node:diagnostics_channel — subscribing to the host's internal channels yields every outbound
        // request it makes, headers included (the Authorization bearer). Keep in sync with
        // BLOCKED_PLUGIN_MODULES.
        'sqlite', 'wasi', 'diagnostics_channel',
        // node:tty — blocked on the require side (BLOCKED_PLUGIN_MODULES) because `new tty.WriteStream(3)`
        // wraps the inherited IPC descriptor and destroying it severs the bridge; import() must refuse it too.
        'tty'
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
                    // A bare `_`-prefixed specifier is one of Node's internal builtins (_http_client, _tls_wrap,
                    // _stream_wrap, …): socket/stream primitives BELOW the connect chokepoint, denied on the
                    // require side by secure-require — import() must deny the same set or the twin path is open.
                    // A relative `./_helper` has bare starting with `./`, so a plugin's own file is unaffected.
                    if (bare.startsWith('_') || esmBlocked.has(bare) || esmBlocked.has(bare.split('/')[0])) {
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
                '  if (bare.startsWith("_") || blocked.has(bare) || blocked.has(bare.split("/")[0])) throw new Error("[sandbox] import(\'" + spec + "\') is blocked for plugin");\n' +
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
        hardExit(1);
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
                hardExit(1);
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
    // Host-derived, per-plugin capability storage. These paths are immutable and never point at the
    // shared data/log/os-tmp roots. Raw fs access still requires the corresponding admin grant.
    paths: Object.freeze({
        data: String(cfg.storage && cfg.storage.data || ''),
        logs: String(cfg.storage && cfg.storage.logs || ''),
        tmp: String(cfg.storage && cfg.storage.tmp || ''),
    }),
    options: { get: (k, d) => callHost('options.get', [k, d]), set: (k, v) => callHost('options.set', [k, v]) },
    db: {
        // Per-plugin table prefix the plugin must use for its own tables (host enforces it). Mirrors
        // the host-side createPluginApi.db.tablePrefix so an isolated plugin can build its table names.
        tablePrefix: ('wjp_' + slug.replace(/[^A-Za-z0-9]+/g, '_') + '_').toLowerCase(),
        all: (sql, p = []) => callHost('db.all', [sql, p]),
        get: (sql, p = []) => callHost('db.get', [sql, p]),
        run: (sql, p = []) => callHost('db.run', [sql, p]),
        // Several statements in ONE host round-trip. Every statement is validated exactly as its
        // single-statement counterpart would be (same permission + same SQL guard), so this is a
        // transport optimisation, not a new capability: a handler that made 20 queries paid 20 IPC
        // round-trips (~5-12ms of pure messaging) and now pays one.
        // NOT a transaction: on Postgres/MySQL each statement runs on the plugin's own role
        // connection, so a host-side BEGIN could not wrap them. Semantics are identical to calling
        // the individual methods in order — including partial application if one of them throws.
        batch: (statements) => callHost('db.batch', [statements]),
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

// Bound a reply payload BEFORE postMessage so a huge value can't be structured-cloned onto the HOST heap
// (the host-side cap runs only AFTER the clone). Bounds BOTH the node count AND the estimated cloned SIZE.
//
// The old walker counted only object NODES via `for..in`, which has three holes structured-clone drives
// straight through: (1) a single giant string is one node but clones its full byte length; (2) an
// ArrayBuffer/SharedArrayBuffer/DataView/TypedArray is ~one node but clones byteLength bytes (and `for..in`
// does not even enumerate an ArrayBuffer/DataView); (3) a Map/Set's entries are not `for..in`-enumerable at
// all, so a 10M-entry Map passed as one node. Each let a plugin OOM the host by returning it from a
// hook/route/shortcode/notify handler. Charge bytes for binary/string payloads and descend Map/Set here.
function replyTooLarge(v) {
    const MAX_NODES = 2000000;
    const MAX_BYTES = 96 * 1024 * 1024;   // ~96MB estimated payload — orders of magnitude above any legit reply
    let nodes = 0, bytes = 0;
    const stack = [v];
    while (stack.length) {
        const cur = stack.pop();
        if (++nodes > MAX_NODES) return true;
        const t = typeof cur;
        if (t === 'string') { bytes += cur.length * 2; if (bytes > MAX_BYTES) return true; continue; }
        if (t !== 'object' || cur === null) continue;
        if (ArrayBuffer.isView(cur)) { bytes += cur.byteLength || 0; if (bytes > MAX_BYTES) return true; continue; }
        if (cur instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && cur instanceof SharedArrayBuffer)) {
            bytes += cur.byteLength || 0; if (bytes > MAX_BYTES) return true; continue;
        }
        // Map/Set: neither their size nor their entries are `for..in`-visible — charge the entry count and
        // descend explicitly, so nested huge content is bounded too. The count check trips BEFORE we push,
        // so a giant Map/Set returns early instead of expanding onto the walk stack.
        if (cur instanceof Map) { nodes += cur.size; if (nodes > MAX_NODES) return true; for (const [mk, mv] of cur) { stack.push(mk); stack.push(mv); } continue; }
        if (cur instanceof Set) { nodes += cur.size; if (nodes > MAX_NODES) return true; for (const sv of cur) stack.push(sv); continue; }
        for (const k in cur) stack.push(cur[k]);
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
