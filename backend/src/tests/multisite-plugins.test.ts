/**
 * WordJS — MULTISITE PLUGINS ON THE REAL APP (documentation/multisite-design.md, guarantees I5 and I8).
 *
 * Boots the REAL Express app with multisite ON, a main site and two twin sites (same administrator
 * login, same row ids), and ONE plugin installed on the network. The plugin is real code in a real
 * sandboxed child process — a fake registry could not show what is at stake here, which is a live worker
 * answering for the wrong site:
 *
 *   I5  a plugin active on site A cannot act on site B. It is offered to the sites and activated on TWO
 *       only: its route answers on TWO (with TWO's data, read through its own bridge) and is a 404 on
 *       THREE and on the main site; its filter runs for TWO's work and never for THREE's; and once it is
 *       activated on THREE as well, each site reaches its OWN worker (two processes, two answers).
 *   I8  a site administrator cannot raise their plugin's privileges beyond the network's decision. A
 *       plugin the network does not offer cannot be activated; a grant beyond the ceiling is refused with
 *       403; lowering the ceiling takes the capability away from a running site at once.
 *
 * THE WORLD. Like the other multisite suite, a throwaway data directory (databases, uploads, the network
 * store) — but the process stays in the backend directory, because a plugin's code must live in the
 * backend's plugins/ tree for the sandbox to grant its worker read access to it. The fixture plugin is
 * written there and removed afterwards.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-ms-plugins-${process.pid}-`));
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const MAIN_URL = 'http://main.example.com';
const ENV_KEYS = ['WORDJS_ALLOWED_HOSTS', 'WORDJS_IP_HOSTS', 'WORDJS_DEV_ORIGINS', 'WORDJS_TRUST_PROXY'];
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) { SAVED_ENV[key] = process.env[key]; delete process.env[key]; }

const config = require('../config/app');
const SAVED_CONFIG = {
    dbPath: config.dbPath, dbDriver: config.dbDriver, siteUrl: config.siteUrl, siteSiteUrl: config.site.url,
    frontendUrl: config.frontendUrl, uploadsDir: config.uploads.dir, privateDir: config.uploads.privateDir,
    nodeEnv: config.nodeEnv, multisite: config.multisite, hostPolicy: config.hostPolicy, installedAt: config.installedAt,
};
config.dbPath = path.join(DATA_DIR, 'wordjs-native.db');
config.dbDriver = 'sqlite-native';
config.siteUrl = MAIN_URL;
config.site.url = MAIN_URL;
config.frontendUrl = MAIN_URL;
config.uploads.dir = path.join(TMP, 'uploads');
config.uploads.privateDir = path.join(DATA_DIR, 'private-uploads');
config.nodeEnv = 'production';
config.hostPolicy = { ipLiterals: 'any' };
config.installedAt = config.installedAt || '2026-01-01T00:00:00.000Z';
config.multisite = { enabled: true, networkDbPath: path.join(DATA_DIR, 'network.db') };

// This install is "installed" without a wordjs-config.json in the backend directory (plugin-public-footprint
// uses the same stub): the installer gate and the config readers see the values set above.
const configManager = require('../core/configManager');
const realIsInstalled = configManager.isInstalled;
const realGetConfig = configManager.getConfig;
configManager.isInstalled = () => true;
configManager.getConfig = () => ({
    installedAt: config.installedAt, dbDriver: 'sqlite-native', siteUrl: MAIN_URL,
    hostPolicy: config.hostPolicy, multisite: config.multisite,
});

const request = require('supertest');
const database = require('../config/database');
const siteContext = require('../core/site-context');
const network = require('../core/network');
const networkSites = require('../core/network-sites');
const plugins = require('../core/plugins');
const isolate = require('../core/plugin-isolate');
const hooks = require('../core/hooks');
const app = require('../index');

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
const MAIN = 'main.example.com';
const TWO = 'two.example.com';
const THREE = 'three.example.com';
const SLUG = 'test-multisite-probe';
const PLUGIN_DIR = path.join(plugins.PLUGINS_DIR, SLUG);
const CEILING = ['express:register_route', 'settings:read'];

let server: any;
let mainAdminId = 0;
let siteTwo = 0;
let siteThree = 0;
const tokens: Record<string, string> = {};

const direct = (method: string, url: string, host: string) =>
    (request(server) as any)[method](url).set('Host', host).set('Origin', `http://${host}`);
const bearer = (method: string, url: string, host: string, token: string) =>
    direct(method, url, host).set('Authorization', `Bearer ${token}`);

async function signIn(host: string, username: string): Promise<string> {
    const res = await direct('post', `${API}/auth/login`, host).send({ username, password: PASSWORD });
    assert.strictEqual(res.status, 200, `sign-in on ${host}: ${res.status} ${JSON.stringify(res.body)}`);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('wordjs_token='));
    assert.ok(cookie, `sign-in on ${host} sets a session cookie`);
    return decodeURIComponent(String(cookie).split(';')[0].slice('wordjs_token='.length));
}

/** The probe: a route and a filter, both answering with the blog name its OWN bridge reads. */
function writeProbePlugin() {
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    fs.writeFileSync(path.join(PLUGIN_DIR, 'manifest.json'), JSON.stringify({
        name: 'Multisite probe', version: '1.0.0', isolated: true, main: 'index.js',
        permissions: [
            { scope: 'express', access: 'register_route', reason: 'answers /whoami' },
            { scope: 'settings', access: 'read', reason: 'reads the blog name of the site it runs for' },
        ],
    }, null, 2));
    fs.writeFileSync(path.join(PLUGIN_DIR, 'index.js'),
        // A random id made once per worker: module globals live in that worker only, so two sites running
        // the plugin hold two different ids (two processes, two memories).
        "var workerId = Math.random().toString(36).slice(2);\n" +
        "exports.init = function (wordjs) {\n" +
        "  wordjs.hooks.addFilter('ms_probe_filter', async function (v) { return v + '|' + (await wordjs.options.get('blogname')); });\n" +
        "  wordjs.http.route('get', '/whoami', async function (req, res) { res.status(200).json({ blogname: await wordjs.options.get('blogname'), workerId: workerId }); });\n" +
        "};\n");
}

