/**
 * conference-manager × PLUGIN-DECLARED ROLES — the two halves, END TO END, through the real core.
 *
 * The user's two rules, proven together here (each half also has its own suite: plugin-declared-roles
 * for the core, conference-manager-team-role for the plugin, lib/__tests__/adminAccess for the guard):
 *
 *   1. "A conference team member can enter ONLY the conference-manager admin page."
 *   2. "The roles a plugin declares can only affect that plugin, never the rest of the core."
 *
 * Nothing in this file is a double of the thing it asserts:
 *   · the REAL marketplace/plugins/conference-manager folder is zipped and installed through the upload
 *     gate (installPluginFromZip), and activated through POST /plugins/:slug/activate — the admin's
 *     activation, which grants what the manifest requests, roles:declare included;
 *   · the plugin's real index.js runs in a REAL isolate (child process), registers its real routes and
 *     its real admin-menu item, and answers through /api/v1/plugin/conference-manager/*, so every
 *     `req.user.pluginCapabilities` it reads is what core/plugin-isolate.ts actually forwarded;
 *   · the account is created by an administrator through POST /users, exactly as the Users screen does;
 *   · the admin route guard is the FRONTEND's own module (frontend/src/lib/adminAccess.ts, the code the
 *     admin layout runs), fed with what the real GET /auth/me and GET /plugins/menus answered.
 *
 * Temp-DB isolation: repoint config.dbPath BEFORE requiring ../config/database (see api.test.ts).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-cm-roles-e2e-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const roles = require('../core/roles');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PLUGIN_SRC = path.join(REPO_ROOT, 'marketplace', 'plugins', 'conference-manager');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PLUGIN_SRC, 'manifest.json'), 'utf8'));
// The guard the admin layout runs. Required by computed path (not imported) so the backend type-check
// does not pull a frontend file into its program; ts-node transpiles it like any other .ts file.
const guard = require(path.join(REPO_ROOT, 'frontend', 'src', 'lib', 'adminAccess.ts'));

const SLUG = 'conference-manager';
const TEAM_ROLE = 'conference_manager_team';
const TEAM_CAP = 'conference_manager_access';
const PLUGIN_PAGE = '/admin/plugin/conference-manager';
const ACCOUNT = '/admin/account';
const ADMIN_PASSWORD = 'Conference-Roles-Admin-1!';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));
require('../core/appRegistry').setApp(app);

const U: Record<string, number> = {};
const tok = (persona: string) => jwt.sign({ userId: U[persona], username: persona }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
const as = (persona: string, method: string, p: string) =>
    (request(app) as any)[method](`/api/v1${p}`).set('Authorization', `Bearer ${tok(persona)}`);
const cm = (persona: string, method: string, p: string) => as(persona, method, `/plugin/${SLUG}${p}`);

let dbAsync: any;
let core: any, pluginRoutes: any;
const installTmps: Array<{ dispose: () => void }> = [];
const pluginDir = () => path.join(core.PLUGINS_DIR, SLUG);

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

/** The plugin folder as the marketplace ships it (no runtime data, no installed modules). */
function zipRealPlugin(): InstanceType<typeof AdmZip> {
    const zip = new AdmZip();
    const walk = (dir: string, rel: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (['node_modules', 'data', '.git', '.DS_Store'].includes(entry.name)) continue;
            const abs = path.join(dir, entry.name);
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(abs, relPath);
            else if (entry.isFile()) zip.addFile(`${SLUG}/${relPath}`, fs.readFileSync(abs));
        }
    };
    walk(PLUGIN_SRC, '');
    return zip;
}

/** Poll (bounded) until `probe` answers truthy — the isolate registers routes and menus after spawn. */
async function waitFor<T>(probe: () => Promise<T>, what: string, tries = 60): Promise<T> {
    let last: T | undefined;
    for (let i = 0; i < tries; i++) {
        last = await probe();
        if (last) return last;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
}

/** What the admin layout knows about a user: GET /auth/me (role + capabilities) and GET /plugins/menus. */
async function adminView(persona: string) {
    const me = await as(persona, 'get', '/auth/me');
    assert.strictEqual(me.status, 200, JSON.stringify(me.body));
    const menus = await as(persona, 'get', '/plugins/menus');
    assert.strictEqual(menus.status, 200, JSON.stringify(menus.body));
    return {
        user: { role: me.body.role, capabilities: me.body.capabilities },
        menus: menus.body as any[],
        pluginItems: (menus.body as any[]).filter((m) => m.plugin !== 'core'),
    };
}

/** Every admin path the app knows: the core routes of the guard's own map, plus the plugin and account pages. */
const coreAdminPaths = () => Array.from(new Set<string>(['/admin', ...guard.ADMIN_ROUTE_RULES.map((r: any) => r.path)]));
const decide = (pathname: string, view: { user: any; menus: any[] }) =>
    guard.decideAdminRoute({ pathname, user: view.user, pluginMenus: view.menus, menusLoaded: true });

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    require('../core/adminMenu').initCoreMenus();
    core = require('../core/plugins');
    pluginRoutes = require('../routes/plugins');
    await require('../core/plugin-permissions').loadGrants();
    assert.strictEqual(fs.existsSync(pluginDir()), false,
        `${pluginDir()} already exists — this suite installs the real plugin there and removes it afterwards`);

    const User = require('../models/User');
    const admin = await User.create({ username: 'admin', email: 'admin@example.com', password: ADMIN_PASSWORD, role: 'administrator' });
    U.admin = admin.id;
    await seedUser('eddie', 'editor');
    await seedUser('sue', 'subscriber');
});

