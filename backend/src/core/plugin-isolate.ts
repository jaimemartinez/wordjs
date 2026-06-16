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
            }
        });

        worker.on('error', (err: any) => { console.error(`[Isolate ${slug}] worker error:`, err.message); reject(err); });
        worker.on('exit', (code: number) => {
            isolates.delete(slug);
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
