/**
 * ACTIVE CORPORATE MAILBOX — the ANCHOR suite (host side).
 *
 * The mail surface is gated on "this account has a corporate mailbox". That used to be DERIVED from
 * the account's own email domain, which made it SELF-GRANTABLE: PUT /users/me is guarded by
 * `authenticate` alone and writes the primary email, and POST /auth/register does the same from an
 * UNAUTHENTICATED request when `users_can_register` is on. This suite pins the replacement:
 *
 *   1. the fact lives in `user_meta.professional_mailbox` and ONLY an `edit_users` caller can write it
 *      — through the dedicated field, through the generic meta bag, or through any self-edit door;
 *   2. no self-service route can put an account on the mail domain (the address is the mailbox);
 *   3. core's admin-menu visibility reads the SAME fact as the mail plugin's route gate;
 *   4. the upgrade migration derives the flag conservatively and reports what it did not grant.
 *
 * It drives the REAL routers over supertest against a throwaway temp DB (same config-repoint-first
 * pattern as api.test.ts / authz-idor.test.ts), so a regression in the route wiring — not just in the
 * helper — fails here.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-mailbox-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const SECRET = config.jwt.secret;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));

// The site is at https://www.acme.example but publishes its mail records on acme.example — the exact
// shape where "the site hostname" and "the mail domain" differ, so every assertion below also proves
// the host uses the mail domain and not the site host.
const SITE_HOST = 'www.acme.example';
const MAIL_DOMAIN = 'acme.example';

const U: Record<string, number> = {};
let dbAsync: any;

const tok = (id: number, login: string) => jwt.sign({ userId: id, username: login }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const anon = (m: string, p: string) => (request(app) as any)[m](`/api/v1${p}`);
const as = (persona: string, m: string, p: string) =>
    (request(app) as any)[m](`/api/v1${p}`).set('Authorization', `Bearer ${tok(U[persona], persona)}`);

async function seedUser(login: string, role: string, email: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, email, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
    return r.lastID;
}
const mailboxFlagOf = async (id: number) =>
    (await dbAsync.get('SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ?', [id, 'professional_mailbox']))?.meta_value ?? null;
const emailOf = async (id: number) =>
    (await dbAsync.get('SELECT user_email FROM users WHERE id = ?', [id]))?.user_email;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();

    const { updateOption } = require('../core/options');
    await updateOption('siteurl', `https://${SITE_HOST}`);
    await updateOption('home', `https://${SITE_HOST}`);
    // The operator's statement of which domain this server signs/sends/receives as.
    await updateOption('mail_domain', MAIL_DOMAIN);   // what the PLUGIN publishes — the key the host can actually read

    await roles.loadRoles();
    // A NON-administrator that holds edit_users — the only persona that can prove the flag gate is on
    // the CAPABILITY and not on the literal administrator role.
    await roles.setRole('usermgr', { name: 'User Manager', capabilities: ['read', 'access_admin_panel', 'edit_users'] });

    await seedUser('admin', 'administrator', 'boss@gmail.com');
    await seedUser('usermgr', 'usermgr', 'hr@gmail.com');
    await seedUser('pablo', 'subscriber', 'pablo@gmail.com');      // no mailbox, personal address
    await seedUser('mallory', 'subscriber', 'mallory@gmail.com');  // the attacker persona
    await seedUser('alice', 'editor', `alice@${MAIL_DOMAIN}`);     // on-domain address…
    // …and the GRANT, set the way an admin sets it.
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'professional_mailbox', '1')`, [U.alice]);
});

after(async () => {
    try { await database.close(); } catch { /* */ }
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

