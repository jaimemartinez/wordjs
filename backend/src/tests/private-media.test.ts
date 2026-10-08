/**
 * PRIVATE MEDIA + HOST-MEDIATED DOWNLOADS (security: paid digital-downloads files were public).
 *
 * THE DEFECT. The bundled digital-downloads plugin sold files whose only protection was that the
 * product's media-library URL was "never listed publicly". But the core media API listed every
 * unattached attachment to ANONYMOUS callers (GET /api/v1/media?mime_type=application/zip returned the
 * paid product with its sourceUrl), and /uploads served the bytes with no authentication and a one-year
 * immutable cache. Anyone downloaded every paid product; and a buyer who had seen the URL once kept it
 * forever, so the link's expiry and use limit meant nothing.
 *
 * WHAT IS PINNED HERE, over the REAL routers, the REAL Media model, a real temp uploads tree served by
 * the same express.static mount index.ts uses, and the REAL digital-downloads plugin booted in a real
 * isolate through the real bridge:
 *   1. a private upload never touches the public tree, is never listed / readable / downloadable by an
 *      anonymous caller, a subscriber or another author, and its /uploads URL 404s;
 *   2. its owner and an administrator still see and download it (authenticated route, download-only
 *      headers);
 *   3. toggling visibility moves the files in both directions;
 *   4. public media behaves exactly as before;
 *   5. a plugin can stream a private file only with the default-deny media:private_read grant;
 *   6. digital-downloads streams the product file on a valid token, rejects expired and exhausted
 *      tokens on EVERY download, never answers a URL for a private product, and keeps a legacy
 *      (public file_url) product working while flagging it to the admin.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-private-media-${STAMP}-`));
const TMP_DB = path.join(TMP_ROOT, 'wordjs.db');
const TMP_UPLOADS = path.join(TMP_ROOT, 'uploads');
const TMP_PRIVATE = path.join(TMP_ROOT, 'data', 'private-uploads');
fs.mkdirSync(TMP_UPLOADS, { recursive: true });

config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
config.uploads.dir = TMP_UPLOADS;
config.uploads.privateDir = TMP_PRIVATE;

const database = require('../config/database');
const roles = require('../core/roles');
const Media = require('../models/Media');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const AdmZip = require('adm-zip');
const { setApp } = require('../core/appRegistry');
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');
const perms = require('../core/plugin-permissions');

const SECRET = config.jwt.secret;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));
// The SAME public mount index.ts installs: the uploads tree, statically, with no authentication.
app.use('/uploads', express.static(path.resolve(config.uploads.dir), { dotfiles: 'deny' }));

const U: Record<string, number> = {};
let dbAsync: any;

const tok = (id: number, login: string) => jwt.sign({ userId: id, username: login }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const as = (persona: string, m: string, p: string) =>
    (request(app) as any)[m](`/api/v1${p}`).set('Authorization', `Bearer ${tok(U[persona], persona)}`);
const anon = (m: string, p: string) => (request(app) as any)[m](`/api/v1${p}`);

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

/** A real ZIP archive (file-type detects application/zip from its magic bytes). */
function zipBytes(label: string): Buffer {
    const z = new AdmZip();
    z.addFile('readme.txt', Buffer.from(`paid product ${label} ${'x'.repeat(200)}`));
    return z.toBuffer();
}

