/**
 * MEDIA OFFLOAD — optional S3-compatible storage for the media library (core/media-storage).
 *
 * Driven over the REAL media router, the REAL Media model, a real temp uploads tree and a real HTTP
 * server playing an S3-compatible bucket (path style, like MinIO/R2 with an endpoint). The fake bucket
 * refuses any request without a SigV4 Authorization header for the configured access key, serves GET
 * anonymously (the "public URL"), and can be told to fail.
 *
 * Pinned here:
 *   1. RELATIVE-URL INVARIANT: an offloaded upload stores exactly what a local one stores — guid
 *      `/uploads/<rel>`, `_wp_attached_file` `<rel>` — and no row or meta value of the attachment
 *      names the bucket or CDN; the API keeps `sourceUrl` relative and adds the CDN `deliveryUrl`;
 *   2. the original AND every stored derivative (size ladder, WebP/AVIF) are in the bucket with their
 *      real Content-Type and an immutable Cache-Control, and nothing is left on local disk;
 *   3. a bucket that refuses the write fails the upload (502) and leaves no row, no object, no file;
 *   4. /uploads/<rel> for a file not on disk redirects (302) to the CDN, and nothing else does;
 *   5. offload / restore of an existing library: idempotent, resumable, flips the public delivery base
 *      only when complete, never deletes from the bucket on restore;
 *   6. delete and make-private remove the objects; the GET route never returns the secret;
 *   7. the connection test, and the CSP origin the public settings expose.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-media-offload-${STAMP}-`));
const TMP_UPLOADS = path.join(TMP_ROOT, 'uploads');
fs.mkdirSync(TMP_UPLOADS, { recursive: true });
config.dbPath = path.join(TMP_ROOT, 'wordjs.db');
config.dbDriver = 'sqlite-native';
config.uploads.dir = TMP_UPLOADS;
config.uploads.privateDir = path.join(TMP_ROOT, 'data', 'private-uploads');

const database = require('../config/database');
const roles = require('../core/roles');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const sharp = require('sharp');
const mediaStorage = require('../core/media-storage');
const migration = require('../core/media-storage-migrate');
const options = require('../core/options');

const ACCESS_KEY = 'AKIAMEDIAOFFLOADTEST';
const SECRET_KEY = 'media-offload-secret-key-do-not-leak-1234';
const BUCKET = 'wjs-media';

// ---- the fake S3-compatible bucket -------------------------------------------------------------------
const objects = new Map<string, { body: Buffer; headers: Record<string, string> }>();
const log: Array<{ method: string; key: string }> = [];
let failPuts = false;
const bucket = http.createServer((req: any, res: any) => {
    const url = new URL(req.url, 'http://x');
    const prefix = `/${BUCKET}/`;
    if (!url.pathname.startsWith(prefix)) { res.statusCode = 404; return res.end(); }
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const auth = String(req.headers.authorization || '');
    const signed = auth.startsWith(`AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/`) && /Signature=[0-9a-f]{64}$/.test(auth);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
        log.push({ method: req.method, key });
        if (req.method === 'GET' && !signed) {
            // The PUBLIC read: no credentials, as a browser/CDN would fetch it.
            const o = objects.get(key);
            if (!o) { res.statusCode = 404; return res.end(); }
            res.setHeader('Content-Type', o.headers['content-type'] || 'application/octet-stream');
            return res.end(o.body);
        }
        if (!signed) { res.statusCode = 403; return res.end('<Error><Code>AccessDenied</Code></Error>'); }
        if (req.method === 'PUT') {
            if (failPuts) { res.statusCode = 500; return res.end('<Error><Code>InternalError</Code></Error>'); }
            objects.set(key, {
                body: Buffer.concat(chunks),
                headers: { 'content-type': String(req.headers['content-type'] || ''), 'cache-control': String(req.headers['cache-control'] || ''), 'content-disposition': String(req.headers['content-disposition'] || '') },
            });
            res.statusCode = 200; return res.end();
        }
        const o = objects.get(key);
        if (req.method === 'HEAD') {
            if (!o) { res.statusCode = 404; return res.end(); }
            res.setHeader('Content-Length', String(o.body.length));
            return res.end();
        }
        if (req.method === 'GET') {
            if (!o) { res.statusCode = 404; return res.end(); }
            return res.end(o.body);
        }
        if (req.method === 'DELETE') { objects.delete(key); res.statusCode = 204; return res.end(); }
        res.statusCode = 405; res.end();
    });
});

let ORIGIN = '';
let BASE = ''; // publicBase: <origin>/<bucket>/uploads
const ENV_KEYS = Object.values(mediaStorage.ENV_BY_FIELD) as string[];
function useS3(on: boolean) {
    for (const k of ENV_KEYS) delete process.env[k];
    if (!on) return;
    process.env.WORDJS_MEDIA_STORAGE = 's3';
    process.env.WORDJS_MEDIA_S3_BUCKET = BUCKET;
    process.env.WORDJS_MEDIA_S3_REGION = 'auto';
    process.env.WORDJS_MEDIA_S3_ENDPOINT = ORIGIN;
    process.env.WORDJS_MEDIA_S3_ACCESS_KEY_ID = ACCESS_KEY;
    process.env.WORDJS_MEDIA_S3_SECRET_ACCESS_KEY = SECRET_KEY;
}

// ---- the app ------------------------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));
app.use('/uploads', express.static(path.resolve(config.uploads.dir), { dotfiles: 'deny' }));
app.use('/uploads', mediaStorage.uploadsRedirect());

let dbAsync: any;
let ADMIN = 0;
const tok = () => jwt.sign({ userId: ADMIN, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
const asAdmin = (m: string, p: string) => (request(app) as any)[m](`/api/v1${p}`).set('Authorization', `Bearer ${tok()}`);

async function png(w: number, h: number): Promise<Buffer> {
    return sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 80, b: 40 } } }).png().toBuffer();
}
async function uploadPng(name: string, w = 1400, h = 900) {
    return asAdmin('post', '/media').attach('file', await png(w, h), { filename: name, contentType: 'image/png' });
}
/** Every file name an attachment's metadata says it owns (original first). */
function ownedFiles(m: any): string[] {
    const dir = path.posix.dirname(m.mediaDetails.file);
    const out = [m.mediaDetails.file];
    for (const s of Object.values<any>(m.mediaDetails.sizes || {})) {
        out.push(`${dir}/${s.file}`);
        for (const d of Object.values<any>(s.sources || {})) out.push(`${dir}/${d.file}`);
    }
    for (const d of Object.values<any>(m.mediaDetails.sources || {})) out.push(`${dir}/${d.file}`);
    return out;
}
const tick = () => new Promise((r) => setTimeout(r, 50));

