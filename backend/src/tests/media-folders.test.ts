/**
 * Folders in the media library (core/media-folders, routes/media.ts /media/folders*), through the REAL
 * routers on every engine: SQLite always; PostgreSQL and MySQL where they are reachable (WORDJS_CI_DB=1 in CI,
 * where they may not skip).
 *
 * The contract: folders are organisation only — a file's path and URL never change when it moves; the list
 * filters by folder (and «in no folder»); an upload lands in a folder; deleting a folder moves what it holds
 * and never leaves a file in a folder that does not exist; private media and the edit rules of each file
 * apply; renaming and deleting folders is for editors (edit_others_posts).
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-media-folders-'));
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
config.uploads.dir = path.join(TMP_ROOT, 'uploads');
config.uploads.privateDir = path.join(TMP_ROOT, 'private-uploads');
const database = require('../config/database');

const express = require('express');
const request = require('supertest');

const B = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
const CERT_DB = 'wordjs_media_folders';

const app = express();
app.use(express.json());
app.use(B, require('../routes'));
app.use(require('../middleware/errorHandler').errorHandler);

after(() => {
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

function engineCoordinates(engine: string): Record<string, any> {
    if (engine === 'postgres') {
        return {
            host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT) || 5432,
            user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD ?? 'password', name: process.env.PGDATABASE || 'wordjs',
        };
    }
    return {
        host: process.env.MYSQL_HOST || '127.0.0.1', port: Number(process.env.MYSQL_PORT) || 3306,
        user: process.env.MYSQL_USER || 'root', password: process.env.MYSQL_PASSWORD ?? 'password', name: process.env.MYSQL_DB || 'wordjs',
    };
}

/** A fresh database on `engine`, or the reason there is none. */
async function bringUp(engine: string): Promise<string | null> {
    if (engine === 'sqlite-native') {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        return null;
    }
    let driver: any;
    try { driver = require(`../drivers/${engine}`); } catch (e: any) { return `${engine} driver not loadable: ${e && e.message}`; }
    const base = engineCoordinates(engine);
    driver.config = { ...base };
    try {
        await Promise.race([driver.connect(), new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
        if (engine === 'postgres') {
            await driver.exec(`DROP DATABASE IF EXISTS ${CERT_DB}`);
            await driver.exec(`CREATE DATABASE ${CERT_DB}`);
        } else {
            await driver.exec(`DROP DATABASE IF EXISTS \`${CERT_DB}\``);
            await driver.exec(`CREATE DATABASE \`${CERT_DB}\``);
        }
    } catch (e: any) {
        try { await driver.close(); } catch { /* best effort */ }
        return `no reachable ${engine}: ${e && e.message}`;
    }
    try { await driver.close(); } catch { /* best effort */ }
    driver.config = { ...base, name: CERT_DB };
    await database.init({ driver: engine });
    await database.initializeDatabase();
    return null;
}

async function scenario() {
    const dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await require('../core/roles').loadRoles();
    const tokens: Record<string, string> = {};
    const ids: Record<string, number> = {};
    for (const [login, role] of [['admin', 'administrator'], ['editor', 'editor'], ['author', 'author'], ['sub', 'subscriber']]) {
        const r = await dbAsync.run(
            'INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?) RETURNING id',
            [login, bcrypt.hashSync(PASSWORD, 4), `${login}@example.com`, login]);
        ids[login] = Number(r.lastID);
        await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)", [ids[login], role]);
        tokens[login] = jwt.sign({ userId: ids[login], username: login }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
    }
    const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
    const sharp = require('sharp');
    const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
    const upload = (who: string, name: string, query = '') =>
        request(app).post(`${B}/media${query}`).set(as(who)).attach('file', png, { filename: name, contentType: 'image/png' });
    const list = async (who: string, folder: string) => {
        const r = await request(app).get(`${B}/media?per_page=100&folder=${folder}`).set(as(who));
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        return r.body.map((m: any) => m.id).sort();
    };

    // ── Folders: create, nest, unique names, no cycles ───────────────────────────────────────────────
    assert.strictEqual((await request(app).get(`${B}/media/folders`).set(as('sub'))).status, 403, 'needs upload_files');
    const photos = await request(app).post(`${B}/media/folders`).set(as('author')).send({ name: 'Photos' });
    assert.strictEqual(photos.status, 201, JSON.stringify(photos.body));
    const events = await request(app).post(`${B}/media/folders`).set(as('admin')).send({ name: 'Events', parent: photos.body.id });
    assert.strictEqual(events.status, 201, JSON.stringify(events.body));
    assert.strictEqual(events.body.parent, photos.body.id);
    assert.strictEqual((await request(app).post(`${B}/media/folders`).set(as('admin')).send({ name: 'photos' })).status, 409, 'unique per parent, ignoring case');
    assert.strictEqual((await request(app).post(`${B}/media/folders`).set(as('admin')).send({ name: 'Photos', parent: events.body.id })).status, 201, 'the same name elsewhere is fine');
    assert.strictEqual((await request(app).post(`${B}/media/folders`).set(as('admin')).send({ name: 'X', parent: 999999 })).status, 400);
    assert.strictEqual((await request(app).post(`${B}/media/folders`).set(as('admin')).send({ name: '   ' })).status, 400);
    const cycle = await request(app).put(`${B}/media/folders/${photos.body.id}`).set(as('admin')).send({ parent: events.body.id });
    assert.strictEqual(cycle.status, 400);
    assert.strictEqual(cycle.body.code, 'rest_media_folder_cycle');
    assert.strictEqual((await request(app).put(`${B}/media/folders/${photos.body.id}`).set(as('author')).send({ name: 'Mine' })).status, 403, 'renaming is for editors');
    const renamed = await request(app).put(`${B}/media/folders/${photos.body.id}`).set(as('editor')).send({ name: 'Pictures' });
    assert.strictEqual(renamed.status, 200, JSON.stringify(renamed.body));
    assert.strictEqual(renamed.body.name, 'Pictures');

    // ── Uploads land in a folder; the list filters by it ─────────────────────────────────────────────
    const inPictures = await upload('admin', 'in-pictures.png', `?folder=${photos.body.id}`);
    assert.strictEqual(inPictures.status, 201, JSON.stringify(inPictures.body));
    assert.strictEqual(inPictures.body.folder, photos.body.id);
    const loose = await upload('author', 'loose.png');
    assert.strictEqual(loose.status, 201);
    assert.strictEqual(loose.body.folder, 0);
    const missing = await upload('admin', 'nowhere.png', '?folder=999999');
    assert.strictEqual(missing.status, 400, 'an upload into a folder that does not exist is refused');
    const authorPrivate = await upload('author', 'secret.png', `?visibility=private&folder=${photos.body.id}`);
    assert.strictEqual(authorPrivate.status, 201, JSON.stringify(authorPrivate.body));
    const adminPrivate = await upload('admin', 'admin-secret.png', `?visibility=private&folder=${photos.body.id}`);
    assert.strictEqual(adminPrivate.status, 201);

    assert.deepStrictEqual(await list('admin', String(photos.body.id)), [inPictures.body.id, authorPrivate.body.id, adminPrivate.body.id].sort());
    assert.deepStrictEqual(await list('admin', '0'), [loose.body.id]);
    assert.ok((await list('admin', 'all')).length >= 4);
    assert.strictEqual((await request(app).get(`${B}/media?folder=abc`).set(as('admin'))).status, 400);
    // Private media: the author sees their own private file in the folder, never the admin's.
    assert.deepStrictEqual(await list('author', String(photos.body.id)), [inPictures.body.id, authorPrivate.body.id].sort());
    const authorRes = await request(app).get(`${B}/media/folders`).set(as("author"));
    assert.strictEqual(authorRes.status, 200, JSON.stringify(authorRes.body));
    const authorCounts = authorRes.body;
    assert.strictEqual(authorCounts.folders.find((f: any) => f.id === photos.body.id).count, 2, 'counts what the caller may see');
    const adminCounts = (await request(app).get(`${B}/media/folders`).set(as('admin'))).body;
    assert.strictEqual(adminCounts.folders.find((f: any) => f.id === photos.body.id).count, 3);
    assert.strictEqual(adminCounts.unfiled, 1);

    // ── Moving: the URL stays, each file's edit rule applies ────────────────────────────────────────
    const urlBefore = inPictures.body.sourceUrl;
    const move = await request(app).post(`${B}/media/folders/move`).set(as('author'))
        .send({ ids: [loose.body.id, inPictures.body.id], folder: events.body.id });
    assert.strictEqual(move.status, 200, JSON.stringify(move.body));
    assert.deepStrictEqual(move.body.moved, [loose.body.id], 'the author moves their own file');
    assert.deepStrictEqual(move.body.refused, [{ id: inPictures.body.id, code: 'rest_forbidden' }], 'not someone else’s');
    const editorMove = await request(app).post(`${B}/media/folders/move`).set(as('editor')).send({ ids: [inPictures.body.id], folder: events.body.id });
    assert.deepStrictEqual(editorMove.body.moved, [inPictures.body.id]);
    const after1 = await request(app).get(`${B}/media/${inPictures.body.id}`).set(as('admin'));
    assert.strictEqual(after1.body.folder, events.body.id);
    assert.strictEqual(after1.body.sourceUrl, urlBefore, 'moving never changes the URL');
    const adminSecretMove = await request(app).post(`${B}/media/folders/move`).set(as('author')).send({ ids: [adminPrivate.body.id], folder: 0 });
    assert.deepStrictEqual(adminSecretMove.body.refused, [{ id: adminPrivate.body.id, code: 'rest_post_invalid_id' }], 'a file the caller may not see is not found');
    assert.strictEqual((await request(app).post(`${B}/media/folders/move`).set(as('admin')).send({ ids: [], folder: 0 })).status, 400);
    assert.strictEqual((await request(app).post(`${B}/media/folders/move`).set(as('admin')).send({ ids: [loose.body.id], folder: 999999 })).status, 400);

    // ── Deleting a folder moves what it holds and orphans nothing ───────────────────────────────────
    assert.strictEqual((await request(app).delete(`${B}/media/folders/${photos.body.id}`).set(as('author'))).status, 403);
    const intoItself = await request(app).delete(`${B}/media/folders/${photos.body.id}?moveTo=${events.body.id}`).set(as('editor'));
    assert.strictEqual(intoItself.status, 400, 'not into one of its own folders');
    const del = await request(app).delete(`${B}/media/folders/${photos.body.id}?moveTo=0`).set(as('editor'));
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    assert.strictEqual(del.body.movedFiles, 2, 'the two private files it held');
    assert.strictEqual(del.body.movedFolders, 1, 'Events');
    const tree = (await request(app).get(`${B}/media/folders`).set(as('admin'))).body;
    assert.ok(!tree.folders.some((f: any) => f.id === photos.body.id));
    assert.strictEqual(tree.folders.find((f: any) => f.id === events.body.id).parent, 0, 'its subfolder moved up');
    assert.deepStrictEqual(await list('admin', '0'), [authorPrivate.body.id, adminPrivate.body.id].sort());
    const orphans = await dbAsync.all(
        `SELECT pm.post_id FROM post_meta pm WHERE pm.meta_key = '_wjs_media_folder'
           AND pm.meta_value NOT IN (SELECT ${database.getDbType().driver === 'postgres' ? 'CAST(term_id AS TEXT)' : 'term_id'} FROM term_taxonomy WHERE taxonomy = 'wjs_media_folder')`);
    assert.deepStrictEqual(orphans, [], 'no file points at a folder that does not exist');
    assert.ok(fs.existsSync(path.join(config.uploads.dir, after1.body.mediaDetails.file)), 'the file never moved on disk');

    // The folder meta is server-owned: the generic meta surface cannot rewrite it.
    assert.ok(require('../core/protected-meta').isProtectedPostMeta('_wjs_media_folder'));
    // Folders are internal: not a registered taxonomy, so no public term route or archive lists them.
    assert.strictEqual(require('../core/post-types').getTaxonomy?.('wjs_media_folder') || null, null);
}

for (const engine of ['sqlite-native', 'postgres', 'mysql']) {
    test(`media folders on ${engine}`, async (t: any) => {
        const reason = await bringUp(engine);
        if (reason) {
            if (process.env.WORDJS_CI_DB === '1') assert.fail(`media folders cannot skip ${engine} in CI: ${reason}`);
            return t.skip(reason);
        }
        try { await scenario(); }
        finally { try { await database.closeDatabase(); } catch { /* best effort */ } }
    });
}
