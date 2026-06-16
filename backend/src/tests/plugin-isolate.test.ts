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
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');
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
        "  wordjs.shortcodes.add('iso_sc', async (attrs) => '<b>' + (attrs.x || '') + '</b>');\n" +
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
