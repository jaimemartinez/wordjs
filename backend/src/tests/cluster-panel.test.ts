/**
 * WordJS — Admin → Servers (routes/cluster.ts) on the REAL app: the panel path for `npm run cluster` and
 * `npm run node:join`. The gateway end of the mTLS control channel is replaced by a recorder (its own
 * logic is gateway/test/cluster-admin.test.js); what is held here is the backend's half:
 *
 *   - a monolith answers { mode: 'monolith' } and refuses every write (there is no gateway to join);
 *   - in split mode GET relays the gateway's nodes and tokens;
 *   - minting a join token and removing a node take the password AND a fresh two-factor code, are
 *     refused to API tokens and to non-administrators, and are audited without the token itself;
 *   - revoking every token takes the password and is audited.
 *
 * MUTATION PROOF (verified once each): drop requireStepUp from POST /token → the "no code" case reaches
 * the gateway; drop recordAudit from /nodes/remove → no cluster.node.remove row; drop the monolith guard
 * → the monolith reaches the gateway.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-cluster-${process.pid}-`));
fs.mkdirSync(path.join(TMP_INSTALL, 'data'), { recursive: true });
const MAIN = 'localhost:3000';
fs.writeFileSync(path.join(TMP_INSTALL, 'wordjs-config.json'), JSON.stringify({ installedAt: '2026-01-01T00:00:00.000Z', dbDriver: 'sqlite-native', siteUrl: `http://${MAIN}` }, null, 2));
process.chdir(TMP_INSTALL);
const ENV_KEYS = ['WORDJS_EMBEDDED', 'WORDJS_MODE'];
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) { SAVED_ENV[key] = process.env[key]; delete process.env[key]; }

const config = require('../config/app');
config.dbPath = path.join(TMP_INSTALL, 'data', 'wordjs-native.db');
config.dbDriver = 'sqlite-native';
config.siteUrl = `http://${MAIN}`;
config.site.url = `http://${MAIN}`;
config.nodeEnv = 'production';

// The gateway, as the control channel reaches it.
const calls: Array<{ method: string; path: string; body: any }> = [];
const certManager = require('../core/cert-manager');
certManager.gatewayControlRequest = async (method: string, urlPath: string, body: any) => {
    calls.push({ method, path: urlPath, body });
    if (urlPath === '/cluster') return { status: 200, text: JSON.stringify({ initialized: true, advertiseHost: '10.0.0.1', enrollPort: 3101, caFingerprint: 'AA', nodes: [{ url: 'https://10.0.0.2:4000', role: 'backend', routes: ['/api'], status: 'up' }], tokens: [], removed: [] }) };
    if (urlPath === '/cluster/token') return { status: 200, text: JSON.stringify({ token: 'wjc.backend.SECRET', role: body.role, host: body.host || null, expiresAt: '2026-01-01T00:15:00.000Z', command: 'node scripts/node-join.js …', readmitted: 0 }) };
    if (urlPath === '/cluster/tokens/revoke') return { status: 200, text: '{"revoked":true}' };
    if (urlPath === '/cluster/nodes/remove') return body.url === 'https://10.0.0.2:4000' ? { status: 200, text: '{"removed":"https://10.0.0.2:4000","routes":1}' } : { status: 404, text: '{"code":"cluster_node_not_found"}' };
    return { status: 404, text: '{}' };
};

const request = require('supertest');
const database = require('../config/database');
const siteContext = require('../core/site-context');
const totp = require('../core/totp');
const mfa = require('../core/mfa');
const User = require('../models/User');
const app = require('../index');

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
let server: any;
const U: Record<string, number> = {};
const tokens: Record<string, string> = {};
let secret = '';
const realNow = Date.now;
let offsetMs = 0;
Date.now = () => realNow() + offsetMs;
const freshCode = () => { offsetMs += 31 * 1000; return totp.totp(secret); };

const as = (who: string, method: string, url: string) => (request(server) as any)[method](url).set('Host', MAIN).set('Origin', `http://${MAIN}`).set('Authorization', `Bearer ${tokens[who]}`);
const audit = (action: string) => siteContext.runWithSite(1, () => database.getDbAsync().all('SELECT * FROM audit_log WHERE action = ?', [action]));

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
            U[login] = r.lastID;
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
    const tok = await as('owner', 'post', `${API}/auth/tokens`).send({ name: 'automation', scopes: '*' });
    tokens.apiToken = tok.body.token;
    secret = totp.generateSecret();
    await siteContext.runWithSite(1, async () => {
        await User.updateMeta(U.owner, mfa.META.lastStep, '-1');
        await User.updateMeta(U.owner, mfa.META.secret, secret);
        await User.updateMeta(U.owner, mfa.META.backup, JSON.stringify([]));
        await User.updateMeta(U.owner, mfa.META.enabled, '1');
    });
});

after(async () => {
    Date.now = realNow;
    try { await new Promise<void>((resolve) => server.close(() => resolve())); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const key of ENV_KEYS) { if (SAVED_ENV[key] === undefined) delete process.env[key]; else process.env[key] = SAVED_ENV[key]; }
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP_INSTALL, { recursive: true, force: true }); } catch { /* */ }
});

