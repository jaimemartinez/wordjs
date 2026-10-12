/**
 * AN API TOKEN DOES NOT DECIDE WHO HAS AN ACCOUNT, OR WITH WHAT POWER — on every route that can.
 *
 * routes/users.ts refuses an administrator's `wjt_` write token on POST /users ("an API token may not
 * mint a brand-new administrator"), but the same token reached the same outcome through three other
 * doors, each with a 200:
 *
 *   · POST /import {importUsers, updateExisting} created an administrator with an address the caller
 *     reads, and moved the real administrator's email to another such address — forgot-password then
 *     mailed the reset link to the caller, and the account was theirs with an interactive session;
 *   · PUT /settings {users_can_register:'1', default_role:'administrator'} turned the next ANONYMOUS
 *     POST /auth/register into an administrator with a session cookie (PUT /settings/:key the same);
 *   · POST /roles redefined `subscriber` with every capability; POST /import/wordpress created an account
 *     per unmatched author.
 *
 * Those are exactly the writes a session bound to a secondary address was already refused
 * (refuseBoundSession). They now share ONE predicate (middleware/auth refuseAccountAuthority), so each
 * route refuses both credentials. Everything runs through the REAL routers with a REAL token minted by
 * POST /auth/tokens, and every assertion is on the state that results — the account list, the stored
 * options, the role map, the outcome of an anonymous registration — not only on the status code.
 *
 * The registration settings are judged under their CANONICAL name (core/registration-settings, via
 * core/option-names): MySQL compares option names case-insensitively, so a site import carrying
 * `REQUIRE_EMAIL_VERIFICATION` or `Mail_Delivery_Ready` wrote the real row while the check, comparing
 * names byte for byte, saw neither.
 *
 * MUTATION PROOF: make refuseAccountAuthority skip its isHeadless branch (or put refuseBoundSession back
 * at any of the call sites) and the matching test below fails with a 200 and the account/option written;
 * put back the byte-for-byte name match in changedRegistrationSettings and the spelling suite fails.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-account-authority-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const User = require('../models/User');
const { getOption, updateOption } = require('../core/options');
const { csrfProtection } = require('../middleware/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const B = config.api.prefix;
const SECRET = config.jwt.secret;
const PASSWORD = 'Correct-Horse-9!';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(B, csrfProtection);
app.use(B, require('../routes'));
// The anonymous sign-up probe arrives the way a non-browser client does (no Origin, no CSRF cookie); the
// CSRF gate is not what is under test there, so it goes to the same routers without it.
const anonymousApp = express();
anonymousApp.use(express.json());
anonymousApp.use(cookieParser());
anonymousApp.use(B, require('../routes'));

const U: Record<string, number> = {};
let dbAsync: any;
let token = '';

const session = (persona: string) => `Bearer ${jwt.sign({ userId: U[persona], username: persona }, SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
const asToken = () => `Bearer ${token}`;

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        'INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
        [login, bcrypt.hashSync(PASSWORD, 10), `${login}@example.com`, login]);
    await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)", [r.lastID, role]);
    U[login] = r.lastID;
}

function assertTokenRefused(res: any, label: string) {
    assert.strictEqual(res.status, 403, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'rest_token_management_forbidden', `${label}: ${JSON.stringify(res.body)}`);
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    await seedUser('owner', 'administrator');
    await seedUser('operator', 'administrator');

    // The strongest token there is: an administrator's, global `write` scope.
    const minted = await request(app).post(`${B}/auth/tokens`).set('Authorization', session('operator')).send({ name: 'ci', scopes: 'write' });
    assert.strictEqual(minted.status, 201, JSON.stringify(minted.body));
    token = minted.body.token;
    assert.ok(/^wjt_/.test(token));
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

describe('POST /import with importUsers', () => {
    const takeover = {
        version: '1.0',
        content: {
            users: [
                { id: 900, username: 'ghost', email: 'ghost@evil.example', role: 'administrator', displayName: 'Ghost' },
                { id: 901, username: 'owner', email: 'owner-takeover@evil.example', displayName: 'Owner' },
            ],
        },
    };

    it('refuses the token: no administrator is minted and no existing account is re-addressed', async () => {
        const res = await request(app).post(`${B}/import`).set('Authorization', asToken())
            .send({ importUsers: true, updateExisting: true, data: takeover });
        assertTokenRefused(res, 'POST /import importUsers');
        assert.deepStrictEqual(res.body.data.params, ['importUsers']);
        assert.strictEqual(await User.findByLogin('ghost'), null, 'no account was created');
        const owner = await User.findByLogin('owner');
        assert.strictEqual(owner.userEmail, 'owner@example.com', 'the administrator keeps their address');
        // ...so forgot-password for the attacker's address reaches nobody.
        assert.strictEqual(await User.findByEmail('owner-takeover@evil.example'), null);
    });

    it('a site import WITHOUT accounts or registration settings still works with the token (no over-block)', async () => {
        const res = await request(app).post(`${B}/import`).set('Authorization', asToken())
            .send({ data: { version: '1.0', settings: { blogdescription: 'Imported by CI' } } });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(await getOption('blogdescription'), 'Imported by CI');
    });

    it('the same account import from an interactive administrator session is accepted (control)', async () => {
        const res = await request(app).post(`${B}/import`).set('Authorization', session('owner'))
            .send({ importUsers: true, data: { version: '1.0', content: { users: [{ id: 902, username: 'migrated', email: 'migrated@example.com', role: 'author' }] } } });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.ok(await User.findByLogin('migrated'), 'the interactive import created the account');
    });
});

describe('the registration settings', () => {
    it('PUT /settings refuses the token opening registration as administrator; nothing is written, and an anonymous sign-up stays closed', async () => {
        await updateOption('users_can_register', '0');
        await updateOption('default_role', 'subscriber');
        const res = await request(app).put(`${B}/settings`).set('Authorization', asToken())
            .send({ blogname: 'Token save', users_can_register: '1', default_role: 'administrator' });
        assertTokenRefused(res, 'PUT /settings');
        assert.deepStrictEqual(res.body.data.params, ['users_can_register', 'default_role']);
        assert.strictEqual(String(await getOption('users_can_register')), '0');
        assert.strictEqual(await getOption('default_role'), 'subscriber');
        assert.notStrictEqual(await getOption('blogname'), 'Token save', 'refused as a whole: nothing was written');

        const signup = await request(anonymousApp).post(`${B}/auth/register`)
            .send({ username: 'walkin', email: 'walkin@evil.example', password: 'whatever-123' });
        assert.strictEqual(signup.status, 403, JSON.stringify(signup.body));
        assert.strictEqual(signup.body.code, 'rest_cannot_register');
        assert.strictEqual(await User.findByLogin('walkin'), null);
    });

    it('PUT /settings/:key refuses the token for each registration setting', async () => {
        for (const [key, value] of [['default_role', 'administrator'], ['users_can_register', '1'], ['require_email_verification', '1']] as const) {
            const before = await getOption(key);
            const res = await request(app).put(`${B}/settings/${key}`).set('Authorization', asToken()).send({ value });
            assertTokenRefused(res, `PUT /settings/${key}`);
            assert.deepStrictEqual(await getOption(key), before, `${key} was not written`);
        }
    });

    it('the token may still save the rest of the screen, registration values sent back unchanged (no over-block)', async () => {
        const res = await request(app).put(`${B}/settings`).set('Authorization', asToken())
            .send({ blogname: 'Saved by token', users_can_register: '0', default_role: 'subscriber' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(await getOption('blogname'), 'Saved by token');
    });

    it('an interactive administrator session may change them (control)', async () => {
        const res = await request(app).put(`${B}/settings/default_role`).set('Authorization', session('owner')).send({ value: 'contributor' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(await getOption('default_role'), 'contributor');
        await updateOption('default_role', 'subscriber');
    });
});

// MySQL/MariaDB compare option names case-insensitively, so `REQUIRE_EMAIL_VERIFICATION` IS the
// `require_email_verification` row there. The check compared names byte for byte and let such a spelling
// through to the importer, which writes whatever name the bundle carries. (SQLite keeps the two apart, so
// what this file can observe is the refusal and the absence of ANY write under either spelling.)
describe('registration settings under another spelling of their name', () => {
    const { changedRegistrationSettings } = require('../core/registration-settings');
    const rowsNamed = async (name: string) => (await dbAsync.all('SELECT option_name FROM options WHERE LOWER(option_name) = ?', [name])).map((r: any) => r.option_name);

    before(async () => {
        await updateOption('require_email_verification', '1');
        await updateOption('mail_delivery_ready', '1');
    });
    after(async () => {
        await updateOption('require_email_verification', '0');
        await updateOption('mail_delivery_ready', '0');
    });

    it('the check judges every spelling, under the canonical name', async () => {
        assert.deepStrictEqual(await changedRegistrationSettings({ REQUIRE_EMAIL_VERIFICATION: '0' }), ['require_email_verification']);
        assert.deepStrictEqual(await changedRegistrationSettings({ Mail_Delivery_Ready: '0' }), ['mail_delivery_ready']);
        assert.deepStrictEqual(await changedRegistrationSettings({ Default_Role: 'administrator', USERS_CAN_REGISTER: '1' }), ['users_can_register', 'default_role']);
        // Any one spelling may be the write that lands last: the current value under one name does not hide the other.
        assert.deepStrictEqual(await changedRegistrationSettings({ require_email_verification: '1', Require_Email_Verification: '0' }), ['require_email_verification']);
        // The current value under another spelling is no change.
        assert.deepStrictEqual(await changedRegistrationSettings({ REQUIRE_EMAIL_VERIFICATION: '1', MAIL_DELIVERY_READY: '1' }), []);
    });

    it('POST /import refuses the token for REQUIRE_EMAIL_VERIFICATION / MAIL_DELIVERY_READY; nothing is written under any spelling', async () => {
        for (const [key, canonical] of [['REQUIRE_EMAIL_VERIFICATION', 'require_email_verification'], ['Mail_Delivery_Ready', 'mail_delivery_ready']] as const) {
            const res = await request(app).post(`${B}/import`).set('Authorization', asToken())
                .send({ data: { version: '1.0', settings: { blogdescription: 'via a variant', [key]: '0' } } });
            assertTokenRefused(res, `POST /import ${key}`);
            assert.deepStrictEqual(res.body.data.params, [canonical]);
            assert.deepStrictEqual(await rowsNamed(canonical), [canonical], `only the real ${canonical} row exists`);
            assert.strictEqual(String(await getOption(canonical)), '1', `${canonical} is unchanged`);
            assert.notStrictEqual(await getOption('blogdescription'), 'via a variant', 'refused as a whole');
        }
    });

    it('PUT /settings never writes another spelling (its allowlist is exact), so it neither refuses nor writes it', async () => {
        const rowsBefore = await rowsNamed('require_email_verification');
        const res = await request(app).put(`${B}/settings`).set('Authorization', asToken())
            .send({ blogname: 'Variant save', REQUIRE_EMAIL_VERIFICATION: '0' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.ok(!('REQUIRE_EMAIL_VERIFICATION' in res.body), 'not written');
        assert.deepStrictEqual(await rowsNamed('require_email_verification'), rowsBefore, 'no row under any spelling');
        assert.strictEqual(String(await getOption('require_email_verification')), '1');
        const one = await request(app).put(`${B}/settings/REQUIRE_EMAIL_VERIFICATION`).set('Authorization', asToken()).send({ value: '0' });
        assert.strictEqual(one.status, 400, JSON.stringify(one.body));
        assert.strictEqual(String(await getOption('require_email_verification')), '1');
    });

    it('an interactive administrator\'s import of such a bundle is accepted (control)', async () => {
        const res = await request(app).post(`${B}/import`).set('Authorization', session('owner'))
            .send({ data: { version: '1.0', settings: { blogdescription: 'interactive variant', Mail_Delivery_Ready: '1' } } });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(await getOption('blogdescription'), 'interactive variant');
    });
});

describe('role definitions and the WordPress import', () => {
    it('POST /roles refuses the token: subscriber does not gain every capability, and no role is created', async () => {
        const before = JSON.stringify(roles.getRole('subscriber'));
        const widen = await request(app).post(`${B}/roles`).set('Authorization', asToken())
            .send({ slug: 'subscriber', name: 'Subscriber', capabilities: { '*': true } });
        assertTokenRefused(widen, 'POST /roles (redefine subscriber)');
        assert.strictEqual(JSON.stringify(roles.getRole('subscriber')), before);
        const mint = await request(app).post(`${B}/roles`).set('Authorization', asToken())
            .send({ slug: 'token-made', name: 'Token made', capabilities: { read: true } });
        assertTokenRefused(mint, 'POST /roles (new role)');
        assert.ok(!roles.getRole('token-made'), 'no role was created');
    });

    it('DELETE /roles/:slug refuses the token; the role survives', async () => {
        const made = await request(app).post(`${B}/roles`).set('Authorization', session('owner'))
            .send({ slug: 'keepme', name: 'Keep me', capabilities: { read: true } });
        assert.strictEqual(made.status, 201, JSON.stringify(made.body));
        const res = await request(app).delete(`${B}/roles/keepme`).set('Authorization', asToken());
        assertTokenRefused(res, 'DELETE /roles/:slug');
        assert.ok(roles.getRole('keepme'), 'the role is still there');
    });

    it('POST /import/wordpress refuses the token before the upload is read: no author account is created', async () => {
        const wxr = '<?xml version="1.0"?><rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/"><channel>'
            + '<wp:author><wp:author_login>wxrghost</wp:author_login><wp:author_email>wxrghost@evil.example</wp:author_email></wp:author>'
            + '</channel></rss>';
        const res = await request(app).post(`${B}/import/wordpress`).set('Authorization', asToken())
            .attach('file', Buffer.from(wxr), 'export.xml');
        assertTokenRefused(res, 'POST /import/wordpress');
        assert.strictEqual(await User.findByEmail('wxrghost@evil.example'), null);
    });
});
