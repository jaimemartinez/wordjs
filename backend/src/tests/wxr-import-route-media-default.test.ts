/**
 * POST /api/v1/import/wordpress: the media mode the route hands to the importer.
 *
 * core/wxr-import downloads attachments by default and the admin screen preselects `download`, so a raw
 * API call that sends neither `media` nor the legacy `importAttachments` switch must get the same
 * default instead of silently skipping every attachment. An explicit opt-out (`media=skip`,
 * `importAttachments=0`) must keep working, and so must the legacy `importAttachments=1`.
 *
 * importWxr is replaced before the router is loaded, so only the route's own option resolution is
 * under test here (core's media handling has its own suite in wxr-import.test.ts).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-wxr-route-media-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');

// The route destructures importWxr when it is first required, so the stub has to be in place before.
const wxrImport = require('../core/wxr-import');
const calls: any[] = [];
const realImportWxr = wxrImport.importWxr;
wxrImport.importWxr = async (_xml: string, opts: any) => { calls.push(opts); return { stub: true }; };

const express = require('express');
const request = require('supertest');

const B = config.api.prefix;
const app = express();
app.use(express.json());
app.use(`${B}/import`, require('../routes/import'));

const WXR = '<?xml version="1.0"?><rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/"><channel></channel></rss>';
let adminId = 0;
const session = () => `Bearer ${jwt.sign({ userId: adminId, username: 'owner' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}`;

async function importWith(fields: Record<string, string>) {
    calls.length = 0;
    let req = request(app).post(`${B}/import/wordpress`).set('Authorization', session());
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    const res = await req.attach('file', Buffer.from(WXR), 'export.xml');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.length, 1, 'the importer ran exactly once');
    return calls[0];
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    const dbAsync = database.getDbAsync();
    await roles.loadRoles();
    const r = await dbAsync.run(
        'INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
        ['owner', bcrypt.hashSync('Correct-Horse-9!', 10), 'owner@example.com', 'owner']);
    await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')", [r.lastID]);
    adminId = r.lastID;
});

after(async () => {
    wxrImport.importWxr = realImportWxr;
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

describe('POST /import/wordpress media mode', () => {
    it('with neither media nor importAttachments, attachments are downloaded (core default)', async () => {
        const opts = await importWith({});
        assert.strictEqual(opts.media, 'download');
    });

    it('an explicit media=skip is honoured', async () => {
        assert.strictEqual((await importWith({ media: 'skip' })).media, 'skip');
    });

    it('media wins over the legacy switch', async () => {
        assert.strictEqual((await importWith({ media: 'link', importAttachments: '1' })).media, 'link');
        assert.strictEqual((await importWith({ media: 'download', importAttachments: '0' })).media, 'download');
    });

    it('legacy importAttachments=1 still means download', async () => {
        assert.strictEqual((await importWith({ importAttachments: '1' })).media, 'download');
    });

    it('legacy importAttachments=0 still opts out', async () => {
        assert.strictEqual((await importWith({ importAttachments: '0' })).media, 'skip');
    });

    it('an unknown media value falls back to the default rather than skipping', async () => {
        assert.strictEqual((await importWith({ media: 'bogus' })).media, 'download');
    });
});
