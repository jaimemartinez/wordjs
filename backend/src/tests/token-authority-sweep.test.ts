/**
 * AN API TOKEN CANNOT RAISE AUTHORITY THROUGH A BACKUP RESTORE OR THROUGH A PLUGIN'S GRANTS.
 *
 * The rule of middleware/auth refuseAccountAuthority — an administrator's `wjt_` token never decides who
 * has an account or with what power, because what it creates outlives the token — covered POST /users,
 * POST /import with accounts, the registration settings and the roles. Its twins were still open to the
 * same token, each answering 200:
 *
 *   · POST /backups/:filename/restore carried only authenticate + isAdmin. A restore replaces the accounts
 *     and roles with the snapshot's (the physical path swaps the database file, so passwords, second
 *     factors, API tokens, plugin grants and registration settings come back too; the logical one is
 *     importSite with importUsers and updateExisting — the very write POST /import refuses to a token). An
 *     administrator demoted since the snapshot was an administrator again. Now refused like the account
 *     import (accountAuthorityOnly).
 *   · POST /plugins/:slug/permissions and POST /plugins/:slug/egress-hosts let the token GIVE a plugin
 *     `database:write`, `browser:script` (its code in the admin's pages with the viewer's session),
 *     `network`, or every public host (an empty egress list). A token may now revoke and narrow, never add
 *     (refusePluginGrantByToken), so an incident runbook can still take a capability away headlessly.
 *   · POST /plugins/:slug/activate seeds the manifest's declared permissions on a plugin's first
 *     activation — the grant-on-activate that stands for "an administrator read the activation dialog".
 *     A token read no dialog: an activation that would seed anything is refused before anything runs. A
 *     plugin that already holds what an administrator approved re-activates from a token as before.
 *
 *
 * Round three, the same rule seen from the other side and on more than one node:
 *
 *   · A COPY OF THE CREDENTIALS AT REST IS A SESSION TOO. POST /backups and GET /backups/:filename/download
 *     answered an administrator's token, and the archive holds the physical database snapshot — the bcrypt
 *     password hashes, the two-factor seeds `user_meta` keeps in clear, the API token hashes — and the
 *     plugins/ tree with its secrets. GET /export handed the same token every plugin's own tables (a
 *     payment plugin's write-only Stripe key); POST /db-migration/migrate copied every table to a database
 *     server the request names and then ran the site on it. All four are refused to a token now (nothing
 *     is written, sent or connected); the WXR export stays open.
 *   · STALE MIRRORS. The narrowing check compared the token's request with THIS node's in-memory grant
 *     mirror, which a revoke made on another node never reaches: stored [settings:read] + stale mirror
 *     database:write → 200, both saved. The token's writes are now decided on a fresh read of the row and
 *     written only if the row still holds what was read; a token's activation adopts the stored grants
 *     AND the stored egress allowlist (the spawn ships the list from this node's copy, so a list narrowed
 *     on another node was widened back for the plugin started here). When there was no row at all, the
 *     write was a plain upsert: a first record another node stored in between was overwritten (a list
 *     wider than the administrator's, another plugin's grants and the host bookkeeping lost). The first
 *     write is now conditional too.
 *   · THE EDGES OF "ADDS NOTHING". `example.com` covers `api.example.com`, never `evilexample.com`; a
 *     hostname entry never covers an IP and an IP entry never a hostname; `scope:admin` implies read and
 *     write, never `provider`. None of these had a test, so each could be broken silently.
 *
 * Every request goes through the REAL routers with a REAL token minted by POST /auth/tokens, and every
 * assertion is on the state that results — the account list and roles, the stored grant record, the
 * stored egress list, the active list — not only on the status code. The restore suite runs LAST: its
 * interactive control really restores (and so wipes) this throwaway database.
 *
 * MUTATION PROOF (round three): drop credentialExportSessionOnly from POST /backups, the download or
 * GET /export, or accountAuthorityOnly from /db-migration/migrate, and the token gets the archive / a 400
 * from the migration handler; judge the token's grant or egress write against getGrants() /
 * getEgressAllowlist() (the mirror) and the stale-mirror tests save the revoked grant or host; write it
 * without the compare-and-set and the concurrent revoke is overwritten; take the token activation's answer
 * from the mirror and the revoked plugin starts; adopt only the stored grants and the child is shipped
 * the stale (empty) egress list; upsert the first write and the "no row yet" tests lose the other node's
 * record; `n.endsWith(c)` for `n.endsWith('.' + c)`, a dropped
 * net.isIP guard, or `provider` added to the admin-implies verbs, and the matching edge test stores it.
 *
 * MUTATION PROOF: drop accountAuthorityOnly from the restore route and the restore test re-creates the
 * snapshot's administrator; drop either refusePluginGrantByToken call (or make grantsAddedTo /
 * egressHostsAddedTo answer []) and the matching "widen" test stores the grant or host; drop the
 * activation refusal and the token activation seeds and records `settings:read`.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const AdmZip = require('adm-zip');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-token-authority-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const User = require('../models/User');
const { getOption } = require('../core/options');
const { csrfProtection } = require('../middleware/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const B = config.api.prefix;
const SECRET = config.jwt.secret;
const PASSWORD = 'Correct-Horse-9!';
const PID = process.pid;
const P_GRANTS = `wjs-tokgrant-${PID}`;   // grants and egress are written on it; never activated
const P_ACT = `wjs-tokact-${PID}`;        // declares settings:read; activated through the real route
const P_NET = `wjs-toknet-${PID}`;        // declares network; activated by a token on a node with a stale list
const BENIGN_INDEX = "'use strict';\nmodule.exports = { init() {} };\n";

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(B, csrfProtection);
// index.ts registers the DB-admin router (core/db-admin) on the app itself; registered here the same way.
require('../core/db-admin').register(app);
app.use(B, require('../routes'));
// index.ts mounts /backups outside the routes index; mounted here the same way.
app.use(`${B}/backups`, require('../routes/backups'));

const U: Record<string, number> = {};
let dbAsync: any;
let token = '';
let core: any, perms: any;
const madeDirs: string[] = [];

const session = (persona: string) => `Bearer ${jwt.sign({ userId: U[persona], username: persona }, SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
const asToken = () => `Bearer ${token}`;

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        'INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
        [login, bcrypt.hashSync(PASSWORD, 10), `${login}@example.com`, login]);
    await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)", [r.lastID, role]);
    U[login] = r.lastID;
}

function writePlugin(slug: string, permissions: any[]) {
    const dir = path.join(core.PLUGINS_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    madeDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: slug, version: '1.0.0', isolated: true, permissions }));
    fs.writeFileSync(path.join(dir, 'index.js'), BENIGN_INDEX);
}

function assertTokenRefused(res: any, label: string, params?: string[]) {
    assert.strictEqual(res.status, 403, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'rest_token_management_forbidden', `${label}: ${JSON.stringify(res.body)}`);
    if (params) assert.deepStrictEqual([...res.body.data.params].sort(), [...params].sort(), `${label}: params`);
}

/** The grant record as STORED (what the next boot loads), not only the in-memory mirror. */
async function storedGrants(slug: string): Promise<string[] | undefined> {
    const stored = (await getOption('plugin_grants', {})) || {};
    return Object.hasOwn(stored, slug) ? stored[slug] : undefined;
}
async function storedEgress(slug: string): Promise<string[] | undefined> {
    const stored = (await getOption('plugin_egress_hosts', {})) || {};
    return Object.hasOwn(stored, slug) ? stored[slug] : undefined;
}

