/**
 * PLUGIN-DECLARED ACCOUNT CAPABILITIES — the ANCHOR suite (host side).
 *
 * A per-account grant ("this editor gets a mailbox") used to be a concept baked into the core: user_meta
 * `professional_mailbox`, `hasProfessionalMailbox` on every plugin projection, `requiresProfessionalMailbox`
 * on menu items, a hardcoded checkbox in the user screen. It is now generic (core/account-capabilities.ts):
 * a plugin declares the capability in its manifest, only an `edit_users` caller can grant it per account,
 * the core stores and enforces it without knowing what it means, and only the declaring plugin is told.
 * This suite pins:
 *
 *   1. the grant is admin-owned — never self-assignable through any door, never derived from the email;
 *   2. the user screen's source (GET /users/account-capabilities) lists ACTIVE plugins' declarations only;
 *   3. a plugin is told its OWN grants, on both wires (users bridge + route req.user), and nothing else;
 *   4. the generic effects: `locksEmail`, and a menu item's `requiresAccountCapability`;
 *   5. the reserved site email domain (core/email-address) on the three self-service doors;
 *   6. the upgrade: legacy `professional_mailbox` values move with no loss and no widening, mixed-version
 *      writes stay consistent, and an outdated mail plugin keeps working (core/legacy-account-flags.ts);
 *   7. the bundled mail plugin really declares its mailbox through the seam.
 *
 * It drives the REAL routers over supertest against a throwaway temp DB, with a probe plugin folder on
 * disk, so a regression in the route wiring — not just in a helper — fails here.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const PASSWORD = 'Correct-Horse-9!';

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-acctcap-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const pluginsCore = require('../core/plugins');
const accountCaps = require('../core/account-capabilities');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const SECRET = config.jwt.secret;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));

// The site is at https://www.acme.example but its mail lives on acme.example (the published mail domain).
const SITE_HOST = 'www.acme.example';
const MAIL_DOMAIN = 'acme.example';

// The probe plugin: declares one locking capability (on by default for new accounts) and one plain one.
const PROBE = 'acct-probe';
const BADGE = 'acct_probe_badge';
const PLAIN = 'acct_probe_plain';
// An installed but INACTIVE plugin with a declaration of its own.
const IDLE = 'acct-idle';
const IDLE_CAP = 'acct_idle_flag';
// A plugin whose manifest names ANOTHER plugin's capability (hand-edited, never through the installer).
const ROGUE = 'acct-rogue';
// The mail plugin's legacy capability — a stand-in folder carrying the REAL marketplace manifest.
const MAIL = 'mail-server';
const MAILBOX = 'mail_server_mailbox';
const REAL_MAIL_MANIFEST = path.resolve(__dirname, '../../../marketplace/plugins/mail-server/manifest.json');

const U: Record<string, number> = {};
let dbAsync: any;
const createdDirs: string[] = [];

const tok = (id: number, login: string) => jwt.sign({ userId: id, username: login }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const anon = (m: string, p: string) => (request(app) as any)[m](`/api/v1${p}`);
const as = (persona: string, m: string, p: string) =>
    (request(app) as any)[m](`/api/v1${p}`).set('Authorization', `Bearer ${tok(U[persona], persona)}`);

async function seedUser(login: string, role: string, email: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        [login, bcrypt.hashSync(PASSWORD, 10), email, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
    return r.lastID;
}
const metaValue = async (id: number, key: string) =>
    (await dbAsync.get('SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ?', [id, key]))?.meta_value ?? null;
const grantOf = (id: number, slug: string) => metaValue(id, `account_capability:${slug}`);
const emailOf = async (id: number) =>
    (await dbAsync.get('SELECT user_email FROM users WHERE id = ?', [id]))?.user_email;
const freshUser = async (id: number) => {
    await require('../core/cache').del(`user:${id}`);
    return require('../models/User').findById(id);
};

function writePlugin(id: string, manifest: any) {
    const dir = path.join(pluginsCore.PLUGINS_DIR, id);
    assert.ok(!fs.existsSync(dir) || createdDirs.includes(dir), `refusing to overwrite a real plugin folder: ${dir}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    if (!createdDirs.includes(dir)) createdDirs.push(dir);
    accountCaps.invalidateDeclarations();
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();

    const { updateOption } = require('../core/options');
    await updateOption('siteurl', `https://${SITE_HOST}`);
    await updateOption('home', `https://${SITE_HOST}`);
    await updateOption('mail_domain', MAIL_DOMAIN);   // what a mail plugin publishes

    writePlugin(PROBE, {
        id: PROBE, name: 'Account probe', version: '1.0.0', isolated: true,
        accountCapabilities: [
            { slug: BADGE, name: 'Probe badge', description: 'Binds the address.', locksEmail: true, defaultForNewAccounts: true },
            { slug: PLAIN, name: 'Probe plain' },
        ],
    });
    writePlugin(IDLE, { id: IDLE, name: 'Idle', version: '1.0.0', isolated: true, accountCapabilities: [{ slug: IDLE_CAP, name: 'Idle flag' }] });
    writePlugin(ROGUE, { id: ROGUE, name: 'Rogue', version: '1.0.0', isolated: true, accountCapabilities: [{ slug: BADGE, name: 'Not mine' }] });
    await updateOption('active_plugins', [PROBE, ROGUE]);

    await roles.loadRoles();
    // A NON-administrator that holds edit_users — proves the gate is the CAPABILITY, not the admin role.
    await roles.setRole('usermgr', { name: 'User Manager', capabilities: ['read', 'access_admin_panel', 'edit_users'] });

    await seedUser('admin', 'administrator', 'boss@gmail.com');
    await seedUser('usermgr', 'usermgr', 'hr@gmail.com');
    await seedUser('pablo', 'subscriber', 'pablo@gmail.com');
    await seedUser('mallory', 'subscriber', 'mallory@gmail.com');
    await seedUser('alice', 'editor', `alice@${MAIL_DOMAIN}`);
    // Alice holds the locking badge, set the way the admin API sets it.
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, '1')`, [U.alice, `account_capability:${BADGE}`]);
});

after(async () => {
    for (const dir of createdDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
    accountCaps.invalidateDeclarations();
    try { await database.close(); } catch { /* */ }
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

