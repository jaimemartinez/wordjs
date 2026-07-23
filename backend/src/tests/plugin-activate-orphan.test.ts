/**
 * WordJS — a failed activation must never leave a child process behind.
 *
 * THE BUG. activatePlugin registers the isolate FIRST and only then writes `active_plugins` and fires
 * 'activated_plugin'. The option write takes a lease that THROWS BY DESIGN when it cannot be won within
 * 15s, and a hook is arbitrary third-party code, so a throw between those two steps is an ordinary
 * outcome — and it left the child REGISTERED while the flag did not list the plugin. From there:
 *
 *   - deactivatePlugin() early-returns 'Plugin not active' and never touches it, so nothing in the
 *     admin UI can clear it;
 *   - the next activation registers a SECOND child over isolates[slug]; the first one's 'exit' handler
 *     then sees wasCurrent === false and SKIPS teardown, so its hooks, routes and any claimed provider
 *     (the system mail sender) stay wired to a process nobody supervises.
 *
 * A guard placed BEFORE loadIsolatedPlugin cannot fix that: it only stops a LATER activation stacking on
 * top of the orphan, and the orphan itself still exists — a state a single POST /plugins/:slug/activate
 * can reach and that only DELETE can then clear. So the tail of the activation is TRANSACTIONAL: every
 * step after the child is registered runs in a block whose catch stops that child, and undoes the
 * `active_plugins` write if this call is the one that made it, before the error propagates.
 *
 * The pre-spawn unload is kept as a BACKSTOP for isolates registered outside activatePlugin entirely —
 * a supervised auto-restart after a crash, or a cross-node load — and that is pinned here too.
 *
 * HOW THE STATE IS REACHED HONESTLY. The two failure modes are produced the way production produces
 * them: by making the `wordjs:active-plugins` lease unwinnable for one call (exactly what
 * withActivePluginsLock turns into a throw), and by registering an 'activated_plugin' action that
 * throws. Nothing is hand-edited into a registry. core/plugin-isolate is faked so the "child" is a
 * bookkeeping record (no process is spawned here; the real spawn is covered by plugin-isolate.test.ts),
 * and it records the GENERATION of every load plus whether that generation was ever torn down, because
 * "an orphan was left behind" is precisely "generation N was never torn down".
 *
 * ORDERING: PLUGINS_DIR resolves from the CWD at module load, and both fakes must be in the require
 * cache before core/plugins is evaluated (it destructures plugin-isolate at line 15). node --test gives
 * each file its own process, so none of this leaks.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// regenerateRegistry-style side effects are not in play here, but core/plugins logs a lot less in prod.
process.env.NODE_ENV = 'production';

// 1. Sandbox the CWD before anything resolves ./plugins.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-activate-orphan-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const PLUGINS_DIR = path.join(TMP_ROOT, 'plugins');
const SLUG = 'orphanable';

// ---------------------------------------------------------------------------------------------
// Fake core/plugin-isolate — the isolate REGISTRY, with per-generation teardown bookkeeping.
// ---------------------------------------------------------------------------------------------

type Handle = { gen: number; tornDown: boolean };

const registry = new Map<string, Handle>();
const handles: Handle[] = [];   // every generation ever loaded, in order
let events: string[] = [];
let generation = 0;
/**
 * Runs INSIDE the load, i.e. after activatePlugin's `isPluginActive` early-return has already been
 * evaluated and before the `active_plugins` write. That is the only place a test can stand in for
 * "another writer changed the option while this activation was spawning" — a peer node, or the
 * cross-node coherence handler — which is precisely the interleaving withActivePluginsLock exists for.
 */
let duringLoad: (() => Promise<void>) | null = null;

const fakeIsolate: any = {
    loadIsolatedPlugin: async (slug: string, _entry: string) => {
        generation += 1;
        const h: Handle = { gen: generation, tornDown: false };
        handles.push(h);
        events.push(`load:${slug}:g${generation}`);
        registry.set(slug, h);          // isolates.set — from this instant a child is LIVE for the slug
        if (duringLoad) { const f = duringLoad; duringLoad = null; await f(); }
        return { ok: true };
    },
    unloadIsolatedPlugin: (slug: string) => {
        const h = registry.get(slug);
        events.push(`unload:${slug}:${h ? `g${h.gen}` : 'none'}`);
        if (h) { h.tornDown = true; registry.delete(slug); }   // teardown() + isolates.delete
    },
    isIsolated: (slug: string) => registry.has(slug),
    reloadIsolatedPlugin: async () => null,
    getIsolateStatus: () => null,
    getAllIsolateStatuses: () => ({}),
};

