/**
 * WordJS — a loadIsolatedPlugin that REJECTS must leave nothing behind. Real child processes.
 *
 * THE BUG. `isolates.set(slug, …)` runs at the end of loadIsolatedPlugin's Promise executor —
 * synchronously, before the child has said anything — and the message handler starts wiring whatever
 * the child registers (hooks, routes, shortcodes, the system mail sender) from its first message. The
 * failure branches then rejected WITHOUT undoing any of it, and plugin-worker.js does not exit after
 * an 'init-error' either: it sends the message and keeps running. So a plugin whose init() threw left
 * a LIVE, REGISTERED, hook-applying child behind while POST /plugins/:slug/activate returned 500 and
 * `active_plugins` stayed clean — a state the admin could not clear, because deactivatePlugin
 * early-returns 'Plugin not active' for exactly it.
 *
 * WHY THE FIX IS IN THIS MODULE AND NOT AT THE CALL SITE. Any cleanup a caller writes around its
 * `await loadIsolatedPlugin(...)` starts one line AFTER the await, so it structurally cannot see this:
 * the throw comes out of the await itself, and the caller has no handle on the child to clean up with.
 * It would also have to be written again at every call site — activatePlugin, loadActivePlugins,
 * loadOnePlugin, superviseRestart, reloadIsolatedPlugin and the dev watcher. The module that OWNS the
 * child is the only place the guarantee can be made once, so failLoad makes it there.
 *
 * THIS FILE SPAWNS REAL CHILDREN on purpose. A registry fake cannot show the leak — the whole point is
 * that a process stays alive and keeps applying a filter to host content — so the assertions are: the
 * registry is clean, the PID is gone, the filter no longer applies, and the route 404s.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

require('../config/app'); // preload (trusted context)
const express = require('express');
const request = require('supertest');
const isolate = require('../core/plugin-isolate');
const { loadIsolatedPlugin, unloadIsolatedPlugin, isIsolated, getLivePids, getIsolateStatus } = isolate;
const { setApp } = require('../core/appRegistry');
const hooks = require('../core/hooks');

const SLUG = 'test-isolate-failing-init';
const PLUGINS_DIR = path.resolve(__dirname, '../../plugins');
const dir = path.join(PLUGINS_DIR, SLUG);
const entry = path.join(dir, 'index.js');

const app = express();
app.use(express.json());

/**
 * An entry that REGISTERS FIRST and THEN throws. The order matters: IPC preserves it, so the host has
 * installed the hook shim and mounted the route by the time 'init-error' arrives. That is the leak.
 */
const FAILING_ENTRY =
    "exports.init = function (wordjs) {\n" +
    "  wordjs.hooks.addFilter('leaky_iso_filter', (v) => '[leaked]' + v);\n" +
    "  wordjs.http.route('get', '/leak', (req, res) => res.status(200).json({ alive: true }));\n" +
    "  throw new Error('boom: this plugin cannot initialise');\n" +
    "};\n";

/** A healthy entry, to prove the slug is reusable after a failed load left nothing behind. */
const GOOD_ENTRY =
    "exports.init = function (wordjs) {\n" +
    "  wordjs.hooks.addFilter('leaky_iso_filter', (v) => '[ok]' + v);\n" +
    "};\n";

/**
 * An entry whose init() REGISTERS and then never returns. plugin-worker.js `await`s init(), so it
 * never sends 'ready' NOR 'init-error' and the child does not exit — the one failure mode neither the
 * message handler nor the exit handler can see. Idle (no CPU spin), so the only thing under test is
 * the deadline. Also the fixture for the mid-load unload below: the load stays UNSETTLED while the
 * isolate is already registered, which is exactly the window `stopping` used to leak in.
 */
const HANGING_ENTRY =
    "exports.init = function (wordjs) {\n" +
    "  wordjs.hooks.addFilter('leaky_iso_filter', (v) => '[hung]' + v);\n" +
    "  return new Promise(function () { /* never settles */ });\n" +
    "};\n";

function writePlugin(source: string) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, isolated: true, permissions: [] }));
    fs.writeFileSync(entry, source);
}

/** Poll until every pid we spawned for the slug has been observed to exit (or give up). */
async function pidsGone(timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (getLivePids(SLUG).length === 0) return true;
        await new Promise((r) => setTimeout(r, 25));
    }
    return false;
}

/** Poll until the isolate for the slug is REGISTERED (the load promise may still be unsettled). */
async function registered(timeoutMs = 15000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (isIsolated(SLUG)) return true;
        await new Promise((r) => setTimeout(r, 10));
    }
    return false;
}

