/**
 * ORPHANED ACTIVE PLUGINS — one definition, three surfaces that used to disagree.
 *
 * `plugins/<slug>/` can be left holding only build output (a `dist/`, no manifest.json, no entry file)
 * while the `active_plugins` option still names <slug>. Before the fix:
 *
 *   · scanPlugins()/getAllPlugins() skipped it, so GET /plugins never showed it and the marketplace
 *     card offered Install;
 *   · installPluginFromZip refused with 409 "currently active. Deactivate it before re-uploading",
 *     because isPluginActive() reads the option alone — about a plugin no screen could show;
 *   · the boot loop just `continue`d, so the contradiction outlived every restart.
 *
 * These cases pin the single notion that reconciles them, and — just as importantly — the two things
 * it must NOT do: delete a real plugin's files, or let an install overwrite a genuinely running one.
 *
 * IMPORTANT ordering (copied from plugin-theme-install.test.ts): PLUGINS_DIR is `path.resolve('./plugins')`,
 * resolved from the CWD at module load, so we chdir into a temp root BEFORE requiring anything that
 * transitively loads core/plugins. node --test runs each file in its own process, so nothing leaks.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

// 1. Sandbox the process CWD FIRST (plugins/ resolves from it at module load).
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-orphan-plugins-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer / routers load.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const PLUGINS_DIR = path.join(TMP_ROOT, 'plugins');
const BENIGN_INDEX = "'use strict';\nmodule.exports = { register() {} };\n";

const dirOf = (slug: string) => path.join(PLUGINS_DIR, slug);

/** A REAL, loadable plugin on disk (manifest + entry file) — the thing nothing may ever delete. */
function writeRealPlugin(slug: string, { version = '1.0.0' } = {}) {
    const dir = dirOf(slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: slug, version, isolated: true }));
    fs.writeFileSync(path.join(dir, 'index.js'), BENIGN_INDEX);
    return dir;
}

/** THE DEFECT ON DISK: a directory holding only build output. No manifest, no entry file. */
function writeDistOnlyResidue(slug: string, { withData = false } = {}) {
    const dir = dirOf(slug);
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), '/* build output */\n');
    if (withData) {
        fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'data', 'secret.key'), 'PRESERVE-ME');
    }
    return dir;
}

function rmSlug(slug: string) {
    try { fs.rmSync(dirOf(slug), { recursive: true, force: true }); } catch { /* */ }
}

