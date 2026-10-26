/**
 * Admin → Site Health → Duplicate records, on the REAL app (SQLite): a database whose rows repeat a login,
 * an email, a slug or a term slug, and what the panel does about it.
 *
 *   - Authorization never relies on a uniqueness the database does not enforce: two accounts with the same
 *     login (or email) can no longer sign in AS whichever row the engine reads first — the lookup refuses.
 *   - Site Health reports the rules that are not enforced and links to the screen.
 *   - The screen lists each duplicated value with its rows; resolving one re-authenticates, keeps the row
 *     the administrator chose, gives every other row a new unique value, deletes nothing, keeps the
 *     previous login/email in the account's meta, returns every change and audits it.
 *   - Once nothing repeats, the unique index is built at once (no restart) and Site Health is green.
 *
 * MUTATION PROOF: revert User.findByLogin to `dbAsync.get` → 'twin' signs in as the first row (the
 * ambiguity test fails); drop requireSudoPassword from POST /resolve → the no-password call is 200.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-dbint-${process.pid}-`));
const DATA_DIR = path.join(TMP_INSTALL, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
for (const d of ['uploads', 'plugins', 'themes']) fs.mkdirSync(path.join(TMP_INSTALL, d), { recursive: true });
const MAIN = 'localhost:3000';
fs.writeFileSync(path.join(TMP_INSTALL, 'wordjs-config.json'), JSON.stringify({ installedAt: '2026-01-01T00:00:00.000Z', dbDriver: 'sqlite-native', siteUrl: `http://${MAIN}` }, null, 2));
process.chdir(TMP_INSTALL);

const config = require('../config/app');
config.dbPath = path.join(DATA_DIR, 'wordjs-native.db');
config.dbDriver = 'sqlite-native';
config.siteUrl = `http://${MAIN}`;
config.site.url = `http://${MAIN}`;
config.uploads.dir = path.join(TMP_INSTALL, 'uploads');

const request = require('supertest');
const database = require('../config/database');
const siteContext = require('../core/site-context');
require('../core/updater')._setForTests({ fetchJson: async () => [] });
const app = require('../index');

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
const TWIN_A = 'Twin-A-pass-1!';
const TWIN_B = 'Twin-B-pass-2!';
let server: any;
let token = '';
let writerToken = '';
const db = () => database.getDbAsync();

const login = (username: string, password: string) =>
    (request(server) as any).post(`${API}/auth/login`).set('Host', MAIN).set('Origin', `http://${MAIN}`).send({ username, password });
const tokenOf = (res: any) => {
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('wordjs_token='));
    return cookie ? decodeURIComponent(String(cookie).split(';')[0].slice('wordjs_token='.length)) : '';
};
const get = (url: string, who = token) => (request(server) as any).get(`${API}${url}`).set('Host', MAIN).set('Authorization', `Bearer ${who}`);
const post = (url: string, body: any, who = token) => (request(server) as any).post(`${API}${url}`).set('Host', MAIN).set('Authorization', `Bearer ${who}`).send(body);

async function addUser(loginName: string, email: string, password: string, role: string) {
    const r = await db().run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)', [loginName, bcrypt.hashSync(password, 4), email, loginName]);
    await db().run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)", [r.lastID, role]);
    return Number(r.lastID);
}

const ids: Record<string, number> = {};

before(async () => {
    await siteContext.runWithSite(1, async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        await require('../core/options').initDefaultOptions(config);
        await require('../core/roles').loadRoles();
        await addUser('owner', 'owner@example.com', PASSWORD, 'administrator');
        await addUser('writer', 'writer@example.com', PASSWORD, 'author');
        // An install from before the unique indexes (or where they could not be built), with duplicates.
        for (const idx of ['idx_users_login', 'idx_users_email', 'idx_posts_name_type', 'uq_terms_slug']) await db().exec(`DROP INDEX IF EXISTS ${idx}`);
        ids.twinA = await addUser('twin', 'twin-a@example.com', TWIN_A, 'subscriber');
        ids.twinB = await addUser('twin', 'twin-b@example.com', TWIN_B, 'subscriber');
        ids.casey = await addUser('casey', 'shared@example.com', PASSWORD, 'subscriber');
        ids.morgan = await addUser('morgan', 'Shared@Example.com', PASSWORD, 'subscriber');
        for (const status of ['publish', 'draft']) {
            const r = await db().run("INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_name, post_type, post_date, post_date_gmt, post_modified, post_modified_gmt, guid) VALUES (1, 'About', '', '', ?, 'about', 'page', '2026-10-21 10:00:00', '2026-10-21 10:00:00', '2026-10-21 10:00:00', '2026-10-21 10:00:00', '')", [status]);
            ids[`page_${status}`] = Number(r.lastID);
        }
        for (const n of [1, 2]) ids[`term${n}`] = Number((await db().run("INSERT INTO terms (name, slug) VALUES ('News', 'news')")).lastID);
    });
    require('../core/plugins-ready').markPluginsReady();
    server = http.createServer(app);
    await new Promise<void>((resolve) => siteContext.runWithSite(null, () => server.listen(0, '127.0.0.1', resolve)));
    token = tokenOf(await login('owner', PASSWORD));
    writerToken = tokenOf(await login('writer', PASSWORD));
    assert.ok(token && writerToken, 'signed in');
});

after(async () => {
    try { await new Promise<void>((resolve) => server.close(() => resolve())); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP_INSTALL, { recursive: true, force: true }); } catch { /* */ }
});

