/**
 * WordJS — MULTISITE ISOLATION ON THE REAL APP (documentation/multisite-design.md, guarantees I1–I8).
 *
 * Boots the REAL Express app from ../index with multisite ON, a main site (site 1) and two more sites
 * created through core/network-sites exactly as the network screen does. The two extra sites are twins:
 * the SAME administrator login and password, the same roles, and — because every site's database starts
 * empty — the same row ids. That is the IDOR shape that matters for tenancy: a request that reaches the
 * wrong site's data with the right id. Every cross attempt is paired with a positive control on the
 * owning site, so a refusal is never a pass for the wrong reason (a broken route, an empty site).
 *
 * THE WORLD. A throwaway install directory (wordjs-config.json, databases, uploads, the network store)
 * the process chdirs into BEFORE any application module loads; nothing of the developer's install is read
 * or written. Requests set `Host` to a name, so they arrive as a direct browser would: the address is the
 * Host, the transport plain http.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-multisite-${process.pid}-`));
const DATA_DIR = path.join(TMP_INSTALL, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const MAIN_URL = 'http://main.example.com';
fs.writeFileSync(path.join(TMP_INSTALL, 'wordjs-config.json'), JSON.stringify({
    installedAt: '2026-01-01T00:00:00.000Z',
    dbDriver: 'sqlite-native',
    siteUrl: MAIN_URL,
    hostPolicy: { ipLiterals: 'any' },
    multisite: { enabled: true },
}, null, 2));
process.chdir(TMP_INSTALL);
const ENV_KEYS = ['WORDJS_ALLOWED_HOSTS', 'WORDJS_IP_HOSTS', 'WORDJS_DEV_ORIGINS', 'WORDJS_TRUST_PROXY'];
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) { SAVED_ENV[key] = process.env[key]; delete process.env[key]; }

const config = require('../config/app');
config.dbPath = path.join(DATA_DIR, 'wordjs-native.db');
config.dbDriver = 'sqlite-native';
config.siteUrl = MAIN_URL;
config.site.url = MAIN_URL;
config.frontendUrl = MAIN_URL;
config.uploads.dir = path.join(TMP_INSTALL, 'uploads');
config.uploads.privateDir = path.join(DATA_DIR, 'private-uploads');
config.nodeEnv = 'production';
// ON before any application module loads: a module that reached site data at import time would throw
// here, exactly as it would on a real multisite boot.
config.multisite = { enabled: true };

const request = require('supertest');
const database = require('../config/database');
const siteContext = require('../core/site-context');
const network = require('../core/network');
const networkSites = require('../core/network-sites');
const app = require('../index');

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
const TWO = 'two.example.com';
const THREE = 'three.example.com';
let server: any;
let mainAdminId = 0;
let siteTwo = 0;
let siteThree = 0;

const direct = (method: string, url: string, host: string) =>
    (request(server) as any)[method](url).set('Host', host).set('Origin', `http://${host}`);

/** Sign in on `host` and return the session JWT (the cookie's value), used as a Bearer from then on. */
async function signIn(host: string, username: string, password = PASSWORD): Promise<string> {
    const res = await direct('post', `${API}/auth/login`, host).send({ username, password });
    assert.strictEqual(res.status, 200, `sign-in on ${host}: ${res.status} ${JSON.stringify(res.body)}`);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('wordjs_token='));
    assert.ok(cookie, `sign-in on ${host} sets a session cookie`);
    assert.ok(!/;\s*Domain=/i.test(String(cookie)), 'the session cookie stays host-only');
    return decodeURIComponent(String(cookie).split(';')[0].slice('wordjs_token='.length));
}
const bearer = (method: string, url: string, host: string, token: string) =>
    direct(method, url, host).set('Authorization', `Bearer ${token}`);

const tokens: Record<string, string> = {};

