/**
 * WordJS — CHANGING A SITE'S ADDRESS AFTER CREATION (QA X1-09), ON THE REAL APP.
 *
 * Network → Sites could create a site but never move it: no route changed its address or gave it another
 * host name, so taking a site from staging to production meant deleting and recreating it. PUT
 * /network/sites/:id/address now moves it and sets its other addresses; this boots the real Express app
 * with multisite ON and checks, on the same world:
 *
 *   · the new main address and every other address answer with THAT site, the old one no longer does;
 *   · the site's own siteurl/home follow the main address; the change is in the network audit log;
 *   · an address of another site or of the main site is refused (409), the main site cannot be moved
 *     here (400), and only a re-authenticated network administrator may do it.
 *
 * MUTATION PROOF: drop the aliases from core/network policySites — the www address gets 421; skip the
 * siteurl update in changeSiteAddress — the option check fails; drop exceptSiteId from
 * assertHostAvailable — keeping the site's own main address is refused as taken.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-site-address-${process.pid}-`));
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
config.multisite = { enabled: true };

const request = require('supertest');
const database = require('../config/database');
const siteContext = require('../core/site-context');
const network = require('../core/network');
const networkSites = require('../core/network-sites');
const app = require('../index');

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
const MAIN = 'main.example.com';
const TWO = 'two.example.com';
const THREE = 'three.example.com';
let server: any;
let netAdminId = 0;
let siteTwo = 0;
let siteThree = 0;
const tokens: Record<string, string> = {};

const direct = (method: string, url: string, host: string) =>
    (request(server) as any)[method](url).set('Host', host).set('Origin', `http://${host}`);
const bearer = (method: string, url: string, host: string, token: string) =>
    direct(method, url, host).set('Authorization', `Bearer ${token}`);

function sessionFrom(res: any): string {
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('wordjs_token='));
    assert.ok(cookie, `a session cookie was set: ${res.status} ${JSON.stringify(res.body)}`);
    return decodeURIComponent(String(cookie).split(';')[0].slice('wordjs_token='.length));
}

async function signIn(host: string, username: string, password = PASSWORD): Promise<string> {
    const res = await direct('post', `${API}/auth/login`, host).send({ username, password });
    assert.strictEqual(res.status, 200, `sign-in on ${host}: ${res.status} ${JSON.stringify(res.body)}`);
    return sessionFrom(res);
}

const networkAudit = async (action: string) => (await network.auditLog(500)).filter((r: any) => r.action === action);
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
        for (const login of ['netadmin', 'mainadmin']) {
            const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
                [login, bcrypt.hashSync(PASSWORD, 10), `${login}@main.example.com`, login]);
            await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [r.lastID]);
            if (login === 'netadmin') netAdminId = r.lastID;
        }
        await network.registerPrimarySite(MAIN_URL);
        await network.addNetworkAdmin(netAdminId, 'netadmin');
        siteTwo = (await networkSites.createSite({ slug: 'two', url: `http://${TWO}`, title: 'Site Two', adminUsername: 'admin', adminEmail: 'admin@two.example.com', adminPassword: PASSWORD })).id;
        siteThree = (await networkSites.createSite({ slug: 'three', url: `http://${THREE}`, title: 'Site Three', adminUsername: 'admin', adminEmail: 'admin@three.example.com', adminPassword: PASSWORD })).id;
    });
    require('../core/plugins-ready').markPluginsReady();
    server = http.createServer(app);
    await new Promise<void>((resolve) => siteContext.runWithSite(null, () => server.listen(0, '127.0.0.1', resolve)));
    tokens.net = await signIn(MAIN, 'netadmin');
    tokens.main = await signIn(MAIN, 'mainadmin');
    tokens.two = await signIn(TWO, 'admin');
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

const addr = (siteId: number, body: object, as = tokens.net) =>
    bearer('put', `${API}/network/sites/${siteId}/address`, MAIN, as).send({ currentPassword: PASSWORD, ...body });

describe('moving a site to another address', () => {
    test('the new address and its www twin answer with the site; the old address no longer does', async () => {
        const res = await addr(siteTwo, { url: 'http://two-new.example.com', aliases: ['www.two-new.example.com', 'WWW.TWO-NEW.EXAMPLE.COM'] });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.site.url, 'http://two-new.example.com');
        assert.deepStrictEqual(res.body.site.aliases, ['www.two-new.example.com']);

        for (const host of ['two-new.example.com', 'www.two-new.example.com']) {
            const page = await direct('get', `${API}/settings`, host);
            assert.strictEqual(page.status, 200, `${host}: ${page.status}`);
            assert.strictEqual(page.body.blogname, 'Site Two', `${host} serves site two`);
        }
        const old = await direct('get', `${API}/settings`, TWO);
        assert.strictEqual(old.status, 421, 'the old address is no longer answered');
    });

    test("the site's own address options follow, and the change is audited", async () => {
        const siteurl = await siteContext.runWithSite(siteTwo, async () => require('../core/options').getOption('siteurl'));
        assert.strictEqual(siteurl, 'http://two-new.example.com');
        const rows = await networkAudit('site.address_changed');
        assert.ok(rows.some((r: any) => r.siteId === siteTwo && r.actorUserId === netAdminId), JSON.stringify(rows));
    });

    test('keeping the main address and changing only the other names works (its own address is not "taken")', async () => {
        const res = await addr(siteTwo, { url: 'http://two-new.example.com', aliases: [] });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.site.aliases, []);
        const www = await direct('get', `${API}/settings`, 'www.two-new.example.com');
        assert.strictEqual(www.status, 421);
    });

    test("another site's address, or the main site's, is refused", async () => {
        const taken = await addr(siteTwo, { url: `http://${THREE}` });
        assert.strictEqual(taken.status, 409, JSON.stringify(taken.body));
        assert.strictEqual(taken.body.code, 'network_host_taken');
        const mainAlias = await addr(siteTwo, { url: 'http://two-new.example.com', aliases: [MAIN] });
        assert.strictEqual(mainAlias.status, 409, JSON.stringify(mainAlias.body));
        const notAHost = await addr(siteTwo, { url: 'http://two-new.example.com', aliases: ['bad host/'] });
        assert.strictEqual(notAHost.status, 400);
        assert.strictEqual(notAHost.body.code, 'network_invalid_alias');
        const ip = await addr(siteTwo, { url: 'http://192.0.2.10' });
        assert.strictEqual(ip.status, 400);
        assert.strictEqual(ip.body.code, 'network_invalid_url');
    });

    test('the main site is moved on its own screen, not here', async () => {
        const res = await addr(1, { url: 'http://elsewhere.example.com' });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'network_primary_site');
    });

    test('only a re-authenticated network administrator', async () => {
        const plain = await addr(siteThree, { url: 'http://three-new.example.com' }, tokens.main);
        assert.strictEqual(plain.status, 403);
        const wrong = await bearer('put', `${API}/network/sites/${siteThree}/address`, MAIN, tokens.net).send({ currentPassword: 'nope', url: 'http://three-new.example.com' });
        assert.strictEqual(wrong.status, 403);
        const page = await direct('get', `${API}/settings`, THREE);
        assert.strictEqual(page.body.blogname, 'Site Three', 'nothing moved');
    });
});
