/**
 * WordJS — IDLE REAPING OF A SITE'S WORKERS, ON THE REAL APP (documentation/multisite-design.md, "Phase 2
 * as built", core/site-workers).
 *
 * Boots the REAL Express app with multisite ON, a main site and one other site (TWO), and ONE plugin
 * installed on the network and active on both. The plugin is real code in a real sandboxed child process:
 * what is at stake is a process that is gone and must come back, transparently, for the next need.
 *
 *   - preparing a site starts none of its workers; its first request does, and the request is answered
 *   - a site idle for longer than multisite.workerIdleMinutes loses its workers; the main site never does
 *   - the next plugin route on the idle site starts them again before it is dispatched, so the first
 *     request is answered (concurrent first requests share one start: one new worker)
 *   - the site's grants, its grant ceiling and its egress allowlist are what the new worker runs under
 *   - a request in flight keeps its site awake; a due cron event wakes it; 0 turns reaping off
 *
 * THE WORLD. Like multisite-plugins.test.ts: a throwaway data directory, the process in the backend
 * directory (a plugin's code must live in plugins/ for the sandbox to grant its worker read access).
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const bcrypt = require('bcryptjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-ms-idle-${process.pid}-`));
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
config.multisite = { enabled: true, networkDbPath: path.join(DATA_DIR, 'network.db'), workerIdleMinutes: 15 };

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
const siteWorkers = require('../core/site-workers');
const app = require('../index');

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
const MAIN = 'main.example.com';
const TWO = 'two.example.com';
const SLUG = 'test-multisite-idle-probe';
const PLUGIN_DIR = path.join(plugins.PLUGINS_DIR, SLUG);
const CEILING = ['express:register_route', 'network', 'settings:read'];
const EGRESS = ['api.example.com'];
const LATER = () => Date.now() + 24 * 3600 * 1000;

let server: any;
let siteTwo = 0;
const tokens: Record<string, string> = {};

const direct = (method: string, url: string, host: string) =>
    (request(server) as any)[method](url).set('Host', host).set('Origin', `http://${host}`);
const bearer = (method: string, url: string, host: string, token: string) =>
    direct(method, url, host).set('Authorization', `Bearer ${token}`);
/** Every worker of a site in this process: its plugins' and its theme's (`s<id>:theme:<slug>`). */
const workersOf = (siteId: number) => isolate.listIsolateKeys().filter((k: string) => isolate.splitIsolateKey(k).siteId === siteId).sort();
/** Its worker of the probe plugin. */
const probeOf = (siteId: number) => workersOf(siteId).filter((k: string) => isolate.splitIsolateKey(k).slug === SLUG);
const BOTH = () => [`s${siteTwo}:${SLUG}`, `s${siteTwo}:theme:default`].sort();
const runCron = () => siteContext.runWithSite(1, () => require('../core/cron').runCron());
const whoami = (host: string) => direct('get', `${API}/plugin/${SLUG}/whoami`, host);
const onTwo = (fn: () => any) => siteContext.runWithSite(siteTwo, fn);

async function signIn(host: string, username: string): Promise<string> {
    const res = await direct('post', `${API}/auth/login`, host).send({ username, password: PASSWORD });
    assert.strictEqual(res.status, 200, `sign-in on ${host}: ${res.status} ${JSON.stringify(res.body)}`);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('wordjs_token='));
    assert.ok(cookie, `sign-in on ${host} sets a session cookie`);
    return decodeURIComponent(String(cookie).split(';')[0].slice('wordjs_token='.length));
}

/** The probe: a route answering with the blog name its OWN bridge reads and an id made once per worker. */
function writeProbePlugin() {
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    fs.writeFileSync(path.join(PLUGIN_DIR, 'manifest.json'), JSON.stringify({
        name: 'Multisite idle probe', version: '1.0.0', isolated: true, main: 'index.js',
        permissions: [
            { scope: 'express', access: 'register_route', reason: 'answers /whoami' },
            { scope: 'settings', access: 'read', reason: 'reads the blog name of the site it runs for' },
            { scope: 'network', access: '', reason: 'holds an egress allowlist the test checks survives a restart' },
        ],
    }, null, 2));
    fs.writeFileSync(path.join(PLUGIN_DIR, 'index.js'),
        "var workerId = Math.random().toString(36).slice(2);\n" +
        "exports.init = function (wordjs) {\n" +
        "  wordjs.http.route('get', '/whoami', async function (req, res) { res.status(200).json({ blogname: await wordjs.options.get('blogname'), workerId: workerId }); });\n" +
        "};\n");
}

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
        network.registerPrimarySite(MAIN_URL);
        network.addNetworkAdmin(r.lastID);
        const two = await networkSites.createSite({ slug: 'two', url: `http://${TWO}`, title: 'Site Two', adminUsername: 'admin', adminEmail: 'admin@two.example.com', adminPassword: PASSWORD });
        siteTwo = two.id;
    });
    require('../core/plugins-ready').markPluginsReady();
    server = http.createServer(app);
    await new Promise<void>((resolve) => siteContext.runWithSite(null, () => server.listen(0, '127.0.0.1', resolve)));
    tokens.net = await signIn(MAIN, 'netadmin');
    tokens.two = await signIn(TWO, 'admin');
});

