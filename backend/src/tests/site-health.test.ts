/**
 * WordJS — Site Health (GET /api/v1/health/site), on the REAL app: the installation's diagnostics in
 * plain words, each with where to fix it in the panel.
 *
 *   - Administrators only; every check has an id, a group, a status, a title and a message.
 *   - The database engine: sqlite-legacy is a warning that links to the migration (Settings → Network).
 *   - Sending email: no transport is a failure that links to Settings → Email.
 *   - The reverse proxy: a request that came through an untrusted proxy on this machine is reported as
 *     a failure (every visitor would look like 127.0.0.1); a direct one is fine.
 *   - Restarting by itself: a process nothing restarts is a warning.
 *
 * MUTATION PROOF (verified once each): make checkProxy ignore X-Forwarded-For → the proxy case is "ok";
 * drop the sqlite-legacy branch from checkDatabase → no database.driver check; let a non-admin through
 * (drop isAdmin) → the author gets 200.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-sitehealth-${process.pid}-`));
const DATA_DIR = path.join(TMP_INSTALL, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
for (const d of ['uploads', 'plugins', 'themes']) fs.mkdirSync(path.join(TMP_INSTALL, d), { recursive: true });
const MAIN = 'localhost:3000';
fs.writeFileSync(path.join(TMP_INSTALL, 'wordjs-config.json'), JSON.stringify({ installedAt: '2026-01-01T00:00:00.000Z', dbDriver: 'sqlite-native', siteUrl: `http://${MAIN}` }, null, 2));
process.chdir(TMP_INSTALL);
const ENV_KEYS = ['WORDJS_TRUST_PROXY', 'WORDJS_SUPERVISED', 'WORDJS_EMBEDDED', 'KUBERNETES_SERVICE_HOST', 'INVOCATION_ID', 'pm_id', 'PM2_HOME', 'WORDJS_RESTART_ON_EXIT'];
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) { SAVED_ENV[key] = process.env[key]; delete process.env[key]; }

const config = require('../config/app');
config.dbPath = path.join(DATA_DIR, 'wordjs-native.db');
config.dbDriver = 'sqlite-native';
config.siteUrl = `http://${MAIN}`;
config.site.url = `http://${MAIN}`;
config.uploads.dir = path.join(TMP_INSTALL, 'uploads');
config.nodeEnv = 'production';
config.trustProxy = null; // automatic: decided by the deployment mode (core/client-ip)

const request = require('supertest');
const database = require('../config/database');
const siteContext = require('../core/site-context');
// No call to GitHub from a test: the updater's releases feed answers "nothing newer" (tests/updater.test.ts).
require('../core/updater')._setForTests({ fetchJson: async () => [] });
const app = require('../index');

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
let server: any;
const tokens: Record<string, string> = {};

const as = (who: string) => (request(server) as any).get(`${API}/health/site`).set('Host', MAIN).set('Authorization', `Bearer ${tokens[who]}`);
const byId = (res: any, id: string) => res.body.checks.find((c: any) => c.id === id);

before(async () => {
    await siteContext.runWithSite(1, async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        await require('../core/options').initDefaultOptions(config);
        await require('../core/roles').loadRoles();
        const db = database.getDbAsync();
        for (const [login, role] of [['owner', 'administrator'], ['writer', 'author']]) {
            const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`, [login, bcrypt.hashSync(PASSWORD, 10), `${login}@example.com`, login]);
            await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
        }
    });
    require('../core/plugins-ready').markPluginsReady();
    server = http.createServer(app);
    await new Promise<void>((resolve) => siteContext.runWithSite(null, () => server.listen(0, '127.0.0.1', resolve)));
    for (const login of ['owner', 'writer']) {
        const res = await (request(server) as any).post(`${API}/auth/login`).set('Host', MAIN).set('Origin', `http://${MAIN}`).send({ username: login, password: PASSWORD });
        const cookie = ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('wordjs_token='));
        tokens[login] = decodeURIComponent(String(cookie).split(';')[0].slice('wordjs_token='.length));
    }
});

after(async () => {
    try { await new Promise<void>((resolve) => server.close(() => resolve())); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const key of ENV_KEYS) { if (SAVED_ENV[key] === undefined) delete process.env[key]; else process.env[key] = SAVED_ENV[key]; }
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP_INSTALL, { recursive: true, force: true }); } catch { /* */ }
});

describe('Site Health', () => {
    test('administrators get every check in plain words; others are refused', async () => {
        const res = await as('owner');
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.ok(res.body.checks.length >= 8, JSON.stringify(res.body.checks.map((c: any) => c.id)));
        for (const c of res.body.checks) {
            assert.ok(['versions', 'storage', 'database', 'mail', 'security', 'background'].includes(c.group), c.id);
            assert.ok(['ok', 'warn', 'fail', 'info'].includes(c.status), c.id);
            assert.ok(c.title && c.message && c.message.length > 10, c.id);
            if (c.fix) assert.match(c.fix.href, /^\/admin\//, c.id);
        }
        const total = Object.values(res.body.summary).reduce((a: number, b: any) => a + Number(b), 0);
        assert.strictEqual(total, res.body.checks.length);
        assert.strictEqual(byId(res, 'database.reachable').status, 'ok');
        assert.strictEqual(byId(res, 'storage.folders').status, 'ok');
        assert.strictEqual((await as('writer')).status, 403);
    });

    test('sqlite-legacy is a warning that links to the migration; no mail transport links to account email', async () => {
        const saved = config.dbDriver;
        config.dbDriver = 'sqlite-legacy';
        try {
            const res = await as('owner');
            const drv = byId(res, 'database.driver');
            assert.ok(drv, 'the engine is reported');
            assert.strictEqual(drv.status, 'warn');
            assert.strictEqual(drv.fix.href, '/admin/settings/network');
            const mail = byId(res, 'mail.transport');
            assert.strictEqual(mail.status, 'fail');
            assert.strictEqual(mail.fix.href, '/admin/settings/email');
        } finally {
            config.dbDriver = saved;
        }
        assert.strictEqual(byId(await as('owner'), 'database.driver'), undefined, 'sqlite-native raises nothing');
    });

    test('a request through an untrusted proxy on this machine is reported; a direct one is fine', async () => {
        const direct = byId(await as('owner'), 'security.proxy');
        assert.strictEqual(direct.status, 'ok', JSON.stringify(direct));
        // The monolith trusts no hop by default: nginx in front of it, unconfigured, collapses every visitor.
        process.env.WORDJS_EMBEDDED = '1';
        try {
            const proxied = byId(await as('owner').set('X-Forwarded-For', '203.0.113.9'), 'security.proxy');
            assert.strictEqual(proxied.status, 'fail', JSON.stringify(proxied));
            assert.match(proxied.message, /127\.0\.0\.1/);
            assert.strictEqual(proxied.fix.href, '/admin/security');
        } finally {
            delete process.env.WORDJS_EMBEDDED;
        }
        // In split mode the gateway is the one trusted hop: the forwarded address is the visitor's.
        assert.strictEqual(byId(await as('owner').set('X-Forwarded-For', '203.0.113.9'), 'security.proxy').status, 'ok');
    });

    test('a process nothing would restart is a warning; a supervised one is fine', async () => {
        const manual = byId(await as('owner'), 'background.restart');
        if (require('../core/restart').restartMode() === 'manual') assert.strictEqual(manual.status, 'warn');
        process.env.WORDJS_SUPERVISED = '1';
        try {
            assert.strictEqual(byId(await as('owner'), 'background.restart').status, 'ok');
        } finally {
            delete process.env.WORDJS_SUPERVISED;
        }
    });
});
