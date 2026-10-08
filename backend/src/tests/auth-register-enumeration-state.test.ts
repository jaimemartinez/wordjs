/**
 * POST /auth/register WITH EMAIL VERIFICATION ON MUST LEAVE THE SAME STATE FOR A TAKEN ADDRESS AS FOR A
 * FREE ONE — not only answer the same 201.
 *
 * Found by a review of the enumeration fix. The two 201 bodies were identical, but a free address got an
 * unverified account named after the submitted username and a taken address got nothing, so ONE more
 * anonymous request told them apart:
 *   · POST /auth/login {probe, its password} → 403 rest_email_unverified (free) vs 401 (taken);
 *   · POST /auth/register {probe, throwaway address} → 400 username taken (free) vs 201 (taken).
 * And a non-string password split the answer by itself: `{"password": true}` passed the length checks,
 * a taken address answered the 201 before anything was hashed, a free one reached bcrypt → 500.
 *
 * Now a registration creates nothing until its emailed link is followed (core/pending-registrations), a
 * non-string field is a 400 before anything is looked up, and a failure after the identity checks is
 * answered with the same 201.
 *
 * Drives the REAL auth router, the REAL User model and the REAL options table on a throwaway SQLite file.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-register-state-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');

let request: any;
let app: any;
let User: any;
let sent: any[] = [];

const VICTIM = { username: 'victim', email: 'victim@gmail.com', password: 'VictimPass123' };
const PASSWORD = 'whatever123';
const LINK_RE = /\/verify-email\?token=([a-f0-9]{64})/;

const register = (body: any) => request(app).post('/api/v1/auth/register').send(body);
const login = (username: string, password = PASSWORD) => request(app).post('/api/v1/auth/login').send({ username, password });
/** What a caller can see of an answer: status, code and body (never the timing). */
const view = (res: any) => ({ status: res.status, body: res.body });