before(async () => {
    await siteContext.runWithSite(1, async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        await require('../core/options').initDefaultOptions(config);
        await require('../core/roles').loadRoles();
        await require('../core/post-types').initPostTypes();
        await require('../core/post-types').initTaxonomies();
        require('../core/adminMenu').initCoreMenus();
        const db = database.getDbAsync();
        for (const [login, setter] of [['netadmin', (id: number) => { mainAdminId = id; }], ['mainadmin', () => { /* a plain administrator of the main site */ }]] as const) {
            const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
                [login, bcrypt.hashSync(PASSWORD, 10), `${login}@main.example.com`, login]);
            await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [r.lastID]);
            setter(r.lastID);
        }
        network.registerPrimarySite(MAIN_URL);
        network.addNetworkAdmin(mainAdminId);
        const two = await networkSites.createSite({ slug: 'two', url: `http://${TWO}`, title: 'Site Two', adminUsername: 'admin', adminEmail: 'admin@two.example.com', adminPassword: PASSWORD });
        const three = await networkSites.createSite({ slug: 'three', url: `http://${THREE}`, title: 'Site Three', adminUsername: 'admin', adminEmail: 'admin@three.example.com', adminPassword: PASSWORD });
        siteTwo = two.id;
        siteThree = three.id;
    });
    // The boot marks this once the main site's plugins are loaded; until then /plugin/* answers 503.
    require('../core/plugins-ready').markPluginsReady();
    server = http.createServer(app);
    await new Promise<void>((resolve) => siteContext.runWithSite(null, () => server.listen(0, '127.0.0.1', resolve)));
    tokens.two = await signIn(TWO, 'admin');
    tokens.three = await signIn(THREE, 'admin');
    tokens.net = await signIn('main.example.com', 'netadmin');
    tokens.main = await signIn('main.example.com', 'mainadmin');
});

after(async () => {
    try { await new Promise<void>((resolve) => server.close(() => resolve())); } catch { /* already closed */ }
    try { await database.closeSiteDatabases(); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    try { network.closeNetworkStore(); } catch { /* */ }
    for (const key of ENV_KEYS) {
        if (SAVED_ENV[key] === undefined) delete process.env[key];
        else process.env[key] = SAVED_ENV[key];
    }
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP_INSTALL, { recursive: true, force: true }); } catch { /* files still open on Windows */ }
});

describe('sites and addresses', () => {
    test('the twin sites are distinct records with ids beyond the main site', () => {
        assert.ok(siteTwo > 1 && siteThree > siteTwo, `${siteTwo} ${siteThree}`);
        assert.notStrictEqual(network.getSite(siteTwo).dbPath, network.getSite(siteThree).dbPath);
    });

    test('each address answers with its own site (I1: options)', async () => {
        for (const [host, title] of [['main.example.com', 'WordJS'], [TWO, 'Site Two'], [THREE, 'Site Three']]) {
            const res = await direct('get', `${API}/settings`, host);
            assert.strictEqual(res.status, 200, `${host}: ${res.status}`);
            assert.strictEqual(res.body.blogname, title, `${host} serves its own title`);
        }
    });

    test('every response names the site that answered it, for the frontend to check', async () => {
        for (const [host, expected] of [['main.example.com', 'main.example.com'], [TWO, TWO], [THREE, THREE]]) {
            const res = await direct('get', `${API}/settings`, host);
            assert.strictEqual(res.headers['x-wordjs-site-host'], expected, host);
        }
    });

    test('an address no site declares gets 421 (I6)', async () => {
        const res = await direct('get', `${API}/settings`, 'four.example.com');
        assert.strictEqual(res.status, 421);
        assert.strictEqual(res.body.code, 'rest_host_not_allowed');
    });

    test('a forged X-Forwarded-Host from a direct client does not move a request to another site (I6)', async () => {
        const res = await direct('get', `${API}/settings`, THREE).set('X-Forwarded-Host', TWO);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.blogname, 'Site Three');
    });

    test('a new site cannot take an address of the main site or of another site', async () => {
        await siteContext.runWithSite(1, async () => {
            await assert.rejects(networkSites.createSite({ slug: 'x1', url: MAIN_URL, title: 'X', adminUsername: 'a', adminEmail: 'a@x.example', adminPassword: PASSWORD }),
                (e: any) => e.code === 'network_host_taken');
            await assert.rejects(networkSites.createSite({ slug: 'x2', url: `http://${TWO}`, title: 'X', adminUsername: 'a', adminEmail: 'a@x.example', adminPassword: PASSWORD }),
                (e: any) => e.code === 'network_host_taken');
            await assert.rejects(networkSites.createSite({ slug: 'x3', url: 'http://127.0.0.1', title: 'X', adminUsername: 'a', adminEmail: 'a@x.example', adminPassword: PASSWORD }),
                (e: any) => e.code === 'network_invalid_url');
        });
        assert.strictEqual(network.listSites().length, 3, 'a refused site leaves no record behind');
    });
});