/** An option's value as the DATABASE holds it (not the option cache, not the mirror). */
async function dbStored(name: string): Promise<any> {
    const row = await dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', [name]);
    return row ? JSON.parse(row.option_value) : {};
}
/** Another node's write: the row changes; this node's option cache and in-memory mirrors do not. */
async function otherNodeWrites(name: string, mutate: (value: any) => void): Promise<void> {
    const value = await dbStored(name);
    mutate(value);
    await dbAsync.run('UPDATE options SET option_value = ? WHERE option_name = ?', [JSON.stringify(value), name]);
}
/** Bring this node back in line with the database after a test that left it stale on purpose. */
async function resync(): Promise<void> {
    const cache = require('../core/cache');
    await cache.del('option:plugin_grants');
    await cache.del('option:plugin_egress_hosts');
    await perms.loadGrants();
    await perms.loadEgressHosts();
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    core = require('../core/plugins');
    perms = require('../core/plugin-permissions');
    await perms.loadGrants();
    await perms.loadEgressHosts();
    await seedUser('owner', 'administrator');
    await seedUser('operator', 'administrator');
    await seedUser('demoted', 'subscriber'); // an administrator once — in the snapshot below

    writePlugin(P_GRANTS, [{ scope: 'database', access: 'write' }, { scope: 'network' }]);
    writePlugin(P_ACT, [{ scope: 'settings', access: 'read', reason: 'reads the site name' }]);
    writePlugin(P_NET, [{ scope: 'network', reason: 'calls one API' }]);

    // The strongest token there is: an administrator's, global `write` scope.
    const minted = await request(app).post(`${B}/auth/tokens`).set('Authorization', session('operator')).send({ name: 'ci', scopes: 'write' });
    assert.strictEqual(minted.status, 201, JSON.stringify(minted.body));
    token = minted.body.token;
    assert.ok(/^wjt_/.test(token));
});