/** Apply the probe filter as `siteId` would (a hook fired by that site's work). */
const filterOn = (siteId: number) => siteContext.runWithSite(siteId, () => hooks.applyFilters('ms_probe_filter', 'v'));

before(async () => {
    writeProbePlugin();
    await siteContext.runWithSite(1, async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        await require('../core/options').initDefaultOptions(config);
        await require('../core/roles').loadRoles();
        await require('../core/post-types').initPostTypes();
        await require('../core/post-types').initTaxonomies();
        require('../core/adminMenu').initCoreMenus();
        await require('../core/plugin-permissions').loadGrants();
        await require('../core/plugin-permissions').loadEgressHosts();
        const db = database.getDbAsync();
        const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['netadmin', bcrypt.hashSync(PASSWORD, 10), 'netadmin@main.example.com', 'netadmin']);
        await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [r.lastID]);
        mainAdminId = r.lastID;
        network.registerPrimarySite(MAIN_URL);
        network.addNetworkAdmin(mainAdminId);
        const two = await networkSites.createSite({ slug: 'two', url: `http://${TWO}`, title: 'Site Two', adminUsername: 'admin', adminEmail: 'admin@two.example.com', adminPassword: PASSWORD });
        const three = await networkSites.createSite({ slug: 'three', url: `http://${THREE}`, title: 'Site Three', adminUsername: 'admin', adminEmail: 'admin@three.example.com', adminPassword: PASSWORD });
        siteTwo = two.id;
        siteThree = three.id;
    });
    require('../core/plugins-ready').markPluginsReady();
    server = http.createServer(app);
    await new Promise<void>((resolve) => siteContext.runWithSite(null, () => server.listen(0, '127.0.0.1', resolve)));
    tokens.two = await signIn(TWO, 'admin');
    tokens.three = await signIn(THREE, 'admin');
    tokens.net = await signIn(MAIN, 'netadmin');
});

