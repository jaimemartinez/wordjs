/**
 * WordJS — THE SITE-ADDRESS API AND ITS SINGLE WRITER, on the real app.
 *
 * core/site-address.ts is the only writer of "where the site lives" (wordjs-config.json siteUrl /
 * siteAliases / hostPolicy, and the siteurl / home / site_address_rev mirrors). routes/site-address.ts is
 * its door. This file boots the REAL Express app from ../index — the door is a CHAIN (host gate → CSRF →
 * MFA gate → authenticate → isAdmin → sessionOnly → sudo → rev), and a suite that mounted the router alone
 * would prove none of the links in front of it.
 *
 * THE WORLD. An installed site at https://example.com with the alias https://www.example.com, in a
 * throwaway wordjs-config.json the process chdirs into BEFORE any application module loads; two
 * administrators and an editor in a throwaway database. supertest connects from 127.0.0.1, so a request
 * that sets `Host` to a name arrives DIRECT (a browser): its scheme is plain http, and its Origin must be
 * http://<that host> to pass the CSRF origin check.
 *
 * What is covered, by amendment (REDTEAM.md):
 *   R3   a move rewrites frontendUrl / gatewayUrl when they named the old main origin
 *   R7   only AUTHENTICATED use keeps an address "in use" for the interlock
 *   R8   GET is administrator + browser session only, like every write
 *   R10  an unreadable config aborts the write instead of replacing the install
 *   R2   removing an alias through the API retires the sessions minted on it
 *   R1   the /certs/config hook upgrades http → https of the same host, and only that
 * plus the commit contract: CAS on rev (409), the interlock (409 + force, audited), rollback when the
 * database refuses, audit rows, one notification per administrator and a link-free email — and every
 * link built outside the browser coming from the main address, never from the request's Host.
 */

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-site-address-${process.pid}-`));
const CONFIG_FILE = path.join(TMP_INSTALL, 'wordjs-config.json');
const STAGED = {
    installedAt: '2026-01-01T00:00:00.000Z',
    dbDriver: 'sqlite-native',
    siteUrl: 'https://example.com',
    frontendUrl: 'https://example.com',
    gatewayUrl: 'https://example.com',
    siteAliases: [{ url: 'https://www.example.com', mode: 'serve', source: 'admin', addedAt: '2026-01-02T00:00:00.000Z' }],
    hostPolicy: { ipLiterals: 'any' },
    siteAddress: { rev: 4 },
    // Present so nothing else writes the file under a test (frontend-purge generates one on first use).
    revalidateSecret: 'site-address-test-secret',
};
fs.writeFileSync(CONFIG_FILE, JSON.stringify(STAGED, null, 2));
process.chdir(TMP_INSTALL);

const ENV_KEYS = ['WORDJS_ALLOWED_HOSTS', 'WORDJS_IP_HOSTS', 'WORDJS_DEV_ORIGINS', 'WORDJS_TRUST_PROXY', 'WORDJS_MODE', 'WORDJS_EMBEDDED'];
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) { SAVED_ENV[key] = process.env[key]; delete process.env[key]; }

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-site-address-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
config.siteUrl = 'https://example.com';
config.site.url = 'https://example.com';
config.frontendUrl = 'https://example.com';
config.nodeEnv = 'production';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const configManager = require('../core/configManager');
const hostPolicy = require('../core/host-policy');
const siteAddress = require('../core/site-address');
const options = require('../core/options');
const database = require('../config/database');
const roles = require('../core/roles');
const app = require('../index');

// The frontend purge is an effect of every change (step 5). Record it instead of sending it: the staged
// frontendUrl is a real public name, and a test must not POST to it.
const purges: Array<{ tags: string[]; paths: string[] }> = [];
require('../core/frontend-purge').purgeFrontend = (tags: string[] = [], paths: string[] = []) => { purges.push({ tags, paths }); };

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
const U: Record<string, number> = {};
let db: any;
let server: any;

assert.strictEqual(configManager.CONFIG_FILE, CONFIG_FILE, 'the staged config must be the file configManager reads');

async function seedUser(login: string, role: string) {
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        [login, bcrypt.hashSync(PASSWORD, 10), `${login}@example.com`, login]);
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    db = database.getDbAsync();
    await roles.loadRoles();
    await require('../core/post-types').initPostTypes();
    await seedUser('siteadmin', 'administrator');
    await seedUser('otheradmin', 'administrator');
    await seedUser('editor1', 'editor');
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

after(async () => {
    siteAddress.stopWatching();
    try { await new Promise<void>((resolve) => server.close(() => resolve())); } catch { /* closed */ }
    try { await database.closeDatabase(); } catch { /* closed */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
    for (const key of ENV_KEYS) {
        if (SAVED_ENV[key] === undefined) delete process.env[key];
        else process.env[key] = SAVED_ENV[key];
    }
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP_INSTALL, { recursive: true, force: true }); } catch { /* */ }
});

// ─── helpers ────────────────────────────────────────────────────────────────────────────────────────

/** Put the world back: the staged file (optionally patched), matching mirrors, clean trackers. */
async function stage(patch: Record<string, unknown> = {}) {
    const cfg = { ...STAGED, ...patch };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    configManager.invalidateConfigCache();
    config.reloadFromFile(cfg);
    const canonical = hostPolicy.parseSiteUrl(cfg.siteUrl);
    if (canonical) {
        await options.updateOption('siteurl', canonical.origin);
        await options.updateOption('home', canonical.origin);
    }
    await options.updateOption('site_address_rev', configManager.siteAddressRev(cfg));
    hostPolicy.lastSeen.clear();
    hostPolicy.refusedHosts.clear();
    await db.run('DELETE FROM notifications');
    purges.length = 0;
    await db.run("DELETE FROM audit_log WHERE action LIKE 'site.address.%'");
}

const fileText = () => fs.readFileSync(CONFIG_FILE, 'utf8');
const fileConfig = () => JSON.parse(fileText());
const sessionOf = (login: string) => require('../middleware/auth').generateToken({ id: U[login], userLogin: login });

/**
 * A browser session on `host` (direct, plain http): session cookie + its CSRF partner + same-origin
 * Origin — everything the real admin screen sends.
 */
function asBrowser(method: string, url: string, login: string, host = 'example.com', opts: { csrf?: boolean } = {}) {
    const csrf = 'csrf-test-token-0123456789';
    const req = (request(app) as any)[method](url).set('Host', host).set('Origin', `http://${host}`);
    const cookies = [`wordjs_token=${sessionOf(login)}`, `wjs_csrf=${csrf}`];
    req.set('Cookie', cookies.join('; '));
    if (opts.csrf !== false) req.set('X-CSRF-Token', csrf);
    return req;
}

async function auditRows() {
    const rows = await db.all("SELECT actor_id, action, detail FROM audit_log WHERE action LIKE 'site.address.%' ORDER BY id");
    return rows.map((r: any) => ({ actor: r.actor_id, action: r.action, detail: JSON.parse(r.detail) }));
}

async function option(name: string) {
    const row = await db.get('SELECT option_value FROM options WHERE option_name = ?', [name]);
    return row ? row.option_value : undefined;
}

const PROBE = `${API}/`;

// ─── R8: who may read and write ────────────────────────────────────────────────────────────────────

