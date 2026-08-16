/**
 * WordJS — one-click in-place plugin UPDATE (runPluginUpdate) + boot recovery.
 *
 * Covers the security + data-safety core WITHOUT spawning a real isolate: every case uses an INACTIVE
 * plugin (wasActive=false), so runPluginUpdate exercises stash → uninstall-data → install → restore-grants
 * → success/rollback with no child_process. Verified invariants:
 *   - data/ dir + wjp_<slug>_* tables + admin grants survive an update;
 *   - the origin gate: no recorded origin → 409, a DIFFERENT source → 409 (the takeover block), same → ok;
 *   - a bad new zip rolls back to the previous code + data + grants (nothing half-applied);
 *   - a NEGATIVE CONTROL proving the gate is what stops a foreign source from taking the plugin over;
 *   - boot recovery restores an interrupted update's stashed code and discards a completed one.
 *
 * Temp-DB isolation: repoint config.dbPath BEFORE requiring ../config/database (see api.test.ts).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-plugin-update-test-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');

const SLUG = `updtest${process.pid}`;
const S1 = 'https://catalog.one/download';
const S2 = 'https://evil.two/download';

describe('plugin in-place update', () => {
    let dbAsync: any;
    let runPluginUpdate: any, recoverInterruptedPluginUpdates: any;
    let PLUGINS_DIR: string, OS_TMP_DIR: string;
    let perms: any, origins: any, getOption: any, updateOption: any;

    const pluginDir = () => path.join(PLUGINS_DIR, SLUG);
    const table = `wjp_${SLUG.toLowerCase()}_data`;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        const core = require('../core/plugins');
        PLUGINS_DIR = core.PLUGINS_DIR;
        OS_TMP_DIR = path.resolve(PLUGINS_DIR, '..', 'os-tmp');
        ({ runPluginUpdate, recoverInterruptedPluginUpdates } = require('../routes/plugins'));
        perms = require('../core/plugin-permissions');
        origins = require('../core/plugin-origins');
        ({ getOption, updateOption } = require('../core/options'));
    });

    after(async () => {
        cleanupSlug();
        for (const t of installTmps) { try { t.dispose(); } catch { /* */ } }
        try { await database.closeDatabase(); } catch { /* */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
    });

    beforeEach(async () => {
        cleanupSlug();
        await updateOption('plugin_grants', {});
        await updateOption('plugin_egress_hosts', {});
        await updateOption('plugin_origins', {});
        await updateOption('active_plugins', []);
        await perms.loadGrants();
        await perms.loadEgressHosts();
        try { await dbAsync.run(`DROP TABLE IF EXISTS ${table}`); } catch { /* */ }
    });

    function cleanupSlug() {
        try { fs.rmSync(pluginDir(), { recursive: true, force: true }); } catch { /* */ }
        try {
            for (const n of fs.readdirSync(OS_TMP_DIR)) {
                if (n.startsWith(`plugin-update-${SLUG}-`)) fs.rmSync(path.join(OS_TMP_DIR, n), { recursive: true, force: true });
            }
        } catch { /* */ }
    }

    const BENIGN_INDEX = "'use strict';\nmodule.exports = { register() {} };\n";

    // A manifest declares permissions as {scope, access} objects; tests pass "scope:access" tokens.
    const permObjs = (toks?: string[]) => (toks || []).map((t) => t === 'network'
        ? { scope: 'network' }
        : { scope: t.split(':')[0], access: t.split(':')[1] || 'read' });

    // Set up an INSTALLED (inactive) plugin: code + a data/ file + a wjp table + grants + (optionally) origin.
    async function installExisting(opts: { version: string; permissions?: string[]; grants?: string[]; egress?: string[]; origin?: any }) {
        const dir = pluginDir();
        fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'Upd Test', isolated: true, version: opts.version, permissions: permObjs(opts.permissions) }));
        fs.writeFileSync(path.join(dir, 'index.js'), `${BENIGN_INDEX}// version ${opts.version}\n`);
        fs.writeFileSync(path.join(dir, 'data', 'secret.key'), 'PRESERVE-ME');
        await dbAsync.run(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, v TEXT)`);
        await dbAsync.run(`INSERT INTO ${table} (v) VALUES ('row1')`);
        if (opts.grants) await perms.setGrants(SLUG, opts.grants);
        if (opts.egress) await perms.setEgressAllowlist(SLUG, opts.egress);
        if (opts.origin) await origins.setPluginOrigin(SLUG, opts.origin);
    }

    /**
     * Where an install package is allowed to live.
     *
     * installPluginFromZip now PROVES that the path it was handed sits inside the app's own os-tmp
     * scratch dir before it opens or unlinks anything (js/path-injection: the pipeline used to delete a
     * caller-chosen path on thirteen failure branches without ever establishing what that path was).
     * Both production callers already put it there — multer's `dest` and the marketplace download — so
     * the fixture uses the same sanctioned allocator instead of a loose name in the shared OS temp dir.
     * Each call gets its own kernel-exclusive 0700 directory, disposed in after().
     */
    const installTmps: Array<{ dispose: () => void }> = [];
    function newZipPath(): string {
        const t = require('../routes/plugins').createInstallTmp();
        installTmps.push(t);
        return t.zipPath;
    }

    // Build a valid update zip (single root folder <slug>/), optionally corrupt to force install failure.
    function buildZip(opts: { version: string; permissions?: string[]; corrupt?: boolean }): string {
        const zip = new AdmZip();
        if (opts.corrupt) {
            // No manifest.json → installPluginFromZip validation fails → update must roll back.
            zip.addFile(`${SLUG}/index.js`, Buffer.from(BENIGN_INDEX));
        } else {
            zip.addFile(`${SLUG}/manifest.json`, Buffer.from(JSON.stringify({ name: 'Upd Test', isolated: true, version: opts.version, permissions: permObjs(opts.permissions) })));
            zip.addFile(`${SLUG}/index.js`, Buffer.from(`${BENIGN_INDEX}// version ${opts.version}\n`));
        }
        const p = newZipPath();
        zip.writeZip(p);
        return p;
    }

    const rowCount = async () => (await dbAsync.get(`SELECT COUNT(*) AS c FROM ${table}`).catch(() => ({ c: -1 }))).c;
    const installedVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(pluginDir(), 'manifest.json'), 'utf8')).version; } catch { return null; } };
    const dataPreserved = () => { try { return fs.readFileSync(path.join(pluginDir(), 'data', 'secret.key'), 'utf8'); } catch { return null; } };

    it('happy path: preserves data/ + tables + grants, bumps version, reports the permission diff', async () => {
        await installExisting({ version: '1.0.0', permissions: ['database:write'], grants: ['database:write'], egress: ['api.one.com'], origin: { source: S1, catalogId: SLUG, version: '1.0.0' } });
        const zip = buildZip({ version: '2.0.0', permissions: ['database:write', 'settings:read'] });

        const r = await runPluginUpdate(SLUG, zip, { source: S1, catalogId: SLUG, version: '2.0.0' });

        assert.strictEqual(r.ok, true, r.body && r.body.error);
        assert.strictEqual(r.body.updated, true);
        assert.strictEqual(r.body.fromVersion, '1.0.0');
        assert.strictEqual(r.body.toVersion, '2.0.0');
        assert.strictEqual(installedVersion(), '2.0.0', 'new code on disk');
        assert.strictEqual(dataPreserved(), 'PRESERVE-ME', 'data/ survived');
        assert.strictEqual(await rowCount(), 1, 'wjp_ table + row survived');
        assert.deepStrictEqual(perms.getGrants(SLUG).sort(), ['database:write'], 'grants restored (not wiped)');
        assert.deepStrictEqual(perms.getEgressAllowlist(SLUG), ['api.one.com'], 'egress restored');
        assert.deepStrictEqual(r.body.newPermissions, ['settings:read'], 'only the newly-declared perm is "new"');
        assert.deepStrictEqual(r.body.ungrantedPermissions, ['settings:read'], 'new perm is declared but not granted');
        assert.ok(!fs.existsSync(path.join(pluginDir(), 'data', 'nope')));
        // stash cleaned up
        assert.strictEqual(fs.readdirSync(OS_TMP_DIR).some((n: string) => n.startsWith(`plugin-update-${SLUG}-`)), false);
    });

    it('origin gate: an UNBOUND plugin (no recorded origin) cannot be updated from a catalog', async () => {
        await installExisting({ version: '1.0.0', grants: ['database:write'] }); // no origin
        const zip = buildZip({ version: '2.0.0' });

        const r = await runPluginUpdate(SLUG, zip, { source: S1, catalogId: SLUG, version: '2.0.0' });

        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.body.code, 'originMismatch');
        assert.strictEqual(r.body.recordedOrigin, null);
        assert.strictEqual(installedVersion(), '1.0.0', 'unchanged — no destructive action taken');
        assert.strictEqual(dataPreserved(), 'PRESERVE-ME');
    });

    it('origin gate + NEGATIVE CONTROL: a DIFFERENT source cannot take the plugin over', async () => {
        await installExisting({ version: '1.0.0', permissions: ['database:write'], grants: ['database:write'], origin: { source: S1, catalogId: SLUG, version: '1.0.0' } });
        const foreignZip = buildZip({ version: '9.9.9', permissions: ['database:write'] });

        const r = await runPluginUpdate(SLUG, foreignZip, { source: S2, catalogId: SLUG, version: '9.9.9' });

        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.body.code, 'originMismatch');
        assert.strictEqual(r.body.recordedOrigin, S1);
        assert.strictEqual(r.body.attemptedOrigin, S2);
        // The takeover was blocked: original code, grants and data are all intact (foreign code never landed).
        assert.strictEqual(installedVersion(), '1.0.0', 'foreign code did NOT replace the plugin');
        assert.deepStrictEqual(perms.getGrants(SLUG), ['database:write'], 'grants not handed to foreign code');
        assert.strictEqual(dataPreserved(), 'PRESERVE-ME', 'secrets not handed to foreign code');
        // The SAME zip from the CORRECT source is accepted — proving the gate (not the zip) is what refused it.
        const okZip = buildZip({ version: '2.0.0', permissions: ['database:write'] });
        const ok = await runPluginUpdate(SLUG, okZip, { source: S1, catalogId: SLUG, version: '2.0.0' });
        assert.strictEqual(ok.ok, true, ok.body && ok.body.error);
        assert.strictEqual(installedVersion(), '2.0.0');
    });

    it('rollback: a bad new zip restores the previous version, data and grants', async () => {
        await installExisting({ version: '1.0.0', permissions: ['database:write'], grants: ['database:write'], egress: ['api.one.com'], origin: { source: S1, catalogId: SLUG, version: '1.0.0' } });
        const badZip = buildZip({ version: '2.0.0', corrupt: true }); // no manifest → install fails

        const r = await runPluginUpdate(SLUG, badZip, { source: S1, catalogId: SLUG, version: '2.0.0' });

        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.body.rolledBack, true);
        assert.strictEqual(r.body.restoredVersion, '1.0.0');
        assert.strictEqual(installedVersion(), '1.0.0', 'old code restored');
        assert.ok(fs.existsSync(path.join(pluginDir(), 'index.js')), 'old index.js restored from stash');
        assert.strictEqual(dataPreserved(), 'PRESERVE-ME', 'data/ preserved through the failed update');
        assert.strictEqual(await rowCount(), 1, 'tables preserved');
        assert.deepStrictEqual(perms.getGrants(SLUG), ['database:write'], 'grants restored after rollback');
        assert.deepStrictEqual(perms.getEgressAllowlist(SLUG), ['api.one.com'], 'egress restored after rollback');
        assert.strictEqual(fs.readdirSync(OS_TMP_DIR).some((n: string) => n.startsWith(`plugin-update-${SLUG}-`)), false, 'stash cleaned up on rollback');
    });

    it('boot recovery: RESTORES an interrupted update (code only in the stash, no manifest on disk)', async () => {
        // Simulate a crash AFTER stash, BEFORE install: plugins/<slug> has only data/, code is in the stash.
        const dir = pluginDir();
        fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'data', 'secret.key'), 'PRESERVE-ME');
        const stash = path.join(OS_TMP_DIR, `plugin-update-${SLUG}-${crypto.randomBytes(8).toString('hex')}`);
        fs.mkdirSync(stash, { recursive: true });
        fs.writeFileSync(path.join(stash, 'manifest.json'), JSON.stringify({ name: 'Upd Test', isolated: true, version: '1.0.0', permissions: [] }));
        fs.writeFileSync(path.join(stash, 'index.js'), BENIGN_INDEX);

        await recoverInterruptedPluginUpdates();

        assert.strictEqual(installedVersion(), '1.0.0', 'previous version restored from stash');
        assert.strictEqual(dataPreserved(), 'PRESERVE-ME', 'data/ kept');
        assert.strictEqual(fs.existsSync(stash), false, 'stash consumed');
    });

    it('boot recovery: DISCARDS a completed update\'s stash (manifest already present)', async () => {
        await installExisting({ version: '2.0.0' }); // manifest present → update had finished
        const stash = path.join(OS_TMP_DIR, `plugin-update-${SLUG}-${crypto.randomBytes(8).toString('hex')}`);
        fs.mkdirSync(stash, { recursive: true });
        fs.writeFileSync(path.join(stash, 'manifest.json'), JSON.stringify({ name: 'Old', isolated: true, version: '1.0.0' }));

        await recoverInterruptedPluginUpdates();

        assert.strictEqual(installedVersion(), '2.0.0', 'installed version untouched');
        assert.strictEqual(fs.existsSync(stash), false, 'stale stash discarded');
    });

    // ── REGRESSIONS ─────────────────────────────────────────────────────────────────────────────
    // Both of these passed GREEN against the buggy code; they exist because the rest of the suite
    // did too. Each asserts the CONSEQUENCE of the bug, not the shape of the fix.

    it('refuses a zip whose root folder is a DIFFERENT plugin, and leaves this one intact', async () => {
        await installExisting({ version: '1.0.0', origin: { source: S1, catalogId: SLUG, version: '1.0.0' } });

        // The install target is taken from the zip's own root folder. A version-suffixed root
        // ('<slug>-2.0.0/') was already refused — the dots fail isValidSlug — but a root that is a
        // VALID slug and simply names something else was not: the new code landed in
        // plugins/<other>/ while the real plugins/<slug>/ sat stashed, the install reported success
        // so no rollback ran, and the success path then deleted the stash. The plugin was gone and
        // an unrelated one had been written over.
        const other = `${SLUG}other`;
        const zip = new AdmZip();
        zip.addFile(`${other}/manifest.json`, Buffer.from(JSON.stringify({ name: 'Other', isolated: true, version: '2.0.0', permissions: [] })));
        zip.addFile(`${other}/index.js`, Buffer.from(BENIGN_INDEX));
        const zipPath = newZipPath();
        zip.writeZip(zipPath);

        try {
            const r = await runPluginUpdate(SLUG, zipPath, { source: S1, catalogId: SLUG, version: '2.0.0' });

            assert.strictEqual(r.ok, false, 'a mismatched archive must be refused, not installed elsewhere');
            assert.strictEqual(r.status, 400);
            assert.strictEqual(r.body.intendedSlug, other);
            assert.strictEqual(r.body.expectedSlug, SLUG);
            // The plugin must be exactly as it was.
            assert.strictEqual(installedVersion(), '1.0.0', 'previous version still installed');
            assert.strictEqual(dataPreserved(), 'PRESERVE-ME', 'data/ survived');
            assert.strictEqual(await rowCount(), 1, 'plugin table survived');
            assert.strictEqual(fs.existsSync(path.join(PLUGINS_DIR, other)), false, 'nothing written to the other plugin');
        } finally {
            try { fs.rmSync(path.join(PLUGINS_DIR, other), { recursive: true, force: true }); } catch { /* */ }
        }
    });

    it('still refuses a version-suffixed root folder (dots are not a valid slug)', async () => {
        await installExisting({ version: '1.0.0', origin: { source: S1, catalogId: SLUG, version: '1.0.0' } });

        const zip = new AdmZip();
        zip.addFile(`${SLUG}-2.0.0/manifest.json`, Buffer.from(JSON.stringify({ name: 'Upd Test', isolated: true, version: '2.0.0', permissions: [] })));
        zip.addFile(`${SLUG}-2.0.0/index.js`, Buffer.from(BENIGN_INDEX));
        const zipPath = newZipPath();
        zip.writeZip(zipPath);

        const r = await runPluginUpdate(SLUG, zipPath, { source: S1, catalogId: SLUG, version: '2.0.0' });

        assert.strictEqual(r.ok, false);
        assert.strictEqual(installedVersion(), '1.0.0', 'previous version still installed');
        assert.strictEqual(dataPreserved(), 'PRESERVE-ME', 'data/ survived');
    });

    it('clearing a plugin origin lets the slug be re-bound to a different source', async () => {
        // DELETE used to leave the origin binding behind. The binding says "this slug may only be
        // updated from source X", so a slug re-installed later from somewhere else was permanently
        // un-updatable, with no UI to clear it.
        await installExisting({ version: '1.0.0', origin: { source: S1, catalogId: SLUG, version: '1.0.0' } });

        await assert.rejects(
            () => origins.assertUpdatableFrom(SLUG, { source: S2, catalogId: SLUG }),
            'a foreign source is refused while the binding stands'
        );

        await origins.removePluginOrigin(SLUG);

        assert.strictEqual((await getOption('plugin_origins', {}))[SLUG], undefined, 'binding removed from the option');
        // The slug is no longer BOUND TO S1 — that is the leak being fixed. It is still not updatable
        // out of nowhere (by design: no origin means "reinstall from the Marketplace to enable
        // updates"), so assert the refusal REASON changed from a takeover block to an unbound one.
        await assert.rejects(
            () => origins.assertUpdatableFrom(SLUG, { source: S2, catalogId: SLUG }),
            (e: any) => {
                assert.match(String(e.body && e.body.error), /no recorded install origin/i);
                assert.strictEqual(e.body.recordedOrigin, null, 'nothing left pointing at the old source');
                return true;
            }
        );
    });
});