after(async () => {
    try { require('../core/plugin-isolate').unloadIsolatedPlugin(SLUG); } catch { /* */ }
    try { fs.rmSync(pluginDir(), { recursive: true, force: true }); } catch { /* */ }
    for (const t of installTmps) { try { t.dispose(); } catch { /* */ } }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

describe('conference-manager team role, end to end through the core', () => {
    let staffRoleId: number;

    it('the real plugin installs through the upload gate (its roles block is accepted)', async () => {
        const t = pluginRoutes.createInstallTmp();
        installTmps.push(t);
        zipRealPlugin().writeZip(t.zipPath);
        const r = await pluginRoutes.installPluginFromZip(t.zipPath, `${SLUG}.zip`);
        assert.strictEqual(r.ok, true, JSON.stringify(r.body));
        assert.ok(fs.existsSync(path.join(pluginDir(), 'manifest.json')));
        assert.strictEqual(roles.getRole(TEAM_ROLE), null, 'installing registers nothing — only an activation with the grant does');
    });

    it('activation by the administrator registers conference_manager_team with exactly read, access_admin_panel and the plugin capability', async () => {
        const act = await as('admin', 'post', `/plugins/${SLUG}/activate`).send({});
        assert.strictEqual(act.status, 200, JSON.stringify(act.body));
        assert.ok(require('../core/plugin-permissions').isGranted(SLUG, 'roles', 'declare'), 'the activation granted what the manifest requests');

        assert.deepStrictEqual(roles.getRole(TEAM_ROLE), {
            name: 'Equipo de conferencia',
            description: MANIFEST.roles[0].description,
            capabilities: ['read', 'access_admin_panel', TEAM_CAP],
            source: 'plugin',
            plugin: SLUG,
        });
        const list = await as('admin', 'get', '/roles');
        assert.strictEqual(list.status, 200);
        assert.strictEqual(list.body[TEAM_ROLE].pluginInstalled, true);
        assert.strictEqual(list.body[TEAM_ROLE].plugin, SLUG);

        // The plugin's isolate is up: its menu item and routes are registered.
        await waitFor(async () => (await adminView('admin')).pluginItems.some((m) => m.href === PLUGIN_PAGE), 'the plugin menu item');
        await waitFor(async () => (await cm('admin', 'get', '/staff/me')).status === 200, 'the plugin routes');
    });

    it('an administrator creates an account with the role (POST /users, what the Users screen sends)', async () => {
        const r = await as('admin', 'post', '/users').send({
            username: 'ana', email: 'ana@example.com', password: 'Ana-Team-Member-1!', role: TEAM_ROLE,
        });
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        U.ana = r.body.id;
        const me = await as('ana', 'get', '/auth/me');
        assert.strictEqual(me.body.role, TEAM_ROLE);
        assert.deepStrictEqual(me.body.capabilities.slice().sort(), ['access_admin_panel', TEAM_CAP, 'read']);
        // The role's own name, for the admin's user chip (it showed «CONFERENCE_MANAGER_TEAM»): GET /roles,
        // where names live, is administrator-only.
        assert.strictEqual(me.body.roleName, 'Equipo de conferencia');
        assert.strictEqual((await as('admin', 'get', '/auth/me')).body.roleName, 'Administrator');
    });

    it('GET /plugins/menus gives the team member the Conference item and no other plugin item; editors and subscribers do not get it', async () => {
        const ana = await adminView('ana');
        assert.deepStrictEqual(ana.pluginItems.map((m) => [m.href, m.cap, m.plugin]), [[PLUGIN_PAGE, TEAM_CAP, SLUG]]);
        // The only core items are the ones every account holding `read` already had (a subscriber gets the same).
        const sue = await adminView('sue');
        assert.deepStrictEqual(ana.menus.filter((m) => m.plugin === 'core'), sue.menus.filter((m) => m.plugin === 'core'));
        assert.deepStrictEqual(sue.pluginItems, [], 'a subscriber no longer sees the Conference entry');
        assert.deepStrictEqual((await adminView('eddie')).pluginItems.filter((m) => m.href === PLUGIN_PAGE), [],
            'nor does an editor: the entry needs the plugin capability');
        assert.ok((await adminView('admin')).pluginItems.some((m) => m.href === PLUGIN_PAGE), 'the administrator keeps it');
    });

    it('the admin route guard: the team member\'s sidebar is Conference + account, and every other admin path lands on the conference page', async () => {
        const ana = await adminView('ana');
        const { core: coreSection, management } = guard.sidebarSections(ana.user, ana.menus);
        assert.deepStrictEqual([...coreSection, ...management].map((i: any) => i.href), [PLUGIN_PAGE, ACCOUNT]);
        assert.deepStrictEqual(decide(PLUGIN_PAGE, ana), { kind: 'allow' });
        assert.deepStrictEqual(decide(ACCOUNT, ana), { kind: 'allow' });
        // Signing in sends everyone to /admin: the team member lands straight on the conference page.
        assert.deepStrictEqual(decide('/admin', ana), { kind: 'redirect', to: PLUGIN_PAGE });

        // /admin/canvas-frame is the empty document the editor's canvas iframe loads (no data of its own,
        // open to every admin-panel account) — the one core path that is not redirected.
        const redirected = coreAdminPaths().filter((p) => p !== ACCOUNT && p !== '/admin/canvas-frame');
        assert.ok(redirected.length > 25, `the guard map lists the core screens (${redirected.length})`);
        for (const p of [...redirected, '/admin/posts/12', '/admin/users/3', '/admin/settings/site-address', '/admin/plugin/mail-server', '/admin/unknown']) {
            assert.deepStrictEqual(decide(p, ana), { kind: 'redirect', to: PLUGIN_PAGE }, p);
        }
        assert.deepStrictEqual(decide('/admin/canvas-frame', ana), { kind: 'allow' });
    });

    it('the core admin APIs stay closed to the team member (each one answers the administrator)', async () => {
        const probes: Array<[string, string, any?]> = [
            ['get', '/users'],
            ['post', '/users', { username: 'x1', email: 'x1@example.com', password: 'Whatever-Pass-1!', role: 'administrator' }],
            ['get', '/settings/all'],
            ['get', '/roles'],
            ['post', '/roles', { slug: 'sneaky', name: 'Sneaky', capabilities: ['read'] }],
            ['get', '/plugins'],
            ['post', `/plugins/${SLUG}/deactivate`, {}],
            ['post', `/plugins/${SLUG}/permissions`, { granted: [] }],
            ['post', '/posts', { title: 'From the team', status: 'publish' }],
            ['post', '/categories', { name: 'Team category' }],
            ['get', '/audit'],
            ['get', '/webhooks'],
        ];
        for (const [method, p, body] of probes) {
            const r = await as('ana', method, p).send(body);
            assert.strictEqual(r.status, 403, `${method.toUpperCase()} ${p} answered the team member ${r.status}: ${JSON.stringify(r.body)}`);
        }
        // Positive controls (read-only ones, so nothing above changes for the steps that follow).
        for (const p of ['/users', '/settings/all', '/roles', '/plugins', '/audit', '/webhooks']) {
            assert.strictEqual((await as('admin', 'get', p)).status, 200, `GET ${p} as administrator`);
        }
        assert.strictEqual((await as('admin', 'get', `/users/${U.ana}`)).body.role, TEAM_ROLE, 'nothing changed the account');
    });

    it('the role cannot be widened past the plugin: POST /roles refuses a core capability on it', async () => {
        const widen = await as('admin', 'post', '/roles').send({ slug: TEAM_ROLE, name: 'Equipo de conferencia', capabilities: ['read', 'access_admin_panel', TEAM_CAP, 'list_users'] });
        assert.strictEqual(widen.status, 400);
        assert.strictEqual(widen.body.code, 'rest_role_plugin_capability');
        assert.deepStrictEqual(roles.getRole(TEAM_ROLE).capabilities, ['read', 'access_admin_panel', TEAM_CAP]);
        assert.strictEqual((await as('ana', 'get', '/users')).status, 403);
    });

    it('the plugin\'s POST /staff/members accepts only accounts whose role opens the panel', async () => {
        const role = await cm('admin', 'post', '/staff/roles').send({ name: 'Recepción', permissions: { inscriptions: 'view' } });
        assert.strictEqual(role.status, 200, JSON.stringify(role.body));
        staffRoleId = role.body.id;

        for (const persona of ['eddie', 'sue']) {
            const r = await cm('admin', 'post', '/staff/members').send({ user_id: U[persona], role_id: staffRoleId });
            assert.strictEqual(r.status, 400, `${persona}: ${JSON.stringify(r.body)}`);
            assert.strictEqual(r.body.code, 'not_team_role');
        }
        const ok = await cm('admin', 'post', '/staff/members').send({ user_id: U.ana, role_id: staffRoleId });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));

        const members = await cm('admin', 'get', '/staff/members');
        assert.strictEqual(members.status, 200);
        assert.deepStrictEqual(members.body.members.map((m: any) => [m.user_id, m.team_role]), [[U.ana, true]]);
        // roles:declare is granted, so the team role exists and opens the panel (the screen shows no warning).
        assert.strictEqual(members.body.roles_ready, true);
    });

    it('the team member works in the plugin with the sections their team role gives — and nowhere else in it', async () => {
        const me = await cm('ana', 'get', '/staff/me');
        assert.strictEqual(me.status, 200, JSON.stringify(me.body));
        assert.deepStrictEqual([me.body.isAdmin, me.body.isStaff, me.body.teamRole, me.body.member], [false, true, true, true]);
        assert.strictEqual(me.body.permissions.inscriptions, 'view');
        assert.strictEqual(me.body.permissions.settings, 'none');
        assert.strictEqual((await cm('ana', 'get', '/list')).status, 200);
        // Administrator-only plugin screens stay closed, and so does a section the team role does not give.
        assert.strictEqual((await cm('ana', 'get', '/staff/members')).status, 403);
        assert.strictEqual((await cm('ana', 'post', '/create').send({ name: 'Nope', slug: 'nope' })).status, 403);
        // An editor is not a team member (no team role, not on the team).
        assert.strictEqual((await cm('eddie', 'get', '/list')).status, 403);
    });

    it('an administrator can still put an editor on the team: giving the editor role the plugin\'s capability (Users › Roles)', async () => {
        // 2.15.0 let the administrator add any non-administrator to the team. In 2.17.0 the capability opens
        // the panel: the team role carries it, and the administrator may give it to any other role.
        const editor = roles.getRole('editor');
        const give = await as('admin', 'post', '/roles').send({ slug: 'editor', name: editor.name, capabilities: [...editor.capabilities, TEAM_CAP] });
        assert.strictEqual(give.status, 201, JSON.stringify(give.body));
        try {
            // The plugin is told through the users bridge (core/plugin-api.ts) that Eddie's role opens it…
            const added = await cm('admin', 'post', '/staff/members').send({ user_id: U.eddie, role_id: staffRoleId });
            assert.strictEqual(added.status, 200, JSON.stringify(added.body));
            // …and through req.user on his own requests.
            const me = await cm('eddie', 'get', '/staff/me');
            assert.deepStrictEqual([me.body.isStaff, me.body.teamRole, me.body.permissions.inscriptions], [true, true, 'view']);
            assert.strictEqual((await cm('eddie', 'get', '/list')).status, 200);
            // His sidebar: every editorial screen he had, plus Conference.
            const eddie = await adminView('eddie');
            assert.ok(eddie.pluginItems.some((m) => m.href === PLUGIN_PAGE));
            assert.deepStrictEqual(decide(PLUGIN_PAGE, eddie), { kind: 'allow' });
            for (const p of ['/admin', '/admin/posts', '/admin/pages', '/admin/media', '/admin/comments']) assert.deepStrictEqual(decide(p, eddie), { kind: 'allow' }, p);
        } finally {
            const back = await as('admin', 'post', '/roles').send({ slug: 'editor', name: editor.name, capabilities: editor.capabilities });
            assert.strictEqual(back.status, 201);
        }
        // The capability taken off the editor role: out of the panel at once, kept (flagged) on the list.
        assert.strictEqual((await cm('eddie', 'get', '/list')).status, 403);
        const members = await cm('admin', 'get', '/staff/members');
        assert.deepStrictEqual(members.body.members.find((m: any) => m.user_id === U.eddie).team_role, false);
        const row = members.body.members.find((m: any) => m.user_id === U.eddie);
        assert.strictEqual((await cm('admin', 'delete', `/staff/members/${row.id}`)).status, 200);
    });

    it('administrators keep everything: every admin path, every core API, every plugin section', async () => {
        const admin = await adminView('admin');
        assert.deepStrictEqual(admin.user.capabilities, ['*']);
        for (const p of [...coreAdminPaths(), PLUGIN_PAGE, ACCOUNT, '/admin/plugin/anything']) {
            assert.deepStrictEqual(decide(p, admin), { kind: 'allow' }, p);
        }
        const me = await cm('admin', 'get', '/staff/me');
        assert.strictEqual(me.body.isAdmin, true);
        assert.ok(Object.values(me.body.permissions).every((v) => v !== 'none'));
        assert.strictEqual((await cm('admin', 'get', '/list')).status, 200);
        // An editor keeps the screens they had (the dashboard and the editorial ones).
        const eddie = await adminView('eddie');
        assert.deepStrictEqual(decide('/admin', eddie), { kind: 'allow' });
        assert.deepStrictEqual(decide('/admin/posts', eddie), { kind: 'allow' });
        assert.deepStrictEqual(decide(PLUGIN_PAGE, eddie), { kind: 'redirect', to: '/admin' });
    });

    it('revoking roles:declare closes the plugin to the team at once — menu, guard and the plugin\'s own routes — and granting it reopens it', async () => {
        const all = MANIFEST.permissions.map((p: any) => `${p.scope}:${p.access}`);
        const revoke = await as('admin', 'post', `/plugins/${SLUG}/permissions`).send({ granted: all.filter((g: string) => g !== 'roles:declare') });
        assert.strictEqual(revoke.status, 200, JSON.stringify(revoke.body));
        assert.strictEqual(revoke.body.deactivated, false, 'the plugin keeps running for the administrator');

        const ana = await adminView('ana');
        assert.deepStrictEqual(ana.user.capabilities.slice().sort(), ['access_admin_panel', 'read']);
        assert.deepStrictEqual(ana.pluginItems, []);
        assert.deepStrictEqual(decide(PLUGIN_PAGE, ana), { kind: 'redirect', to: ACCOUNT });
        // The plugin reads the forwarded capabilities: same role, no capability → no team access.
        assert.strictEqual((await cm('ana', 'get', '/list')).status, 403);
        assert.strictEqual((await cm('ana', 'get', '/staff/me')).body.teamRole, false);
        assert.strictEqual((await cm('admin', 'get', '/list')).status, 200, 'the administrator is unaffected');

        const grant = await as('admin', 'post', `/plugins/${SLUG}/permissions`).send({ granted: all });
        assert.strictEqual(grant.status, 200, JSON.stringify(grant.body));
        assert.strictEqual(grant.body.rolesError, null);
        assert.deepStrictEqual((await adminView('ana')).pluginItems.map((m) => m.href), [PLUGIN_PAGE]);
        assert.strictEqual((await cm('ana', 'get', '/list')).status, 200);
    });

    it('deactivating the plugin keeps the role (inert: no menu item, no page) for when it comes back', async () => {
        const off = await as('admin', 'post', `/plugins/${SLUG}/deactivate`).send({});
        assert.strictEqual(off.status, 200, JSON.stringify(off.body));
        assert.deepStrictEqual(roles.getRole(TEAM_ROLE).capabilities, ['read', 'access_admin_panel', TEAM_CAP], 'the role stays registered');
        const ana = await adminView('ana');
        assert.strictEqual(ana.user.role, TEAM_ROLE);
        assert.deepStrictEqual(ana.pluginItems, [], 'an inactive plugin serves no menu item');
        assert.deepStrictEqual(decide(PLUGIN_PAGE, ana), { kind: 'redirect', to: ACCOUNT });
        assert.deepStrictEqual(decide('/admin', ana), { kind: 'redirect', to: ACCOUNT });
        assert.strictEqual((await as('ana', 'get', '/users')).status, 403);
    });

    it('deleting the plugin leaves the account with read/access_admin_panel only (the role is kept, orphaned)', async () => {
        const del = await as('admin', 'delete', `/plugins/${SLUG}`).send({ password: ADMIN_PASSWORD });
        assert.strictEqual(del.status, 200, JSON.stringify(del.body));
        assert.deepStrictEqual(del.body.cleanup.roles.orphaned, [TEAM_ROLE]);
        const ana = await adminView('ana');
        assert.strictEqual(ana.user.role, TEAM_ROLE, 'the account keeps its role');
        assert.deepStrictEqual(ana.user.capabilities.slice().sort(), ['access_admin_panel', 'read']);
        assert.deepStrictEqual(ana.pluginItems, []);
        assert.deepStrictEqual(decide('/admin', ana), { kind: 'redirect', to: ACCOUNT });
        assert.strictEqual((await as('ana', 'get', '/users')).status, 403);
    });
});
