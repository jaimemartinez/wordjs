/**
 * HOST-RESERVED PLUGIN SLUGS ARE REFUSED AT EVERY ENTRY POINT.
 *
 * `core` is the owner the host uses for its own admin-menu items; `theme-<x>` (and every spelling that
 * normalizes onto it: theme_x, Theme-X…) shares the route prefix, cookie namespace and table prefix of
 * the theme <x> (identity theme:<x>); `@…` is the host's registry namespace. One policy
 * (core/plugin-slug-policy.ts) is asked by the zip installer — which serves both POST /plugins/upload and
 * the marketplace install — and by the boot-time scan of plugins/, so a directory that reached the disk
 * some other way is never listed, activated or loaded.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

// Sandbox the CWD first: plugins/ resolves from it at module load.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-reserved-slugs-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const PLUGINS_DIR = path.join(TMP_ROOT, 'plugins');
const BENIGN_INDEX = "'use strict';\nmodule.exports = { register() {} };\n";
const MANIFEST = (slug: string) => JSON.stringify({ name: slug, version: '1.0.0', isolated: true });

describe('reserved plugin slugs', () => {
    let core: any, policy: any, installPluginFromZip: any, createInstallTmp: any;
    let request: any, app: any, adminToken: string;
    const tmps: Array<{ dispose: () => void }> = [];

    /** A zip with a single root folder `<root>/` (the slug), or files at the root when `flat`. */
    function zipBuffer(root: string, { flat = false } = {}): Buffer {
        const zip = new AdmZip();
        const pre = flat ? '' : `${root}/`;
        zip.addFile(`${pre}manifest.json`, Buffer.from(MANIFEST(root)));
        zip.addFile(`${pre}index.js`, Buffer.from(BENIGN_INDEX));
        return zip.toBuffer();
    }
    function zipFile(root: string, opts: { flat?: boolean } = {}): string {
        const tmp = createInstallTmp();
        tmps.push(tmp);
        fs.writeFileSync(tmp.zipPath, zipBuffer(root, opts));
        return tmp.zipPath;
    }
    const upload = (buf: Buffer, filename: string) => request(app)
        .post('/api/v1/plugins/upload')
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('plugin', buf, { filename, contentType: 'application/zip' });

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        const dbAsync = database.getDbAsync();
        core = require('../core/plugins');
        policy = require('../core/plugin-slug-policy');
        ({ installPluginFromZip, createInstallTmp } = require('../routes/plugins'));

        await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('admin', 'x', 'admin@example.com', 'Admin')`);
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
        for (const t of tmps) { try { t.dispose(); } catch { /* */ } }
        try { await database.closeDatabase(); } catch { /* */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    beforeEach(() => {
        for (const entry of fs.readdirSync(PLUGINS_DIR)) {
            try { fs.rmSync(path.join(PLUGINS_DIR, entry), { recursive: true, force: true }); } catch { /* */ }
        }
    });

    describe('the policy', () => {
        it('reserves core, the theme namespace in every normalized spelling, and @-names', () => {
            for (const slug of ['core', 'Core', 'CORE', 'theme', 'theme-acme', 'theme_acme', 'theme.acme', 'Theme-Acme', 'theme--acme', '@host', '@themes', '@scope']) {
                assert.ok(policy.isReservedPluginSlug(slug), `${slug} is reserved`);
            }
        });
        it('leaves ordinary slugs alone, including ones that merely contain the words', () => {
            for (const slug of ['acme', 'core-tools', 'mycore', 'themes-gallery', 'themer', 'my-theme-switcher', 'photo-carousel', 'conference-manager']) {
                assert.strictEqual(policy.reservedPluginSlugReason(slug), null, `${slug} is allowed`);
            }
        });
        it('fails closed on a non-string', () => {
            assert.ok(policy.isReservedPluginSlug(undefined));
            assert.ok(policy.isReservedPluginSlug(''));
        });
    });

    describe('POST /plugins/upload', () => {
        for (const slug of ['core', 'theme-acme', 'theme_acme', 'Theme-Acme']) {
            it(`refuses a zip whose root folder is '${slug}' (409 reserved_plugin_slug), writing nothing`, async () => {
                const res = await upload(zipBuffer(slug), `${slug}.zip`);
                assert.strictEqual(res.status, 409, JSON.stringify(res.body));
                assert.strictEqual(res.body.code, 'reserved_plugin_slug');
                assert.deepStrictEqual(fs.readdirSync(PLUGINS_DIR), [], 'no directory was created');
            });
        }
        it("refuses a files-at-root zip whose FILE name is 'core.zip'", async () => {
            const res = await upload(zipBuffer('core', { flat: true }), 'core.zip');
            assert.strictEqual(res.status, 409, JSON.stringify(res.body));
            assert.strictEqual(res.body.code, 'reserved_plugin_slug');
            assert.deepStrictEqual(fs.readdirSync(PLUGINS_DIR), []);
        });
        it('CONTROL: an ordinary slug still installs', async () => {
            const res = await upload(zipBuffer('acme-tools'), 'acme-tools.zip');
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.ok(fs.existsSync(path.join(PLUGINS_DIR, 'acme-tools', 'manifest.json')));
        });
    });

    describe('the shared installer (the marketplace install calls it too)', () => {
        it('refuses core and theme-* the same way', async () => {
            for (const slug of ['core', 'theme-acme']) {
                const res = await installPluginFromZip(zipFile(slug), `${slug}-1.0.0.zip`, undefined, 1);
                assert.strictEqual(res.status, 409, `${slug}: ${JSON.stringify(res.body)}`);
                assert.strictEqual(res.body.code, 'reserved_plugin_slug');
            }
            assert.deepStrictEqual(fs.readdirSync(PLUGINS_DIR), []);
        });
    });

    describe('boot-time scan of plugins/', () => {
        function writeRealPlugin(slug: string) {
            const dir = path.join(PLUGINS_DIR, slug);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'manifest.json'), MANIFEST(slug));
            fs.writeFileSync(path.join(dir, 'index.js'), BENIGN_INDEX);
        }

        it('never lists a directory with a reserved name, so it cannot be activated or loaded', async () => {
            for (const slug of ['core', 'theme-acme', 'theme_acme', '@scope', 'acme']) writeRealPlugin(slug);
            const listed = core.scanPlugins().map((p: any) => p.slug).sort();
            assert.deepStrictEqual(listed, ['acme']);
            assert.deepStrictEqual((await core.getAllPlugins()).map((p: any) => p.slug), ['acme']);
            await assert.rejects(core.activatePlugin('core'), /not found/);
            await assert.rejects(core.activatePlugin('theme-acme'), /not found/);
            assert.strictEqual(await core.loadOnePlugin('core'), false, 'a cross-node load of it is refused too');
        });
    });
});
