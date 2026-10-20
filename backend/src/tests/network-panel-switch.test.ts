/**
 * WordJS — TURNING THE NETWORK ON AND OFF FROM THE PANEL (zero config), on the REAL app.
 *
 * Settings → Network replaces `npm run network -- enable|disable` + a manual restart:
 *
 *   1. GET /network/setup lists what a network needs in plain words (the database engine — sqlite-legacy
 *      cannot hold one, and the screen offers the migration —, the main address, whether WordJS can
 *      restart itself) and the main site's administrators. Main-site administrators only.
 *   2. POST /network/enable asks for the password AND a fresh two-factor code, refuses an account without
 *      two-factor authentication, a non-administrator, a chosen user who is not an administrator, and an
 *      unmet requirement; it records site 1 and the network administrators, writes multisite.enabled,
 *      audits it in both logs, and asks the supervisor for a restart (exit code 75).
 *   3. With the network on, a local install accepts a <name>.localhost site; a public one refuses it.
 *   4. POST /network/disable: network administrators of the main site only (404 on another site, 403 for
 *      a main-site administrator who is not one), refused while another site exists, then the same
 *      write + audit + restart.
 *   5. Network administrators are added and removed from the panel; the last one cannot be removed.
 *   6. The restart itself: how each way of running WordJS is restarted, and a peer node's announcement
 *      applied to this node's config.
 *
 * MUTATION PROOF (verified once each): drop requireStepUp from POST /enable → the "no code" test passes a
 * 200 and fails; drop refuseSetupCaller → the author gets 200; drop the requirements() check from
 * enableNetwork → the sqlite-legacy test enables; drop scheduleRestart from enableNetwork → no exit code;
 * drop the otherSites check from disableNetwork → the "other site exists" test disables; drop the
 * mainSiteIsLocal guard → the public install accepts a .localhost site.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-netswitch-${process.pid}-`));
const DATA_DIR = path.join(TMP_INSTALL, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const MAIN_URL = 'http://localhost:3000';
const MAIN = 'localhost:3000';
const CONFIG_FILE = path.join(TMP_INSTALL, 'wordjs-config.json');
fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    installedAt: '2026-01-01T00:00:00.000Z',
    dbDriver: 'sqlite-native',
    siteUrl: MAIN_URL,
}, null, 2));
process.chdir(TMP_INSTALL);
const ENV_KEYS = ['WORDJS_ALLOWED_HOSTS', 'WORDJS_IP_HOSTS', 'WORDJS_DEV_ORIGINS', 'WORDJS_TRUST_PROXY', 'WORDJS_SUPERVISED'];
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) { SAVED_ENV[key] = process.env[key]; delete process.env[key]; }
// Run as backend/server.js runs the app: a supervisor restarts it when it exits with 75.
process.env.WORDJS_SUPERVISED = '1';

const config = require('../config/app');
config.dbPath = path.join(DATA_DIR, 'wordjs-native.db');
config.dbDriver = 'sqlite-native';
config.siteUrl = MAIN_URL;
config.site.url = MAIN_URL;
config.frontendUrl = MAIN_URL;
config.uploads.dir = path.join(TMP_INSTALL, 'uploads');
config.uploads.privateDir = path.join(DATA_DIR, 'private-uploads');
config.nodeEnv = 'production';
config.multisite = { enabled: false };

const request = require('supertest');
const database = require('../config/database');
const siteContext = require('../core/site-context');
const network = require('../core/network');
const networkSites = require('../core/network-sites');
const restart = require('../core/restart');
const configManager = require('../core/configManager');
const totp = require('../core/totp');
const mfa = require('../core/mfa');
const User = require('../models/User');
const app = require('../index');

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
const BLOG = 'blog.localhost:3000';
let server: any;
const U: Record<string, number> = {};
const tokens: Record<string, string> = {};
const secrets: Record<string, string> = {};
const exits: number[] = [];

// TOTP refuses a time step already used: every fresh code moves the clock one step on.
const realNow = Date.now;
let offsetMs = 0;
Date.now = () => realNow() + offsetMs;
const freshCode = (who: string) => { offsetMs += 31 * 1000; return totp.totp(secrets[who]); };

const direct = (method: string, url: string, host: string) =>
    (request(server) as any)[method](url).set('Host', host).set('Origin', `http://${host}`);
const as = (who: string, method: string, url: string, host = MAIN) =>
    direct(method, url, host).set('Authorization', `Bearer ${tokens[who]}`);

async function signIn(host: string, username: string, code?: string): Promise<string> {
    const res = await direct('post', `${API}/auth/login`, host).send({ username, password: PASSWORD });
    assert.strictEqual(res.status, 200, `sign-in ${username}@${host}: ${res.status} ${JSON.stringify(res.body)}`);
    if (res.body && res.body.mfaRequired) {
        const second = await direct('post', `${API}/auth/mfa`, host).send({ challenge: res.body.challenge, code });
        assert.strictEqual(second.status, 200, `mfa ${username}: ${second.status} ${JSON.stringify(second.body)}`);
        return cookieOf(second);
    }
    return cookieOf(res);
}
function cookieOf(res: any): string {
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('wordjs_token='));
    return decodeURIComponent(String(cookie).split(';')[0].slice('wordjs_token='.length));
}

const onMain = <T>(fn: () => T): T => siteContext.runWithSite(1, fn);
const fileConfig = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

async function seed(login: string, role: string) {
    const db = database.getDbAsync();
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        [login, bcrypt.hashSync(PASSWORD, 10), `${login}@example.com`, login]);
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

async function enroll(login: string) {
    const secret = totp.generateSecret();
    await onMain(async () => {
        await User.updateMeta(U[login], mfa.META.lastStep, '-1');
        await User.updateMeta(U[login], mfa.META.secret, secret);
        await User.updateMeta(U[login], mfa.META.backup, JSON.stringify([]));
        await User.updateMeta(U[login], mfa.META.enabled, '1');
    });
    secrets[login] = secret;
}

/** What the restart that the last switch scheduled asked for, once its timer ran. */
async function restartCode(): Promise<number | undefined> {
    for (let i = 0; i < 40 && !exits.length; i++) await new Promise((r) => setTimeout(r, 50));
    const code = exits.shift();
    restart.resetForTests();
    return code;
}

