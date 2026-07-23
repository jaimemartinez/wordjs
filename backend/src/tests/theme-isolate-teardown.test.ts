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
const { loadIsolatedPlugin, unloadIsolatedPlugin, isIsolated, listIsolates, getLivePids } = isolate;

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
    // Registers, then dies at runtime → the host supervisor ARMS a backoff restart for it. That restart
    // is the second way a retired theme comes back (see the crash test at the bottom). The delay is
    // deliberately LONGER than the supervisor's first backoff step (1s) plus a child's boot time: a
    // resurrected child must stay up long enough to be observable, or the test passes for the wrong
    // reason — it did, until this fixture crashed again before the assertions could see it.
    writeTheme(CRASHER,
        "module.exports = (wordjs) => {\n" +
        "  wordjs.hooks.addFilter('zz_theme_marker', (v) => '[crash]' + v);\n" +
        "  setTimeout(() => { throw new Error('theme crasher: deliberate runtime crash'); }, 2500);\n" +
        "};\n");

    // A PLUGIN isolate that must be completely unaffected by every theme switch below.
    const bdir = path.join(PLUGINS_DIR, BYSTANDER);
    fs.mkdirSync(bdir, { recursive: true });
    fs.writeFileSync(path.join(bdir, 'manifest.json'), JSON.stringify({ name: BYSTANDER, isolated: true, permissions: [] }));
    fs.writeFileSync(path.join(bdir, 'index.js'),
        "exports.init = function (wordjs) {\n" +
        "  wordjs.hooks.addFilter('zz_bystander_filter', (v) => '[plugin]' + v);\n" +
        "};\n");
});

after(async () => {
    for (const slug of FIXTURE_THEMES) { try { unloadIsolatedPlugin(iso(slug)); } catch { /* */ } }
    try { unloadIsolatedPlugin(BYSTANDER); } catch { /* */ }
    // Delete ONLY our own fixtures — themes/ and plugins/ hold the operator's real installs.
    for (const slug of FIXTURE_THEMES) { try { fs.rmSync(path.join(THEMES_DIR, slug), { recursive: true, force: true }); } catch { /* */ } }
    try { fs.rmSync(path.join(PLUGINS_DIR, BYSTANDER), { recursive: true, force: true }); } catch { /* */ }
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

    // Wait for the deliberate runtime crash: the registry entry disappears and a restart is armed.
    const deadline = Date.now() + 8000;
    while (isIsolated(iso(CRASHER)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(isIsolated(iso(CRASHER)), false, 'the crasher child died and left the registry');

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