// ---------------------------------------------------------------------------------------------
// Fake core/dist-lock — so the `wordjs:active-plugins` lease can be made unwinnable for ONE call,
// which is what withActivePluginsLock converts into the throw that stranded the isolate.
// ---------------------------------------------------------------------------------------------

const denyLeaseOnce = new Set<string>();
const fakeDistLock: any = {
    HOLDER: 'test-holder',
    ensureLockTable: async () => { },
    tryAcquire: async () => true,
    renew: async () => true,
    release: async () => { },
    acquireBlocking: async (name: string) => {
        if (denyLeaseOnce.has(name)) { denyLeaseOnce.delete(name); return { held: false, release: async () => { } }; }
        return { held: true, release: async () => { } };
    },
    runAsLeader: async (_n: string, _o: any, fn: any) => fn(),
    releaseAllHeld: async () => [],
    heldLockNames: () => [],
};

function injectModule(resolvedPath: string, exportsObj: any) {
    const stub = new Module(resolvedPath, null);
    stub.filename = resolvedPath;
    stub.loaded = true;
    stub.exports = exportsObj;
    require.cache[resolvedPath] = stub;
}

injectModule(require.resolve('../core/plugin-isolate'), fakeIsolate);
injectModule(require.resolve('../core/dist-lock'), fakeDistLock);

/** A minimal plugin that passes the AST scan and the manifest gate, and declares no npm deps. */
function seedPlugin(slug: string) {
    const dir = path.join(PLUGINS_DIR, slug);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        id: slug, name: 'Orphanable', version: '1.0.0', isolated: true, bundled: true, permissions: [],
    }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'exports.init = () => 1;\n');
    return dir;
}

