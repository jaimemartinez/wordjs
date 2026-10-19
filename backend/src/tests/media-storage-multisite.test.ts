/**
 * MEDIA STORAGE ON A NETWORK OF SITES — the REAL app (../index) with multisite on, three sites, and a
 * real HTTP server playing an S3-compatible bucket (path style, SigV4 required for writes, anonymous
 * public GET), configured through the `mediaStorage` block of wordjs-config.json as an operator would.
 *
 * Pinned here:
 *   1. KEY SPACES. Two sites that upload the SAME relative path (`<yyyy>/<mm>/same-<id>.png`) through the
 *      real media router get two objects: site 1 keeps `uploads/<rel>` (its keys and URLs are unchanged),
 *      every other site writes `uploads/sites/<id>/<rel>`. Each site's API delivery URL, its /uploads
 *      redirect and its media_public_base point at its own object, and deleting one site's item leaves
 *      the other's object in place.
 *   2. RESTORE FOR THE WHOLE NETWORK. POST /media-storage/migrate restore (network admin, main site)
 *      brings every site's offloaded media back to that site's own uploads root, and only then does the
 *      switch back to local storage go through.
 *   3. THE ONE-TIME KEY MOVE. Objects a site stored under the shared layout move into its own space; an
 *      object at a path that site 1 also holds stays where site 1 reads it.
 *   4. PER-SITE QUOTA. A network administrator caps a site's media storage; an upload over it answers
 *      413 and leaves nothing behind, while the other sites (and the main site) are unaffected.
 *   5. PLUGIN LIFECYCLE RATE LIMIT. Reload/activate/deactivate share a bounded per-site, per-account
 *      budget on the real router.
 *
 * MUTATION PROOFS (each was run once):
 *   - objectKeyFor / publicUrlFor without the site segment → case 1 fails (one object, overwritten);
 *   - /migrate running runMigration as the main site only → case 2 fails (409 in use, sites 2/3 marked);
 *   - the quota check removed from POST /media → case 4 fails (201);
 *   - pluginLifecycleLimiter removed from /:slug/reload → case 5 fails (no 429);
 *   - bindRequestToCurrentSite dropped from core/site-resolver → the multi-chunk upload answers 500.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-ms-media-${process.pid}-`));
const DATA_DIR = path.join(TMP_INSTALL, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const MAIN_URL = 'http://main.example.com';
const ACCESS_KEY = 'AKIAMULTISITEMEDIA01';
const SECRET_KEY = 'multisite-media-secret-key-0123456789';
const BUCKET = 'wjs-net';

// ---- the fake S3-compatible bucket -------------------------------------------------------------------
const objects = new Map<string, Buffer>();
const bucket = http.createServer((req: any, res: any) => {
    const url = new URL(req.url, 'http://x');
    const prefix = `/${BUCKET}/`;
    if (!url.pathname.startsWith(prefix)) { res.statusCode = 404; return res.end(); }
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const auth = String(req.headers.authorization || '');
    const signed = auth.startsWith(`AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/`);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
        const o = objects.get(key);
        if (req.method === 'GET') {
            if (!o) { res.statusCode = 404; return res.end(); }
            return res.end(o);
        }
        if (!signed) { res.statusCode = 403; return res.end(); }
        if (req.method === 'PUT') { objects.set(key, Buffer.concat(chunks)); res.statusCode = 200; return res.end(); }
        if (req.method === 'HEAD') {
            if (!o) { res.statusCode = 404; return res.end(); }
            res.setHeader('Content-Length', String(o.length));
            return res.end();
        }
        if (req.method === 'DELETE') { objects.delete(key); res.statusCode = 204; return res.end(); }
        res.statusCode = 405; res.end();
    });
});

let ORIGIN = '';
const CONFIG_FILE = path.join(TMP_INSTALL, 'wordjs-config.json');
function writeConfig(mediaStorage: any) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
        installedAt: '2026-01-01T00:00:00.000Z',
        dbDriver: 'sqlite-native',
        siteUrl: MAIN_URL,
        hostPolicy: { ipLiterals: 'any' },
        multisite: { enabled: true },
        ...(mediaStorage ? { mediaStorage } : {}),
    }, null, 2));
}
writeConfig(null);
process.chdir(TMP_INSTALL);
const ENV_KEYS = ['WORDJS_ALLOWED_HOSTS', 'WORDJS_IP_HOSTS', 'WORDJS_DEV_ORIGINS', 'WORDJS_TRUST_PROXY'];
const SAVED_ENV: Record<string, string | undefined> = {};

const config = require('../config/app');
config.dbPath = path.join(DATA_DIR, 'wordjs-native.db');
config.dbDriver = 'sqlite-native';
config.siteUrl = MAIN_URL;
config.site.url = MAIN_URL;
config.frontendUrl = MAIN_URL;
config.uploads.dir = path.join(TMP_INSTALL, 'uploads');
config.uploads.privateDir = path.join(DATA_DIR, 'private-uploads');
config.nodeEnv = 'production';
config.multisite = { enabled: true };

// THE SAME RELATIVE PATH ON TWO SITES. Upload names carry a random 8-hex suffix; while `sameName` is on,
// the media router's uuid gives the same one on every site, as a collision (or a deliberate choice) would.
let sameName = false;
{
    const uuid = require('uuid');
    const realV4 = uuid.v4;
    Object.defineProperty(uuid, 'v4', { configurable: true, enumerable: true, get: () => (...a: any[]) => (sameName ? '5a5e5a5e-0000-4000-8000-000000000000' : realV4(...a)) });
}

const mediaStorage = require('../core/media-storage');
for (const k of Object.values(mediaStorage.ENV_BY_FIELD) as string[]) { SAVED_ENV[k] = process.env[k]; delete process.env[k]; }
for (const key of ENV_KEYS) { SAVED_ENV[key] = process.env[key]; delete process.env[key]; }

const request = require('supertest');
const sharp = require('sharp');
const database = require('../config/database');
const siteContext = require('../core/site-context');
const network = require('../core/network');
const networkSites = require('../core/network-sites');
const migration = require('../core/media-storage-migrate');
const app = require('../index');

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
const TWO = 'two.example.com';
const THREE = 'three.example.com';
const MAIN = 'main.example.com';
let server: any;
let siteTwo = 0;
let siteThree = 0;
let netAdminId = 0;
const tokens: Record<string, string> = {};

const direct = (method: string, url: string, host: string) =>
    (request(server) as any)[method](url).set('Host', host).set('Origin', `http://${host}`);
async function signIn(host: string, username: string): Promise<string> {
    const res = await direct('post', `${API}/auth/login`, host).send({ username, password: PASSWORD });
    assert.strictEqual(res.status, 200, `sign-in on ${host}: ${res.status} ${JSON.stringify(res.body)}`);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('wordjs_token='));
    return decodeURIComponent(String(cookie).split(';')[0].slice('wordjs_token='.length));
}
const bearer = (method: string, url: string, host: string, token: string) =>
    direct(method, url, host).set('Authorization', `Bearer ${token}`);

const COLORS: Record<string, { r: number; g: number; b: number }> = {
    main: { r: 10, g: 20, b: 30 }, two: { r: 200, g: 10, b: 10 }, three: { r: 10, g: 200, b: 10 },
};
async function png(color: { r: number; g: number; b: number }, w = 48, h = 32): Promise<Buffer> {
    return sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
}
async function upload(host: string, token: string, color: any, name = 'same.png') {
    return bearer('post', `${API}/media`, host, token).attach('file', await png(color), { filename: name, contentType: 'image/png' });
}
const useBucket = () => writeConfig({ driver: 's3', bucket: BUCKET, region: 'auto', endpoint: ORIGIN, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY });
async function settle(): Promise<void> {
    // configManager caches the file for ~2 s; the storage block is read through it.
    require('../core/configManager').invalidateConfigCache();
    await new Promise((r) => setTimeout(r, 2100));
}
async function waitForMigrations() {
    for (let i = 0; i < 200; i++) {
        if (!(await siteContext.runWithSite(1, () => migration.isRunningOnAnySite()))) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('migration did not finish');
}

before(async () => {
    await new Promise<void>((resolve) => bucket.listen(0, '127.0.0.1', resolve));
    ORIGIN = `http://127.0.0.1:${bucket.address().port}`;
    await siteContext.runWithSite(1, async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        await require('../core/options').initDefaultOptions(config);
        await require('../core/roles').loadRoles();
        await require('../core/post-types').initPostTypes();
        await require('../core/post-types').initTaxonomies();
        require('../core/adminMenu').initCoreMenus();
        const db = database.getDbAsync();
        const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['netadmin', bcrypt.hashSync(PASSWORD, 10), 'netadmin@main.example.com', 'netadmin']);
        await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [r.lastID]);
        netAdminId = r.lastID;
        network.registerPrimarySite(MAIN_URL);
        network.addNetworkAdmin(netAdminId);
        siteTwo = (await networkSites.createSite({ slug: 'two', url: `http://${TWO}`, title: 'Two', adminUsername: 'admin', adminEmail: 'admin@two.example.com', adminPassword: PASSWORD })).id;
        siteThree = (await networkSites.createSite({ slug: 'three', url: `http://${THREE}`, title: 'Three', adminUsername: 'admin', adminEmail: 'admin@three.example.com', adminPassword: PASSWORD })).id;
    });
    require('../core/plugins-ready').markPluginsReady();
    server = http.createServer(app);
    await new Promise<void>((resolve) => siteContext.runWithSite(null, () => server.listen(0, '127.0.0.1', resolve)));
    tokens.two = await signIn(TWO, 'admin');
    tokens.three = await signIn(THREE, 'admin');
    tokens.net = await signIn(MAIN, 'netadmin');
    useBucket();
    await settle();
});

after(async () => {
    sameName = false;
    try { await new Promise<void>((resolve) => server.close(() => resolve())); } catch { /* */ }
    try { await new Promise<void>((resolve) => bucket.close(() => resolve())); } catch { /* */ }
    try { await database.closeSiteDatabases(); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    try { network.closeNetworkStore(); } catch { /* */ }
    for (const [k, v] of Object.entries(SAVED_ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP_INSTALL, { recursive: true, force: true }); } catch { /* files still open on Windows */ }
});