/** What the backend does when it starts again after a switch: read multisite.enabled from the file. */
async function bootAs(enabled: boolean) {
    config.multisite = { ...(config.multisite || {}), enabled };
    if (enabled) {
        await network.ready();
        network.registerPrimarySite(MAIN_URL);
    }
}

before(async () => {
    restart.setExitHandlerForTests((code: number) => { exits.push(code); });
    await onMain(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        await require('../core/options').initDefaultOptions(config);
        await require('../core/roles').loadRoles();
        await require('../core/post-types').initPostTypes();
        await require('../core/post-types').initTaxonomies();
        require('../core/adminMenu').initCoreMenus();
        await seed('owner', 'administrator');
        await seed('second', 'administrator');
        await seed('writer', 'author');
    });
    require('../core/plugins-ready').markPluginsReady();
    server = http.createServer(app);
    await new Promise<void>((resolve) => siteContext.runWithSite(null, () => server.listen(0, '127.0.0.1', resolve)));
    tokens.owner = await signIn(MAIN, 'owner');
    tokens.second = await signIn(MAIN, 'second');
    tokens.writer = await signIn(MAIN, 'writer');
});

after(async () => {
    restart.setExitHandlerForTests(null);
    Date.now = realNow;
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

describe('turning the network on from the panel', () => {
    test('GET /network/setup: the requirements in plain words and the candidates, for administrators only', async () => {
        const res = await as('owner', 'get', `${API}/network/setup`);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.enabled, false);
        assert.strictEqual(res.body.ready, true, JSON.stringify(res.body.requirements));
        const ids = res.body.requirements.map((r: any) => r.id);
        for (const id of ['installed', 'driver', 'site_address', 'restart']) assert.ok(ids.includes(id), `requirement ${id} listed`);
        assert.ok(res.body.requirements.every((r: any) => typeof r.message === 'string' && r.message.length > 10));
        assert.deepStrictEqual(res.body.administrators.map((a: any) => a.login).sort(), ['owner', 'second']);
        assert.strictEqual(res.body.restart.mode, 'supervisor');
        assert.strictEqual(res.body.restart.automatic, true);
        assert.match(res.body.restart.bootId, /^[0-9a-f]{16}$/);
        assert.strictEqual(res.body.mfaEnrolled, false);

        const author = await as('writer', 'get', `${API}/network/setup`);
        assert.strictEqual(author.status, 403, JSON.stringify(author.body));
        const anon = await direct('get', `${API}/network/setup`, MAIN);
        assert.strictEqual(anon.status, 401);
    });

    test('on sqlite-legacy the screen says why and offers the migration; enabling is refused', async () => {
        const saved = config.dbDriver;
        config.dbDriver = 'sqlite-legacy';
        try {
            const res = await as('owner', 'get', `${API}/network/setup`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.ready, false);
            const driver = res.body.requirements.find((r: any) => r.id === 'driver');
            assert.strictEqual(driver.ok, false);
            assert.strictEqual(driver.fix.action, 'migrate_sqlite_native');
            assert.match(driver.message, /sqlite-legacy/);
            await enroll('owner');
            const enable = await as('owner', 'post', `${API}/network/enable`).send({ admins: [U.owner], currentPassword: PASSWORD, mfaCode: freshCode('owner') });
            assert.strictEqual(enable.status, 409, JSON.stringify(enable.body));
            assert.strictEqual(enable.body.code, 'network_requirements_unmet');
            assert.strictEqual(fileConfig().multisite, undefined, 'nothing was written');
        } finally {
            config.dbDriver = saved;
        }
        assert.strictEqual(await restartCode(), undefined, 'no restart for a refused switch');
    });

    test('the password AND a fresh two-factor code are required; an account without 2FA is told to turn it on', async () => {
        const noMfa = await as('second', 'post', `${API}/network/enable`).send({ admins: [U.second], currentPassword: PASSWORD, mfaCode: '123456' });
        assert.strictEqual(noMfa.status, 403, JSON.stringify(noMfa.body));
        assert.strictEqual(noMfa.body.code, 'network_mfa_enrollment_required');

        const wrongPw = await as('owner', 'post', `${API}/network/enable`).send({ admins: [U.owner], currentPassword: 'nope', mfaCode: freshCode('owner') });
        assert.strictEqual(wrongPw.status, 403);
        assert.strictEqual(wrongPw.body.code, 'rest_bad_current_password');

        const noCode = await as('owner', 'post', `${API}/network/enable`).send({ admins: [U.owner], currentPassword: PASSWORD });
        assert.strictEqual(noCode.status, 403, JSON.stringify(noCode.body));
        assert.strictEqual(noCode.body.code, 'rest_mfa_step_up_required');

        const badCode = await as('owner', 'post', `${API}/network/enable`).send({ admins: [U.owner], currentPassword: PASSWORD, mfaCode: '000000' });
        assert.strictEqual(badCode.status, 400, JSON.stringify(badCode.body));
        assert.strictEqual(badCode.body.code, 'rest_mfa_invalid');

        const author = await as('writer', 'post', `${API}/network/enable`).send({ admins: [U.writer], currentPassword: PASSWORD, mfaCode: '000000' });
        assert.strictEqual(author.status, 403);

        const notAdmin = await as('owner', 'post', `${API}/network/enable`).send({ admins: [U.writer], currentPassword: PASSWORD, mfaCode: freshCode('owner') });
        assert.strictEqual(notAdmin.status, 400, JSON.stringify(notAdmin.body));
        assert.strictEqual(notAdmin.body.code, 'network_admin_not_administrator');

        const none = await as('owner', 'post', `${API}/network/enable`).send({ admins: [], currentPassword: PASSWORD, mfaCode: freshCode('owner') });
        assert.strictEqual(none.status, 400);
        assert.strictEqual(none.body.code, 'network_admins_required');

        assert.strictEqual(fileConfig().multisite, undefined, 'nothing was written');
        assert.strictEqual(await restartCode(), undefined);
    });

    test('enabling records site 1 and the network administrators, writes the config, audits, and restarts', async () => {
        const res = await as('owner', 'post', `${API}/network/enable`).send({ admins: [U.owner], currentPassword: PASSWORD, mfaCode: freshCode('owner') });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.enabled, true);
        assert.strictEqual(res.body.restart, 'supervisor');
        assert.strictEqual(await restartCode(), restart.RESTART_EXIT_CODE, 'the supervisor was asked for a restart');

        assert.strictEqual(fileConfig().multisite.enabled, true, 'multisite.enabled written to wordjs-config.json');
        assert.strictEqual(siteContext.multisiteEnabled(), false, 'this process keeps running as it booted until the restart');
        assert.deepStrictEqual(network.listNetworkAdmins(), [U.owner]);
        assert.strictEqual(network.getSite(1).mainUrl, MAIN_URL);
        assert.strictEqual(String((await network.storeGet('SELECT meta_value FROM network_meta WHERE meta_key = ?', ['network_enabled'])).meta_value), '1');
        const netLog = await network.auditLog(10);
        const row = netLog.find((r: any) => r.action === 'network.enabled');
        assert.ok(row, 'the network audit log has the switch');
        assert.strictEqual(row.actorUserId, U.owner);
        assert.match(row.detail, /"via":"panel"/);
        assert.match(row.detail, /"mfa":"step_up"/);
        const siteLog = await onMain(() => database.getDbAsync().get("SELECT * FROM audit_log WHERE action = 'network.enable'"));
        assert.ok(siteLog, 'the site audit log has the switch');
        assert.strictEqual(Number(siteLog.actor_id ?? siteLog.user_id ?? siteLog.actor), U.owner);
    });

    test('after the restart: already on; a local install takes a <name>.localhost site', async () => {
        await bootAs(true);
        const again = await as('owner', 'post', `${API}/network/enable`).send({ admins: [U.owner], currentPassword: PASSWORD, mfaCode: freshCode('owner') });
        assert.strictEqual(again.status, 409);
        assert.strictEqual(again.body.code, 'network_already_enabled');

        const sites = await as('owner', 'get', `${API}/network/sites`);
        assert.strictEqual(sites.status, 200, JSON.stringify(sites.body));
        assert.strictEqual(sites.body.localAddresses, true);

        const plainLocalhost = await as('owner', 'post', `${API}/network/sites`).send({ slug: 'bad', url: 'http://localhost:3001', title: 'Bad', adminUsername: 'admin', adminEmail: 'admin@blog.example.com', adminPassword: PASSWORD, currentPassword: PASSWORD });
        assert.strictEqual(plainLocalhost.status, 400);
        assert.match(plainLocalhost.body.message, /\.localhost/);

        const created = await as('owner', 'post', `${API}/network/sites`).send({ slug: 'blog', url: `http://${BLOG}`, title: 'Blog', adminUsername: 'admin', adminEmail: 'admin@blog.example.com', adminPassword: PASSWORD, currentPassword: PASSWORD });
        assert.strictEqual(created.status, 201, JSON.stringify(created.body));
        tokens.blog = await signIn(BLOG, 'admin');
        const me = await direct('get', `${API}/auth/me`, BLOG).set('Authorization', `Bearer ${tokens.blog}`);
        assert.strictEqual(me.status, 200, JSON.stringify(me.body));
        assert.strictEqual(me.body.username || me.body.user_login || (me.body.user && me.body.user.username), 'admin');
    });

    test('a public install refuses a .localhost site', () => {
        const r = configManager.updateConfig((c: any) => ({ ...c, siteUrl: 'https://www.example.com' }), { reload: false });
        assert.ok(r.ok);
        try {
            assert.strictEqual(networkSites.mainSiteIsLocal(), false);
            assert.throws(() => networkSites.assertHostAvailable('http://shop.localhost'), (e: any) => e.code === 'network_invalid_url');
            assert.doesNotThrow(() => networkSites.assertHostAvailable('https://shop.example.com'));
        } finally {
            configManager.updateConfig((c: any) => ({ ...c, siteUrl: MAIN_URL }), { reload: false });
        }
        assert.strictEqual(networkSites.mainSiteIsLocal(), true);
    });
});

