/**
 * RE-INSTALLING A SLUG ADOPTS A PREVIOUS INSTALLATION'S DATA ONLY ON AN EXPLICIT CHOICE.
 *
 * Uninstall-with-keep-data leaves plugins/<slug>/data/ and the wjp_<slug>_* tables. A later upload of
 * a zip with that slug must not reconnect to them silently: without `existingData` it answers 409
 * `existing_plugin_data` listing what it found and changes nothing; `existingData=adopt` keeps them
 * (the previous behaviour), `existingData=discard` removes them — but only once the new package has
 * passed validation, so a rejected zip leaves the previous state exactly as it was.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-existing-data-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const PLUGINS_DIR = path.join(TMP_ROOT, 'plugins');
const SLUG = 'kept-data';
const TABLE = 'wjp_kept_data_items';
const BENIGN_INDEX = "'use strict';\nmodule.exports = { register() {} };\n";

describe('re-upload over data a previous uninstall kept', () => {
    let request: any, app: any, adminToken: string, dbAsync: any;

    function zipBuffer({ valid = true } = {}): Buffer {
        const zip = new AdmZip();
        if (valid) zip.addFile(`${SLUG}/manifest.json`, Buffer.from(JSON.stringify({ name: SLUG, version: '2.0.0', isolated: true })));
        zip.addFile(`${SLUG}/index.js`, Buffer.from(BENIGN_INDEX));
        return zip.toBuffer();
    }
    const upload = (buf: Buffer, existingData?: string) => {
        const r = request(app).post('/api/v1/plugins/upload').set('Authorization', `Bearer ${adminToken}`);
        if (existingData !== undefined) r.field('existingData', existingData);
        return r.attach('plugin', buf, { filename: `${SLUG}.zip`, contentType: 'application/zip' });
    };
    const dataFile = () => path.join(PLUGINS_DIR, SLUG, 'data', 'secret.key');
    const tableExists = async () => !!(await dbAsync.get(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [TABLE]));
    const osTmpLeftovers = () => {
        try { return fs.readdirSync(path.join(TMP_ROOT, 'os-tmp')).filter((n: string) => n.startsWith('discard-')); } catch { return []; }
    };

    /** What uninstall-with-keep-data leaves: data/ alone in the plugin dir, and its tables. */
    async function leaveResidue({ data = true, table = true } = {}) {
        if (data) {
            fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
            fs.writeFileSync(dataFile(), 'PRESERVE-ME');
        }
        if (table) {
            await dbAsync.run(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY, v TEXT)`);
            await dbAsync.run(`INSERT INTO ${TABLE} (v) VALUES ('old row')`);
        }
    }

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();

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
        try { await database.closeDatabase(); } catch { /* */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    beforeEach(async () => {
        for (const entry of fs.readdirSync(PLUGINS_DIR)) {
            try { fs.rmSync(path.join(PLUGINS_DIR, entry), { recursive: true, force: true }); } catch { /* */ }
        }
        await dbAsync.run(`DROP TABLE IF EXISTS ${TABLE}`);
    });

    it('without a choice: 409 existing_plugin_data listing the data dir and the tables, nothing changed', async () => {
        await leaveResidue();
        const res = await upload(zipBuffer());
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'existing_plugin_data');
        assert.deepStrictEqual(res.body.data, { slug: SLUG, dataDir: true, tables: [TABLE] });
        assert.deepStrictEqual(fs.readdirSync(path.join(PLUGINS_DIR, SLUG)), ['data'], 'no code was extracted');
        assert.strictEqual(fs.readFileSync(dataFile(), 'utf8'), 'PRESERVE-ME');
        assert.ok(await tableExists());
    });

    it('tables alone (no directory left) are leftovers too', async () => {
        await leaveResidue({ data: false });
        const res = await upload(zipBuffer());
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.data, { slug: SLUG, dataDir: false, tables: [TABLE] });
        assert.strictEqual(fs.existsSync(path.join(PLUGINS_DIR, SLUG, 'manifest.json')), false);
    });

    it('an unknown choice is not a choice', async () => {
        await leaveResidue();
        const res = await upload(zipBuffer(), 'yes');
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'existing_plugin_data');
    });

    it('existingData=adopt installs and keeps the data and the tables', async () => {
        await leaveResidue();
        const res = await upload(zipBuffer(), 'adopt');
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.ok(fs.existsSync(path.join(PLUGINS_DIR, SLUG, 'manifest.json')));
        assert.strictEqual(fs.readFileSync(dataFile(), 'utf8'), 'PRESERVE-ME');
        assert.ok(await tableExists());
    });

    it('existingData=discard installs clean: the data dir and the tables are gone', async () => {
        await leaveResidue();
        const res = await upload(zipBuffer(), 'discard');
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.ok(fs.existsSync(path.join(PLUGINS_DIR, SLUG, 'manifest.json')));
        assert.strictEqual(fs.existsSync(path.join(PLUGINS_DIR, SLUG, 'data')), false, 'the previous data/ is gone');
        assert.strictEqual(await tableExists(), false, 'the previous tables are dropped');
        assert.deepStrictEqual(osTmpLeftovers(), [], 'nothing is left set aside in os-tmp');
    });

    it('existingData=discard with a package that fails validation leaves the previous data exactly as it was', async () => {
        await leaveResidue();
        const res = await upload(zipBuffer({ valid: false }), 'discard');
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.match(res.body.error, /manifest\.json/);
        assert.strictEqual(fs.readFileSync(dataFile(), 'utf8'), 'PRESERVE-ME', 'the data came back');
        assert.deepStrictEqual(fs.readdirSync(path.join(PLUGINS_DIR, SLUG)), ['data']);
        assert.ok(await tableExists(), 'the tables were not touched');
        assert.deepStrictEqual(osTmpLeftovers(), []);
    });

    it('CONTROL: a slug with no leftovers installs without any choice', async () => {
        const res = await upload(zipBuffer());
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    });
});
