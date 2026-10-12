/**
 * WordJS — one-click in-place plugin UPDATE (runPluginUpdate) + boot recovery.
 *
 * Covers the security + data-safety core WITHOUT spawning a real isolate: every case uses an INACTIVE
 * plugin (wasActive=false), so runPluginUpdate exercises stash → uninstall-data → install → adopt the
 * stored grants → success/rollback with no child_process. Verified invariants:
 *   - data/ dir + wjp_<slug>_* tables + admin grants survive an update;
 *   - an update never rewrites the grants or the egress allowlist: on a node whose in-memory copy is stale
 *     (another node revoked a grant or narrowed the list), the stored record stays what that node stored
 *     and this node adopts it, on success and on rollback;
 *   - the one grant write an update makes: a plugin with NO grant record gets an empty one nobody decided,
 *     before anything moves — so the boot backfill cannot grant an active plugin what its NEW version
 *     declares, while a plugin never activated is still seeded on its first activation;
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

    // An existing grant record is handed back exactly as it was found (an empty one stays empty). A plugin
    // with NO record gets an empty one — the only grant write an update makes — and no administrator
    // decision with it: "no record" on an ACTIVE plugin is what the boot backfill reads as "grant it what
    // its manifest declares", and after an update that manifest is the new version's. Undecided, the empty
    // record is still seeded at the plugin's first activation (shouldSeedDeclaredGrants).
    const storedRecord = async () => {
        const blob = await require('../core/options').getOptionFresh('plugin_grants', {});
        return Object.prototype.hasOwnProperty.call(blob || {}, SLUG) ? blob[SLUG] : undefined;
    };

    it('a plugin with NO grant record gets an empty one nobody decided — from a successful update, and from one that rolled back', async () => {
        await installExisting({ version: '1.0.0', permissions: ['database:write'], origin: { source: S1, catalogId: SLUG, version: '1.0.0' } });
        assert.strictEqual(await storedRecord(), undefined, 'precondition: never activated, no grant record');

        const r = await runPluginUpdate(SLUG, buildZip({ version: '2.0.0', permissions: ['database:write'] }), { source: S1, catalogId: SLUG, version: '2.0.0' });
        assert.strictEqual(r.ok, true, r.body && r.body.error);
        assert.deepStrictEqual(await storedRecord(), [], 'the update left the plugin with no grant record for the boot backfill to fill');
        assert.strictEqual(perms.hasGrantRecord(SLUG), true, 'memory mirrors the stored record');
        assert.strictEqual(await perms.hasAdminGrantDecision(SLUG), false, 'an update is not an administrator\'s decision');

        // A failed update creates it too, before anything moved — what a crash half-way through leaves.
        await updateOption('plugin_grants', {});
        await perms.loadGrants();
        const bad = await runPluginUpdate(SLUG, buildZip({ version: '3.0.0', corrupt: true }), { source: S1, catalogId: SLUG, version: '3.0.0' });
        assert.strictEqual(bad.body.rolledBack, true);
        assert.deepStrictEqual(await storedRecord(), [], 'a failed update left no grant record');
        assert.strictEqual(await perms.hasAdminGrantDecision(SLUG), false);
    });

    it('control: an EMPTY grant record is still empty after an update', async () => {
        await installExisting({ version: '1.0.0', permissions: ['database:write'], grants: [], origin: { source: S1, catalogId: SLUG, version: '1.0.0' } });
        assert.deepStrictEqual(await storedRecord(), [], 'precondition');
        const r = await runPluginUpdate(SLUG, buildZip({ version: '2.0.0', permissions: ['database:write'] }), { source: S1, catalogId: SLUG, version: '2.0.0' });
        assert.strictEqual(r.ok, true, r.body && r.body.error);
        assert.deepStrictEqual(await storedRecord(), [], 'the empty grant record was lost in the update');
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

    // ── A NODE WHOSE COPY OF THE GRANTS IS STALE ────────────────────────────────────────────────
    // Each node keeps the grants and egress allowlists in memory, and a revoke made through another node
    // reaches the database, not that copy. The update cleared the stored record and wrote back THIS
    // node's copy, so an update served by a stale node re-granted the revoked `database:write` and replaced
    // a narrowed allowlist with an empty one — every public host.

    /** An option's value as the DATABASE holds it (not the option cache, not the in-memory copy). */
    async function dbStored(name: string): Promise<any> {
        const row = await dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', [name]);
        return row ? JSON.parse(row.option_value) : {};
    }
    /** Another node's write: the row changes; this node's option cache and in-memory copy do not. */
    async function otherNodeWrites(name: string, mutate: (value: any) => void): Promise<void> {
        const value = await dbStored(name);
        mutate(value);
        await dbAsync.run('UPDATE options SET option_value = ? WHERE option_name = ?', [JSON.stringify(value), name]);
    }
    /** Installed with database:write + settings:read and no list; then another node revokes and narrows. */
    async function staleNodeSetup() {
        await installExisting({ version: '1.0.0', permissions: ['settings:read', 'database:write', 'network'], grants: ['settings:read', 'database:write', 'network'], origin: { source: S1, catalogId: SLUG, version: '1.0.0' } });
        await getOption('plugin_grants', {}); // this node has read both since: its option cache holds them too
        await getOption('plugin_egress_hosts', {});
        await otherNodeWrites('plugin_grants', (v) => { v[SLUG] = ['settings:read', 'network']; });
        await otherNodeWrites('plugin_egress_hosts', (v) => { v[SLUG] = ['api.example.com']; });
        assert.deepStrictEqual(perms.getGrants(SLUG).sort(), ['database:write', 'network', 'settings:read'], 'precondition: this node\'s copy is stale');
        assert.deepStrictEqual(perms.getEgressAllowlist(SLUG), [], 'precondition: this node\'s copy has no list (every public host)');
    }

    it('an update served by a stale node keeps the revoke and the narrowed egress list another node stored', async () => {
        await staleNodeSetup();
        const zip = buildZip({ version: '2.0.0', permissions: ['settings:read', 'database:write', 'network'] });

        const r = await runPluginUpdate(SLUG, zip, { source: S1, catalogId: SLUG, version: '2.0.0' });

        assert.strictEqual(r.ok, true, r.body && r.body.error);
        assert.strictEqual(installedVersion(), '2.0.0');
        assert.deepStrictEqual((await dbStored('plugin_grants'))[SLUG], ['settings:read', 'network'], 'the revoke of database:write stands');
        assert.deepStrictEqual((await dbStored('plugin_egress_hosts'))[SLUG], ['api.example.com'], 'the narrowed egress list stands');
        // What this node would start the plugin with is the stored record, not its stale copy.
        assert.deepStrictEqual(perms.getGrants(SLUG).sort(), ['network', 'settings:read'], 'this node adopted the stored grants');
        assert.deepStrictEqual(perms.getEgressAllowlist(SLUG), ['api.example.com'], 'this node adopted the stored egress list');
        assert.strictEqual(perms.isGranted(SLUG, 'database', 'write'), false, 'the revoked grant is not usable here');
        assert.deepStrictEqual(r.body.ungrantedPermissions, ['database:write'], 'reported as declared and not granted');
    });

    it('a rolled-back update on a stale node writes nothing back either', async () => {
        await staleNodeSetup();
        const badZip = buildZip({ version: '2.0.0', corrupt: true });

        const r = await runPluginUpdate(SLUG, badZip, { source: S1, catalogId: SLUG, version: '2.0.0' });

        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.body.rolledBack, true);
        assert.strictEqual(installedVersion(), '1.0.0', 'old code restored');
        assert.deepStrictEqual((await dbStored('plugin_grants'))[SLUG], ['settings:read', 'network'], 'the revoke of database:write stands');
        assert.deepStrictEqual((await dbStored('plugin_egress_hosts'))[SLUG], ['api.example.com'], 'the narrowed egress list stands');
    });

    it('a missing grant record becomes an empty, undecided one that the first activation still seeds; no egress record is written', async () => {
        // No grant or egress record at all (installed, never activated). The update stores an empty grant
        // record with NO administrator decision, so it is not read as "an administrator revoked
        // everything": the first activation still grants what the plugin declares. The egress allowlist
        // is not written (no list and an empty list mean the same: every public host).
        await installExisting({ version: '1.0.0', permissions: ['settings:read'], origin: { source: S1, catalogId: SLUG, version: '1.0.0' } });
        const zip = buildZip({ version: '2.0.0', permissions: ['settings:read', 'database:write'] });

        const r = await runPluginUpdate(SLUG, zip, { source: S1, catalogId: SLUG, version: '2.0.0' });

        assert.strictEqual(r.ok, true, r.body && r.body.error);
        assert.deepStrictEqual((await dbStored('plugin_grants'))[SLUG], [], 'an empty grant record was stored');
        assert.strictEqual(await perms.hasAdminGrantDecision(SLUG), false, 'with no administrator decision');
        assert.strictEqual(Object.hasOwn(await dbStored('plugin_egress_hosts'), SLUG), false, 'no egress record was written');
        // The first activation (the activation route asks exactly these two) still seeds the new declared set.
        assert.strictEqual((await perms.adoptStoredPolicy(SLUG)).seedsDeclaredGrants, true, 'the first activation would not seed the declared grants');
        assert.strictEqual(await perms.seedGrants(SLUG, ['settings:read', 'database:write'], { adminDecision: true }), true);
        assert.deepStrictEqual([...(await dbStored('plugin_grants'))[SLUG]].sort(), ['database:write', 'settings:read']);
    });

    it('restart after an update: the boot backfill grants an ACTIVE plugin nothing its new version declares', async () => {
        // Activated while it declared nothing, so it holds no grant record (grant-on-activate persists only
        // a non-empty seed); then updated to a version that declares network and database:write. Every
        // boot runs loadGrants → backfillActive over the ACTIVE plugins, which grants a plugin with no
        // record whatever its manifest on disk — the new version's — declares.
        await installExisting({ version: '1.0.0', origin: { source: S1, catalogId: SLUG, version: '1.0.0' } });
        assert.strictEqual(await storedRecord(), undefined, 'precondition: no grant record');
        const r = await runPluginUpdate(SLUG, buildZip({ version: '2.0.0', permissions: ['network', 'database:write'] }), { source: S1, catalogId: SLUG, version: '2.0.0' });
        assert.strictEqual(r.ok, true, r.body && r.body.error);
        assert.deepStrictEqual([...r.body.ungrantedPermissions].sort(), ['database:write', 'network'], 'reported as declared and not granted');

        // The plugin is active when the server restarts (the update reactivates a plugin that was running).
        await updateOption('active_plugins', [SLUG]);
        await perms.loadGrants();
        const core = require('../core/plugins');
        const all: any[] = await core.getAllPlugins();
        const active: string[] = await core.getActivePlugins();
        const entries = all.filter((p: any) => active.includes(p.slug)).map((p: any) => ({
            slug: p.slug,
            requested: Array.from(new Set((p.permissions || [])
                .map((perm: any) => (perm && perm.scope) ? (perm.scope === 'network' ? 'network' : `${perm.scope}:${perm.access || 'read'}`) : null)
                .filter(Boolean))) as string[],
        }));
        assert.deepStrictEqual(entries.find((e) => e.slug === SLUG)?.requested.sort(), ['database:write', 'network'], 'precondition: the boot reads the new manifest');
        await perms.backfillActive(entries);

        assert.deepStrictEqual((await dbStored('plugin_grants'))[SLUG], [], 'the restart granted what the new version declares');
        assert.deepStrictEqual(perms.getGrants(SLUG), []);
        assert.strictEqual(perms.isNetworkGranted(SLUG), false);
        assert.strictEqual(perms.isGranted(SLUG, 'database', 'write'), false);
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
