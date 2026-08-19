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

// ── THE FILESYSTEM GRANT MUST SURVIVE THE PROCESS BOUNDARY ──────────────────────────────────────────
//
// The runtime capability gate (io-guard.fsCapabilityRevoked) asks plugin-permissions whether the
// operator granted `filesystem`. That grant map is populated ONLY on the host — loadGrants() reads the
// `plugin_grants` option and the child has no database — so inside an isolate every reader of it got an
// empty map, i.e. "not granted", and the gate denied a granted plugin its OWN data directory. Since
// in-process plugins were retired, the child is where every real plugin runs: the gate was inert in the
// tests (all host-side) and a total denial in production.
//
// This exercises the gate IN THE PROCESS WHERE A PLUGIN ACTUALLY LIVES, and pins BOTH halves in one
// place so a future widening cannot trade one for the other:
//   · GRANTED  ⇒ the plugin CAN write+read its own data dir, and CAN write a shared write-zone…
//   · …but STILL CANNOT write the PUBLISHED surface of its own dir (public/ is served over HTTP), and
//     still cannot write outside every write zone. A grant is not a skeleton key.
//   · REVOKED (+ the respawn that POST /plugins/:slug/permissions performs) ⇒ the own dir is denied
//     again, which is the closure the runtime gate was introduced for.
const FSSLUG = 'test-isolate-fsgrant';
const fsDir = path.join(path.resolve(__dirname, '../../plugins'), FSSLUG);
const fsEntry = path.join(fsDir, 'index.js');
const ROOT = path.resolve(__dirname, '../../');
const sharedProbe = path.join(ROOT, 'os-tmp', 'wjs-fsgate-probe.txt');
const outsideProbe = path.join(ROOT, 'src', 'wjs-fsgate-probe.txt');