after(async () => {
    for (const key of isolate.listIsolateKeys()) { try { await isolate.unloadIsolateKey(key); } catch { /* */ } }
    try { await new Promise<void>((resolve) => server.close(() => resolve())); } catch { /* already closed */ }
    try { await database.closeSiteDatabases(); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    try { network.closeNetworkStore(); } catch { /* */ }
    try { fs.rmSync(PLUGIN_DIR, { recursive: true, force: true }); } catch { /* */ }
    configManager.isInstalled = realIsInstalled;
    configManager.getConfig = realGetConfig;
    for (const key of ENV_KEYS) {
        if (SAVED_ENV[key] === undefined) delete process.env[key];
        else process.env[key] = SAVED_ENV[key];
    }
    Object.assign(config, {
        dbPath: SAVED_CONFIG.dbPath, dbDriver: SAVED_CONFIG.dbDriver, siteUrl: SAVED_CONFIG.siteUrl, frontendUrl: SAVED_CONFIG.frontendUrl,
        nodeEnv: SAVED_CONFIG.nodeEnv, multisite: SAVED_CONFIG.multisite, hostPolicy: SAVED_CONFIG.hostPolicy, installedAt: SAVED_CONFIG.installedAt,
    });
    config.site.url = SAVED_CONFIG.siteSiteUrl;
    config.uploads.dir = SAVED_CONFIG.uploadsDir;
    config.uploads.privateDir = SAVED_CONFIG.privateDir;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* files still open on Windows */ }
});

describe('a plugin the network has not offered (I8)', () => {
    test('another site sees it listed as not offered and cannot activate it', async () => {
        const list = await bearer('get', `${API}/plugins`, TWO, tokens.two);
        assert.strictEqual(list.status, 200, JSON.stringify(list.body));
        const row = list.body.find((p: any) => p.slug === SLUG);
        assert.ok(row, 'the network-wide plugin is listed on the site');
        assert.strictEqual(row.offered, false);
        assert.deepStrictEqual(row.grantCeiling, []);
        const res = await bearer('post', `${API}/plugins/${SLUG}/activate`, TWO, tokens.two);
        assert.strictEqual(res.status, 403, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'plugin_not_offered');
        assert.strictEqual(isolate.listIsolateKeys().some((k: string) => k.endsWith(SLUG)), false, 'no worker was started');
    });

    test('nor grant it anything', async () => {
        const res = await bearer('post', `${API}/plugins/${SLUG}/permissions`, TWO, tokens.two).send({ granted: ['settings:read'] });
        assert.strictEqual(res.status, 403, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'plugin_not_offered');
    });

    test('a site administrator cannot install or delete plugin code', async () => {
        assert.strictEqual((await bearer('delete', `${API}/plugins/${SLUG}`, TWO, tokens.two).send({ password: PASSWORD })).status, 403);
        assert.strictEqual((await bearer('post', `${API}/plugins/upload`, TWO, tokens.two)).status, 403);
    });

    test('only a network administrator, on the main site, sets a ceiling', async () => {
        assert.strictEqual((await bearer('put', `${API}/network/plugins/${SLUG}/ceiling`, TWO, tokens.two).send({ tokens: CEILING, currentPassword: PASSWORD })).status, 404);
        const bad = await bearer('put', `${API}/network/plugins/${SLUG}/ceiling`, MAIN, tokens.net).send({ tokens: ['not a token'], currentPassword: PASSWORD });
        assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
        const wrong = await bearer('put', `${API}/network/plugins/${SLUG}/ceiling`, MAIN, tokens.net).send({ tokens: CEILING, currentPassword: 'nope' });
        assert.notStrictEqual(wrong.status, 200, 'a wrong password does not offer the plugin');
        assert.strictEqual(network.pluginCeiling(SLUG), null);
    });
});