const uploaded: Record<string, any> = {};

describe('S3 keys are per site', () => {
    test('the same relative path on three sites gives three objects; site 1 keeps its keys', async () => {
        sameName = true;
        try {
            uploaded.main = (await upload(MAIN, tokens.net, COLORS.main)).body;
            const two = await upload(TWO, tokens.two, COLORS.two);
            assert.strictEqual(two.status, 201, JSON.stringify(two.body));
            uploaded.two = two.body;
            const three = await upload(THREE, tokens.three, COLORS.three);
            assert.strictEqual(three.status, 201, JSON.stringify(three.body));
            uploaded.three = three.body;
        } finally {
            sameName = false;
        }
        const rel = uploaded.two.mediaDetails.file;
        assert.ok(/^\d{4}\/\d{2}\/same-5a5e5a5e\.png$/.test(rel), rel);
        assert.strictEqual(uploaded.main.mediaDetails.file, rel, 'the main site stored the same relative path');
        assert.strictEqual(uploaded.three.mediaDetails.file, rel, 'site three stored the same relative path');

        const base = `${ORIGIN}/${BUCKET}/uploads`;
        const keyMain = `uploads/${rel}`;
        const keyTwo = `uploads/sites/${siteTwo}/${rel}`;
        const keyThree = `uploads/sites/${siteThree}/${rel}`;
        for (const k of [keyMain, keyTwo, keyThree]) assert.ok(objects.has(k), `object ${k} exists`);
        const pixel = async (buf: Buffer) => Array.from((await sharp(buf).raw().toBuffer()).subarray(0, 3));
        assert.deepStrictEqual(await pixel(objects.get(keyMain)!), [10, 20, 30], 'site 1 object is site 1 bytes');
        assert.deepStrictEqual(await pixel(objects.get(keyTwo)!), [200, 10, 10], 'site 2 object is site 2 bytes');
        assert.deepStrictEqual(await pixel(objects.get(keyThree)!), [10, 200, 10], 'site 3 object is site 3 bytes');

        // Delivery URLs: site 1 exactly as before; the others in their own space.
        assert.strictEqual(uploaded.main.deliveryUrl, `${base}/${rel}`);
        assert.strictEqual(uploaded.two.deliveryUrl, `${base}/sites/${siteTwo}/${rel}`);
        assert.strictEqual(uploaded.three.deliveryUrl, `${base}/sites/${siteThree}/${rel}`);
        // The /uploads fallback of each address redirects to that site's object.
        for (const [host, want] of [[MAIN, `${base}/${rel}`], [TWO, `${base}/sites/${siteTwo}/${rel}`], [THREE, `${base}/sites/${siteThree}/${rel}`]]) {
            const r = await direct('get', `/uploads/${rel}`, host);
            assert.strictEqual(r.status, 302, `${host}: ${r.status}`);
            assert.strictEqual(r.headers.location, want, host);
        }
        // Site 1 never addresses another site's space through its own /uploads.
        const cross = await direct('get', `/uploads/sites/${siteTwo}/${rel}`, MAIN);
        assert.notStrictEqual(cross.status, 302, 'site 1 must not redirect into a site space');
    });

    test('deleting one site\'s item leaves the other sites\' objects', async () => {
        const rel = uploaded.three.mediaDetails.file;
        const del = await bearer('delete', `${API}/media/${uploaded.three.id}?force=true`, THREE, tokens.three);
        assert.ok(del.status === 200 || del.status === 204, `${del.status} ${JSON.stringify(del.body)}`);
        await new Promise((r) => setTimeout(r, 200)); // the object removal runs after the commit
        assert.ok(!objects.has(`uploads/sites/${siteThree}/${rel}`), 'site 3 object removed');
        assert.ok(objects.has(`uploads/sites/${siteTwo}/${rel}`), 'site 2 object kept');
        assert.ok(objects.has(`uploads/${rel}`), 'site 1 object kept');
    });

    test('each site\'s public delivery base is its own space once its library is offloaded', async () => {
        const res = await bearer('post', `${API}/media-storage/migrate`, MAIN, tokens.net).send({ direction: 'offload' });
        assert.strictEqual(res.status, 202, JSON.stringify(res.body));
        await waitForMigrations();
        const base = `${ORIGIN}/${BUCKET}/uploads`;
        const pub = async (host: string) => (await direct('get', `${API}/settings`, host)).body.media_public_base;
        assert.strictEqual(await pub(MAIN), base);
        assert.strictEqual(await pub(TWO), `${base}/sites/${siteTwo}`);
    });
});

