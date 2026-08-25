/**
 * WORK THAT ESCAPES ITS HANDLER — THE CLASS, NOT THE ONE SITE THAT WAS REPORTED.
 *
 * `asyncHandler` is the only thing standing between a route and a 500, and all it does is
 * `Promise.resolve(fn(req, res, next)).catch(next)`. It can therefore only ever see a rejection of
 * the promise the handler RETURNED. The moment a handler hands work to something that will call back
 * on a LATER TICK — a node-style callback (`fs.readdir`, `res.download`), a `.then` reaction, a
 * listener on `req`/`res`/an emitter — that work runs on an EMPTY stack. A throw there is not a 500:
 * it is an `uncaughtException` (or, when the derived promise is discarded, an `unhandledRejection`),
 * and `src/index.ts` answers both with `process.exit(1)`. The request is never answered either way.
 *
 * `routes/fonts.ts` was closed for this last round (its `fs.readdir` callback now ends in
 * `catch (e) { next(e) }`). This file is the sweep of the REST of the class. The site list was
 * derived by walking the AST of every file in `backend/src/routes` and `backend/src/middleware` for
 * a call to an async-dispatching API — `fs.*` with a callback, `res.download`/`res.sendFile`,
 * `.then`/`.catch`, `.on`/`.once`, `setTimeout`/`setInterval`/`setImmediate`, `execFile` — whose
 * callback is reachable from a request handler; 22 such sites exist, and the members that can
 * actually throw are exercised below. More than one site is driven here on purpose: a class test
 * that touches one member is a member test.
 *
 * WHAT IS REAL HERE AND WHAT IS MADE REPEATABLE. Each `it` drives the REAL route handler, pulled out
 * of the REAL router's own stack, through a real express app and a real socket. Only the auth layers
 * in front of it are left off, because the defect lives in the handler body and nothing about it
 * depends on who the caller is. Where the triggering failure is real but environmental (an errno the
 * filesystem produces on a read-only file, a race window between two concurrent requests), the error
 * is injected AT THE FS BOUNDARY THE ROUTE ALREADY CALLS, for one path only — the same tactic
 * `handler-escape-cleanup.test.ts` used when it planted a dangling junction to make the
 * readdir→statSync race repeatable. The code under test is never stubbed or reimplemented.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// core/themes resolves THEMES_DIR (`path.resolve('./themes')`) and createThemeZip's temp directory
// (`path.resolve(process.cwd(), 'os-tmp')`) from the CWD, so move before anything is required.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-escape-class-'));
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');

const express = require('express');
const request = require('supertest');
const http = require('http');
const { errorHandler } = require('../middleware/errorHandler');

const THEME_SLUG = 'twin-theme';
const THEMES_DIR = path.join(TMP_ROOT, 'themes');
const ZIP_PATH = path.resolve(TMP_ROOT, 'os-tmp', `${THEME_SLUG}.zip`);

/**
 * The REAL handler for one route, taken out of the REAL router. `route.stack` is
 * [ ...middleware, handler ], so the last entry is the handler itself — the auth layers in front of
 * it are what we are deliberately not re-running.
 */
function routeHandler(router: any, method: string, routePath: string): any {
    const layer = router.stack.find((l: any) => l.route && l.route.path === routePath && l.route.methods[method]);
    assert.ok(layer, `no ${method.toUpperCase()} ${routePath} in that router — the route was renamed`);
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle;
}

/** Collects everything that escaped onto the process while `fn` ran. */
async function withEscapeCapture(fn: () => Promise<any>): Promise<{ escaped: any[]; value: any }> {
    const escaped: any[] = [];
    const capture = (err: any) => escaped.push(err);
    process.on('uncaughtException', capture);
    process.on('unhandledRejection', capture);
    try {
        const value = await fn();
        // Both an uncaughtException from a callback and an unhandledRejection from a discarded
        // promise surface a macrotask later than the code that produced them.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        return { escaped, value };
    } finally {
        process.removeListener('uncaughtException', capture);
        process.removeListener('unhandledRejection', capture);
    }
}

const describeEscaped = (escaped: any[]) => escaped.map((e: any) => `${e && e.code ? e.code + ': ' : ''}${e && e.message}`);