describe('offered to the sites, active on TWO only (I5)', () => {
    before(async () => {
        const res = await bearer('put', `${API}/network/plugins/${SLUG}/ceiling`, MAIN, tokens.net).send({ tokens: CEILING, currentPassword: PASSWORD });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.ceiling, [...CEILING].sort());
        const act = await bearer('post', `${API}/plugins/${SLUG}/activate`, TWO, tokens.two);
        assert.strictEqual(act.status, 200, JSON.stringify(act.body));
    });

    test('the network lists the plugin with its ceiling', async () => {
        const res = await bearer('get', `${API}/network/plugins`, MAIN, tokens.net);
        assert.strictEqual(res.status, 200);
        const row = res.body.plugins.find((p: any) => p.slug === SLUG);
        assert.deepStrictEqual(row.ceiling, [...CEILING].sort());
    });

    test('one worker, keyed by its site', () => {
        const keys = isolate.listIsolateKeys().filter((k: string) => k.endsWith(SLUG));
        assert.deepStrictEqual(keys, [`s${siteTwo}:${SLUG}`]);
    });

    test('its route answers on TWO, with TWO\'s own data read through its bridge', async () => {
        const res = await direct('get', `${API}/plugin/${SLUG}/whoami`, TWO);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.blogname, 'Site Two');
    });

    test('and does not exist on THREE nor on the main site', async () => {
        assert.strictEqual((await direct('get', `${API}/plugin/${SLUG}/whoami`, THREE)).status, 404);
        assert.strictEqual((await direct('get', `${API}/plugin/${SLUG}/whoami`, MAIN)).status, 404);
    });

    test('its filter runs for TWO\'s work and never for THREE\'s or the main site\'s', async () => {
        assert.strictEqual(await filterOn(siteTwo), 'v|Site Two');
        assert.strictEqual(await filterOn(siteThree), 'v');
        assert.strictEqual(await filterOn(1), 'v');
    });

    test('the site lists it as active, the twin as offered but inactive', async () => {
        const two = (await bearer('get', `${API}/plugins/active`, TWO, tokens.two)).body;
        const three = (await bearer('get', `${API}/plugins/active`, THREE, tokens.three)).body;
        assert.ok(two.includes(SLUG), JSON.stringify(two));
        assert.ok(!three.includes(SLUG), JSON.stringify(three));
        const row = (await bearer('get', `${API}/plugins`, THREE, tokens.three)).body.find((p: any) => p.slug === SLUG);
        assert.strictEqual(row.offered, true);
        assert.strictEqual(row.active, false);
    });
});

describe('a grant beyond the ceiling (I8)', () => {
    test('is refused with 403 and changes nothing', async () => {
        const res = await bearer('post', `${API}/plugins/${SLUG}/permissions`, TWO, tokens.two)
            .send({ granted: ['express:register_route', 'settings:read', 'settings:write'] });
        assert.strictEqual(res.status, 403, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'plugin_grant_beyond_ceiling');
        assert.deepStrictEqual(res.body.data.beyond, ['settings:write']);
        const net = await bearer('post', `${API}/plugins/${SLUG}/permissions`, TWO, tokens.two).send({ granted: ['settings:read'], network: true });
        assert.strictEqual(net.status, 403, JSON.stringify(net.body));
        const grants = await siteContext.runWithSite(siteTwo, () => require('../core/plugin-permissions').getGrants(SLUG));
        assert.deepStrictEqual([...grants].sort(), [...CEILING].sort());
    });

    test('a grant within the ceiling is accepted', async () => {
        const res = await bearer('post', `${API}/plugins/${SLUG}/permissions`, TWO, tokens.two).send({ granted: CEILING });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    });

    test('the main site is not bounded by the ceiling', () => siteContext.runWithSite(1, async () => {
        const perms = require('../core/plugin-permissions');
        assert.strictEqual(perms.ceilingFor(SLUG), null);
        assert.deepStrictEqual(perms.tokensBeyondCeiling(SLUG, ['settings:write', 'network']), []);
    }));
});

