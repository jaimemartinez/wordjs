/**
 * F6: REAL compatibility coverage for every plugin that ships in marketplace/plugins/.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * F6-C05 (backend/scripts/verify-f6-migration.ts) used to count a plugin as "covered" when its slug
 * appeared somewhere in backend test SOURCE. A slug in a string is not evidence of anything: it made
 * `assert.ok(true) // online-store` indistinguishable from a test that loads the plugin, and it left 27
 * of 31 shipping plugins with no backend test naming them at all. This suite replaces the mention with
 * an EXERCISE: it enumerates the plugin directories off disk, loads each plugin's real entry point, and
 * boots it against a bridge that behaves the way the host bridge behaves — including refusing the
 * capabilities the plugin's own manifest did not declare.
 *
 * THE POPULATION IS DERIVED, NEVER LISTED
 * ---------------------------------------
 * `readdirSync(marketplace/plugins)` is the population. There is no array of slugs in this file to fall
 * out of date, and `zero plugins found` is a FAILURE, not a silent pass — a scan that succeeds by
 * looking at nothing is the exact failure mode this codebase keeps re-shipping (the marketplace
 * "freshness" check that diffed a gitignored directory; the migration gate that compared the strict
 * validator with itself). Every plugin gets its own top-level test NAMED FOR ITS SLUG, so the F6 ratchet
 * can read the covered set out of an actual run instead of out of a grep.
 *
 * WHAT IS ASSERTED, AND WHY EACH ONE IS CHECKABLE WITHOUT A RUNNING SITE
 * ---------------------------------------------------------------------
 *  1. MANIFEST SHAPE. `id` must equal the directory name: routes/marketplace.ts installs the package by
 *     unpacking `<id>/manifest.json`, and build-marketplace.js derives the zip name from the directory,
 *     so a mismatch produces a catalog row that can never be installed. `id` must also satisfy
 *     core/plugin-permissions' own PLUGIN_SLUG and avoid its FORBIDDEN_KEYS — those are the rules the
 *     GRANT STORE applies, and a slug it refuses as a key is a plugin that can never be granted anything.
 *  2. DECLARED PERMISSIONS. Validated with the shipping validator (core/plugins.validateManifestPermissions),
 *     not a copy of its table, so a typo'd scope cannot be legal here and illegal at upload.
 *  3. DECLARED FRONTEND EXISTS. Every entry a manifest names — admin page, block (through the real
 *     plugin-block-contract resolver, both spellings), hooks — must exist on disk. build-plugin.js skips a
 *     declared entry whose file is missing (`if (fs.existsSync(...))`), so the package ships green with a
 *     block that can never load. verify-marketplace.js catches this too, but only AFTER a catalog build;
 *     this catches it on the source tree, which is what a contributor edits.
 *  4. BLOCK EXPORT SHAPE. The Verso registry generator emits `import * as X` plus a static reference to
 *     ONE member name, and Turbopack hard-errors on a member that is not a real export. So the member
 *     resolveBlockExports() picks must actually be exported by the block source.
 *  5. THE INSTALL-TIME SECURITY SCAN. core/plugins.validatePluginPermissions in 'declaration' mode is the
 *     gate that runs at upload and at activation. Running it here means a plugin cannot sit in the tree in
 *     a state that would be rejected the moment someone installed it.
 *  6. THE ENTRY LOADS AND EXPORTS `init`. plugin-worker.js calls exactly one thing on a plugin module:
 *     `plugin.init(wordjs)` (or the module itself if it is a function). Anything else — a syntax error, an
 *     unresolvable relative require, a missing export — is a plugin that dies at `kind:'init-error'`.
 *  7. `init()` COMPLETES ON A FRESH INSTALL, UNDER ITS OWN MANIFEST. This is the part that makes the word
 *     "compatibility" mean something. The bridge handed to init() mirrors plugin-worker.js's `wordjs`
 *     object shape AND core/plugin-api.ts's default-deny gate: a call into a namespace the manifest did
 *     not declare is REFUSED, exactly as verifyPermission() refuses it on a real site. A plugin whose boot
 *     path needs `settings:read` and does not declare it fails here for the same reason it would fail
 *     there. Denials are recorded as well as thrown, so a plugin that swallows its own error in a
 *     try/catch still fails the test rather than hiding the defect.
 *  8. WHAT init() DID must satisfy the host's own acceptance rules:
 *       · every table it creates is under `wjp_<slug>_` — createTable throws otherwise;
 *       · every SQL statement it issues passes the REAL guard (plugin-api.assertSqlAllowed), against its
 *         own prefix, so a plugin migration that reaches another plugin's or core's tables is caught;
 *       · every route path/verb satisfies plugin-isolate's register-route gate — a violation there is
 *         SILENTLY dropped at load, leaving an endpoint that 404s for ever with no error anywhere;
 *       · registration counts stay under the caps read out of plugin-isolate.ts, for the same reason;
 *       · every asset it enqueues resolves to a file inside the plugin directory (plugin-assets refuses
 *         to emit a tag for a file that is not there);
 *       · its admin-menu href agrees with the manifest and with the admin page slug, or the sidebar entry
 *         the operator sees links at a 404.
 *
 * WHAT IS DELIBERATELY *NOT* ASSERTED, AND WHY
 * -------------------------------------------
 *  · Behaviour of a plugin's HTTP handlers. Answering "does this endpoint return the right rows" needs a
 *    database, seeded content and an authenticated user — that is an integration test per plugin, not a
 *    contract every plugin shares. What IS shared, and is asserted, is that the route can be mounted.
 *  · The compiled frontend bundles. Compiling 30 admin pages and blocks is build-plugin.js's job and
 *    plugin-bundle-build.test.ts already proves the builder; re-running it here would multiply CI time
 *    for a second opinion on the same producer.
 *  · Runtime containment. Whether the sandbox actually confines a plugin is decided by the OS layer
 *    (sandbox-parity.yml, plugin-isolate) and cannot be inferred from a manifest. Nothing here should be
 *    read as a containment claim; the module policy below stubs the egress/process builtins so THIS
 *    process cannot be used as a plugin's network or spawn surface, and that is a test-hygiene measure,
 *    not a security proof.
 *  · `admin_menu:register` / `express:register_route` are declared in KNOWN_PERMISSIONS and shown on the
 *    operator's approval screen, but NOTHING denies those two calls at runtime today (see
 *    plugin-isolate.ts's register-route handler and core/adminMenu.ts — neither consults a grant). They
 *    are therefore asserted as a DISCLOSURE rule, separately from the gated capabilities, and the failure
 *    message says so. Overstating them as enforced is how a test starts lying about what it proves.
 *  · Anything a plugin does with a real socket. The socket layer is replaced by a fake on which nothing
 *    can bind or connect (see makeSocketLayerFake), so an SMTP listener's own bootstrap is exercised down
 *    to its degraded path and no further. That is a limit of the harness, stated rather than hidden.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const NodeModule = require('module');

/**
 * CLOSE WHAT MERELY IMPORTING THIS OPENS.
 *
 * `core/cache` subscribes to the peer-invalidation channel AT MODULE LOAD when Redis is configured, so
 * pulling in core/plugins is enough to leave a live Redis connection behind — no test has to touch the
 * cache for it to exist. Under `--test-force-exit` node:test then kills this file's child process with
 * that handle open, and a child killed mid-write leaves a TRUNCATED frame on the advanced-serialization
 * IPC channel it reports results over. The parent runner's reader throws
 * `Unable to deserialize cloned data due to invalid or unsupported version.` — an uncaughtException
 * attributed to this FILE, with no failing assertion in it. plugin-isolate.ts documents that same
 * framing hazard for plugin channels; this is the node:test channel hitting it for the same reason.
 *
 * It only bit on CI's Redis-CONNECTED leg (the degraded leg has no connection to leave open) and never
 * on Windows, which is exactly the shape of a flake nobody can reproduce where it was reported.
 *
 * Required lazily and defensively: this suite must keep working when core/cache was never reachable.
 */