describe('R8 — every route is administrator + browser session only', () => {
    beforeEach(() => stage());

    test('anonymous: 401 on read and write', async () => {
        const get = await request(app).get(`${API}/site-address`).set('Host', 'example.com');
        assert.strictEqual(get.status, 401, JSON.stringify(get.body));
        const put = await request(app).put(`${API}/site-address/canonical`).set('Host', 'example.com').set('Origin', 'http://example.com')
            .send({ url: 'https://new.example', currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(put.status, 401, JSON.stringify(put.body));
    });

    test('an editor: 403 rest_forbidden, nothing written', async () => {
        const before = fileText();
        const get = await asBrowser('get', `${API}/site-address`, 'editor1');
        assert.strictEqual(get.status, 403);
        assert.strictEqual(get.body.code, 'rest_forbidden');
        const put = await asBrowser('put', `${API}/site-address/canonical`, 'editor1').send({ url: 'https://new.example', currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(put.status, 403);
        assert.strictEqual(fileText(), before);
    });

    test('an administrator API token: 403 rest_token_management_forbidden on read AND write', async () => {
        const mint = await request(app).post(`${API}/auth/tokens`).set('Host', 'example.com').set('Origin', 'http://example.com')
            .set('Authorization', `Bearer ${sessionOf('siteadmin')}`).send({ name: `site-${Date.now()}`, scopes: '*' });
        assert.strictEqual(mint.status, 201, JSON.stringify(mint.body));
        const bearer = `Bearer ${mint.body.token}`;
        const get = await request(app).get(`${API}/site-address`).set('Host', 'example.com').set('Authorization', bearer);
        assert.strictEqual(get.status, 403, JSON.stringify(get.body));
        assert.strictEqual(get.body.code, 'rest_token_management_forbidden', 'the read lists the origin IPs: an API token must not get it (R8)');
        const before = fileText();
        const put = await request(app).put(`${API}/site-address/aliases`).set('Host', 'example.com').set('Authorization', bearer)
            .send({ aliases: [], currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(put.status, 403);
        assert.strictEqual(put.body.code, 'rest_token_management_forbidden');
        assert.strictEqual(fileText(), before);
    });

    test('a cookie session without the CSRF token: 403 rest_csrf_token, nothing written', async () => {
        const before = fileText();
        const res = await asBrowser('put', `${API}/site-address/policy`, 'siteadmin', 'example.com', { csrf: false })
            .send({ ipLiterals: 'none', currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.code, 'rest_csrf_token');
        assert.strictEqual(fileText(), before);
    });

    test('the wrong current password: 403 rest_bad_current_password, nothing written', async () => {
        const before = fileText();
        const res = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin').send({ url: 'https://new.example', currentPassword: 'nope', rev: 4 });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.code, 'rest_bad_current_password');
        assert.strictEqual(fileText(), before);
    });

    test('a stale rev: 409 rest_site_address_stale with the current rev, nothing written', async () => {
        const before = fileText();
        const res = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin').send({ url: 'https://new.example', currentPassword: PASSWORD, rev: 3 });
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'rest_site_address_stale');
        assert.strictEqual(res.body.data.rev, 4);
        assert.strictEqual(res.body.data.dependents, undefined, 'a stale write names no dependents (the client tells the two 409s apart by that)');
        assert.strictEqual(fileText(), before);
    });

    test('the administrator reads the whole state, including how they are connected', async () => {
        const res = await asBrowser('get', `${API}/site-address`, 'siteadmin', 'www.example.com');
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.headers['cache-control'], 'no-store');
        assert.strictEqual(res.body.rev, 4);
        assert.strictEqual(res.body.canonical, 'https://example.com');
        assert.deepStrictEqual(res.body.aliases.map((a: any) => [a.origin, a.mode, a.source, a.signInExplicit]), [['https://www.example.com', 'serve', 'admin', false]]);
        assert.deepStrictEqual(res.body.connectedVia, { host: 'www.example.com', cls: 'alias' });
        assert.ok(Array.isArray(res.body.ownAddresses));
        for (const ip of res.body.ownAddresses) assert.ok(!/^\[fe[89ab]/.test(ip) && !ip.startsWith('169.254.'), `link-local ${ip} must not be listed (R8)`);
        assert.strictEqual(res.body.ipLiterals, 'any');
        assert.strictEqual(res.body.conflict, null);
    });
});

// ─── validation: what a main address may be ───────────────────────────────────────────────────────

describe('PUT /canonical refuses anything that is not a bare site address', () => {
    beforeEach(() => stage());

    for (const url of ['javascript:alert(1)', 'https://a@b.example', 'https://x.example/path', 'https,https://x.example', 'https://*.example.com', 'http://[::1', 'https://127.1']) {
        test(`${JSON.stringify(url)} → 400, nothing written`, async () => {
            const before = fileText();
            const res = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin').send({ url, currentPassword: PASSWORD, rev: 4 });
            assert.strictEqual(res.status, 400, JSON.stringify(res.body));
            assert.strictEqual(res.body.code, 'rest_invalid_site_address');
            assert.strictEqual(fileText(), before);
        });
    }

    test('a missing rev is a 400 naming it (after the password: the sudo door is never skipped)', async () => {
        const res = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin').send({ url: 'https://new.example', currentPassword: PASSWORD });
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.body.data.params, ['rev']);
    });

    test('the same address again is a no-op: no revision, no audit, no notification', async () => {
        const before = fileText();
        const res = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin').send({ url: 'https://EXAMPLE.com/', currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body, { rev: 4, unchanged: true, warnings: [] });
        assert.strictEqual(fileText(), before);
        assert.deepStrictEqual(await auditRows(), []);
    });
});

// ─── a move ────────────────────────────────────────────────────────────────────────────────────────

describe('a change of main address', () => {
    let mail: any[] = [];
    const realSend = (global as any).wordjs_send_mail;
    beforeEach(async () => {
        await stage();
        await options.updateOption('admin_email', 'owner@example.org');
        mail = [];
        (global as any).wordjs_send_mail = (m: any) => { mail.push(m); };
    });
    afterEach(() => { (global as any).wordjs_send_mail = realSend; });

    test('the value comes from the BODY — never from the Host the admin is using — and the old address is kept', async () => {
        // The admin is on the alias; the body names a third address.
        const res = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin', 'www.example.com')
            .send({ url: 'https://new.example', currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.rev, 5);

        const cfg = fileConfig();
        assert.strictEqual(cfg.siteUrl, 'https://new.example', 'the body value is stored, not www.example.com');
        assert.deepStrictEqual(cfg.siteAliases.map((a: any) => [a.url, a.mode]),
            [['https://www.example.com', 'serve'], ['https://example.com', 'serve']], 'keep-old is the default');
        assert.strictEqual(cfg.siteAddress.rev, 5);
        assert.deepStrictEqual({ kind: cfg.siteAddress.lastChange.kind, via: cfg.siteAddress.lastChange.via, by: cfg.siteAddress.lastChange.by },
            { kind: 'canonical', via: 'ui', by: U.siteadmin });
        // Unrelated keys survive the rewrite.
        assert.strictEqual(cfg.installedAt, STAGED.installedAt);
        assert.strictEqual(cfg.dbDriver, 'sqlite-native');

        // Mirrors, in the database.
        assert.strictEqual(await option('siteurl'), 'https://new.example');
        assert.strictEqual(await option('home'), 'https://new.example');
        assert.strictEqual(await option('site_address_rev'), '5');
        // The runtime config followed without a restart.
        assert.strictEqual(config.siteUrl, 'https://new.example');

        // Every cached page may print an absolute URL: the whole frontend is purged.
        assert.ok(purges.some((p) => p.tags.includes('settings') && p.tags.includes('posts') && p.paths.includes('/')), JSON.stringify(purges));

        // The gate answers the new address at once, and still the old one (kept as an alias).
        assert.strictEqual((await request(app).get(PROBE).set('Host', 'new.example')).status, 200);
        assert.strictEqual((await request(app).get(PROBE).set('Host', 'example.com')).status, 200);
    });

    test('R3: frontendUrl and gatewayUrl follow when they named exactly the old main origin', async () => {
        await stage({ gatewayUrl: 'https://example.com:3000' });
        const res = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin').send({ url: 'https://new.example', currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const cfg = fileConfig();
        assert.strictEqual(cfg.frontendUrl, 'https://new.example', 'frontendUrl was the old main origin: rewritten');
        assert.strictEqual(cfg.gatewayUrl, 'https://example.com:3000', 'gatewayUrl named another origin: untouched');
        assert.strictEqual(config.frontendUrl, 'https://new.example', 'the CORS list (config.frontendUrl) no longer names the retired origin');
        const [row] = await auditRows();
        assert.deepStrictEqual(row.detail.rewritten, ['frontendUrl']);
    });

    test('the change is audited with from/to/via, and every administrator is told — in-app and by a link-free email', async () => {
        const res = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin').send({ url: 'https://new.example', oldAddress: 'redirect', currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const rows = await auditRows();
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].action, 'site.address.canonical');
        assert.strictEqual(rows[0].actor, U.siteadmin);
        assert.deepStrictEqual({ from: rows[0].detail.from, to: rows[0].detail.to, via: rows[0].detail.via, oldAddress: rows[0].detail.oldAddress, force: rows[0].detail.force },
            { from: 'https://example.com', to: 'https://new.example', via: 'ui', oldAddress: 'redirect', force: false });
        assert.strictEqual(fileConfig().siteAliases.find((a: any) => a.url === 'https://example.com').mode, 'redirect');

        const notes = await db.all('SELECT user_id, title, message FROM notifications ORDER BY user_id');
        assert.deepStrictEqual(notes.map((n: any) => n.user_id), [U.siteadmin, U.otheradmin], 'one notification per administrator, by id — never the broadcast user 0, never the editor');
        assert.match(notes[0].message, /example\.com to new\.example/);
        assert.match(notes[0].message, /siteadmin/);

        assert.strictEqual(mail.length, 1);
        assert.strictEqual(mail[0].to, 'owner@example.org');
        for (const part of [mail[0].text, mail[0].html]) {
            assert.ok(!/:\/\//.test(part) && !/<a\b/i.test(part), `the email must carry no link: ${part}`);
        }
    });

    test('dropping the old address retires it, and changing only the scheme keeps one host', async () => {
        // From the alias: the address the admin is signed in on would itself count as in use (see the interlock).
        const drop = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin', 'www.example.com').send({ url: 'https://new.example', oldAddress: 'drop', currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(drop.status, 200, JSON.stringify(drop.body));
        assert.deepStrictEqual(fileConfig().siteAliases.map((a: any) => a.url), ['https://www.example.com']);
        assert.strictEqual((await request(app).get(PROBE).set('Host', 'example.com')).status, 421, 'the dropped address is no longer answered');

        await stage({ siteUrl: 'http://example.com', frontendUrl: 'http://example.com', gatewayUrl: 'http://example.com' });
        const scheme = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin').send({ url: 'https://example.com', currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(scheme.status, 200, JSON.stringify(scheme.body));
        const cfg = fileConfig();
        assert.strictEqual(cfg.siteUrl, 'https://example.com');
        assert.ok(!cfg.siteAliases.some((a: any) => hostPolicy.parseSiteUrl(a.url).hostname === 'example.com'), 'the same host is never its own alias');
    });

    test('promoting an alias removes it from the list', async () => {
        const res = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin').send({ url: 'https://www.example.com', currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(fileConfig().siteAliases.map((a: any) => a.url), ['https://example.com']);
    });
});

// ─── the interlock (R7) ────────────────────────────────────────────────────────────────────────────

describe('the interlock refuses to retire an address something still uses', () => {
    beforeEach(() => stage());

    test('an address used by a SIGNED-IN request in the last ten minutes: 409 with dependents; force goes through and is audited', async () => {
        const me = await asBrowser('get', `${API}/auth/me`, 'siteadmin', 'www.example.com');
        assert.strictEqual(me.status, 200, JSON.stringify(me.body));
        const before = fileText();
        const refused = await asBrowser('put', `${API}/site-address/aliases`, 'siteadmin').send({ aliases: [], currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
        assert.strictEqual(refused.body.code, 'rest_site_address_in_use');
        assert.deepStrictEqual(refused.body.data.dependents.map((d: any) => [d.kind, d.host]), [['recent-use', 'www.example.com']]);
        assert.strictEqual(fileText(), before, 'nothing is written');

        const forced = await asBrowser('put', `${API}/site-address/aliases`, 'siteadmin').send({ aliases: [], currentPassword: PASSWORD, rev: 4, force: true });
        assert.strictEqual(forced.status, 200, JSON.stringify(forced.body));
        assert.deepStrictEqual(fileConfig().siteAliases, []);
        const [row] = await auditRows();
        assert.strictEqual(row.action, 'site.address.aliases');
        assert.strictEqual(row.detail.force, true, 'overriding the interlock is on the record');
        assert.deepStrictEqual(row.detail.forcedPast, ['recent-use www.example.com'], 'and so is what it went past');
        assert.deepStrictEqual(row.detail.removed, ['www.example.com']);
        const recorded = fileConfig().siteAddress.lastChange;
        assert.deepStrictEqual({ force: recorded.force, forcedPast: recorded.forcedPast, rev: recorded.rev }, { force: true, forcedPast: ['recent-use www.example.com'], rev: 5 },
            'the revision\'s record in the file says the same as its audit row');
    });

    test('R7: ANONYMOUS traffic on an address never keeps it "in use"', async () => {
        for (let i = 0; i < 5; i++) assert.strictEqual((await request(app).get(PROBE).set('Host', 'www.example.com')).status, 200);
        assert.ok(hostPolicy.lastSeen.get('www.example.com').seenAt > 0, 'the gate saw it');
        const res = await asBrowser('put', `${API}/site-address/aliases`, 'siteadmin').send({ aliases: [], currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(res.status, 200, `anonymous requests must not block the removal: ${JSON.stringify(res.body)}`);
    });

    test('an address that is the gateway URL is a dependent', async () => {
        await stage({ gatewayUrl: 'https://www.example.com:3000' });
        const res = await asBrowser('put', `${API}/site-address/aliases`, 'siteadmin').send({ aliases: [], currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.data.dependents, [{ kind: 'gatewayUrl', host: 'www.example.com', detail: 'https://www.example.com:3000' }]);
    });

    test('dropping the old main address checks it too — the admin\'s own signed-in use counts, R3-rewritten URLs do not', async () => {
        // Signed in ON the address being dropped: that use is the reason to confirm.
        const own = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin', 'example.com').send({ url: 'https://new.example', oldAddress: 'drop', currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(own.status, 409, JSON.stringify(own.body));
        assert.deepStrictEqual(own.body.data.dependents.map((d: any) => [d.kind, d.host]), [['recent-use', 'example.com']],
            'frontendUrl/gatewayUrl named the old main origin, but the same change rewrites them (R3), so they are not dependents');
        // From the alias, nothing else depends on the old address.
        hostPolicy.lastSeen.clear();
        const res = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin', 'www.example.com').send({ url: 'https://new.example', oldAddress: 'drop', currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    });
});

// ─── R2: retiring an alias through the API retires its sessions ────────────────────────────────────

describe('R2 — removing an alias through the API ends the sessions minted on it', () => {
    beforeEach(() => stage());

    test('an alias-bound session stops authenticating the moment the alias is removed', async () => {
        const bound = jwt.sign({ userId: U.otheradmin, username: 'otheradmin', mh: 'www.example.com' }, config.jwt.secret, { expiresIn: '1h' });
        const me = () => request(app).get(`${API}/auth/me`).set('Host', 'example.com').set('Cookie', `wordjs_token=${bound}`);
        assert.strictEqual((await me()).status, 200);
        const res = await asBrowser('put', `${API}/site-address/aliases`, 'siteadmin').send({ aliases: [], currentPassword: PASSWORD, rev: 4, force: true });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const after = await me();
        assert.strictEqual(after.status, 401, JSON.stringify(after.body));
        assert.strictEqual(after.body.code, 'rest_token_revoked');
    });
});

// ─── S6.6: what a change ended stays ended once the address is accepted again ─────────────────────

describe('S6.6 — accepting a retired address again does not bring its sessions back', () => {
    beforeEach(() => stage());
    const nowS = () => Math.floor(Date.now() / 1000);
    /** A session as generateToken mints it: `mh` is the address it was started on (none on loopback). */
    const session = (mh?: string, iat?: number) =>
        jwt.sign({ userId: U.otheradmin, username: 'otheradmin', ...(mh ? { mh } : {}), ...(iat ? { iat } : {}) }, config.jwt.secret, { expiresIn: '1h' });
    const me = (token: string, host = 'example.com') => request(app).get(`${API}/auth/me`).set('Host', host).set('Cookie', `wordjs_token=${token}`);
    const status = async (token: string, host?: string) => (await me(token, host)).status;
    const aliases = (list: unknown[], rev: number) =>
        asBrowser('put', `${API}/site-address/aliases`, 'siteadmin').send({ aliases: list, currentPassword: PASSWORD, rev, force: true });

    test('remove, then add back: the old session stays revoked everywhere and refresh cannot launder it; others are untouched', async () => {
        const old = session('www.example.com');
        const main = session('example.com');
        const loopback = session();
        assert.strictEqual(await status(old), 200);
        assert.strictEqual((await aliases([], 4)).status, 200);
        assert.strictEqual(await status(old), 401);
        const readded = await aliases(['https://www.example.com'], 5);
        assert.strictEqual(readded.status, 200, JSON.stringify(readded.body));

        for (const host of ['example.com', 'www.example.com']) {
            const after = await me(old, host);
            assert.strictEqual(after.status, 401, `${host}: ${JSON.stringify(after.body)}`);
            assert.strictEqual(after.body.code, 'rest_token_revoked');
        }
        const refresh = await request(app).post(`${API}/auth/refresh`).set('Host', 'example.com').set('Origin', 'http://example.com')
            .set('Cookie', `wordjs_token=${old}; wjs_csrf=t`).set('X-CSRF-Token', 't');
        assert.strictEqual(refresh.status, 401, `a refresh must not mint a fresh token from it: ${JSON.stringify(refresh.body)}`);
        assert.strictEqual(refresh.body.code, 'rest_token_revoked');
        assert.ok(!String(refresh.headers['set-cookie'] || '').includes('wordjs_token=ey'), 'no session cookie is issued');
        const bearer = await request(app).get(`${API}/auth/me`).set('Host', 'example.com').set('Authorization', `Bearer ${old}`);
        assert.strictEqual(bearer.status, 401, 'nor as a Bearer token');

        assert.strictEqual(await status(session('www.example.com', nowS() + siteAddress.RETIREMENT_GRACE_S + 1), 'www.example.com'), 200,
            'a session started on the address after it came back is a new session');
        assert.strictEqual(await status(main), 200, 'the main address was never retired');
        assert.strictEqual(await status(loopback), 200, 'a loopback session carries no address');
        assert.ok(fileConfig().siteAddress.retired.hosts['www.example.com'] >= nowS() - 60, 'recorded in the config, with the change');
    });

    test('dropping the old main address ends its sessions for good, even if it is added back as an alias', async () => {
        const main = session('example.com');
        const moved = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin', 'www.example.com')
            .send({ url: 'https://new.example', oldAddress: 'drop', currentPassword: PASSWORD, rev: 4, force: true });
        assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
        assert.strictEqual(await status(main, 'new.example'), 401);
        const back = await asBrowser('put', `${API}/site-address/aliases`, 'siteadmin', 'www.example.com')
            .send({ aliases: ['https://www.example.com', 'https://example.com'], currentPassword: PASSWORD, rev: 5 });
        assert.strictEqual(back.status, 200, JSON.stringify(back.body));
        assert.strictEqual(await status(main, 'new.example'), 401, 'example.com is answered again, but its old sessions are not');
    });

    test('narrowing the IP rule ends foreign-IP sessions for good; this machine\'s own addresses keep theirs', async () => {
        const own = [...hostPolicy.ownAddresses()][0];
        const foreign = session('203.0.113.9');
        const mine = own ? session(own) : null;
        const policy = (ipLiterals: string, rev: number) =>
            asBrowser('put', `${API}/site-address/policy`, 'siteadmin').send({ ipLiterals, currentPassword: PASSWORD, rev });
        assert.strictEqual(await status(foreign), 200);
        assert.strictEqual((await policy('own', 4)).status, 200);
        assert.strictEqual(await status(foreign), 401);
        if (mine) assert.strictEqual(await status(mine), 200, `own address ${own}: still answered, so still signed in`);
        assert.strictEqual((await policy('any', 5)).status, 200);
        assert.strictEqual(await status(foreign), 401, 'widening the rule again does not bring the foreign IP\'s session back');
        if (mine) assert.strictEqual(await status(mine), 200);
    });

    test('a sign-in in the seconds after its address was retired gets 503 with Retry-After, never a cookie that is already dead (lab R2V-M-NF1)', async () => {
        // Signing in on an alias of an https site needs real https, and this harness speaks plain http.
        await stage({ siteUrl: 'http://example.com', frontendUrl: 'http://example.com', gatewayUrl: 'http://example.com',
            siteAliases: [{ url: 'http://www.example.com', mode: 'serve', source: 'admin', addedAt: '2026-01-02T00:00:00.000Z' }] });
        assert.strictEqual((await aliases([], 4)).status, 200);
        assert.strictEqual((await aliases(['http://www.example.com'], 5)).status, 200);
        await db.run("DELETE FROM audit_log WHERE action = 'auth.login.success'");
        const login = () => request(app).post(`${API}/auth/login`).set('Host', 'www.example.com').set('Origin', 'http://www.example.com')
            .send({ username: 'otheradmin', password: PASSWORD });

        const refused = await login();
        assert.strictEqual(refused.status, 503, JSON.stringify(refused.body));
        assert.strictEqual(refused.body.code, 'rest_address_retiring');
        const wait = Number(refused.headers['retry-after']);
        assert.ok(wait >= 1 && wait <= siteAddress.RETIREMENT_GRACE_S + 1, `Retry-After ${wait}`);
        assert.strictEqual(refused.body.data.retryAfter, wait);
        assert.ok(!String(refused.headers['set-cookie'] || '').includes('wordjs_token='), 'no session cookie');
        assert.deepStrictEqual(await db.all("SELECT id FROM audit_log WHERE action = 'auth.login.success'"), [], 'answered before the credentials: no login recorded or counted');

        // Once the window is over (the record moved back a minute, rather than waiting it out), the same
        // sign-in gets a session that the very next request accepts.
        const cfg = fileConfig();
        cfg.siteAddress.retired.hosts['www.example.com'] -= 60;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
        configManager.invalidateConfigCache();
        const ok = await login();
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        const cookie = /wordjs_token=([^;]+)/.exec(String(ok.headers['set-cookie']));
        assert.ok(cookie, 'a session cookie');
        assert.strictEqual(await status(cookie![1], 'www.example.com'), 200);
    });

    test('a removal and re-add written by npm run site inside one config-cache window is not missed either (review R3S-2)', async () => {
        await stage({ siteUrl: 'http://example.com', frontendUrl: 'http://example.com', gatewayUrl: 'http://example.com',
            siteAliases: [{ url: 'http://www.example.com', mode: 'serve', source: 'admin', addedAt: '2026-01-02T00:00:00.000Z' }] });
        await db.run("DELETE FROM audit_log WHERE action = 'auth.login.success'");
        // This process has the file in its 2-second cache; then the CLI, another process, removes the alias
        // and adds it back. All this process could ever see is the record that removal left.
        assert.ok(configManager.getConfig().siteAliases.length === 1);
        const cfg = fileConfig();
        cfg.siteAddress = { ...cfg.siteAddress, retired: { hosts: { 'www.example.com': nowS() }, ipLiterals: [] } };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); // not invalidateConfigCache(): another process wrote it

        const refused = await request(app).post(`${API}/auth/login`).set('Host', 'www.example.com').set('Origin', 'http://www.example.com')
            .send({ username: 'otheradmin', password: PASSWORD });
        assert.strictEqual(refused.status, 503, `a cookie the session check refuses ${siteAddress.RETIREMENT_GRACE_S} s later: ${JSON.stringify(refused.body)}`);
        assert.strictEqual(refused.body.code, 'rest_address_retiring');
        assert.ok(!String(refused.headers['set-cookie'] || '').includes('wordjs_token='), 'no session cookie');
        assert.deepStrictEqual(await db.all("SELECT id FROM audit_log WHERE action = 'auth.login.success'"), []);

        // The one door reads it the same way: a token minted for the alias now is not handed out.
        const { issueSessionCookie } = require('../middleware/auth');
        const answered: any = { cookies: [] };
        const res: any = { set() { return res; }, status(code: number) { answered.status = code; return res; }, json() { return res; }, cookie(name: string) { answered.cookies.push(name); return res; } };
        const fresh = jwt.sign({ userId: U.otheradmin, username: 'otheradmin', mh: 'www.example.com' }, config.jwt.secret, { expiresIn: '1h' });
        assert.strictEqual(issueSessionCookie({ headers: { host: 'example.com' }, socket: { remoteAddress: '127.0.0.1' } }, res, fresh, {}), true);
        assert.deepStrictEqual([answered.status, answered.cookies], [503, []]);
        configManager.invalidateConfigCache();
    });

    test('the one door refuses any session the check would refuse, whatever minted it; every sign-in asks before the credentials (lab R2V-M-NF1)', async () => {
        assert.strictEqual((await aliases([], 4)).status, 200);
        assert.strictEqual((await aliases(['https://www.example.com'], 5)).status, 200);
        const { issueSessionCookie } = require('../middleware/auth');
        const answered: any = { headers: {}, cookies: [] };
        const res: any = {
            set(name: string, value: string) { answered.headers[name.toLowerCase()] = value; return res; },
            status(code: number) { answered.status = code; return res; },
            json(body: unknown) { answered.body = body; return res; },
            cookie(name: string) { answered.cookies.push(name); return res; },
        };
        // What refresh, MFA completion or the installer hand it: a token, on a request the gate did not classify.
        const req: any = { headers: { host: 'example.com' }, socket: { remoteAddress: '127.0.0.1' } };
        const dead = jwt.sign({ userId: U.otheradmin, username: 'otheradmin', mh: 'www.example.com' }, config.jwt.secret, { expiresIn: '1h' });
        assert.strictEqual(issueSessionCookie(req, res, dead, {}), true);
        assert.deepStrictEqual([answered.status, answered.body.code, answered.cookies], [503, 'rest_address_retiring', []]);
        assert.ok(Number(answered.headers['retry-after']) >= 1);
        const live = jwt.sign({ userId: U.otheradmin, username: 'otheradmin', mh: 'example.com' }, config.jwt.secret, { expiresIn: '1h' });
        assert.strictEqual(issueSessionCookie(req, res, live, {}), false, 'an address nothing retired goes through');
        assert.deepStrictEqual(answered.cookies, ['wordjs_token', 'wjs_csrf']);

        // The question the installer's auto-login asks first (routes/setup.ts), so the door never answers it.
        const { signInRetiring } = require('../middleware/auth');
        const on = (hostname: string, cls: string) => ({ headers: {}, siteHost: { hostname, host: hostname, cls, entry: null } });
        assert.strictEqual(signInRetiring(on('www.example.com', 'alias')), true);
        assert.strictEqual(signInRetiring(on('example.com', 'canonical')), false);
        assert.strictEqual(signInRetiring(on('localhost', 'loopback')), false, 'loopback carries no address to retire');

        // Login, registration and MFA completion ask before they look at a password or spend a code.
        const routes = fs.readFileSync(path.resolve(__dirname, '..', 'routes', 'auth.ts'), 'utf8');
        for (const [route, credential] of [["'/login'", 'User.authenticate('], ["'/register'", 'User.create('], ["'/mfa'", 'mfa.verifyLoginCode(']]) {
            const body = routes.slice(routes.indexOf(`router.post(${route}`));
            const ask = body.indexOf('refuseRetiringSignIn(req, res)');
            assert.ok(ask > 0 && ask < body.indexOf(credential), `${route} must refuse a retiring address before ${credential}`);
        }
    });
});

// ─── critic: the upgrade conflict banner's Use A / Use B both resolve it ───────────────────────────

describe('an upgrade conflict is resolved from the admin screen, whichever address is chosen (critic finding)', () => {
    /** A legacy config (no revision) whose main address the database does not share: the boot raises a conflict. */
    async function conflict() {
        await stage({ siteAddress: undefined });
        await options.updateOption('siteurl', 'https://old.example');
        await options.updateOption('home', 'https://old.example');
        assert.strictEqual((await siteAddress.reconcileAtBoot()).state, 'conflict');
        const state = await asBrowser('get', `${API}/site-address`, 'siteadmin');
        assert.deepStrictEqual({ rev: state.body.rev, conflict: state.body.conflict }, { rev: 0, conflict: { config: 'https://example.com', db: 'https://old.example' } });
    }
    afterEach(async () => {
        await stage();
        await siteAddress.reconcileAtBoot();
    });

    test('Use A — the configured address: recorded as a choice, the mirrors follow, the banner goes, audited', async () => {
        await conflict();
        const res = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin').send({ url: 'https://example.com', currentPassword: PASSWORD, rev: 0 });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.unchanged, undefined, 'not "nothing to change"');
        assert.strictEqual(res.body.rev, 1);
        assert.strictEqual(await option('siteurl'), 'https://example.com');
        assert.strictEqual(await option('home'), 'https://example.com');
        assert.strictEqual(await siteAddress.linkBase(), 'https://example.com', 'reset links use the chosen address');
        assert.strictEqual((await asBrowser('get', `${API}/site-address`, 'siteadmin')).body.conflict, null);
        const rows = await auditRows();
        assert.deepStrictEqual(rows.map((r: any) => [r.action, r.actor]), [['site.address.canonical', U.siteadmin], ['site.address.conflict_resolved', U.siteadmin]]);
        assert.deepStrictEqual({ to: rows[0].detail.to, confirmed: rows[0].detail.confirmed }, { to: 'https://example.com', confirmed: true });
        assert.deepStrictEqual({ db: rows[1].detail.db, chosen: rows[1].detail.chosen, via: rows[1].detail.via }, { db: 'https://old.example', chosen: 'https://example.com', via: 'ui' });
        // The notice says what happened, as the audit rows do (lab R2-M-NEW1: it read "The main address
        // changed from example.com to example.com." and never named the conflict or the other address).
        const [note] = await db.all('SELECT message FROM notifications WHERE user_id = ?', [U.siteadmin]);
        assert.strictEqual(note.message, 'example.com was confirmed as the main address. Confirmed by siteadmin (Settings → Site address). '
            + 'The two different main addresses, example.com in wordjs-config.json and old.example in the database, were reconciled: links and emails now use example.com.');
    });

    test('Use B — the database\'s address: the main address moves there, the banner goes, audited', async () => {
        await conflict();
        const res = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin').send({ url: 'https://old.example', currentPassword: PASSWORD, rev: 0 });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(fileConfig().siteUrl, 'https://old.example');
        assert.strictEqual(await option('siteurl'), 'https://old.example');
        assert.strictEqual((await asBrowser('get', `${API}/site-address`, 'siteadmin')).body.conflict, null);
        assert.deepStrictEqual((await auditRows()).map((r: any) => [r.action, r.detail.chosen ?? r.detail.to]),
            [['site.address.canonical', 'https://old.example'], ['site.address.conflict_resolved', 'https://old.example']]);
        const [note] = await db.all('SELECT message FROM notifications WHERE user_id = ?', [U.siteadmin]);
        assert.strictEqual(note.message, 'The main address changed from example.com to old.example. Changed by siteadmin (Settings → Site address). '
            + 'The two different main addresses, example.com in wordjs-config.json and old.example in the database, were reconciled: links and emails keep using old.example.');
    });
});

// ─── aliases: validation and defaults ──────────────────────────────────────────────────────────────

describe('PUT /aliases', () => {
    beforeEach(() => stage());

    test('a new tunnel name expires in a week; who added an existing entry and when is kept', async () => {
        const t0 = Date.now();
        const res = await asBrowser('put', `${API}/site-address/aliases`, 'siteadmin').send({
            aliases: [{ url: 'https://www.example.com', label: 'www\u0007 twin' }, { url: 'https://ab12.ngrok-free.app' }],
            currentPassword: PASSWORD, rev: 4,
        });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const [www, tunnel] = fileConfig().siteAliases;
        assert.deepStrictEqual({ source: www.source, addedAt: www.addedAt, label: www.label }, { source: 'admin', addedAt: '2026-01-02T00:00:00.000Z', label: 'www twin' });
        assert.strictEqual(tunnel.source, 'admin');
        assert.strictEqual(tunnel.addedBy, U.siteadmin);
        const ttl = Date.parse(tunnel.expiresAt) - t0;
        assert.ok(ttl > 6.9 * 864e5 && ttl < 7.1 * 864e5, `tunnel default expiry is a week, got ${ttl}ms`);
        const [row] = await auditRows();
        // (core/audit stores no empty list, so "removed nothing" is the absent key.)
        assert.deepStrictEqual({ added: row.detail.added, changed: row.detail.changed, removed: row.detail.removed },
            { added: ['ab12.ngrok-free.app'], changed: ['www.example.com'], removed: undefined });
    });

    test('a new .local name needs confirmLocal', async () => {
        const body = { aliases: [{ url: 'http://printer.local' }], currentPassword: PASSWORD, rev: 4, force: true };
        const refused = await asBrowser('put', `${API}/site-address/aliases`, 'siteadmin').send(body);
        assert.strictEqual(refused.status, 400);
        assert.strictEqual(refused.body.code, 'rest_site_address_confirm_local');
        const ok = await asBrowser('put', `${API}/site-address/aliases`, 'siteadmin').send({ ...body, confirmLocal: true });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    });

    for (const [name, aliases, code] of [
        ['a wildcard', [{ url: 'https://*.example.com' }], 'rest_invalid_site_address'],
        ['the main address', [{ url: 'https://example.com:8443' }], 'rest_invalid_param'],
        ['a name twice', [{ url: 'https://www.example.com' }, { url: 'http://www.example.com:8080' }], 'rest_invalid_param'],
        ['a bad mode', [{ url: 'https://www.example.com', mode: 'proxy' }], 'rest_invalid_param'],
        ['a bad expiry', [{ url: 'https://www.example.com', expiresAt: 'soon' }], 'rest_invalid_param'],
        ['not a list', 'https://www.example.com', 'rest_invalid_param'],
    ] as Array<[string, unknown, string]>) {
        test(`${name} → 400 ${code}`, async () => {
            const before = fileText();
            const res = await asBrowser('put', `${API}/site-address/aliases`, 'siteadmin').send({ aliases, currentPassword: PASSWORD, rev: 4 });
            assert.strictEqual(res.status, 400, JSON.stringify(res.body));
            assert.strictEqual(res.body.code, code);
            assert.strictEqual(fileText(), before);
        });
    }
});

describe('PUT /policy', () => {
    beforeEach(() => stage());

    test('switching IP literals off refuses a LAN IP at once; the change is audited', async () => {
        assert.strictEqual((await request(app).get(PROBE).set('Host', '192.168.1.23:3000')).status, 200);
        const res = await asBrowser('put', `${API}/site-address/policy`, 'siteadmin').send({ ipLiterals: 'none', currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(fileConfig().hostPolicy, { ipLiterals: 'none' });
        assert.strictEqual((await request(app).get(PROBE).set('Host', '192.168.1.23:3000')).status, 421);
        const [row] = await auditRows();
        assert.deepStrictEqual({ action: row.action, from: row.detail.from, to: row.detail.to }, { action: 'site.address.policy', from: 'any', to: 'none' });
    });

    test('an environment override is reported, not hidden', async () => {
        process.env.WORDJS_IP_HOSTS = 'any';
        try {
            const res = await asBrowser('put', `${API}/site-address/policy`, 'siteadmin').send({ ipLiterals: 'own', currentPassword: PASSWORD, rev: 4 });
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.warnings.some((w: string) => /WORDJS_IP_HOSTS/.test(w)), JSON.stringify(res.body));
        } finally {
            delete process.env.WORDJS_IP_HOSTS;
        }
    });

    test('an unknown mode → 400', async () => {
        const res = await asBrowser('put', `${API}/site-address/policy`, 'siteadmin').send({ ipLiterals: 'some', currentPassword: PASSWORD, rev: 4 });
        assert.strictEqual(res.status, 400);
    });

    test('the notice says what changed: the IP rule, sign-in on IP addresses, or both (lab R2-M-NEW1)', async () => {
        // `ip-signin on` used to read "The IP address policy changed from any to any." and nothing else.
        const notes = async () => (await db.all('SELECT message FROM notifications WHERE user_id = ? ORDER BY id', [U.siteadmin])).map((n: any) => n.message);
        const by = ' Changed by siteadmin (Settings → Site address).';
        const put = (body: Record<string, unknown>, rev: number) => asBrowser('put', `${API}/site-address/policy`, 'siteadmin').send({ ...body, currentPassword: PASSWORD, rev });
        assert.strictEqual((await put({ ipLiterals: 'any', ipSignIn: true }, 4)).status, 200);
        assert.strictEqual((await put({ ipLiterals: 'own', ipSignIn: false }, 5)).status, 200);
        assert.strictEqual((await put({ ipLiterals: 'none' }, 6)).status, 200);
        assert.deepStrictEqual(await notes(), [
            `Signing in on IP addresses was turned on.${by}`,
            `The IP address policy changed from any to own. Signing in on IP addresses was turned off.${by}`,
            `The IP address policy changed from own to none.${by}`,
        ]);
        const rows = await auditRows();
        assert.deepStrictEqual(rows.map((r: any) => [r.detail.ipSignInFrom, r.detail.ipSignIn]), [[false, true], [true, false], [false, false]], 'the audit row records both sides of the switch');
    });

    test('on a config that stores no IP rule, it is read as `any`, as the server reads it (review UX-3)', async () => {
        // The lab's own path: `ip-signin on` on a fresh install, whose file has no hostPolicy at all.
        const notes = async () => (await db.all('SELECT message FROM notifications WHERE user_id = ? ORDER BY id', [U.siteadmin])).map((n: any) => n.message);
        const put = (body: Record<string, unknown>) => asBrowser('put', `${API}/site-address/policy`, 'siteadmin').send({ ...body, currentPassword: PASSWORD, rev: 4 });
        await stage({ hostPolicy: undefined });
        assert.strictEqual((await put({ ipLiterals: 'any', ipSignIn: true })).status, 200);
        assert.deepStrictEqual(await notes(), ['Signing in on IP addresses was turned on. Changed by siteadmin (Settings → Site address).']);
        await stage({ hostPolicy: undefined });
        assert.strictEqual((await put({ ipLiterals: 'any' })).status, 200);
        assert.deepStrictEqual(await notes(), ['The IP address policy was saved as any, which was already in effect. Saved by siteadmin (Settings → Site address).']);
        assert.deepStrictEqual((await auditRows()).map((r: any) => [r.detail.from, r.detail.to]), [['default', 'any']], 'the record keeps what the file held');
    });

    test('a record written before ipSignInFrom existed claims no switch it cannot know about (review DOC-3)', () => {
        // An older `npm run site` (a stale dist/) wrote these. The switch is known to have moved only when
        // the stored rule did not; otherwise the notice says where it stands now.
        const legacy = (summary: Record<string, unknown>) => siteAddress.describeChange('policy', summary);
        assert.strictEqual(legacy({ from: 'default', to: 'any', ipSignIn: false }), 'The IP address policy was saved as any, and signing in on IP addresses is off.');
        assert.strictEqual(legacy({ from: 'default', to: 'any', ipSignIn: true }), 'The IP address policy was saved as any, and signing in on IP addresses is on.');
        assert.strictEqual(legacy({ from: 'any', to: 'any', ipSignIn: true }), 'Signing in on IP addresses was turned on.');
        assert.strictEqual(legacy({ from: 'own', to: 'own', ipSignIn: false }), 'Signing in on IP addresses was turned off.');
        assert.strictEqual(legacy({ from: 'any', to: 'own', ipSignIn: true }), 'The IP address policy changed from any to own; signing in on IP addresses is on.');
        assert.strictEqual(legacy({ from: 'default', to: 'none', ipSignIn: false }), 'The IP address policy changed from any to none; signing in on IP addresses is off.');
    });
});

// ─── atomicity: the file and the database never disagree ───────────────────────────────────────────

describe('commit atomicity', () => {
    beforeEach(() => stage());

    test('when the database refuses the mirrors, the previous config bytes come back and the API answers 500', async () => {
        const before = fileText();
        const real = options.updateOption;
        options.updateOption = async (name: string, value: any, autoload?: string) => {
            if (name === 'home') throw new Error('disk full (simulated)');
            return real(name, value, autoload);
        };
        try {
            const res = await asBrowser('put', `${API}/site-address/canonical`, 'siteadmin').send({ url: 'https://new.example', currentPassword: PASSWORD, rev: 4 });
            assert.strictEqual(res.status, 500, JSON.stringify(res.body));
            assert.strictEqual(res.body.code, 'rest_site_address_rollback');
            assert.strictEqual(res.body.data.restored, true);
        } finally {
            options.updateOption = real;
        }
        assert.strictEqual(fileText(), before, 'the config file is byte-for-byte what it was');
        assert.strictEqual(await option('siteurl'), 'https://example.com', 'the siteurl write inside the same transaction was rolled back too');
        assert.strictEqual(await option('site_address_rev'), '4');
        assert.strictEqual(config.siteUrl, 'https://example.com', 'the runtime config is back as well');
        assert.strictEqual((await request(app).get(PROBE).set('Host', 'new.example')).status, 421, 'the gate never answers the address that was not stored');
        assert.deepStrictEqual(await auditRows(), [], 'nothing happened, so nothing is audited');
    });

    test('R10: an unreadable config aborts the write — 503, and the file is NOT replaced by the site-address keys alone', async () => {
        const garbage = '{"installedAt": "2026-01-01", "dbDriver": "sqlite-native", "jwtSecret": "keep-me", "siteUrl": ';
        fs.writeFileSync(CONFIG_FILE, garbage);
        configManager.invalidateConfigCache();
        try {
            const res = await asBrowser('put', `${API}/site-address/policy`, 'siteadmin').send({ ipLiterals: 'none', currentPassword: PASSWORD, rev: 4 });
            assert.strictEqual(res.status, 503, JSON.stringify(res.body));
            assert.strictEqual(res.body.code, 'rest_config_unreadable');
            assert.strictEqual(fileText(), garbage, 'not one byte written');
            assert.strictEqual(configManager.saveConfig({ revalidateSecret: 'x' }), false, 'every writer refuses, not just the site-address one');
            assert.strictEqual(fileText(), garbage);
        } finally {
            await stage();
        }
    });
});

// ─── links are built from the main address, never from the request ─────────────────────────────────

describe('link bases', () => {
    const realSend = (global as any).wordjs_send_mail;
    let mail: any[] = [];
    beforeEach(async () => {
        await stage();
        mail = [];
        (global as any).wordjs_send_mail = (m: any) => { mail.push(m); };
        await options.updateOption('mail_delivery_ready', '1');
    });
    afterEach(async () => {
        (global as any).wordjs_send_mail = realSend;
        await options.updateOption('mail_delivery_ready', '0');
    });

    test('a reset link requested through an ALIAS, with a forged X-Forwarded-Host, still points at the main address', async () => {
        await db.run("INSERT OR REPLACE INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'personal_email', 'me@personal.example')", [U.editor1]);
        const res = await request(app).post(`${API}/auth/forgot-password`).set('Host', 'www.example.com').set('Origin', 'http://www.example.com')
            .set('X-Forwarded-Host', 'attacker.example').send({ login: 'editor1' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(mail.length, 1, 'the reset mail was sent');
        const link = (/https?:\/\/\S+reset-password\S*/.exec(mail[0].text) || [''])[0];
        assert.ok(link.startsWith('https://example.com/reset-password?'), `the link must use the main address, got ${JSON.stringify(link)} in ${mail[0].text}`);
    });

    test('with the siteurl mirror gone, links fall back to the CONFIGURED main address — not to the Host', async () => {
        await db.run("DELETE FROM options WHERE option_name IN ('siteurl', 'home')");
        await require('../core/cache').del('option:siteurl');
        await require('../core/cache').del('option:home');
        assert.strictEqual(await siteAddress.linkBase(), 'https://example.com');
        const robots = await request(app).get(`${API}/seo/robots.txt`).set('Host', '192.168.1.9');
        assert.strictEqual(robots.status, 200);
        assert.match(robots.text, /https:\/\/example\.com\/sitemap\.xml/);
        assert.ok(!robots.text.includes('192.168.1.9'), 'the request host never reaches robots.txt');
        const sitemap = await request(app).get(`${API}/seo/sitemap.xml`).set('Host', '192.168.1.9');
        assert.strictEqual(sitemap.status, 200);
        assert.ok(!sitemap.text.includes('192.168.1.9'), 'nor the sitemap');
        assert.match(sitemap.text, /<loc>https:\/\/example\.com\//);
    });

    test('a corrupted mirror is never a link base', async () => {
        await options.updateOption('siteurl', 'https,http://example.com');
        await options.updateOption('home', 'javascript:alert(1)');
        assert.strictEqual(await siteAddress.linkBase(), 'https://example.com');
    });

    test('plugins\' site.url()/domain() and the mailbox reservation use the same base', async () => {
        await options.updateOption('siteurl', 'https://example.com');
        const api = require('../core/plugin-api').createPluginApi('test-plugin');
        assert.strictEqual(await api.site.url(), 'https://example.com');
        assert.strictEqual(await api.site.domain(), 'example.com');
        assert.strictEqual(await require('../core/mailbox').getMailDomain(), 'example.com');
    });
});

// ─── the old writers are closed ────────────────────────────────────────────────────────────────────

describe('siteurl / home cannot be written around the site-address API', () => {
    beforeEach(() => stage());

    test('PUT /settings skips them in a bulk save; PUT /settings/siteurl is a 400 naming the right API', async () => {
        const bearer = `Bearer ${sessionOf('siteadmin')}`;
        const bulk = await request(app).put(`${API}/settings`).set('Host', 'example.com').set('Authorization', bearer)
            .send({ siteurl: 'https://evil.example', home: 'https://evil.example', blogname: 'Renamed' });
        assert.strictEqual(bulk.status, 200, JSON.stringify(bulk.body));
        assert.deepStrictEqual(Object.keys(bulk.body), ['blogname']);
        assert.strictEqual(await option('siteurl'), 'https://example.com');
        const single = await request(app).put(`${API}/settings/siteurl`).set('Host', 'example.com').set('Authorization', bearer).send({ value: 'https://evil.example' });
        assert.strictEqual(single.status, 400);
        assert.match(single.body.message, /site-address/);
    });

    test('site_address_rev is a protected option: plugins cannot read or write it, themes cannot write it', async () => {
        const { isProtectedOption } = require('../core/plugin-api');
        assert.strictEqual(isProtectedOption('site_address_rev'), true);
        // The theme-context backstop in core/options (every option writer calls it) delegates to the same
        // predicate; ask the backstop itself, in a theme's context, rather than restating its list here.
        const { assertThemeOptionWritable } = require('../core/options');
        const { runWithContext } = require('../core/plugin-context');
        runWithContext('theme:site-address-probe', () => {
            assert.throws(() => assertThemeOptionWritable('site_address_rev'), /not writable from theme context/);
            assert.throws(() => assertThemeOptionWritable('siteurl'), /not writable from theme context/);
            assert.doesNotThrow(() => assertThemeOptionWritable('site_address_revision'), 'exact names, not prefixes');
        });
    });
});

// ─── R1 through the certificates page ──────────────────────────────────────────────────────────────

describe('R1 — after a TLS/port change on the certificates page', () => {
    const certManager = require('../core/cert-manager');
    const realUpdate = certManager.updateGatewayConfig;
    const realEnsure = certManager.ensureGatewayCert;
    let gatewayAnswer = '';
    beforeEach(() => {
        certManager.updateGatewayConfig = async () => ({ success: true, siteUrl: gatewayAnswer });
        certManager.ensureGatewayCert = async () => ({ success: true });
    });
    afterEach(() => {
        certManager.updateGatewayConfig = realUpdate;
        certManager.ensureGatewayCert = realEnsure;
    });
    const toggle = () => request(app).post(`${API}/system/certs/config`).set('Host', 'example.com')
        .set('Authorization', `Bearer ${sessionOf('siteadmin')}`).send({ sslEnabled: true, port: 443 });

    test('the same host moving http → https is applied at once, audited as a repair', async () => {
        await stage({ siteUrl: 'http://example.com', frontendUrl: 'http://example.com', gatewayUrl: 'http://example.com' });
        gatewayAnswer = 'https://example.com';
        const res = await toggle();
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.canonicalUpgraded, 'https://example.com');
        assert.strictEqual(fileConfig().siteUrl, 'https://example.com');
        assert.strictEqual(await option('siteurl'), 'https://example.com', 'reset links are now https');
        const [row] = await auditRows();
        assert.deepStrictEqual({ action: row.action, via: row.detail.via, from: row.detail.from, to: row.detail.to },
            { action: 'site.address.repair', via: 'gateway', from: 'http://example.com', to: 'https://example.com' });
        // Bare names in the notice (no link), so the move is said in words, not as "example.com to example.com".
        const [note] = await db.all('SELECT message FROM notifications WHERE user_id = ?', [U.siteadmin]);
        assert.strictEqual(note.message, 'The main address example.com now uses https instead of http. Changed by an automatic repair.');
    });

    test('a downgrade is only suggested — nothing is written', async () => {
        await stage();
        gatewayAnswer = 'http://example.com:3000';
        const before = fileText();
        const res = await toggle();
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.suggestCanonical, 'http://example.com:3000');
        assert.strictEqual(res.body.canonicalUpgraded, undefined);
        assert.strictEqual(fileText(), before);
        assert.strictEqual(await option('siteurl'), 'https://example.com');
        const state = await asBrowser('get', `${API}/site-address`, 'siteadmin');
        assert.deepStrictEqual(state.body.gatewayDrift, { gateway: 'http://example.com:3000', config: 'https://example.com' });
    });

    test('another host is only suggested, even over https', async () => {
        await stage({ siteUrl: 'http://example.com' });
        gatewayAnswer = 'https://other.example';
        const before = fileText();
        const res = await toggle();
        assert.strictEqual(res.body.suggestCanonical, 'https://other.example');
        assert.strictEqual(fileText(), before);
    });
});

// ─── the API that has always printed absolute URLs grows a relative one ────────────────────────────

describe('featuredMedia.path', () => {
    test('a post with a featured image carries the same file as a same-origin path', async () => {
        const Post = require('../models/Post');
        const media = await Post.create({ authorId: U.siteadmin, title: 'Cover', type: 'attachment', status: 'inherit' });
        await Post.updateMeta(media.id, '_wp_attached_file', '2026/10/cover.png');
        const post = await Post.create({ authorId: U.siteadmin, title: 'With cover', type: 'post', status: 'publish' });
        await Post.updateMeta(post.id, '_thumbnail_id', String(media.id));
        const json = await (await Post.findById(post.id)).toJSON();
        assert.ok(json.featuredMedia, 'the featured image is serialised');
        assert.strictEqual(json.featuredMedia.path, '/uploads/2026/10/cover.png');
        assert.match(json.featuredMedia.url, /\/uploads\/2026\/10\/cover\.png$/, 'url stays absolute for og:image and API consumers');
    });
});
