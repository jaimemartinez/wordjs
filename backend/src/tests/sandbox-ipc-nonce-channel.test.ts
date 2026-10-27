/**
 * The per-spawn IPC frame nonce never appears on the child's command line.
 *
 * The host authenticates every control frame from an isolated child by a per-spawn secret. It used to
 * travel inside the cfg blob in argv; the worker rewrote process.argv, but the kernel keeps its own copy
 * of the command line (`ps`, /proc/<pid>/cmdline), so the secret stayed readable. It now arrives as the
 * host's first IPC message, and the plugin still loads (its `ready` frame is accepted only when stamped).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

require('../config/app');
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');
const hooks = require('../core/hooks');

const SLUG = 'test-ipc-nonce-channel';
const dir = path.join(path.resolve(__dirname, '../../plugins'), SLUG);
const entry = path.join(dir, 'index.js');
let handle: any = null;

before(async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, isolated: true }));
    fs.writeFileSync(entry,
        "exports.init = function (wordjs) {\n" +
        "  wordjs.hooks.addFilter('test_ipc_nonce_argv', () => JSON.stringify(process.argv));\n" +
        "};\n");
    handle = await loadIsolatedPlugin(SLUG, entry);
});
after(() => {
    unloadIsolatedPlugin(SLUG);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

test('the spawned command line carries no frame nonce', () => {
    const child = handle && handle.worker && handle.worker._child;
    assert.ok(child && Array.isArray(child.spawnargs), 'the launched child is reachable');
    const argv = child.spawnargs.join('\n');
    assert.ok(!/frameNonce/.test(argv), 'the cfg blob on the command line has no nonce field');
    const cfgArg = child.spawnargs.find((a: string) => a.startsWith('{') && a.includes('"slug"'));
    assert.ok(cfgArg, 'the cfg blob is still passed');
    assert.strictEqual(JSON.parse(cfgArg).frameNonce, undefined);
});

test('the plugin still loads and its frames are accepted (the nonce arrived over the channel)', async () => {
    const seen = await hooks.applyFilters('test_ipc_nonce_argv', '');
    assert.ok(typeof seen === 'string' && seen.startsWith('['), 'the filter registered and ran inside the isolate');
    assert.ok(!/frameNonce/.test(seen), 'plugin code sees no nonce in process.argv');
});

test('the worker waits for the nonce before loading plugin code and never reads it from argv', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'plugin-worker.js'), 'utf8');
    assert.ok(!/cfg\.frameNonce/.test(src), 'the worker no longer takes the nonce from the cfg blob');
    assert.match(src, /await nonceReady;[\s\S]{0,200}try \{[\s\S]{0,2000}require\(entryFile\)/);
});