before(async () => {
    await new Promise<void>((r) => bucket.listen(0, '127.0.0.1', () => r()));
    ORIGIN = `http://127.0.0.1:${bucket.address().port}`;
    BASE = `${ORIGIN}/${BUCKET}/uploads`;
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    const r = await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('admin', 'x', 'admin@example.com', 'admin')`);
    ADMIN = r.lastID;
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [ADMIN]);
});

after(async () => {
    useS3(false);
    await new Promise((r) => bucket.close(r));
    try { await database.closeDatabase(); } catch { /* ignore */ }
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('media-storage config resolution (pure)', () => {
    test('defaults to local; a partial s3 config is NOT configured', () => {
        assert.strictEqual(mediaStorage.resolveMediaStorage({}, {}).driver, 'local');
        const partial = mediaStorage.resolveMediaStorage({}, { mediaStorage: { driver: 's3', bucket: 'b' } });
        assert.strictEqual(partial.driver, 'local');
        assert.deepStrictEqual(partial.incomplete, ['accessKeyId', 'secretAccessKey']);
    });

    test('public base: AWS virtual-hosted, endpoint path style, explicit CDN; origin is exactly one origin', () => {
        const creds = { driver: 's3', bucket: 'site-media', accessKeyId: 'a', secretAccessKey: 's' };
        const aws = mediaStorage.resolveMediaStorage({}, { mediaStorage: { ...creds, region: 'eu-west-1' } });
        assert.strictEqual(aws.publicBase, 'https://site-media.s3.eu-west-1.amazonaws.com/uploads');
        const r2 = mediaStorage.resolveMediaStorage({}, { mediaStorage: { ...creds, region: 'auto', endpoint: 'https://acct.r2.cloudflarestorage.com' } });
        assert.strictEqual(r2.publicBase, 'https://acct.r2.cloudflarestorage.com/site-media/uploads');
        const cdn = mediaStorage.resolveMediaStorage({}, { mediaStorage: { ...creds, publicUrl: 'https://cdn.example.com/', prefix: 'media/site1' } });
        assert.strictEqual(cdn.publicBase, 'https://cdn.example.com/media/site1');
        assert.strictEqual(cdn.publicOrigin, 'https://cdn.example.com');
    });

    test('hostile values are refused, never repaired', () => {
        const creds = { driver: 's3', bucket: 'b-1', accessKeyId: 'a', secretAccessKey: 's' };
        for (const publicUrl of ['javascript:alert(1)', 'https://u:p@cdn.example.com', 'https://cdn.example.com/?x=1', 'https://cdn.example.com/#frag', 'ftp://cdn.example.com']) {
            assert.strictEqual(mediaStorage.resolveMediaStorage({}, { mediaStorage: { ...creds, publicUrl } }).driver, 'local', publicUrl);
        }
        assert.strictEqual(mediaStorage.resolveMediaStorage({}, { mediaStorage: { ...creds, prefix: '../x' } }).driver, 'local');
        assert.strictEqual(mediaStorage.resolveMediaStorage({}, { mediaStorage: { ...creds, endpoint: 'file:///etc' } }).driver, 'local');
    });

    test('env overrides the file per field, and is reported as env', () => {
        const s = mediaStorage.resolveMediaStorage({ WORDJS_MEDIA_S3_BUCKET: 'from-env' }, { mediaStorage: { driver: 's3', bucket: 'from-file', accessKeyId: 'a', secretAccessKey: 's' } });
        assert.strictEqual(s.s3.bucket, 'from-env');
        assert.strictEqual(s.sources.bucket, 'env');
        assert.strictEqual(s.sources.accessKeyId, 'file');
    });

    test('publicUrlFor only maps plain media paths (no traversal, no fonts, no negotiation cache)', () => {
        const s = mediaStorage.resolveMediaStorage({}, { mediaStorage: { driver: 's3', bucket: 'b-1', accessKeyId: 'a', secretAccessKey: 's', publicUrl: 'https://cdn.example.com' } });
        assert.strictEqual(mediaStorage.publicUrlFor(s, '2026/10/a.jpg'), 'https://cdn.example.com/uploads/2026/10/a.jpg');
        for (const bad of ['../wordjs.db', '2026/../../x', 'fonts/inter.woff2', '.derivatives/a.avif', '2026/10/a b.jpg', '2026/10/"x.jpg', '']) {
            assert.strictEqual(mediaStorage.publicUrlFor(s, bad), null, bad);
        }
    });

    test('document types are stored as an opaque download; media keep their type', () => {
        assert.strictEqual(mediaStorage.objectHeadersFor('a/b.html')['Content-Type'], 'application/octet-stream');
        assert.strictEqual(mediaStorage.objectHeadersFor('a/b.html')['Content-Disposition'], 'attachment');
        assert.strictEqual(mediaStorage.objectHeadersFor('a/b.avif')['Content-Type'], 'image/avif');
        assert.match(mediaStorage.objectHeadersFor('a/b.jpg')['Cache-Control'], /immutable/);
    });

    test('the admin view never carries a full credential', () => {
        const v = mediaStorage.describeForAdmin({}, { mediaStorage: { driver: 's3', bucket: 'b-1', accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY } });
        const text = JSON.stringify(v);
        assert.ok(!text.includes(SECRET_KEY) && !text.includes(ACCESS_KEY));
        assert.strictEqual(v.secretAccessKeySet, true);
        assert.strictEqual(v.secretAccessKeyHint, '••••1234');
    });

    test('mergeBlock keeps the stored secret on an empty write and clears on request', () => {
        const { mergeBlock } = require('../routes/media-storage');
        const kept = mergeBlock({ secretAccessKey: 'old' }, { driver: 's3', secretAccessKey: '' });
        assert.strictEqual(kept.block.secretAccessKey, 'old');
        const cleared = mergeBlock({ secretAccessKey: 'old', accessKeyId: 'id' }, { clearCredentials: true });
        assert.strictEqual(cleared.block.secretAccessKey, undefined);
        assert.ok(mergeBlock({}, { driver: 'ftp' }).error);
    });
});

describe('offloaded uploads over the real routes and a fake S3 bucket', () => {
    let offloaded: any;

    test('upload with s3 configured: relative in the DB, every file in the bucket, none left on disk', async () => {
        useS3(true);
        const r = await uploadPng('Hero Photo.png');
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        offloaded = r.body;
        const rel = offloaded.mediaDetails.file;
        assert.match(rel, /^\d{4}\/\d{2}\/hero-photo-[0-9a-f]{8}\.png$/);

        // 1. the relative-URL invariant
        assert.strictEqual(offloaded.sourceUrl, `/uploads/${rel}`);
        assert.strictEqual(offloaded.deliveryUrl, `${BASE}/${rel}`);
        assert.strictEqual(offloaded.storage, 's3');
        const row = await dbAsync.get('SELECT guid FROM posts WHERE id = ?', [offloaded.id]);
        assert.strictEqual(row.guid, `/uploads/${rel}`);
        const meta = await dbAsync.all('SELECT meta_key, meta_value FROM post_meta WHERE post_id = ?', [offloaded.id]);
        for (const m of meta) {
            assert.ok(!String(m.meta_value).includes(ORIGIN) && !/https?:\/\//.test(String(m.meta_value)), `${m.meta_key} must stay relative: ${m.meta_value}`);
        }
        assert.ok(meta.some((m: any) => m.meta_key === '_wjs_media_storage' && m.meta_value === 's3'));

        // 2. every owned file, derivatives included, is in the bucket — and not on disk
        const files = ownedFiles(offloaded);
        assert.ok(files.some((f) => f.endsWith('.webp')) || files.some((f) => f.endsWith('.avif')), 'sharp wrote modern derivatives');
        assert.ok(files.length >= 4, `original + ladder + derivatives, got ${files.length}`);
        for (const f of files) {
            const o: any = objects.get(`uploads/${f}`);
            assert.ok(o, `bucket holds ${f}`);
            assert.match(o.headers['cache-control'], /immutable/);
            const ext: string = path.extname(f);
            assert.strictEqual(o.headers['content-type'], ({ '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif' } as Record<string, string>)[ext]);
            assert.ok(!fs.existsSync(path.join(TMP_UPLOADS, f)), `${f} removed locally`);
        }
    });

    test('/uploads/<rel> redirects to the CDN for an offloaded file; traversal and fonts do not', async () => {
        const rel = offloaded.mediaDetails.file;
        const r = await request(app).get(`/uploads/${rel}`);
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.location, `${BASE}/${rel}`);
        assert.strictEqual((await request(app).get('/uploads/fonts/x.woff2')).status, 404);
        assert.strictEqual((await request(app).get('/uploads/%2e%2e/wordjs.db')).status, 404);
        // And the CDN URL really serves the bytes, without credentials.
        const pub = await fetch(`${BASE}/${rel}`);
        assert.strictEqual(pub.status, 200);
        assert.strictEqual(pub.headers.get('content-type'), 'image/png');
    });

    test('a bucket that refuses the write fails the upload and leaves nothing behind', async () => {
        const before = await dbAsync.get(`SELECT COUNT(*) AS n FROM posts WHERE post_type = 'attachment'`);
        const keys = objects.size;
        failPuts = true;
        try {
            const r = await uploadPng('refused.png', 800, 600);
            assert.strictEqual(r.status, 502);
            assert.strictEqual(r.body.code, 'rest_media_storage_unavailable');
        } finally { failPuts = false; }
        const afterCount = await dbAsync.get(`SELECT COUNT(*) AS n FROM posts WHERE post_type = 'attachment'`);
        assert.strictEqual(afterCount.n, before.n, 'no row');
        assert.strictEqual(objects.size, keys, 'no object');
        const leftovers: string[] = [];
        const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.startsWith('refused')) leftovers.push(p); } };
        walk(TMP_UPLOADS);
        assert.deepStrictEqual(leftovers, [], 'no local file');
    });

    test('the public settings expose the CDN origin; the delivery base waits for a complete offload', async () => {
        const s = await request(app).get('/api/v1/settings');
        assert.strictEqual(s.body.media_cdn_origin, ORIGIN);
        assert.strictEqual(s.body.media_public_base, '');
    });

    test('GET /media-storage masks the credentials and reports env-sourced fields', async () => {
        const r = await asAdmin('get', '/media-storage');
        assert.strictEqual(r.status, 200);
        const text = JSON.stringify(r.body);
        assert.ok(!text.includes(SECRET_KEY), 'secret never returned');
        assert.ok(!text.includes(ACCESS_KEY), 'access key id only as a hint');
        assert.strictEqual(r.body.sources.bucket, 'env');
        assert.strictEqual(r.body.effective.publicBase, BASE);
        assert.strictEqual((await request(app).get('/api/v1/media-storage')).status, 401);
    });

    test('the connection test writes, reads and deletes a probe; the server never fetches the public URL', async () => {
        const { testConnection } = require('../routes/media-storage');
        const keys = new Set(objects.keys());
        const anonGets = () => log.filter((l) => l.method === 'GET').length;
        const getsBefore = anonGets();
        const r = await testConnection(mediaStorage.resolveMediaStorage());
        assert.strictEqual(r.ok, true, JSON.stringify(r.steps));
        assert.deepStrictEqual(r.steps.map((s: any) => s.step), ['write', 'read', 'delete']);
        assert.deepStrictEqual(new Set(objects.keys()), keys, 'probe removed');
        assert.strictEqual(anonGets(), getsBefore, 'no GET of the public URL from the server');
        const bad = mediaStorage.resolveMediaStorage({ ...process.env, WORDJS_MEDIA_S3_SECRET_ACCESS_KEY: 'x', WORDJS_MEDIA_S3_ACCESS_KEY_ID: 'WRONGKEY' });
        const failed = await testConnection(bad);
        assert.strictEqual(failed.ok, false);
        assert.strictEqual(failed.steps[0].ok, false);
    });

    test('POST /media-storage/test keeps the probe for the browser, then deletes exactly that probe', async () => {
        const first = await asAdmin('post', '/media-storage/test').send({});
        assert.strictEqual(first.status, 200, JSON.stringify(first.body));
        assert.deepStrictEqual(first.body.steps.map((s: any) => s.step), ['write', 'read']);
        assert.match(first.body.probe, /^\.wordjs-connection-test-[0-9a-f]{12}\.png$/);
        assert.strictEqual(first.body.publicUrl, `${BASE}/${first.body.probe}`);
        // What the admin's browser does: load it anonymously from the public URL — a real PNG.
        const pub = await fetch(first.body.publicUrl);
        assert.strictEqual(pub.status, 200);
        const meta = await sharp(Buffer.from(await pub.arrayBuffer())).metadata();
        assert.strictEqual(meta.format, 'png');
        const second = await asAdmin('post', '/media-storage/test').send({ probe: first.body.probe });
        assert.strictEqual(second.status, 200);
        assert.deepStrictEqual(second.body.steps.map((s: any) => s.step), ['delete']);
        assert.ok(!objects.has(`uploads/${first.body.probe}`), 'probe deleted');
        // The cleanup call deletes probes and nothing else.
        const rel = offloaded.mediaDetails.file;
        for (const probe of [rel, '../uploads/x.png', '.wordjs-connection-test-zz.png', `.wordjs-connection-test-${'a'.repeat(12)}.png/../x`]) {
            const r = await asAdmin('post', '/media-storage/test').send({ probe });
            assert.strictEqual(r.status, 400, probe);
        }
        assert.ok(objects.has(`uploads/${rel}`), 'a media object can never be deleted through the probe cleanup');
    });

    test('making an offloaded item private pulls it back and removes its objects', async () => {
        const r = await uploadPng('to-private.png', 700, 500);
        assert.strictEqual(r.status, 201);
        const files = ownedFiles(r.body);
        const p = await asAdmin('put', `/media/${r.body.id}`).send({ visibility: 'private' });
        assert.strictEqual(p.status, 200, JSON.stringify(p.body));
        for (const f of files) {
            assert.ok(!objects.has(`uploads/${f}`), `${f} removed from the bucket`);
            assert.ok(fs.existsSync(path.join(config.uploads.privateDir, f)), `${f} in the private root`);
        }
        const marker = await dbAsync.get(`SELECT 1 FROM post_meta WHERE post_id = ? AND meta_key = '_wjs_media_storage'`, [r.body.id]);
        assert.ok(!marker);
    });

    test('deleting an offloaded item removes its objects', async () => {
        const r = await uploadPng('to-delete.png', 700, 500);
        const files = ownedFiles(r.body);
        assert.ok(files.every((f) => objects.has(`uploads/${f}`)));
        const d = await asAdmin('delete', `/media/${r.body.id}?force=true`);
        assert.ok(d.status === 200 || d.status === 204, `${d.status} ${JSON.stringify(d.body)}`);
        await tick();
        for (const f of files) assert.ok(!objects.has(`uploads/${f}`), `${f} removed`);
    });
});

describe('offload / restore of an existing library', () => {
    const localIds: number[] = [];

    before(async () => {
        useS3(false); // these three are uploaded to LOCAL disk, as on a site that predates the offload
        for (const n of ['old-a.png', 'old-b.png', 'old-c.png']) {
            const r = await uploadPng(n, 700, 500);
            assert.strictEqual(r.status, 201);
            assert.strictEqual(r.body.storage, 'local');
            localIds.push(r.body.id);
        }
        useS3(true);
    });

    test('a run stopped by --limit resumes from its cursor', async () => {
        const first = await migration.runMigration('offload', { limit: 1 });
        assert.strictEqual(first.status, 'running');
        assert.strictEqual(await migration.getState(), 'migrating');
        const marked = await migration.countOffloaded();
        const second = await migration.runMigration('offload');
        assert.strictEqual(second.status, 'done', JSON.stringify(second));
        assert.ok(second.cursor > first.cursor);
        assert.ok(await migration.countOffloaded() >= marked + 2);
    });

    test('offload completes: objects in the bucket, local copies kept (no --delete-local), CDN base published', async () => {
        assert.strictEqual(await migration.getState(), 'offloaded');
        for (const id of localIds) {
            const m = (await asAdmin('get', `/media/${id}`)).body;
            assert.strictEqual(m.storage, 's3');
            assert.strictEqual(m.sourceUrl, `/uploads/${m.mediaDetails.file}`, 'still relative');
            for (const f of ownedFiles(m)) {
                assert.ok(objects.has(`uploads/${f}`), `${f} in the bucket`);
                assert.ok(fs.existsSync(path.join(TMP_UPLOADS, f)), `${f} kept on disk`);
            }
        }
        const s = await request(app).get('/api/v1/settings');
        assert.strictEqual(s.body.media_public_base, BASE);
    });

    test('offload is idempotent: a second run moves nothing and uploads nothing', async () => {
        const puts = log.filter((l) => l.method === 'PUT').length;
        const again = await migration.runMigration('offload');
        assert.strictEqual(again.status, 'done');
        assert.strictEqual(again.moved, 0);
        assert.strictEqual(log.filter((l) => l.method === 'PUT').length, puts);
    });

    test('switching to local is refused while items are in the bucket', async () => {
        const r = await asAdmin('put', '/media-storage').send({ driver: 'local' });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.body.code, 'rest_media_storage_in_use');
    });

    test('restore brings every file back, clears the markers, keeps the objects, and unpublishes the CDN base', async () => {
        // Simulate a node without the local copies (the multi-node case): delete them first.
        const m0 = (await asAdmin('get', `/media/${localIds[0]}`)).body;
        for (const f of ownedFiles(m0)) fs.unlinkSync(path.join(TMP_UPLOADS, f));
        const keys = objects.size;
        const r = await migration.runMigration('restore');
        assert.strictEqual(r.status, 'done', JSON.stringify(r));
        assert.strictEqual(await migration.getState(), 'local');
        assert.strictEqual(await migration.countOffloaded(), 0);
        assert.strictEqual(objects.size, keys, 'restore never deletes from the bucket');
        for (const f of ownedFiles(m0)) assert.ok(fs.existsSync(path.join(TMP_UPLOADS, f)), `${f} restored`);
        // Restored bytes are the bytes: served locally again, not redirected.
        const served = await request(app).get(`/uploads/${m0.mediaDetails.file}`);
        assert.strictEqual(served.status, 200);
        const s = await request(app).get('/api/v1/settings');
        assert.strictEqual(s.body.media_public_base, '');
        const again = await migration.runMigration('restore');
        assert.strictEqual(again.moved, 0, 'restore is idempotent');
        await options.updateOption(migration.PROGRESS_OPTION, null);
    });
});

describe('s3Request: the method-generic signer behind the adapter', () => {
    const s3 = { bucket: 'site-media', region: 'eu-west-1', accessKeyId: 'AKID', secretAccessKey: 'SECRET', sessionToken: null, endpoint: null, prefix: '' };
    const capture = () => {
        const seen: any[] = [];
        const fakeRequest = (opts: any, cb: any) => {
            seen.push(opts);
            const { EventEmitter } = require('events');
            const res = new EventEmitter();
            res.statusCode = 200; res.headers = {};
            const req = new EventEmitter();
            req.end = () => { cb(res); res.emit('end'); };
            return req;
        };
        return { seen, fakeRequest };
    };

    test('a body-less request signs the empty-payload digest and its own method; only PUT sends a length', async () => {
        const { seen, fakeRequest } = capture();
        const { s3Request } = require('../core/s3-offload');
        const now = new Date('2026-10-15T12:00:00Z');
        for (const m of ['GET', 'HEAD', 'DELETE']) await s3Request(m, 'uploads/2026/10/a.jpg', s3, {}, { request: fakeRequest, now });
        await s3Request('PUT', 'uploads/2026/10/a.jpg', s3, { body: Buffer.from('abc'), headers: { 'Content-Type': 'image/jpeg' } }, { request: fakeRequest, now });
        const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
        for (const o of seen.slice(0, 3)) {
            assert.strictEqual(o.host, 'site-media.s3.eu-west-1.amazonaws.com');
            assert.strictEqual(o.path, '/uploads/2026/10/a.jpg');
            assert.strictEqual(o.headers['X-Amz-Content-Sha256'], EMPTY);
            assert.strictEqual(o.headers['Content-Length'], undefined);
        }
        assert.deepStrictEqual(seen.map((o) => o.method), ['GET', 'HEAD', 'DELETE', 'PUT']);
        assert.strictEqual(seen[3].headers['Content-Length'], '3');
        assert.strictEqual(seen[3].headers['Content-Type'], 'image/jpeg');
        // Different methods produce different signatures over the same key and time.
        const sigs = new Set(seen.map((o) => o.headers.Authorization.split('Signature=')[1]));
        assert.strictEqual(sigs.size, 4);
    });

    test('the destination is still decided by config alone: a hostile key is refused before any request', async () => {
        const { seen, fakeRequest } = capture();
        const { s3Request } = require('../core/s3-offload');
        await assert.rejects(() => s3Request('GET', 'uploads/../../etc/passwd', s3, {}, { request: fakeRequest }));
        assert.strictEqual(seen.length, 0);
    });
});
