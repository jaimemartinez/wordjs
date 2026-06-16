/**
 * WordJS - Isolated Plugin Host (worker_threads, cross-platform, no native deps)
 *
 * Loads a plugin marked `"isolated": true` in a worker (separate V8 isolate). The plugin reaches
 * core ONLY via the `wordjs` bridge, whose calls are RPC'd here and run through createPluginApi()
 * (permission-checked, in the plugin's context). Hooks/filters the plugin registers become shims
 * in the real hook system that call back into the isolate. The host's heap (secrets, DB handle,
 * other plugins) is never exposed to the isolate. See documentation/plugin-isolation-proposal.md.
 */

const { Worker } = require('worker_threads');
const path = require('path');
const { createPluginApi } = require('./plugin-api');
const { runWithContext } = require('./plugin-context');
const hooks = require('./hooks');
const { addShortcode, removeShortcode } = require('./shortcodes');

const WORKER_FILE = path.join(__dirname, 'plugin-worker.js');
const isolates = new Map<string, any>();

// Trust = shipped default OR operator-toggled (admin UI). See core/plugin-trust.
function isTrustedPlugin(slug: string): boolean {
    try { return require('./plugin-trust').isTrusted(slug); } catch { return false; }
}

// Navigate "options.get" / "mail" on the api object and call it with args.
function callApi(api: any, method: string, args: any[]) {
    const parts = String(method).split('.');
    let ctx: any = null;
    let fn: any = api;
    for (const p of parts) { ctx = fn; fn = fn ? fn[p] : undefined; }
    if (typeof fn !== 'function') throw new Error(`Unknown bridge method: ${method}`);
    return fn.apply(ctx, args);
}