describe('sessions and tokens (I2)', () => {
    test('each twin administrator is signed in to their own site', async () => {
        for (const [host, key] of [[TWO, 'two'], [THREE, 'three']]) {
            const res = await bearer('get', `${API}/users/me`, host, tokens[key]);
            assert.strictEqual(res.status, 200, `${host}: ${res.status} ${JSON.stringify(res.body)}`);
            assert.strictEqual(res.body.email || res.body.userEmail, `admin@${host}`);
        }
    });

    test("one site's session is refused on its twin, and the main site's on both", async () => {
        for (const [host, key] of [[THREE, 'two'], [TWO, 'three'], [TWO, 'net'], [THREE, 'main'], ['main.example.com', 'two']]) {
            const res = await bearer('get', `${API}/users/me`, host, tokens[key]);
            assert.strictEqual(res.status, 401, `${key}'s token on ${host}: ${res.status} ${JSON.stringify(res.body)}`);
        }
    });

    test('a token signed with the main secret, or claiming another site, is refused', async () => {
        // The pre-multisite shape: the raw secret, no site claim. Valid for the main site only.
        const legacy = jwt.sign({ userId: 1, username: 'admin' }, config.jwt.secret, { expiresIn: '1h' });
        assert.strictEqual((await bearer('get', `${API}/users/me`, TWO, legacy)).status, 401);
        // Site three's own key, but claiming site two (or no site at all).
        const key3 = require('../core/site-keys').siteSigningKey(siteThree);
        const claimsTwo = jwt.sign({ userId: 1, username: 'admin', sid: siteTwo }, key3, { expiresIn: '1h' });
        const claimsNone = jwt.sign({ userId: 1, username: 'admin' }, key3, { expiresIn: '1h' });
        assert.strictEqual((await bearer('get', `${API}/users/me`, THREE, claimsTwo)).status, 401);
        assert.strictEqual((await bearer('get', `${API}/users/me`, THREE, claimsNone)).status, 401);
        // Positive control: the right key and the right claim.
        const good = jwt.sign({ userId: 1, username: 'admin', sid: siteThree }, key3, { expiresIn: '1h' });
        assert.strictEqual((await bearer('get', `${API}/users/me`, THREE, good)).status, 200);
    });

    test('a token minted the pre-multisite way still works on the main site', async () => {
        const legacy = jwt.sign({ userId: mainAdminId, username: 'netadmin' }, config.jwt.secret, { expiresIn: '1h' });
        assert.strictEqual((await bearer('get', `${API}/users/me`, 'main.example.com', legacy)).status, 200);
    });
});

