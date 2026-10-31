/**
 * AN ADMINISTRATOR CREATES ACCOUNTS WITHOUT AN EMAIL, AND THE DISPLAY NAME THEY TYPE IS KEPT.
 *
 *   • The account email is the account's OWN address — a professional mailbox fills it in. An account
 *     without one has none: POST /users takes no `email`, stores '', and the personal address stays in
 *     `personalEmail` (it is never copied into the account email). Several such accounts can exist: the
 *     unique email rule leaves '' out (migration 0026 rebuilds the index of an existing install).
 *   • A display name that IS the login was swapped for «User <id>» without a word — what a password manager
 *     filling the login into the field above the password produced in production. It is refused now.
 *   • Every other door (self-registration, the importers, the model by default) still requires an email.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-optemail-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const User = require('../models/User');
const { generateToken } = require('../middleware/auth');
const { MIGRATIONS } = require('../core/schema-migrations');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));

const PW = 'Correct-Horse-1';
let dbAsync: any;
let cookie = '';

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await roles.loadRoles();
    const root = await User.create({ username: 'root', email: 'root@example.com', password: PW, role: 'administrator' });
    cookie = `wordjs_token=${generateToken(await User.findById(root.id))}`;
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const suf of ['', '-wal', '-shm']) { try { fs.rmSync(TMP_DB + suf, { force: true }); } catch { /* */ } }
});

const create = (body: Record<string, any>) => request(app).post('/api/v1/users').set('Cookie', cookie).send({ password: PW, role: 'subscriber', ...body });
const rowOf = (id: number) => dbAsync.get('SELECT user_email, display_name FROM users WHERE id = ?', [id]);

test('an account is created with no email; the personal address stays personal', async () => {
    const res = await create({ username: 'cindy.reales', displayName: 'Cindy Reales', personalEmail: 'cindy@personal.example' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const row = await rowOf(res.body.id);
    assert.strictEqual(row.user_email, '', 'the account email is empty, not the personal address');
    assert.strictEqual(row.display_name, 'Cindy Reales');
    assert.strictEqual(await User.getMeta(res.body.id, 'personal_email'), 'cindy@personal.example');
});

test('several accounts can have no email; a real address is still unique', async () => {
    const a = await create({ username: 'noemail.a', displayName: 'A' });
    const b = await create({ username: 'noemail.b', displayName: 'B', email: '' });
    assert.strictEqual(a.status, 201, JSON.stringify(a.body));
    assert.strictEqual(b.status, 201, JSON.stringify(b.body));

    const first = await create({ username: 'owner1', displayName: 'Owner', email: 'same@example.com' });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await create({ username: 'owner2', displayName: 'Owner 2', email: 'SAME@example.com' });
    assert.strictEqual(second.status, 400, JSON.stringify(second.body));
    assert.strictEqual(second.body.code, 'rest_user_exists');
    // The database rule too, not only the application check.
    await assert.rejects(dbAsync.run("INSERT INTO users (user_login, user_pass, user_email) VALUES ('raw', 'x', 'same@example.com')"));
    await dbAsync.run("INSERT INTO users (user_login, user_pass, user_email) VALUES ('raw2', 'x', '')");
});

test('a malformed email given is still refused', async () => {
    const res = await create({ username: 'badmail', displayName: 'Bad', email: 'not-an-address' });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_invalid_param');
});

test('a display name that is the login is refused, not swapped for «User <id>»', async () => {
    const res = await create({ username: 'maria.lopez', displayName: 'Maria.Lopez' });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_display_name_is_login');
    assert.strictEqual(await User.findByLogin('maria.lopez'), null, 'nothing was created');
});

test('every other door still requires an email', async () => {
    await assert.rejects(User.create({ username: 'model.default', password: PW }), /required/);
    await assert.rejects(User.assertNewIdentity('register.door', ''), /Invalid email format/);
    assert.strictEqual(await User.findByEmail(''), null, 'an empty address names nobody');
});

test('migration 0026 rebuilds an existing install\'s email rule so \'\' is outside it', async () => {
    // The shape an install had before: the rule over every row, with one email-less account already in it.
    await dbAsync.exec('DROP INDEX IF EXISTS idx_users_email');
    await dbAsync.run("DELETE FROM users WHERE user_email = '' AND user_login <> 'cindy.reales'");
    await dbAsync.exec('CREATE UNIQUE INDEX idx_users_email ON users (LOWER(user_email))');
    await assert.rejects(dbAsync.run("INSERT INTO users (user_login, user_pass, user_email) VALUES ('before', 'x', '')"));

    const m = MIGRATIONS.find((x: any) => x.id === '0026_users_email_optional');
    const ctx = {
        driverName: 'sqlite-native', isPostgres: false,
        exec: (sql: string) => dbAsync.exec(sql), run: (sql: string, p: any[] = []) => dbAsync.run(sql, p),
        get: (sql: string, p: any[] = []) => dbAsync.get(sql, p), all: (sql: string, p: any[] = []) => dbAsync.all(sql, p),
    };
    assert.strictEqual(await m.up(ctx), undefined, 'recorded, not deferred');
    await dbAsync.run("INSERT INTO users (user_login, user_pass, user_email) VALUES ('after', 'x', '')");
    await assert.rejects(dbAsync.run("INSERT INTO users (user_login, user_pass, user_email) VALUES ('dupe', 'x', 'root@example.com')"));
});