describe('register with verification on: the same answer AND the same state for any address', () => {
    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        const { updateOption } = require('../core/options');
        await updateOption('users_can_register', '1');
        (global as any).wordjs_send_mail = (m: any) => { sent.push(m); return { queued: true }; };
        await updateOption('mail_delivery_ready', '1');
        await updateOption('require_email_verification', '1');

        User = require('../models/User');
        await User.create({ ...VICTIM, role: 'subscriber' });

        const express = require('express');
        const cookieParser = require('cookie-parser');
        app = express();
        app.use(express.json());
        app.use(cookieParser());
        app.use('/api/v1/auth', require('../routes/auth'));
    });

    beforeEach(() => { sent = []; });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { delete (global as any).wordjs_send_mail; } catch { /* ignore */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* ignore */ }
        }
    });

    it('a follow-up LOGIN as the probe username answers the same for a taken and a free address', async () => {
        const taken = await register({ username: 'probetaken1', email: VICTIM.email, password: PASSWORD });
        const fresh = await register({ username: 'probefresh1', email: 'nobody-here-1@gmail.com', password: PASSWORD });
        assert.deepStrictEqual(view(taken), view(fresh), 'precondition: the two registrations answer alike');
        assert.strictEqual(fresh.status, 201);

        const afterTaken = await login('probetaken1');
        const afterFresh = await login('probefresh1');
        assert.deepStrictEqual(view(afterFresh), view(afterTaken),
            'logging in as the probe told whether the address already had an account');
        assert.strictEqual(afterFresh.status, 401);
        assert.strictEqual(afterFresh.body.code, 'rest_invalid_credentials');
    });

    it('a follow-up REGISTRATION of the probe username answers the same for a taken and a free address', async () => {
        await register({ username: 'probetaken2', email: VICTIM.email, password: PASSWORD });
        await register({ username: 'probefresh2', email: 'nobody-here-2@gmail.com', password: PASSWORD });

        const reuseTaken = await register({ username: 'probetaken2', email: 'throwaway-a@attacker.example', password: PASSWORD });
        const reuseFresh = await register({ username: 'probefresh2', email: 'throwaway-b@attacker.example', password: PASSWORD });
        assert.deepStrictEqual(view(reuseFresh), view(reuseTaken),
            're-registering the probe username told whether the address already had an account');
        assert.strictEqual(reuseFresh.status, 201, 'a pending registration takes no username');
    });

    it('no account and no username exist for either probe until a link is followed', async () => {
        for (const login of ['probetaken1', 'probefresh1', 'probetaken2', 'probefresh2']) {
            assert.strictEqual(await User.findByLogin(login), null, `${login} exists before any link was followed`);
            assert.strictEqual(await User.identifierInUse(login), false);
        }
    });

    it('a NON-STRING password (or display name) answers the same 400 for a taken and a free address', async () => {
        const shapes: any[] = [true, 12345678, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], { length: 9 }];
        for (const password of shapes) {
            const taken = await register({ username: 'probeshape1', email: VICTIM.email, password });
            const fresh = await register({ username: 'probeshape2', email: 'nobody-shape@gmail.com', password });
            assert.deepStrictEqual(view(fresh), view(taken), `password=${JSON.stringify(password)} split the answer`);
            assert.strictEqual(fresh.status, 400, `password=${JSON.stringify(password)} → ${fresh.status}`);
            assert.strictEqual(fresh.body.code, 'rest_invalid_param');
        }
        const takenName = await register({ username: 'probeshape1', email: VICTIM.email, password: PASSWORD, displayName: { x: 1 } });
        const freshName = await register({ username: 'probeshape2', email: 'nobody-shape@gmail.com', password: PASSWORD, displayName: ['x'] });
        assert.strictEqual(takenName.status, 400);
        assert.deepStrictEqual(view(freshName), view(takenName));
        assert.strictEqual(sent.length, 0, 'nothing is mailed for a refused shape');
    });

    it('a NON-STRING displayName of every JSON shape (the reported `true`) answers one 400, with verification on AND off', async () => {
        // The reported probe: `displayName: true` reached User.create raw, failed only at the SQL bind on
        // the fresh path (500, nothing created, the username still free) while a taken address answered the
        // anti-enumeration 201 — a free, repeatable yes/no on any address. Every non-string shape is now
        // the same 400 before anything is looked up, whichever way verification is set.
        const { updateOption } = require('../core/options');
        const shapes: any[] = [true, false, 0, 12345, { a: 1 }, ['x'], [], {}];
        try {
            for (const verification of ['1', '0']) {
                await updateOption('require_email_verification', verification);
                for (const displayName of shapes) {
                    const taken = await register({ username: 'dnprobe1', email: VICTIM.email, password: PASSWORD, displayName });
                    const fresh = await register({ username: 'dnprobe2', email: 'nobody-dn@gmail.com', password: PASSWORD, displayName });
                    const label = `verification=${verification} displayName=${JSON.stringify(displayName)}`;
                    assert.deepStrictEqual(view(fresh), view(taken), `${label} split the answer`);
                    assert.strictEqual(fresh.status, 400, `${label} → ${fresh.status} ${JSON.stringify(fresh.body)}`);
                    assert.strictEqual(fresh.body.code, 'rest_invalid_param');
                }
                for (const login of ['dnprobe1', 'dnprobe2']) {
                    assert.strictEqual(await User.findByLogin(login), null, `${login} was created`);
                }
            }
            assert.strictEqual(sent.length, 0, 'nothing is mailed for a refused shape');
            // Control: a STRING display name is accepted (verification off creates the account at once).
            const ok = await register({ username: 'dnprobe3', email: 'dn-ok@gmail.com', password: PASSWORD, displayName: 'Dee Enn' });
            assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
            assert.strictEqual((await User.findByLogin('dnprobe3')).displayName, 'Dee Enn');
        } finally {
            await updateOption('require_email_verification', '1');
        }
    });

    it('a failure past the identity checks is answered with the same 201 as a taken address', async () => {
        // Storing the pending registration fails (database trouble): the fresh path must not answer
        // differently from the taken path, which stores nothing.
        const options = require('../core/options');
        const realAdd = options.addOption;
        options.addOption = async () => { throw new Error('simulated storage failure'); };
        try {
            const taken = await register({ username: 'probefail1', email: VICTIM.email, password: PASSWORD });
            const fresh = await register({ username: 'probefail2', email: 'nobody-fail@gmail.com', password: PASSWORD });
            assert.deepStrictEqual(view(fresh), view(taken), 'a storage failure on the fresh path split the answer');
            assert.strictEqual(fresh.status, 201);
        } finally {
            options.addOption = realAdd;
        }
    });

    it('the link creates the account; a second link for the same username is answered "no longer available"', async () => {
        const first = await register({ username: 'samename', email: 'first-owner@gmail.com', password: PASSWORD });
        const second = await register({ username: 'samename', email: 'second-owner@gmail.com', password: 'otherpass123' });
        assert.strictEqual(first.status, 201);
        assert.strictEqual(second.status, 201);
        const tokenFor = (to: string) => {
            const m = sent.find((x) => x.to === to);
            const hit = m && String(m.text).match(LINK_RE);
            assert.ok(hit, `no verification link was mailed to ${to}`);
            return (hit as RegExpMatchArray)[1];
        };
        const t1 = tokenFor('first-owner@gmail.com');
        const t2 = tokenFor('second-owner@gmail.com');

        const ok = await request(app).post('/api/v1/auth/verify-email').send({ token: t2 });
        assert.strictEqual(ok.status, 200);
        const lost = await request(app).post('/api/v1/auth/verify-email').send({ token: t1 });
        assert.strictEqual(lost.status, 409);
        assert.strictEqual(lost.body.code, 'rest_registration_unavailable');

        const account = await User.findByLogin('samename');
        assert.strictEqual(account.userEmail, 'second-owner@gmail.com', 'the confirmed registration owns the name');
        assert.strictEqual((await login('samename', 'otherpass123')).status, 200);
        assert.strictEqual((await login('samename', PASSWORD)).status, 401, 'the other registration\'s password does not sign in');
        // The losing link is used up.
        assert.strictEqual((await request(app).post('/api/v1/auth/verify-email').send({ token: t1 })).status, 400);
    });

    it('the waiting registration is stored hashed, out of every plugin\'s reach, and expires', async () => {
        const reg = await register({ username: 'stored1', email: 'stored-1@gmail.com', password: PASSWORD });
        assert.strictEqual(reg.status, 201);
        const raw = (String(sent[0].text).match(LINK_RE) as RegExpMatchArray)[1];

        const { pendingRegistrationOptionName, prunePendingRegistrations } = require('../core/pending-registrations');
        const name = pendingRegistrationOptionName(raw);
        const { dbAsync } = require('../config/database');
        const row = await dbAsync.get('SELECT option_value, autoload FROM options WHERE option_name = ?', [name]);
        assert.ok(row, 'the registration is kept under the hash of its token');
        assert.strictEqual(row.autoload, 'no');
        assert.ok(!String(row.option_value).includes(raw), 'the raw token is never stored');
        assert.ok(!String(row.option_value).includes(PASSWORD), 'the password is never stored');
        assert.ok(!name.includes(raw), 'the option name carries the hash, not the token');

        const { isProtectedOption } = require('../core/plugin-api');
        assert.strictEqual(isProtectedOption(name), true, 'the options bridge must refuse the row');

        // Expired: the link no longer works and the row is pruned.
        const rec = JSON.parse(String(row.option_value));
        rec.expires = Date.now() - 1000;
        await dbAsync.run('UPDATE options SET option_value = ? WHERE option_name = ?', [JSON.stringify(rec), name]);
        await require('../core/cache').del(`option:${name}`);
        assert.strictEqual(await prunePendingRegistrations(), 1);
        const expired = await request(app).post('/api/v1/auth/verify-email').send({ token: raw });
        assert.strictEqual(expired.status, 400);
        assert.strictEqual(await User.findByLogin('stored1'), null);
    });
});