// =================================================================================================
describe('declarations: what the user screen renders', () => {

    test('GET /users/account-capabilities lists the ACTIVE plugins\' valid declarations, for edit_users only', async () => {
        const res = await as('usermgr', 'get', '/users/account-capabilities');
        assert.equal(res.status, 200);
        const slugs = res.body.map((d: any) => d.slug).sort();
        assert.deepEqual(slugs, [BADGE, PLAIN].sort(),
            'the probe\'s two declarations; NOT the inactive plugin\'s, and NOT the rogue one naming another plugin\'s capability');
        const badge = res.body.find((d: any) => d.slug === BADGE);
        assert.deepEqual(badge, { slug: BADGE, plugin: PROBE, name: 'Probe badge', description: 'Binds the address.', locksEmail: true, defaultForNewAccounts: true });

        const denied = await as('pablo', 'get', '/users/account-capabilities');
        assert.equal(denied.status, 403, 'a caller who cannot grant them is not given the list');
    });

    test('the manifest validator enforces the plugin\'s own namespace (upload and activation refuse the rest)', () => {
        const v = accountCaps.validateManifestAccountCapabilities;
        assert.deepEqual(v(PROBE, { accountCapabilities: [{ slug: BADGE, name: 'ok' }] }), []);
        assert.ok(v(PROBE, { accountCapabilities: [{ slug: 'mail_server_mailbox', name: 'x' }] }).length, 'another plugin\'s namespace');
        assert.ok(v(PROBE, { accountCapabilities: [{ slug: 'edit_users', name: 'x' }] }).length, 'a core capability');
        assert.ok(v(PROBE, { accountCapabilities: [{ slug: BADGE, name: 'x', grantsCore: true }] }).length, 'an unknown key');
        assert.ok(v(PROBE, { accountCapabilities: [{ slug: BADGE }] }).length, 'a missing name');
        assert.ok(v(PROBE, { accountCapabilities: 'nope' }).length, 'not an array');
    });
});