describe('an upload larger than one network packet', () => {
    // A browser streams a real photo in many chunks; multer resumes from the stream's events, which run
    // outside the request's async context. The resolver binds the request to its site, so the upload is
    // stored as that site (and not refused with "No site context").
    // MUTATION PROOF: drop bindRequestToCurrentSite from core/site-resolver and this answers 500.
    test('a multi-chunk upload on another site is stored as that site', async () => {
        const noise = Buffer.alloc(900 * 600 * 3);
        for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919 + (i >> 5) * 104729) & 0xff;
        const big = await sharp(noise, { raw: { width: 900, height: 600, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
        assert.ok(big.length > 1024 * 1024, `the body spans many packets (${big.length} bytes)`);
        // Streamed like a browser does: headers first, then the body in pieces with pauses, so multer is
        // already reading when most of the bytes arrive.
        const boundary = '----wjs' + Date.now();
        const CRLF = '\r\n';
        const head = Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="big.png"${CRLF}Content-Type: image/png${CRLF}${CRLF}`);
        const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
        const body = Buffer.concat([head, big, tail]);
        const res: any = await new Promise((resolve, reject) => {
            const r = http.request({
                host: '127.0.0.1', port: server.address().port, method: 'POST', path: `${API}/media`,
                headers: {
                    Host: TWO, Origin: `http://${TWO}`, Authorization: `Bearer ${tokens.two}`,
                    'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length),
                },
            }, (resp: any) => {
                const chunks: Buffer[] = [];
                resp.on('data', (c: Buffer) => chunks.push(c));
                resp.on('end', () => { let b: any = {}; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ } resolve({ status: resp.statusCode, body: b }); });
            });
            r.on('error', reject);
            const step = 64 * 1024;
            let off = 0;
            const pump = () => {
                if (off >= body.length) return r.end();
                r.write(body.subarray(off, off + step));
                off += step;
                setTimeout(pump, 15);
            };
            pump();
        });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        assert.ok(objects.has(`uploads/sites/${siteTwo}/${res.body.mediaDetails.file}`), 'stored in site 2 space');
        const del = await bearer('delete', `${API}/media/${res.body.id}?force=true`, TWO, tokens.two);
        assert.ok(del.status === 200 || del.status === 204);
    });
});