before(() => {
    setApp(app); // host owns Express; isolated routes mount here
});

after(() => {
    try { unloadIsolatedPlugin(SLUG); } catch { /* */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

test('a plugin whose init() throws leaves NO registered isolate, NO live process and NO host wiring', async () => {
    writePlugin(FAILING_ENTRY);

    await assert.rejects(() => loadIsolatedPlugin(SLUG, entry), /boom: this plugin cannot initialise/,
        'the load reports the plugin failure to the caller (this part always worked)');

    // 1. THE REGISTRY. Before the fix this was `true`: the handle set at the end of the executor was
    //    never removed, so isIsolated() reported a running plugin for one that had just failed to start.
    assert.strictEqual(isIsolated(SLUG), false, 'no isolate is registered for a load that rejected');

    // 2. THE PROCESS. plugin-worker.js does NOT exit after sending 'init-error', so nothing but an
    //    explicit terminate ends it — the child would otherwise sit there, unsupervised, forever.
    assert.ok(await pidsGone(), `every child spawned for '${SLUG}' has exited (still alive: ${getLivePids(SLUG).join(', ')})`);

    // 3. THE HOST WIRING. The filter was registered before init() threw, so this is what a "failed"
    //    activation was still doing to real content: '[leaked]hello'.
    assert.strictEqual(await hooks.applyFilters('leaky_iso_filter', 'hello'), 'hello',
        'the hook shim the child installed before throwing was torn down');

    const r = await request(app).get(`/api/v1/plugin/${SLUG}/leak`);
    assert.strictEqual(r.status, 404, 'and its route is unmounted (not a 502 into a dead child, nor a 200 from a live one)');

    // 4. And the health surface says stopped — not 'running', which is what it reported before.
    const status = getIsolateStatus(SLUG);
    assert.strictEqual(status && status.state, 'stopped', 'health reflects a plugin that is not running');
});

test('the failed load did not arm a supervised restart', async () => {
    // A failed INITIAL load must not enter the crash-supervisor: the entry file is broken, so a backoff
    // restart just re-spawns it up to five times and ends in a "keeps crashing" admin notice for a
    // plugin that was never running. Wait past the first backoff step (1s) and re-check.
    await new Promise((r) => setTimeout(r, 1400));

    assert.strictEqual(isIsolated(SLUG), false, 'nothing came back up on its own');
    assert.deepStrictEqual(getLivePids(SLUG), [], 'and no new child was spawned');
    assert.strictEqual(await hooks.applyFilters('leaky_iso_filter', 'hello'), 'hello', 'nor re-wired');
});

test('the slug is fully reusable afterwards — a fixed plugin loads and works', async () => {
    // The other half of "nothing left behind": no stale registry entry, `stopping` mark or restart timer
    // may make the NEXT load of this slug behave differently.
    writePlugin(GOOD_ENTRY);

    await loadIsolatedPlugin(SLUG, entry);

    assert.strictEqual(isIsolated(SLUG), true);
    assert.strictEqual(await hooks.applyFilters('leaky_iso_filter', 'hello'), '[ok]hello',
        'the repaired plugin applies its filter — the previous failure left no residue');

    unloadIsolatedPlugin(SLUG);
    assert.ok(await pidsGone(), 'and it stops cleanly');
    assert.strictEqual(await hooks.applyFilters('leaky_iso_filter', 'hello'), 'hello');
});

test('unloadIsolatedPlugin marks an intentional stop ONLY when a child exit will consume it', async () => {
    // `stopping` is read by a child's 'exit' handler and deleted there — it is how an unload tells the
    // supervisor "this death was on purpose, do not restart it". Marking a slug that has NO registered
    // child therefore leaves an entry nothing will ever consume, and the unload is unconditional on the
    // DELETE path (it has to be, to cancel a pending supervised restart), so the set grew without bound
    // and each stale mark silences the crash supervisor for the next child of that slug.
    const NEVER_LOADED = 'test-isolate-never-loaded';
    unloadIsolatedPlugin(NEVER_LOADED);
    assert.strictEqual(isolate.__stopIntentMarked(NEVER_LOADED), false,
        'nothing was registered, so no stop intent is recorded');

    // Idempotent on a slug that HAS been loaded and is already gone — the DELETE path's second call.
    unloadIsolatedPlugin(SLUG);
    assert.strictEqual(isolate.__stopIntentMarked(SLUG), false, 'and none is left behind by a repeat unload');

    // Positive control: a real child IS marked, and the mark is consumed by its exit.
    writePlugin(GOOD_ENTRY);
    await loadIsolatedPlugin(SLUG, entry);
    unloadIsolatedPlugin(SLUG);
    assert.strictEqual(isolate.__stopIntentMarked(SLUG), true, 'a real stop is marked so it is not supervised as a crash');
    assert.ok(await pidsGone(), 'the child exits');
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(isolate.__stopIntentMarked(SLUG), false, 'and its exit consumes the mark — nothing accumulates');
});

test('an init() that never returns FAILS the load on a deadline instead of hanging forever', async () => {
    // THE HOLE THE OTHER BRANCHES LEAVE. loadIsolatedPlugin settles on 'ready', 'init-error', 'fatal', a
    // spawn 'error' or an early 'exit'. An init() that simply never returns sends none of those and the
    // child stays alive, so the load promise NEVER settled: the activate request hung with no reply, and
    // at boot loadActivePlugins — which awaits each plugin in turn — never reached the next plugin.
    writePlugin(HANGING_ENTRY);

    // Per-load override: the shipped default is 60s (a legitimate init() may migrate a cold schema), and
    // lowering it globally for this file would make every HEALTHY fixture here race a 2.5s fork+sandbox
    // boot — which is exactly how it flaked when the whole suite ran its files in parallel.
    const started = Date.now();
    await assert.rejects(() => loadIsolatedPlugin(SLUG, entry, { readyTimeoutMs: 2500 }), /did not become ready within/,
        'the load fails on the deadline (before the fix this promise never settled at all)');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2000, `it waited for the deadline rather than failing early (${elapsed}ms)`);

    // And it is a failLoad, so it clears up exactly like every other failure — not a bare timeout.
    assert.strictEqual(isIsolated(SLUG), false, 'no isolate is left registered');
    assert.ok(await pidsGone(), 'the hung child was killed');
    assert.strictEqual(await hooks.applyFilters('leaky_iso_filter', 'hello'), 'hello',
        'and the filter it registered before hanging was torn down');
});

test('an unload that lands MID-LOAD does not strand the intentional-stop mark', async () => {
    // `isolates.set()` runs at the END of loadIsolatedPlugin's executor, while the load stays unsettled
    // until the child sends 'ready' — so there is a window where the slug is REGISTERED and the load is
    // still pending. unloadIsolatedPlugin only needs the registration, so an unload in that window (the
    // DELETE path, a cross-node deactivate) marked `stopping`, killed the child, and the exit handler
    // then took the "load never settled" early return — which sat ABOVE the line that consumes the mark.
    //
    // The mark is read by exactly one place, that handler, so a mark not consumed there is never
    // consumed at all: it outlives the child forever and the NEXT child for this slug has its first
    // crash silently classified as an intentional stop — no 'crashed' health state, no supervised
    // restart. Deleting the `stopping.delete(slug)` that now runs before the early return makes this red.
    writePlugin(HANGING_ENTRY);

    const pending = loadIsolatedPlugin(SLUG, entry);
    pending.catch(() => { /* asserted below; attached now so the rejection is never unhandled */ });

    assert.ok(await registered(), 'the isolate registers while the load is still pending (the window)');
    assert.strictEqual(isolate.__stopIntentMarked(SLUG), false, 'nothing is marked yet');

    unloadIsolatedPlugin(SLUG); // lands inside the window
    assert.strictEqual(isolate.__stopIntentMarked(SLUG), true, 'the unload marks the stop as intentional');

    await assert.rejects(() => pending, 'and the pending load is failed rather than left hanging');
    assert.ok(await pidsGone(), 'the child exits');
    await new Promise((r) => setTimeout(r, 100)); // let the exit handler run

    assert.strictEqual(isolate.__stopIntentMarked(SLUG), false,
        'its exit consumed the mark — the next child of this slug is supervised normally');
});

test('a plugin whose entry file does not exist leaves nothing behind either', async () => {
    // The same failure branch reached before any user code runs (the child's require throws): it must
    // clear up identically, so the guarantee is about the FUNCTION, not about one plugin's init().
    const missing = path.join(dir, 'does-not-exist.js');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, isolated: true, permissions: [] }));

    await assert.rejects(() => loadIsolatedPlugin(SLUG, missing));

    assert.strictEqual(isIsolated(SLUG), false, 'no isolate registered');
    assert.ok(await pidsGone(), 'and no child left running');
});