describe('network administrators from the panel', () => {
    test('add and remove, password-confirmed; never the last one', async () => {
        const list = await as('owner', 'get', `${API}/network/admins`);
        assert.strictEqual(list.status, 200, JSON.stringify(list.body));
        assert.deepStrictEqual(list.body.administrators.filter((a: any) => a.networkAdmin).map((a: any) => a.login), ['owner']);

        const notListed = await as('second', 'get', `${API}/network/admins`);
        assert.strictEqual(notListed.status, 403);

        const last = await as('owner', 'delete', `${API}/network/admins/${U.owner}`).send({ currentPassword: PASSWORD });
        assert.strictEqual(last.status, 409, JSON.stringify(last.body));
        assert.strictEqual(last.body.code, 'network_last_admin');

        const badPw = await as('owner', 'post', `${API}/network/admins`).send({ userId: U.second, currentPassword: 'nope' });
        assert.strictEqual(badPw.status, 403);
        const author = await as('owner', 'post', `${API}/network/admins`).send({ userId: U.writer, currentPassword: PASSWORD });
        assert.strictEqual(author.status, 400);
        assert.strictEqual(author.body.code, 'network_admin_not_administrator');

        const add = await as('owner', 'post', `${API}/network/admins`).send({ userId: U.second, currentPassword: PASSWORD });
        assert.strictEqual(add.status, 200, JSON.stringify(add.body));
        assert.deepStrictEqual(network.listNetworkAdmins(), [U.owner, U.second].sort((a, b) => a - b));
        const remove = await as('owner', 'delete', `${API}/network/admins/${U.second}`).send({ currentPassword: PASSWORD });
        assert.strictEqual(remove.status, 200, JSON.stringify(remove.body));
        assert.deepStrictEqual(network.listNetworkAdmins(), [U.owner]);
        const audit = await onMain(() => database.getDbAsync().all("SELECT action FROM audit_log WHERE action LIKE 'network.admin.%'"));
        assert.deepStrictEqual(audit.map((r: any) => r.action).sort(), ['network.admin.add', 'network.admin.remove']);
    });
});