describe('the one-time move into per-site key spaces', () => {
    test('a site\'s objects under the shared layout move to its space; a path site 1 also holds stays', async () => {
        const rel = uploaded.two.mediaDetails.file;
        // Recreate the pre-key-space bucket for site 2: its object at the shared key, nothing in its space,
        // and the move not yet recorded. Site 1 holds the same path, so the shared object must stay.
        const bytes = objects.get(`uploads/sites/${siteTwo}/${rel}`)!;
        objects.delete(`uploads/sites/${siteTwo}/${rel}`);
        const sharedMain = objects.get(`uploads/${rel}`)!;
        await siteContext.runWithSite(siteTwo, () => require('../core/options').deleteOption(migration.KEY_LAYOUT_OPTION));
        // An item only site 2 has, stored under the shared layout.
        const own = await upload(TWO, tokens.two, COLORS.two, 'only-two.png');
        assert.strictEqual(own.status, 201);
        const ownRel = own.body.mediaDetails.file;
        const ownBytes = objects.get(`uploads/sites/${siteTwo}/${ownRel}`)!;
        objects.delete(`uploads/sites/${siteTwo}/${ownRel}`);
        objects.set(`uploads/${ownRel}`, ownBytes);

        const report = await siteContext.runWithSite(1, () => migration.migrateSiteKeys());
        const two = report.sites.find((s: any) => s.siteId === siteTwo);
        assert.ok(two && two.failed === 0, JSON.stringify(report));
        assert.ok(objects.get(`uploads/sites/${siteTwo}/${ownRel}`)?.equals(ownBytes), 'own item moved into the site space');
        assert.ok(!objects.has(`uploads/${ownRel}`), 'own item removed from the shared layout');
        assert.ok(objects.has(`uploads/sites/${siteTwo}/${rel}`), 'colliding item copied into the site space');
        assert.ok(objects.get(`uploads/${rel}`)?.equals(sharedMain), 'the shared object site 1 reads stays');
        // (Under the shared layout that one key held whichever site wrote last; put site 2's own bytes back
        // so the restore below can tell the sites apart.)
        objects.set(`uploads/sites/${siteTwo}/${rel}`, bytes);
        // Done once: a second walk copies nothing.
        const again = await siteContext.runWithSite(1, () => migration.migrateSiteKeys());
        assert.deepStrictEqual(again.sites, []);
    });
});

