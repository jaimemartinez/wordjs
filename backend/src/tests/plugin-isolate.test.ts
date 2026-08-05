/**
 * End-to-end test for the worker-based isolated plugin runtime (cross-platform).
 * Proves: an `isolated` plugin loads in a worker, registers a filter via the bridge, and that
 * filter is applied through the real hook system over RPC into the isolate.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

require('../config/app'); // preload (trusted context)
const express = require('express');
const request = require('supertest');
const { loadIsolatedPlugin, unloadIsolatedPlugin, reloadIsolatedPlugin } = require('../core/plugin-isolate');
const { setApp } = require('../core/appRegistry');
const hooks = require('../core/hooks');
const { doShortcodeAsync } = require('../core/shortcodes');

const SLUG = 'test-isolate-plugin';
const dir = path.join(path.resolve(__dirname, '../../plugins'), SLUG);
const entry = path.join(dir, 'index.js');
const app = express();
app.use(express.json());

before(async () => {
    setApp(app); // host owns Express; isolated routes mount here
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, isolated: true, permissions: [] }));
    fs.writeFileSync(entry,
        "exports.init = function (wordjs) {\n" +
        "  wordjs.hooks.addFilter('test_iso_filter', (v) => '[iso]' + v);\n" +
        "  wordjs.http.route('get', '/ping', (req, res) => res.status(200).json({ ok: true, echo: req.query.x || null }));\n" +
        // 'all' is on the isolate's verb allowlist, and it is the verb whose teardown silently failed:
        // app.all() never leaves a route.methods.all key, so the old verb-keyed unmount never matched.
        "  wordjs.http.route('all', '/anyverb', (req, res) => res.status(200).json({ ok: true, verb: req.method }));\n" +
        "  wordjs.shortcodes.add('iso_sc', async (attrs) => '<b>' + (attrs.x || '') + '</b>');\n" +
        "  wordjs.http.route('get', '/netcheck', (req, res) => {\n" +
        "    let fetchBlocked = false; try { void fetch; } catch (e) { fetchBlocked = true; }\n" +
        "    let netBlocked = false; try { require('net').createServer(); } catch (e) { netBlocked = true; }\n" +
        "    res.status(200).json({ fetchBlocked, netBlocked });\n" +
        "  });\n" +
        "};\n");
    await loadIsolatedPlugin(SLUG, entry);
});
after(() => {
    unloadIsolatedPlugin(SLUG);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

test('isolated plugin runs in a worker and its filter applies over RPC', async () => {
    const out = await hooks.applyFilters('test_iso_filter', 'hello');
    assert.strictEqual(out, '[iso]hello');
});

test('isolated plugin JSON route is served via host Express + RPC forwarding', async () => {
    // (plugin already loaded by the previous test; route mounted at registration)
    const r = await request(app).get(`/api/v1/plugin/${SLUG}/ping?x=hi`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { ok: true, echo: 'hi' });
});

test('isolated plugin async shortcode expands via doShortcodeAsync over RPC', async () => {
    const out = await doShortcodeAsync('a [iso_sc x="hi"] b');
    assert.strictEqual(out, 'a <b>hi</b> b');
});

test('untrusted isolated plugin cannot reach the network (global fetch + raw sockets are blocked)', async () => {
    // The test plugin has NOT been granted the `network` capability (cfg.network=false): secure-require
    // blocks the net module AND the worker bootstrap traps the binding-backed global fetch (which the
    // module denylist can't reach). Both must be blocked, or a plugin can exfiltrate / SSRF.
    const r = await request(app).get(`/api/v1/plugin/${SLUG}/netcheck`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.fetchBlocked, true, 'global fetch must be trapped for an untrusted plugin');
    assert.strictEqual(r.body.netBlocked, true, 'raw net sockets must be blocked for an untrusted plugin');
});

const countRouteLayers = (full: string) =>
    (app._router?.stack || []).filter((l: any) => l.route && l.route.path === full).length;

test('reloading an isolated plugin re-registers cleanly — no stale/duplicate route layer', async () => {
    const full = `/api/v1/plugin/${SLUG}/ping`;
    assert.strictEqual(countRouteLayers(full), 1, 'precondition: exactly one route layer');

    await reloadIsolatedPlugin(SLUG);

    // The fresh worker serves the route...
    const r = await request(app).get(`${full}?x=re`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { ok: true, echo: 're' });
    // ...the old layer was torn down (not left as a duplicate pointing at the dead worker)...
    assert.strictEqual(countRouteLayers(full), 1, 'reload must not duplicate the route layer');
    // ...and the filter still applies (re-registered as a single shim, no stale shim accumulating).
    assert.strictEqual(await hooks.applyFilters('test_iso_filter', 'x'), '[iso]x');
});

test('an `all`-verb route is served like any other', async () => {
    const r = await request(app).post(`/api/v1/plugin/${SLUG}/anyverb`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { ok: true, verb: 'POST' });
});

test('unloading an isolated plugin tears down its route AND hook (no dead-worker RPC left behind)', async () => {
    const full = `/api/v1/plugin/${SLUG}/ping`;
    unloadIsolatedPlugin(SLUG);

    assert.strictEqual(countRouteLayers(full), 0, 'route layer must be removed on unload');
    const r = await request(app).get(full);
    assert.strictEqual(r.status, 404, 'route must 404 after unload, not 502 from a dead worker');
    assert.strictEqual(await hooks.applyFilters('test_iso_filter', 'hello'), 'hello', 'hook shim must be removed');
});

// Regression: teardown keyed the unmount on the REGISTRATION verb, but Express implements app.all()
// by looping the concrete HTTP methods, so route.methods has get/post/... and never a key named
// 'all'. The layer of an unloaded plugin therefore survived, and a request to it reached a dead
// worker whose IPC send fails asynchronously — so it hung for the full 30s RPC timeout instead of
// 404ing. Anyone could hold sockets open on a plugin the admin had deliberately removed.
test('unload also tears down an `all`-verb route (it must not outlive the worker)', async () => {
    const full = `/api/v1/plugin/${SLUG}/anyverb`;
    // (the previous test already unloaded the plugin — teardown is idempotent and covers every verb)
    assert.strictEqual(countRouteLayers(full), 0, 'the `all` route layer must be removed on unload');
    const r = await request(app).post(full);
    assert.strictEqual(r.status, 404, 'an `all` route must 404 after unload, never hang on a dead worker');
});