// =================================================================================================
describe('the corporate-mailbox grant is admin-owned', () => {

    test('PUT /users/me cannot move an account onto the mail domain (the self-grant hole)', async () => {
        const res = await as('mallory', 'put', '/users/me').send({ email: `ceo@${MAIL_DOMAIN}` });
        assert.equal(res.status, 403, 'a subscriber must not be able to claim a corporate address');
        assert.equal(res.body.code, 'rest_reserved_mail_domain');
        assert.equal(await emailOf(U.mallory), 'mallory@gmail.com', 'the address must be unchanged in the DB');

        // POSITIVE CONTROL: an ordinary, off-domain change still works, so the 403 above is the mail-domain
        // rule and not a broken route.
        const ok = await as('mallory', 'put', '/users/me').send({ email: 'mallory@outlook.com' });
        assert.equal(ok.status, 200, 'a normal self-service email change must still succeed');
        assert.equal(await emailOf(U.mallory), 'mallory@outlook.com');
    });

    test('PUT /users/me cannot set the grant itself, by field or by meta bag', async () => {
        const byField = await as('mallory', 'put', '/users/me').send({ professionalMailbox: true, displayName: 'M' });
        assert.equal(byField.status, 200, 'the rest of the profile save still works');
        assert.equal(await mailboxFlagOf(U.mallory), null, 'the self-service route must ignore the grant field entirely');

        // The generic meta path is the other door: User.update lists the key in PROTECTED_META.
        await require('../models/User').update(U.mallory, { meta: { professional_mailbox: '1' } });
        assert.equal(await mailboxFlagOf(U.mallory), null, 'the grant must never be reachable through data.meta');
    });

    test('PUT /users/:id: a self-edit cannot set the grant; an edit_users caller can', async () => {
        const self = await as('pablo', 'put', `/users/${U.pablo}`).send({ professionalMailbox: true });
        assert.equal(self.status, 403, 'editing your OWN record must not let you grant yourself a mailbox');
        assert.equal(self.body.code, 'rest_forbidden');
        assert.equal(await mailboxFlagOf(U.pablo), null);

        // A NON-administrator holding edit_users is the positive control: the gate is the capability.
        const granted = await as('usermgr', 'put', `/users/${U.pablo}`).send({ professionalMailbox: true });
        assert.equal(granted.status, 200);
        assert.equal(await mailboxFlagOf(U.pablo), '1');
        assert.equal(granted.body.professionalMailbox, true, 'the API must report the grant back to the form');

        const revoked = await as('usermgr', 'put', `/users/${U.pablo}`).send({ professionalMailbox: false });
        assert.equal(revoked.status, 200);
        assert.equal(await mailboxFlagOf(U.pablo), '0');
        assert.equal(revoked.body.professionalMailbox, false);
    });

    test('PUT /users/:id is the THIRD self-service door and refuses a corporate address too', async () => {
        // COVERAGE GAP, not a new rule: refuseSelfServiceEmailChange guards three routes, but only
        // PUT /users/me and POST /auth/register were pinned. Deleting the call in PUT /users/:id left the
        // whole suite green while a self-edit to <someone>@<mailDomain> returned 200 and stored it — the
        // same door as the /users/me hole that IS tested, one route along.
        const squat = await as('pablo', 'put', `/users/${U.pablo}`).send({ email: `ceo@${MAIL_DOMAIN}` });
        assert.equal(squat.status, 403, 'a self-edit must not claim an address on the mail domain');
        assert.equal(squat.body.code, 'rest_reserved_mail_domain');

        // The positive control: the capability is what decides, not the route.
        const byManager = await as('usermgr', 'put', `/users/${U.pablo}`).send({ email: `ceo@${MAIL_DOMAIN}` });
        assert.equal(byManager.status, 200, 'provisioning corporate addresses is exactly an edit_users job');
    });

    test('the grant actually REACHES the plugin — both projections carry it', async () => {
        // COVERAGE GAP. Every plugin is mandatorily isolated, so there are exactly two wires from the host
        // to the plugin's view of a user, and the mail gate/delivery read nothing else:
        //   core/plugin-api.ts projectUser  — what wordjs.users.* returns (inbound/internal DELIVERY)
        //   core/plugin-isolate.ts req.user — what the route gate reads
        // Deleting either line left the whole suite green: the gate suite hand-builds the projection
        // (`ALICE = { …, hasProfessionalMailbox: true }`), so it proves the plugin's behaviour GIVEN the
        // field and never that the host sends it — the exact "green suite over broken code" trap. Both
        // fail closed (webmail 403s, inbound diverts to the catch-all), so this is availability, not
        // escalation — but nothing was asserting it at all.
        const { hasProfessionalMailbox } = require('../core/mailbox');
        const User = require('../models/User');

        const granted = await User.findById(U.alice);   // alice holds the grant in this fixture
        const withoutGrant = await User.findById(U.pablo);

        // Wire 1 — the users bridge projection. Asserted unconditionally: a guarded assertion that can
        // silently not run is the same vacuous-pass problem this test exists to close.
        const { projectUser } = require('../core/plugin-api');
        assert.equal(typeof projectUser, 'function', 'projectUser must be reachable for this to mean anything');
        assert.equal(projectUser(granted).hasProfessionalMailbox, true,
            'the users bridge must carry the grant to the plugin');
        assert.equal(projectUser(withoutGrant).hasProfessionalMailbox, false, 'and must not invent one');

        // Wire 2 — the value the isolate stamps onto req.user, asserted through the SAME helper the
        // isolate calls, so a change to that helper cannot silently diverge from what the gate reads.
        assert.equal(hasProfessionalMailbox(granted), true, 'req.user.hasProfessionalMailbox is true for a holder');
        assert.equal(hasProfessionalMailbox(withoutGrant), false, 'and false for everyone else');
    });

    test('an unchanged professionalMailbox resend does not 403 an ordinary self-edit', async () => {
        // The admin user editor loads the flag into its form state and PUTs the whole object back, so a
        // "save my display name" from a non-edit_users user carries professionalMailbox unchanged.
        // Rejecting on PRESENCE 403'd every one of those legitimate saves; only a real CHANGE is a write.
        assert.equal(await mailboxFlagOf(U.pablo), '0', 'precondition: pablo currently has no mailbox');
        const save = await as('pablo', 'put', `/users/${U.pablo}`)
            .send({ displayName: 'Pablo Renamed', professionalMailbox: false });
        assert.equal(save.status, 200, 'an unchanged flag must not turn a profile save into a privileged write');
        assert.equal(await mailboxFlagOf(U.pablo), '0', 'and it still cannot change the grant');
    });

    test('a user WITH a mailbox cannot self-change their address (it IS the mailbox)', async () => {
        const moved = await as('alice', 'put', '/users/me').send({ email: 'alice@gmail.com' });
        assert.equal(moved.status, 403, 'moving your mailbox address off the domain orphans your mail');
        assert.equal(moved.body.code, 'rest_mailbox_address_locked');
        assert.equal(await emailOf(U.alice), `alice@${MAIL_DOMAIN}`);

        // …but RESENDING the unchanged address (which every profile form does on every save) is a no-op,
        // not a change — otherwise she could never update her display name again.
        const resend = await as('alice', 'put', '/users/me')
            .send({ email: `ALICE@${MAIL_DOMAIN}`, displayName: 'Alice A' });
        assert.equal(resend.status, 200, 'an unchanged (even differently-cased) address must not be treated as a change');
        assert.equal(resend.body.displayName, 'Alice A');
    });

    test('POST /auth/register cannot claim a corporate address, even with registration enabled', async () => {
        const { updateOption } = require('../core/options');
        await updateOption('users_can_register', '1');
        try {
            const res = await anon('post', '/auth/register')
                .send({ username: 'intruder', email: `ceo@${MAIL_DOMAIN}`, password: 'correct-horse-1' });
            assert.equal(res.status, 403, 'an ANONYMOUS caller must not be able to register a corporate address');
            assert.equal(res.body.code, 'rest_reserved_mail_domain');
            assert.equal(await dbAsync.get('SELECT id FROM users WHERE user_login = ?', ['intruder']), undefined,
                'no account may be created by the refused registration');

            // POSITIVE CONTROL: registration itself still works off-domain.
            const ok = await anon('post', '/auth/register')
                .send({ username: 'newbie', email: 'newbie@gmail.com', password: 'correct-horse-1' });
            assert.equal(ok.status, 201, 'ordinary self-registration must still succeed');
            assert.equal(ok.body.user.professionalMailbox, false, 'a self-registered account never has a mailbox');
        } finally {
            await updateOption('users_can_register', '0');
        }
    });

    test('POST /users validates the PRIMARY email shape (no ambiguous double-@ address)', async () => {
        // `a@gmail.com@acme.example` is the address whose domain two readers disagree about — the host
        // used to take the FIRST '@' and the plugin the LAST. create() rejects it outright now.
        const bad = await as('admin', 'post', '/users')
            .send({ username: 'weird', email: `a@gmail.com@${MAIL_DOMAIN}`, password: 'correct-horse-1' });
        assert.equal(bad.status, 400, 'an invalid primary email must not be stored');
        assert.equal(bad.body.code, 'rest_invalid_param');
        assert.equal(await dbAsync.get('SELECT id FROM users WHERE user_login = ?', ['weird']), undefined);

        // …and the MODEL refuses it too, so the importers and self-registration are covered by the same
        // rule rather than by this one route's validator.
        await assert.rejects(
            () => require('../models/User').create({ username: 'weird2', email: 'nope', password: 'correct-horse-1' }),
            /Invalid email format/);

        // POSITIVE CONTROL: an admin creating a real corporate mailbox works, grant and all.
        const ok = await as('admin', 'post', '/users')
            .send({ username: 'bob', email: `bob@${MAIL_DOMAIN}`, password: 'correct-horse-1', professionalMailbox: true });
        assert.equal(ok.status, 201);
        assert.equal(ok.body.professionalMailbox, true);
        assert.equal(await mailboxFlagOf(ok.body.id), '1');
    });

    test('core admin-menu visibility reads the GRANT, not the address', async () => {
        const { registerAdminMenu, unregisterAdminMenu } = require('../core/adminMenu');
        registerAdminMenu('core', {
            href: '/admin/plugin/emails-test', label: 'Webmail', cap: 'read', requiresProfessionalMailbox: true
        });
        try {
            const hrefs = async (persona: string) =>
                (await as(persona, 'get', '/plugins/menus')).body.map((m: any) => m.href);

            assert.ok((await hrefs('alice')).includes('/admin/plugin/emails-test'),
                'a granted user sees the item');
            assert.ok(!(await hrefs('pablo')).includes('/admin/plugin/emails-test'),
                'a user without the grant does not');
            assert.ok((await hrefs('admin')).includes('/admin/plugin/emails-test'),
                'administrators always keep it (they own the catch-all inbox)');

            // THE REGRESSION THIS EXISTS FOR: an on-domain address with NO grant must NOT reveal the item.
            await dbAsync.run('UPDATE users SET user_email = ? WHERE id = ?', [`sneaky@${MAIL_DOMAIN}`, U.mallory]);
            assert.ok(!(await hrefs('mallory')).includes('/admin/plugin/emails-test'),
                'an on-domain address alone must never confer visibility');
        } finally {
            unregisterAdminMenu('core');
            await dbAsync.run('UPDATE users SET user_email = ? WHERE id = ?', ['mallory@outlook.com', U.mallory]);
        }
    });
});

