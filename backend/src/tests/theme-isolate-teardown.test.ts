/**
 * WordJS — switching themes must not leave the OLD theme's process running. Real child processes.
 *
 * THE BUG. A theme's functions.js runs in a child process registered under `theme:<slug>`; every hook,
 * filter, shortcode and route it declares becomes a HOST-side shim that RPCs back into that child, and
 * the shims live until the isolate is unloaded. theme-engine.init() assigns `this.activeTheme` to the
 * INCOMING theme and only THEN calls loadThemeLogic(), which read the slug back off `this.activeTheme` —
 * so `if (isIsolated('theme:' + slug)) unload(...)` computed the slug of the theme it was about to LOAD.
 * On a switch from A to B that expression is `theme:B`: the only thing it could ever retire was a stale
 * worker for B, and `theme:A` was unloaded by nobody. The comment on that line said "theme switch: tear
 * down the old worker first", which is the intent, not what the code did.
 *
 * THE OBSERVABLE SYMPTOM. After an admin switched the site away from a theme, that theme's process was
 * still alive and still registered: its filters kept mutating every page the site rendered and its
 * shortcodes kept expanding, layered UNDER the new theme's. Nothing in the admin UI showed it, and only
 * a server restart cleared it. Two entry points reach it — themes.switchTheme() (the admin action) and
 * theme-engine.render(), which re-inits LAZILY when it notices the `template` option changed underneath
 * it — so it also happened on a plain page request after another node/plugin wrote the option.
 *
 * THIS FILE SPAWNS REAL CHILDREN on purpose. A registry fake cannot show this: the whole point is that a
 * PROCESS outlives the switch and keeps applying filters to host content. So the assertions are the same
 * ones plugin-isolate-failed-load.test.ts makes — the registry is clean, the pid is gone, the filter no
 * longer applies, the shortcode no longer expands — plus the ones specific to a switch: the plugin
 * isolates must survive it untouched, and a REFUSED switch must not retire the theme it failed to replace.
 *
 * Each fixture theme registers the SAME filter name with a different marker, so a leaked isolate is not
 * merely "still registered" — it visibly corrupts the output ('[b][a]x' instead of '[b]x').
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// core/theme-engine and core/themes resolve THEMES_DIR as `path.resolve('./themes')` — CWD-relative —
// while the isolate layer resolves a `theme:<slug>` child's own directory from backend/ (plugin-api's
// ROOT_DIR). Pin the CWD to backend/ before requiring either so the two agree exactly as in production.
const BACKEND_ROOT = path.resolve(__dirname, '../..');
process.chdir(BACKEND_ROOT);

require('../config/app'); // preload (trusted context)
const config = require('../config/app');
config.dbPath = path.join(os.tmpdir(), `wordjs-theme-iso-${process.pid}.db`);
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const express = require('express');
const hooks = require('../core/hooks');
const { doShortcodeAsync } = require('../core/shortcodes');
const { setApp } = require('../core/appRegistry');
const isolate = require('../core/plugin-isolate');
const { loadIsolatedPlugin, unloadIsolatedPlugin, isIsolated, listIsolates, getLivePids, getIsolateStatus } = isolate;

const THEMES_DIR = path.join(BACKEND_ROOT, 'themes');
const PLUGINS_DIR = path.join(BACKEND_ROOT, 'plugins');

// Fixture slugs. Prefixed so they can never collide with a real installed theme, and so the `after()`
// cleanup can delete EXACTLY its own directories out of a themes/ dir that holds the operator's themes.
const A = 'zz-test-theme-a';
const B = 'zz-test-theme-b';
const C = 'zz-test-theme-c';
const NO_LOGIC = 'zz-test-theme-nologic';
const BLOCKED = 'zz-test-theme-blocked';
const CRASHER = 'zz-test-theme-crasher';
const FIXTURE_THEMES = [A, B, C, NO_LOGIC, BLOCKED, CRASHER];
const BYSTANDER = 'zz-test-theme-switch-bystander'; // a PLUGIN isolate, must survive every theme switch
// A second PLUGIN fixture, loaded/unloaded freely by the same-slug tests at the bottom — BYSTANDER is
// asserted to be untouched by tests in between, so it must not be used as a scratch isolate.
const PLUGIN_DUP = 'zz-test-plugin-dup';
const FIXTURE_PLUGINS = [BYSTANDER, PLUGIN_DUP];

const iso = (slug: string) => `theme:${slug}`;

const app = express();
app.use(express.json());

/**
 * A theme functions.js in the real bundled-theme shape (`module.exports = (wordjs) => {…}`, which is
 * what backend/themes/default/functions.js uses and what plugin-worker.js calls for a bare function).
 * All fixtures claim the SAME filter name so a survivor shows up in the OUTPUT, not just in a registry.
 */