after(async () => {
    siteWorkers.stopReaper();
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

describe('a site\'s workers start on its first need', () => {
    before(async () => {
        const offer = await bearer('put', `${API}/network/plugins/${SLUG}/ceiling`, MAIN, tokens.net).send({ tokens: CEILING, currentPassword: PASSWORD });
        assert.strictEqual(offer.status, 200, JSON.stringify(offer.body));
        const main = await bearer('post', `${API}/plugins/${SLUG}/activate`, MAIN, tokens.net);
        assert.strictEqual(main.status, 200, JSON.stringify(main.body));
        const act = await bearer('post', `${API}/plugins/${SLUG}/activate`, TWO, tokens.two);
        assert.strictEqual(act.status, 200, JSON.stringify(act.body));
        const grant = await bearer('post', `${API}/plugins/${SLUG}/permissions`, TWO, tokens.two).send({ granted: CEILING });
        assert.strictEqual(grant.status, 200, JSON.stringify(grant.body));
        await onTwo(() => require('../core/plugin-permissions').setEgressAllowlist(SLUG, EGRESS));
        await onTwo(() => isolate.reloadIsolatedPlugin(SLUG));
    });

    test('both sites run their worker of the plugin', async () => {
        assert.deepStrictEqual(probeOf(1), [SLUG]);
        assert.deepStrictEqual(workersOf(siteTwo), BOTH(), 'its plugin worker and its theme worker');
        const res = await whoami(TWO);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.blogname, 'Site Two');
        assert.strictEqual(siteWorkers.phaseOf(siteTwo), 'awake');
    });

    test('preparing a site again (a background pass) starts nothing', async () => {
        await siteWorkers.reapIdleSites(LATER());
        assert.deepStrictEqual(workersOf(siteTwo), []);
        await networkSites.forEachSecondarySite('test pass', () => { /* the outbox, webhooks and cron passes prepare every site */ });
        assert.deepStrictEqual(workersOf(siteTwo), [], 'a pass that only prepares the site spawns no worker');
        assert.strictEqual(siteWorkers.phaseOf(siteTwo), 'asleep');
    });
});

describe('an idle site loses its workers, and gets them back on its next request', () => {
    let before0: any;
    let fingerprint = '';
    before(async () => {
        before0 = await whoami(TWO);
        assert.strictEqual(before0.status, 200, JSON.stringify(before0.body));
        fingerprint = await onTwo(() => isolate.spawnPolicyFingerprint(SLUG));
        assert.ok(fingerprint && fingerprint.includes(EGRESS[0]), `the worker runs under the egress allowlist: ${fingerprint}`);
    });

    test('a site idle for less than the period keeps its workers', async () => {
        assert.deepStrictEqual(await siteWorkers.reapIdleSites(Date.now() + 60 * 1000), []);
        assert.deepStrictEqual(workersOf(siteTwo), BOTH());
    });

    test('past the idle period its workers stop, the main site\'s never do', async () => {
        const reaped = await siteWorkers.reapIdleSites(LATER());
        assert.deepStrictEqual(reaped, [siteTwo]);
        assert.deepStrictEqual(workersOf(siteTwo), [], 'its plugin worker and its theme worker');
        assert.strictEqual(siteWorkers.phaseOf(siteTwo), 'asleep');
        assert.deepStrictEqual(probeOf(1), [SLUG], 'the main site keeps its worker');
        assert.strictEqual((await whoami(MAIN)).status, 200);
        assert.deepStrictEqual(await siteWorkers.reapIdleSites(LATER()), [], 'nothing left to reap');
    });

    test('the next plugin route is answered by a new worker, started before dispatch', async () => {
        const res = await whoami(TWO);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.blogname, 'Site Two');
        assert.notStrictEqual(res.body.workerId, before0.body.workerId, 'a new process answered');
        assert.deepStrictEqual(workersOf(siteTwo), BOTH());
        assert.strictEqual(siteWorkers.phaseOf(siteTwo), 'awake');
    });

    test('its grants and egress allowlist are what the new worker runs under', async () => {
        assert.strictEqual(await onTwo(() => isolate.spawnPolicyFingerprint(SLUG)), fingerprint);
        await onTwo(async () => {
            const perms = require('../core/plugin-permissions');
            assert.deepStrictEqual([...perms.getGrants(SLUG)].sort(), [...CEILING].sort());
            assert.deepStrictEqual(perms.getEgressAllowlist(SLUG), EGRESS);
            assert.strictEqual(perms.isGranted(SLUG, 'settings', 'write'), false, 'still bounded by the ceiling');
        });
    });

    test('concurrent first requests after an idle stop share one start', async () => {
        await siteWorkers.reapIdleSites(LATER());
        assert.deepStrictEqual(workersOf(siteTwo), []);
        const answers = await Promise.all([whoami(TWO), whoami(TWO), whoami(TWO)]);
        for (const a of answers) assert.strictEqual(a.status, 200, JSON.stringify(a.body));
        assert.strictEqual(new Set(answers.map((a: any) => a.body.workerId)).size, 1, 'one worker answered all of them');
        assert.deepStrictEqual(workersOf(siteTwo), BOTH());
    });
});