after(async () => {
    for (const handle of bootTimers.splice(0)) {
        try { clearTimeout(handle); clearInterval(handle); } catch { /* already cleared */ }
    }
    try {
        const cache = require('../core/cache');
        if (cache && typeof cache.closeAll === 'function') await cache.closeAll();
    } catch { /* the cache was never loaded; nothing to close */ }
});

/**
 * A plugin's init() legitimately starts heartbeats — that is what `exports.deactivate` exists to stop,
 * and the host calls it on unload. This suite boots 31 of them and never unloads, so every interval any
 * of them arms stays armed and the file's process cannot exit on its own. `--test-force-exit` then kills
 * it with those handles open, which is what truncates the IPC frame described above.
 *
 * Timers created DURING a boot are recorded and cleared afterwards, so the process ends because it is
 * finished rather than because it was killed. Only the boot window is wrapped: the globals are restored
 * in a `finally`, so nothing outside init() is affected and a throwing plugin cannot leave them patched.
 */
const bootTimers: any[] = [];
function captureBootTimers(): () => void {
    const realSetTimeout = global.setTimeout;
    const realSetInterval = global.setInterval;
    (global as any).setTimeout = (...args: any[]) => { const h = (realSetTimeout as any)(...args); bootTimers.push(h); return h; };
    (global as any).setInterval = (...args: any[]) => { const h = (realSetInterval as any)(...args); bootTimers.push(h); return h; };
    return () => { (global as any).setTimeout = realSetTimeout; (global as any).setInterval = realSetInterval; };
}

const { resolveBlockEntry, resolveBlockExports } = require('../../scripts/plugin-block-contract');
const { validateManifestPermissions, validatePluginPermissions, KNOWN_PERMISSIONS } = require('../core/plugins');
const { PLUGIN_SLUG, FORBIDDEN_KEYS } = require('../core/plugin-permissions');
const { assertSqlAllowed, isProtectedOption } = require('../core/plugin-api');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PLUGINS_ROOT = path.join(REPO_ROOT, 'marketplace', 'plugins');
const ISOLATE_SRC = path.join(REPO_ROOT, 'backend', 'src', 'core', 'plugin-isolate.ts');
/** The frontend's hard-coded shortcode→plugin map; a declared tag is honoured there or nowhere. */
const HOME_CONTENT_SRC = path.join(REPO_ROOT, 'frontend', 'src', 'components', 'public', 'HomeContent.tsx');

// ── The host's own acceptance rules, READ from the host rather than restated ─────────────────────────
//
// A test that re-types a limit is a test that keeps passing after the limit changes. These are lifted
// out of plugin-isolate.ts's source, and the extraction itself is asserted, so a rename turns this red
// instead of silently disabling the check.
function readIsolateCaps(): { hooks: number; routes: number; shortcodes: number } {
    const src = fs.readFileSync(ISOLATE_SRC, 'utf8');
    const m = src.match(/const\s+MAX_HOOKS\s*=\s*(\d+)\s*,\s*MAX_ROUTES\s*=\s*(\d+)\s*,\s*MAX_SHORTCODES\s*=\s*(\d+)/);
    assert.ok(m, 'could not read MAX_HOOKS/MAX_ROUTES/MAX_SHORTCODES out of plugin-isolate.ts — the registration caps this suite '
        + 'checks against were renamed or reformatted, so the check would have silently stopped checking');
    return { hooks: Number(m![1]), routes: Number(m![2]), shortcodes: Number(m![3]) };
}
const CAPS = readIsolateCaps();

