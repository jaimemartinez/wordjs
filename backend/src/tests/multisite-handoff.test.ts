/**
 * WordJS — THE NETWORK ADMINISTRATOR'S HANDOFF INTO A SITE, ON THE REAL APP (core/network-handoff,
 * documentation/multisite-design.md "Roles: network admin and site admin").
 *
 * Boots the real Express app from ../index with multisite ON: a main site with a network administrator
 * (`netadmin`) and a plain administrator of the main site (`mainadmin`), and two more sites created the
 * way the network screen creates them. Every refusal is paired with the positive path on the same world,
 * so a 4xx never passes for the wrong reason (a broken route, a missing site):
 *
 *   · issue: only a network administrator, re-authenticated, with a session — never an API token, never
 *     for the main site or a suspended one;
 *   · redeem: once (a replay is refused), only on the address it was minted for (another site, another
 *     address of the site, the main site), never after it expired, never on a suspended site, never once
 *     the network administrator is no longer one;
 *   · the session: marked as a handoff in /auth/me, ends after 30 minutes (a refresh keeps the end), and
 *     ends when the network administrator is removed; the account it uses cannot sign in by password,
 *     cannot be edited by the site's administrators and cannot mint an API token;
 *   · both audit logs: the site's own (auth.network_handoff) and the network's (issued, redeemed, refused).
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
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-handoff-${process.pid}-`));
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
const { siteSigningKey } = require('../core/site-keys');
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

/** Ask the main site for a handoff into `siteId` as the network administrator; the token from its URL. */
async function issue(siteId: number, as = tokens.net, currentPassword = PASSWORD): Promise<{ res: any; token: string | null; url: string | null }> {
    const res = await bearer('post', `${API}/network/sites/${siteId}/handoff`, MAIN, as).send({ currentPassword });
    if (res.status !== 200) return { res, token: null, url: null };
    const url = new URL(res.body.url);
    return { res, url: res.body.url, token: new URLSearchParams(url.hash.slice(1)).get('token') };
}

const redeem = (host: string, token: unknown) => direct('post', `${API}/auth/handoff`, host).send({ token });

/** Run `fn` with the clock moved `ms` ahead (jsonwebtoken and the handoff read Date.now). */
async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    const realNow = Date.now;
    Date.now = () => realNow() + ms;
    try { return await fn(); } finally { Date.now = realNow; }
}

const networkAudit = async (action: string) => (await network.auditLog(500)).filter((r: any) => r.action === action);
const siteAudit = async (siteId: number) => siteContext.runWithSite(siteId, async () =>
    (await require('../core/audit').listAudit({ limit: 200 })).rows.filter((r: any) => r.action === 'auth.network_handoff'));

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

describe('issuing a handoff (main site)', () => {
    test('a network administrator gets a one-time URL on the site\'s own address, recorded in the network log', async () => {
        const { res, token, url } = await issue(siteTwo);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.ok(String(url).startsWith(`http://${TWO}/login/handoff#token=`), String(url));
        assert.ok(token);
        assert.strictEqual(res.headers['cache-control'], 'no-store');
        const claims = jwt.decode(token);
        assert.strictEqual(claims.sid, siteTwo);
        assert.strictEqual(claims.aud, TWO);
        assert.strictEqual(claims.uid, netAdminId);
        assert.ok(claims.exp - claims.iat <= 60, 'the token lives a minute at most');
        // Signed with the TARGET's key: the main site's own secret does not verify it.
        assert.throws(() => jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }));
        jwt.verify(token, siteSigningKey(siteTwo), { algorithms: ['HS256'] });
        const issued = await networkAudit('site.handoff.issued');
        assert.ok(issued.some((r: any) => r.siteId === siteTwo && r.actorUserId === netAdminId), JSON.stringify(issued));
    });

    test('an administrator of the main site who is not a network administrator is refused', async () => {
        const { res } = await issue(siteTwo, tokens.main);
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.code, 'rest_forbidden_network');
    });

    test('a wrong current password is refused', async () => {
        const { res } = await issue(siteTwo, tokens.net, 'not-the-password');
        assert.strictEqual(res.status, 403, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'rest_bad_current_password');
    });

    test('the main site cannot be opened through a handoff', async () => {
        const { res } = await issue(1);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'network_primary_site');
    });

    test('an unknown site is 404', async () => {
        const { res } = await issue(999);
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.code, 'network_site_not_found');
    });

    test('an API token of the network administrator cannot ask for one (session only)', async () => {
        const created = await bearer('post', `${API}/auth/tokens`, MAIN, tokens.net).send({ name: 'automation', scopes: ['read', 'write'] });
        assert.strictEqual(created.status, 201, JSON.stringify(created.body));
        const raw = created.body.token;
        assert.ok(String(raw).startsWith('wjt_'), JSON.stringify(created.body));
        const { res } = await issue(siteTwo, raw);
        assert.strictEqual(res.status, 403, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'rest_token_management_forbidden');
    });

    test('a suspended site cannot be opened', async () => {
        assert.strictEqual((await bearer('post', `${API}/network/sites/${siteThree}/suspend`, MAIN, tokens.net).send({ currentPassword: PASSWORD })).status, 200);
        try {
            const { res } = await issue(siteThree);
            assert.strictEqual(res.status, 409);
            assert.strictEqual(res.body.code, 'network_site_suspended');
        } finally {
            assert.strictEqual((await bearer('post', `${API}/network/sites/${siteThree}/resume`, MAIN, tokens.net).send({ currentPassword: PASSWORD })).status, 200);
        }
    });
});