describe('work that escapes its handler (class)', () => {
    let app: any;
    let server: any;
    let port: number;

    before(async () => {
        // A real theme on disk for createThemeZip to pack.
        const themeDir = path.join(THEMES_DIR, THEME_SLUG);
        fs.mkdirSync(themeDir, { recursive: true });
        fs.writeFileSync(path.join(themeDir, 'theme.json'), JSON.stringify({ name: 'Twin', version: '1.0.0' }));
        fs.writeFileSync(path.join(themeDir, 'style.css'), 'body{color:red}');

        const themesRouter = require('../routes/themes');
        const hooksRouter = require('../routes/hooks');

        app = express();
        app.get('/themes/:slug/download', routeHandler(themesRouter, 'get', '/:slug/download'));
        app.get('/hooks/stream', routeHandler(hooksRouter, 'get', '/stream'));
        app.use(errorHandler);

        server = app.listen(0);
        await new Promise((resolve) => server.once('listening', resolve));
        port = server.address().port;
    });

    after(async () => {
        try { await new Promise((resolve) => server.close(resolve)); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    /**
     * CONTROL for the theme download. The route must still serve the zip AND still delete the temp
     * file it created — the fix wraps that cleanup, it must not move or skip it.
     */
    it('GET /themes/:slug/download: still serves the zip and still deletes the temp file', async () => {
        const res = await request(app).get(`/themes/${THEME_SLUG}/download`).buffer(true);

        assert.strictEqual(res.status, 200, `expected the zip, got ${res.status}`);
        assert.ok(
            Number(res.headers['content-length']) > 0,
            `the zip body must not be empty, content-length was ${res.headers['content-length']}`
        );
        assert.match(res.headers['content-disposition'] || '', new RegExp(`${THEME_SLUG}\\.zip`));
        // The callback's whole job. It must still run after being wrapped.
        assert.strictEqual(
            fs.existsSync(ZIP_PATH), false,
            `the temp zip was left behind at ${ZIP_PATH}`
        );
    });

    /**
     * ─── MEMBER: routes/themes.ts, GET /themes/:slug/download ─────────────────────────────────────
     *
     *     res.download(zipPath, name, (err) => { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); });
     *
     * The exact shape routes/fonts.ts had. Express hands this callback to `send`'s finish/error
     * listeners, so the body runs on an empty stack that asyncHandler cannot see, and `fs.unlinkSync`
     * is not a call that cannot fail: it throws EPERM on Windows for a file carrying
     * FILE_ATTRIBUTE_READONLY (what a backup agent, an AV quarantine or `attrib +R` leaves behind)
     * and EACCES on POSIX when os-tmp/ is not writable by the server user. The throw lands on an
     * empty stack as an uncaughtException, and index.ts answers that with process.exit(1) — the
     * server dies AFTER a download the client saw succeed, so nothing in the response says why.
     *
     * `fs.unlinkSync` is made to produce that real errno for this one path. Everything else — the
     * handler, the zip build, express's streaming and the callback body under test — is untouched.
     */
    it('GET /themes/:slug/download: a cleanup that throws does not escape the handler', async () => {
        const realUnlinkSync = fs.unlinkSync;
        (fs as any).unlinkSync = (p: any, ...rest: any[]) => {
            if (path.resolve(String(p)) === ZIP_PATH) {
                const err: any = new Error(`EPERM: operation not permitted, unlink '${p}'`);
                err.code = 'EPERM';
                err.syscall = 'unlink';
                err.path = String(p);
                throw err;
            }
            return (realUnlinkSync as any)(p, ...rest);
        };

        let result: any;
        try {
            result = await withEscapeCapture(() =>
                request(app).get(`/themes/${THEME_SLUG}/download`).buffer(true)
            );
        } finally {
            (fs as any).unlinkSync = realUnlinkSync;
            try { realUnlinkSync(ZIP_PATH); } catch { /* already gone */ }
        }

        assert.strictEqual(result.value.status, 200, `expected the zip to be served, got ${result.value.status}`);
        assert.deepStrictEqual(
            describeEscaped(result.escaped), [],
            'the cleanup throw escaped the download callback — on a live server index.ts turns that into process.exit(1)'
        );
    });

    /**
     * ─── SAME MEMBER, OTHER HALF: the `err` the callback never looks at ────────────────────────────
     *
     * Supplying a callback to `res.download` makes express hand a TRANSFER failure to that callback
     * INSTEAD of to `next()`. The callback ignores its `err`, so nothing answers the request and
     * nothing closes it: the socket is held open until the client gives up.
     *
     * The window is real and this route opens it on itself. createThemeZip writes a DETERMINISTIC
     * `os-tmp/<slug>.zip`, so two concurrent downloads of the same theme share one temp file, and the
     * first callback to run deletes it while the second is still opening it. `fs.stat` — the call
     * `send` makes before it streams — is made to report that state for this one path.
     */
    it('GET /themes/:slug/download: a failed transfer answers instead of hanging for ever', async () => {
        const realStat = fs.stat;
        (fs as any).stat = (p: any, ...rest: any[]) => {
            if (path.resolve(String(p)) === ZIP_PATH) {
                const cb = rest[rest.length - 1];
                const err: any = new Error(`ENOENT: no such file or directory, stat '${p}'`);
                err.code = 'ENOENT';
                err.syscall = 'stat';
                err.path = String(p);
                return process.nextTick(() => cb(err));
            }
            return (realStat as any)(p, ...rest);
        };

        let res: any;
        const pending = request(app).get(`/themes/${THEME_SLUG}/download`).buffer(true);
        try {
            res = await Promise.race([
                pending.then((r: any) => r, (e: any) => ({ status: `ERRORED (${e && e.message})` })),
                new Promise((resolve) => setTimeout(() => resolve({ status: 'NO RESPONSE (timed out)' }), 3000)),
            ]);
        } finally {
            (fs as any).stat = realStat;
            try { pending.abort(); } catch { /* already settled */ }
            try { fs.unlinkSync(ZIP_PATH); } catch { /* already gone */ }
        }

        assert.strictEqual(
            typeof res.status, 'number',
            `the request was never answered: ${JSON.stringify(res.status)} — res.download handed the transfer error to a callback that drops it`
        );
        assert.ok(res.status >= 400, `a transfer that failed must not report success, got ${res.status}`);
        // send's own message names os-tmp/<slug>.zip; the answer must not repeat it back.
        assert.ok(
            !JSON.stringify(res.body || {}).includes('os-tmp'),
            `the failure body disclosed the temp path: ${JSON.stringify(res.body)}`
        );
    });

    /**
     * ─── MEMBER: routes/hooks.ts, GET /hooks/stream ────────────────────────────────────────────────
     *
     *     const onHookCall = (data) => { res.write(`data: ${JSON.stringify(data)}\n\n`); };
     *     hooks.monitor.on('hook:call', onHookCall);
     *
     * A listener registered INSIDE a request handler, on an emitter that outlives the request. Its
     * body throws whenever the monitor frame is not JSON-serializable, and `Hooks._emitMonitor`
     * flattens only OBJECTS — primitives are passed through untouched, so a hook fired with a BIGINT
     * argument (what mysql2 hands back for a BIGINT column) reaches `JSON.stringify` and throws
     * `Do not know how to serialize a BigInt`.
     *
     * This is the worst variant in the class, because the failure does not even surface on the SSE
     * request that owns the listener: `monitor.emit` is synchronous, so the throw propagates out of
     * `hooks.doAction` and lands on WHOEVER fired the hook — an unrelated request, or, for a
     * fire-and-forget `doAction(...)`, nobody at all (an unhandledRejection, which ends the process).
     * One admin holding the hook inspector open turns any BIGINT-carrying hook into a failure
     * somewhere else entirely. Nothing is stubbed here: a real SSE client, the real emitter, a real
     * hook dispatch.
     */
    it('GET /hooks/stream: an unserializable monitor frame does not escape onto the hook caller', async () => {
        const hooks = require('../core/hooks');
        const sse = await openStream();

        let thrownAtCaller: any = null;
        const { escaped } = await withEscapeCapture(async () => {
            try {
                // From a string on purpose: this value is exactly what a BIGINT column holds and a
                // number literal cannot — which is why the driver hands it over as a BigInt at all.
                await hooks.doAction('wordjs_handler_escape_probe', BigInt('9007199254740993'));
            } catch (e) {
                thrownAtCaller = e;
            }
        });
        sse.destroy();

        assert.strictEqual(
            thrownAtCaller, null,
            `the SSE listener's throw escaped onto the hook caller: ${thrownAtCaller && thrownAtCaller.message}`
        );
        assert.deepStrictEqual(
            describeEscaped(escaped), [],
            'the SSE listener took the process down instead of dropping one frame'
        );
    });

    /**
     * CONTROL for the hook stream: containment must mean "drop the frame", not "kill the stream".
     * Without this, the member above could be satisfied by silently closing the subscriber.
     */
    it('GET /hooks/stream: a serializable frame still reaches the subscriber after a bad one', async () => {
        const hooks = require('../core/hooks');
        const frames: string[] = [];
        const sse = await openStream();
        sse.setEncoding('utf8');
        sse.on('data', (c: string) => frames.push(c));

        try {
            await hooks.doAction('wordjs_handler_escape_probe', BigInt(1)).catch(() => { /* the defect */ });
            await hooks.doAction('wordjs_handler_escape_probe_ok', 'plain-string').catch(() => { /* the defect */ });
            await new Promise((resolve) => setTimeout(resolve, 100));
        } finally {
            sse.destroy();
        }

        assert.ok(
            frames.join('').includes('wordjs_handler_escape_probe_ok'),
            `the stream stopped delivering after the unserializable frame; got ${JSON.stringify(frames.join(''))}`
        );
    });

    /** Opens a real SSE client against the mounted /hooks/stream and waits for its first frame. */
    async function openStream(): Promise<any> {
        const res: any = await new Promise((resolve, reject) => {
            const r = http.get({ port, path: '/hooks/stream' }, resolve);
            r.on('error', reject);
        });
        assert.strictEqual(res.statusCode, 200, 'the hook stream must open');
        await new Promise((resolve) => res.once('data', resolve));
        return res;
    }
});