/** Verbs plugin-isolate.ts allows a child to mount. Anything else is rejected at load, silently. */
const ROUTE_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);
/** plugin-isolate.ts's route-path charset: static segments, `:param` and `*` only — no regex structure. */
const ROUTE_PATH_RE = /^\/[A-Za-z0-9_./:*-]*$/;

/**
 * How long one plugin's init() may take before this suite calls it wedged. Short on purpose: unlike the
 * host's 60s READY_TIMEOUT_MS there is no cold database here to migrate against, and the whole point of
 * a deadline is that a wedged plugin FAILS instead of hanging the run.
 */
const INIT_DEADLINE_MS = 15000;

/** The prefix formula, character for character as plugin-api.ts and plugin-worker.js both compute it. */
function tablePrefixFor(slug: string): string {
    return ('wjp_' + slug.replace(/[^A-Za-z0-9]+/g, '_') + '_').toLowerCase();
}

// ── Module policy for loading a plugin entry in THIS process ────────────────────────────────────────
//
// Plugin entries are CommonJS and are loaded through a miniature loader instead of `require()`, for two
// reasons. First, a plugin's third-party dependencies (mail-server's nodemailer/smtp-server/…) are not
// installed in backend/node_modules, and "the test machine happens not to have this package" must not be
// the reason a plugin looks broken — bare specifiers resolve to an inert recording stub. Second, the
// loader decides which builtins a plugin's top-level code can touch: everything that spawns a process or
// leaves the machine is stubbed, so booting 31 third-party plugins inside a test runner cannot open a
// socket, listen on a port, or fork anything. Local (`./`) requires resolve for real, because a plugin
// splitting its code across files is ordinary and skipping those files would skip the plugin.
const STUBBED_BUILTINS = new Set([
    'child_process', 'http', 'http2', 'https', 'dns', 'dns/promises',
    'cluster', 'worker_threads', 'inspector', 'repl', 'v8', 'sqlite', 'wasi',
]);

/**
 * The socket layer (net/tls/dgram) needs more than an inert stub, because a plugin does not merely CALL
 * it — it AWAITS it. mail-server's boot probes whether port 25 is bindable with
 * `await new Promise(r => { tester.once('error', …); tester.once('listening', …); tester.listen(25) })`.
 * A stub whose `.once()` is a no-op leaves that promise pending for ever, and the suite hangs instead of
 * failing — the worst outcome available, because a hang looks exactly like slowness in CI.
 *
 * So this fake IS the socket layer for a host where nothing may bind or dial: every server and socket is
 * a real EventEmitter that asynchronously emits `error` with EACCES/ECONNREFUSED. That is a state a real
 * deployment reaches (an unprivileged process has no CAP_NET_BIND_SERVICE for port 25), so the plugin's
 * own degraded path is exercised rather than skipped, and no test run can open a listener or leave the
 * machine. `isIP` and friends stay real — they are pure predicates plugins use to validate input.
 */
function makeSocketLayerFake(moduleName: string): any {
    const { EventEmitter } = require('events');
    const realNet = require('net');
    const failAsync = (emitter: any, code: string) => {
        setImmediate(() => {
            const err: any = new Error(`${code}: the plugin compatibility harness permits no sockets`);
            err.code = code;
            emitter.emit('error', err);
        });
        return emitter;
    };
    const makeServer = () => {
        const server: any = new EventEmitter();
        server.listen = () => failAsync(server, 'EACCES');
        server.bind = () => failAsync(server, 'EACCES');
        server.close = (cb?: any) => { if (typeof cb === 'function') setImmediate(cb); return server; };
        server.address = () => null;
        server.unref = () => server;
        server.ref = () => server;
        return server;
    };
    const makeSocket = () => {
        const socket: any = new EventEmitter();
        socket.connect = () => failAsync(socket, 'ECONNREFUSED');
        socket.write = () => true;
        socket.end = () => socket;
        socket.destroy = () => socket;
        socket.setTimeout = () => socket;
        socket.setEncoding = () => socket;
        socket.unref = () => socket;
        socket.ref = () => socket;
        return socket;
    };
    const api: any = {
        createServer: makeServer,
        createSocket: makeServer,                                   // dgram
        Server: function () { return makeServer(); },
        Socket: function () { return makeSocket(); },
        connect: () => makeSocket(),
        createConnection: () => makeSocket(),
        isIP: realNet.isIP, isIPv4: realNet.isIPv4, isIPv6: realNet.isIPv6,
    };
    if (moduleName === 'tls') {
        api.TLSSocket = function () { return makeSocket(); };
        api.createSecureContext = () => ({});
    }
    return api;
}
const SOCKET_LAYER_BUILTINS = new Set(['net', 'tls', 'dgram']);

/** A permissive inert object: every property access and call yields another one. Never throws. */
function makeStub(name: string): any {
    const target: any = function () { return makeStub(name); };
    return new Proxy(target, {
        get(_t, p) {
            if (p === 'then') return undefined;                        // must not look thenable to `await`
            if (p === Symbol.toPrimitive) return () => `[stub ${name}]`;
            if (p === 'toString') return () => `[stub ${name}]`;
            if (p === 'default') return makeStub(name);
            return makeStub(`${name}.${String(p)}`);
        },
        apply() { return makeStub(`${name}()`); },
        construct() { return makeStub(`new ${name}`); },
    });
}

