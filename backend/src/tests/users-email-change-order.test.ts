/**
 * CHANGING YOUR EMAIL DOES NOT TELL A CALLER WITHOUT YOUR PASSWORD WHETHER AN ADDRESS HAS AN ACCOUNT.
 *
 * PUT /users/me checked "does another account hold this address?" BEFORE the current-password (sudo) gate
 * that every address change demands. So, with no password at all:
 *     {email: <a registered address>}  → 400 rest_invalid_email
 *     {email: <a free address>}        → 403 rest_bad_current_password
 * — an account-existence oracle for anyone holding the session: a hijacked cookie, a same-origin script, a
 * borrowed browser. PUT /users/:id serves self-edits too and had the same order (the twin).
 *
 * Now the format is judged up front (it depends on the request alone) and the lookup of other accounts
 * runs after the sudo proof: without the password, both addresses get the same 403 and nothing is
 * looked up; with it, the owner gets the uniform 400 for a taken address and the change for a free one.
 * An administrator editing ANOTHER account (no sudo there) still gets the 400.
 *
 * MUTATION PROOF: move primaryEmailTakenByAnother back above the sudo gate in either handler and the
 * matching "same answer without the password" test fails with 400 against 403.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-email-order-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const B = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
const TAKEN = 'registered-victim@example.com';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(B, require('../routes'));

const U: Record<string, number> = {};
let dbAsync: any;
const session = (login: string) => `Bearer ${jwt.sign({ userId: U[login], username: login }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}`;
const view = (res: any) => ({ status: res.status, body: res.body });

async function seedUser(login: string, role: string, email = `${login}@example.com`) {
    const r = await dbAsync.run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
        [login, bcrypt.hashSync(PASSWORD, 10), email, login]);
    await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)", [r.lastID, role]);
    U[login] = r.lastID;
}
const emailOf = async (login: string) => (await dbAsync.get('SELECT user_email FROM users WHERE id = ?', [U[login]])).user_email;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/roles').loadRoles();
    await seedUser('victim', 'subscriber', TAKEN);
    await seedUser('selfme', 'subscriber');
    await seedUser('selfid', 'author');
    await seedUser('admin', 'administrator');
    await seedUser('target', 'subscriber');
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

for (const [label, login, url] of [
    ['PUT /users/me', 'selfme', () => `${B}/users/me`],
    ['PUT /users/:ownId (the twin)', 'selfid', () => `${B}/users/${U.selfid}`],
] as const) {
    describe(label, () => {
        const put = (body: any) => request(app).put(url()).set('Authorization', session(login)).send(body);

        it('without the password, a registered and a free address get the same answer', async () => {
            const taken = await put({ email: TAKEN });
            const free = await put({ email: `free-${login}@example.com` });
            assert.deepStrictEqual(view(taken), view(free), 'the answer told the two addresses apart');
            assert.strictEqual(taken.status, 403);
            assert.strictEqual(taken.body.code, 'rest_bad_current_password');
            // ...and with a WRONG password too.
            const takenWrong = await put({ email: TAKEN, currentPassword: 'not-it-at-all' });
            const freeWrong = await put({ email: `free-${login}@example.com`, currentPassword: 'not-it-at-all' });
            assert.deepStrictEqual(view(takenWrong), view(freeWrong));
            assert.strictEqual(await emailOf(login), `${login}@example.com`, 'nothing was written');
        });

        it('a malformed address is refused up front, password or not (it depends on the request alone)', async () => {
            const res = await put({ email: 'not-an-email' });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.code, 'rest_invalid_email');
        });

        it('with the password, a registered address is the uniform 400 and a free one is changed', async () => {
            const taken = await put({ email: TAKEN, currentPassword: PASSWORD });
            assert.strictEqual(taken.status, 400, JSON.stringify(taken.body));
            assert.strictEqual(taken.body.code, 'rest_invalid_email');
            assert.strictEqual(await emailOf('victim'), TAKEN);
            const free = await put({ email: `moved-${login}@example.com`, currentPassword: PASSWORD });
            assert.strictEqual(free.status, 200, JSON.stringify(free.body));
            assert.strictEqual(await emailOf(login), `moved-${login}@example.com`);
        });
    });
}

it('an administrator editing ANOTHER account (no sudo there) still gets the uniform 400 for a taken address', async () => {
    const res = await request(app).put(`${B}/users/${U.target}`).set('Authorization', session('admin')).send({ email: TAKEN });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_invalid_email');
    assert.strictEqual(await emailOf('target'), 'target@example.com');
});