// =================================================================================================
describe('upgrade migration 0006 (derive the flag for existing installs)', () => {

    test('grants only to accounts the old hole could not have helped, and reports the rest', async () => {
        const { MIGRATIONS } = require('../core/schema-migrations');
        const mig = MIGRATIONS.find((m: any) => m.id === '0006_professional_mailbox_flag');
        assert.ok(mig, 'migration 0006 must exist');

        // A throwaway in-memory stand-in for the DB the migration sees: options + users + user_meta.
        const Database = require('better-sqlite3');
        const raw = new Database(':memory:');
        raw.exec(`CREATE TABLE options (option_name TEXT, option_value TEXT, autoload TEXT);
                  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT);
                  CREATE TABLE user_meta (user_id INTEGER, meta_key TEXT, meta_value TEXT);`);
        const ctx = {
            isPostgres: false,
            exec: async (sql: string) => raw.exec(sql),
            run: async (sql: string, p: any[] = []) => raw.prepare(sql).run(...p),
            get: async (sql: string, p: any[] = []) => raw.prepare(sql).get(...p),
            all: async (sql: string, p: any[] = []) => raw.prepare(sql).all(...p),
        };
        const opt = (n: string, v: string) => raw.prepare('INSERT INTO options VALUES (?,?,?)').run(n, v, 'yes');
        opt('siteurl', `https://${SITE_HOST}`);
        opt('mail_domain', MAIL_DOMAIN);                        // the www-vs-apex shape, set the way production does
        opt('wordjs_user_roles', JSON.stringify({
            editor: { name: 'Editor', capabilities: ['edit_posts'] },
            subscriber: { name: 'Subscriber', capabilities: ['read'] },
            hr: { name: 'HR', capabilities: ['read', 'edit_users'] }
        }));
        const user = (email: string, role: string | null) => {
            const id = Number(raw.prepare('INSERT INTO users (user_email) VALUES (?)').run(email).lastInsertRowid);
            if (role) raw.prepare('INSERT INTO user_meta VALUES (?,?,?)').run(id, 'role', role);
            return id;
        };
        const boss = user(`boss@${MAIL_DOMAIN}`, 'administrator');   // privileged → granted
        const hr = user(`hr@${MAIL_DOMAIN}`, 'hr');                  // edit_users → granted
        const editor = user(`alice@${MAIL_DOMAIN}`, 'editor');       // legit, but not privileged → pending
        const sneak = user(`ceo@${MAIL_DOMAIN}`, 'subscriber');      // the self-assigner → pending
        const outside = user('someone@gmail.com', 'editor');         // off-domain → untouched
        const wwwUser = user(`x@${SITE_HOST}`, 'editor');            // on the SITE host, not the MAIL domain

        await mig.up(ctx);

        const flag = (id: number) =>
            (raw.prepare('SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ?').get(id, 'professional_mailbox') as any)?.meta_value ?? null;
        assert.equal(flag(boss), '1', 'an administrator on the mail domain keeps their mailbox');
        assert.equal(flag(hr), '1', 'so does an edit_users delegate — the hole conferred them nothing');
        assert.equal(flag(editor), null, 'a non-privileged on-domain account is NOT auto-granted (it may have been self-assigned)');
        assert.equal(flag(sneak), null, 'the self-assigner is definitively not granted');
        assert.equal(flag(outside), null, 'an off-domain account is untouched');
        assert.equal(flag(wwwUser), null, 'the SITE host is not the MAIL domain — no grant from it');

        // The operator gets an exact worklist of who must be re-enabled by hand.
        const pending = JSON.parse((raw.prepare('SELECT option_value FROM options WHERE option_name = ?')
            .get('professional_mailbox_migration_pending') as any).option_value);
        assert.deepEqual(pending.sort(), [`alice@${MAIL_DOMAIN} (editor)`, `ceo@${MAIL_DOMAIN} (subscriber)`].sort());

        // Re-running must never overwrite a decision an admin has since made.
        raw.prepare('UPDATE user_meta SET meta_value = ? WHERE user_id = ? AND meta_key = ?').run('0', boss, 'professional_mailbox');
        await mig.up(ctx);
        assert.equal(flag(boss), '0', 'a later admin revocation survives a re-run');
        raw.close();
    });
});