after(async () => {
    try { await core.deactivatePlugin(P_ACT, { prune: false }); } catch { /* */ }
    try { await core.deactivatePlugin(P_NET, { prune: false }); } catch { /* */ }
    for (const d of madeDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

describe('POST /plugins/:slug/permissions — a token may revoke, never grant', () => {
    const grant = (auth: string, body: any) => request(app).post(`${B}/plugins/${P_GRANTS}/permissions`).set('Authorization', auth).send(body);

    it('refuses a token adding database:write and network; the stored record is untouched', async () => {
        await perms.setGrants(P_GRANTS, ['settings:read'], { adminDecision: true });
        const res = await grant(asToken(), { granted: ['settings:read', 'database:write'], network: true });
        assertTokenRefused(res, 'widen grants', ['database:write', 'network']);
        assert.deepStrictEqual(perms.getGrants(P_GRANTS), ['settings:read']);
        assert.deepStrictEqual(await storedGrants(P_GRANTS), ['settings:read'], 'nothing was written');
    });

    it('a spelling the store folds together is still an addition', async () => {
        await perms.setGrants(P_GRANTS, [], { adminDecision: true });
        assertTokenRefused(await grant(asToken(), { granted: [' DATABASE:WRITE '] }), 'case/space variant', ['database:write']);
        assert.deepStrictEqual(await storedGrants(P_GRANTS), []);
    });

    it('a token may revoke (no over-block): the grant is gone, in memory and stored', async () => {
        await perms.setGrants(P_GRANTS, ['settings:read', 'database:write'], { adminDecision: true });
        const res = await grant(asToken(), { granted: ['settings:read'] });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(perms.getGrants(P_GRANTS), ['settings:read']);
        assert.deepStrictEqual(await storedGrants(P_GRANTS), ['settings:read']);
        // Sending back exactly what it holds adds nothing either.
        assert.strictEqual((await grant(asToken(), { granted: ['settings:read'] })).status, 200);
    });

    it('narrowing scope:admin to scope:write is a narrowing, not an addition', async () => {
        await perms.setGrants(P_GRANTS, ['filesystem:admin'], { adminDecision: true });
        const res = await grant(asToken(), { granted: ['filesystem:write'] });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(await storedGrants(P_GRANTS), ['filesystem:write']);
    });

    it('an interactive administrator may grant (control)', async () => {
        const res = await grant(session('owner'), { granted: ['database:write'], network: true });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual([...(await storedGrants(P_GRANTS) || [])].sort(), ['database:write', 'network']);
    });
});

describe('POST /plugins/:slug/egress-hosts — a token may narrow, never widen', () => {
    const egress = (auth: string, hosts: any) => request(app).post(`${B}/plugins/${P_GRANTS}/egress-hosts`).set('Authorization', auth).send({ hosts });

    it('from "every public host", any list is a narrowing a token may write', async () => {
        await perms.setEgressAllowlist(P_GRANTS, []);
        const res = await egress(asToken(), ['api.example.com']);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(await storedEgress(P_GRANTS), ['api.example.com']);
    });

    it('refuses a token adding a host outside the list; the stored list is untouched', async () => {
        const res = await egress(asToken(), ['api.example.com', 'collector.evil.example']);
        assertTokenRefused(res, 'add a host', ['collector.evil.example']);
        assert.deepStrictEqual(await storedEgress(P_GRANTS), ['api.example.com']);
        assert.deepStrictEqual(perms.getEgressAllowlist(P_GRANTS), ['api.example.com']);
    });

    it('refuses a token clearing the list — an empty list is every public host', async () => {
        assertTokenRefused(await egress(asToken(), []), 'clear the list', ['*']);
        assertTokenRefused(await egress(asToken(), ['https://not-a-host/']), 'a list that validates to empty', ['*']);
        assert.deepStrictEqual(await storedEgress(P_GRANTS), ['api.example.com']);
    });

    it('a subdomain (or a wildcard of the same host) of a listed host is a narrowing', async () => {
        assert.strictEqual((await egress(asToken(), ['*.api.example.com'])).status, 200);
        const res = await egress(asToken(), ['v2.api.example.com']);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(await storedEgress(P_GRANTS), ['v2.api.example.com']);
        // ...and the parent is now outside it.
        assertTokenRefused(await egress(asToken(), ['api.example.com']), 'back to the parent', ['api.example.com']);
    });

    it('an interactive administrator may widen or clear it (control)', async () => {
        const res = await egress(session('owner'), []);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(await storedEgress(P_GRANTS), []);
    });
});

describe('POST /plugins/:slug/activate — a token activation never seeds permissions', () => {
    const activate = (auth: string) => request(app).post(`${B}/plugins/${P_ACT}/activate`).set('Authorization', auth).send({});
    const deactivate = (auth: string) => request(app).post(`${B}/plugins/${P_ACT}/deactivate`).set('Authorization', auth).send({});
    const active = async () => ((await getOption('active_plugins', [])) as string[]).includes(P_ACT);

    it('refuses the first activation of a plugin that declares permissions: nothing runs, nothing is granted', async () => {
        const res = await activate(asToken());
        assertTokenRefused(res, 'token first activation', ['settings:read']);
        assert.strictEqual(await active(), false, 'not activated');
        assert.deepStrictEqual(perms.getGrants(P_ACT), [], 'no grant in memory');
        assert.strictEqual(await storedGrants(P_ACT), undefined, 'no grant record');
        assert.strictEqual(await perms.hasAdminGrantDecision(P_ACT), false, 'no administrator decision recorded');
    });

    it('once an administrator activated it, a token may deactivate and re-activate it (headless deploys)', async () => {
        const first = await activate(session('owner'));
        assert.strictEqual(first.status, 200, JSON.stringify(first.body));
        assert.deepStrictEqual(await storedGrants(P_ACT), ['settings:read'], 'the dialog\'s grant-on-activate');
        assert.strictEqual((await deactivate(asToken())).status, 200);
        assert.strictEqual(await active(), false);
        const again = await activate(asToken());
        assert.strictEqual(again.status, 200, JSON.stringify(again.body));
        assert.strictEqual(await active(), true);
        assert.deepStrictEqual(await storedGrants(P_ACT), ['settings:read'], 'nothing new was granted');
        assert.strictEqual((await deactivate(asToken())).status, 200);
    });

    it('after an administrator revoked everything, a token re-activation seeds nothing: the plugin starts with nothing granted', async () => {
        // The revoke of every grant is the administrator's recorded decision (POST /permissions), so an
        // activation does not re-seed it — for a token as for anyone — and there is nothing to refuse.
        await perms.setGrants(P_ACT, [], { adminDecision: true });
        const res = await activate(asToken());
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        try {
            assert.strictEqual(await active(), true);
            assert.deepStrictEqual(perms.getGrants(P_ACT), [], 'the token activation granted something');
            assert.deepStrictEqual(await storedGrants(P_ACT), [], 'the revoke of every grant was overwritten');
        } finally {
            assert.strictEqual((await deactivate(asToken())).status, 200);
        }
    });

    it('an empty record no administrator decided (an older update\'s leftover) would be seeded — refused to a token', async () => {
        await otherNodeWrites('plugin_grants', (v) => {
            v[P_ACT] = [];
            if (v['@host'] && v['@host'].adminDecisions) delete v['@host'].adminDecisions[P_ACT];
        });
        await resync();
        assert.strictEqual(await perms.hasAdminGrantDecision(P_ACT), false, 'precondition: nobody decided it');
        assertTokenRefused(await activate(asToken()), 'token seed of an undecided empty record', ['settings:read']);
        assert.strictEqual(await active(), false);
        assert.deepStrictEqual((await dbStored('plugin_grants'))[P_ACT], [], 'nothing was granted');
        // Control: an administrator's activation seeds it (and records the decision).
        const ctl = await activate(session('owner'));
        assert.strictEqual(ctl.status, 200, JSON.stringify(ctl.body));
        assert.deepStrictEqual((await dbStored('plugin_grants'))[P_ACT], ['settings:read']);
        assert.strictEqual(await perms.hasAdminGrantDecision(P_ACT), true);
        assert.strictEqual((await deactivate(asToken())).status, 200);
    });
});

describe('activate, update, restart — the next boot grants nothing the token\'s update brought in', () => {
    // A token may activate a plugin that declares nothing (there is nothing to seed, so nothing to refuse)
    // and may update it in place (POST /marketplace/update → runPluginUpdate). The activation stores no
    // grant record — grant-on-activate persists only a non-empty seed — and the boot backfill grants every
    // ACTIVE plugin without a record whatever its manifest on disk declares. So the update to a version
    // declaring network and database:write, followed by any restart, granted both, approved by nobody.
    const P_UPD = `wjs-tokupd-${PID}`;
    const SOURCE = 'https://catalog.example/download';
    const activate = (auth: string) => request(app).post(`${B}/plugins/${P_UPD}/activate`).set('Authorization', auth).send({});

    /** index.ts's boot sequence for grants: loadGrants, then backfillActive over the active plugins. */
    async function restart(): Promise<void> {
        await perms.loadGrants();
        const active: string[] = await core.getActivePlugins();
        const all: any[] = await core.getAllPlugins();
        const entries = all.filter((p: any) => active.includes(p.slug)).map((p: any) => ({
            slug: p.slug,
            requested: Array.from(new Set((p.permissions || [])
                .map((perm: any) => (perm && perm.scope) ? (perm.scope === 'network' ? 'network' : `${perm.scope}:${perm.access || 'read'}`) : null)
                .filter(Boolean))) as string[],
        }));
        await perms.backfillActive(entries);
    }

    before(async () => {
        writePlugin(P_UPD, []);
        await require('../core/plugin-origins').setPluginOrigin(P_UPD, { source: SOURCE, catalogId: P_UPD, version: '1.0.0' });
    });
    after(async () => {
        try { await core.deactivatePlugin(P_UPD, { prune: false }); } catch { /* */ }
        await resync();
    });

    it('an update of an active plugin with no grant record leaves an empty one, and the restart grants nothing', async () => {
        const first = await activate(asToken());
        assert.strictEqual(first.status, 200, JSON.stringify(first.body));
        assert.ok(((await getOption('active_plugins', [])) as string[]).includes(P_UPD), 'precondition: active');
        assert.strictEqual(await storedGrants(P_UPD), undefined, 'precondition: no grant record');

        const { runPluginUpdate, createInstallTmp } = require('../routes/plugins');
        const tmp = createInstallTmp();
        try {
            const zip = new AdmZip();
            zip.addFile(`${P_UPD}/manifest.json`, Buffer.from(JSON.stringify({ name: P_UPD, version: '2.0.0', isolated: true,
                permissions: [{ scope: 'network', reason: 'phones home' }, { scope: 'database', access: 'write', reason: 'writes' }] })));
            zip.addFile(`${P_UPD}/index.js`, Buffer.from(BENIGN_INDEX));
            zip.writeZip(tmp.zipPath);
            const r = await runPluginUpdate(P_UPD, tmp.zipPath, { source: SOURCE, catalogId: P_UPD, version: '2.0.0' });
            assert.strictEqual(r.ok, true, JSON.stringify(r.body));
            assert.strictEqual(r.body.reactivated, true);
            assert.deepStrictEqual([...r.body.ungrantedPermissions].sort(), ['database:write', 'network']);
        } finally {
            try { tmp.dispose(); } catch { /* */ }
        }
        assert.deepStrictEqual(await storedGrants(P_UPD), [], 'the update left no grant record for the next boot to fill');
        assert.strictEqual(await perms.hasAdminGrantDecision(P_UPD), false, 'and recorded no administrator decision');

        await restart();

        assert.deepStrictEqual((await dbStored('plugin_grants'))[P_UPD], [], 'the restart granted what the new version declares');
        assert.deepStrictEqual(perms.getGrants(P_UPD), []);
        assert.strictEqual(perms.isNetworkGranted(P_UPD), false, 'the plugin got the network at the restart');
        assert.strictEqual(perms.isGranted(P_UPD, 'database', 'write'), false);
    });

    it('control: the update did not make the plugin\'s re-activation look decided — a token still cannot seed it', async () => {
        assert.strictEqual((await request(app).post(`${B}/plugins/${P_UPD}/deactivate`).set('Authorization', asToken()).send({})).status, 200);
        assertTokenRefused(await activate(asToken()), 'token seed after the update', ['database:write', 'network']);
        assert.deepStrictEqual(await storedGrants(P_UPD), [], 'nothing was granted');
        // An administrator's activation reads the dialog and seeds what this version declares.
        const ctl = await activate(session('owner'));
        assert.strictEqual(ctl.status, 200, JSON.stringify(ctl.body));
        assert.deepStrictEqual([...(await storedGrants(P_UPD) || [])].sort(), ['database:write', 'network']);
    });
});

describe('a token never gets a copy of the credentials at rest', () => {
    const backupsDir = path.resolve(__dirname, '../../backups');
    const written: string[] = [];
    const TOTP_SEED = `TESTSEED${PID}ABCDEFGH`;
    let ownerHash = '';
    const archives = () => (fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((f: string) => f.endsWith('.zip')).sort() : []);

    before(async () => {
        // A second factor at rest, the way core/mfa keeps it: the seed in clear in user_meta.
        await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'mfa_totp_secret', ?)", [U.owner, TOTP_SEED]);
        ownerHash = (await dbAsync.get('SELECT user_pass FROM users WHERE id = ?', [U.owner])).user_pass;
        assert.ok(/^\$2[aby]\$/.test(ownerHash), 'precondition: a bcrypt hash is stored');
    });
    let preexisting: string[] = [];
    before(() => { preexisting = archives(); });
    // Every archive this suite caused — the control's, and one a token managed to have written when the
    // refusal is missing — is removed; archives that were there before are left alone.
    after(() => {
        for (const f of archives()) {
            if (preexisting.includes(f)) continue;
            try { fs.rmSync(path.join(backupsDir, f), { force: true }); } catch { /* */ }
        }
    });

    it('POST /backups: a token is refused and no archive is written', async () => {
        const before = archives();
        assertTokenRefused(await request(app).post(`${B}/backups`).set('Authorization', asToken()).send({}), 'POST /backups');
        assert.deepStrictEqual(archives(), before, 'an archive was written for the token');
    });

    it('an interactive administrator creates one (control) — and it holds the password hashes and the two-factor seeds', async () => {
        const saved = { log: console.log, warn: console.warn };
        console.log = console.warn = () => {};
        let res: any;
        try { res = await request(app).post(`${B}/backups`).set('Authorization', session('owner')).send({}); }
        finally { Object.assign(console, saved); }
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        written.push(res.body.filename);
        const snapshot = new AdmZip(path.join(backupsDir, res.body.filename)).getEntry('database/wordjs.db');
        assert.ok(snapshot, 'the archive carries the physical database snapshot');
        const bytes = snapshot.getData().toString('latin1');
        assert.ok(bytes.includes(ownerHash), 'the snapshot holds the password hash');
        assert.ok(bytes.includes(TOTP_SEED), 'the snapshot holds the two-factor seed');
    });

    it('GET /backups/:filename/download: a token is refused, the archive is not sent', async () => {
        const file = written[0];
        assert.ok(file, 'precondition: the control above wrote an archive');
        const res = await request(app).get(`${B}/backups/${file}/download`).set('Authorization', asToken())
            .buffer(true).parse((r: any, cb: any) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
        assert.strictEqual(res.status, 403, `the token got ${res.status} ${res.headers['content-type']}`);
        const body = JSON.parse(res.body.toString('utf8'));
        assert.strictEqual(body.code, 'rest_token_management_forbidden');
        assert.ok(!res.body.toString('latin1').includes(ownerHash), 'no credential crossed the wire');
        // Control: the session still downloads it, byte for byte.
        const ok = await request(app).get(`${B}/backups/${file}/download`).set('Authorization', session('owner'))
            .buffer(true).parse((r: any, cb: any) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
        assert.strictEqual(ok.status, 200);
        assert.ok(ok.body.equals(fs.readFileSync(path.join(backupsDir, file))), 'the administrator gets the archive');
    });

    it('GET /export: the JSON site archive is refused to a token, with or without users; WXR stays open', async () => {
        // A payment plugin's write-only key, in its own table — where the marketplace plugins keep theirs.
        const SECRET = `sk_live_tok${PID}`;
        await dbAsync.exec('CREATE TABLE IF NOT EXISTS wjp_tokpay_settings (name TEXT PRIMARY KEY, value TEXT)');
        await dbAsync.run('INSERT INTO wjp_tokpay_settings (name, value) VALUES (?, ?)', ['stripe_sk', SECRET]);
        for (const q of ['', '?users=true']) {
            const res = await request(app).get(`${B}/export${q}`).set('Authorization', asToken());
            assertTokenRefused(res, `GET /export${q}`);
            assert.ok(!JSON.stringify(res.body).includes(SECRET), 'no plugin secret crossed the wire');
        }
        // Control: what the token was refused — the administrator's archive carries the plugin's secret...
        const full = await request(app).get(`${B}/export?users=true`).set('Authorization', session('owner'));
        assert.strictEqual(full.status, 200, JSON.stringify(full.body).slice(0, 200));
        assert.ok(JSON.stringify(full.body.content.custom_tables || []).includes(SECRET), 'the archive carries the plugin table');
        // ...and, for anyone, no password hash: the account list never had one (the old `password` field was
        // always undefined), and it must not start carrying one.
        assert.ok((full.body.content.users || []).length > 0, 'precondition: accounts were exported');
        assert.ok(!JSON.stringify(full.body).includes(ownerHash), 'a password hash is in the JSON archive');
        // The content export carries no plugin table, and stays a token's to use.
        const wxr = await request(app).get(`${B}/export/wxr`).set('Authorization', asToken());
        assert.strictEqual(wxr.status, 200, `WXR: ${wxr.status}`);
        assert.ok(!String(wxr.text).includes(SECRET) && !String(wxr.text).includes(ownerHash));
    });

    it('POST /db-migration/migrate: refused to a token before the request is read', async () => {
        // An invalid driver is the cheapest probe: the handler answers it with a 400 and touches nothing,
        // so a 403 here means the refusal ran first.
        const res = await request(app).post(`${B}/db-migration/migrate`).set('Authorization', asToken()).send({ targetDriver: 'not-a-driver' });
        assertTokenRefused(res, 'POST /db-migration/migrate');
        // Control: an interactive administrator reaches the handler (and its own 400).
        const ctl = await request(app).post(`${B}/db-migration/migrate`).set('Authorization', session('owner')).send({ targetDriver: 'not-a-driver' });
        assert.strictEqual(ctl.status, 400, JSON.stringify(ctl.body));
    });
});

describe('multi-node: a token is judged against what is STORED, not this node\'s mirror', () => {
    const grant = (auth: string, body: any) => request(app).post(`${B}/plugins/${P_GRANTS}/permissions`).set('Authorization', auth).send(body);
    const egress = (auth: string, hosts: any) => request(app).post(`${B}/plugins/${P_GRANTS}/egress-hosts`).set('Authorization', auth).send({ hosts });

    after(resync);

    it('a grant revoked on another node is not re-saved by a token sending this node\'s stale set', async () => {
        await perms.setGrants(P_GRANTS, ['settings:read', 'database:write'], { adminDecision: true });
        await getOption('plugin_grants', {}); // this node has read it since: its option cache holds it too
        await otherNodeWrites('plugin_grants', (v) => { v[P_GRANTS] = ['settings:read']; });
        assert.deepStrictEqual(perms.getGrants(P_GRANTS).sort(), ['database:write', 'settings:read'], 'precondition: this node\'s mirror is stale');
        assert.deepStrictEqual([...((await getOption('plugin_grants', {})) as any)[P_GRANTS]].sort(), ['database:write', 'settings:read'], 'precondition: and so is its option cache');
        assertTokenRefused(await grant(asToken(), { granted: ['settings:read', 'database:write'] }), 'stale-mirror re-grant', ['database:write']);
        assert.deepStrictEqual((await dbStored('plugin_grants'))[P_GRANTS], ['settings:read'], 'the revoke stands');
        // ...and what the token may do, it still does: the narrowing to nothing is written.
        const narrowed = await grant(asToken(), { granted: [] });
        assert.strictEqual(narrowed.status, 200, JSON.stringify(narrowed.body));
        assert.deepStrictEqual((await dbStored('plugin_grants'))[P_GRANTS], []);
        await resync();
    });

    it('a revoke that lands between the token\'s read and its write is not overwritten', async () => {
        await perms.setGrants(P_GRANTS, ['settings:read', 'database:write'], { adminDecision: true });
        const options = require('../core/options');
        const original = options.readStoredOption;
        let landed = false;
        // The other node's revoke commits right AFTER the token's read: the decision taken on that read
        // ("adds nothing") must not be applied over it.
        options.readStoredOption = async (name: string) => {
            const read = await original(name);
            if (!landed && name === 'plugin_grants') {
                landed = true;
                await otherNodeWrites('plugin_grants', (v) => { v[P_GRANTS] = ['settings:read']; });
            }
            return read;
        };
        let res: any;
        try { res = await grant(asToken(), { granted: ['settings:read', 'database:write'] }); }
        finally { options.readStoredOption = original; }
        assert.ok(landed, 'precondition: the token\'s write read the stored grants');
        assertTokenRefused(res, 'concurrent revoke', ['database:write']);
        assert.deepStrictEqual((await dbStored('plugin_grants'))[P_GRANTS], ['settings:read'], 'the concurrent revoke stands');
        await resync();
    });

    it('a host removed on another node is not re-added by a token sending the stale list', async () => {
        await perms.setEgressAllowlist(P_GRANTS, ['api.example.com', 'cdn.example.com']);
        await getOption('plugin_egress_hosts', {}); // primes this node's option cache, as any earlier read did
        await otherNodeWrites('plugin_egress_hosts', (v) => { v[P_GRANTS] = ['api.example.com']; });
        assert.deepStrictEqual(perms.getEgressAllowlist(P_GRANTS), ['api.example.com', 'cdn.example.com'], 'precondition: stale mirror');
        assert.deepStrictEqual(((await getOption('plugin_egress_hosts', {})) as any)[P_GRANTS], ['api.example.com', 'cdn.example.com'], 'precondition: stale option cache');
        assertTokenRefused(await egress(asToken(), ['api.example.com', 'cdn.example.com']), 'stale-mirror host', ['cdn.example.com']);
        assert.deepStrictEqual((await dbStored('plugin_egress_hosts'))[P_GRANTS], ['api.example.com']);
        await resync();
    });

    /**
     * No row yet (a fresh install): the token's read sees nothing stored, and another node stores the first
     * record right after that read. The token's decision was taken on "nothing"; it must not be written
     * over what the other node stored.
     */
    async function firstWriteRace(name: string, otherNodeRecord: any, send: () => Promise<any>): Promise<any> {
        await dbAsync.run('DELETE FROM options WHERE option_name = ?', [name]);
        await resync();
        const options = require('../core/options');
        const original = options.readStoredOption;
        let landed = false;
        let sawNoRow = false;
        options.readStoredOption = async (n: string) => {
            const read = await original(n);
            if (!landed && n === name) {
                landed = true;
                sawNoRow = read.raw === null;
                await dbAsync.run('INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, ?)', [name, JSON.stringify(otherNodeRecord), 'yes']);
            }
            return read;
        };
        let res: any;
        try { res = await send(); }
        finally { options.readStoredOption = original; }
        assert.ok(landed && sawNoRow, 'precondition: the token\'s write read "no row" before the other node stored one');
        return res;
    }

    it('no egress row yet: a token\'s list is not written over the first list another node stored', async () => {
        const res = await firstWriteRace('plugin_egress_hosts', { [P_GRANTS]: ['api.example.com'] },
            () => egress(asToken(), ['cdn.example.com']));
        assertTokenRefused(res, 'first write over a concurrent first list', ['cdn.example.com']);
        assert.deepStrictEqual((await dbStored('plugin_egress_hosts'))[P_GRANTS], ['api.example.com'], 'the other node\'s list stands');
        await resync();
    });

    it('no grant row yet: a token\'s narrowing keeps the record another node stored first', async () => {
        const otherNode = { [P_ACT]: ['settings:read'], [P_GRANTS]: ['settings:read'], '@host': { adminDecisions: { [P_ACT]: '2026-01-01T00:00:00.000Z' } } };
        const res = await firstWriteRace('plugin_grants', otherNode, () => grant(asToken(), { granted: [] }));
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const stored = await dbStored('plugin_grants');
        assert.deepStrictEqual(stored[P_GRANTS], [], 'the narrowing was written');
        assert.deepStrictEqual(stored[P_ACT], ['settings:read'], 'another plugin\'s grant record survived');
        assert.ok(stored['@host'] && stored['@host'].adminDecisions && stored['@host'].adminDecisions[P_ACT], 'the host bookkeeping survived');
        await resync();
    });

    describe('activation', () => {
        const activate = (auth: string) => request(app).post(`${B}/plugins/${P_ACT}/activate`).set('Authorization', auth).send({});
        const active = async () => ((await getOption('active_plugins', [])) as string[]).includes(P_ACT);
        after(async () => {
            if (await active()) await request(app).post(`${B}/plugins/${P_ACT}/deactivate`).set('Authorization', session('owner')).send({});
            await resync();
        });

        it('everything revoked on another node: a token activation starts the plugin with nothing granted, not on the stale grants', async () => {
            await perms.setGrants(P_ACT, [], { adminDecision: true });
            perms._setGrantsInMemory(P_ACT, ['settings:read']); // this node never heard of the revoke
            const res = await activate(asToken());
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.deepStrictEqual(perms.getGrants(P_ACT), [], 'the plugin runs here with the revoked grant');
            assert.strictEqual(perms.isGranted(P_ACT, 'settings', 'read'), false);
            assert.deepStrictEqual((await dbStored('plugin_grants'))[P_ACT], [], 'nothing granted');
            await request(app).post(`${B}/plugins/${P_ACT}/deactivate`).set('Authorization', session('owner')).send({});
            assert.strictEqual(await active(), false);
        });

        it('an undecided empty record on another node, stale grants here: refused as a seed, not started on the stale grants', async () => {
            await otherNodeWrites('plugin_grants', (v) => {
                v[P_ACT] = [];
                if (v['@host'] && v['@host'].adminDecisions) delete v['@host'].adminDecisions[P_ACT];
            });
            perms._setGrantsInMemory(P_ACT, ['settings:read']); // this node's stale copy
            assertTokenRefused(await activate(asToken()), 'stale-mirror activation', ['settings:read']);
            assert.strictEqual(await active(), false, 'not activated');
            assert.deepStrictEqual((await dbStored('plugin_grants'))[P_ACT], [], 'nothing granted');
            assert.deepStrictEqual(perms.getGrants(P_ACT), [], 'this node adopted the stored (empty) record');
        });

        it('part revoked on another node: the token activation starts the plugin with what is stored', async () => {
            await perms.setGrants(P_ACT, ['settings:read'], { adminDecision: true });
            perms._setGrantsInMemory(P_ACT, ['settings:read', 'database:write']); // stale: database:write was revoked
            const res = await activate(asToken());
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.deepStrictEqual(perms.getGrants(P_ACT), ['settings:read'], 'the plugin runs here without the revoked grant');
            assert.deepStrictEqual((await dbStored('plugin_grants'))[P_ACT], ['settings:read']);
        });

        it('egress list narrowed on another node: the token activation ships the child the stored list', async () => {
            await perms.setGrants(P_NET, ['network'], { adminDecision: true });
            await perms.setEgressAllowlist(P_NET, []); // this node: no list, every public host
            await otherNodeWrites('plugin_egress_hosts', (v) => { v[P_NET] = ['api.example.com']; });
            assert.deepStrictEqual(perms.getEgressAllowlist(P_NET), [], 'precondition: this node\'s copy is stale');
            // The spawn reads the list it ships to the child (childCfg.allowedHosts) through
            // getEgressAllowlist; record what it got.
            const shipped: string[][] = [];
            const original = perms.getEgressAllowlist;
            perms.getEgressAllowlist = (s: string) => { const l = original(s); if (s === P_NET) shipped.push(l); return l; };
            let res: any;
            try { res = await request(app).post(`${B}/plugins/${P_NET}/activate`).set('Authorization', asToken()).send({}); }
            finally { perms.getEgressAllowlist = original; }
            try {
                assert.strictEqual(res.status, 200, JSON.stringify(res.body));
                assert.ok(shipped.length > 0, 'precondition: the spawn read the egress list');
                assert.deepStrictEqual(shipped[shipped.length - 1], ['api.example.com'], 'the child got the stored list, not every public host');
                assert.deepStrictEqual(perms.getEgressAllowlist(P_NET), ['api.example.com'], 'this node adopted the stored list');
                assert.deepStrictEqual((await dbStored('plugin_egress_hosts'))[P_NET], ['api.example.com'], 'nothing was written over it');
            } finally {
                await request(app).post(`${B}/plugins/${P_NET}/deactivate`).set('Authorization', session('owner')).send({});
            }
        });
    });
});

describe('the edges of "adds nothing" — egress-guard\'s and isGranted\'s own lines', () => {
    const grant = (auth: string, body: any) => request(app).post(`${B}/plugins/${P_GRANTS}/permissions`).set('Authorization', auth).send(body);
    const egress = (auth: string, hosts: any) => request(app).post(`${B}/plugins/${P_GRANTS}/egress-hosts`).set('Authorization', auth).send({ hosts });

    it('`example.com` covers `api.example.com`, never `evilexample.com` (a label boundary, not a suffix)', async () => {
        await perms.setEgressAllowlist(P_GRANTS, ['example.com']);
        assertTokenRefused(await egress(asToken(), ['evilexample.com']), 'suffix without a dot', ['evilexample.com']);
        assert.deepStrictEqual((await dbStored('plugin_egress_hosts'))[P_GRANTS], ['example.com']);
        const sub = await egress(asToken(), ['api.example.com']);
        assert.strictEqual(sub.status, 200, JSON.stringify(sub.body));
        assert.deepStrictEqual((await dbStored('plugin_egress_hosts'))[P_GRANTS], ['api.example.com']);
        // Sending back exactly what is stored changes nothing and is not mistaken for a concurrent write
        // (MySQL reports 0 affected rows for an UPDATE to the same value).
        const same = await egress(asToken(), ['api.example.com']);
        assert.strictEqual(same.status, 200, JSON.stringify(same.body));
        assert.deepStrictEqual((await dbStored('plugin_egress_hosts'))[P_GRANTS], ['api.example.com']);
    });

    it('a hostname entry never covers an IP literal, and an IP entry never a hostname', async () => {
        await perms.setEgressAllowlist(P_GRANTS, ['0.0.1']);
        assertTokenRefused(await egress(asToken(), ['10.0.0.1']), 'IP under a hostname entry', ['10.0.0.1']);
        await perms.setEgressAllowlist(P_GRANTS, ['2.3.4.5']);
        assertTokenRefused(await egress(asToken(), ['x.2.3.4.5']), 'hostname under an IP entry', ['x.2.3.4.5']);
        assert.deepStrictEqual((await dbStored('plugin_egress_hosts'))[P_GRANTS], ['2.3.4.5']);
    });

    it('`scope:admin` implies read and write, never `provider`', async () => {
        await perms.setGrants(P_GRANTS, ['email:admin'], { adminDecision: true });
        assertTokenRefused(await grant(asToken(), { granted: ['email:provider'] }), 'admin → provider', ['email:provider']);
        assert.deepStrictEqual((await dbStored('plugin_grants'))[P_GRANTS], ['email:admin']);
        const narrowed = await grant(asToken(), { granted: ['email:read'] });
        assert.strictEqual(narrowed.status, 200, JSON.stringify(narrowed.body));
        assert.deepStrictEqual((await dbStored('plugin_grants'))[P_GRANTS], ['email:read']);
    });
});

// LAST: the interactive control really restores the snapshot into this database.
describe('POST /backups/:filename/restore', () => {
    const FILE = `wjs-token-restore-${PID}.zip`;
    let filePath = '';

    before(() => {
        const { getBackupPath } = require('../core/backup');
        // An older snapshot: `demoted` was an administrator then, and `ghost` existed.
        const snapshot = {
            version: '1.0',
            content: {
                users: [
                    { id: 1, username: 'demoted', email: 'demoted@example.com', role: 'administrator', displayName: 'Demoted' },
                    { id: 2, username: 'ghost', email: 'ghost@evil.example', role: 'administrator', displayName: 'Ghost' },
                ],
            },
        };
        const zip = new AdmZip();
        zip.addFile('wordjs-content.json', Buffer.from(JSON.stringify(snapshot)));
        // The directory the route restores from (core/backup BACKUPS_DIR), found through its own resolver.
        const dir = path.resolve(__dirname, '../../backups');
        fs.mkdirSync(dir, { recursive: true });
        filePath = path.join(dir, FILE);
        zip.writeZip(filePath);
        assert.strictEqual(getBackupPath(FILE), filePath, 'precondition: the route resolves this file');
    });
    after(() => { try { fs.rmSync(filePath, { force: true }); } catch { /* */ } });

    it('refuses the token before anything is read: no account comes back, no role is raised', async () => {
        const usersBefore = (await dbAsync.get('SELECT COUNT(*) AS n FROM users')).n;
        const res = await request(app).post(`${B}/backups/${FILE}/restore`).set('Authorization', asToken());
        assertTokenRefused(res, 'POST /backups/:filename/restore');
        assert.strictEqual(await User.findByLogin('ghost'), null, 'the snapshot\'s administrator was not restored');
        const demoted = await User.findByLogin('demoted');
        assert.ok(demoted, 'the current accounts are untouched');
        assert.strictEqual(demoted.getRole(), 'subscriber', 'the demotion stands');
        assert.strictEqual((await dbAsync.get('SELECT COUNT(*) AS n FROM users')).n, usersBefore);
        assert.ok(await User.findByLogin('owner'), 'nothing was wiped');
    });

    it('an interactive administrator may restore (control)', async () => {
        // The restore narrates every step on the console; written asynchronously in the middle of the
        // test runner's own frames, those lines can corrupt them, so they are held for the duration.
        const saved = { log: console.log, warn: console.warn, error: console.error };
        console.log = console.warn = console.error = () => {};
        let res: any;
        try {
            res = await request(app).post(`${B}/backups/${FILE}/restore`).set('Authorization', session('owner'));
        } finally {
            Object.assign(console, saved);
        }
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.ok(await User.findByLogin('ghost'), 'the snapshot was restored');
    });
});