describe('content with the same ids (I1)', () => {
    let twoPost = 0;
    let threePost = 0;
    before(async () => {
        const a = await bearer('post', `${API}/posts`, TWO, tokens.two).send({ title: 'Two private plans', content: 'two-secret-body', status: 'draft' });
        assert.strictEqual(a.status, 201, JSON.stringify(a.body));
        twoPost = a.body.id;
        const b = await bearer('post', `${API}/posts`, THREE, tokens.three).send({ title: 'Three notes', content: 'three-body', status: 'draft' });
        assert.strictEqual(b.status, 201, JSON.stringify(b.body));
        threePost = b.body.id;
    });

    test('the twins hand out the same ids (the precondition of the IDOR checks below)', () => {
        assert.strictEqual(twoPost, threePost);
    });

    test('reading the id on the other site returns that site\'s own post, never this one', async () => {
        const onTwo = await bearer('get', `${API}/posts/${twoPost}`, TWO, tokens.two);
        assert.strictEqual(onTwo.status, 200);
        assert.match(JSON.stringify(onTwo.body), /two-secret-body/);
        const onThree = await bearer('get', `${API}/posts/${twoPost}`, THREE, tokens.three);
        assert.strictEqual(onThree.status, 200);
        assert.doesNotMatch(JSON.stringify(onThree.body), /two-secret-body|Two private plans/);
        const onMain = await bearer('get', `${API}/posts/${twoPost}`, 'main.example.com', tokens.net);
        assert.doesNotMatch(JSON.stringify(onMain.body), /two-secret-body|Two private plans/);
    });

    test('writing the id on the other site changes only that site\'s post', async () => {
        const res = await bearer('put', `${API}/posts/${threePost}`, THREE, tokens.three).send({ title: 'Three renamed' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const two = await bearer('get', `${API}/posts/${twoPost}`, TWO, tokens.two);
        assert.match(JSON.stringify(two.body), /Two private plans/);
    });

    test('listing and searching never cross sites', async () => {
        const res = await bearer('get', `${API}/posts?status=draft&search=private`, THREE, tokens.three);
        assert.doesNotMatch(JSON.stringify(res.body), /Two private plans/);
    });

    test('users are per site: the twin lists only its own accounts', async () => {
        const res = await bearer('get', `${API}/users`, THREE, tokens.three);
        assert.strictEqual(res.status, 200);
        const text = JSON.stringify(res.body);
        assert.match(text, /admin@three\.example\.com/);
        assert.doesNotMatch(text, /two\.example\.com|main\.example\.com/);
    });

    test('a setting saved on one site stays on that site (I1, I4: the option cache)', async () => {
        const save = await bearer('put', `${API}/settings`, TWO, tokens.two).send({ blogdescription: 'only on two' });
        assert.strictEqual(save.status, 200, JSON.stringify(save.body));
        const two = await direct('get', `${API}/settings`, TWO);
        const three = await direct('get', `${API}/settings`, THREE);
        const main = await direct('get', `${API}/settings`, 'main.example.com');
        assert.strictEqual(two.body.blogdescription, 'only on two');
        assert.notStrictEqual(three.body.blogdescription, 'only on two');
        assert.notStrictEqual(main.body.blogdescription, 'only on two');
    });
});

describe('uploads (I3)', () => {
    // A valid 1×1 PNG: the upload route checks the bytes, not the name.
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    let url = '';
    before(async () => {
        const res = await bearer('post', `${API}/media`, TWO, tokens.two).attach('file', PNG, 'pixel.png');
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        url = String(res.body.sourceUrl || res.body.source_url || res.body.url || '');
        url = url.replace(/^https?:\/\/[^/]+/, '');
        assert.match(url, /^\/uploads\//, `media URL: ${url}`);
    });

    test('the file is served on its own site', async () => {
        assert.strictEqual((await direct('get', url, TWO)).status, 200);
    });

    test('the same path is not served on the twin, the main site or an unknown address', async () => {
        assert.strictEqual((await direct('get', url, THREE)).status, 404);
        assert.strictEqual((await direct('get', url, 'main.example.com')).status, 404);
        assert.strictEqual((await direct('get', url, 'nobody.example.com')).status, 404);
    });

    test('the file lives in the site\'s own directory, outside the main site\'s served tree', () => {
        const rel = url.replace(/^\/uploads\//, '');
        assert.ok(fs.existsSync(path.join(network.siteDataDir(siteTwo), 'uploads', rel)));
        assert.ok(!fs.existsSync(path.join(config.uploads.dir, rel)));
    });
});

describe('what stays the main site\'s', () => {
    test('plugin code is the network\'s: a site lists and activates plugins, never installs or deletes them', async () => {
        // Phase 2: the site's own plugin screen answers (core/multisite-guards); I5 and I8 are proven with
        // a real plugin worker in multisite-plugins.test.ts.
        assert.strictEqual((await bearer('get', `${API}/plugins`, TWO, tokens.two)).status, 200);
        const active = await bearer('get', `${API}/plugins/active`, TWO, tokens.two);
        assert.strictEqual(active.status, 200);
        assert.deepStrictEqual(active.body, []);
        assert.strictEqual((await bearer('post', `${API}/plugins/upload`, TWO, tokens.two)).status, 403);
        assert.strictEqual((await bearer('post', `${API}/plugins/sample`, TWO, tokens.two)).status, 403);
        assert.strictEqual((await bearer('get', `${API}/plugin/anything/x`, TWO, tokens.two)).status, 404);
    });

    test('backups, certificates, the site-address screen and the installer writes are not reachable', async () => {
        assert.strictEqual((await bearer('get', `${API}/backups`, TWO, tokens.two)).status, 404);
        assert.strictEqual((await bearer('get', `${API}/system/certs/config`, TWO, tokens.two)).status, 404);
        assert.strictEqual((await bearer('get', `${API}/site-address`, TWO, tokens.two)).status, 404);
        assert.strictEqual((await bearer('post', `${API}/setup/install`, TWO, tokens.two).send({})).status, 403);
    });

    test('theme files cannot be created or deleted from another site', async () => {
        assert.strictEqual((await bearer('delete', `${API}/themes/default`, TWO, tokens.two)).status, 403);
        assert.strictEqual((await bearer('post', `${API}/themes/default`, TWO, tokens.two)).status, 403);
    });

    test('the admin menu of another site lists its own entries, never the network screen', async () => {
        const res = await bearer('get', `${API}/plugins/menus`, TWO, tokens.two);
        assert.strictEqual(res.status, 200);
        const hrefs = (Array.isArray(res.body) ? res.body : res.body.menus || res.body.items || []).map((m: any) => m.href);
        assert.ok(hrefs.includes('/admin'), JSON.stringify(hrefs));
        assert.ok(hrefs.includes('/admin/plugins'), `the site manages its plugins: ${JSON.stringify(hrefs)}`);
        assert.ok(!hrefs.includes('/admin/network'), JSON.stringify(hrefs));
    });
});

describe('the network screen\'s API', () => {
    test('only a network administrator, on the main site, can list the sites', async () => {
        assert.strictEqual((await bearer('get', `${API}/network/sites`, TWO, tokens.two)).status, 404);
        assert.strictEqual((await bearer('get', `${API}/network/sites`, 'main.example.com', tokens.main)).status, 403);
        const res = await bearer('get', `${API}/network/sites`, 'main.example.com', tokens.net);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.sites.map((s: any) => s.host), ['main.example.com', TWO, THREE]);
        assert.ok(!JSON.stringify(res.body).includes('wordjs-native.db'), 'file paths are not exposed');
    });

    test('status says who is a network administrator', async () => {
        const net = await bearer('get', `${API}/network/status`, 'main.example.com', tokens.net);
        const main = await bearer('get', `${API}/network/status`, 'main.example.com', tokens.main);
        const two = await bearer('get', `${API}/network/status`, TWO, tokens.two);
        assert.deepStrictEqual([net.body.networkAdmin, main.body.networkAdmin, two.body.networkAdmin], [true, false, false]);
    });

    test('creating a site re-authenticates, then provisions it end to end', async () => {
        const body = { slug: 'four', url: 'http://four.example.com', title: 'Site Four', adminUsername: 'owner', adminEmail: 'owner@four.example.com', adminPassword: PASSWORD };
        const refused = await bearer('post', `${API}/network/sites`, 'main.example.com', tokens.net).send({ ...body, currentPassword: 'wrong' });
        assert.notStrictEqual(refused.status, 201);
        const res = await bearer('post', `${API}/network/sites`, 'main.example.com', tokens.net).send({ ...body, currentPassword: PASSWORD });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        const settings = await direct('get', `${API}/settings`, 'four.example.com');
        assert.strictEqual(settings.status, 200);
        assert.strictEqual(settings.body.blogname, 'Site Four');
        await signIn('four.example.com', 'owner');
    });

    test('a suspended site answers 503, and comes back when resumed', async () => {
        const s = await bearer('post', `${API}/network/sites/${siteThree}/suspend`, 'main.example.com', tokens.net).send({ currentPassword: PASSWORD });
        assert.strictEqual(s.status, 200, JSON.stringify(s.body));
        assert.strictEqual((await direct('get', `${API}/settings`, THREE)).status, 503);
        assert.strictEqual((await direct('get', `${API}/settings`, TWO)).status, 200, 'the other sites are unaffected');
        const r = await bearer('post', `${API}/network/sites/${siteThree}/resume`, 'main.example.com', tokens.net).send({ currentPassword: PASSWORD });
        assert.strictEqual(r.status, 200);
        assert.strictEqual((await direct('get', `${API}/settings`, THREE)).status, 200);
    });

    test('the main site cannot be suspended', async () => {
        const res = await bearer('post', `${API}/network/sites/1/suspend`, 'main.example.com', tokens.net).send({ currentPassword: PASSWORD });
        assert.strictEqual(res.status, 400);
    });
});

describe('in-process state (I4, I7)', () => {
    test('cache entries of one site are invisible to another', async () => {
        const cache = require('../core/cache');
        await siteContext.runWithSite(siteTwo, () => cache.set('probe:key', 'two'));
        assert.strictEqual(await siteContext.runWithSite(siteThree, () => cache.get('probe:key')), null);
        assert.strictEqual(await siteContext.runWithSite(1, () => cache.get('probe:key')), null);
        assert.strictEqual(await siteContext.runWithSite(siteTwo, () => cache.get('probe:key')), 'two');
    });

    test('frontend purges of another site are qualified with its host', () => {
        const { siteQualifiedPurge } = require('../core/frontend-purge');
        const q = siteContext.runWithSite(siteTwo, () => siteQualifiedPurge(['posts'], ['/', '/hello']));
        assert.deepStrictEqual(q, { tags: [`site:${TWO}:posts`], paths: [`/wjs-site/${TWO}`, `/wjs-site/${TWO}/hello`] });
        const main = siteContext.runWithSite(1, () => siteQualifiedPurge(['posts'], ['/']));
        assert.deepStrictEqual(main, { tags: ['posts'], paths: ['/'] });
    });

    test('work with no site context fails instead of landing on the main site', async () => {
        assert.throws(() => siteContext.currentSiteId(), (e: any) => e.code === 'site_context_missing');
        await assert.rejects(async () => database.dbAsync.get('SELECT 1 AS x'), (e: any) => e.code === 'site_context_missing');
        await siteContext.runWithSite(null, async () => {
            await assert.rejects(async () => database.dbAsync.get('SELECT 1 AS x'), (e: any) => e.code === 'site_unresolved');
        });
    });

    test('a notification stream only receives notifications of its own site, whatever the user id', () => {
        const notifications = require('../core/notifications');
        const received: Record<string, string[]> = { two: [], three: [] };
        const fake = (key: string) => ({ write: (chunk: string) => { received[key].push(chunk); }, on: () => {}, end: () => {} });
        const resTwo = fake('two');
        const resThree = fake('three');
        siteContext.runWithSite(siteTwo, () => notifications.addClient(resTwo, 1));
        siteContext.runWithSite(siteThree, () => notifications.addClient(resThree, 1));
        try {
            siteContext.runWithSite(siteTwo, () => notifications.broadcast({ uuid: 'n-two', user_id: 1, title: 'for two' }));
            assert.strictEqual(received.two.length, 1);
            assert.strictEqual(received.three.length, 0, 'user 1 of site three never sees the notification of user 1 of site two');
        } finally {
            siteContext.runWithSite(siteTwo, () => notifications.removeClient(1, resTwo));
            siteContext.runWithSite(siteThree, () => notifications.removeClient(1, resThree));
        }
    });

    test('a transaction of one site cannot be used by another', async () => {
        await assert.rejects(siteContext.runWithSite(siteTwo, () => database.dbAsync.transaction(async () => {
            await siteContext.runWithSite(siteThree, () => database.dbAsync.get('SELECT 1 AS x'));
        })), /another site/);
    });
});
