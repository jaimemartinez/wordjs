/**
 * UPDATING A PLUGIN NEVER MEANS UNINSTALLING IT (POST /marketplace/adopt).
 *
 * The owner's question: "why does updating a plugin require uninstalling it?". An installed plugin whose
 * recorded origin is not the catalog entry's source (uploaded by zip, installed before origins were
 * recorded, or from another catalog) used to show "uninstall it first". The origin binding exists so
 * another source cannot take a plugin over together with its approved permissions and its data/ — so the
 * route that replaces the uninstall keeps that: the catalog says which path applies (applyMode), a source
 * change must be confirmed and must say whether to keep the data, the permissions come from the consent
 * sent with the request (never replayed), an API token cannot grant through it, and every attempt is
 * audited with the previous and new source and grants.
 *
 * The catalog here is a LOCAL source (a directory with marketplace-index.json + the zip), so its mode is
 * always 'reinstall'; the official-catalog 'adopt' path is covered by plugin-update.test.ts at the core.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const AdmZip = require('adm-zip');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-mkt-adopt-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const roles = require('../core/roles');
const { updateOption } = require('../core/options');
const { csrfProtection } = require('../middleware/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const B = config.api.prefix;
const SECRET = config.jwt.secret;
const SLUG = `wjs-adopt-${process.pid}`;
const OLD_SOURCE = 'https://catalog.one/download';
const BENIGN_INDEX = "'use strict';\nmodule.exports = { init() {} };\n";

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(B, csrfProtection);
app.use(B, require('../routes'));

let dbAsync: any, core: any, perms: any, origins: any;
let adminId = 0;
let token = '';
let catalogDir = '';
const session = () => `Bearer ${jwt.sign({ userId: adminId, username: 'owner' }, SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
const pluginDir = () => path.join(core.PLUGINS_DIR, SLUG);
const perm = (t: string) => ({ scope: t.split(':')[0], access: t.split(':')[1] });

function installOld() {
    fs.rmSync(pluginDir(), { recursive: true, force: true });
    fs.mkdirSync(path.join(pluginDir(), 'data'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir(), 'manifest.json'), JSON.stringify({ name: SLUG, version: '1.0.0', isolated: true, permissions: [perm('database:write')] }));
    fs.writeFileSync(path.join(pluginDir(), 'index.js'), BENIGN_INDEX);
    fs.writeFileSync(path.join(pluginDir(), 'data', 'secret.key'), 'PRESERVE-ME');
}

const adopt = (auth: string, body: any) => request(app).post(`${B}/marketplace/adopt`).set('Authorization', auth).send(body);
const lastAudit = async () => {
    const row = await dbAsync.get(`SELECT action, detail FROM audit_log WHERE target_id = ? ORDER BY id DESC LIMIT 1`, [SLUG]);
    return row ? { action: row.action, detail: JSON.parse(row.detail || '{}') } : null;
};

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    core = require('../core/plugins');
    perms = require('../core/plugin-permissions');
    origins = require('../core/plugin-origins');
    await perms.loadGrants();
    await perms.loadEgressHosts();

    const r = await dbAsync.run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
        ['owner', bcrypt.hashSync('Correct-Horse-9!', 10), 'owner@example.com', 'owner']);
    adminId = r.lastID;
    await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')", [adminId]);
    const minted = await request(app).post(`${B}/auth/tokens`).set('Authorization', session()).send({ name: 'ci', scopes: 'write' });
    assert.strictEqual(minted.status, 201, JSON.stringify(minted.body));
    token = minted.body.token;

    // A local catalog listing version 2.0.0 of the plugin.
    catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-mkt-adopt-cat-'));
    const zip = new AdmZip();
    zip.addFile(`${SLUG}/manifest.json`, Buffer.from(JSON.stringify({ name: SLUG, version: '2.0.0', isolated: true, permissions: [perm('database:write'), perm('settings:read')] })));
    zip.addFile(`${SLUG}/index.js`, Buffer.from(BENIGN_INDEX));
    const file = `${SLUG}-2.0.0.zip`;
    const buf = zip.toBuffer();
    fs.writeFileSync(path.join(catalogDir, file), buf);
    fs.writeFileSync(path.join(catalogDir, 'marketplace-index.json'), JSON.stringify({ plugins: [{
        id: SLUG, name: SLUG, version: '2.0.0', description: '', author: '', category: 'General', file, size: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'), permissions: [perm('database:write'), perm('settings:read')],
    }] }));
    await updateOption('marketplace_sources', [catalogDir]);

    installOld();
    await perms.setGrants(SLUG, ['database:write']);
    await origins.setPluginOrigin(SLUG, { source: OLD_SOURCE, catalogId: SLUG, version: '1.0.0' });
});

after(async () => {
    try { fs.rmSync(pluginDir(), { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(catalogDir, { recursive: true, force: true }); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
});

describe('POST /marketplace/adopt', () => {
    it('the catalog tells the screen which path applies: another source is a reinstall, not an update', async () => {
        const res = await request(app).get(`${B}/marketplace/catalog?refresh=1`).set('Authorization', session());
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const e = res.body.plugins.find((p: any) => p.id === SLUG);
        assert.strictEqual(e.updateAvailable, true);
        assert.strictEqual(e.updatable, false);
        assert.strictEqual(e.applyMode, 'reinstall');
        assert.strictEqual(e.installedFrom, OLD_SOURCE);
    });

    it('a source change must say whether to keep the data, and must be confirmed; the plain update still refuses it', async () => {
        const noChoice = await adopt(session(), { id: SLUG, mode: 'reinstall', grants: [], confirmSourceChange: true });
        assert.strictEqual(noChoice.status, 400);
        assert.strictEqual(noChoice.body.code, 'keepDataRequired');

        const unconfirmed = await adopt(session(), { id: SLUG, mode: 'reinstall', grants: [], keepData: true });
        assert.strictEqual(unconfirmed.status, 400);
        assert.strictEqual(unconfirmed.body.code, 'sourceChangeNotConfirmed');

        const wrongMode = await adopt(session(), { id: SLUG, mode: 'adopt', grants: [] });
        assert.strictEqual(wrongMode.status, 409, 'a local source is never the official catalog');
        assert.strictEqual(wrongMode.body.code, 'modeMismatch');

        const plain = await request(app).post(`${B}/marketplace/update`).set('Authorization', session()).send({ id: SLUG });
        assert.strictEqual(plain.status, 409);
        assert.strictEqual(plain.body.code, 'originMismatch');

        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pluginDir(), 'manifest.json'), 'utf8')).version, '1.0.0', 'nothing changed');
        assert.deepStrictEqual(perms.getGrants(SLUG), ['database:write']);
    });

    it('malformed fields are refused before anything is read', async () => {
        for (const body of [
            { id: SLUG, mode: 'takeover', grants: [] },
            { id: SLUG, mode: 'reinstall', grants: 'database:write', keepData: true, confirmSourceChange: true },
            { id: SLUG, mode: 'reinstall', grants: [{ scope: 'database' }], keepData: true, confirmSourceChange: true },
            { id: SLUG, mode: 'reinstall', grants: [], keepData: 'yes', confirmSourceChange: true },
            { id: [SLUG], mode: 'reinstall', grants: [], keepData: true, confirmSourceChange: true },
        ]) {
            const res = await adopt(session(), body);
            assert.strictEqual(res.status, 400, `${JSON.stringify(body)} → ${res.status} ${JSON.stringify(res.body)}`);
        }
    });

    it('an API token cannot grant through it: the consent is an administrator\'s', async () => {
        const res = await adopt(`Bearer ${token}`, { id: SLUG, mode: 'reinstall', grants: ['database:write'], keepData: true, confirmSourceChange: true });
        assert.strictEqual(res.status, 403, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'rest_token_management_forbidden');
        assert.strictEqual((await origins.getPluginOrigin(SLUG)).source, OLD_SOURCE, 'not reinstalled');
    });

    it('confirmed, keeping the data: one step, the data stays, only what was approved is granted, the source is recorded and audited', async () => {
        const res = await adopt(session(), { id: SLUG, mode: 'reinstall', grants: ['settings:read'], keepData: true, confirmSourceChange: true });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pluginDir(), 'manifest.json'), 'utf8')).version, '2.0.0');
        assert.strictEqual(fs.readFileSync(path.join(pluginDir(), 'data', 'secret.key'), 'utf8'), 'PRESERVE-ME');
        assert.deepStrictEqual(perms.getGrants(SLUG), ['settings:read'], 'database:write was not replayed');
        assert.strictEqual((await origins.getPluginOrigin(SLUG)).source, catalogDir);

        const audit = await lastAudit();
        if (!audit) throw new Error('the reinstall was not audited');
        assert.strictEqual(audit.action, 'marketplace.adopt');
        assert.strictEqual(audit.detail.mode, 'reinstall');
        assert.strictEqual(audit.detail.keepData, true);
        assert.strictEqual(audit.detail.previousSource, OLD_SOURCE);
        assert.strictEqual(audit.detail.newSource, catalogDir);
        assert.deepStrictEqual(audit.detail.previousGrants, ['database:write']);
        assert.deepStrictEqual(audit.detail.grants, ['settings:read']);
        assert.strictEqual(audit.detail.ok, true);

        // Bound to the new source now: the catalog offers the normal update path for it.
        const cat = await request(app).get(`${B}/marketplace/catalog?refresh=1`).set('Authorization', session());
        const e = cat.body.plugins.find((p: any) => p.id === SLUG);
        assert.strictEqual(e.updateAvailable, false, 'already at the catalog version');
        assert.strictEqual(e.installedFrom, catalogDir);
    });
});