/** Load `<dir>/<entry>` and its relative requires. Throws with the offending file named. */
function loadPluginEntry(dir: string, entryRel: string): any {
    const cache = new Map<string, { exports: any }>();

    function resolveLocal(fromDir: string, spec: string): string {
        const full = path.resolve(fromDir, spec);
        const candidates = [full, `${full}.js`, `${full}.json`, path.join(full, 'index.js')];
        const hit = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
        if (!hit) throw new Error(`cannot resolve '${spec}' from ${path.relative(dir, fromDir) || '.'}`);
        return hit;
    }

    function req(fromDir: string, spec: string): any {
        if (spec.startsWith('.') || path.isAbsolute(spec)) {
            const file = resolveLocal(fromDir, spec);
            if (cache.has(file)) return cache.get(file)!.exports;
            if (file.endsWith('.json')) {
                const mod = { exports: JSON.parse(fs.readFileSync(file, 'utf8')) };
                cache.set(file, mod);
                return mod.exports;
            }
            return run(file);
        }
        const bare = spec.replace(/^node:/, '');
        const head = bare.split('/')[0];
        if (NodeModule.builtinModules.includes(head)) {
            if (SOCKET_LAYER_BUILTINS.has(head)) return makeSocketLayerFake(head);
            if (STUBBED_BUILTINS.has(bare) || STUBBED_BUILTINS.has(head)) return makeStub(bare);
            return require(bare);
        }
        return makeStub(spec); // a declared third-party dependency we deliberately do not install
    }

    function run(file: string): any {
        const mod = { exports: {} as any };
        cache.set(file, mod);
        // compileFunction (not `new Function`) so a syntax error names the real file and line.
        const wrapper = vm.compileFunction(
            fs.readFileSync(file, 'utf8'),
            ['exports', 'require', 'module', '__filename', '__dirname'],
            { filename: file },
        );
        wrapper(mod.exports, (s: string) => req(path.dirname(file), s), mod, file, path.dirname(file));
        return mod.exports;
    }

    return run(path.join(dir, entryRel.replace(/^\.\//, '')));
}

// ── The recording, permission-enforcing bridge ──────────────────────────────────────────────────────
//
// Shape mirrors plugin-worker.js's `wordjs`; the gate mirrors plugin-api.ts's verifyPermission. Grants
// are assumed to be exactly the manifest's declarations, which is the state a site reaches when an
// operator approves everything the plugin asked for (and what backfillActive() produces on upgrade). So
// a denial here means the plugin asks for something IT NEVER DECLARED — not that an admin said no.

type Recorder = {
    denials: string[];
    gated: Set<string>;        // capability tokens the plugin exercised through a GATED bridge method
    ungated: Set<string>;      // capabilities it exercised that no runtime gate consults today
    sql: { kind: 'read' | 'write'; sql: string }[];
    tables: string[];
    routes: string[];
    hooks: number;
    shortcodes: string[];
    menus: any[];
    assets: any[];
    protectedOptions: string[];
};

function newRecorder(): Recorder {
    return {
        denials: [], gated: new Set(), ungated: new Set(), sql: [], tables: [], routes: [],
        hooks: 0, shortcodes: [], menus: [], assets: [], protectedOptions: [],
    };
}

function makeBridge(slug: string, manifest: any, rec: Recorder, tmpDir: string): any {
    const declared = new Set<string>(
        (manifest.permissions || []).map((p: any) => (p.access ? `${p.scope}:${p.access}` : String(p.scope))),
    );
    const prefix = tablePrefixFor(slug);

    /** plugin-api.ts's verifyPermission, including `scope:admin` implying read+write and nothing more. */
    const gate = (scope: string, access?: string) => {
        const token = access ? `${scope}:${access}` : scope;
        rec.gated.add(token);
        const ok = declared.has(token)
            || ((access === 'read' || access === 'write') && declared.has(`${scope}:admin`));
        if (!ok) {
            const message = `🛡️ Permission denied: '${token}' is not declared in manifest.json`;
            rec.denials.push(token);        // recorded too, so a swallowed throw still fails the test
            throw new Error(message);
        }
    };
    const ungated = (what: string) => { rec.ungated.add(what); };

    return {
        slug,
        paths: Object.freeze({ data: path.join(tmpDir, 'data'), logs: path.join(tmpDir, 'logs'), tmp: path.join(tmpDir, 'tmp') }),
        options: {
            async get(key: string, def: any = null) {
                gate('settings', 'read');
                if (isProtectedOption(key, slug)) rec.protectedOptions.push(String(key));
                return def;                 // a fresh install: nothing has been saved yet
            },
            async set(key: string) {
                gate('settings', 'write');
                if (isProtectedOption(key, slug)) rec.protectedOptions.push(String(key));
            },
        },
        db: {
            tablePrefix: prefix,
            async all(sql: string) { gate('database', 'read'); rec.sql.push({ kind: 'read', sql: String(sql) }); return []; },
            async get(sql: string) { gate('database', 'read'); rec.sql.push({ kind: 'read', sql: String(sql) }); return undefined; },
            async run(sql: string) { gate('database', 'write'); rec.sql.push({ kind: 'write', sql: String(sql) }); return { changes: 0, lastID: 1 }; },
            async batch(statements: any[]) {
                gate('database', 'write');
                for (const entry of statements || []) {
                    const stmt = String(Array.isArray(entry) ? entry[0] : entry);
                    rec.sql.push({ kind: /^\s*(?:select|with)\b/i.test(stmt) ? 'read' : 'write', sql: stmt });
                }
                return (statements || []).map(() => ({ changes: 0, lastID: 1 }));
            },
            async createTable(name: string) { gate('database', 'write'); rec.tables.push(String(name)); },
            async getType() { gate('database', 'read'); return 'sqlite'; },
        },
        hooks: {
            addAction() { ungated('hooks'); rec.hooks += 1; },
            addFilter() { ungated('hooks'); rec.hooks += 1; },
            async doAction() { ungated('hooks'); },
        },
        fs: {
            async read() { gate('filesystem', 'read'); return ''; },
            async write() { gate('filesystem', 'write'); },
        },
        async mail() { ungated('mail'); return { ok: true }; },
        provideMail() { gate('email', 'provider'); },
        notify: Object.assign(
            async () => { gate('notifications', 'send'); },
            { registerTransport() { gate('notifications', 'provider'); } },
        ),
        adminMenu: { async add(item: any) { ungated('admin_menu:register'); rec.menus.push(item); } },
        cron: { async schedule() { ungated('cron'); } },
        crypto: {
            async randomToken(bytes = 16) { ungated('crypto'); return 'ab'.repeat(bytes); },
            async randomInt(min = 0) { ungated('crypto'); return min; },
        },
        assets: {
            async enqueueScript(spec: any) { gate('assets', 'write'); rec.assets.push(spec); },
            async enqueueStyle(spec: any) { gate('assets', 'write'); rec.assets.push(spec); },
        },
        users: {
            async findByEmail() { gate('users', 'read'); return null; },
            async findByLogin() { gate('users', 'read'); return null; },
            async findById() { gate('users', 'read'); return null; },
            async search() { gate('users', 'read'); return []; },
        },
        site: {
            async url() { gate('settings', 'read'); return 'https://example.test'; },
            async domain() { gate('settings', 'read'); return 'example.test'; },
            async adminEmail() { gate('settings', 'read'); return 'admin@example.test'; },
        },
        dns: {
            async resolveMx() { gate('network'); return []; },
            async resolveTxt() { gate('network'); return []; },
            async resolve4() { gate('network'); return []; },
            async resolve6() { gate('network'); return []; },
            async resolve() { gate('network'); return []; },
        },
        http: {
            route(method: string, routePath: string, opts: any, handler: any) {
                ungated('express:register_route');
                // Same overload plugin-worker.js accepts: the third argument is either the options
                // object or the handler itself.
                const routeHandler = typeof opts === 'function' ? opts : handler;
                rec.routes.push(`${String(method).toLowerCase()} ${routePath}`);
                assert.strictEqual(typeof routeHandler, 'function',
                    `route ${method} ${routePath} was registered without a handler function`);
            },
        },
        shortcodes: {
            add(tag: string, handler: any) {
                ungated('shortcodes');
                rec.shortcodes.push(String(tag));
                assert.strictEqual(typeof handler, 'function', `shortcode [${tag}] was registered without a handler`);
            },
        },
    };
}

/**
 * Plugins the SHIPPING install-time validator rejects today, with the exact reason.
 *
 * This is debt, written down rather than skipped, and it is compared for EQUALITY: fix the plugin and
 * the test goes red asking for its entry to be deleted, so the exception cannot rot into a permanent
 * excuse (same discipline as UNRESOLVED_BUILTIN_COLUMN_BINDINGS in the F6 gate).
 *
 * mail-server: core/plugins.ts flags a bare `exec` method call as possible child_process usage. It
 * exempts the regex-LITERAL form (`/re/.exec(s)`) but not a regex held in a variable, and
 * lib/sanitize-email-html.js drives its tokenizer with `ATTR_RE.exec(inner)` and
 * `TAG_START_RE.exec(src…)` — the standard way to iterate a sticky/global regex. The consequence is not
 * cosmetic: validatePluginPermissions runs on upload AND on activation, so mail-server as it stands is
 * refused by the very gate that guards installing it. Fixing it means rewriting the tokenizer loops in
 * an HTML sanitizer that exists to stop stored XSS in email bodies, or teaching the scanner that a
 * RegExp-typed binding is not a child_process handle. Neither is a small, obviously-correct edit, so
 * this records the state instead of guessing at it.
 */
const KNOWN_INSTALL_VALIDATOR_REJECTIONS: Record<string, { dangerousCalls: string[]; missingPermissions: string[] }> = {
    // EMPTY, and that is the point: mail-server was the only entry, and it retired itself the moment the
    // scanner stopped flagging it. Adding an entry here is admitting a plugin cannot be installed by the
    // gate that guards installing it, so it should be rare and short-lived.
};

/** The tags the public home page will expand, read out of the frontend rather than restated. */
function frontendShortcodeTags(): Set<string> {
    if (!fs.existsSync(HOME_CONTENT_SRC)) return new Set();
    const src = fs.readFileSync(HOME_CONTENT_SRC, 'utf8');
    const tags = new Set<string>();
    for (const m of src.matchAll(/\{\s*tag:\s*'\[([A-Za-z0-9_-]+)\]'/g)) tags.add(m[1]);
    return tags;
}
const FRONTEND_TAGS = frontendShortcodeTags();

// ── The population ──────────────────────────────────────────────────────────────────────────────────

const SLUGS: string[] = fs.existsSync(PLUGINS_ROOT)
    ? fs.readdirSync(PLUGINS_ROOT, { withFileTypes: true })
        .filter((e: any) => e.isDirectory())
        .map((e: any) => e.name)
        .sort()
    : [];

test('the marketplace plugin population is non-empty and readable', () => {
    // A suite that enumerates nothing passes everything. This is the guard against the whole file
    // quietly becoming decoration because a path moved or a checkout was partial.
    assert.ok(fs.existsSync(PLUGINS_ROOT), `marketplace/plugins is missing at ${PLUGINS_ROOT}`);
    assert.ok(SLUGS.length > 0, 'enumerated ZERO marketplace plugins — a scan that passes by looking at nothing');
    for (const slug of SLUGS) {
        assert.ok(fs.existsSync(path.join(PLUGINS_ROOT, slug, 'manifest.json')),
            `marketplace/plugins/${slug} has no manifest.json — it can neither be packaged nor installed`);
    }
    // Same guard one level down: the shortcode check below compares a manifest's declared tags against
    // the frontend's map. If that file moved, the map reads EMPTY and the comparison would blame the
    // plugins for a path change. Fail here instead, where the message names the real cause.
    assert.ok(fs.existsSync(HOME_CONTENT_SRC), `${HOME_CONTENT_SRC} is missing — the frontend shortcode map cannot be read`);
    assert.ok(FRONTEND_TAGS.size > 0,
        `no '[tag]' entries could be parsed out of ${HOME_CONTENT_SRC}; its SHORTCODES table changed shape, so the `
        + 'declared-shortcode check below has silently stopped checking');
});

for (const slug of SLUGS) {
    // One top-level test per plugin, NAMED for the slug: F6-C05 reads the covered set from this run's
    // reporter output, so "covered" means a test for that plugin actually executed and passed.
    test(slug, async () => {
        const dir = path.join(PLUGINS_ROOT, slug);
        const manifestPath = path.join(dir, 'manifest.json');

        // ── 1. Manifest shape ───────────────────────────────────────────────────────────────────────
        let manifest: any;
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (e: any) {
            assert.fail(`manifest.json is not valid JSON: ${e && e.message}`);
        }
        assert.strictEqual(manifest.id, slug,
            `manifest id "${manifest.id}" does not match the directory name "${slug}" — the installer unpacks `
            + `"<id>/manifest.json" and the builder names the zip from the directory, so this entry is uninstallable`);
        assert.ok(PLUGIN_SLUG.test(slug),
            `"${slug}" is not a legal plugin slug (${PLUGIN_SLUG}) — the grant store refuses it as a record key, `
            + 'so this plugin could never be granted a permission');
        assert.ok(!FORBIDDEN_KEYS.has(slug), `"${slug}" is a forbidden record key in the grant store`);
        for (const field of ['name', 'version', 'description', 'author']) {
            assert.ok(typeof manifest[field] === 'string' && manifest[field].trim(),
                `manifest is missing a non-empty "${field}" — the catalog and the admin plugin list both render it`);
        }
        assert.match(String(manifest.version), /^\d+\.\d+\.\d+/,
            `version "${manifest.version}" is not dotted-numeric; build-marketplace.js derives the zip file name from it `
            + 'and the installer validates that name against SAFE_FILE_RE');
        assert.strictEqual(manifest.isolated, true,
            'every marketplace plugin runs in the child-process sandbox; a manifest that does not say so asks the host '
            + 'to load third-party code in-process');

        const entryRel = String((manifest.backend && manifest.backend.entry) || 'index.js');
        assert.ok(fs.existsSync(path.join(dir, entryRel)),
            `backend.entry "${entryRel}" does not exist — the isolate would die at require()`);

        // ── 2. Declared permissions, via the shipping validator ─────────────────────────────────────
        const permissionProblems = validateManifestPermissions(manifest.permissions);
        assert.deepStrictEqual(permissionProblems, [],
            `manifest.permissions is rejected by the upload validator:\n  ${permissionProblems.join('\n  ')}`);

        // ── 3. Every DECLARED frontend entry exists on disk ─────────────────────────────────────────
        const frontend = manifest.frontend || {};
        if (frontend.adminPage && frontend.adminPage.entry) {
            assert.ok(fs.existsSync(path.join(dir, String(frontend.adminPage.entry).replace(/^\.\//, ''))),
                `frontend.adminPage.entry "${frontend.adminPage.entry}" is missing — build-plugin.js skips it silently `
                + 'and the package ships with an admin page that can never load');
            assert.ok(typeof frontend.adminPage.slug === 'string' && frontend.adminPage.slug.trim(),
                'an adminPage without a slug has no /admin/plugin/<slug> route to be reached at');
        }
        if (typeof frontend.hooks === 'string') {
            assert.ok(fs.existsSync(path.join(dir, frontend.hooks.replace(/^\.\//, ''))),
                `frontend.hooks "${frontend.hooks}" is missing`);
        }

        // ── 4. The block entry and its EXPORT SHAPE ─────────────────────────────────────────────────
        //
        // Two resolutions, because the two consumers read different manifest keys and collapsing them
        // would assert something no tool actually does. The BUNDLER channel (componentsChannel: true)
        // includes the pre-Puck `frontend.components[]` key, and every entry there must exist on disk or
        // build-plugin.js silently omits the bundle. The REGISTRY channel (componentsChannel: false) is
        // what generate-verso-plugin-registry.js imports, and only entries on THAT channel need to export
        // a block member — `frontend.components[]` files are plain React components (video-gallery's
        // carousel) that the registry generator has never imported and must not start importing.
        const bundled = resolveBlockEntry(dir, manifest, { componentsChannel: true, warn: false });
        if (bundled) {
            assert.ok(fs.existsSync(path.join(dir, String(bundled.entry).replace(/^\.\//, ''))),
                `${bundled.declared ? 'declared' : 'conventional'} block entry "${bundled.entry}" is missing`);
        }
        const block = resolveBlockEntry(dir, manifest, { componentsChannel: false, warn: false });
        if (block) {
            const blockPath = path.join(dir, String(block.entry).replace(/^\.\//, ''));
            assert.ok(fs.existsSync(blockPath), `block entry "${block.entry}" is missing`);
            const shape = resolveBlockExports(blockPath);
            const blockSrc = fs.readFileSync(blockPath, 'utf8');
            assert.match(blockSrc, new RegExp(`export\\s+(?:const|let|var|function|class)\\s+${shape.member}\\b`),
                `the Verso registry generator will emit a static reference to "${shape.member}" from ${block.entry}, `
                + 'but that name is not exported there — Turbopack hard-errors on a member that is not a real export, '
                + 'so the whole frontend build breaks, not just this block');
        }

        // ── 5. The install-time security scan the real upload path runs ─────────────────────────────
        let rejection: { dangerousCalls: string[]; missingPermissions: string[] } | null = null;
        try {
            validatePluginPermissions(slug, dir, manifest, { mode: 'declaration' });
        } catch (e: any) {
            assert.strictEqual(e && e.code, 'PLUGIN_VALIDATION_FAILED',
                `the install-time validator threw something other than a validation failure: ${e && e.message}`);
            rejection = {
                dangerousCalls: [...(e.dangerousCalls || [])].sort(),
                missingPermissions: [...(e.missingPermissions || [])].sort(),
            };
        }
        assert.deepStrictEqual(rejection, KNOWN_INSTALL_VALIDATOR_REJECTIONS[slug] || null,
            rejection
                ? 'the shipping install-time validator rejects this plugin, so uploading it to a real site would be blocked'
                : `this plugin now PASSES the install-time validator — delete its entry from `
                  + 'KNOWN_INSTALL_VALIDATOR_REJECTIONS so the exception retires itself');

        // ── 6. The entry loads and exposes the one export the worker calls ──────────────────────────
        let mod: any;
        try {
            mod = loadPluginEntry(dir, entryRel);
        } catch (e: any) {
            assert.fail(`the plugin entry could not be loaded (the isolate would report init-error): ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
        }
        const initFn = typeof mod === 'function' ? mod : mod && mod.init;
        assert.strictEqual(typeof initFn, 'function',
            'plugin-worker.js calls `plugin.init(wordjs)` (or the module itself when it is a function); this module '
            + `exports neither, so loading it would register nothing at all (exports: ${Object.keys(mod || {}).join(', ') || 'none'})`);
        if (mod && mod.metadata) {
            assert.strictEqual(String(mod.metadata.version || manifest.version), String(manifest.version),
                `exports.metadata.version (${mod.metadata.version}) disagrees with manifest.json (${manifest.version}); `
                + 'the catalog publishes the manifest version, so the two would name different builds');
        }
        if (mod && mod.deactivate !== undefined) {
            assert.strictEqual(typeof mod.deactivate, 'function',
                'exports.deactivate must be callable — the isolate calls it on unload to release timers and servers');
        }

        // ── 7. init() boots on a fresh install under this plugin's OWN declarations ─────────────────
        const rec = newRecorder();
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-compat-${slug}-`));
        try {
            // Bounded, for the same reason plugin-isolate.ts arms READY_TIMEOUT_MS at spawn: an init()
            // that never settles is a plugin that never reaches 'ready', and the host gives up on it.
            // Without the deadline this suite would HANG on such a plugin, and a hang in CI is
            // indistinguishable from slowness — the failure mode is worse than the bug.
            let deadline: any;
            const release = captureBootTimers();
            try {
                await Promise.race([
                    Promise.resolve(initFn(makeBridge(slug, manifest, rec, tmpDir))),
                    new Promise((_ok, reject) => {
                        deadline = setTimeout(
                            () => reject(new Error(`init() did not settle within ${INIT_DEADLINE_MS}ms; the isolate would never report 'ready'`)),
                            INIT_DEADLINE_MS,
                        );
                    }),
                ]).finally(() => clearTimeout(deadline));  // always clear: the loser of a race keeps the loop alive
            } finally {
                release();
            }
        } catch (e: any) {
            assert.fail(`init() threw on a fresh install: ${e && e.message}`
                + (rec.denials.length ? `\n  refused capabilities: ${[...new Set(rec.denials)].join(', ')}` : ''));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
        assert.deepStrictEqual([...new Set(rec.denials)], [],
            'init() reached bridge capabilities this manifest does not declare. On a real site plugin-api.ts refuses '
            + 'each of these calls, and a plugin that catches its own error keeps booting into a half-wired state');

        // ── 8. What init() did must satisfy the host's acceptance rules ─────────────────────────────
        const prefix = tablePrefixFor(slug);

        for (const name of rec.tables) {
            assert.ok(String(name).toLowerCase().startsWith(prefix),
                `createTable("${name}") is outside this plugin's namespace "${prefix}" — plugin-api.ts throws on it, `
                + 'so the plugin cannot finish installing');
        }
        // The verb lists are the ones plugin-api.ts hands assertSqlAllowed for each method, so a statement
        // that passes here passes for the same reason it would pass on a real site — and one that fails
        // here makes init() throw there, which the isolate reports as `init-error` and the plugin never
        // registers anything at all.
        const SQL_READ_VERBS = ['select', 'with'];
        const SQL_WRITE_VERBS = ['insert', 'update', 'delete', 'create', 'alter', 'drop', 'replace'];
        for (const { kind, sql } of rec.sql) {
            if (!sql || sql === 'undefined') continue;
            assert.doesNotThrow(
                () => assertSqlAllowed(sql, kind === 'read' ? SQL_READ_VERBS : SQL_WRITE_VERBS, prefix, slug),
                `a statement issued during init() is refused by the plugin SQL guard, so init() throws and the plugin `
                + `never finishes loading: ${sql.replace(/\s+/g, ' ').slice(0, 180)}`,
            );
        }
        assert.deepStrictEqual(rec.protectedOptions, [],
            'init() reads or writes a protected option name; plugin-api.ts refuses those to every plugin, with no '
            + 'trusted bypass — a plugin keeps its own secrets in its own wjp_ table');

        const seenRoutes = new Set<string>();
        for (const entry of rec.routes) {
            const idx = entry.indexOf(' ');
            const verb = entry.slice(0, idx);
            const routePath = entry.slice(idx + 1);
            assert.ok(ROUTE_VERBS.has(verb),
                `route "${entry}" uses a verb plugin-isolate.ts does not mount; the registration is dropped with only a `
                + 'console warning, so the endpoint 404s for ever');
            assert.ok(
                ROUTE_PATH_RE.test(routePath) && routePath.length <= 200 && !routePath.includes('::')
                && (routePath.match(/\*/g) || []).length <= 2 && !routePath.includes('..'),
                `route path "${routePath}" fails plugin-isolate.ts's register-route gate (static segments, :param and `
                + 'at most two `*` only). The host silently refuses the registration — the plugin looks installed and '
                + 'the endpoint does not exist');
            assert.ok(!seenRoutes.has(entry),
                `route "${entry}" is registered twice; Express serves the FIRST handler, so the second is dead code`);
            seenRoutes.add(entry);
        }
        assert.ok(rec.routes.length <= CAPS.routes,
            `registers ${rec.routes.length} routes, over plugin-isolate.ts's MAX_ROUTES=${CAPS.routes}; everything past the `
            + 'cap is refused at load');
        assert.ok(rec.hooks <= CAPS.hooks, `registers ${rec.hooks} hooks, over MAX_HOOKS=${CAPS.hooks}`);
        assert.ok(rec.shortcodes.length <= CAPS.shortcodes,
            `registers ${rec.shortcodes.length} shortcodes, over MAX_SHORTCODES=${CAPS.shortcodes}`);

        for (const spec of rec.assets) {
            const src = String((spec && spec.src) || '');
            assert.ok(src && !path.isAbsolute(src) && !src.split(/[\\/]/).includes('..'),
                `enqueued asset src "${src}" is not a plain relative path inside the plugin directory`);
            assert.ok(fs.existsSync(path.join(dir, src)),
                `enqueued asset "${src}" does not exist in the package — plugin-assets refuses to emit a tag for a `
                + 'missing file, so the public behaviour this plugin advertises never loads');
            assert.ok(spec && spec.handle, `enqueued asset "${src}" has no handle, so it cannot be dequeued or deduped`);
        }

        // The sidebar entry the operator clicks must reach the admin page the manifest ships.
        if (manifest.adminMenu) {
            assert.ok(typeof manifest.adminMenu.href === 'string' && manifest.adminMenu.href.startsWith('/'),
                'adminMenu.href must be a rooted path');
            if (frontend.adminPage && frontend.adminPage.slug) {
                assert.strictEqual(manifest.adminMenu.href, `/admin/plugin/${frontend.adminPage.slug}`,
                    'the sidebar href does not point at this plugin\'s own admin page route, so the menu entry 404s');
            }
        }
        for (const item of rec.menus) {
            assert.ok(item && typeof item.href === 'string' && item.href.startsWith('/'),
                `adminMenu.add(${JSON.stringify(item)}) has no rooted href`);
            if (manifest.adminMenu && manifest.adminMenu.href) {
                assert.strictEqual(item.href, manifest.adminMenu.href,
                    'the menu entry registered at runtime points somewhere else than the one the manifest advertises; '
                    + 'the catalog shows one destination and the sidebar goes to another');
            }
        }

        // A shortcode tag is honoured by the backend expander (registered at init) or by the public home
        // page's own map — a manifest that advertises one honoured by neither is a documented feature that
        // does nothing when a user types it.
        for (const declaredTag of (manifest.shortcodes || [])) {
            const tag = String(declaredTag && declaredTag.tag);
            assert.ok(rec.shortcodes.includes(tag) || FRONTEND_TAGS.has(tag),
                `manifest advertises the shortcode [${tag}], but init() registers ${JSON.stringify(rec.shortcodes)} and the `
                + `public home page expands ${JSON.stringify([...FRONTEND_TAGS])} — nothing anywhere honours [${tag}]`);
        }

        // Disclosure-only capabilities: nothing denies these at runtime today (see the header), but the
        // approval screen is built from manifest.permissions, so an undeclared one means the operator
        // approves a plugin without being told it mounts host routes or an admin-sidebar entry.
        const declaredTokens = new Set<string>(
            (manifest.permissions || []).map((p: any) => (p.access ? `${p.scope}:${p.access}` : String(p.scope))),
        );
        for (const token of ['admin_menu:register', 'express:register_route']) {
            if (!rec.ungated.has(token)) continue;
            const [scope, access] = token.split(':');
            assert.ok(Array.isArray(KNOWN_PERMISSIONS[scope]) && KNOWN_PERMISSIONS[scope].includes(access),
                `"${token}" is no longer part of KNOWN_PERMISSIONS — this disclosure check is asserting a token the `
                + 'product does not define any more');
            assert.ok(declaredTokens.has(token) || declaredTokens.has(`${scope}:admin`),
                `init() uses ${token} but manifest.permissions does not declare it, so /admin/plugins asks the operator to `
                + 'approve this plugin without listing that capability');
        }
    });
}
