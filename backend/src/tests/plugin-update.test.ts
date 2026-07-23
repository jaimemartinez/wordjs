/**
 * WordJS — one-click in-place plugin UPDATE (routes/plugins.updatePluginFromZip).
 *
 * The marketplace "Actualizar a vX" button used to hit the plain install pipeline, which refuses to
 * overwrite an existing plugin (409 "already exists" / "is currently active") — so updating was
 * impossible without uninstalling first, i.e. without risking the plugin's data. These tests pin the
 * contract of the real update cycle:
 *
 *   - the code is REPLACED (new version on disk, files the old version had are gone),
 *   - plugins/<slug>/data/ survives byte-for-byte (mail keys, attachments…),
 *   - the wjp_<slug>_* tables survive (uninstallPluginData runs with dropTables:false),
 *   - the admin's permission grants + egress allowlist survive (uninstallPluginData purges them —
 *     correct for a real uninstall, wrong for an update, so they are snapshotted and restored),
 *   - a plugin that was ACTIVE is deactivated and reactivated,
 *   - a package that fails validation (or fails to activate) ROLLS BACK to the previous version,
 *   - a package whose root folder is a different slug is refused before anything is extracted.
 *
 * …and the three hardening properties that make the above safe to expose as a one-click button:
 *
 *   - PROVENANCE: replacing a plugin's code replays the admin's grants (network + egress included)
 *     onto it and hands it the preserved data/ dir, so it is allowed ONLY from the origin the plugin
 *     was installed from. No recorded origin (manual upload / pre-feature install) = refused,
 *   - MUTUAL EXCLUSION: a second operation on the same slug during the stash window is refused (409)
 *     instead of interleaving two extracts in the same directory,
 *   - CRASH RECOVERY: a stash left behind by a killed process is restored (or discarded) at boot.
 *
 * IMPORTANT ordering: PLUGINS_DIR ('./plugins') resolves from the CWD at module load, so we chdir
 * into a temp root BEFORE requiring anything that loads core/plugins (same pattern as
 * plugin-theme-install.test.ts). node --test gives each file its own process, so the chdir leaks
 * nowhere. activate/deactivate are stubbed on the cached core/plugins module: this exercises the
 * update ORCHESTRATION, not the isolate spawn (covered by plugin-isolate tests).
 *
 * What is NOT stubbed, deliberately: `isPluginActive`. installPluginFromZip destructures it at MODULE
 * load, so a stub on the cached core/plugins object never reaches it — it always reads the real
 * `active_plugins` option. With that option left empty, its "plugin is currently active" 409 (the very
 * guard the deactivate → install → reactivate cycle exists to get past) passes for free and the whole
 * wasActive:true path proves nothing. So the stubs drive the REAL option instead, and the negative
 * control below asserts that skipping the deactivation does make the install refuse.
 *
 * The stubs also model the ISOLATE REGISTRY (`liveIsolates`), because "is this plugin running?" and
 * "is this plugin listed in active_plugins?" are two different facts and every interesting failure
 * here lives in the gap between them: activatePlugin registers the child FIRST and only then writes
 * the flag and fires 'activated_plugin' (so a throw can leave an orphan), and it EARLY-RETURNS
 * 'Plugin already active' — spawning nothing — whenever the flag is still set. A stub that only
 * tracked the flag could not tell a reactivation that worked from one that did nothing at all.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

// 0. routes/plugins fires regenerateRegistry() after every install/update/rollback — a fire-and-forget
//    execFile of the THREE frontend registry generators, unawaited. Left alone, one run of this file
//    spawns ~15 orphan node processes that --test-force-exit kills mid-write, and
//    frontend/scripts/generate-plugin-registry.js writes an absolute path from THIS temp root into
//    frontend/src/lib/pluginRegistry.ts — a file the project forbids committing. regenerateRegistry
//    reads process.env.NODE_ENV at CALL time and no-ops in production (in a real prod install the
//    registries are baked into .next), which is also what config/app already resolves to when NODE_ENV
//    is unset, so pinning it here changes nothing else about how the code under test behaves.
process.env.NODE_ENV = 'production';

// 1. Sandbox the process CWD FIRST (plugins/ + os-tmp/ resolve from it at module load).
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-plugin-update-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
fs.mkdirSync(path.join(TMP_ROOT, 'os-tmp'), { recursive: true });
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer loads.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const PLUGINS_DIR = path.join(TMP_ROOT, 'plugins');
const OS_TMP = path.join(TMP_ROOT, 'os-tmp');
const SLUG = 'updatable';
// The catalog source the test plugin is "installed from" — provenance is compared against this.
const SOURCE = 'https://catalog.example.com/download';
const ORIGIN = { source: SOURCE, catalogId: SLUG };

/** Build a plugin zip in the marketplace's shape: a single <slug>/ root folder. */
function makeZip(slug: string, version: string, { extraFile = '', isolated = true, manifestExtra = {} }: any = {}): string {
    const zip = new AdmZip();
    zip.addFile(`${slug}/manifest.json`, Buffer.from(JSON.stringify({
        id: slug, name: `Updatable ${version}`, version, isolated, permissions: [{ scope: 'database', access: 'write' }], ...manifestExtra,
    })));
    zip.addFile(`${slug}/index.js`, Buffer.from(`exports.init = () => 'v${version}';\n`));
    zip.addFile(`${slug}/VERSION.txt`, Buffer.from(version));
    if (extraFile) zip.addFile(`${slug}/${extraFile}`, Buffer.from('x'));
    // The zip must never carry data/ — build-marketplace excludes it; the preserved one wins anyway.
    const zipPath = path.join(TMP_ROOT, 'os-tmp', `pkg-${slug}-${version}-${Math.random().toString(36).slice(2)}.zip`);
    fs.writeFileSync(zipPath, zip.toBuffer());
    return zipPath;
}

