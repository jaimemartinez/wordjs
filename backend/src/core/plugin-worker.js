/**
 * WordJS - Isolated Plugin Worker (cross-platform, no native deps)
 *
 * Runs ONE untrusted plugin inside a worker_threads Worker (a separate V8 isolate). The plugin
 * reaches core ONLY through the injected `wordjs` bridge, whose calls are RPC'd to the host and
 * permission-checked THERE — the host's heap (secrets, DB handle, other plugins) is unreachable
 * from this isolate. The same runtime guards (secure-require / io-guard) are installed inside the
 * worker too, so the plugin's own fs/child_process are sandboxed even here.
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
const { parentPort, workerData } = require('worker_threads');
const path = require('path');

const { slug, entryFile, coreDir } = workerData;

// Install the same capability guards inside this isolate (defense-in-depth: even after a heap
// escape the worker can't freely touch fs/child_process), then run the plugin in its context.
try {
    require(path.join(coreDir, 'io-guard'));
    require(path.join(coreDir, 'secure-require')).installSecureRequire();
} catch (e) { /* guards are best-effort inside the worker */ }
const { runWithContext } = require(path.join(coreDir, 'plugin-context'));

let _id = 0;
const pending = new Map();         // id -> {resolve,reject} for our calls to the host
const callbacks = new Map();       // cbId -> function (hook/filter callbacks living in this isolate)
const routeHandlers = new Map();   // routeId -> route handler (req,res) living in this isolate
const shortcodeHandlers = new Map(); // scId -> shortcode handler (attrs,content,tag)=>string living here

function callHost(method, args) {
    return new Promise((resolve, reject) => {
        const id = ++_id;
        pending.set(id, { resolve, reject });
        parentPort.postMessage({ kind: 'call', id, method, args });
    });
}

function registerCallback(hookType, hook, cb, priority) {
    const cbId = `${hookType}:${hook}:${++_id}`;
    callbacks.set(cbId, cb);
    parentPort.postMessage({ kind: 'register', hookType, hook, cbId, priority });
}

// The `wordjs` bridge as seen INSIDE the isolate. Data methods RPC to the host; hook registration
// keeps the callback local and tells the host to install a shim that calls back in.
const wordjs = {
    slug,
    options: { get: (k, d) => callHost('options.get', [k, d]), set: (k, v) => callHost('options.set', [k, v]) },
    db: {
        all: (sql, p = []) => callHost('db.all', [sql, p]),
        get: (sql, p = []) => callHost('db.get', [sql, p]),
        run: (sql, p = []) => callHost('db.run', [sql, p]),
        createTable: (name, cols) => callHost('db.createTable', [name, cols])
    },
    hooks: {
        addAction: (hook, cb, priority) => registerCallback('action', hook, cb, priority),
        addFilter: (hook, cb, priority) => registerCallback('filter', hook, cb, priority),
        doAction: (hook, ...args) => callHost('hooks.doAction', [hook, ...args])
    },
    fs: { read: (p, enc) => callHost('fs.read', [p, enc]), write: (p, d) => callHost('fs.write', [p, d]) },
    mail: (msg) => callHost('mail', [msg]),
    notify: (n) => callHost('notify', [n]),
    adminMenu: { add: (item) => callHost('adminMenu.add', [item]) },
    cron: { schedule: (ts, rec, hook, args) => callHost('cron.schedule', [ts, rec, hook, args]) },

    // Register a JSON route. `opts` (optional): { auth, admin } -> host applies the real auth
    // middleware before forwarding. The handler runs HERE with a mock (req,res) over RPC: it gets
    // {method,path,query,params,body,user} and replies via res.status().json()/send()/end().
    http: {
        route(method, routePath, opts, handler) {
            if (typeof opts === 'function') { handler = opts; opts = {}; }
            const routeId = `route:${method}:${routePath}:${++_id}`;
            routeHandlers.set(routeId, handler);
            parentPort.postMessage({ kind: 'register-route', method, routePath, opts: opts || {}, routeId });
        }
    },

    // Register a shortcode. The handler runs HERE (may be async / use the bridge) and returns the
    // HTML string; the host expands it via doShortcodeAsync, forwarding {attrs,content,tag} over RPC.
    shortcodes: {
        add(tag, handler) {
            const scId = `sc:${tag}:${++_id}`;
            shortcodeHandlers.set(scId, handler);
            parentPort.postMessage({ kind: 'register-shortcode', tag, scId });
        }
    }
};

parentPort.on('message', async (msg) => {
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
            parentPort.postMessage({ kind: 'invoke-reply', id: msg.id, ok: true, value });
        } catch (e) {
            parentPort.postMessage({ kind: 'invoke-reply', id: msg.id, ok: false, error: String(e && e.message || e) });
        }
    } else if (msg.kind === 'invoke-route') {
        // Host forwarded an HTTP request for a route handler living in this isolate.
        const handler = routeHandlers.get(msg.routeId);
        const reqData = msg.req || {};
        let settled = false;
        const reply = (status, body, headers) => {
            if (settled) return; settled = true;
            parentPort.postMessage({ kind: 'route-reply', id: msg.id, ok: true, response: { status, body, headers } });
        };
        const res = {
            _status: 200, _headers: undefined,
            status(s) { this._status = s; return this; },
            set(h) { this._headers = Object.assign({}, this._headers, h); return this; },
            json(b) { reply(this._status, b, this._headers); return this; },
            send(b) { reply(this._status, b, this._headers); return this; },
            end() { reply(this._status, undefined, this._headers); return this; }
        };
        try {
            if (!handler) throw new Error('No such route handler');
            await handler(reqData, res);
            if (!settled) reply(res._status, undefined, res._headers);
        } catch (e) {
            parentPort.postMessage({ kind: 'route-reply', id: msg.id, ok: false, error: String(e && e.stack || e) });
        }
    } else if (msg.kind === 'invoke-shortcode') {
        // Host is expanding a shortcode whose handler lives in this isolate.
        const handler = shortcodeHandlers.get(msg.scId);
        try {
            const out = handler ? await handler(msg.attrs || {}, msg.content || '', msg.tag) : '';
            parentPort.postMessage({ kind: 'shortcode-reply', id: msg.id, ok: true, value: out == null ? '' : String(out) });
        } catch (e) {
            parentPort.postMessage({ kind: 'shortcode-reply', id: msg.id, ok: false, error: String(e && e.message || e) });
        }
    }
});

// Load + initialize the plugin inside its context.
(async () => {
    try {
        const plugin = require(entryFile);
        if (typeof plugin.init === 'function') {
            await runWithContext(slug, () => plugin.init(wordjs));
        }
        parentPort.postMessage({ kind: 'ready' });
    } catch (e) {
        parentPort.postMessage({ kind: 'init-error', error: String(e && e.stack || e) });
    }
})();