test('an isolate CAN write its own data dir when filesystem is granted — and still cannot write the published surface', async () => {
    const perms = require('../core/plugin-permissions');
    fs.mkdirSync(fsDir, { recursive: true });
    fs.writeFileSync(path.join(fsDir, 'manifest.json'), JSON.stringify({
        name: FSSLUG, isolated: true,
        permissions: [{ scope: 'filesystem', access: 'read' }, { scope: 'filesystem', access: 'write' }],
    }));
    // The published dir is created HERE, by unsandboxed host code. Without it the child's write to
    // public/leak.css would fail with ENOENT and the assertion below would pass for the wrong reason —
    // green whatever the published-surface rule says. A negative assertion has to name the refusal it
    // expects, or it is not testing anything (verified: dropping public/ from PLUGIN_PUBLISHED_SUBDIRS
    // left the earlier, weaker form of this test green).
    fs.mkdirSync(path.join(fsDir, 'public'), { recursive: true });
    // Every probe runs INSIDE the child, through the plugin-facing require('fs') proxy.
    fs.writeFileSync(fsEntry,
        "exports.init = function (wordjs) {\n" +
        "  wordjs.http.route('get', '/fscheck', async (req, res) => {\n" +
        "    const nfs = require('fs');\n" +
        "    const npath = require('path');\n" +
        "    const own = __dirname;\n" +
        "    const root = npath.resolve(__dirname, '..', '..');\n" +
        "    const attempt = (fn) => { try { fn(); return { ok: true, err: null }; } catch (e) { return { ok: false, err: String((e && e.message) || e).slice(0, 160) }; } };\n" +
        "    const attemptAsync = async (fn) => { try { await fn(); return { ok: true, err: null }; } catch (e) { return { ok: false, err: String((e && e.message) || e).slice(0, 160) }; } };\n" +
        "    res.status(200).json({\n" +
        "      ownData: attempt(() => { nfs.mkdirSync(npath.join(own, 'data'), { recursive: true }); nfs.writeFileSync(npath.join(own, 'data', 'probe.txt'), 'x'); }),\n" +
        "      ownRead: attempt(() => nfs.readFileSync(npath.join(own, 'data', 'probe.txt'), 'utf8')),\n" +
        "      published: attempt(() => nfs.writeFileSync(npath.join(own, 'public', 'leak.css'), 'body{}')),\n" +
        "      sharedZone: attempt(() => { nfs.mkdirSync(npath.join(root, 'os-tmp'), { recursive: true }); nfs.writeFileSync(npath.join(root, 'os-tmp', 'wjs-fsgate-probe.txt'), 'x'); }),\n" +
        "      outsideZone: attempt(() => nfs.writeFileSync(npath.join(root, 'src', 'wjs-fsgate-probe.txt'), 'x')),\n" +
        // fs.promises is the SECOND guarded surface, with its own proxy in secure-require. It reads
        // the capability through the same guardFsCall, so this is where the two copies would show up
        // disagreeing about where the grant lives.
        "      ownDataPromise: await attemptAsync(() => nfs.promises.writeFile(npath.join(own, 'data', 'probe2.txt'), 'x')),\n" +
        "    });\n" +
        "  });\n" +
        "};\n");

    // A refusal only counts if it is the sandbox refusing. ENOENT/EPERM from the OS would otherwise
    // stand in for a security rule that had been deleted.
    const refusedBySandbox = (probe: any) =>
        probe && probe.ok === false && /SECURITY BLOCK|not permitted|Permission denied|plugin cannot access/i.test(String(probe.err));
    const before = perms.getGrants(FSSLUG);
    try {
        // The ADMIN grants it (host-side, no plugin context) — exactly what /admin/plugins does.
        perms._setGrantsInMemory(FSSLUG, ['filesystem:read', 'filesystem:write']);
        await loadIsolatedPlugin(FSSLUG, fsEntry);

        const r = await request(app).get(`/api/v1/plugin/${FSSLUG}/fscheck`);
        assert.strictEqual(r.status, 200);
        // The regression: a granted plugin was denied its own private storage inside the isolate.
        assert.strictEqual(r.body.ownData.ok, true, `granted plugin must write its own data dir, got: ${r.body.ownData.err}`);
        assert.strictEqual(r.body.ownRead.ok, true, `granted plugin must read its own data dir, got: ${r.body.ownRead.err}`);
        assert.strictEqual(r.body.ownDataPromise.ok, true, `the fs.promises surface must honour the same grant, got: ${r.body.ownDataPromise.err}`);
        // …and the surface the host publishes over HTTP stays READ-ONLY even so (#3).
        assert.ok(refusedBySandbox(r.body.published), `a granted plugin must be REFUSED writing its PUBLISHED public/ dir, got: ${JSON.stringify(r.body.published)}`);
        // The other reader of the same grant (secure-require's outside-the-own-dir branch) must agree.
        assert.strictEqual(r.body.sharedZone.ok, true, `granted plugin must write a shared write-zone, got: ${r.body.sharedZone.err}`);
        // A grant is not a skeleton key: zones that are not write zones stay closed.
        assert.ok(refusedBySandbox(r.body.outsideZone), `a granted plugin must be REFUSED writing outside every write zone, got: ${JSON.stringify(r.body.outsideZone)}`);

        // REVOKE + respawn (what POST /plugins/:slug/permissions does): the denial must come back, or the
        // admin's switch is inert for exactly the plugins the gate exists to control.
        perms._setGrantsInMemory(FSSLUG, []);
        await reloadIsolatedPlugin(FSSLUG);
        const r2 = await request(app).get(`/api/v1/plugin/${FSSLUG}/fscheck`);
        assert.strictEqual(r2.status, 200);
        assert.ok(refusedBySandbox(r2.body.ownData), `a DECLARED-but-REVOKED filesystem:write must be REFUSED in the own dir, got: ${JSON.stringify(r2.body.ownData)}`);
        assert.ok(refusedBySandbox(r2.body.sharedZone), `a revoked filesystem:write must be REFUSED in the shared write zones too, got: ${JSON.stringify(r2.body.sharedZone)}`);
        assert.ok(refusedBySandbox(r2.body.ownDataPromise), `the fs.promises surface must be REFUSED too when revoked, got: ${JSON.stringify(r2.body.ownDataPromise)}`);
    } finally {
        try { unloadIsolatedPlugin(FSSLUG); } catch { /* */ }
        try { perms._setGrantsInMemory(FSSLUG, before); } catch { /* */ }
        try { fs.rmSync(fsDir, { recursive: true, force: true }); } catch { /* */ }
        try { fs.rmSync(sharedProbe, { force: true }); } catch { /* */ }
        try { fs.rmSync(outsideProbe, { force: true }); } catch { /* */ }
    }
});
