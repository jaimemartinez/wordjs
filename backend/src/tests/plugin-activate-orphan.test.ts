/**
 * WordJS — core/plugins.activatePlugin must never spawn on top of an already-registered child.
 *
 * THE BUG. activatePlugin registers the isolate FIRST and only then writes `active_plugins` and fires
 * 'activated_plugin'. The option write takes a lease that THROWS BY DESIGN when it cannot be won within
 * 15s, and a hook is arbitrary code, so a throw between those two steps is an ordinary outcome — and it
 * leaves the child REGISTERED while the flag does not list the plugin. From there:
 *
 *   - deactivatePlugin() early-returns 'Plugin not active' and never touches it, so nothing in the
 *     admin UI can clear it;
 *   - the next activation registers a SECOND child over isolates[slug]; the first one's 'exit' handler
 *     then sees wasCurrent === false and SKIPS teardown, so its hooks, routes and any claimed provider
 *     (the system mail sender) stay wired to a process nobody supervises.
 *
 * The guard therefore belongs at the single point every activation funnels through — immediately before
 * loadIsolatedPlugin — not at the four call sites, one of which (POST /plugins/:slug/activate) had been
 * missed. These tests pin all three properties of that placement: it clears an orphan, it does not
 * disturb an ordinary activation, and it cannot double-tear-down a healthy isolate.
 *
 * HOW THE STATE IS REACHED HONESTLY. The orphan is produced the way production produces it — by making
 * the `wordjs:active-plugins` lease unwinnable for one call, exactly what withActivePluginsLock turns
 * into a throw — not by hand-editing a registry. core/plugin-isolate is faked so the "child" is a
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

const fakeIsolate: any = {
    loadIsolatedPlugin: async (slug: string, _entry: string) => {
        generation += 1;
        const h: Handle = { gen: generation, tornDown: false };
        handles.push(h);
        events.push(`load:${slug}:g${generation}`);
        registry.set(slug, h);          // isolates.set — from this instant a child is LIVE for the slug
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
// which is what withActivePluginsLock converts into the throw that strands the isolate.
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

describe('activatePlugin — no isolate is ever spawned on top of another', () => {
    let plugins: any;
    let readActive: () => Promise<string[]>;
    let setActive: (l: string[]) => Promise<any>;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        plugins = require('../core/plugins');
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
        await setActive([]);
    });

    it('clears the ORPHAN a previous activation stranded, instead of spawning a second child', async () => {
        // 1. Produce the orphan exactly as production does: the isolate is registered, and the
        //    `active_plugins` write immediately after it loses its lease and throws.
        denyLeaseOnce.add('wordjs:active-plugins');
        await assert.rejects(() => plugins.activatePlugin(SLUG), /Failed to activate plugin/);

        assert.strictEqual(fakeIsolate.isIsolated(SLUG), true, 'the child is registered…');
        assert.deepStrictEqual(await readActive(), [], '…while active_plugins does not list the plugin');
        assert.strictEqual(handles.length, 1);
        assert.strictEqual(handles[0].tornDown, false, 'and nothing tore it down — this IS the orphan');
        // The admin has no way out on their own: the flag is clear, so deactivation is a no-op.
        assert.deepStrictEqual(await plugins.deactivatePlugin(SLUG), { success: true, message: 'Plugin not active' });

        // 2. The next activation must NOT stack a second child on top of it.
        events = [];
        const r = await plugins.activatePlugin(SLUG);

        assert.strictEqual(r.success, true);
        assert.strictEqual(handles.length, 2, 'a new child was spawned');
        assert.strictEqual(handles[0].tornDown, true,
            'THE FIX: the stranded first child was torn down before the second was registered — without it, its '
            + 'hooks, routes and any claimed provider stay wired to a process nobody supervises');
        assert.deepStrictEqual(events, [`unload:${SLUG}:g1`, `load:${SLUG}:g2`], 'unload happens BEFORE the load, not after');
        assert.strictEqual(registry.get(SLUG)!.gen, 2, 'exactly one child is registered — the new one');
        assert.deepStrictEqual(await readActive(), [SLUG], 'and the flag now agrees with reality');
    });

    it('does not disturb an ordinary activation (no child to clear)', async () => {
        const r = await plugins.activatePlugin(SLUG);

        assert.strictEqual(r.success, true);
        assert.deepStrictEqual(events, [`unload:${SLUG}:none`, `load:${SLUG}:g1`],
            'the defensive unload runs but finds nothing — it is idempotent, so this costs nothing');
        assert.strictEqual(handles.length, 1);
        assert.strictEqual(handles[0].tornDown, false, 'the plugin that was just started is still running');
        assert.strictEqual(fakeIsolate.isIsolated(SLUG), true);
        assert.deepStrictEqual(await readActive(), [SLUG]);
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