function loadIsolatedPlugin(slug: string, entryFile: string): Promise<any> {
    return new Promise((resolve, reject) => {
        // In dev we run via ts-node and the worker must too (core is .ts); compiled, no flag needed.
        // Pass ONLY the ts-node register flag — forwarding all of process.execArgv trips Worker's
        // execArgv allowlist.
        const execArgv = __filename.endsWith('.ts') ? ['-r', 'ts-node/register'] : [];
        const worker = new Worker(WORKER_FILE, {
            workerData: { slug, entryFile, coreDir: __dirname },
            execArgv,
            resourceLimits: { maxOldGenerationSizeMb: 256 } // cap isolate memory (DoS containment)
        });
        const api = createPluginApi(slug);
        let invokeId = 0;

        // Every host→worker RPC carries a hard timeout: a plugin that never replies (hang or DoS)
        // must not pin an HTTP request open or leak a pending entry forever. rpcSettle clears it.
        const RPC_TIMEOUT_MS = 30000;
        const rpcSend = (map: Map<number, any>, message: any): Promise<any> => new Promise((res, rej) => {
            const id = ++invokeId;
            const timer = setTimeout(() => {
                if (map.has(id)) { map.delete(id); rej(new Error(`Isolated plugin '${slug}' RPC timed out`)); }
            }, RPC_TIMEOUT_MS);
            if ((timer as any).unref) (timer as any).unref();
            map.set(id, { res, rej, timer });
            worker.postMessage({ id, ...message });
        });
        const rpcSettle = (map: Map<number, any>, msg: any, value: any) => {
            const p = map.get(msg.id);
            if (!p) return;
            map.delete(msg.id);
            clearTimeout(p.timer);
            msg.ok ? p.res(value) : p.rej(new Error(msg.error));
        };

        const pendingInvoke = new Map<number, any>();
        const invokeWorker = (cbId: string, args: any[]) => rpcSend(pendingInvoke, { kind: 'invoke', cbId, args });

        const pendingRoute = new Map<number, any>();
        const invokeRoute = (routeId: string, req: any) => rpcSend(pendingRoute, { kind: 'invoke-route', routeId, req });

        const pendingShortcode = new Map<number, any>();
        // Everything the plugin registers in host-side state, tracked so we can fully tear it
        // down on unload/reload — otherwise a stale route/hook/shortcode would RPC a dead worker.
        const registeredShortcodes: string[] = [];                                  // shortcode tags
        const registeredRoutes: Array<{ m: string; full: string }> = [];            // mounted Express routes
        const registeredHooks: Array<{ hook: string; type: string; shim: Function }> = []; // hook/filter shims
        let providedMail = false;                                                   // did this plugin become the mail sender
        const invokeShortcode = (scId: string, payload: any) => rpcSend(pendingShortcode, { kind: 'invoke-shortcode', scId, ...payload });

        const pendingMail = new Map<number, any>();
        const invokeMail = (mailMsg: any) => rpcSend(pendingMail, { kind: 'invoke-mail', msg: mailMsg });

        const pendingTransport = new Map<number, any>();
        const invokeNotifyTransport = (name: string, notification: any) => rpcSend(pendingTransport, { kind: 'invoke-notify-transport', name, notification });

        worker.on('message', async (msg: any) => {
            if (msg.kind === 'ready') {
                resolve({ worker, slug });
            } else if (msg.kind === 'init-error') {
                reject(new Error(msg.error));
            } else if (msg.kind === 'call') {
                // The isolate invoked a wordjs.* method — run it here, in the plugin's context.
                try {
                    const value = await runWithContext(slug, () => callApi(api, msg.method, msg.args));
                    worker.postMessage({ kind: 'reply', id: msg.id, ok: true, value });
                } catch (e: any) {
                    worker.postMessage({ kind: 'reply', id: msg.id, ok: false, error: String(e && e.message || e) });
                }
            } else if (msg.kind === 'register') {
                // Install a shim in the real hook system that calls back into the isolate.
                const shim = (...args: any[]) => invokeWorker(msg.cbId, args);
                registeredHooks.push({ hook: msg.hook, type: msg.hookType, shim });
                runWithContext(slug, () => {
                    if (msg.hookType === 'filter') hooks.addFilter(msg.hook, shim, msg.priority);
                    else hooks.addAction(msg.hook, shim, msg.priority);
                });
            } else if (msg.kind === 'invoke-reply') {
                rpcSettle(pendingInvoke, msg, msg.value);
            } else if (msg.kind === 'register-route') {
                // Mount an Express route owned by the host; run the real auth middleware, then forward
                // a serialized request to the isolate and write back its response descriptor.
                const { getApp } = require('./appRegistry');
                const app = getApp();
                if (!app) return;
                const mw: any[] = [];
                if (msg.opts && msg.opts.auth) mw.push(require('../middleware/auth').authenticate);
                if (msg.opts && msg.opts.admin) mw.push(require('../middleware/permissions').isAdmin);
                // Multipart uploads can't be serialized over RPC, so the HOST parses them (multer)
                // and forwards the saved file's metadata to the isolate. opts.multipart = field name.
                if (msg.opts && msg.opts.multipart) {
                    try {
                        const multer = require('multer');
                        const os = require('os');
                        const up = multer({ dest: path.join(os.tmpdir(), 'wordjs-uploads') });
                        mw.push(up.single(String(msg.opts.multipart)));
                    } catch (e: any) { console.warn(`[Isolate ${slug}] multipart unavailable:`, e && e.message); }
                }
                const finalHandler = async (req: any, res: any) => {
                    const reqData = {
                        method: req.method, path: req.path, query: req.query, params: req.params, body: req.body,
                        cookies: req.cookies || {},
                        headers: { 'x-portal-token': req.headers['x-portal-token'] }, // selected non-sensitive headers
                        // Saved-upload metadata (multer) — the isolate gets the path/name, not the stream.
                        file: req.file ? { path: req.file.path, originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size, filename: req.file.filename } : undefined,
                        user: req.user ? { id: req.user.id, role: req.user.role, userEmail: req.user.userEmail, userLogin: req.user.userLogin } : null
                    };
                    try {
                        const r = await invokeRoute(msg.routeId, reqData);
                        if (r.headers) res.set(r.headers);
                        // Replay cookies the isolate set/cleared on the real response.
                        if (Array.isArray(r.cookies)) {
                            for (const c of r.cookies) {
                                if (c.clear) res.clearCookie(c.name, c.options || {});
                                else res.cookie(c.name, c.value, c.options || {});
                            }
                        }
                        res.status(r.status || 200);
                        if (r.body === undefined) res.end(); else res.json(r.body);
                    } catch (e: any) {
                        res.status(502).json({ error: 'Isolated plugin error', detail: String(e && e.message || e) });
                    }
                };
                const m = String(msg.method).toLowerCase();
                // Untrusted plugins are namespaced under /api/v1/plugin/<slug> (no route hijack).
                // Operator-trusted plugins may opt into their ORIGINAL absolute path (opts.absolute)
                // so a first-party plugin can isolate without rewriting its whole frontend's URLs.
                const full = (msg.opts && msg.opts.absolute && isTrustedPlugin(slug))
                    ? msg.routePath
                    : `/api/v1/plugin/${slug.replace('theme:', 'theme-')}${msg.routePath}`;
                runWithContext(slug, () => app[m](full, ...mw, finalHandler));
                registeredRoutes.push({ m, full });
            } else if (msg.kind === 'route-reply') {
                rpcSettle(pendingRoute, msg, msg.response);
            } else if (msg.kind === 'register-shortcode') {
                // Register a shortcode shim that forwards {attrs,content,tag} to the isolate and
                // resolves its HTML asynchronously (works with doShortcodeAsync).
                const shim = (attrs: any, content: any, tag: any) =>
                    invokeShortcode(msg.scId, { attrs, content, tag });
                registeredShortcodes.push(msg.tag);
                runWithContext(slug, () => addShortcode(msg.tag, shim));
            } else if (msg.kind === 'shortcode-reply') {
                rpcSettle(pendingShortcode, msg, msg.value);
            } else if (msg.kind === 'register-mail-provider') {
                // Becoming the host-wide mail sender is host-level hijack potential, so it is
                // restricted to operator-trusted plugins (config.trustedSystemPlugins) — an untrusted
                // uploaded plugin cannot intercept everyone's outbound mail.
                if (isTrustedPlugin(slug)) {
                    (global as any).wordjs_send_mail = (mailMsg: any) => invokeMail(mailMsg);
                    providedMail = true;
                } else {
                    console.warn(`[Isolate ${slug}] provideMail denied: only operator-trusted plugins may register the host mail sender.`);
                }
            } else if (msg.kind === 'mail-reply') {
                rpcSettle(pendingMail, msg, msg.value);
            } else if (msg.kind === 'register-notify-transport') {
                // Registering a core notification transport can intercept dispatched notifications,
                // so it is likewise restricted to operator-trusted plugins.
                if (isTrustedPlugin(slug)) {
                    try {
                        require('./notifications').registerTransport(msg.name, (notification: any) => invokeNotifyTransport(msg.name, notification));
                    } catch (e: any) { console.warn(`[Isolate ${slug}] notify transport register failed:`, e && e.message); }
                } else {
                    console.warn(`[Isolate ${slug}] notify.registerTransport denied: only operator-trusted plugins may register a notification transport.`);
                }
            } else if (msg.kind === 'notify-transport-reply') {
                rpcSettle(pendingTransport, msg, msg.value);
            }
        });

        // Remove every host-side registration this plugin made. Idempotent (safe to call twice)
        // so it can run both from unloadIsolatedPlugin and as a crash safety-net in 'exit'.
        const teardown = () => {
            // Routes: splice the plugin's layers out of the Express stack (Express 4 has no public
            // unmount API), so a request to its path no longer reaches a dead worker.
            try {
                const { getApp } = require('./appRegistry');
                const app = getApp();
                const stack = app && app._router && app._router.stack;
                if (Array.isArray(stack) && registeredRoutes.length) {
                    for (const { m, full } of registeredRoutes) {
                        for (let i = stack.length - 1; i >= 0; i--) {
                            const r = stack[i] && stack[i].route;
                            if (r && r.path === full && r.methods && r.methods[m]) stack.splice(i, 1);
                        }
                    }
                }
            } catch { /* */ }
            for (const { hook, type, shim } of registeredHooks) {
                try { type === 'filter' ? hooks.removeFilter(hook, shim) : hooks.removeAction(hook, shim); } catch { /* */ }
            }
            for (const tag of registeredShortcodes) { try { removeShortcode(tag); } catch { /* */ } }
            if (providedMail && (global as any).wordjs_send_mail) { try { delete (global as any).wordjs_send_mail; } catch { /* */ } }
            try { require('./notifications').unregisterPluginTransports(slug); } catch { /* */ }
            try { require('./adminMenu').unregisterAdminMenu(slug); } catch { /* */ }
        };

        worker.on('error', (err: any) => { console.error(`[Isolate ${slug}] worker error:`, err.message); reject(err); });
        worker.on('exit', (code: number) => {
            // Only act if WE are still the registered isolate — on reload a fresh worker has already
            // replaced us, and tearing down here would rip out the new worker's registrations.
            const cur = isolates.get(slug);
            if (cur && cur.worker === worker) { isolates.delete(slug); try { teardown(); } catch { /* */ } }
            if (code !== 0) console.warn(`[Isolate ${slug}] worker exited with code ${code}`);
        });

        isolates.set(slug, { worker, teardown, entryFile });
    });
}

function unloadIsolatedPlugin(slug: string) {
    const h = isolates.get(slug);
    if (h) {
        try { h.teardown && h.teardown(); } catch (e) { /* */ }
        try { h.worker.terminate(); } catch (e) { /* */ }
        isolates.delete(slug);
    }
}

// Tear the plugin down and start it again, reusing the entry file from the original load. Used by
// the trust toggle so a now-trusted/untrusted plugin re-registers its routes (namespaced ↔ absolute)
// and re-evaluates host-capability gates without a full server restart. No-op if not loaded.
async function reloadIsolatedPlugin(slug: string): Promise<any> {
    const h = isolates.get(slug);
    if (!h || !h.entryFile) return null;
    const entryFile = h.entryFile;
    unloadIsolatedPlugin(slug);
    return loadIsolatedPlugin(slug, entryFile);
}

module.exports = { loadIsolatedPlugin, unloadIsolatedPlugin, reloadIsolatedPlugin, isIsolated: (slug: string) => isolates.has(slug) };