describe('Admin → Servers', () => {
    test('a monolith has no cluster: GET says so and every write is refused before the gateway', async () => {
        process.env.WORDJS_EMBEDDED = '1';
        try {
            const res = await as('owner', 'get', `${API}/system/cluster`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.mode, 'monolith');
            const tok = await as('owner', 'post', `${API}/system/cluster/token`).send({ role: 'backend', currentPassword: PASSWORD, mfaCode: freshCode() });
            assert.strictEqual(tok.status, 409);
            assert.strictEqual(tok.body.code, 'cluster_monolith');
        } finally {
            delete process.env.WORDJS_EMBEDDED;
        }
        assert.strictEqual(calls.length, 0, 'nothing reached a gateway');
    });

    test('split mode relays the nodes; administrators only, never an API token', async () => {
        const res = await as('owner', 'get', `${API}/system/cluster`);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        // A node on another machine: the deployment is reported as separate, not split (QA X1-08).
        assert.strictEqual(res.body.mode, 'separate');
        assert.strictEqual(res.body.nodes[0].status, 'up');
        // Said up front: this session may use the writes, and where the main address is (QA X1-06).
        assert.strictEqual(res.body.boundSession, false);
        assert.strictEqual(res.body.mainAddress, `http://${MAIN}`);
        assert.strictEqual((await as('writer', 'get', `${API}/system/cluster`)).status, 403);
        const token = await (request(server) as any).get(`${API}/system/cluster`).set('Host', MAIN).set('Authorization', `Bearer ${tokens.apiToken}`);
        assert.strictEqual(token.status, 403, JSON.stringify(token.body));
    });

    test('a join token takes the password and a fresh code, and is audited without the token', async () => {
        calls.length = 0;
        const noCode = await as('owner', 'post', `${API}/system/cluster/token`).send({ role: 'backend', host: '10.0.0.7', currentPassword: PASSWORD });
        assert.strictEqual(noCode.status, 403);
        assert.strictEqual(noCode.body.code, 'rest_mfa_step_up_required');
        const badPw = await as('owner', 'post', `${API}/system/cluster/token`).send({ role: 'backend', currentPassword: 'nope', mfaCode: freshCode() });
        assert.strictEqual(badPw.status, 403);
        assert.strictEqual(calls.length, 0, 'a refused request reaches no gateway');

        const ok = await as('owner', 'post', `${API}/system/cluster/token`).send({ role: 'backend', host: '10.0.0.7', ttlMinutes: 15, currentPassword: PASSWORD, mfaCode: freshCode() });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        assert.strictEqual(ok.body.token, 'wjc.backend.SECRET');
        assert.deepStrictEqual(calls, [{ method: 'POST', path: '/cluster/token', body: { role: 'backend', host: '10.0.0.7', ttlMinutes: 15 } }]);
        const rows = await audit('cluster.token.create');
        assert.strictEqual(rows.length, 1);
        assert.doesNotMatch(String(rows[0].detail), /SECRET/, 'the token never reaches the audit log');
        assert.match(String(rows[0].detail), /10\.0\.0\.7/);
    });

    test('an invalid join-token request is refused BEFORE the two-factor code is spent (QA X1-08)', async () => {
        calls.length = 0;
        const code = freshCode();
        for (const bad of [{ role: 'gateway' }, { role: 'backend', ttlMinutes: -3 }, { role: 'backend', host: 'bad host;rm -rf' }]) {
            const r = await as('owner', 'post', `${API}/system/cluster/token`).send({ ...bad, currentPassword: PASSWORD, mfaCode: code });
            assert.strictEqual(r.status, 400, JSON.stringify(r.body));
            assert.match(r.body.code, /^cluster_invalid_(role|ttl|host)$/);
        }
        assert.strictEqual(calls.length, 0);
        // The same code still works for the corrected request.
        const ok = await as('owner', 'post', `${API}/system/cluster/token`).send({ role: 'frontend', currentPassword: PASSWORD, mfaCode: code });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    });

    test('removing a node takes the password and a fresh code; revoking tokens takes the password; both audited', async () => {
        calls.length = 0;
        const noCode = await as('owner', 'post', `${API}/system/cluster/nodes/remove`).send({ url: 'https://10.0.0.2:4000', currentPassword: PASSWORD });
        assert.strictEqual(noCode.status, 403);
        const author = await as('writer', 'post', `${API}/system/cluster/nodes/remove`).send({ url: 'https://10.0.0.2:4000', currentPassword: PASSWORD, mfaCode: '000000' });
        assert.strictEqual(author.status, 403);
        assert.strictEqual(calls.length, 0);
        const missing = await as('owner', 'post', `${API}/system/cluster/nodes/remove`).send({ url: 'https://10.9.9.9:4000', currentPassword: PASSWORD, mfaCode: freshCode() });
        assert.strictEqual(missing.status, 404);
        const ok = await as('owner', 'post', `${API}/system/cluster/nodes/remove`).send({ url: 'https://10.0.0.2:4000', currentPassword: PASSWORD, mfaCode: freshCode() });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        assert.strictEqual((await audit('cluster.node.remove')).length, 1);

        const revokeBad = await as('owner', 'post', `${API}/system/cluster/tokens/revoke`).send({ currentPassword: 'nope' });
        assert.strictEqual(revokeBad.status, 403);
        const revoke = await as('owner', 'post', `${API}/system/cluster/tokens/revoke`).send({ currentPassword: PASSWORD });
        assert.strictEqual(revoke.status, 200);
        assert.strictEqual((await audit('cluster.tokens.revoke')).length, 1);
    });
});