function themeSource(marker: string) {
    return "module.exports = (wordjs) => {\n" +
        `  wordjs.hooks.addFilter('zz_theme_marker', (v) => '[${marker}]' + v);\n` +
        `  wordjs.shortcodes.add('sc_zz_${marker}', async () => '<i>${marker}</i>');\n` +
        "};\n";
}

function writeTheme(slug: string, functionsJs: string | null) {
    const dir = path.join(THEMES_DIR, slug);
    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ name: slug, version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, 'style.css'), ':root { --wjs-color-primary: #123456; }\n');
    fs.writeFileSync(path.join(dir, 'templates', 'index.html'), '<p>{{siteTitle}}</p>\n');
    if (functionsJs !== null) fs.writeFileSync(path.join(dir, 'functions.js'), functionsJs);
    return dir;
}

/** Poll until every child we spawned for a slug has been observed to exit (or give up). */
async function pidsGone(slug: string, timeoutMs = 8000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (getLivePids(slug).length === 0) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** Poll until exactly `n` children are alive for a slug (a restart is transiently two). */
async function livePidCount(slug: string, n: number, timeoutMs = 8000): Promise<number[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const pids = getLivePids(slug);
        if (pids.length === n || Date.now() >= deadline) return pids;
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** Every THEME isolate currently registered — the set this fix is about, plugins excluded. */
const themeIsolates = (): string[] => listIsolates().filter((s: string) => s.startsWith('theme:')).sort();

const marker = () => hooks.applyFilters('zz_theme_marker', 'x');

/**
 * Point the site at a theme and re-init the engine — byte for byte what themes.switchTheme() does
 * (`updateOption('template', slug)` then `themeEngine.init()`), minus the scanThemes/doAction bookkeeping
 * that is irrelevant here. Using the option + the real init() rather than calling loadThemeLogic()
 * directly is deliberate: the bug lived in the ORDER init() does its two steps in.
 */
async function switchTo(slug: string) {
    const { updateOption } = require('../core/options');
    await updateOption('template', slug);
    await require('../core/theme-engine').init();
}

before(async () => {
    setApp(app); // host owns Express; isolated routes mount here (and are spliced out on teardown)
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();

    writeTheme(A, themeSource('a'));
    writeTheme(B, themeSource('b'));
    writeTheme(C, themeSource('c'));
    writeTheme(NO_LOGIC, null); // a perfectly legitimate theme that simply has no functions.js
    // Blocked by the AST pre-scan in loadThemeLogic (require('child_process') is a dangerous call), so
    // it reaches the pre-scan's `return` — one of the two early exits that must still retire the outgoing.
    writeTheme(BLOCKED, "module.exports = () => { require('child_process').execSync('echo pwned'); };\n");
    // Registers, then dies at runtime ON DEMAND → the host supervisor ARMS a backoff restart for it. That
    // restart is the second way a retired theme comes back (see the crash test at the bottom).
    //
    // The crash is TRIGGERED BY THE HOST (applying `zz_theme_crash_now`), not scheduled on a wall clock.
    // It used to be a `setTimeout(..., 2500)` racing the supervisor's 1s backoff and the test's 3s/8s
    // windows — green, but tuned to timings rather than robust to them, and it had already produced one
    // false pass. Now the test crashes the child at the exact instant it is ready to observe the crash,
    // and every wait after that polls for the STATE it needs instead of sleeping a guessed interval.
    // The filter returns normally so the RPC reply is sent first; the throw lands on the next tick, as an
    // uncaught exception with no plugin frame to catch it — the child dies exactly as a real crash.
    writeTheme(CRASHER,
        "module.exports = (wordjs) => {\n" +
        "  wordjs.hooks.addFilter('zz_theme_marker', (v) => '[crash]' + v);\n" +
        "  wordjs.hooks.addFilter('zz_theme_crash_now', (v) => {\n" +
        "    setTimeout(() => { throw new Error('theme crasher: deliberate runtime crash'); }, 0);\n" +
        "    return v;\n" +
        "  });\n" +
        "};\n");

    // A PLUGIN isolate that must be completely unaffected by every theme switch below.
    const bdir = path.join(PLUGINS_DIR, BYSTANDER);
    fs.mkdirSync(bdir, { recursive: true });
    fs.writeFileSync(path.join(bdir, 'manifest.json'), JSON.stringify({ name: BYSTANDER, isolated: true, permissions: [] }));
    fs.writeFileSync(path.join(bdir, 'index.js'),
        "exports.init = function (wordjs) {\n" +
        "  wordjs.hooks.addFilter('zz_bystander_filter', (v) => '[plugin]' + v);\n" +
        "};\n");

    // The same-slug orphan is an ISOLATE-layer bug, not a theme one: `isolates` is keyed by slug and a
    // plugin slug overwrites exactly the same way. This fixture proves the guard is not theme-only.
    const ddir = path.join(PLUGINS_DIR, PLUGIN_DUP);
    fs.mkdirSync(ddir, { recursive: true });
    fs.writeFileSync(path.join(ddir, 'manifest.json'), JSON.stringify({ name: PLUGIN_DUP, isolated: true, permissions: [] }));
    fs.writeFileSync(path.join(ddir, 'index.js'),
        "exports.init = function (wordjs) {\n" +
        "  wordjs.hooks.addFilter('zz_dup_filter', (v) => '[dup]' + v);\n" +
        "};\n");
});

after(async () => {
    for (const slug of FIXTURE_THEMES) { try { unloadIsolatedPlugin(iso(slug)); } catch { /* */ } }
    for (const slug of FIXTURE_PLUGINS) { try { unloadIsolatedPlugin(slug); } catch { /* */ } }
    // Delete ONLY our own fixtures — themes/ and plugins/ hold the operator's real installs.
    for (const slug of FIXTURE_THEMES) { try { fs.rmSync(path.join(THEMES_DIR, slug), { recursive: true, force: true }); } catch { /* */ } }
    for (const slug of FIXTURE_PLUGINS) { try { fs.rmSync(path.join(PLUGINS_DIR, slug), { recursive: true, force: true }); } catch { /* */ } }
    try { await database.closeDatabase(); } catch { /* */ }
    try { fs.rmSync(config.dbPath, { force: true }); } catch { /* */ }
});

// ---------------------------------------------------------------------------------------------------
// THE BUG.
// ---------------------------------------------------------------------------------------------------

test('switching theme A -> B leaves NO theme:A isolate, NO live A process and NO A wiring', async () => {
    await switchTo(A);
    assert.strictEqual(isIsolated(iso(A)), true, 'precondition: theme A is loaded as an isolate');
    assert.strictEqual(await marker(), '[a]x', 'precondition: A\'s filter applies');
    assert.strictEqual(await doShortcodeAsync('[sc_zz_a]'), '<i>a</i>', 'precondition: A\'s shortcode expands');
    const aPids = getLivePids(iso(A));
    assert.strictEqual(aPids.length, 1, 'precondition: exactly one child process for theme A');

    await switchTo(B);

    // 1. THE REGISTRY. Before the fix this was `true`: nothing ever unloaded the OUTGOING slug, because
    //    loadThemeLogic derived the slug from this.activeTheme, which init() had already moved to B.
    assert.strictEqual(isIsolated(iso(A)), false, 'the outgoing theme has no registered isolate');
    assert.strictEqual(isIsolated(iso(B)), true, 'and the incoming theme is loaded');
    assert.deepStrictEqual(themeIsolates(), [iso(B)], 'exactly ONE theme isolate exists after a switch');

    // 2. THE PROCESS. The orphan is what made this more than bookkeeping: a live child holding the old
    //    theme's hooks/shortcodes/routes, unreachable from the admin UI and surviving until a restart.
    assert.ok(await pidsGone(iso(A)), `no child spawned for theme A is still alive (alive: ${getLivePids(iso(A)).join(', ')})`);

    // 3. THE HOST WIRING. This is what the leak did to real rendered content: both themes' filters ran.
    assert.strictEqual(await marker(), '[b]x', "only the ACTIVE theme's filter applies (a leak shows as '[b][a]x')");
    assert.strictEqual(await doShortcodeAsync('[sc_zz_a]'), '[sc_zz_a]', "the old theme's shortcode no longer expands");
    assert.strictEqual(await doShortcodeAsync('[sc_zz_b]'), '<i>b</i>', "and the new theme's does");
});

test('re-initialising the SAME theme still restarts it cleanly (the stale-worker case the old check handled)', async () => {
    // The old code's one correct behaviour: a re-init of the CURRENT theme retires its existing worker
    // and starts a fresh one. The namespace sweep includes the incoming slug precisely so this still
    // holds — losing it would mean a double-registered filter ('[b][b]x') or a second child.
    const before = getLivePids(iso(B));
    assert.strictEqual(before.length, 1, 'precondition: one child for theme B');

    await switchTo(B);

    assert.strictEqual(isIsolated(iso(B)), true, 'the theme is still loaded after re-init');
    const after = await livePidCount(iso(B), 1);
    assert.strictEqual(after.length, 1, `exactly one child survives the re-init (got: ${after.join(', ')})`);
    assert.notStrictEqual(after[0], before[0], 'and it is a NEW child — the stale worker was retired, not left running');
    assert.strictEqual(await marker(), '[b]x', 'the filter is registered exactly once, not twice');
});

test('a PLUGIN isolate is untouched by a theme switch', async () => {
    // Themes and plugins share one registry, so the sweep is namespace-scoped. If it were not, switching
    // themes would silently deactivate every isolated plugin on the site.
    await loadIsolatedPlugin(BYSTANDER, path.join(PLUGINS_DIR, BYSTANDER, 'index.js'));
    assert.strictEqual(await hooks.applyFilters('zz_bystander_filter', 'x'), '[plugin]x');
    const pluginPids = getLivePids(BYSTANDER);
    assert.strictEqual(pluginPids.length, 1, 'precondition: the plugin has one child');

    await switchTo(A); // B -> A, with a plugin isolate loaded

    assert.strictEqual(isIsolated(BYSTANDER), true, 'the plugin isolate is still registered');
    assert.deepStrictEqual(getLivePids(BYSTANDER), pluginPids, 'its child was neither killed nor restarted');
    assert.strictEqual(await hooks.applyFilters('zz_bystander_filter', 'x'), '[plugin]x', 'and its filter still applies');
    assert.deepStrictEqual(themeIsolates(), [iso(A)], 'while the theme namespace still converged to one');
});

// ---------------------------------------------------------------------------------------------------
// The early-return paths INSIDE loadThemeLogic: the incoming theme ends up with no isolate of its own,
// but the switch has already happened, so the outgoing child must go anyway.
// ---------------------------------------------------------------------------------------------------

test('switching to a theme with NO functions.js still retires the outgoing theme child', async () => {
    assert.strictEqual(isIsolated(iso(A)), true, 'precondition: theme A is loaded');

    await switchTo(NO_LOGIC);

    // A theme without functions.js legitimately owns no isolate — but that is not a reason to let the
    // PREVIOUS theme keep running. The teardown therefore sits ABOVE the `if (!exists) return`.
    assert.deepStrictEqual(themeIsolates(), [], 'no theme isolate remains at all');
    assert.ok(await pidsGone(iso(A)), 'and no child of the outgoing theme is alive');
    assert.strictEqual(await marker(), 'x', 'no theme filter applies to rendered content');
    assert.strictEqual(isIsolated(BYSTANDER), true, 'the plugin isolate is still untouched');
});

test('a theme BLOCKED by the AST pre-scan retires the outgoing child and registers none of its own', async () => {
    await switchTo(A);
    assert.strictEqual(isIsolated(iso(A)), true, 'precondition: theme A is loaded');

    await switchTo(BLOCKED); // its functions.js require()s child_process → the pre-scan refuses it

    // The site is now on a theme whose logic was refused, so it has no theme logic — which is the
    // correct outcome. Keeping A's child alive instead would serve the OLD theme's hooks under the NEW
    // theme, invisibly, which is strictly worse than none.
    assert.strictEqual(isIsolated(iso(BLOCKED)), false, 'the blocked theme did not load');
    assert.deepStrictEqual(themeIsolates(), [], 'and the outgoing theme was retired all the same');
    assert.ok(await pidsGone(iso(A)), 'no child of the outgoing theme is alive');
    assert.strictEqual(await marker(), 'x', 'no theme filter applies');
});

// ---------------------------------------------------------------------------------------------------
// The early-return paths INSIDE init(): the switch is REFUSED, so nothing may be torn down.
// ---------------------------------------------------------------------------------------------------

test('a REFUSED theme switch does not strand the site with no theme logic', async () => {
    const { updateOption } = require('../core/options');
    const themeEngine = require('../core/theme-engine');

    await switchTo(A);
    const aPids = getLivePids(iso(A));
    assert.strictEqual(aPids.length, 1, 'precondition: theme A is loaded and running');

    // init() refuses each of these BEFORE it assigns this.activeTheme, so loadThemeLogic is never
    // reached and the teardown never runs. Ordering is the whole point: validate first, tear down only
    // once committed to loading — otherwise a typo'd option would kill the working theme's logic and
    // then fail to replace it, leaving the site with nothing.
    for (const bad of ['zz-test-theme-does-not-exist', '../evil', 'a/b', '..']) {
        await updateOption('template', bad);
        await themeEngine.init();

        assert.strictEqual(isIsolated(iso(A)), true, `theme A survives a refused switch to ${JSON.stringify(bad)}`);
        assert.deepStrictEqual(getLivePids(iso(A)), aPids, 'its child was not killed');
        assert.strictEqual(await marker(), '[a]x', 'and it is still doing its job');
        assert.strictEqual(themeEngine.activeTheme.slug, A, 'the engine still points at the working theme');
    }

    await updateOption('template', A); // leave the option consistent with what is actually loaded
});

// ---------------------------------------------------------------------------------------------------
// The second entry point, and the self-healing property.
// ---------------------------------------------------------------------------------------------------

test("render()'s LAZY re-init reaches the same teardown (a switch this process never performed)", async () => {
    const { updateOption } = require('../core/options');
    const themeEngine = require('../core/theme-engine');

    assert.strictEqual(isIsolated(iso(A)), true, 'precondition: theme A is loaded');

    // No init() call: only the option moves, exactly as when another node's admin switched the theme, or
    // a plugin wrote the option. render() notices on the next page and re-inits — so the leak also
    // happened on an ordinary request, not just on an explicit admin action.
    await updateOption('template', C);
    const html = await themeEngine.render('index', {});

    assert.match(html, /<p>/, 'the page rendered from the NEW theme');
    assert.deepStrictEqual(themeIsolates(), [iso(C)], 'and the lazily-replaced theme was retired');
    assert.ok(await pidsGone(iso(A)), 'its child is gone');
    assert.strictEqual(await marker(), '[c]x', 'only the new theme filters the content');
});

test('the sweep CONVERGES from an already-leaked state (several theme isolates at once)', async () => {
    // Every install that ever switched a theme is already in this state, so the fix has to repair it, not
    // just stop producing it. This is also the test that a "remember the previous slug and unload that
    // one" implementation fails: it would retire exactly one of the two survivors below.
    //
    // Scope, precisely: these are REGISTERED leaks — isolates the layer still holds a handle to. A sweep
    // cannot converge from an ORPHAN, which no registry can name; that is prevented at the source instead,
    // and the tests for it are at the bottom of this file.
    await loadIsolatedPlugin(iso(A), path.join(THEMES_DIR, A, 'functions.js'));
    await loadIsolatedPlugin(iso(B), path.join(THEMES_DIR, B, 'functions.js'));
    assert.deepStrictEqual(themeIsolates(), [iso(A), iso(B), iso(C)].sort(), 'precondition: three theme isolates, as a leaked install has');

    await switchTo(B);

    assert.deepStrictEqual(themeIsolates(), [iso(B)], 'one switch collapses the whole namespace to the active theme');
    assert.ok(await pidsGone(iso(A)), 'A\'s child is gone');
    assert.ok(await pidsGone(iso(C)), 'C\'s child is gone');
    assert.strictEqual(await marker(), '[b]x', 'and exactly one theme filter is wired');
});

test('a CRASHED outgoing theme does not come back through its supervised restart', async () => {
    // The other way a retired theme resurrects itself. When a theme child crashes, the host supervisor
    // deletes it from the isolate registry and arms a backoff restart that re-forks the SAME entry file.
    // A sweep that only walked the registry would find nothing to retire and the timer would then bring
    // the OLD theme back — an orphan a second late, which is the original symptom exactly.
    await switchTo(CRASHER);
    assert.strictEqual(isIsolated(iso(CRASHER)), true, 'precondition: the crasher loaded');

    // Crash it ON PURPOSE, now, from the host — no wall-clock race between a fixture's timer and this
    // test's readiness (see the CRASHER fixture).
    await hooks.applyFilters('zz_theme_crash_now', 'go');

    // Then wait for the STATE this test depends on rather than for a duration: the child gone from the
    // registry AND a supervised restart armed. Asserting it makes a supervisor that never armed one a
    // loud failure instead of a test that quietly proves nothing (which is how the timing-tuned version
    // of this test passed once for the wrong reason).
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const st = getIsolateStatus(iso(CRASHER));
        if (!isIsolated(iso(CRASHER)) && st && st.state === 'restarting') break;
        await new Promise((r) => setTimeout(r, 25));
    }
    assert.strictEqual(isIsolated(iso(CRASHER)), false, 'the crasher child died and left the registry');
    assert.strictEqual((getIsolateStatus(iso(CRASHER)) || {}).state, 'restarting',
        'precondition: the supervisor observed the crash and ARMED a restart — without one there is nothing to resurrect and this test proves nothing');

    await switchTo(B);

    // WATCH for the resurrection rather than sampling once. The restart is armed 1s after the crash and
    // the resurrected child would then live for a while — a single check at a fixed offset can miss it
    // (and did), so poll across the whole window in which it could appear and fail on ANY sighting.
    let seen: string | null = null;
    const watchUntil = Date.now() + 3000;
    while (Date.now() < watchUntil) {
        if (isIsolated(iso(CRASHER))) { seen = 'registered as an isolate'; break; }
        if (getLivePids(iso(CRASHER)).length > 0) { seen = `running as pid ${getLivePids(iso(CRASHER)).join(', ')}`; break; }
        await new Promise((r) => setTimeout(r, 25));
    }
    assert.strictEqual(seen, null, `the retired theme must not restart itself (came back ${seen})`);

    assert.deepStrictEqual(themeIsolates(), [iso(B)], 'only the active theme is loaded');
    assert.strictEqual(await marker(), '[b]x', "and the dead theme's filter is not back");
});

// ---------------------------------------------------------------------------------------------------
// THE RESIDUAL LEAK PATHS the namespace sweep alone does NOT close, because they produce a child the
// isolate layer itself has lost the handle to. `isolates` maps a slug to exactly ONE handle, so a second
// load for that slug overwrote the first: the overwritten child was absent from `isolates`, never in
// `restartTimers`, invisible to listIsolates() — and therefore unreachable by unloadIsolatedPlugin, by
// the theme sweep, and by everything else — while still running and still applying every filter and
// shortcode it had registered. The sweep converges from REGISTERED leaks; it cannot converge from an
// orphan nothing can name, so these are fixed at the source, in the isolate layer.
//
// The registry is not the witness in this section: it reports one healthy isolate in exactly the state
// this is about. getLivePids is — it counts children this process spawned and has not seen exit.
// ---------------------------------------------------------------------------------------------------

test('two overlapping loads of the same slug JOIN — one child, and no invisible orphan', async () => {
    await switchTo(NO_LOGIC);
    assert.deepStrictEqual(themeIsolates(), [], 'precondition: no theme isolate is loaded');
    const entry = path.join(THEMES_DIR, A, 'functions.js');

    // Two loads of the same slug, overlapping — an admin double-clicking Activate, or two admins at once.
    // POST /themes/:slug/activate and POST /plugins/:slug/activate both land here with no mutex above.
    const p1 = loadIsolatedPlugin(iso(A), entry);
    const p2 = loadIsolatedPlugin(iso(A), entry);
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.strictEqual(r1, r2, 'the second overlapping load JOINED the first instead of forking a rival child');
    const pids = await livePidCount(iso(A), 1);
    assert.strictEqual(pids.length, 1, `exactly ONE child exists after two overlapping loads (alive: ${pids.join(', ')})`);
    assert.strictEqual(await marker(), '[a]x', "the theme's filter is wired exactly once — a surviving twin renders '[a][a]x'");

    // THE INVARIANT, stated as a behaviour: the map never lost its reference, so one unload really does
    // stop everything this slug is running. Against an orphan this assertion was the one that failed.
    unloadIsolatedPlugin(iso(A));
    assert.ok(await pidsGone(iso(A)), `the surviving child is REACHABLE — one unload leaves no process behind (alive: ${getLivePids(iso(A)).join(', ')})`);
});

test('loading a slug that is ALREADY loaded retires the displaced child instead of orphaning it', async () => {
    await switchTo(NO_LOGIC);
    const entry = path.join(THEMES_DIR, A, 'functions.js');
    await loadIsolatedPlugin(iso(A), entry);
    const first = getLivePids(iso(A));
    assert.strictEqual(first.length, 1, 'precondition: one child for the slug');

    // Nothing OVERLAPS here — the first load settled long ago — so the in-flight join cannot see this and
    // the only thing standing between the running child and orphanhood is the guard at `isolates.set`.
    await loadIsolatedPlugin(iso(A), entry);

    const pids = await livePidCount(iso(A), 1);
    assert.strictEqual(pids.length, 1, `the displaced child was retired, not left running (alive: ${pids.join(', ')})`);
    assert.notStrictEqual(pids[0], first[0], 'and the survivor is the NEW child — the map kept the handle it can act on');
    assert.strictEqual(await marker(), '[a]x', "the displaced child's registrations came back out of the host ('[a][a]x' means it is still wired)");

    unloadIsolatedPlugin(iso(A));
    assert.ok(await pidsGone(iso(A)), 'and the survivor is reachable');
});

test('the same-slug guard covers PLUGIN isolates, not only theme: slugs', async () => {
    // Same map, same unconditional overwrite: two concurrent activations of the same PLUGIN orphaned a
    // child exactly as a theme did. Fixed once, in the isolate layer, for both namespaces.
    const entry = path.join(PLUGINS_DIR, PLUGIN_DUP, 'index.js');

    const [r1, r2] = await Promise.all([loadIsolatedPlugin(PLUGIN_DUP, entry), loadIsolatedPlugin(PLUGIN_DUP, entry)]);
    assert.strictEqual(r1, r2, 'two concurrent activations of the same PLUGIN join, exactly as theme loads do');
    assert.strictEqual((await livePidCount(PLUGIN_DUP, 1)).length, 1, 'one child after the overlapping activations');

    await loadIsolatedPlugin(PLUGIN_DUP, entry); // and the sequential displacement, in the plugin namespace
    const pids = await livePidCount(PLUGIN_DUP, 1);
    assert.strictEqual(pids.length, 1, `a displaced PLUGIN child is retired too (alive: ${pids.join(', ')})`);
    assert.strictEqual(await hooks.applyFilters('zz_dup_filter', 'x'), '[dup]x', "and the plugin's filter is wired exactly once");

    unloadIsolatedPlugin(PLUGIN_DUP);
    assert.ok(await pidsGone(PLUGIN_DUP), 'the plugin isolate is reachable and fully stopped');
    assert.strictEqual(isIsolated(BYSTANDER), true, 'the unrelated plugin isolate was untouched throughout');
});

test('a load IN FLIGHT is visible to listIsolates() before it registers (the window superviseRestart walks through)', async () => {
    await switchTo(NO_LOGIC);
    assert.deepStrictEqual(themeIsolates(), [], 'precondition: no theme isolate is loaded');

    // THE WINDOW, verbatim. superviseRestart deletes the slug's restartTimers entry and then calls
    // loadIsolatedPlugin, whose `isolates.set` is the LAST line of the load executor — so from that
    // delete until the child is registered the slug was in NO registry at all. listIsolates() therefore
    // under-reported precisely where it is needed most, and a sweep landing there skipped a child that
    // was about to exist: the retired theme came back a moment later, which is the original symptom.
    //
    // loadIsolatedPlugin returns having recorded the in-flight load and nothing else, so the very next
    // SYNCHRONOUS statement below executes inside that window.
    const inflight = loadIsolatedPlugin(iso(A), path.join(THEMES_DIR, A, 'functions.js'));
    assert.strictEqual(isIsolated(iso(A)), false, 'precondition: we are INSIDE the window — the load has not registered yet');
    assert.ok(listIsolates().includes(iso(A)), 'listIsolates() reports a slug whose load is in flight — neither registry can see it yet');

    await inflight;
    assert.ok(listIsolates().includes(iso(A)), 'and it keeps reporting it once the load registered');
    unloadIsolatedPlugin(iso(A));
    assert.ok(!listIsolates().includes(iso(A)), 'and stops reporting it after the unload');
    assert.ok(await pidsGone(iso(A)), 'with no child left behind');
});

test('the theme sweep does not SKIP a theme whose load is still in flight', async () => {
    const themeEngine = require('../core/theme-engine');
    await switchTo(NO_LOGIC);
    assert.deepStrictEqual(themeIsolates(), [], 'precondition: no theme isolate is loaded');

    // Open the window (as above) and drive the REAL sweep inside it.
    const inflight = loadIsolatedPlugin(iso(A), path.join(THEMES_DIR, A, 'functions.js'));
    assert.strictEqual(isIsolated(iso(A)), false, 'precondition: we are INSIDE the window');

    // loadThemeLogic's first act is unloadThemeIsolates(), whose listIsolates() snapshot is taken
    // synchronously — so the snapshot lands in the window. activeTheme is set by hand and the method
    // called directly because init() would await the `template` option first, and the window would be
    // long over by the time the sweep ran; landing the snapshot IN it is the entire point.
    const dir = path.join(THEMES_DIR, NO_LOGIC);
    themeEngine.activeTheme = { slug: NO_LOGIC, path: dir, templatesDir: path.join(dir, 'templates'), partialsDir: path.join(dir, 'partials') };
    const swept = themeEngine.loadThemeLogic();

    await Promise.allSettled([inflight, swept]);

    // Two ways to fail, both leaks: not SEEING the in-flight slug (sweep walks past it), or seeing it and
    // unloading a slug that has no registered child yet (a no-op — it registers a moment later anyway).
    assert.deepStrictEqual(themeIsolates(), [], 'the sweep waited for the in-flight load to settle and then retired it');
    assert.ok(await pidsGone(iso(A)), `and no child of it survives the switch (alive: ${getLivePids(iso(A)).join(', ')})`);
    assert.strictEqual(await marker(), 'x', 'nothing it registered is still wired to the host');
});

// ---------------------------------------------------------------------------------------------------
// ACTIVATION IDEMPOTENCY — stop the overlap happening at all. Defence in depth: everything above must
// hold even when these are bypassed (another node, a plugin writing the option, a future caller).
// ---------------------------------------------------------------------------------------------------

test('a double-clicked theme activation is ONE switch: the duplicate JOINS it', async () => {
    const { switchTheme } = require('../core/themes');
    await switchTo(NO_LOGIC);

    // POST /themes/:slug/activate has no idempotency of its own — the route validates the slug and calls
    // switchTheme — so two clicks arrive as two overlapping calls into the same theme switch.
    const [r1, r2] = await Promise.all([switchTheme(A), switchTheme(A)]);

    assert.strictEqual(r1, r2, 'the duplicate activation joined the first instead of running a second switch');
    assert.deepStrictEqual(themeIsolates(), [iso(A)], 'exactly one theme isolate exists afterwards');
    const pids = await livePidCount(iso(A), 1);
    assert.strictEqual(pids.length, 1, `and exactly one child (alive: ${pids.join(', ')})`);
    assert.strictEqual(await marker(), '[a]x', "with the theme's filter wired exactly once");
});

test("overlapping theme-engine inits are SERIALIZED — one init's sweep cannot run before another's load", async () => {
    const themeEngine = require('../core/theme-engine');
    await switchTo(A);

    // Instrument the step whose overlap IS the bug. Two inits interleaving means one's sweep can run
    // before the other's load, so both children end up registered — and when they are for the same slug
    // the second overwrites the first in `isolates` and orphans it. Three entry points can call init()
    // concurrently: boot, switchTheme (the admin action) and render()'s lazy re-init.
    const original = themeEngine.loadThemeLogic;
    let concurrent = 0, peak = 0;
    themeEngine.loadThemeLogic = async function (...args: any[]) {
        concurrent++; peak = Math.max(peak, concurrent);
        try { return await original.apply(this, args); } finally { concurrent--; }
    };
    try {
        await Promise.all([themeEngine.init(), themeEngine.init(), themeEngine.init()]);
    } finally {
        delete themeEngine.loadThemeLogic; // restore the prototype method
    }

    assert.strictEqual(peak, 1, `theme re-inits never overlap (peak concurrent loadThemeLogic runs: ${peak})`);
    assert.deepStrictEqual(themeIsolates(), [iso(A)], 'three concurrent re-inits leave exactly one theme isolate');
    const pids = await livePidCount(iso(A), 1);
    assert.strictEqual(pids.length, 1, `and exactly one child (alive: ${pids.join(', ')})`);
    assert.strictEqual(await marker(), '[a]x', 'with its filter wired exactly once');
});
