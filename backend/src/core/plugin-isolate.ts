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
        const pendingInvoke = new Map<number, any>();

        const invokeWorker = (cbId: string, args: any[]) => new Promise((res, rej) => {
            const id = ++invokeId;
            pendingInvoke.set(id, { res, rej });
            worker.postMessage({ kind: 'invoke', id, cbId, args });
        });

        const pendingRoute = new Map<number, any>();
        const invokeRoute = (routeId: string, req: any) => new Promise<any>((res, rej) => {
            const id = ++invokeId;
            pendingRoute.set(id, { res, rej });
            worker.postMessage({ kind: 'invoke-route', id, routeId, req });
        });

        const pendingShortcode = new Map<number, any>();
        const registeredShortcodes: string[] = []; // tags to remove when the isolate exits
        const invokeShortcode = (scId: string, payload: any) => new Promise<any>((res, rej) => {
            const id = ++invokeId;
            pendingShortcode.set(id, { res, rej });
            worker.postMessage({ kind: 'invoke-shortcode', id, scId, ...payload });
        });

        const pendingMail = new Map<number, any>();
        const invokeMail = (mailMsg: any) => new Promise<any>((res, rej) => {
            const id = ++invokeId;
            pendingMail.set(id, { res, rej });
            worker.postMessage({ kind: 'invoke-mail', id, msg: mailMsg });
        });

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
                runWithContext(slug, () => {
                    if (msg.hookType === 'filter') hooks.addFilter(msg.hook, shim, msg.priority);
                    else hooks.addAction(msg.hook, shim, msg.priority);
                });
            } else if (msg.kind === 'invoke-reply') {
                const p = pendingInvoke.get(msg.id);
                if (p) { pendingInvoke.delete(msg.id); msg.ok ? p.res(msg.value) : p.rej(new Error(msg.error)); }
            } else if (msg.kind === 'register-route') {
                // Mount an Express route owned by the host; run the real auth middleware, then forward
                // a serialized request to the isolate and write back its response descriptor.
                const { getApp } = require('./appRegistry');
                const app = getApp();
                if (!app) return;
                const mw: any[] = [];
                if (msg.opts && msg.opts.auth) mw.push(require('../middleware/auth').authenticate);
                if (msg.opts && msg.opts.admin) mw.push(require('../middleware/permissions').isAdmin);
                const finalHandler = async (req: any, res: any) => {
                    const reqData = {
                        method: req.method, path: req.path, query: req.query, params: req.params, body: req.body,
                        cookies: req.cookies || {},
                        headers: { 'x-portal-token': req.headers['x-portal-token'] }, // selected non-sensitive headers
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
                const full = `/api/v1/plugin/${slug.replace('theme:', 'theme-')}${msg.routePath}`;
                runWithContext(slug, () => app[m](full, ...mw, finalHandler));
            } else if (msg.kind === 'route-reply') {
                const p = pendingRoute.get(msg.id);
                if (p) { pendingRoute.delete(msg.id); msg.ok ? p.res(msg.response) : p.rej(new Error(msg.error)); }
            } else if (msg.kind === 'register-shortcode') {
                // Register a shortcode shim that forwards {attrs,content,tag} to the isolate and
                // resolves its HTML asynchronously (works with doShortcodeAsync).
                const shim = (attrs: any, content: any, tag: any) =>
                    invokeShortcode(msg.scId, { attrs, content, tag });
                registeredShortcodes.push(msg.tag);
                runWithContext(slug, () => addShortcode(msg.tag, shim));
            } else if (msg.kind === 'shortcode-reply') {
                const p = pendingShortcode.get(msg.id);
                if (p) { pendingShortcode.delete(msg.id); msg.ok ? p.res(msg.value) : p.rej(new Error(msg.error)); }
            } else if (msg.kind === 'register-mail-provider') {
                // This isolate provides the host-wide mail send. Install a shim that RPCs it.
                (global as any).wordjs_send_mail = (mailMsg: any) => invokeMail(mailMsg);
            } else if (msg.kind === 'mail-reply') {
                const p = pendingMail.get(msg.id);
                if (p) { pendingMail.delete(msg.id); msg.ok ? p.res(msg.value) : p.rej(new Error(msg.error)); }
            }
        });

        worker.on('error', (err: any) => { console.error(`[Isolate ${slug}] worker error:`, err.message); reject(err); });
        worker.on('exit', (code: number) => {
            isolates.delete(slug);
            // Drop the plugin's shortcodes so a dead isolate isn't RPC'd on the next render.
            for (const tag of registeredShortcodes) { try { removeShortcode(tag); } catch { /* */ } }
            if (code !== 0) console.warn(`[Isolate ${slug}] worker exited with code ${code}`);
        });

        isolates.set(slug, { worker });
    });
}

function unloadIsolatedPlugin(slug: string) {
    const h = isolates.get(slug);
    if (h) { try { h.worker.terminate(); } catch (e) { /* */ } isolates.delete(slug); }
}

module.exports = { loadIsolatedPlugin, unloadIsolatedPlugin, isIsolated: (slug: string) => isolates.has(slug) };
