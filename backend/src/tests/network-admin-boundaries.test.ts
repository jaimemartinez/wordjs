/**
 * WordJS — NETWORK ADMINISTRATORS ABOVE THE MAIN SITE'S ADMINISTRATORS (multisite), on the REAL app.
 *
 * A network administrator is an administrator of the main site whose id is listed in the network store
 * (core/network-auth). This suite holds the two halves of what that means:
 *
 *   1. ACCOUNTS. An administrator of the main site who is NOT a network administrator cannot change a
 *      network administrator's email, password or role, reset their second factor, bind or manage an AI
 *      agent connection as them, rewrite them through a site import, or delete them. A network
 *      administrator can; everyone keeps managing ordinary accounts exactly as before.
 *   2. NETWORK-WIDE ACTIONS on the main site take a network administrator: plugin and theme code,
 *      marketplace, backups, the database migration tool, the site's addresses, certificates, the hooks
 *      registry and the object-cache switch. Activation, grants and the other site-level actions stay
 *      with the main site's administrators.
 *
 * Plus the bookkeeping: deleting an account removes it from the network administrators, and every row
 * follows its own account (by login) when the main database is replaced. And with multisite OFF every
 * one of these requests behaves exactly as on any single site.
 *
 * MUTATION PROOF (verified once each): drop the protectsNetworkAdmin calls from routes/users.ts → the
 * account tests fail; replace networkAdminOnMainSite with a pass-through → the network-wide matrix fails;
 * make networkSettingsReadOnly ignore the main site → the settings test fails; remove forgetNetworkAdmin
 * from User.delete → the delete test fails; drop the login comparison in core/network isNetworkAdmin →
 * the restore test fails.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-netadmin-${process.pid}-`));
const DATA_DIR = path.join(TMP_INSTALL, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const MAIN_URL = 'http://main.example.com';
const MAIN = 'main.example.com';
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
const networkAuth = require('../core/network-auth');
const app = require('../index');

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
const TWO = 'two.example.com';
let server: any;
const U: Record<string, number> = {};
const tokens: Record<string, string> = {};

const direct = (method: string, url: string, host: string) =>
    (request(server) as any)[method](url).set('Host', host).set('Origin', `http://${host}`);
const as = (who: string, method: string, url: string, host = MAIN) =>
    direct(method, url, host).set('Authorization', `Bearer ${tokens[who]}`);

async function signIn(host: string, username: string): Promise<string> {
    const res = await direct('post', `${API}/auth/login`, host).send({ username, password: PASSWORD });
    assert.strictEqual(res.status, 200, `sign-in ${username}@${host}: ${res.status} ${JSON.stringify(res.body)}`);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('wordjs_token='));
    return decodeURIComponent(String(cookie).split(';')[0].slice('wordjs_token='.length));
}

const onMain = <T>(fn: () => T): T => siteContext.runWithSite(1, fn);
const userRow = (id: number) => onMain(() => database.getDbAsync().get('SELECT * FROM users WHERE id = ?', [id]));
const option = (name: string) => onMain(() => require('../core/options').getOption(name));

async function seed(login: string, role: string, listed = false) {
    const db = database.getDbAsync();
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        [login, bcrypt.hashSync(PASSWORD, 10), `${login}@main.example.com`, login]);
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
    if (listed) network.addNetworkAdmin(r.lastID, login);
}

before(async () => {
    await onMain(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        await require('../core/options').initDefaultOptions(config);
        await require('../core/roles').loadRoles();
        await require('../core/post-types').initPostTypes();
        await require('../core/post-types').initTaxonomies();
        require('../core/adminMenu').initCoreMenus();
        network.registerPrimarySite(MAIN_URL);
        await seed('netadmin', 'administrator', true);
        await seed('netadmin2', 'administrator', true);
        await seed('mainadmin', 'administrator');
        await seed('plain', 'author');
        await networkSites.createSite({ slug: 'two', url: `http://${TWO}`, title: 'Site Two', adminUsername: 'admin', adminEmail: 'admin@two.example.com', adminPassword: PASSWORD });
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

const refusedAsNetwork = (res: any, label: string) => {
    assert.strictEqual(res.status, 403, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'rest_forbidden_network', `${label}: ${JSON.stringify(res.body)}`);
};

describe('a network administrator account is out of reach of a main-site-only administrator', () => {
    test('email, password and role changes, the two-factor reset and deletion are refused', async () => {
        const before = await userRow(U.netadmin);
        refusedAsNetwork(await as('main', 'put', `${API}/users/${U.netadmin}`).send({ email: 'taken@evil.example' }), 'email');
        refusedAsNetwork(await as('main', 'put', `${API}/users/${U.netadmin}`).send({ password: 'Another-Horse-9!x' }), 'password');
        refusedAsNetwork(await as('main', 'put', `${API}/users/${U.netadmin}`).send({ role: 'subscriber' }), 'role');
        refusedAsNetwork(await as('main', 'post', `${API}/users/${U.netadmin}/mfa/reset`).send({}), 'mfa reset');
        refusedAsNetwork(await as('main', 'delete', `${API}/users/${U.netadmin}`), 'delete');
        const after = await userRow(U.netadmin);
        assert.ok(after, 'the account still exists');
        assert.strictEqual(after.user_email, before.user_email);
        assert.strictEqual(after.user_pass, before.user_pass);
        assert.strictEqual(network.isNetworkAdmin(U.netadmin), true);
        // The network administrator can still sign in with the original password.
        assert.ok(await signIn(MAIN, 'netadmin'));
    });

    test('ordinary accounts are managed exactly as before, and a network administrator manages everyone (controls)', async () => {
        const plain = await as('main', 'put', `${API}/users/${U.plain}`).send({ displayName: 'Plain Author' });
        assert.strictEqual(plain.status, 200, JSON.stringify(plain.body));
        const peer = await as('net', 'put', `${API}/users/${U.netadmin2}`).send({ displayName: 'Second Net Admin' });
        assert.strictEqual(peer.status, 200, JSON.stringify(peer.body));
        const down = await as('net', 'put', `${API}/users/${U.mainadmin}`).send({ displayName: 'Main Admin' });
        assert.strictEqual(down.status, 200, JSON.stringify(down.body));
        const reset = await as('net', 'post', `${API}/users/${U.netadmin2}/mfa/reset`).send({});
        assert.strictEqual(reset.status, 200, JSON.stringify(reset.body));
    });

    test('an AI agent connection cannot be bound to, granted for or revoked from a network administrator', async () => {
        refusedAsNetwork(await as('main', 'post', `${API}/agents`).send({ name: 'as-net', requested: ['content:read'], userId: U.netadmin }), 'create');
        const own = await as('net', 'post', `${API}/agents`).send({ name: 'net-own', requested: ['content:read'] });
        assert.strictEqual(own.status, 201, JSON.stringify(own.body));
        const id = own.body.connection.id;
        refusedAsNetwork(await as('main', 'put', `${API}/agents/${id}/grant`).send({ granted: ['content:read'] }), 'grant');
        refusedAsNetwork(await as('main', 'delete', `${API}/agents/${id}`), 'revoke');
        // Control: for an ordinary account it works as before.
        const forPlain = await as('main', 'post', `${API}/agents`).send({ name: 'as-plain', requested: ['content:read'], userId: U.plain });
        assert.strictEqual(forPlain.status, 201, JSON.stringify(forPlain.body));
    });

    test('a site import leaves the network administrator and the network-wide settings alone', async () => {
        const data = {
            version: '1.0',
            content: { users: [
                { id: 900, username: 'netadmin', email: 'netadmin@evil.example', displayName: 'Hijacked', role: 'subscriber' },
                { id: 901, username: 'plain', email: 'plain-new@main.example.com', displayName: 'Plain Imported' },
            ] },
            settings: { redis_cache_enabled: '1', blogdescription: 'imported' },
        };
        const res = await as('main', 'post', `${API}/import`).send({ data, updateExisting: true, importUsers: true });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const net = await userRow(U.netadmin);
        assert.strictEqual(net.user_email, 'netadmin@main.example.com', 'the network administrator was rewritten by the import');
        assert.strictEqual(String(await option('redis_cache_enabled')), '0', 'the import flipped the network-wide cache switch');
        // Controls: the ordinary account and the ordinary setting were imported.
        assert.strictEqual((await userRow(U.plain)).user_email, 'plain-new@main.example.com');
        assert.strictEqual(await option('blogdescription'), 'imported');
    });
});

describe('network-wide actions on the main site take a network administrator', () => {
    const NETWORK_WIDE: Array<[string, string]> = [
        ['get', '/backups'],
        ['get', '/db-migration/status'],
        ['get', '/site-address'],
        ['get', '/system/certs/config'],
        ['get', '/hooks'],
        ['get', '/marketplace/sources'],
        ['post', '/plugins/upload'],
        ['delete', '/plugins/no-such-plugin'],
        ['post', '/plugins/no-such-plugin/pack'],
        ['get', '/plugins/no-such-plugin/download'],
        ['post', '/themes/upload'],
        ['delete', '/themes/no-such-theme'],
        ['put', '/themes/no-such-theme'],
    ];

    test('a main-site-only administrator is refused every one of them', async () => {
        for (const [method, url] of NETWORK_WIDE) {
            refusedAsNetwork(await as('main', method, `${API}${url}`).send({}), `${method.toUpperCase()} ${url}`);
        }
    });

    test('a network administrator reaches each of them (control)', async () => {
        for (const [method, url] of NETWORK_WIDE) {
            const res = await as('net', method, `${API}${url}`).send({});
            assert.ok(res.status !== 401 && res.body?.code !== 'rest_forbidden_network',
                `${method.toUpperCase()} ${url}: ${res.status} ${JSON.stringify(res.body)}`);
        }
    });

    test('what is the main site\'s own stays with its administrators', async () => {
        assert.strictEqual((await as('main', 'get', `${API}/plugins`)).status, 200);
        assert.strictEqual((await as('main', 'get', `${API}/themes`)).status, 200);
        const activate = await as('main', 'post', `${API}/plugins/no-such-plugin/activate`).send({});
        assert.notStrictEqual(activate.body?.code, 'rest_forbidden_network', JSON.stringify(activate.body));
        const mods = await as('main', 'get', `${API}/themes/mods/export`);
        assert.notStrictEqual(mods.status, 403, JSON.stringify(mods.body));
    });

    test('another site\'s administrator is answered as before (404 for the main site\'s subtrees)', async () => {
        // Except its own backups: every site of a network has them (core/backup).
        assert.strictEqual((await as('two', 'get', `${API}/backups`, TWO)).status, 200);
        assert.strictEqual((await as('two', 'get', `${API}/site-address`, TWO)).status, 404);
        assert.strictEqual((await as('two', 'post', `${API}/plugins/upload`, TWO).send({})).status, 403);
    });

    test('the object-cache switch: refused to a main-site-only administrator, changed by a network administrator', async () => {
        const single = await as('main', 'put', `${API}/settings/redis_cache_enabled`).send({ value: '1' });
        assert.strictEqual(single.status, 403, JSON.stringify(single.body));
        assert.strictEqual(single.body.code, 'rest_network_only');
        const bulk = await as('main', 'put', `${API}/settings`).send({ redis_cache_enabled: '1' });
        assert.strictEqual(bulk.status, 403, JSON.stringify(bulk.body));
        // The screen sends every field back: an unchanged value does not block the rest of the save.
        const screen = await as('main', 'put', `${API}/settings`).send({ redis_cache_enabled: '0', blogname: 'Main Site' });
        assert.strictEqual(screen.status, 200, JSON.stringify(screen.body));
        assert.strictEqual(String(await option('redis_cache_enabled')), '0');
        for (const value of ['1', '0']) {
            const net = await as('net', 'put', `${API}/settings/redis_cache_enabled`).send({ value });
            assert.strictEqual(net.status, 200, JSON.stringify(net.body));
            assert.strictEqual(String(await option('redis_cache_enabled')), value);
        }
    });
});

describe('the network administrator list follows the accounts', () => {
    test('deleting a network administrator removes it from the list', async () => {
        await onMain(() => seed('netadmin3', 'administrator', true));
        const res = await as('net', 'delete', `${API}/users/${U.netadmin3}`);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(network.isNetworkAdmin(U.netadmin3), false, 'the deleted account is still listed');
        assert.ok(!network.listNetworkAdmins().includes(U.netadmin3));
    });

    test('a replaced main database: an id given to another account is no network administrator, and each row follows its login', async () => {
        await onMain(() => seed('restored', 'administrator', true));
        const oldId = U.restored;
        // The restored database gives that id to a different account…
        await onMain(() => database.getDbAsync().run('UPDATE users SET user_login = ?, user_email = ? WHERE id = ?', ['someone-else', 'someone-else@main.example.com', oldId]));
        await onMain(() => require('../core/cache').del(`user:${oldId}`));
        const imposter = await signIn(MAIN, 'someone-else');
        const status = await direct('get', `${API}/network/status`, MAIN).set('Authorization', `Bearer ${imposter}`);
        assert.strictEqual(status.status, 200, JSON.stringify(status.body));
        assert.strictEqual(status.body.networkAdmin, false, 'another account inherited the network administrator row by id');
        // …and the account the row names now has another id.
        await onMain(() => seed('restored', 'administrator'));
        assert.notStrictEqual(U.restored, oldId);
        const outcome = await networkAuth.recheckNetworkAdmins();
        assert.ok(outcome.rebound >= 1, JSON.stringify(outcome));
        assert.ok(!network.listNetworkAdmins().includes(oldId));
        assert.ok(network.listNetworkAdmins().includes(U.restored));
        const back = await signIn(MAIN, 'restored');
        const st = await direct('get', `${API}/network/status`, MAIN).set('Authorization', `Bearer ${back}`);
        assert.strictEqual(st.body.networkAdmin, true, JSON.stringify(st.body));
    });

    test('a row whose account is gone is dropped; an older row with no login is bound to its account', async () => {
        network.addNetworkAdmin(987654);
        network.removeNetworkAdmin(U.netadmin2);
        network.addNetworkAdmin(U.netadmin2); // no login: a row written before the login was recorded
        await networkAuth.recheckNetworkAdmins();
        assert.ok(!network.listNetworkAdmins().includes(987654));
        assert.strictEqual(network.isNetworkAdmin(U.netadmin2, 'netadmin2'), true);
        assert.strictEqual(network.isNetworkAdmin(U.netadmin2, 'not-netadmin2'), false, 'the row was not bound to its login');
    });
});

describe('a single site is unchanged', () => {
    test('with multisite off, the main site\'s administrators do all of it as before', async () => {
        config.multisite = { enabled: false };
        try {
            for (const url of ['/backups', '/db-migration/status', '/site-address', '/hooks', '/marketplace/sources']) {
                const res = await as('main', 'get', `${API}${url}`);
                assert.strictEqual(res.status, 200, `${url}: ${res.status} ${JSON.stringify(res.body)}`);
            }
            const edit = await as('main', 'put', `${API}/users/${U.netadmin}`).send({ displayName: 'Edited on a single site' });
            assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));
            const cache = await as('main', 'put', `${API}/settings/redis_cache_enabled`).send({ value: '0' });
            assert.strictEqual(cache.status, 200, JSON.stringify(cache.body));
        } finally {
            config.multisite = { enabled: true };
        }
    });
});