describe('restore runs for every site of the network', () => {
    test('POST /media-storage/migrate restore brings every site back, then local storage is accepted', async () => {
        const marked = async (id: number) => siteContext.runWithSite(id, async () => {
            if (id !== 1) await database.openSiteDatabase(id, network.getSite(id).dbPath || network.siteDbPath(id));
            return migration.countOffloaded();
        });
        assert.ok((await marked(siteTwo)) > 0, 'site 2 has offloaded media before the restore');
        const res = await bearer('post', `${API}/media-storage/migrate`, MAIN, tokens.net).send({ direction: 'restore' });
        assert.strictEqual(res.status, 202, JSON.stringify(res.body));
        await waitForMigrations();
        for (const id of [1, siteTwo, siteThree]) assert.strictEqual(await marked(id), 0, `site ${id} still has items in the bucket`);
        // Site 2's file is back in ITS uploads root, with its own bytes.
        const rel = uploaded.two.mediaDetails.file;
        const twoRoot = path.join(network.siteDataDir(siteTwo), 'uploads');
        const back = fs.readFileSync(path.join(twoRoot, ...rel.split('/')));
        assert.deepStrictEqual(Array.from((await sharp(back).raw().toBuffer()).subarray(0, 3)), [200, 10, 10]);
        // And the network can switch back to local storage.
        const put = await bearer('put', `${API}/media-storage`, MAIN, tokens.net).send({ driver: 'local' });
        assert.strictEqual(put.status, 200, JSON.stringify(put.body));
        await settle();
        const after = await direct('get', `/uploads/${rel}`, TWO);
        assert.strictEqual(after.status, 200, 'site 2 serves its restored file from disk');
        useBucket();
        await settle();
    });
});