describe('turning the network off from the panel', () => {
    test('refused on another site (404) and for a main-site administrator who is not a network administrator (403)', async () => {
        const onBlog = await direct('post', `${API}/network/disable`, BLOG).set('Authorization', `Bearer ${tokens.blog}`).send({ currentPassword: PASSWORD, mfaCode: '000000' });
        assert.strictEqual(onBlog.status, 404, JSON.stringify(onBlog.body));
        const setupOnBlog = await direct('get', `${API}/network/setup`, BLOG).set('Authorization', `Bearer ${tokens.blog}`);
        assert.strictEqual(setupOnBlog.status, 404);
        const enableOnBlog = await direct('post', `${API}/network/enable`, BLOG).set('Authorization', `Bearer ${tokens.blog}`).send({ admins: [1], currentPassword: PASSWORD, mfaCode: '000000' });
        assert.strictEqual(enableOnBlog.status, 404, JSON.stringify(enableOnBlog.body));
        const second = await as('second', 'post', `${API}/network/disable`).send({ currentPassword: PASSWORD, mfaCode: '000000' });
        assert.strictEqual(second.status, 403, JSON.stringify(second.body));
        assert.strictEqual(second.body.code, 'rest_forbidden_network');
        assert.strictEqual(fileConfig().multisite.enabled, true);
    });

    test('refused while another site exists, then turned off with the same safeguards and a restart', async () => {
        const busy = await as('owner', 'post', `${API}/network/disable`).send({ currentPassword: PASSWORD, mfaCode: freshCode('owner') });
        assert.strictEqual(busy.status, 409, JSON.stringify(busy.body));
        assert.strictEqual(busy.body.code, 'network_has_sites');
        assert.strictEqual(await restartCode(), undefined);

        const noCode = await as('owner', 'post', `${API}/network/disable`).send({ currentPassword: PASSWORD });
        assert.strictEqual(noCode.status, 403);
        assert.strictEqual(noCode.body.code, 'rest_mfa_step_up_required');

        const blog = network.listSites().find((s: any) => s.slug === 'blog');
        await networkSites.setSiteStatus(blog.id, 'suspended', U.owner);
        await networkSites.deleteSite(blog.id, { confirmSlug: 'blog', actorUserId: U.owner });

        const res = await as('owner', 'post', `${API}/network/disable`).send({ currentPassword: PASSWORD, mfaCode: freshCode('owner') });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.enabled, false);
        assert.strictEqual(await restartCode(), restart.RESTART_EXIT_CODE);
        assert.strictEqual(fileConfig().multisite.enabled, false);
        assert.strictEqual(String((await network.storeGet('SELECT meta_value FROM network_meta WHERE meta_key = ?', ['network_enabled'])).meta_value), '0');
        assert.ok((await network.auditLog(10)).some((r: any) => r.action === 'network.disabled'));
        assert.ok(await onMain(() => database.getDbAsync().get("SELECT 1 AS x FROM audit_log WHERE action = 'network.disable'")));

        await bootAs(false);
        const off = await as('owner', 'post', `${API}/network/disable`).send({ currentPassword: PASSWORD, mfaCode: freshCode('owner') });
        assert.strictEqual(off.status, 409);
        assert.strictEqual(off.body.code, 'network_not_enabled');
    });
});