/** Install v1 on disk the way a previous install would have left it, plus runtime data + old-version file. */
function seedInstalled(slug: string, version: string, { permissions = [{ scope: 'database', access: 'write' }] }: any = {}) {
    const dir = path.join(PLUGINS_DIR, slug);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        id: slug, name: `Updatable ${version}`, version, isolated: true, permissions,
    }));
    fs.writeFileSync(path.join(dir, 'index.js'), `exports.init = () => 'v${version}';\n`);
    fs.writeFileSync(path.join(dir, 'VERSION.txt'), version);
    fs.writeFileSync(path.join(dir, 'gone-in-v2.js'), '// only in v1\n');           // must NOT survive the update
    fs.writeFileSync(path.join(dir, 'data', '.secretkey'), 'AES-ROOT-KEY');          // must survive
    return dir;
}

/** Names of the leftover update stashes in os-tmp (the cycle must never leave one behind). */
function stashDirs(): string[] {
    return fs.readdirSync(OS_TMP).filter((f: string) => f.startsWith('plugin-update-'));
}

/** Poll until `cond` holds — used to await the DEFERRED boot-recovery retry (a real setTimeout). */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error(`condition not met within ${timeoutMs}ms`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

/** The slugs a child process is currently registered for — the stand-in for plugin-isolate's map. */
const liveIsolates = new Set<string>();

describe('in-place plugin update', () => {
    let dbAsync: any;
    let plugins: any;
    let updatePluginFromZip: any;
    let recoverInterruptedPluginUpdates: any;
    let acquirePluginOpLock: any;
    let permissions: any;
    let calls: string[];

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();

        plugins = require('../core/plugins');
        permissions = require('../core/plugin-permissions');
        ({ updatePluginFromZip, recoverInterruptedPluginUpdates, acquirePluginOpLock } = require('../routes/plugins'));

        // Model the isolate registry for the whole file. The real one is keyed off child processes we
        // never spawn here, so left alone it would report "nothing is running" for every plugin and the
        // update cycle's running/not-running distinction would be untestable.
        const isolate = require('../core/plugin-isolate');
        isolate.isIsolated = (s: string) => liveIsolates.has(s);
        isolate.unloadIsolatedPlugin = (s: string) => { calls.push(`unload:${s}`); liveIsolates.delete(s); };
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* */ }
        process.chdir(os.tmpdir());
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    /** The REAL `active_plugins` option — what installPluginFromZip's "currently active" 409 reads. */
    const setActivePlugins = async (list: string[]) => require('../core/options').updateOption('active_plugins', list);
    const readActivePlugins = async (): Promise<string[]> => (await require('../core/options').getOption('active_plugins', [])) || [];

    /**
     * Stub the activation lifecycle on the cached core module (runPluginUpdate re-requires it per call,
     * so the stubs are what IT sees) — but have the stubs write the REAL `active_plugins` option, since
     * that is the only thing installPluginFromZip's module-load `isPluginActive` binding can read, and
     * keep `liveIsolates` in step so "flagged active" and "actually running" can disagree exactly the
     * way they do in production.
     *
     *   `deactivateIsNoop`                 — a deactivation that never took effect: the negative control.
     *   `deactivateThrowsOnCall` (1-based) — deactivatePlugin's own withActivePluginsLock throws by
     *                                        design when it cannot win the 'wordjs:active-plugins'
     *                                        lease within 15s, and an 'activated_plugin'/'deactivated_
     *                                        plugin' hook is arbitrary code that can throw too.
     *   `deactivateThrowsAfterClearing`    — which of those two: false = the lease timed out and NOTHING
     *                                        happened (the flag survives); true = the plugin really went
     *                                        down and the hook afterwards threw.
     *   `activateThrowsAfterRegistering`   — the failure mode that produces ORPHANS: the isolate is
     *                                        registered and the flag written, and only then does it blow
     *                                        up (vs. the default, which fails before anything is live).
     *   `activateThrowsOnCall` (1-based)   — which activation fails. Default 1 = the NEW version only,
     *                                        so the rollback's reactivation of the OLD one still works.
     */
    const stubLifecycle = async ({
        active = false,
        activateThrows = '',
        activateThrowsOnCall = 1,
        activateThrowsAfterRegistering = false,
        deactivateIsNoop = false,
        deactivateThrowsOnCall = 0,
        deactivateThrowsAfterClearing = false,
        slug = SLUG,
    } = {}) => {
        calls = [];
        liveIsolates.clear();
        if (active) liveIsolates.add(slug);
        let deactivateCalls = 0;
        plugins.deactivatePlugin = async (s: string, opts: any = {}) => {
            calls.push(`deactivate:${s}:prune=${opts.prune !== false}`);
            deactivateCalls += 1;
            const throwsNow = deactivateThrowsOnCall === deactivateCalls;
            if (throwsNow && !deactivateThrowsAfterClearing) {
                throw new Error('Could not acquire active_plugins lock (another node/operation holds it)');
            }
            if (!deactivateIsNoop) {
                await setActivePlugins((await readActivePlugins()).filter((x) => x !== s));
                liveIsolates.delete(s);
            }
            if (throwsNow) throw new Error("doAction('deactivated_plugin') threw");
            return { success: true };
        };
        let activateCalls = 0;
        plugins.activatePlugin = async (s: string) => {
            calls.push(`activate:${s}`);
            activateCalls += 1;
            const throwsNow = !!activateThrows && activateThrowsOnCall === activateCalls;
            if (throwsNow && !activateThrowsAfterRegistering) throw new Error(activateThrows);
            // core/plugins.activatePlugin EARLY-RETURNS here — it spawns NOTHING and reports success.
            // This is precisely the state a deactivation that failed leaves behind.
            if ((await readActivePlugins()).includes(s)) return { success: true, message: 'Plugin already active' };
            // loadIsolatedPlugin registers the child FIRST; the flag write and the hook come after.
            liveIsolates.add(s);
            await setActivePlugins(Array.from(new Set([...(await readActivePlugins()), s])));
            if (throwsNow) throw new Error(activateThrows);
            return { success: true };
        };
        await setActivePlugins(active ? [slug] : []);
    };

    beforeEach(async () => {
        // Fresh grants + provenance each test (both persist to the shared temp DB).
        permissions._setGrantsInMemory(SLUG, []);
        await plugins.setPluginOrigin(SLUG, { source: SOURCE, catalogId: SLUG, version: '1.0.0' });
    });

    it('replaces the code, keeps data/ + tables + grants, and reactivates an active plugin', async () => {
        const dir = seedInstalled(SLUG, '1.0.0');
        await dbAsync.run('CREATE TABLE wjp_updatable_mailbox (id INTEGER PRIMARY KEY, addr TEXT)');
        await dbAsync.run("INSERT INTO wjp_updatable_mailbox (addr) VALUES ('me@example.com')");
        await permissions.setGrants(SLUG, ['database:write', 'network']);
        await permissions.setEgressAllowlist(SLUG, ['smtp.example.com']);
        await stubLifecycle({ active: true });
        assert.deepStrictEqual(await readActivePlugins(), [SLUG], 'the plugin really is active before the update');

        const r = await updatePluginFromZip(makeZip(SLUG, '2.0.0'), `${SLUG}-2.0.0.zip`, SLUG, { origin: ORIGIN });

        assert.strictEqual(r.ok, true, `update failed: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.fromVersion, '1.0.0');
        assert.strictEqual(r.body.version, '2.0.0');
        assert.strictEqual(r.body.wasActive, true);
        assert.strictEqual(r.body.reactivated, true);
        // prune=false is load-bearing: pruning would npm-uninstall the plugin's dependencies between
        // the two steps, and a range that no longer resolves then strands the plugin permanently
        // (mail-server's since-removed spf-validator ^1.0.0 did exactly that on the Proxmox LXC).
        assert.deepStrictEqual(calls, [`deactivate:${SLUG}:prune=false`, `activate:${SLUG}`], 'deactivated (without pruning deps) before, reactivated after');
        // The handoff, on the real flag: the installer's "is currently active" 409 only let this
        // through because the deactivation had actually cleared `active_plugins` (proved by the
        // negative control below), and the reactivation put it back.
        assert.deepStrictEqual(await readActivePlugins(), [SLUG], 'the real active_plugins flag is restored');

        // Code replaced.
        assert.strictEqual(fs.readFileSync(path.join(dir, 'VERSION.txt'), 'utf8'), '2.0.0');
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version, '2.0.0');
        assert.ok(!fs.existsSync(path.join(dir, 'gone-in-v2.js')), 'a file only the old version had is gone');

        // Data preserved — on disk and in the DB.
        assert.strictEqual(fs.readFileSync(path.join(dir, 'data', '.secretkey'), 'utf8'), 'AES-ROOT-KEY');
        const row = await dbAsync.get('SELECT addr FROM wjp_updatable_mailbox');
        assert.strictEqual(row.addr, 'me@example.com', 'plugin table survived the update');

        // Admin decisions preserved (uninstallPluginData purges grants — the update must restore them).
        assert.deepStrictEqual(permissions.getGrants(SLUG).sort(), ['database:write', 'network']);
        assert.deepStrictEqual(permissions.getEgressAllowlist(SLUG), ['smtp.example.com']);
        const stored = await require('../core/options').getOption('plugin_grants', {});
        assert.deepStrictEqual((stored[SLUG] || []).sort(), ['database:write', 'network'], 'grants persisted, not just in memory');

        // Provenance survives too (uninstallPluginData clears it), now tracking the installed version.
        const origin = await plugins.getPluginOrigin(SLUG);
        assert.strictEqual(origin.source, SOURCE);
        assert.strictEqual(origin.version, '2.0.0');

        // No stash left behind.
        assert.strictEqual(stashDirs().length, 0);
    });

    it('negative control: an active plugin that is NOT really deactivated is refused by the installer', async () => {
        // The whole reason updatePluginFromZip exists is installPluginFromZip's 409 "is currently
        // active" — it reads the real `active_plugins` option through a binding no stub can reach. Here
        // deactivatePlugin is called but leaves the flag set, so that guard must fire. If it does not,
        // the wasActive:true test above is passing on an empty option table and proves nothing about
        // the deactivate → install → reactivate handoff.
        const dir = seedInstalled(SLUG, '1.0.0');
        await permissions.setGrants(SLUG, ['database:write']);
        await stubLifecycle({ active: true, deactivateIsNoop: true });

        const r = await updatePluginFromZip(makeZip(SLUG, '12.0.0'), `${SLUG}-12.0.0.zip`, SLUG, { origin: ORIGIN });

        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, 409);
        assert.match(r.body.error, /currently active/i, 'the installer refused because the plugin was still marked active');
        assert.strictEqual(r.body.rolledBack, true);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'VERSION.txt'), 'utf8'), '1.0.0', 'and the working version came back');
        assert.deepStrictEqual(permissions.getGrants(SLUG), ['database:write'], 'with its grants');
        assert.strictEqual(stashDirs().length, 0);
    });

    it('reports permissions the new version ADDS — not the ones the admin refused — and grants none', async () => {
        // The installed version already declares `network`; the admin granted only database:write, i.e.
        // network was deliberately REFUSED. The new version declares both of those plus settings:write.
        //
        // "New" therefore has to be diffed against the OLD MANIFEST. Diffing against the GRANTS instead
        // reports `network` on this and every future update, so the one number an admin uses to judge
        // "does this update widen its access?" says yes when the answer is no — and the real addition
        // drowns in it. The refused permission is still surfaced, as declared-but-not-granted.
        seedInstalled(SLUG, '1.0.0', { permissions: [{ scope: 'database', access: 'write' }, { scope: 'network' }] });
        await permissions.setGrants(SLUG, ['database:write']);
        await stubLifecycle({ active: false });

        const zip = makeZip(SLUG, '3.0.0', {
            manifestExtra: { permissions: [{ scope: 'database', access: 'write' }, { scope: 'network' }, { scope: 'settings', access: 'write' }] },
        });
        const r = await updatePluginFromZip(zip, `${SLUG}-3.0.0.zip`, SLUG, { origin: ORIGIN });

        assert.strictEqual(r.ok, true, `update failed: ${JSON.stringify(r.body)}`);
        assert.deepStrictEqual(r.body.newPermissions, ['settings:write'], 'only what the previous manifest did not declare');
        assert.ok(!r.body.newPermissions.includes('network'), 'a permission BOTH versions declare is never "added by this update"');
        assert.deepStrictEqual([...r.body.ungrantedPermissions].sort(), ['network', 'settings:write'], 'declared-but-not-granted covers the refused one too');
        assert.deepStrictEqual(permissions.getGrants(SLUG), ['database:write'], 'nothing is auto-granted (default-deny)');
        assert.strictEqual(r.body.wasActive, false);
        assert.deepStrictEqual(calls, [], 'an inactive plugin is neither deactivated nor activated');
    });

    it('reports NO new permissions when the manifest did not change', async () => {
        // The complement of the case above: same declarations, one still ungranted. Nothing was added,
        // so `newPermissions` must be empty — the UI says "no pide ningún permiso nuevo" on the
        // strength of exactly this.
        seedInstalled(SLUG, '1.0.0', { permissions: [{ scope: 'database', access: 'write' }, { scope: 'network' }] });
        await permissions.setGrants(SLUG, ['database:write']);
        await stubLifecycle({ active: false });

        const zip = makeZip(SLUG, '3.1.0', {
            manifestExtra: { permissions: [{ scope: 'database', access: 'write' }, { scope: 'network' }] },
        });
        const r = await updatePluginFromZip(zip, `${SLUG}-3.1.0.zip`, SLUG, { origin: ORIGIN });

        assert.strictEqual(r.ok, true, `update failed: ${JSON.stringify(r.body)}`);
        assert.deepStrictEqual(r.body.newPermissions, [], 'an unchanged permission set adds nothing');
        assert.deepStrictEqual(r.body.ungrantedPermissions, ['network'], 'but the refused one is still not usable');
    });

    it('rolls back to the previous version when the new package fails validation', async () => {
        const dir = seedInstalled(SLUG, '1.0.0');
        await permissions.setGrants(SLUG, ['database:write']);
        await stubLifecycle({ active: true });

        // isolated:false is rejected by the post-extract manifest validation.
        const r = await updatePluginFromZip(makeZip(SLUG, '9.9.9', { isolated: false }), `${SLUG}-9.9.9.zip`, SLUG, { origin: ORIGIN });

        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.body.rolledBack, true);
        assert.strictEqual(r.body.restoredVersion, '1.0.0');
        assert.strictEqual(r.body.reactivated, true);
        assert.match(r.body.error, /isolated/i, 'the real reason is still surfaced');

        assert.strictEqual(fs.readFileSync(path.join(dir, 'VERSION.txt'), 'utf8'), '1.0.0', 'old code is back');
        assert.ok(fs.existsSync(path.join(dir, 'gone-in-v2.js')), 'old-only file is back');
        assert.strictEqual(fs.readFileSync(path.join(dir, 'data', '.secretkey'), 'utf8'), 'AES-ROOT-KEY', 'data untouched');
        assert.deepStrictEqual(permissions.getGrants(SLUG), ['database:write'], 'grants restored on rollback');
        const origin = await plugins.getPluginOrigin(SLUG);
        assert.strictEqual(origin && origin.source, SOURCE, 'provenance restored on rollback');
        assert.strictEqual(stashDirs().length, 0);
    });

    it('rolls back when the new version installs but cannot be activated', async () => {
        const dir = seedInstalled(SLUG, '1.0.0');
        await stubLifecycle({ active: true, activateThrows: 'Cannot find module smtp-server' });

        const r = await updatePluginFromZip(makeZip(SLUG, '4.0.0'), `${SLUG}-4.0.0.zip`, SLUG, { origin: ORIGIN });

        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, 502);
        assert.strictEqual(r.body.rolledBack, true);
        assert.match(r.body.error, /smtp-server/, 'the activation error is surfaced');
        assert.strictEqual(fs.readFileSync(path.join(dir, 'VERSION.txt'), 'utf8'), '1.0.0', 'the version that worked is back');
        assert.strictEqual(fs.readFileSync(path.join(dir, 'data', '.secretkey'), 'utf8'), 'AES-ROOT-KEY');
    });

    it('tears the FAILED version down before reactivating the old one (no orphaned child)', async () => {
        // activatePlugin can throw AFTER the isolate is live (isolates.set already ran). If rollback
        // just reactivated the old version, the second spawn would overwrite isolates[slug] and the
        // first child's exit handler would skip teardown — an orphan still holding hooks, routes and
        // any claimed provider. Rollback must unload it first.
        seedInstalled(SLUG, '1.0.0');
        await stubLifecycle({
            active: true,
            activateThrows: "doAction('activated_plugin') threw",
            activateThrowsAfterRegistering: true,
        });

        const r = await updatePluginFromZip(makeZip(SLUG, '5.0.0'), `${SLUG}-5.0.0.zip`, SLUG, { origin: ORIGIN });

        // deactivate (pre-swap) → activate (fails) → deactivate + unload (kill the failed child) → activate (old).
        assert.deepStrictEqual(calls, [
            `deactivate:${SLUG}:prune=false`,
            `activate:${SLUG}`,
            `deactivate:${SLUG}:prune=false`,
            `unload:${SLUG}`,
            `activate:${SLUG}`,
        ], 'the failed version is deactivated AND unloaded before the old one is brought back');
        assert.strictEqual(r.body.reactivated, true, 'and the old version really is running again');
        assert.deepStrictEqual([...liveIsolates], [SLUG], 'exactly one child is registered — the restored version');
    });

    it('tears down the isolate of a reactivation that fails on the STASH-PREPARATION path too', async () => {
        // The pre-swap deactivate → stash step can throw (deactivatePlugin's own active_plugins lease
        // times out). That path also puts the plugin back — and it used to do it with a bare
        // `try { activatePlugin } catch {}`, which has exactly the orphan problem the rollback path was
        // fixed for: activatePlugin registers the child before the flag write and the hook, so a throw
        // there leaves a process holding this plugin's hooks, routes and any claimed provider (the
        // system mail sender) while the API answers "nothing was replaced".
        const dir = seedInstalled(SLUG, '1.0.0');
        await stubLifecycle({
            active: true,
            deactivateThrowsOnCall: 1,
            deactivateThrowsAfterClearing: true,     // the plugin went down, the hook after it threw
            activateThrows: 'the restart hook threw after the isolate was registered',
            activateThrowsAfterRegistering: true,
        });

        const r = await updatePluginFromZip(makeZip(SLUG, '15.0.0'), `${SLUG}-15.0.0.zip`, SLUG, { origin: ORIGIN });

        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, 500);
        assert.match(r.body.error, /Could not prepare the update/);
        assert.match(r.body.error, /could NOT be restarted/, 'the admin is told the plugin is down, not that all is well');
        assert.strictEqual(r.body.reactivated, false);
        assert.deepStrictEqual(calls, [
            `deactivate:${SLUG}:prune=false`,
            `activate:${SLUG}`,
            `deactivate:${SLUG}:prune=false`,
            `unload:${SLUG}`,
        ], 'the half-started isolate is deactivated AND unloaded');
        assert.deepStrictEqual([...liveIsolates], [], 'no orphan child is left holding this slug');
        assert.strictEqual(fs.readFileSync(path.join(dir, 'VERSION.txt'), 'utf8'), '1.0.0', 'and nothing was replaced');
        assert.strictEqual(stashDirs().length, 0);
    });

    it('does NOT claim the old version was reactivated when activatePlugin only early-returned', async () => {
        // The false-success report. Rollback's first step deactivates the failed new version, and that
        // call can throw on its own lease — leaving the slug LISTED in active_plugins. activatePlugin
        // then hits `if (await isPluginActive(slug)) return { success: true, 'Plugin already active' }`
        // and spawns nothing, while the unconditional unload just before it took the only live child
        // away. A `try { activate; reactivated = true } catch` reports "v1.0.0 was restored and
        // reactivated" for a plugin with no process at all.
        const dir = seedInstalled(SLUG, '1.0.0');
        await stubLifecycle({
            active: true,
            activateThrows: 'init failed',
            activateThrowsAfterRegistering: true,    // so the flag IS set when the rollback starts
            deactivateThrowsOnCall: 2,               // the rollback's teardown loses the lease race
        });

        const r = await updatePluginFromZip(makeZip(SLUG, '14.0.0'), `${SLUG}-14.0.0.zip`, SLUG, { origin: ORIGIN });

        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.body.rolledBack, true);
        assert.strictEqual(r.body.reactivated, false, 'nothing is running — the API must not say it was reactivated');
        assert.match(r.body.error, /could NOT be reactivated/, 'and the message says so');
        assert.deepStrictEqual([...liveIsolates], [], 'the isolate registry agrees: no child for this slug');
        assert.strictEqual(fs.readFileSync(path.join(dir, 'VERSION.txt'), 'utf8'), '1.0.0', 'the code was still rolled back');
        assert.strictEqual(stashDirs().length, 0);
    });

    it('refuses a package that would install a DIFFERENT plugin', async () => {
        const dir = seedInstalled(SLUG, '1.0.0');
        await stubLifecycle({ active: false });

        const r = await updatePluginFromZip(makeZip('someone-else', '1.0.0'), 'someone-else-1.0.0.zip', SLUG, { origin: ORIGIN });

        assert.strictEqual(r.ok, false);
        assert.match(r.body.error, /someone-else/);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'VERSION.txt'), 'utf8'), '1.0.0', 'the target plugin is intact');
        assert.ok(!fs.existsSync(path.join(PLUGINS_DIR, 'someone-else')), 'and nothing was extracted for the other slug');
    });

    it('falls back to a plain install when the plugin is not installed (adopting preserved data/)', async () => {
        const dir = path.join(PLUGINS_DIR, 'not-installed');
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(path.join(dir, 'data'), { recursive: true });         // residual data from an uninstall
        fs.writeFileSync(path.join(dir, 'data', 'keep.txt'), 'preserved');
        await stubLifecycle({ active: false });

        const r = await updatePluginFromZip(makeZip('not-installed', '1.0.0'), 'not-installed-1.0.0.zip', 'not-installed', {
            origin: { source: SOURCE, catalogId: 'not-installed' },
        });

        assert.strictEqual(r.ok, true, `install failed: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.slug, 'not-installed');
        assert.strictEqual(fs.readFileSync(path.join(dir, 'data', 'keep.txt'), 'utf8'), 'preserved');
        assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
        // A fresh install binds the plugin to the source it came from, so a LATER update can be checked.
        const origin = await plugins.getPluginOrigin('not-installed');
        assert.strictEqual(origin && origin.source, SOURCE, 'the install origin is recorded');
    });

    // ---- PROVENANCE (the security gate) ----------------------------------------------------------
    // An update replays the admin's grants (network + egress allowlist included, and those are read
    // from the grant map alone — the new manifest does NOT re-gate them) onto the replacement code,
    // and hands it plugins/<slug>/data/. Binding "is this an update?" to the SLUG alone would let any
    // catalog source that lists the same id take over an installed plugin, with its secrets.

    it('refuses to update a plugin with NO recorded origin (manual upload / pre-feature install)', async () => {
        const dir = seedInstalled(SLUG, '1.0.0');
        await plugins.clearPluginOrigin(SLUG);
        await permissions.setGrants(SLUG, ['database:write', 'network']);
        await stubLifecycle({ active: true });

        const r = await updatePluginFromZip(makeZip(SLUG, '6.0.0'), `${SLUG}-6.0.0.zip`, SLUG, { origin: ORIGIN });

        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.body.originMismatch, true);
        assert.strictEqual(r.body.recordedOrigin, null);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'VERSION.txt'), 'utf8'), '1.0.0', 'nothing was replaced');
        assert.deepStrictEqual(calls, [], 'the plugin was not even stopped');
        assert.deepStrictEqual(permissions.getGrants(SLUG).sort(), ['database:write', 'network'], 'grants untouched');
    });

    it('refuses an update coming from a DIFFERENT source, and transfers nothing to it', async () => {
        const dir = seedInstalled(SLUG, '1.0.0');
        await permissions.setGrants(SLUG, ['database:write', 'network']);
        await permissions.setEgressAllowlist(SLUG, ['smtp.example.com']);
        await stubLifecycle({ active: true });

        const r = await updatePluginFromZip(makeZip(SLUG, '7.0.0'), `${SLUG}-7.0.0.zip`, SLUG, {
            origin: { source: 'https://evil.example.net/catalog', catalogId: SLUG },
        });

        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.body.originMismatch, true);
        assert.strictEqual(r.body.recordedOrigin, SOURCE);
        assert.match(r.body.error, /evil\.example\.net/);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'VERSION.txt'), 'utf8'), '1.0.0', 'the installed code is untouched');
        assert.deepStrictEqual(calls, [], 'the running plugin was never stopped');
        // The point of the gate: none of what an update inherits reaches the foreign package. Nothing
        // was extracted, so nothing can read data/, and the grants/egress the admin approved for the
        // code from SOURCE are still attached to that code alone.
        assert.deepStrictEqual(permissions.getGrants(SLUG).sort(), ['database:write', 'network'], 'grants did NOT transfer');
        assert.deepStrictEqual(permissions.getEgressAllowlist(SLUG), ['smtp.example.com'], 'nor the egress allowlist');
        assert.strictEqual(fs.readFileSync(path.join(dir, 'data', '.secretkey'), 'utf8'), 'AES-ROOT-KEY', 'nor the plugin secrets in data/');
        const origin = await plugins.getPluginOrigin(SLUG);
        assert.strictEqual(origin && origin.source, SOURCE, 'and the recorded origin still names the real publisher');
        assert.strictEqual(stashDirs().length, 0, 'refused before anything was stashed');
    });

    it('negative control: with the provenance gate neutered the foreign package DOES take over', async () => {
        // Proves the two refusals above are produced by the gate and not by some incidental failure —
        // if the check were deleted, THIS is what would happen, and those tests would go red. The gate
        // is neutered exactly where it reads: getPluginOrigin now agrees with whatever the caller
        // claims, which is what "identify an update by its slug" amounted to.
        const dir = seedInstalled(SLUG, '1.0.0');
        await permissions.setGrants(SLUG, ['database:write', 'network']);
        await permissions.setEgressAllowlist(SLUG, ['smtp.example.com']);
        await stubLifecycle({ active: false });

        const EVIL = 'https://evil.example.net/catalog';
        const realGetOrigin = plugins.getPluginOrigin;
        plugins.getPluginOrigin = async () => ({
            source: plugins.normalizeOriginSource(EVIL), catalogId: SLUG, version: '1.0.0', installedAt: Date.now(),
        });
        let r: any;
        try {
            r = await updatePluginFromZip(makeZip(SLUG, '13.0.0'), `${SLUG}-13.0.0.zip`, SLUG, { origin: { source: EVIL, catalogId: SLUG } });
        } finally {
            plugins.getPluginOrigin = realGetOrigin;
        }

        assert.strictEqual(r.ok, true, `the ungated update should have gone through: ${JSON.stringify(r.body)}`);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'VERSION.txt'), 'utf8'), '13.0.0', 'a package from another source replaced the code');
        assert.deepStrictEqual(permissions.getGrants(SLUG).sort(), ['database:write', 'network'], 'and inherited the grants the admin approved for someone else');
        assert.deepStrictEqual(permissions.getEgressAllowlist(SLUG), ['smtp.example.com'], 'including the egress allowlist');
        assert.strictEqual(fs.readFileSync(path.join(dir, 'data', '.secretkey'), 'utf8'), 'AES-ROOT-KEY', 'and was handed the plugin secrets — this is what the gate prevents');
    });

    it('refuses an update whose caller names no origin at all', async () => {
        const dir = seedInstalled(SLUG, '1.0.0');
        await stubLifecycle({ active: false });

        const r = await updatePluginFromZip(makeZip(SLUG, '8.0.0'), `${SLUG}-8.0.0.zip`, SLUG);

        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, 400);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'VERSION.txt'), 'utf8'), '1.0.0');
    });

    it('accepts a source that differs only by a trailing slash (same origin, normalized)', async () => {
        const dir = seedInstalled(SLUG, '1.0.0');
        await stubLifecycle({ active: false });

        const r = await updatePluginFromZip(makeZip(SLUG, '2.5.0'), `${SLUG}-2.5.0.zip`, SLUG, {
            origin: { source: `${SOURCE}/`, catalogId: SLUG },
        });

        assert.strictEqual(r.ok, true, `update failed: ${JSON.stringify(r.body)}`);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'VERSION.txt'), 'utf8'), '2.5.0');
    });

    // ---- MUTUAL EXCLUSION ------------------------------------------------------------------------

    it('refuses a second operation on the same plugin while one is running', async () => {
        seedInstalled(SLUG, '1.0.0');
        await stubLifecycle({ active: false });

        // Both calls target the same slug; the second must be REFUSED, not interleaved — during the
        // stash window plugins/<slug>/ holds only data/, which the plain-install branch would happily
        // extract over, and the loser's rollback would then delete the winner's files.
        const [a, b] = await Promise.all([
            updatePluginFromZip(makeZip(SLUG, '10.0.0'), `${SLUG}-10.0.0.zip`, SLUG, { origin: ORIGIN }),
            updatePluginFromZip(makeZip(SLUG, '11.0.0'), `${SLUG}-11.0.0.zip`, SLUG, { origin: ORIGIN }),
        ]);

        const winners = [a, b].filter((r: any) => r.ok);
        const losers = [a, b].filter((r: any) => !r.ok);
        assert.strictEqual(winners.length, 1, 'exactly one update ran');
        assert.strictEqual(losers.length, 1);
        assert.strictEqual(losers[0].status, 409);
        assert.strictEqual(losers[0].busy || losers[0].body.busy, true);
        assert.strictEqual(stashDirs().length, 0, 'the refused call left no stash behind');
    });

    it('locks a plugin by its CASE-FOLDED slug, so a case variant is not a second lock', async () => {
        // SLUG_RE allows mixed case, but on a case-insensitive filesystem (Windows / default macOS)
        // resolveSafePluginDir maps 'Mail-Server' and 'mail-server' to the SAME directory. Keying the
        // guard on the raw spelling hands out two independent locks — and two distributed lease names —
        // for one directory, so a DELETE spelled one way rmSync's the dir an update spelled the other
        // way is mid-swap on.
        const held = await acquirePluginOpLock('Mail-Server');
        assert.strictEqual(held.ok, true);
        try {
            const variant = await acquirePluginOpLock('mail-server');
            assert.strictEqual(variant.ok, false, 'same directory ⇒ same lock, whatever the spelling');
            const shouty = await acquirePluginOpLock('MAIL-SERVER');
            assert.strictEqual(shouty.ok, false);
        } finally {
            await held.release();
        }
        const after = await acquirePluginOpLock('mail-SERVER');
        assert.strictEqual(after.ok, true, 'and releasing one spelling frees them all');
        await after.release();
    });

    // ---- CRASH RECOVERY --------------------------------------------------------------------------

    it('restores a GUTTED plugin from the stash an interrupted update left behind', async () => {
        // Exactly what a kill between stashPluginCode and the end of the cycle leaves on disk: the
        // plugin dir holds only data/, and the code lives in os-tmp (which backups exclude).
        const slug = 'interrupted';
        const dir = path.join(PLUGINS_DIR, slug);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'data', 'keep.txt'), 'preserved');
        fs.writeFileSync(path.join(dir, 'half-extracted.js'), '// from the new version');  // partial extract
        const stash = path.join(OS_TMP, `plugin-update-${slug}-aabbccddeeff`);
        fs.mkdirSync(stash, { recursive: true });
        fs.writeFileSync(path.join(stash, 'manifest.json'), JSON.stringify({ id: slug, name: 'Interrupted', version: '1.0.0', isolated: true }));
        fs.writeFileSync(path.join(stash, 'index.js'), 'exports.init = () => 1;\n');

        const out = await recoverInterruptedPluginUpdates();

        assert.deepStrictEqual(out.restored, [slug]);
        assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), 'the old code is back');
        assert.strictEqual(fs.readFileSync(path.join(dir, 'data', 'keep.txt'), 'utf8'), 'preserved', 'data/ survived the recovery');
        assert.ok(!fs.existsSync(path.join(dir, 'half-extracted.js')), 'the partial new extract is gone');
        assert.ok(!fs.existsSync(stash), 'the stash is consumed');
    });

    it('discards a stale stash when the plugin directory is intact', async () => {
        const slug = 'completed';
        const dir = path.join(PLUGINS_DIR, slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: slug, name: 'Completed', version: '2.0.0', isolated: true }));
        const stash = path.join(OS_TMP, `plugin-update-${slug}-0011223344ff`);
        fs.mkdirSync(stash, { recursive: true });
        fs.writeFileSync(path.join(stash, 'manifest.json'), JSON.stringify({ id: slug, name: 'Completed', version: '1.0.0', isolated: true }));

        const out = await recoverInterruptedPluginUpdates();

        assert.deepStrictEqual(out.discarded, [slug]);
        assert.ok(!fs.existsSync(stash), 'the stale stash is removed');
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version, '2.0.0', 'the installed version is untouched');
    });

    it('DEFERS and retries a stash it cannot lock, instead of silently skipping it', async () => {
        // Losing the operation lock at boot is not proof another node is working: on Postgres the lease
        // is holder-guarded and only lapses on its TTL, so the single likeliest holder is the very
        // process that was killed mid-update and left this stash — its successor has a new HOLDER and
        // cannot free it. Skipping then leaves the plugin GUTTED, with its only copy of the code in a
        // directory core/backup.ts excludes, until some later restart happens to fall outside the TTL
        // window. (Restore is what makes this observable: the plugin dir below has no manifest.)
        const slug = 'deferred';
        const dir = path.join(PLUGINS_DIR, slug);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
        const stash = path.join(OS_TMP, `plugin-update-${slug}-ffeeddccbbaa`);
        fs.mkdirSync(stash, { recursive: true });
        fs.writeFileSync(path.join(stash, 'manifest.json'), JSON.stringify({ id: slug, name: 'Deferred', version: '1.0.0', isolated: true }));

        // Stand in for the stranded lease / the other node: hold the slug for the first sweep.
        const holder = await acquirePluginOpLock(slug);
        assert.strictEqual(holder.ok, true);

        const first = await recoverInterruptedPluginUpdates({ retryMs: 40 });

        assert.deepStrictEqual(first.deferred, [slug], 'reported as deferred, not silently dropped');
        assert.deepStrictEqual(first.restored, [], 'and NOT restored from under the lock holder');
        assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')), 'the plugin is still gutted');
        assert.ok(fs.existsSync(stash), 'and the only copy of its code is still in os-tmp');

        await holder.release();                                  // the lease expires / the other node finishes

        await waitFor(() => fs.existsSync(path.join(dir, 'manifest.json')));
        assert.ok(!fs.existsSync(stash), 'the scheduled retry consumed the stash');
    });
});
