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
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');
const hooks = require('../core/hooks');

const SLUG = 'test-isolate-plugin';
const dir = path.join(path.resolve(__dirname, '../../plugins'), SLUG);
const entry = path.join(dir, 'index.js');

before(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, isolated: true, permissions: [] }));
    fs.writeFileSync(entry,
        "exports.init = function (wordjs) {\n" +
        "  wordjs.hooks.addFilter('test_iso_filter', (v) => '[iso]' + v);\n" +
        "};\n");
});
after(() => {
    unloadIsolatedPlugin(SLUG);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

test('isolated plugin runs in a worker and its filter applies over RPC', async () => {
    await loadIsolatedPlugin(SLUG, entry);
    const out = await hooks.applyFilters('test_iso_filter', 'hello');
    assert.strictEqual(out, '[iso]hello');
});