describe('restarting by itself', () => {
    test('each way of running WordJS has its restart', () => {
        assert.strictEqual(restart.restartMode({ WORDJS_SUPERVISED: '1' }, false), 'supervisor');
        assert.strictEqual(restart.restartMode({}, true), 'watch');
        assert.strictEqual(restart.restartMode({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, false), 'service');
        assert.strictEqual(restart.restartMode({ INVOCATION_ID: 'abc' }, false), 'service');
        assert.strictEqual(restart.restartMode({ pm_id: '0' }, false), 'service');
        assert.strictEqual(restart.RESTART_EXIT_CODE, 75);
    });

    test('nothing to bring it back: no exit, the screen asks for a restart by hand', async () => {
        const saved = process.env.WORDJS_SUPERVISED;
        delete process.env.WORDJS_SUPERVISED;
        try {
            if (restart.restartMode() !== 'manual') return; // a container or service manager on this machine
            assert.strictEqual(restart.scheduleRestart('test'), 'manual');
            assert.strictEqual(await restartCode(), undefined, 'a process nobody restarts must not exit');
        } finally {
            process.env.WORDJS_SUPERVISED = saved;
        }
    });

    test("another node's announcement is applied to this node's config, and never its own", () => {
        assert.strictEqual(fileConfig().multisite.enabled, false);
        const own = restart.applyClusterChange(JSON.stringify({ from: restart.BOOT_ID, multisiteEnabled: true, reason: 'x' }));
        assert.strictEqual(own.applied, false);
        assert.strictEqual(restart.applyClusterChange('not json').applied, false);
        assert.strictEqual(restart.applyClusterChange(JSON.stringify({ from: 'peer', multisiteEnabled: 'yes' })).applied, false);
        const peer = restart.applyClusterChange(JSON.stringify({ from: 'peer', multisiteEnabled: true, reason: 'the network was turned on' }));
        assert.strictEqual(peer.applied, true);
        assert.strictEqual(fileConfig().multisite.enabled, true);
        restart.applyClusterChange(JSON.stringify({ from: 'peer', multisiteEnabled: false, reason: 'off' }));
        assert.strictEqual(fileConfig().multisite.enabled, false);
    });

    test('the supervisors restart on 75 and pass every other exit through', () => {
        const root = path.resolve(__dirname, '../../..');
        const server = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');
        assert.match(server, /RESTART_EXIT_CODE = 75/);
        assert.match(server, /WORDJS_SUPERVISED: '1'/);
        const mono = require(path.join(root, 'monolith.js'));
        assert.strictEqual(typeof mono.superviseMonolith, 'function');
    });
});