async function upload(persona: string, name: string, bytes: Buffer, query = '') {
    const r = await as(persona, 'post', `/media${query}`).attach('file', bytes, { filename: name, contentType: 'application/zip' });
    assert.strictEqual(r.status, 201, `upload failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
}

/** Binary-safe supertest body. */
const binary = (req: any) => req.buffer(true).parse((res: any, cb: any) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
});

const DD_SLUG = 'dd-private-test';
const DD_DIR = path.join(path.resolve(__dirname, '../../plugins'), DD_SLUG);
const DD_SRC = path.resolve(__dirname, '../../../marketplace/plugins/digital-downloads');
const DD_GRANTS = [
    'database:read', 'database:write', 'settings:read', 'settings:write',
    'express:register_route', 'admin_menu:register', 'email:admin', 'media:private_read',
];
const PROBE_SLUG = 'private-media-probe';
const PROBE_DIR = path.join(path.resolve(__dirname, '../../plugins'), PROBE_SLUG);

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    await seedUser('admin', 'administrator');
    await seedUser('authorA', 'author');
    await seedUser('authorB', 'author');
    await seedUser('subscriber', 'subscriber');
    setApp(app);
});

after(async () => {
    try { unloadIsolatedPlugin(DD_SLUG); } catch { /* */ }
    try { unloadIsolatedPlugin(PROBE_SLUG); } catch { /* */ }
    for (const d of [DD_DIR, PROBE_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    try { await database.closeDatabase(); } catch { /* */ }
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

describe('core: private media is invisible to everyone who may not edit it', () => {
    let priv: any;
    let pub: any;

    before(async () => {
        priv = await upload('authorA', 'paid-ebook.zip', zipBytes('secret'), '?visibility=private');
        pub = await upload('authorA', 'free-sample.zip', zipBytes('sample'));
    });

    test('the private upload is stored OUTSIDE the public uploads tree and has no /uploads URL', () => {
        assert.strictEqual(priv.visibility, 'private');
        assert.strictEqual(priv.sourceUrl, `/api/v1/media/${priv.id}/file`);
        assert.ok(!String(priv.guid).includes('/uploads/'), 'guid must not name a public path');
        const rel = priv.mediaDetails.file;
        assert.ok(fs.existsSync(path.join(TMP_PRIVATE, rel)), 'the bytes live in the private root');
        assert.ok(!fs.existsSync(path.join(TMP_UPLOADS, rel)), 'nothing was written under the served tree');
    });

    test('anonymous GET /media (the PoC query) never lists it, and the pager does not count it', async () => {
        const r = await anon('get', '/media?mime_type=application/zip&per_page=100');
        assert.strictEqual(r.status, 200);
        const ids = r.body.map((m: any) => m.id);
        assert.ok(!ids.includes(priv.id), 'private item leaked to the anonymous list');
        assert.ok(ids.includes(pub.id), 'public media is listed exactly as before');
        assert.strictEqual(r.headers['x-wp-total'], '1');
        assert.ok(!JSON.stringify(r.body).includes(priv.mediaDetails.file), 'no trace of the private file name');

        const onlyPrivate = await anon('get', '/media?visibility=private');
        assert.deepStrictEqual(onlyPrivate.body, []);
        assert.strictEqual(onlyPrivate.headers['x-wp-total'], '0');
    });

    test('anonymous / subscriber / another author: GET /media/:id is 404 and the file route refuses', async () => {
        assert.strictEqual((await anon('get', `/media/${priv.id}`)).status, 404);
        assert.strictEqual((await anon('get', `/media/${priv.id}/file`)).status, 401);
        for (const persona of ['subscriber', 'authorB']) {
            assert.strictEqual((await as(persona, 'get', `/media/${priv.id}`)).status, 404, `${persona} read the item`);
            assert.strictEqual((await as(persona, 'get', `/media/${priv.id}/file`)).status, 404, `${persona} downloaded the file`);
            const list = await as(persona, 'get', '/media?per_page=100');
            assert.ok(!list.body.some((m: any) => m.id === priv.id), `${persona} listed the item`);
        }
    });

    test('the direct /uploads URL of the private file 404s', async () => {
        const r = await request(app).get(`/uploads/${priv.mediaDetails.file}`);
        assert.strictEqual(r.status, 404);
    });

    test('other public surfaces: anonymous /posts?type=attachment and search never return it', async () => {
        const list = await anon('get', '/posts?type=attachment&status=any&per_page=100');
        assert.ok(!(list.body || []).some((p: any) => p.id === priv.id));
        const search = await anon('get', '/posts?search=paid-ebook&type=attachment');
        assert.ok(!(search.body || []).some((p: any) => p.id === priv.id));
    });

    test('the owner and an administrator still see it and can download it (download-only headers)', async () => {
        for (const persona of ['authorA', 'admin']) {
            const list = await as(persona, 'get', '/media?per_page=100');
            assert.ok(list.body.some((m: any) => m.id === priv.id && m.visibility === 'private'), `${persona} lost the item`);
            assert.strictEqual((await as(persona, 'get', `/media/${priv.id}`)).status, 200);
        }
        const r = await binary(as('admin', 'get', `/media/${priv.id}/file`));
        assert.strictEqual(r.status, 200);
        assert.ok(Buffer.isBuffer(r.body) && r.body.length > 0);
        assert.strictEqual(r.body.subarray(0, 2).toString('latin1'), 'PK', 'the real ZIP bytes are streamed');
        assert.match(String(r.headers['content-disposition']), /^attachment/);
        assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
        assert.match(String(r.headers['cache-control']), /no-store/);

        const onlyPrivate = await as('admin', 'get', '/media?visibility=private');
        assert.deepStrictEqual(onlyPrivate.body.map((m: any) => m.id), [priv.id]);
        const onlyPublic = await as('admin', 'get', '/media?visibility=public');
        assert.ok(!onlyPublic.body.some((m: any) => m.id === priv.id));
    });

    test('public media is unchanged: /uploads sourceUrl, served statically, readable anonymously', async () => {
        assert.strictEqual(pub.visibility, 'public');
        assert.ok(pub.sourceUrl.startsWith('/uploads/'));
        assert.strictEqual((await anon('get', `/media/${pub.id}`)).status, 200);
        const r = await request(app).get(pub.sourceUrl);
        assert.strictEqual(r.status, 200);
    });

    test('visibility toggles move the files both ways (PUT /media/:id)', async () => {
        const item = await upload('authorA', 'toggle.zip', zipBytes('toggle'));
        const rel = item.mediaDetails.file;
        assert.strictEqual((await request(app).get(`/uploads/${rel}`)).status, 200);

        const made = await as('authorA', 'put', `/media/${item.id}`).send({ visibility: 'private' });
        assert.strictEqual(made.status, 200, JSON.stringify(made.body));
        assert.strictEqual(made.body.visibility, 'private');
        assert.strictEqual((await request(app).get(`/uploads/${rel}`)).status, 404, 'still served after going private');
        assert.ok(fs.existsSync(path.join(TMP_PRIVATE, rel)));
        assert.ok(!(await anon('get', '/media?per_page=100')).body.some((m: any) => m.id === item.id));

        // Another author may not flip someone else's item — and since a private item they may not edit is
        // invisible to them (GET /media/:id → 404), the write answers the same 404 rather than confirming it.
        assert.strictEqual((await as('authorB', 'put', `/media/${item.id}`).send({ visibility: 'public' })).status, 404);
        assert.strictEqual((await as('authorB', 'get', `/media/${item.id}`)).status, 404);

        const back = await as('admin', 'put', `/media/${item.id}`).send({ visibility: 'public' });
        assert.strictEqual(back.body.visibility, 'public');
        assert.strictEqual((await request(app).get(`/uploads/${rel}`)).status, 200);
        assert.strictEqual((await as('admin', 'put', `/media/${item.id}`).send({ visibility: 'secret' })).status, 400);
    });

    test('deleting a private item removes its file from the private root', async () => {
        const item = await upload('authorA', 'to-delete.zip', zipBytes('del'), '?visibility=private');
        const abs = path.join(TMP_PRIVATE, item.mediaDetails.file);
        assert.ok(fs.existsSync(abs));
        assert.strictEqual((await as('authorA', 'delete', `/media/${item.id}`)).status, 200);
        assert.ok(!fs.existsSync(abs));
    });
});

describe('plugin bridge: res.sendPrivateMedia is default-deny (media:private_read)', () => {
    let priv: any;
    before(async () => {
        priv = await upload('admin', 'probe.zip', zipBytes('probe'), '?visibility=private');
        fs.mkdirSync(PROBE_DIR, { recursive: true });
        fs.writeFileSync(path.join(PROBE_DIR, 'manifest.json'), JSON.stringify({
            name: PROBE_SLUG, isolated: true,
            permissions: [{ scope: 'express', access: 'register_route' }, { scope: 'media', access: 'private_read' }],
        }));
        fs.writeFileSync(path.join(PROBE_DIR, 'index.js'),
            "exports.init = function (wordjs) {\n" +
            "  wordjs.http.route('get', '/file', (req, res) => res.sendPrivateMedia(Number(req.query.id), { filename: 'probe' }));\n" +
            "  wordjs.http.route('get', '/info', async (req, res) => {\n" +
            "    try { res.json({ info: await wordjs.media.getPrivate(Number(req.query.id)) }); }\n" +
            "    catch (e) { res.status(403).json({ error: String(e && e.message || e) }); }\n" +
            "  });\n" +
            "};\n");
        perms._setGrantsInMemory(PROBE_SLUG, ['express:register_route']);
        await loadIsolatedPlugin(PROBE_SLUG, path.join(PROBE_DIR, 'index.js'));
    });

    test('without the grant the host refuses both the description and the stream', async () => {
        perms._setGrantsInMemory(PROBE_SLUG, ['express:register_route']);
        const info = await request(app).get(`/api/v1/plugin/${PROBE_SLUG}/info?id=${priv.id}`);
        assert.strictEqual(info.status, 403);
        const file = await request(app).get(`/api/v1/plugin/${PROBE_SLUG}/file?id=${priv.id}`);
        assert.strictEqual(file.status, 403);
        assert.ok(!String(file.text).includes('PK'));
    });

    test('with the grant the host streams the private file, and never a public one', async () => {
        perms._setGrantsInMemory(PROBE_SLUG, ['express:register_route', 'media:private_read']);
        const info = await request(app).get(`/api/v1/plugin/${PROBE_SLUG}/info?id=${priv.id}`);
        assert.strictEqual(info.status, 200, JSON.stringify(info.body));
        assert.strictEqual(info.body.info.id, priv.id);
        assert.ok(!('path' in info.body.info) && !JSON.stringify(info.body).includes(TMP_PRIVATE), 'no filesystem path leaks to the plugin');

        const file = await binary(request(app).get(`/api/v1/plugin/${PROBE_SLUG}/file?id=${priv.id}`));
        assert.strictEqual(file.status, 200);
        assert.strictEqual(file.body.subarray(0, 2).toString('latin1'), 'PK');
        assert.match(String(file.headers['content-disposition']), /attachment; filename="probe\.zip"/);
        assert.match(String(file.headers['cache-control']), /no-store/);

        const pub = await upload('admin', 'public.zip', zipBytes('pub'));
        assert.strictEqual((await request(app).get(`/api/v1/plugin/${PROBE_SLUG}/file?id=${pub.id}`)).status, 404);
        assert.strictEqual((await request(app).get(`/api/v1/plugin/${PROBE_SLUG}/info?id=${pub.id}`)).body.info, null);
    });
});

describe('digital-downloads (real plugin, real isolate): token-gated streaming of a private file', () => {
    const BASE = `/api/v1/plugin/${DD_SLUG}`;
    const P = 'wjp_dd_private_test_';
    let priv: any;
    let productId: number;

    const adminReq = (m: string, p: string) => (request(app) as any)[m](`${BASE}${p}`).set('Authorization', `Bearer ${tok(U.admin, 'admin')}`);
    const order = async (pid: number) => {
        const r = await request(app).post(`${BASE}/public/order`).send({
            product_id: pid, customer_email: 'buyer@example.com', customer_name: 'Buyer', elapsed: 5000,
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        return r.body.token as string;
    };
    const download = (token: string) => binary(request(app).get(`${BASE}/public/download?token=${token}`));

    before(async () => {
        priv = await upload('admin', 'course.zip', zipBytes('course'), '?visibility=private');
        fs.cpSync(DD_SRC, DD_DIR, { recursive: true });
        const manifest = JSON.parse(fs.readFileSync(path.join(DD_DIR, 'manifest.json'), 'utf8'));
        manifest.id = DD_SLUG;
        fs.writeFileSync(path.join(DD_DIR, 'manifest.json'), JSON.stringify(manifest));
        perms._setGrantsInMemory(DD_SLUG, DD_GRANTS);
        await loadIsolatedPlugin(DD_SLUG, path.join(DD_DIR, 'index.js'));
    });

    test('a product must reference a PRIVATE media item; a public one is refused', async () => {
        const pub = await upload('admin', 'leaky.zip', zipBytes('leaky'));
        const bad = await adminReq('post', '/products').send({ name: 'Leaky', price_cents: 0, media_id: pub.id });
        assert.strictEqual(bad.status, 400);
        const legacyUrl = await adminReq('post', '/products').send({ name: 'Url only', price_cents: 0, file_url: '/uploads/x.zip' });
        assert.strictEqual(legacyUrl.status, 400, 'a pasted public URL is no longer accepted');

        const ok = await adminReq('post', '/products').send({ name: 'Course', price_cents: 0, media_id: priv.id });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        productId = ok.body.id;
        const list = await adminReq('get', '/products');
        const row = list.body.find((p: any) => p.id === productId);
        assert.strictEqual(row.file_status, 'private');
        assert.strictEqual(row.file_url, '');
    });

    test('a valid token STREAMS the file (no URL in the response) and the public listing reveals nothing', async () => {
        const token = await order(productId);
        const status = await request(app).get(`${BASE}/public/status?token=${token}`);
        assert.strictEqual(status.body.delivery, 'stream');

        const r = await download(token);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.subarray(0, 2).toString('latin1'), 'PK');
        assert.match(String(r.headers['content-disposition']), /^attachment; filename="course\.zip"/);
        assert.match(String(r.headers['cache-control']), /no-store/);
        assert.ok(!String(r.headers['content-type']).includes('json'), 'the body is the file, not a JSON reveal');

        const products = await request(app).get(`${BASE}/public/products`);
        assert.ok(!JSON.stringify(products.body).includes(priv.mediaDetails.file));
        assert.ok(!(await anon('get', '/media?per_page=100')).body.some((m: any) => m.id === priv.id));
    });

    test('max-uses is enforced on EVERY download, not only on a reveal', async () => {
        const token = await order(productId);
        await dbAsync.run(`UPDATE ${P}orders SET max_uses = 2 WHERE token = ?`, [token]);
        assert.strictEqual((await download(token)).status, 200);
        assert.strictEqual((await download(token)).status, 200);
        const third = await request(app).get(`${BASE}/public/download?token=${token}`);
        assert.strictEqual(third.status, 410);
        assert.ok(!('url' in (third.body || {})));
    });

    test('an expired token is refused and does not stream', async () => {
        const token = await order(productId);
        await dbAsync.run(`UPDATE ${P}orders SET expires_at = ? WHERE token = ?`, ['2000-01-01T00:00:00.000Z', token]);
        const r = await request(app).get(`${BASE}/public/download?token=${token}`);
        assert.strictEqual(r.status, 410);
        assert.ok(!String(r.text).startsWith('PK'));
    });

    test('an unpaid order is refused', async () => {
        const token = await order(productId);
        await dbAsync.run(`UPDATE ${P}orders SET payment_status = 'pending' WHERE token = ?`, [token]);
        assert.strictEqual((await request(app).get(`${BASE}/public/download?token=${token}`)).status, 402);
    });

    test('without media:private_read nothing is delivered AND no download use is consumed', async () => {
        const token = await order(productId);
        perms._setGrantsInMemory(DD_SLUG, DD_GRANTS.filter((g) => g !== 'media:private_read'));
        try {
            const r = await request(app).get(`${BASE}/public/download?token=${token}`);
            assert.strictEqual(r.status, 503);
            const row = await dbAsync.get(`SELECT use_count FROM ${P}orders WHERE token = ?`, [token]);
            assert.strictEqual(Number(row.use_count), 0);
        } finally {
            perms._setGrantsInMemory(DD_SLUG, DD_GRANTS);
        }
        assert.strictEqual((await download(token)).status, 200);
    });

    test('legacy product (public file_url, pre-1.1.0) keeps working and is flagged to the admin', async () => {
        const ins = await dbAsync.run(
            `INSERT INTO ${P}products (name, slug, price_cents, file_url, is_published) VALUES (?, ?, 0, ?, 1)`,
            ['Old ebook', 'old-ebook', '/uploads/2025/01/old.zip']);
        const legacyId = ins.lastID;
        const list = await adminReq('get', '/products');
        assert.strictEqual(list.body.find((p: any) => p.id === legacyId).file_status, 'public_legacy');

        const token = await order(legacyId);
        assert.strictEqual((await request(app).get(`${BASE}/public/status?token=${token}`)).body.delivery, 'url');
        const r = await request(app).get(`${BASE}/public/download?token=${token}`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.url, '/uploads/2025/01/old.zip');

        // Re-selecting a private file migrates it: the public URL is dropped and never revealed again.
        const upd = await adminReq('put', `/products/${legacyId}`).send({ media_id: priv.id });
        assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
        const after = (await adminReq('get', '/products')).body.find((p: any) => p.id === legacyId);
        assert.strictEqual(after.file_status, 'private');
        assert.strictEqual(after.file_url, '');
        const streamed = await download(token);
        assert.strictEqual(streamed.status, 200);
        assert.strictEqual(streamed.body.subarray(0, 2).toString('latin1'), 'PK');
    });
});

test('Media.findAll / Media.count default to PUBLIC items only (every internal caller stays safe)', async () => {
    const all = await Media.findAll({ limit: 100 });
    assert.ok(all.length > 0);
    assert.ok(all.every((m: any) => m.visibility === 'public'));
    assert.strictEqual(await Media.count({}), all.length);
});