describe('redeeming a handoff (the target site)', () => {
    let session = '';

    test('the token starts a session on the site, marked as a handoff, recorded in BOTH audit logs', async () => {
        const { token } = await issue(siteTwo);
        const before = (await siteAudit(siteTwo)).length;
        const res = await redeem(TWO, token);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.handoff.networkAdmin, 'netadmin');
        assert.strictEqual(res.body.handoff.from, MAIN);
        session = sessionFrom(res);

        const me = await bearer('get', `${API}/auth/me`, TWO, session);
        assert.strictEqual(me.status, 200, JSON.stringify(me.body));
        assert.strictEqual(me.body.role, 'administrator');
        assert.strictEqual(me.body.handoff.networkAdmin, 'netadmin');
        assert.strictEqual(me.body.handoff.from, MAIN);
        const ends = Date.parse(me.body.handoff.expiresAt) - Date.now();
        assert.ok(ends > 25 * 60_000 && ends <= 30 * 60_000, `the session ends in 30 minutes (${ends} ms)`);
        // The session works as this site's administrator, on this site's data.
        const settings = await bearer('get', `${API}/settings`, TWO, session);
        assert.strictEqual(settings.status, 200);
        assert.strictEqual(settings.body.blogname, 'Site Two');
        // The JWT itself ends with the handoff, not after the 7-day session lifetime.
        const claims = jwt.decode(session);
        assert.ok(claims.exp <= claims.hof.exp, JSON.stringify(claims));

        const rows = await siteAudit(siteTwo);
        assert.strictEqual(rows.length, before + 1, 'one row in the site\'s own audit log');
        const row = rows[0];
        assert.strictEqual(Number(row.actorId ?? row.actor_id), me.body.id);
        const detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
        assert.strictEqual(detail.networkAdmin, 'netadmin');
        assert.strictEqual(detail.networkAdminId, netAdminId);
        assert.strictEqual(detail.from, MAIN);
        const redeemed = await networkAudit('site.handoff.redeemed');
        assert.ok(redeemed.some((r: any) => r.siteId === siteTwo && r.actorUserId === netAdminId && JSON.parse(r.detail).account === me.body.id), JSON.stringify(redeemed));
    });

    test('a token works once: the replay is refused and recorded', async () => {
        const { token } = await issue(siteTwo);
        assert.strictEqual((await redeem(TWO, token)).status, 200);
        const refusedBefore = (await networkAudit('site.handoff.refused')).length;
        const replay = await redeem(TWO, token);
        assert.strictEqual(replay.status, 401);
        assert.strictEqual(replay.body.code, 'network_handoff_used');
        assert.ok(!([] as string[]).concat(replay.headers['set-cookie'] || []).some((c) => c.startsWith('wordjs_token=')), 'no session for a replay');
        const refused = await networkAudit('site.handoff.refused');
        assert.strictEqual(refused.length, refusedBefore + 1);
        assert.strictEqual(JSON.parse(refused[0].detail).reason, 'network_handoff_used');
    });

    test('a token is worthless on another site and on the main site', async () => {
        const { token } = await issue(siteTwo);
        const other = await redeem(THREE, token);
        assert.strictEqual(other.status, 401);
        assert.strictEqual(other.body.code, 'network_handoff_invalid');
        const main = await redeem(MAIN, token);
        assert.strictEqual(main.status, 404);
        // ...and refusing it there did not spend it: the site it was minted for still takes it.
        assert.strictEqual((await redeem(TWO, token)).status, 200);
    });

    test('a token sent to an address other than the one it names is refused, and spent', async () => {
        // A token of this site naming another of its addresses (as one minted before the site moved would):
        // signed with the site's own key and registered as issued, so only the address check can refuse it.
        const nowSec = Math.floor(Date.now() / 1000);
        const jti = 'wrong-host-test-jti';
        await network.storeRun('INSERT INTO network_handoffs (jti, site_id, admin_user_id, expires_at) VALUES (?, ?, ?, ?)', [jti, siteTwo, netAdminId, nowSec + 60]);
        const token = jwt.sign({ purpose: 'network_handoff', sid: siteTwo, jti, uid: netAdminId, by: 'netadmin', aud: 'old.two.example.com', from: MAIN, iat: nowSec, exp: nowSec + 60 },
            siteSigningKey(siteTwo), { algorithm: 'HS256' });
        const res = await redeem(TWO, token);
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.code, 'network_handoff_wrong_host');
        assert.strictEqual((await redeem(TWO, token)).body.code, 'network_handoff_used', 'one attempt, whatever its outcome');
        const refused = await networkAudit('site.handoff.refused');
        assert.ok(refused.some((r: any) => JSON.parse(r.detail).reason === 'network_handoff_wrong_host'));
    });

    test('an expired token is refused', async () => {
        const { token } = await issue(siteTwo);
        const res = await later(61_000, () => redeem(TWO, token));
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.code, 'network_handoff_expired');
    });

    test('a token is refused once the site is suspended', async () => {
        const { token } = await issue(siteTwo);
        assert.strictEqual((await bearer('post', `${API}/network/sites/${siteTwo}/suspend`, MAIN, tokens.net).send({ currentPassword: PASSWORD })).status, 200);
        try {
            const res = await redeem(TWO, token);
            assert.strictEqual(res.status, 503, JSON.stringify(res.body));
            assert.ok(!([] as string[]).concat(res.headers['set-cookie'] || []).some((c) => c.startsWith('wordjs_token=')));
        } finally {
            assert.strictEqual((await bearer('post', `${API}/network/sites/${siteTwo}/resume`, MAIN, tokens.net).send({ currentPassword: PASSWORD })).status, 200);
        }
    });

    test('a token is refused once its network administrator is no longer one', async () => {
        const { token } = await issue(siteTwo);
        await siteContext.runWithSite(1, () => network.removeNetworkAdmin(netAdminId));
        try {
            const res = await redeem(TWO, token);
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.code, 'network_handoff_not_admin');
        } finally {
            await siteContext.runWithSite(1, () => network.addNetworkAdmin(netAdminId, 'netadmin'));
        }
    });

    test('a token that is not a handoff token (a session of the site) is refused', async () => {
        const res = await redeem(TWO, tokens.two);
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.code, 'network_handoff_invalid');
        assert.strictEqual((await redeem(TWO, '')).status, 401);
        assert.strictEqual((await redeem(TWO, { not: 'a string' })).status, 401);
    });

    test('every handoff of the same network administrator uses the same marked account of the site', async () => {
        const first = await bearer('get', `${API}/auth/me`, TWO, session);
        const { token } = await issue(siteTwo);
        const again = sessionFrom(await redeem(TWO, token));
        const second = await bearer('get', `${API}/auth/me`, TWO, again);
        assert.strictEqual(second.body.id, first.body.id);
        const users = await bearer('get', `${API}/users?per_page=100`, TWO, tokens.two);
        const list = Array.isArray(users.body) ? users.body : (users.body.users || users.body.data || []);
        assert.strictEqual(list.filter((u: any) => String(u.username || u.userLogin || '').startsWith('network.')).length, 1, JSON.stringify(list.map((u: any) => u.username || u.userLogin)));
    });

    describe('the handoff session and its account', () => {
        test('a refresh keeps the handoff and its end', async () => {
            const res = await bearer('post', `${API}/auth/refresh`, TWO, session);
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            const refreshed = jwt.decode(sessionFrom(res));
            const original = jwt.decode(session);
            assert.deepStrictEqual(refreshed.hof, original.hof);
            assert.ok(refreshed.exp <= original.hof.exp, 'a refresh never extends the handoff');
        });

        test('the session ends after 30 minutes', async () => {
            const res = await later(31 * 60_000, () => bearer('get', `${API}/auth/me`, TWO, session));
            assert.strictEqual(res.status, 401);
        });

        test('the session ends when the network administrator is removed from the network', async () => {
            await siteContext.runWithSite(1, () => network.removeNetworkAdmin(netAdminId));
            try {
                const res = await bearer('get', `${API}/auth/me`, TWO, session);
                assert.strictEqual(res.status, 401);
                assert.strictEqual(res.body.code, 'rest_token_revoked');
            } finally {
                await siteContext.runWithSite(1, () => network.addNetworkAdmin(netAdminId, 'netadmin'));
            }
            assert.strictEqual((await bearer('get', `${API}/auth/me`, TWO, session)).status, 200);
        });

        test('a handoff session cannot mint an API token, an agent connection or change its own account', async () => {
            const tokenRes = await bearer('post', `${API}/auth/tokens`, TWO, session).send({ name: 'outlive', scopes: ['read'] });
            assert.strictEqual(tokenRes.status, 403, JSON.stringify(tokenRes.body));
            assert.strictEqual(tokenRes.body.code, 'rest_network_handoff_session');
            const agentRes = await bearer('post', `${API}/agents`, TWO, session).send({ name: 'outlive' });
            assert.strictEqual(agentRes.status, 403, JSON.stringify(agentRes.body));
            assert.strictEqual(agentRes.body.code, 'rest_network_handoff_session');
            const meRes = await bearer('put', `${API}/users/me`, TWO, session).send({ email: 'me@two.example.com' });
            assert.strictEqual(meRes.status, 403);
            assert.strictEqual(meRes.body.code, 'rest_network_handoff_session');
            const mfaRes = await bearer('post', `${API}/auth/mfa/setup`, TWO, session).send({});
            assert.strictEqual(mfaRes.status, 403);
        });

        test('the site\'s administrator sees the account but cannot edit it or reset its second factor', async () => {
            const me = await bearer('get', `${API}/auth/me`, TWO, session);
            const id = me.body.id;
            const edit = await bearer('put', `${API}/users/${id}`, TWO, tokens.two).send({ password: 'Another-Horse-9!x', email: 'mine@two.example.com' });
            assert.strictEqual(edit.status, 403, JSON.stringify(edit.body));
            assert.strictEqual(edit.body.code, 'rest_network_handoff_account');
            const reset = await bearer('post', `${API}/users/${id}/mfa/reset`, TWO, tokens.two).send({});
            assert.strictEqual(reset.status, 403);
            assert.strictEqual(reset.body.code, 'rest_network_handoff_account');
        });

        test('the account cannot sign in by password, even with the right one', async () => {
            const me = await bearer('get', `${API}/auth/me`, TWO, session);
            const id = me.body.id;
            // Give it a known password behind the API's back: the sign-in must still refuse it.
            await siteContext.runWithSite(siteTwo, async () => {
                await database.getDbAsync().run('UPDATE users SET user_pass = ? WHERE id = ?', [bcrypt.hashSync(PASSWORD, 4), id]);
            });
            const res = await direct('post', `${API}/auth/login`, TWO).send({ username: me.body.username, password: PASSWORD });
            assert.strictEqual(res.status, 401, JSON.stringify(res.body));
            assert.ok(!([] as string[]).concat(res.headers['set-cookie'] || []).some((c) => c.startsWith('wordjs_token=')));
        });

        test('a session of the account without the handoff claim is no session', async () => {
            const me = await bearer('get', `${API}/auth/me`, TWO, session);
            const forged = jwt.sign({ userId: me.body.id, username: me.body.username, sid: siteTwo }, siteSigningKey(siteTwo), { expiresIn: '1h' });
            const res = await bearer('get', `${API}/auth/me`, TWO, forged);
            assert.strictEqual(res.status, 401);
        });

        test('an ordinary session of the site carries no handoff', async () => {
            const me = await bearer('get', `${API}/auth/me`, TWO, tokens.two);
            assert.strictEqual(me.status, 200);
            assert.strictEqual(me.body.handoff, undefined);
        });
    });
});