describe('per-site upload quota', () => {
    test('a network administrator caps a site; an upload over it is refused and leaves nothing', async () => {
        const quotas = await bearer('get', `${API}/network/quotas`, MAIN, tokens.net);
        assert.strictEqual(quotas.status, 200, JSON.stringify(quotas.body));
        const usedTwo = quotas.body.sites.find((s: any) => s.id === siteTwo).used;
        assert.ok(usedTwo > 0, 'site 2 usage is counted');
        const noPassword = await bearer('put', `${API}/network/sites/${siteTwo}/quota`, MAIN, tokens.net).send({ bytes: usedTwo + 10 });
        assert.ok(noPassword.status === 400 || noPassword.status === 403, `the quota write re-authenticates (${noPassword.status})`);
        const set = await bearer('put', `${API}/network/sites/${siteTwo}/quota`, MAIN, tokens.net).send({ bytes: usedTwo + 10, currentPassword: PASSWORD });
        assert.strictEqual(set.status, 200, JSON.stringify(set.body));
        assert.strictEqual(set.body.effectiveQuota, usedTwo + 10);
        const main = await bearer('put', `${API}/network/sites/1/quota`, MAIN, tokens.net).send({ bytes: 1, currentPassword: PASSWORD });
        assert.strictEqual(main.status, 400, 'the main site has no quota');

        const before = objects.size;
        const over = await upload(TWO, tokens.two, COLORS.two, 'over.png');
        assert.strictEqual(over.status, 413, JSON.stringify(over.body));
        assert.strictEqual(over.body.code, 'rest_upload_quota_exceeded');
        assert.strictEqual(objects.size, before, 'no object written');
        const list = await bearer('get', `${API}/media?search=over`, TWO, tokens.two);
        assert.ok(!(list.body || []).some((m: any) => /over/.test(m.mediaDetails?.file || '')), 'no row');

        // The other sites are not capped by it.
        assert.strictEqual((await upload(THREE, tokens.three, COLORS.three, 'free.png')).status, 201);
        assert.strictEqual((await upload(MAIN, tokens.net, COLORS.main, 'free.png')).status, 201);
        // A network default applies to a site without its own; the site's own wins.
        const dflt = await bearer('put', `${API}/network/quotas/default`, MAIN, tokens.net).send({ bytes: 1, currentPassword: PASSWORD });
        assert.strictEqual(dflt.status, 200);
        assert.strictEqual((await upload(THREE, tokens.three, COLORS.three, 'capped.png')).status, 413);
        await bearer('put', `${API}/network/quotas/default`, MAIN, tokens.net).send({ bytes: null, currentPassword: PASSWORD });
        const clear = await bearer('put', `${API}/network/sites/${siteTwo}/quota`, MAIN, tokens.net).send({ bytes: null, currentPassword: PASSWORD });
        assert.strictEqual(clear.body.effectiveQuota, null);
        assert.strictEqual((await upload(TWO, tokens.two, COLORS.two, 'again.png')).status, 201);
    });
});

describe('plugin lifecycle rate limit', () => {
    test('reload/activate/deactivate share a bounded budget per site and account', async () => {
        const max = require('../routes/plugins').PLUGIN_LIFECYCLE_MAX;
        for (let i = 0; i < max; i++) {
            const last = await bearer('post', `${API}/plugins/no-such-plugin/${i % 3 === 0 ? 'reload' : i % 3 === 1 ? 'activate' : 'deactivate'}`, TWO, tokens.two).send({});
            assert.notStrictEqual(last.status, 429, `request ${i + 1} of ${max} was limited`);
        }
        const limited = await bearer('post', `${API}/plugins/no-such-plugin/reload`, TWO, tokens.two).send({});
        assert.strictEqual(limited.status, 429, JSON.stringify(limited.body));
        assert.strictEqual(limited.body.code, 'rest_plugin_lifecycle_rate_limited');
        // Another site's administrator has their own budget.
        const other = await bearer('post', `${API}/plugins/no-such-plugin/reload`, THREE, tokens.three).send({});
        assert.notStrictEqual(other.status, 429);
    });
});