// =================================================================================================
describe('the grant is admin-owned', () => {

    test('PUT /users/me ignores the grant field, and the generic meta bag cannot reach it', async () => {
        const byField = await as('mallory', 'put', '/users/me').send({ accountCapabilities: { [BADGE]: true }, displayName: 'M' });
        assert.equal(byField.status, 200, 'the rest of the profile save still works');
        assert.equal(await grantOf(U.mallory, BADGE), null, 'the self-service route must ignore the grant field entirely');

        await require('../models/User').update(U.mallory, { meta: { [`account_capability:${BADGE}`]: '1', professional_mailbox: '1' } });
        assert.equal(await grantOf(U.mallory, BADGE), null, 'the grant must never be reachable through data.meta');
        assert.equal(await metaValue(U.mallory, 'professional_mailbox'), null, 'nor the legacy key it was migrated from');
    });

    test('PUT /users/:id: a self-edit cannot grant; an edit_users caller grants and revokes', async () => {
        const self = await as('pablo', 'put', `/users/${U.pablo}`).send({ accountCapabilities: { [PLAIN]: true } });
        assert.equal(self.status, 403, 'editing your OWN record must not let you grant yourself a capability');
        assert.equal(self.body.code, 'rest_forbidden');
        assert.equal(await grantOf(U.pablo, PLAIN), null);

        const granted = await as('usermgr', 'put', `/users/${U.pablo}`).send({ accountCapabilities: { [PLAIN]: true } });
        assert.equal(granted.status, 200);
        assert.equal(await grantOf(U.pablo, PLAIN), '1');
        assert.deepEqual(granted.body.accountCapabilities, [PLAIN], 'the API reports the grant back to the form');

        const revoked = await as('usermgr', 'put', `/users/${U.pablo}`).send({ accountCapabilities: { [PLAIN]: false } });
        assert.equal(revoked.status, 200);
        assert.equal(await grantOf(U.pablo, PLAIN), '0');
        assert.deepEqual(revoked.body.accountCapabilities, []);
    });

    test('an unchanged resend is not a write — even of an inactive plugin\'s grant', async () => {
        // pablo: PLAIN off now. The form PUTs the whole state back on "save my display name".
        const save = await as('pablo', 'put', `/users/${U.pablo}`)
            .send({ displayName: 'Pablo Renamed', accountCapabilities: { [PLAIN]: false, [IDLE_CAP]: false } });
        assert.equal(save.status, 200, 'an unchanged map must not turn a profile save into a privileged write');
        assert.equal(await grantOf(U.pablo, PLAIN), '0');
    });

    test('a CHANGE naming a capability no active plugin declares is refused, and nothing is stored', async () => {
        const idle = await as('usermgr', 'put', `/users/${U.pablo}`).send({ accountCapabilities: { [IDLE_CAP]: true } });
        assert.equal(idle.status, 400, 'an inactive plugin\'s capability cannot be granted while it is off');
        assert.equal(idle.body.code, 'rest_invalid_param');
        const junk = await as('usermgr', 'put', `/users/${U.pablo}`).send({ accountCapabilities: { made_up: true } });
        assert.equal(junk.status, 400);
        const shape = await as('usermgr', 'put', `/users/${U.pablo}`).send({ accountCapabilities: [PLAIN] });
        assert.equal(shape.status, 400, 'the field is a map, not a list');
        assert.equal(await grantOf(U.pablo, IDLE_CAP), null);
        assert.equal(await grantOf(U.pablo, 'made_up'), null);
    });

    test('POST /users applies the grants an admin sends; self-registration never carries one', async () => {
        const ok = await as('admin', 'post', '/users')
            .send({ username: 'bob', email: `bob@${MAIL_DOMAIN}`, password: 'correct-horse-1', accountCapabilities: { [BADGE]: true, [PLAIN]: false } });
        assert.equal(ok.status, 201);
        assert.deepEqual(ok.body.accountCapabilities, [BADGE]);
        assert.equal(await grantOf(ok.body.id, BADGE), '1');

        const { updateOption } = require('../core/options');
        await updateOption('users_can_register', '1');
        try {
            const reg = await anon('post', '/auth/register')
                .send({ username: 'newbie', email: 'newbie@gmail.com', password: 'correct-horse-1', accountCapabilities: { [BADGE]: true } });
            assert.equal(reg.status, 201, 'ordinary self-registration still succeeds');
            assert.deepEqual(reg.body.user.accountCapabilities, [], 'a self-registered account never holds a grant');
        } finally {
            await updateOption('users_can_register', '0');
        }
    });

    test('an ADMINISTRATOR holds no account capability implicitly — the grant is always explicit', async () => {
        const admin = await freshUser(U.admin);
        assert.deepEqual(accountCaps.grantedAccountCapabilities(admin), []);
        assert.deepEqual(require('../core/plugin-isolate').projectRouteUser(admin, PROBE).accountCapabilities, []);
    });
});