describe('the same plugin active on both twins (I5)', () => {
    before(async () => {
        const act = await bearer('post', `${API}/plugins/${SLUG}/activate`, THREE, tokens.three);
        assert.strictEqual(act.status, 200, JSON.stringify(act.body));
    });

    test('each site reaches its own worker, with its own memory', async () => {
        const two = await direct('get', `${API}/plugin/${SLUG}/whoami`, TWO);
        const three = await direct('get', `${API}/plugin/${SLUG}/whoami`, THREE);
        assert.strictEqual(two.body.blogname, 'Site Two');
        assert.strictEqual(three.body.blogname, 'Site Three');
        assert.ok(two.body.workerId && three.body.workerId);
        assert.notStrictEqual(two.body.workerId, three.body.workerId);
        assert.strictEqual(await filterOn(siteTwo), 'v|Site Two');
        assert.strictEqual(await filterOn(siteThree), 'v|Site Three');
        assert.strictEqual(await filterOn(1), 'v');
    });

    test('deactivating it on THREE leaves TWO\'s worker running', async () => {
        const res = await bearer('post', `${API}/plugins/${SLUG}/deactivate`, THREE, tokens.three);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual((await direct('get', `${API}/plugin/${SLUG}/whoami`, THREE)).status, 404);
        assert.strictEqual((await direct('get', `${API}/plugin/${SLUG}/whoami`, TWO)).status, 200);
        assert.strictEqual(await filterOn(siteThree), 'v');
    });
});

describe('the network lowers or withdraws its offer (I8)', () => {
    test('a lowered ceiling takes the capability away from the running site at once', async () => {
        const res = await bearer('put', `${API}/network/plugins/${SLUG}/ceiling`, MAIN, tokens.net).send({ tokens: ['settings:read'], currentPassword: PASSWORD });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        // The stored grant still names express:register_route, but it no longer counts on TWO: the
        // restarted worker could not mount its route.
        const granted = await siteContext.runWithSite(siteTwo, () => require('../core/plugin-permissions').isGranted(SLUG, 'express', 'register_route'));
        assert.strictEqual(granted, false);
        assert.strictEqual((await direct('get', `${API}/plugin/${SLUG}/whoami`, TWO)).status, 404);
        assert.strictEqual(await filterOn(siteTwo), 'v|Site Two', 'what the ceiling still allows keeps working');
    });

    test('withdrawing the offer deactivates it on every other site', async () => {
        const res = await bearer('delete', `${API}/network/plugins/${SLUG}/ceiling`, MAIN, tokens.net).send({ currentPassword: PASSWORD });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.deactivatedOn, [siteTwo]);
        assert.strictEqual(isolate.listIsolateKeys().some((k: string) => k.endsWith(SLUG)), false);
        assert.strictEqual(await filterOn(siteTwo), 'v');
        const active = (await bearer('get', `${API}/plugins/active`, TWO, tokens.two)).body;
        assert.ok(!active.includes(SLUG));
    });
});

describe('a suspended site runs no plugin code', () => {
    const workersOf = (siteId: number) => isolate.listIsolateKeys().filter((k: string) => k === `s${siteId}:${SLUG}`);
    before(async () => {
        const offer = await bearer('put', `${API}/network/plugins/${SLUG}/ceiling`, MAIN, tokens.net).send({ tokens: CEILING, currentPassword: PASSWORD });
        assert.strictEqual(offer.status, 200, JSON.stringify(offer.body));
        const act = await bearer('post', `${API}/plugins/${SLUG}/activate`, TWO, tokens.two);
        assert.strictEqual(act.status, 200, JSON.stringify(act.body));
        assert.strictEqual(workersOf(siteTwo).length, 1);
    });

    test('suspending the site stops its workers, resuming starts them again', async () => {
        const s = await bearer('post', `${API}/network/sites/${siteTwo}/suspend`, MAIN, tokens.net).send({ currentPassword: PASSWORD });
        assert.strictEqual(s.status, 200, JSON.stringify(s.body));
        assert.deepStrictEqual(workersOf(siteTwo), []);
        const r = await bearer('post', `${API}/network/sites/${siteTwo}/resume`, MAIN, tokens.net).send({ currentPassword: PASSWORD });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            const res = await direct('get', `${API}/plugin/${SLUG}/whoami`, TWO);
            if (res.status === 200) { assert.strictEqual(res.body.blogname, 'Site Two'); return; }
            await new Promise((done) => setTimeout(done, 200));
        }
        assert.fail('the plugin did not come back on the resumed site');
    });
});