describe('Duplicate records', () => {
    test('two accounts with one login: neither signs in by that login, and lookups name nobody', async () => {
        assert.strictEqual((await login('twin', TWIN_A)).status, 401, 'the first row\'s password does not pick it');
        assert.strictEqual((await login('twin', TWIN_B)).status, 401, 'nor does the second\'s');
        const User = require('../models/User');
        assert.strictEqual(await siteContext.runWithSite(1, () => User.findByLogin('twin')), null);
        assert.strictEqual(await siteContext.runWithSite(1, () => User.findByEmail('shared@example.com')), null, 'an email two accounts share names nobody');
        // Signing in by the account's own (unique) email still works.
        assert.strictEqual((await login('twin-a@example.com', TWIN_A)).status, 200);
    });

    test('Site Health reports the rules the database does not enforce, and links to the screen', async () => {
        const res = await get('/health/site');
        assert.strictEqual(res.status, 200);
        const c = res.body.checks.find((x: any) => x.id === 'database.unique');
        assert.ok(c, 'the check is there');
        assert.strictEqual(c.status, 'warn');
        assert.strictEqual(c.messageKey, 'siteHealth.check.database.unique.duplicates');
        assert.strictEqual(c.fix.href, '/admin/database-integrity');
        assert.strictEqual(c.vars.count, '4');
    });

    test('the screen lists each duplicated value with its rows; non-administrators are refused', async () => {
        assert.strictEqual((await get('/database-integrity', writerToken)).status, 403);
        const s = await get('/database-integrity');
        assert.strictEqual(s.status, 200);
        for (const r of s.body.rules) assert.strictEqual(r.enforced, false, r.id);
        const logins = await get('/database-integrity/users.login/duplicates');
        assert.strictEqual(logins.status, 200);
        assert.deepStrictEqual(logins.body.groups.map((g: any) => g.key), ['twin']);
        assert.deepStrictEqual(logins.body.groups[0].rows.map((r: any) => r.id), [ids.twinA, ids.twinB]);
        assert.ok(!('user_pass' in logins.body.groups[0].rows[0]), 'never the password hash');
        assert.strictEqual((await get('/database-integrity/users.pass/duplicates')).status, 400);
    });

    test('resolving re-authenticates, keeps the chosen row, renames the others, deletes nothing and audits it', async () => {
        const usersBefore = Number((await db().get('SELECT COUNT(*) AS c FROM users')).c);
        const noPw = await post('/database-integrity/resolve', { rule: 'users.login', key: 'twin', keepId: ids.twinA });
        assert.strictEqual(noPw.status, 403, 'no password, no change');
        const wrong = await post('/database-integrity/resolve', { rule: 'users.login', key: 'twin', keepId: 999999, currentPassword: PASSWORD });
        assert.strictEqual(wrong.status, 400, 'the row to keep must be in the group');

        const r = await post('/database-integrity/resolve', { rule: 'users.login', key: 'twin', keepId: ids.twinA, currentPassword: PASSWORD });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(r.body.changes, [{ id: ids.twinB, field: 'user_login', from: 'twin', to: `twin-${ids.twinB}` }]);
        assert.strictEqual(Number((await db().get('SELECT COUNT(*) AS c FROM users')).c), usersBefore, 'no account was deleted');
        const meta = await db().get("SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = '_wordjs_previous_login'", [ids.twinB]);
        assert.strictEqual(meta && meta.meta_value, 'twin', 'the previous login is kept');
        const audit = await db().get("SELECT detail FROM audit_log WHERE action = 'database.duplicates.resolve' ORDER BY id DESC LIMIT 1");
        assert.ok(audit, 'audited');
        assert.deepStrictEqual(JSON.parse(audit.detail).changedIds, [ids.twinB]);
        // Each account signs in with its own login again.
        assert.strictEqual((await login('twin', TWIN_A)).status, 200);
        assert.strictEqual((await login(`twin-${ids.twinB}`, TWIN_B)).status, 200);
        assert.strictEqual(r.body.rules.find((x: any) => x.id === 'users.login').enforced, true, 'the login index is built at once');

        const again = await post('/database-integrity/resolve', { rule: 'users.login', key: 'twin', keepId: ids.twinA, currentPassword: PASSWORD });
        assert.strictEqual(again.status, 404, 'a value no longer duplicated');
    });

    test('emails keep their mailbox, slugs and terms get a number; then every rule is enforced', async () => {
        const e = await post('/database-integrity/resolve', { rule: 'users.email', key: 'shared@example.com', keepId: ids.casey, currentPassword: PASSWORD });
        assert.strictEqual(e.status, 200, JSON.stringify(e.body));
        assert.deepStrictEqual(e.body.changes, [{ id: ids.morgan, field: 'user_email', from: 'Shared@Example.com', to: `shared+dup${ids.morgan}@example.com` }]);
        const p = await post('/database-integrity/resolve', { rule: 'posts.slug', key: 'page/about', keepId: ids.page_publish, currentPassword: PASSWORD });
        assert.strictEqual(p.status, 200, JSON.stringify(p.body));
        assert.deepStrictEqual(p.body.changes, [{ id: ids.page_draft, field: 'post_name', from: 'about', to: 'about-2' }]);
        const t = await post('/database-integrity/resolve', { rule: 'terms.slug', key: 'news', keepId: ids.term1, currentPassword: PASSWORD });
        assert.strictEqual(t.status, 200, JSON.stringify(t.body));
        assert.deepStrictEqual(t.body.changes, [{ id: ids.term2, field: 'slug', from: 'news', to: 'news-2' }]);
        for (const r of t.body.rules) assert.strictEqual(r.enforced, true, `${r.id} enforced without a restart`);

        const health = await get('/health/site');
        assert.strictEqual(health.body.checks.find((x: any) => x.id === 'database.unique').status, 'ok');
        // The database itself now refuses a new duplicate.
        await assert.rejects(db().run("INSERT INTO users (user_login, user_pass, user_email) VALUES ('twin', 'x', 'third@example.com')"));
    });
});