// =================================================================================================
describe('a plugin is told its OWN grants, on both wires', () => {

    test('users bridge (projectUserFor) and route req.user (projectRouteUser) carry them; other plugins see none', async () => {
        const { projectUserFor } = require('../core/plugin-api');
        const { projectRouteUser } = require('../core/plugin-isolate');
        const alice = await freshUser(U.alice);
        const pablo = await freshUser(U.pablo);

        assert.deepEqual(projectUserFor(alice, PROBE).accountCapabilities, [BADGE], 'wire 1 carries the grant');
        assert.deepEqual(projectRouteUser(alice, PROBE).accountCapabilities, [BADGE], 'wire 2 carries the grant');
        assert.deepEqual(projectUserFor(pablo, PROBE).accountCapabilities, [], 'and invents none');
        assert.deepEqual(projectUserFor(alice, IDLE).accountCapabilities, [], 'another plugin is never told');
        assert.deepEqual(projectRouteUser(alice, ROGUE).accountCapabilities, [], 'not even one that names the capability');
        assert.equal('hasProfessionalMailbox' in projectRouteUser(alice, PROBE), false,
            'the legacy mail field is not handed to plugins outside the mail namespace');
    });

    test('NEVER derived from the email address: an on-domain address with no grant holds nothing', async () => {
        await dbAsync.run('UPDATE users SET user_email = ? WHERE id = ?', [`sneaky@${MAIL_DOMAIN}`, U.mallory]);
        try {
            const mallory = await freshUser(U.mallory);
            assert.deepEqual(projectRouteUser(mallory), [], 'no grant');
        } finally {
            await dbAsync.run('UPDATE users SET user_email = ? WHERE id = ?', ['mallory@gmail.com', U.mallory]);
        }
        function projectRouteUser(u: any) { return require('../core/plugin-isolate').projectRouteUser(u, PROBE).accountCapabilities; }
    });
});