describe('orphaned active plugins', () => {
    let core: any;
    let getOption: any, updateOption: any;
    let installPluginFromZip: any, createInstallTmp: any;
    let request: any, app: any, adminToken: string;
    let dbAsync: any;

    const installTmps: Array<{ dispose: () => void }> = [];
    function buildZip(slug: string, { version = '2.0.0' } = {}): string {
        const zip = new AdmZip();
        zip.addFile(`${slug}/manifest.json`, Buffer.from(JSON.stringify({ name: slug, version, isolated: true })));
        zip.addFile(`${slug}/index.js`, Buffer.from(BENIGN_INDEX));
        const tmp = createInstallTmp();
        installTmps.push(tmp);
        zip.writeZip(tmp.zipPath);
        return tmp.zipPath;
    }

    const active = async (): Promise<string[]> => (await getOption('active_plugins', [])) as string[];
    const noticeIds = async (): Promise<string[]> =>
        ((await getOption('admin_notices', [])) as any[]).map((n: any) => n && n.id);
    const noticeById = async (id: string) =>
        ((await getOption('admin_notices', [])) as any[]).find((n: any) => n && n.id === id) || null;
    const auditActions = async (target: string): Promise<string[]> =>
        (await dbAsync.all('SELECT action FROM audit_log WHERE target_id = ? ORDER BY id', [target])).map((r: any) => r.action);

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();

        core = require('../core/plugins');
        ({ getOption, updateOption } = require('../core/options'));
        ({ installPluginFromZip, createInstallTmp } = require('../routes/plugins'));

        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@example.com', 'Administrator']
        );
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [admin.id]);
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use('/api/v1/plugins', require('../routes/plugins'));
        app.use(errorHandler);
    });

    after(async () => {
        for (const t of installTmps) { try { t.dispose(); } catch { /* */ } }
        try { await database.closeDatabase(); } catch { /* */ }
        // Windows refuses to remove the CWD — step out of the temp root first.
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    beforeEach(async () => {
        for (const entry of fs.readdirSync(PLUGINS_DIR)) {
            try { fs.rmSync(path.join(PLUGINS_DIR, entry), { recursive: true, force: true }); } catch { /* */ }
        }
        await updateOption('active_plugins', []);
        await updateOption('admin_notices', []);
    });

    // ───────────────────────────────────────────────────────────────────────────────────────────────
    // THE DEFINITION
    // ───────────────────────────────────────────────────────────────────────────────────────────────

    describe('listOrphanedPlugins — what counts as orphaned', () => {
        it('a dist-only directory listed active is an orphan, and scanPlugins/getAllPlugins still skip it', async () => {
            writeDistOnlyResidue('ghost');
            await updateOption('active_plugins', ['ghost']);

            // The premise of the whole bug: the two authorities disagree.
            assert.deepStrictEqual(core.scanPlugins().map((p: any) => p.slug), [], 'scanPlugins does not list it');
            assert.deepStrictEqual((await core.getAllPlugins()).map((p: any) => p.slug), [],
                'getAllPlugins keeps its contract — no entry with no files');
            assert.strictEqual(await core.isPluginActive('ghost'), true, 'the option still claims it');

            const orphans = await core.listOrphanedPlugins();
            assert.deepStrictEqual(orphans.map((o: any) => o.slug), ['ghost']);
            assert.strictEqual(orphans[0].active, true);
            assert.strictEqual(orphans[0].hasDirectory, true);
            assert.strictEqual(orphans[0].residual, true, 'no manifest and no entry file → safe to remove');
            assert.strictEqual(orphans[0].reason, 'no-manifest');
        });

        it('an active slug with no directory at all is an orphan, and is never "residual"', async () => {
            await updateOption('active_plugins', ['vanished']);
            const [o] = await core.listOrphanedPlugins();
            assert.strictEqual(o.slug, 'vanished');
            assert.strictEqual(o.reason, 'missing');
            assert.strictEqual(o.hasDirectory, false);
            assert.strictEqual(o.residual, false, 'there is nothing on disk to call removable');
        });

        it('a real plugin is never an orphan — active or not', async () => {
            writeRealPlugin('real-one');
            assert.deepStrictEqual(await core.listOrphanedPlugins(), []);
            await updateOption('active_plugins', ['real-one']);
            assert.deepStrictEqual(await core.listOrphanedPlugins(), []);
        });

        it('a manifest-less LEGACY plugin (index.js only) is loadable, so it is not an orphan', async () => {
            fs.mkdirSync(dirOf('legacy'), { recursive: true });
            fs.writeFileSync(path.join(dirOf('legacy'), 'index.js'), BENIGN_INDEX);
            assert.deepStrictEqual(core.scanPlugins().map((p: any) => p.slug), ['legacy'], 'scanPlugins lists it');
            assert.deepStrictEqual(await core.listOrphanedPlugins(), []);
        });

        it('a data/-only directory is the INTENDED uninstall residue — reported only when the option claims it', async () => {
            fs.mkdirSync(path.join(dirOf('uninstalled'), 'data'), { recursive: true });
            fs.writeFileSync(path.join(dirOf('uninstalled'), 'data', 'secret.key'), 'PRESERVE-ME');

            assert.deepStrictEqual(await core.listOrphanedPlugins(), [],
                'a successful uninstall must not leave a red card behind');

            await updateOption('active_plugins', ['uninstalled']);
            const [o] = await core.listOrphanedPlugins();
            assert.strictEqual(o.slug, 'uninstalled', 'listed active with no code IS a contradiction');
            assert.strictEqual(o.residual, true);
        });

        it('an UNREADABLE manifest is an orphan whose files are NOT removable', async () => {
            const dir = dirOf('broken-manifest');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'manifest.json'), '{ this is not json');
            fs.writeFileSync(path.join(dir, 'index.js'), BENIGN_INDEX);
            await updateOption('active_plugins', ['broken-manifest']);

            const [o] = await core.listOrphanedPlugins();
            assert.strictEqual(o.reason, 'unreadable-manifest');
            assert.strictEqual(o.residual, false, "a broken plugin's code is still someone's work");
        });
    });

    // ───────────────────────────────────────────────────────────────────────────────────────────────
    // BOOT
    // ───────────────────────────────────────────────────────────────────────────────────────────────

    describe('boot reconciliation', () => {
        it('prunes the stale entry, keeps the real one, and raises one persistent notice per slug', async () => {
            writeRealPlugin('real-one');
            writeDistOnlyResidue('ghost');
            await updateOption('active_plugins', ['real-one', 'ghost']);

            const pruned = await core.pruneOrphanedActivePlugins();

            assert.deepStrictEqual(pruned.map((o: any) => o.slug), ['ghost']);
            assert.deepStrictEqual(await active(), ['real-one'], 'the option was written, the real plugin kept');
            assert.strictEqual(await core.isPluginActive('ghost'), false, 'no guard can call it active any more');

            const notice = await noticeById('plugins.orphaned-active.ghost');
            assert.ok(notice, 'a persistent admin notice was raised');
            assert.match(notice.message, /was marked active but its files are missing/);
            assert.match(notice.message, /reinstall it from the Marketplace/);
            assert.strictEqual(notice.type, 'warning');
            assert.strictEqual(notice.dismissible, true);
        });

        it('the prune leaves the FILES alone — it only reconciles the option', async () => {
            writeDistOnlyResidue('ghost');
            await updateOption('active_plugins', ['ghost']);
            await core.pruneOrphanedActivePlugins();
            assert.ok(fs.existsSync(path.join(dirOf('ghost'), 'dist', 'bundle.js')),
                'deleting from disk is the install/cleanup path\'s job, never boot\'s');
        });

        it('a healthy site writes nothing at all — no option churn, no notice', async () => {
            writeRealPlugin('real-one');
            await updateOption('active_plugins', ['real-one']);
            await updateOption('admin_notices', []);

            const pruned = await core.pruneOrphanedActivePlugins();

            assert.deepStrictEqual(pruned, []);
            assert.deepStrictEqual(await active(), ['real-one']);
            assert.deepStrictEqual(await noticeIds(), []);
        });

        it('the notice is idempotent across restarts (one row per slug, original timestamp kept)', async () => {
            writeDistOnlyResidue('ghost');
            await updateOption('active_plugins', ['ghost']);
            await core.pruneOrphanedActivePlugins();
            const first = await noticeById('plugins.orphaned-active.ghost');

            // A second "boot" that finds the same state (the slug re-added by some other path).
            await updateOption('active_plugins', ['ghost']);
            await core.pruneOrphanedActivePlugins();

            const ids = (await noticeIds()).filter((id: string) => id === 'plugins.orphaned-active.ghost');
            assert.strictEqual(ids.length, 1, 'a hundred restarts must leave ONE row');
            assert.strictEqual((await noticeById('plugins.orphaned-active.ghost')).timestamp, first.timestamp,
                'the condition is the same one — re-dating it would sort an old fault to the top');
        });

        it('the notice retires itself once the plugin is loadable again', async () => {
            writeDistOnlyResidue('ghost');
            await updateOption('active_plugins', ['ghost']);
            await core.pruneOrphanedActivePlugins();
            assert.ok(await noticeById('plugins.orphaned-active.ghost'));

            rmSlug('ghost');
            writeRealPlugin('ghost'); // the admin reinstalled it
            const retired = await core.retireResolvedOrphanNotices();

            assert.deepStrictEqual(retired, ['ghost']);
            assert.strictEqual(await noticeById('plugins.orphaned-active.ghost'), null,
                'a panel that contradicts the fix it demanded teaches the operator to ignore it');
        });

        it('loadActivePlugins() runs the reconciliation — the boot surface, not just the helper', async () => {
            // The loop that used to `continue` past an unresolvable slug is what made the state
            // permanent, so the call has to be IN loadActivePlugins, not merely available next to it.
            const src = fs.readFileSync(path.resolve(__dirname, '..', 'core', 'plugins.ts'), 'utf8');
            const body = src.slice(src.indexOf('async function loadActivePlugins()'));
            assert.match(body.slice(0, 2000), /pruneOrphanedActivePlugins\s*\(/);
            assert.match(body.slice(0, 2000), /retireResolvedOrphanNotices\s*\(/);

            // …and it really reconciles when called (no active plugin to load → no isolate is spawned).
            writeDistOnlyResidue('ghost');
            await updateOption('active_plugins', ['ghost']);
            await core.loadActivePlugins();
            assert.deepStrictEqual(await active(), []);
        });
    });

    // ───────────────────────────────────────────────────────────────────────────────────────────────
    // INSTALL
    // ───────────────────────────────────────────────────────────────────────────────────────────────

    describe('installing over an orphan', () => {
        it('succeeds, drops the stale entry, removes the residue and records the audit row', async () => {
            writeDistOnlyResidue('ghost');
            await updateOption('active_plugins', ['ghost']);

            const res = await installPluginFromZip(buildZip('ghost'), 'ghost.zip', undefined, 1);

            assert.strictEqual(res.ok, true, res.body && res.body.error);
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(await active(), [], 'the stale entry is gone');
            assert.strictEqual(fs.existsSync(path.join(dirOf('ghost'), 'dist')), false, 'the residue is gone');
            assert.ok(fs.existsSync(path.join(dirOf('ghost'), 'manifest.json')), 'the new code is in place');
            assert.deepStrictEqual((await core.getAllPlugins()).map((p: any) => p.slug), ['ghost'],
                'and it is a real plugin now — the Instalados tab shows it');
            assert.deepStrictEqual(await core.listOrphanedPlugins(), []);
            assert.ok((await auditActions('ghost')).includes('plugin.orphan_reclaim'), 'the reclaim is audited');
        });

        it('preserves the orphan directory\'s data/ (the reinstall reconnects with it)', async () => {
            writeDistOnlyResidue('ghost', { withData: true });
            await updateOption('active_plugins', ['ghost']);

            const res = await installPluginFromZip(buildZip('ghost'), 'ghost.zip', undefined, 1);

            assert.strictEqual(res.ok, true, res.body && res.body.error);
            assert.strictEqual(fs.readFileSync(path.join(dirOf('ghost'), 'data', 'secret.key'), 'utf8'), 'PRESERVE-ME');
        });

        it('NEGATIVE CONTROL — a genuinely RUNNING plugin is still refused, and untouched', async () => {
            writeRealPlugin('real-one', { version: '1.0.0' });
            await updateOption('active_plugins', ['real-one']);

            const res = await installPluginFromZip(buildZip('real-one', { version: '9.9.9' }), 'real-one.zip', undefined, 1);

            assert.strictEqual(res.ok, false);
            assert.strictEqual(res.status, 409);
            assert.match(res.body.error, /currently active/);
            assert.deepStrictEqual(await active(), ['real-one'], 'the active entry survives');
            assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dirOf('real-one'), 'manifest.json'), 'utf8')).version,
                '1.0.0', 'the running code was not overwritten');
        });

        it('NEGATIVE CONTROL — a real INACTIVE plugin directory is refused and never deleted', async () => {
            writeRealPlugin('real-one', { version: '1.0.0' });

            const res = await installPluginFromZip(buildZip('real-one', { version: '9.9.9' }), 'real-one.zip', undefined, 1);

            assert.strictEqual(res.ok, false);
            assert.strictEqual(res.status, 409);
            assert.match(res.body.error, /already exists/);
            assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dirOf('real-one'), 'manifest.json'), 'utf8')).version, '1.0.0');
            assert.ok(fs.existsSync(path.join(dirOf('real-one'), 'index.js')), 'its code is still there');
        });

        it('NEGATIVE CONTROL — a broken-manifest orphan is unblocked but its FILES are never removed', async () => {
            const dir = dirOf('broken-manifest');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'manifest.json'), '{ this is not json');
            fs.writeFileSync(path.join(dir, 'index.js'), BENIGN_INDEX);
            await updateOption('active_plugins', ['broken-manifest']);

            const res = await installPluginFromZip(buildZip('broken-manifest'), 'broken-manifest.zip', undefined, 1);

            // The dead end is gone (no more "deactivate something you cannot see") …
            assert.deepStrictEqual(await active(), [], 'the stale entry was dropped');
            // … but the refusal that protects real files stands, and the files are intact.
            assert.strictEqual(res.ok, false);
            assert.strictEqual(res.status, 409);
            assert.match(res.body.error, /already exists/);
            assert.strictEqual(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), BENIGN_INDEX);
            assert.strictEqual(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), '{ this is not json');
        });
    });

    // ───────────────────────────────────────────────────────────────────────────────────────────────
    // THE ADMIN'S DOORS
    // ───────────────────────────────────────────────────────────────────────────────────────────────

    describe('GET /plugins — the admin can finally SEE it', () => {
        it('projects the orphan with broken:true and active:false, next to the real plugins', async () => {
            writeRealPlugin('real-one');
            writeDistOnlyResidue('ghost');
            await updateOption('active_plugins', ['real-one', 'ghost']);

            const res = await request(app).get('/api/v1/plugins').set('Authorization', `Bearer ${adminToken}`);

            assert.strictEqual(res.status, 200);
            const ghost = res.body.find((p: any) => p.slug === 'ghost');
            assert.ok(ghost, 'the Instalados tab now has something to render');
            assert.strictEqual(ghost.broken, true);
            assert.strictEqual(ghost.brokenReason, 'no-manifest');
            assert.strictEqual(ghost.wasActive, true);
            assert.strictEqual(ghost.removable, true);
            assert.strictEqual(ghost.active, false, 'never active — nothing may treat it as running');

            const real = res.body.find((p: any) => p.slug === 'real-one');
            assert.strictEqual(real.active, true);
            assert.strictEqual(real.broken, undefined, 'a healthy row is unchanged');
        });

        it('GET /plugins/active still lists only what can run', async () => {
            writeRealPlugin('real-one');
            writeDistOnlyResidue('ghost');
            await updateOption('active_plugins', ['real-one', 'ghost']);

            const res = await request(app).get('/api/v1/plugins/active');
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(res.body, ['real-one'],
                'the registry generators and the frontend loader must never see an orphan');
        });
    });

    describe('POST /plugins/:slug/deactivate — "Quitar restos"', () => {
        it('clears the stale entry, removes the residue and says so', async () => {
            writeDistOnlyResidue('ghost');
            await updateOption('active_plugins', ['ghost']);

            const res = await request(app)
                .post('/api/v1/plugins/ghost/deactivate')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({});

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.orphaned, true);
            assert.strictEqual(res.body.residueRemoved, true);
            assert.deepStrictEqual(await active(), []);
            assert.strictEqual(fs.existsSync(dirOf('ghost')), false, 'nothing left behind');
            assert.deepStrictEqual(await core.listOrphanedPlugins(), []);
            assert.ok((await auditActions('ghost')).includes('plugin.orphan_reclaim'));
        });

        it('keeps data/ while removing the code residue around it', async () => {
            writeDistOnlyResidue('ghost', { withData: true });
            await updateOption('active_plugins', ['ghost']);

            const res = await request(app)
                .post('/api/v1/plugins/ghost/deactivate')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({});

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.residueRemoved, true);
            assert.strictEqual(fs.existsSync(path.join(dirOf('ghost'), 'dist')), false);
            assert.strictEqual(fs.readFileSync(path.join(dirOf('ghost'), 'data', 'secret.key'), 'utf8'), 'PRESERVE-ME',
                'encryption keys survive a cleanup, exactly as they survive an uninstall');
        });

        it('an active slug with NO directory is cleared without touching anything', async () => {
            await updateOption('active_plugins', ['vanished']);

            const res = await request(app)
                .post('/api/v1/plugins/vanished/deactivate')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({});

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.orphaned, true);
            assert.strictEqual(res.body.residueRemoved, false);
            assert.deepStrictEqual(await active(), []);
        });

        it('a broken-manifest orphan is unlisted but its files are LEFT ALONE, and the answer says so', async () => {
            const dir = dirOf('broken-manifest');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'manifest.json'), '{ this is not json');
            fs.writeFileSync(path.join(dir, 'index.js'), BENIGN_INDEX);
            await updateOption('active_plugins', ['broken-manifest']);

            const res = await request(app)
                .post('/api/v1/plugins/broken-manifest/deactivate')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({});

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.residueRemoved, false);
            assert.match(res.body.message, /still holds files/);
            assert.ok(fs.existsSync(path.join(dir, 'index.js')));
        });

        it('a REAL inactive plugin is not an orphan — deactivate leaves its directory alone', async () => {
            writeRealPlugin('real-one');

            const res = await request(app)
                .post('/api/v1/plugins/real-one/deactivate')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({});

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.orphaned, undefined, 'no orphan handling for a real plugin');
            assert.ok(fs.existsSync(path.join(dirOf('real-one'), 'index.js')), 'its code is untouched');
            assert.ok((await auditActions('real-one')).includes('plugin.deactivate'));
        });
    });
});