describe('what keeps a site awake, and what wakes it', () => {
    test('a request in flight keeps its site awake however long it lasts', async () => {
        const res = new EventEmitter();
        await siteWorkers.enterRequest(siteTwo, res);
        assert.deepStrictEqual(await siteWorkers.reapIdleSites(LATER()), [], 'not while the response is open');
        assert.deepStrictEqual(workersOf(siteTwo), BOTH());
        res.emit('finish');
        assert.deepStrictEqual(await siteWorkers.reapIdleSites(LATER()), [siteTwo]);
        assert.deepStrictEqual(workersOf(siteTwo), []);
    });

    test('a cross-node activation for a sleeping site starts nothing', async () => {
        await onTwo(() => require('../core/coherence').handlePluginChange(JSON.stringify({ action: 'activate', slug: SLUG, origin: 'another-node' })));
        await new Promise((r) => setTimeout(r, 300));
        assert.deepStrictEqual(workersOf(siteTwo), []);
    });

    test('a due cron event wakes the site before it runs', async () => {
        await onTwo(async () => {
            const cron = require('../core/cron');
            await cron.scheduleEvent(Date.now() - 1000, null, 'publish_future_post', [0]);
        });
        await runCron();
        assert.strictEqual(siteWorkers.phaseOf(siteTwo), 'awake');
        assert.deepStrictEqual(workersOf(siteTwo), BOTH());
    });

    test('a due core event that never reaches plugin code does not', async () => {
        await siteWorkers.reapIdleSites(LATER());
        await onTwo(async () => {
            const cron = require('../core/cron');
            await cron.scheduleEvent(Date.now() - 1000, null, 'wordjs_collab_sweep');
        });
        await runCron();
        assert.deepStrictEqual(workersOf(siteTwo), []);
    });

    test('suspending the site stops its workers; resumed, its next request starts them', async () => {
        assert.strictEqual((await whoami(TWO)).status, 200);
        const s = await bearer('post', `${API}/network/sites/${siteTwo}/suspend`, MAIN, tokens.net).send({ currentPassword: PASSWORD });
        assert.strictEqual(s.status, 200, JSON.stringify(s.body));
        assert.deepStrictEqual(workersOf(siteTwo), []);
        const r = await bearer('post', `${API}/network/sites/${siteTwo}/resume`, MAIN, tokens.net).send({ currentPassword: PASSWORD });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const res = await whoami(TWO);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.blogname, 'Site Two');
    });

    test('workerIdleMinutes 0 turns reaping off', async () => {
        const saved = config.multisite.workerIdleMinutes;
        config.multisite.workerIdleMinutes = 0;
        try {
            assert.deepStrictEqual(await siteWorkers.reapIdleSites(LATER()), []);
            assert.deepStrictEqual(workersOf(siteTwo), BOTH());
        } finally { config.multisite.workerIdleMinutes = saved; }
    });
});