// =================================================================================================
describe('the generic effects', () => {

    test('locksEmail: a holder of a locking capability cannot move their own address; a resend is fine', async () => {
        const moved = await as('alice', 'put', '/users/me').send({ email: 'alice@gmail.com', currentPassword: PASSWORD });
        assert.equal(moved.status, 403, 'the grant binds the address');
        assert.equal(moved.body.code, 'rest_mailbox_address_locked');
        assert.equal(await emailOf(U.alice), `alice@${MAIL_DOMAIN}`);

        const resend = await as('alice', 'put', '/users/me').send({ email: `ALICE@${MAIL_DOMAIN}`, displayName: 'Alice A' });
        assert.equal(resend.status, 200, 'an unchanged (even differently-cased) address is not a change');

        // A NON-locking capability binds nothing: pablo holding PLAIN may move his address.
        await as('usermgr', 'put', `/users/${U.pablo}`).send({ accountCapabilities: { [PLAIN]: true } });
        const free = await as('pablo', 'put', '/users/me').send({ email: 'pablo@outlook.com', currentPassword: PASSWORD });
        assert.equal(free.status, 200, 'only a declaration asking for locksEmail locks the address');
    });

    test('locksEmail keeps applying while the declaring plugin is DEACTIVATED (read from the installed manifest)', async () => {
        const { updateOption } = require('../core/options');
        await updateOption('active_plugins', [ROGUE]);
        try {
            const moved = await as('alice', 'put', '/users/me').send({ email: 'alice@gmail.com', currentPassword: PASSWORD });
            assert.equal(moved.status, 403, 'deactivating the plugin must not release the address of a stored grant');
        } finally {
            await updateOption('active_plugins', [PROBE, ROGUE]);
        }
    });

    test('a menu item requiring an account capability is shown to holders and administrators only', async () => {
        const { registerAdminMenu, unregisterAdminMenu } = require('../core/adminMenu');
        registerAdminMenu(PROBE, { href: '/admin/acct-probe-test', label: 'Probe', cap: 'read', requiresAccountCapability: BADGE });
        registerAdminMenu(ROGUE, { href: '/admin/acct-rogue-test', label: 'Rogue', cap: 'read', requiresAccountCapability: BADGE });
        try {
            const hrefs = async (persona: string) => (await as(persona, 'get', '/plugins/menus')).body.map((m: any) => m.href);
            assert.ok((await hrefs('alice')).includes('/admin/acct-probe-test'), 'a holder sees it');
            assert.ok(!(await hrefs('pablo')).includes('/admin/acct-probe-test'), 'a non-holder does not');
            assert.ok((await hrefs('admin')).includes('/admin/acct-probe-test'), 'administrators always keep it');
            assert.ok(!(await hrefs('alice')).includes('/admin/acct-rogue-test'),
                'an item naming ANOTHER plugin\'s capability is never revealed by that plugin\'s grant');

            await dbAsync.run('UPDATE users SET user_email = ? WHERE id = ?', [`sneaky@${MAIL_DOMAIN}`, U.mallory]);
            assert.ok(!(await hrefs('mallory')).includes('/admin/acct-probe-test'), 'an on-domain address confers no visibility');
        } finally {
            unregisterAdminMenu(PROBE);
            unregisterAdminMenu(ROGUE);
            await dbAsync.run('UPDATE users SET user_email = ? WHERE id = ?', ['mallory@gmail.com', U.mallory]);
        }
    });
});

// =================================================================================================
describe('the site\'s own email domain is reserved on the three self-service doors', () => {

    test('PUT /users/me, PUT /users/:id (self) and POST /auth/register refuse it; an edit_users caller may assign it', async () => {
        const me = await as('mallory', 'put', '/users/me').send({ email: `ceo@${MAIL_DOMAIN}` });
        assert.equal(me.status, 403);
        assert.equal(me.body.code, 'rest_reserved_mail_domain');

        const self = await as('mallory', 'put', `/users/${U.mallory}`).send({ email: `ceo@${MAIL_DOMAIN}` });
        assert.equal(self.status, 403);
        assert.equal(self.body.code, 'rest_reserved_mail_domain');
        assert.equal(await emailOf(U.mallory), 'mallory@gmail.com');

        const { updateOption } = require('../core/options');
        await updateOption('users_can_register', '1');
        try {
            const reg = await anon('post', '/auth/register').send({ username: 'intruder', email: `ceo@${MAIL_DOMAIN}`, password: 'correct-horse-1' });
            assert.equal(reg.status, 403);
            assert.equal(reg.body.code, 'rest_reserved_mail_domain');
        } finally {
            await updateOption('users_can_register', '0');
        }

        const byManager = await as('usermgr', 'put', `/users/${U.mallory}`).send({ email: `ceo@${MAIL_DOMAIN}` });
        assert.equal(byManager.status, 200, 'assigning organisation addresses is an edit_users job');
    });
});