describe('activatePlugin — a failed activation leaves no child behind', () => {
    let plugins: any;
    let hooks: any;
    let readActive: () => Promise<string[]>;
    let setActive: (l: string[]) => Promise<any>;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        plugins = require('../core/plugins');
        hooks = require('../core/hooks');
        const options = require('../core/options');
        readActive = async () => (await options.getOption('active_plugins', [])) || [];
        setActive = (l: string[]) => options.updateOption('active_plugins', l);
        seedPlugin(SLUG);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* */ }
        process.chdir(os.tmpdir());
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    beforeEach(async () => {
        registry.clear();
        handles.length = 0;
        events = [];
        generation = 0;
        denyLeaseOnce.clear();
        duringLoad = null;
        await setActive([]);
    });

    it('stops the child it just started when the active_plugins write loses its lease', async () => {
        // Production's own failure mode: the isolate is registered, and the `active_plugins` write
        // immediately after it cannot win 'wordjs:active-plugins' within 15s, which withActivePluginsLock
        // turns into a throw.
        denyLeaseOnce.add('wordjs:active-plugins');

        await assert.rejects(() => plugins.activatePlugin(SLUG), /Failed to activate plugin/);

        assert.strictEqual(handles.length, 1, 'a child was started…');
        assert.strictEqual(handles[0].tornDown, true,
            'THE FIX: …and stopped again on the way out. Left running, it keeps this plugin\'s hooks, routes '
            + 'and any claimed provider (the system mail sender) wired to a process nobody supervises');
        assert.strictEqual(fakeIsolate.isIsolated(SLUG), false, 'nothing is registered for the slug');
        assert.deepStrictEqual(events, [`unload:${SLUG}:none`, `load:${SLUG}:g1`, `unload:${SLUG}:g1`],
            'the teardown is the LAST thing that happens — a pre-spawn guard could not have done it');
        assert.deepStrictEqual(await readActive(), [], 'and the flag is clean, so nothing claims it is active');
    });

    it('rolls the state back when the activated_plugin hook throws AFTER the flag was written', async () => {
        // The other half of the same window, and the one a pre-spawn guard misses entirely: the option
        // write SUCCEEDED and then arbitrary third-party code threw. Without the rollback the admin is
        // left with `active_plugins` naming a plugin whose child was stopped — the state activatePlugin
        // answers with 'Plugin already active' while spawning nothing.
        const boom = () => { throw new Error('hook exploded'); };
        hooks.addAction('activated_plugin', boom);
        try {
            await assert.rejects(() => plugins.activatePlugin(SLUG), /hook exploded/);
        } finally {
            hooks.removeAction('activated_plugin', boom);
        }

        assert.strictEqual(handles.length, 1);
        assert.strictEqual(handles[0].tornDown, true, 'the child that was already serving was stopped');
        assert.strictEqual(fakeIsolate.isIsolated(SLUG), false);
        assert.deepStrictEqual(await readActive(), [],
            'and the active_plugins entry this call added was taken back out — activation is all-or-nothing');
    });

    it('does not take the flag back out when ANOTHER writer had already listed the slug', async () => {
        // Only the entry THIS call wrote may be rolled back. Here a peer node writes `active_plugins`
        // while this activation is spawning (the interleaving the lease exists for), so by the time the
        // write runs the slug is already listed and the mutator makes no change at all — and then the
        // hook throws. The child this call started still has to go; the LISTING is not ours to delete.
        const boom = () => { throw new Error('hook exploded'); };
        duringLoad = async () => { await setActive(['another-plugin', SLUG]); };
        hooks.addAction('activated_plugin', boom);
        try {
            await assert.rejects(() => plugins.activatePlugin(SLUG), /hook exploded/);
        } finally {
            hooks.removeAction('activated_plugin', boom);
            duringLoad = null;
        }

        assert.strictEqual(handles[0].tornDown, true, 'the child this call started was still stopped');
        assert.deepStrictEqual(await readActive(), ['another-plugin', SLUG],
            'but the listing this call did not write is untouched — the rollback is scoped to its own write');
    });

    it('does not disturb an ordinary activation', async () => {
        const r = await plugins.activatePlugin(SLUG);

        assert.strictEqual(r.success, true);
        assert.deepStrictEqual(events, [`unload:${SLUG}:none`, `load:${SLUG}:g1`],
            'the pre-spawn backstop runs but finds nothing — it is idempotent, so this costs nothing, and '
            + 'no teardown follows the successful commit');
        assert.strictEqual(handles.length, 1);
        assert.strictEqual(handles[0].tornDown, false, 'the plugin that was just started is still running');
        assert.strictEqual(fakeIsolate.isIsolated(SLUG), true);
        assert.deepStrictEqual(await readActive(), [SLUG]);
    });

    it('BACKSTOP: clears an isolate registered from OUTSIDE activatePlugin before spawning', async () => {
        // What the pre-spawn unload is actually for, now that the tail is transactional: a child that
        // core/plugin-isolate's supervisor started on its own after a crash (superviseRestart calls
        // loadIsolatedPlugin directly, with no flag write), or a cross-node loadOnePlugin. activatePlugin
        // never saw it, so only this guard can stop it being stacked on.
        await fakeIsolate.loadIsolatedPlugin(SLUG, 'index.js');   // the supervisor's own restart
        events = [];

        const r = await plugins.activatePlugin(SLUG);

        assert.strictEqual(r.success, true);
        assert.strictEqual(handles.length, 2, 'a new child was spawned');
        assert.strictEqual(handles[0].tornDown, true, 'and the supervisor\'s child was stopped FIRST');
        assert.deepStrictEqual(events, [`unload:${SLUG}:g1`, `load:${SLUG}:g2`], 'unload happens BEFORE the load, not after');
        assert.strictEqual(registry.get(SLUG)!.gen, 2, 'exactly one child is registered — the new one');
        assert.deepStrictEqual(await readActive(), [SLUG], 'and the flag now agrees with reality');
    });

    it('cannot double-tear-down a HEALTHY isolate: a redundant activate never reaches the guard', async () => {
        await plugins.activatePlugin(SLUG);
        const live = handles[0];
        events = [];

        const again = await plugins.activatePlugin(SLUG);

        // The `isPluginActive` early-return fires first whenever the flag is set, which is the only
        // state a healthy isolate can be in — so the guard is unreachable for a running plugin.
        assert.deepStrictEqual(again, { success: true, message: 'Plugin already active' });
        assert.deepStrictEqual(events, [], 'nothing was unloaded and nothing was loaded');
        assert.strictEqual(live.tornDown, false, 'the running child was never torn down');
        assert.strictEqual(registry.get(SLUG), live, 'and it is still the registered isolate');
    });
});