// =================================================================================================
describe('the upgrade from the core-owned mailbox flag (core/legacy-account-flags.ts)', () => {

    const memoryCtx = () => {
        const Database = require('better-sqlite3');
        const raw = new Database(':memory:');
        raw.exec('CREATE TABLE user_meta (user_id INTEGER, meta_key TEXT, meta_value TEXT);');
        const ctx = {
            run: async (sql: string, p: any[] = []) => raw.prepare(sql).run(...p),
            get: async (sql: string, p: any[] = []) => raw.prepare(sql).get(...p),
            all: async (sql: string, p: any[] = []) => raw.prepare(sql).all(...p),
        };
        const meta = (id: number, k: string) => (raw.prepare('SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ?').get(id, k) as any)?.meta_value ?? null;
        return { raw, ctx, meta };
    };

    test('migration 0019 copies every legacy value unchanged, keeps the legacy rows, and is idempotent', async () => {
        const { MIGRATIONS } = require('../core/schema-migrations');
        const ids = MIGRATIONS.map((m: any) => m.id);
        const mig = MIGRATIONS.find((m: any) => m.id === '0019_account_capabilities_from_mailbox_flag');
        assert.ok(mig, 'migration 0019 must exist');
        assert.ok(ids.indexOf(mig.id) > ids.indexOf('0006_professional_mailbox_flag'), 'and run after the one that created the legacy flag');

        const { raw, ctx, meta } = memoryCtx();
        const ins = raw.prepare('INSERT INTO user_meta VALUES (?,?,?)');
        ins.run(1, 'professional_mailbox', '1');
        ins.run(2, 'professional_mailbox', '0');
        ins.run(3, 'professional_mailbox', 'garbage');
        ins.run(4, 'role', 'editor');
        ins.run(5, 'professional_mailbox', '0');
        ins.run(5, `account_capability:${MAILBOX}`, '1');   // already decided — never overwritten

        await mig.up(ctx);
        assert.equal(meta(1, `account_capability:${MAILBOX}`), '1', 'a grant is kept');
        assert.equal(meta(2, `account_capability:${MAILBOX}`), '0', 'a revocation is kept');
        assert.equal(meta(3, `account_capability:${MAILBOX}`), '0', 'anything but "1" is not a grant (no widening)');
        assert.equal(meta(4, `account_capability:${MAILBOX}`), null, 'an account without the legacy flag gets nothing');
        assert.equal(meta(5, `account_capability:${MAILBOX}`), '1', 'an existing generic row is never overwritten');
        assert.equal(meta(1, 'professional_mailbox'), '1', 'the legacy rows stay for a node still on the previous release');

        await mig.up(ctx);
        const count = (raw.prepare('SELECT COUNT(*) AS c FROM user_meta WHERE meta_key = ?').get(`account_capability:${MAILBOX}`) as any).c;
        assert.equal(count, 4, 're-running copies nothing twice');
        raw.close();
    });

    test('a legacy "not granted" VETOES the generic grant (a revocation on an old node is honoured)', () => {
        assert.deepEqual(accountCaps.grantedAccountCapabilities({ [`account_capability:${MAILBOX}`]: '1', professional_mailbox: '0' }), []);
        assert.deepEqual(accountCaps.grantedAccountCapabilities({ [`account_capability:${MAILBOX}`]: '1', professional_mailbox: '1' }), [MAILBOX]);
        assert.deepEqual(accountCaps.grantedAccountCapabilities({ [`account_capability:${MAILBOX}`]: '1' }), [MAILBOX]);
        assert.deepEqual(accountCaps.grantedAccountCapabilities({ professional_mailbox: '1' }), [],
            'and the legacy row alone grants nothing — only the migrated value does');
    });

    test('with the mail plugin\'s REAL manifest: it declares the mailbox, and a write mirrors the legacy row', async () => {
        const manifest = JSON.parse(fs.readFileSync(REAL_MAIL_MANIFEST, 'utf8'));
        assert.deepEqual(accountCaps.validateManifestAccountCapabilities(MAIL, manifest), [], 'the bundled manifest is valid');
        const decl = (manifest.accountCapabilities || []).find((d: any) => d.slug === MAILBOX);
        assert.ok(decl, 'mail-server declares its mailbox through the generic seam');
        assert.equal(decl.locksEmail, true, 'and asks for the address lock the mailbox needs');

        writePlugin(MAIL, manifest);
        const { updateOption } = require('../core/options');
        await updateOption('active_plugins', [PROBE, ROGUE, MAIL]);
        try {
            const on = await as('usermgr', 'put', `/users/${U.pablo}`).send({ accountCapabilities: { [MAILBOX]: true } });
            assert.equal(on.status, 200);
            assert.equal(await grantOf(U.pablo, MAILBOX), '1');
            assert.equal(await metaValue(U.pablo, 'professional_mailbox'), '1', 'mirrored for a node on the previous release');
            const pablo = await freshUser(U.pablo);
            const routeUser = require('../core/plugin-isolate').projectRouteUser(pablo, MAIL);
            assert.deepEqual(routeUser.accountCapabilities, [MAILBOX]);
            assert.equal(routeUser.hasProfessionalMailbox, true, 'the deprecated field still reaches the mail plugin');

            const off = await as('usermgr', 'put', `/users/${U.pablo}`).send({ accountCapabilities: { [MAILBOX]: false } });
            assert.equal(off.status, 200);
            assert.equal(await metaValue(U.pablo, 'professional_mailbox'), '0', 'a revocation is mirrored too');

            // With the plugin UPDATED (it declares the capability), the outdated toggle's field is inert.
            const legacyField = await as('usermgr', 'put', `/users/${U.pablo}`).send({ professionalMailbox: true });
            assert.equal(legacyField.status, 200);
            assert.equal(await grantOf(U.pablo, MAILBOX), '0', 'the legacy field writes nothing once a declaration exists');
        } finally {
            await updateOption('active_plugins', [PROBE, ROGUE]);
        }
    });

    test('an OUTDATED mail plugin (no declaration) keeps its gates: projection, menu flag and address lock', async () => {
        // The installed manifest from before this release: no accountCapabilities block.
        const manifest = JSON.parse(fs.readFileSync(REAL_MAIL_MANIFEST, 'utf8'));
        delete manifest.accountCapabilities;
        writePlugin(MAIL, manifest);
        const { updateOption } = require('../core/options');
        await updateOption('active_plugins', [PROBE, ROGUE, MAIL]);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, '1')`, [U.mallory, `account_capability:${MAILBOX}`]);
        await require('../core/cache').del(`user:${U.mallory}`);
        const { registerAdminMenu, unregisterAdminMenu } = require('../core/adminMenu');
        registerAdminMenu(MAIL, { href: '/admin/legacy-webmail-test', label: 'Webmail', cap: 'read', requiresProfessionalMailbox: true });
        try {
            const mallory = await freshUser(U.mallory);
            assert.equal(require('../core/plugin-isolate').projectRouteUser(mallory, MAIL).hasProfessionalMailbox, true);
            const hrefs = async (persona: string) => (await as(persona, 'get', '/plugins/menus')).body.map((m: any) => m.href);
            assert.ok((await hrefs('mallory')).includes('/admin/legacy-webmail-test'), 'the legacy menu flag maps onto the grant');
            assert.ok(!(await hrefs('pablo')).includes('/admin/legacy-webmail-test'), 'and still hides the item from non-holders');
            const moved = await as('mallory', 'put', '/users/me').send({ email: 'mallory@outlook.com', currentPassword: PASSWORD });
            assert.equal(moved.status, 403, 'the mailbox still binds the address without a declaration saying so');
            assert.equal(moved.body.code, 'rest_mailbox_address_locked');

            // Its own user-form toggle still writes the grant — through the SAME gate as the generic field.
            const self = await as('pablo', 'put', `/users/${U.pablo}`).send({ professionalMailbox: true });
            assert.equal(self.status, 403, 'the legacy field is never self-assignable either');
            assert.equal(await grantOf(U.pablo, MAILBOX), '0');
            const meSelf = await as('pablo', 'put', '/users/me').send({ professionalMailbox: true, displayName: 'P' });
            assert.equal(meSelf.status, 200);
            assert.equal(await grantOf(U.pablo, MAILBOX), '0', 'PUT /users/me ignores it');
            const byManager = await as('usermgr', 'put', `/users/${U.pablo}`).send({ professionalMailbox: true });
            assert.equal(byManager.status, 200);
            assert.equal(await grantOf(U.pablo, MAILBOX), '1', 'an edit_users caller grants through the outdated toggle');
            assert.equal(await metaValue(U.pablo, 'professional_mailbox'), '1', 'mirrored');
            const revoke = await as('usermgr', 'put', `/users/${U.pablo}`).send({ professionalMailbox: false });
            assert.equal(revoke.status, 200);
            assert.equal(await grantOf(U.pablo, MAILBOX), '0', 'and revokes');
        } finally {
            unregisterAdminMenu(MAIL);
            await dbAsync.run('DELETE FROM user_meta WHERE user_id = ? AND meta_key = ?', [U.mallory, `account_capability:${MAILBOX}`]);
            await require('../core/cache').del(`user:${U.mallory}`);
            await updateOption('active_plugins', [PROBE, ROGUE]);
        }
    });
});

// =================================================================================================
// Turning a service off takes its address away: an account's email is the address a plugin provides, so
// the user forms send `removeEmail` once it is gone (a blank `email` stays "left alone").
// =================================================================================================
describe('removing the account email (PUT /users/:id removeEmail)', () => {

    test('refused while a granted capability binds the address; one save turns it off and removes it', async () => {
        await seedUser('rosa', 'subscriber', `rosa@${MAIL_DOMAIN}`);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, '1')`, [U.rosa, `account_capability:${BADGE}`]);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'password_reset_hash', 'pending')`, [U.rosa]);

        const bound = await as('usermgr', 'put', `/users/${U.rosa}`).send({ email: '', removeEmail: true });
        assert.equal(bound.status, 400);
        assert.equal(bound.body.code, 'rest_email_in_use_by_service');
        assert.equal(await emailOf(U.rosa), `rosa@${MAIL_DOMAIN}`, 'the address stays while the service uses it');

        const off = await as('usermgr', 'put', `/users/${U.rosa}`).send({ email: '', removeEmail: true, accountCapabilities: { [BADGE]: false } });
        assert.equal(off.status, 200, JSON.stringify(off.body));
        assert.equal(await emailOf(U.rosa), '', 'the account has no email now');
        assert.equal(await grantOf(U.rosa, BADGE), '0');
        assert.equal(await metaValue(U.rosa, 'password_reset_hash'), '', 'a reset link sent to the old address dies with it');

        const again = await as('usermgr', 'put', `/users/${U.rosa}`).send({ email: '', removeEmail: true, displayName: 'Rosa' });
        assert.equal(again.status, 200, 'removing an email the account does not have is a no-op');
    });

    test('a blank email is still "left alone", and removeEmail cannot travel with a new address', async () => {
        await seedUser('tomas', 'subscriber', 'tomas@gmail.com');
        const resend = await as('usermgr', 'put', `/users/${U.tomas}`).send({ email: '', displayName: 'Tomás' });
        assert.equal(resend.status, 200);
        assert.equal(await emailOf(U.tomas), 'tomas@gmail.com');

        const both = await as('usermgr', 'put', `/users/${U.tomas}`).send({ email: 'other@gmail.com', removeEmail: true });
        assert.equal(both.status, 400);
        assert.equal(both.body.code, 'rest_invalid_param');
        assert.equal(await emailOf(U.tomas), 'tomas@gmail.com');
    });

    test('only a user manager removes an address, and on their own account only with the password', async () => {
        await seedUser('lucia', 'subscriber', 'lucia@gmail.com');
        const self = await as('lucia', 'put', `/users/${U.lucia}`).send({ removeEmail: true, currentPassword: PASSWORD });
        assert.equal(self.status, 403);
        assert.equal(self.body.code, 'rest_forbidden');
        assert.equal(await emailOf(U.lucia), 'lucia@gmail.com');

        const noProof = await as('usermgr', 'put', `/users/${U.usermgr}`).send({ removeEmail: true });
        assert.equal(noProof.status, 403, 'removing your own address moves your reset link: sudo');
        assert.equal(await emailOf(U.usermgr), 'hr@gmail.com');
        const withProof = await as('usermgr', 'put', `/users/${U.usermgr}`).send({ removeEmail: true, currentPassword: PASSWORD });
        assert.equal(withProof.status, 200, JSON.stringify(withProof.body));
        assert.equal(await emailOf(U.usermgr), '');
    });
});
