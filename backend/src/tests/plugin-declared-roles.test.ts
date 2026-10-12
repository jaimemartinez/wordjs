/**
 * PLUGIN-DECLARED ROLES — "a role a plugin declares can only ever affect that plugin, never the core".
 *
 * A plugin may declare roles in its manifest (conference-manager: a team role whose holders may open the
 * conference screens and nothing else). The contract this file pins, end to end, against the REAL
 * producers — the install gate, core activation, the grant route, the delete route, the roles and users
 * APIs, the auth/me projection and a REAL isolate's route handler:
 *
 *   · NAMESPACE: every declared role slug and capability starts with the plugin's prefix (plugin id,
 *     non [a-z0-9] → "_", plus "_"); anything else refuses the whole block, at upload and at activation.
 *   · The only non-namespaced capabilities such a role ever holds are `read` and `access_admin_panel` —
 *     at registration, through POST /roles, after a tampered option, and after the boot-time syncRoles.
 *   · It never replaces a core role, an administrator's role or another plugin's role, and a capability
 *     inside ANOTHER installed plugin's (nested) namespace is refused.
 *   · Lifecycle: registered on activation WITH the roles:declare grant; inert without it; kept while the
 *     plugin is deactivated; on delete removed when unheld, otherwise orphaned (read/access_admin_panel).
 *   · Its holders reach nothing of the core: /users, /settings/all, POST /posts all refuse.
 *   · A plugin route sees, as req.user.pluginCapabilities, ONLY the caller's capabilities in its namespace.
 *
 * Every "refused" assertion has a positive control next to it (the same call with an allowed value
 * succeeds), so a refusal can never pass because the route was simply broken.
 *
 * Temp-DB isolation: repoint config.dbPath BEFORE requiring ../config/database (see api.test.ts).
 */

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-plugin-roles-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const pluginRoles = require('../core/plugin-roles');
const roles = require('../core/roles');

const SLUG = `rolesprobe${process.pid}`;
const PREFIX = `${SLUG}_`;
const ROLE = `${PREFIX}team`;
const CAP = `${PREFIX}access`;
const ADMIN_PASSWORD = 'Plugin-Roles-Admin-1!';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));
require('../core/appRegistry').setApp(app);

const U: Record<string, number> = {};
const tok = (persona: string) => jwt.sign({ userId: U[persona], username: persona }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
const as = (persona: string, m: string, p: string) =>
    (request(app) as any)[m](`/api/v1${p}`).set('Authorization', `Bearer ${tok(persona)}`);

let dbAsync: any;
let core: any, routes: any, perms: any;
const installTmps: Array<{ dispose: () => void }> = [];

/** The probe plugin: one authenticated route that echoes what the host tells it about the caller. */
const PROBE_CODE = [
    "'use strict';",
    'exports.init = function (wordjs) {',
    "    wordjs.http.route('get', '/whoami', { auth: true }, (req, res) => res.json({ user: req.user }));",
    '};',
    '',
].join('\n');

const goodManifest = (overrides: any = {}) => ({
    id: SLUG,
    name: 'Roles Probe',
    version: '1.0.0',
    isolated: true,
    permissions: [
        { scope: 'express', access: 'register_route', reason: 'Serves the probe route that echoes the caller.' },
        { scope: 'roles', access: 'declare', reason: 'Declares the probe team role for these tests.' },
    ],
    roles: [{ slug: ROLE, name: 'Probe team', description: 'Can open the probe screens.', capabilities: [CAP] }],
    ...overrides,
});

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

async function installProbe(manifest: any) {
    const zip = new AdmZip();
    zip.addFile(`${SLUG}/manifest.json`, Buffer.from(JSON.stringify(manifest)));
    zip.addFile(`${SLUG}/index.js`, Buffer.from(PROBE_CODE));
    const t = routes.createInstallTmp();
    installTmps.push(t);
    zip.writeZip(t.zipPath);
    return await routes.installPluginFromZip(t.zipPath, `${SLUG}.zip`);
}

const pluginDir = () => path.join(core.PLUGINS_DIR, SLUG);
const capsOf = async (persona: string) => (await as(persona, 'get', '/auth/me')).body.capabilities.slice().sort();

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    core = require('../core/plugins');
    routes = require('../routes/plugins');
    perms = require('../core/plugin-permissions');
    await perms.loadGrants();
    try { fs.rmSync(pluginDir(), { recursive: true, force: true }); } catch { /* */ }

    const User = require('../models/User');
    const admin = await User.create({ username: 'admin', email: 'admin@example.com', password: ADMIN_PASSWORD, role: 'administrator' });
    U.admin = admin.id;
    await seedUser('editor', 'editor');
    await seedUser('member', 'subscriber');
    await seedUser('bystander', 'subscriber');
    // A delegate who may change roles but holds none of the probe's capabilities.
    await roles.setRole('promoter', { name: 'Promoter', capabilities: ['read', 'access_admin_panel', 'list_users', 'edit_users', 'promote_users'] });
    await seedUser('promoter', 'promoter');
    // An administrator-made role that was given the probe's capability AND some foreign ones.
    await roles.setRole('eventstaff', { name: 'Event staff', capabilities: ['read', 'access_admin_panel', CAP, 'otherplugin_access', 'edit_posts'] });
    await seedUser('staff', 'eventstaff');
});

after(async () => {
    try { require('../core/plugin-isolate').unloadIsolatedPlugin(SLUG); } catch { /* */ }
    try { fs.rmSync(pluginDir(), { recursive: true, force: true }); } catch { /* */ }
    for (const t of installTmps) { try { t.dispose(); } catch { /* */ } }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

describe('the namespace rules (core/plugin-roles.ts)', () => {
    it('derives the prefix from the plugin id: every non [a-z0-9] character becomes "_"', () => {
        assert.strictEqual(pluginRoles.pluginNamespacePrefix('conference-manager'), 'conference_manager_');
        assert.strictEqual(pluginRoles.pluginNamespacePrefix('a.b-c'), 'a_b_c_');
        assert.strictEqual(pluginRoles.isInPluginNamespace('conference_manager_access', 'conference-manager'), true);
        assert.strictEqual(pluginRoles.isInPluginNamespace('conference_manager_', 'conference-manager'), false, 'the bare prefix is not a capability');
        assert.strictEqual(pluginRoles.isInPluginNamespace('manage_options', 'conference-manager'), false);
    });

    it('the owner of a nested capability is the plugin with the LONGEST matching prefix', () => {
        assert.strictEqual(pluginRoles.capabilityOwner('foo_bar_x', ['foo', 'foo-bar']), 'foo-bar');
        assert.strictEqual(pluginRoles.capabilityOwner('foo_baz', ['foo', 'foo-bar']), 'foo');
        assert.strictEqual(pluginRoles.pluginOwnsCapability('foo', 'foo_bar_x', ['foo-bar']), false);
        assert.strictEqual(pluginRoles.pluginOwnsCapability('foo', 'foo_bar_x', []), true, 'control: without foo-bar installed it is foo\'s');
    });

    it('accepts a well-formed roles block', () => {
        assert.deepStrictEqual(pluginRoles.validateManifestRoles(SLUG, goodManifest()), []);
        assert.deepStrictEqual(pluginRoles.validateManifestRoles(SLUG, { permissions: [] }), [], 'no roles block, nothing to say');
    });

    const refused: Array<[string, (m: any) => void, RegExp]> = [
        ['a core capability', (m) => { m.roles[0].capabilities.push('manage_options'); }, /"manage_options" must start with/],
        ['the wildcard', (m) => { m.roles[0].capabilities.push('*'); }, /not a capability name/],
        ['read listed explicitly (the core adds it itself)', (m) => { m.roles[0].capabilities.push('read'); }, /"read" must start with/],
        ['another plugin\'s capability', (m) => { m.roles[0].capabilities.push('conference_manager_access'); }, /must start with/],
        ['a slug outside the namespace', (m) => { m.roles[0].slug = 'event_team'; }, /must start with/],
        ['a core role slug', (m) => { m.roles[0].slug = 'administrator'; }, /must start with/],
        ['the bare prefix as slug', (m) => { m.roles[0].slug = PREFIX; }, /must start with/],
        ['a provenance key', (m) => { m.roles[0].source = 'core'; }, /unknown key "source"/],
        ['an empty capability list', (m) => { m.roles[0].capabilities = []; }, /non-empty array/],
        ['a duplicated slug', (m) => { m.roles.push({ ...m.roles[0] }); }, /declared twice/],
        ['no roles:declare permission', (m) => { m.permissions = m.permissions.filter((p: any) => p.scope !== 'roles'); }, /roles:declare/],
        ['a non-array block', (m) => { m.roles = { slug: ROLE }; }, /must be an array/],
    ];
    for (const [label, mutate, message] of refused) {
        it(`refuses ${label}`, () => {
            const m = goodManifest();
            mutate(m);
            const problems = pluginRoles.validateManifestRoles(SLUG, m);
            assert.ok(problems.length > 0, `${label} was accepted`);
            assert.match(problems.join(' | '), message);
        });
    }
});

describe('registration refusals and the effective capabilities (core/roles.ts)', () => {
    after(async () => {
        for (const slug of Object.keys(roles.getRoles())) {
            if (/^(foo|a_b)_/.test(slug)) await roles.removeRole(slug);
        }
    });

    const fooManifest = (caps: string[], slug = 'foo_team') => ({
        permissions: [{ scope: 'roles', access: 'declare' }],
        roles: [{ slug, name: 'Foo team', capabilities: caps }],
    });

    it('refuses a capability inside ANOTHER installed plugin\'s nested namespace — and writes nothing', async () => {
        const before = JSON.stringify(roles.getRoles());
        await assert.rejects(roles.registerPluginRoles('foo', fooManifest(['foo_bar_x']), { installedPluginIds: ['foo', 'foo-bar'] }),
            (e: any) => e.code === 'PLUGIN_ROLES_REFUSED' && /belongs to the namespace of plugin "foo-bar"/.test(e.message));
        assert.strictEqual(JSON.stringify(roles.getRoles()), before, 'a refused registration must not half-apply');
    });

    it('refuses two installed plugins sharing a namespace (a-b and a_b)', async () => {
        await assert.rejects(roles.registerPluginRoles('a-b', {
            permissions: [{ scope: 'roles', access: 'declare' }],
            roles: [{ slug: 'a_b_team', name: 'AB', capabilities: ['a_b_x'] }],
        }, { installedPluginIds: ['a-b', 'a_b'] }), /shares the namespace "a_b_"/);
    });

    it('refuses to replace a core role, an administrator\'s role or another plugin\'s role', async () => {
        await roles.setRole('foo_custom', { name: 'Admin made', capabilities: ['read'] });
        await assert.rejects(roles.registerPluginRoles('foo', fooManifest(['foo_x'], 'foo_custom'), { installedPluginIds: ['foo'] }),
            /already exists as a role created by an administrator/);
        assert.deepStrictEqual(roles.getRole('foo_custom').capabilities, ['read'], 'the administrator\'s role is untouched');

        // Another plugin's role: plugin "a_b" registered `a_b_team` and was later deleted (its role kept,
        // orphaned, for the users holding it). Plugin "a-b" maps to the same namespace and declares the same
        // slug — the collision rule cannot see "a_b" any more (not installed), so provenance must refuse.
        const ab = (caps: string[]) => ({ permissions: [{ scope: 'roles', access: 'declare' }], roles: [{ slug: 'a_b_team', name: 'AB', capabilities: caps }] });
        await roles.registerPluginRoles('a_b', ab(['a_b_x']), { installedPluginIds: ['a_b'] });
        await roles.releasePluginRoles('a_b', { countHolders: async () => 1 });
        await assert.rejects(roles.registerPluginRoles('a-b', ab(['a_b_x', 'a_b_more']), { installedPluginIds: ['a-b'] }),
            /role "a_b_team" already exists as a role of plugin "a_b"/);
        assert.strictEqual(roles.getRole('a_b_team').plugin, 'a_b', 'the first plugin keeps its role');
        assert.strictEqual(roles.getRole('a_b_team').orphaned, true);
        // Positive control: the plugin that owns it may take it back (re-adopting the orphan).
        await roles.registerPluginRoles('a_b', ab(['a_b_x']), { installedPluginIds: ['a_b'] });
        assert.strictEqual(roles.getRole('a_b_team').orphaned, undefined);
    });

    it('a later-installed nested plugin takes its capabilities back from the older plugin\'s role', async () => {
        await roles.registerPluginRoles('foo', fooManifest(['foo_x', 'foo_bar_y'], 'foo_team'), { installedPluginIds: ['foo'] });
        assert.ok(roles.getRole('foo_team').capabilities.includes('foo_bar_y'), 'precondition: registered while foo-bar was absent');
        await roles.enforcePluginRoleNamespaces(['foo', 'foo-bar']);
        assert.deepStrictEqual(roles.getRole('foo_team').capabilities.slice().sort(), ['access_admin_panel', 'foo_x', 'read']);
    });

    it('confers its namespaced capabilities ONLY while roles:declare is granted', async () => {
        await roles.registerPluginRoles('foo', fooManifest(['foo_x'], 'foo_team'), { installedPluginIds: ['foo'] });
        perms._setGrantsInMemory('foo', []);
        assert.deepStrictEqual(roles.getRoleCapabilities('foo_team').sort(), ['access_admin_panel', 'read'], 'no grant: inert');
        perms._setGrantsInMemory('foo', ['roles:declare']);
        assert.deepStrictEqual(roles.getRoleCapabilities('foo_team').sort(), ['access_admin_panel', 'foo_x', 'read']);
        perms._setGrantsInMemory('foo', []);
    });

    it('re-registration retires a role the manifest no longer declares (removed when nobody holds it)', async () => {
        const first = await roles.registerPluginRoles('foo', fooManifest(['foo_x'], 'foo_old'), { installedPluginIds: ['foo'] });
        assert.deepStrictEqual(first.removed, ['foo_team'], 'nobody holds foo_team (real user_meta count)');
        const r = await roles.registerPluginRoles('foo', fooManifest(['foo_x'], 'foo_new'), { installedPluginIds: ['foo'], countHolders: async () => 0 });
        assert.deepStrictEqual(r.removed, ['foo_old']);
        assert.strictEqual(roles.getRole('foo_old'), null);
        const held = await roles.registerPluginRoles('foo', { permissions: [] }, { installedPluginIds: ['foo'], countHolders: async () => 3 });
        assert.deepStrictEqual(held.orphaned, ['foo_new'], 'a held role is orphaned, not deleted');
        assert.deepStrictEqual(roles.getRole('foo_new').capabilities.slice().sort(), ['access_admin_panel', 'read']);
        assert.strictEqual(roles.getRole('foo_new').orphaned, true);
    });

    it('the boot sync checks a role the operator\'s config.roles seeds, too', async () => {
        await roles.syncRoles({ evil_team: { name: 'Evil', capabilities: ['read', 'manage_options', 'evil_x'], source: 'plugin', plugin: 'evil' } });
        try {
            assert.deepStrictEqual(roles.getRole('evil_team').capabilities, ['read', 'evil_x']);
        } finally {
            await roles.removeRole('evil_team');
        }
    });

    it('getRole never answers with an inherited name', () => {
        assert.strictEqual(roles.getRole('constructor'), null);
        assert.strictEqual(roles.getRole('__proto__'), null);
    });
});

// The prefix alone is not a namespace when the plugin id IS a core capability verb: plugin `manage` has
// the prefix `manage_`, so `manage_options` "starts with its prefix". These tests pin that no such name
// is ever a plugin capability — declared, stored, conferred or forwarded — and that the reserved verbs
// cover every capability the core defines or checks (so a new core capability cannot reopen the hole).
describe('the core\'s capability vocabulary is never a plugin\'s (plugin ids that are core verbs)', () => {
    const VERB_PLUGIN = 'manage';
    const VERB_ROLE = 'manage_team';
    const verbManifest = (caps: string[]) => ({
        permissions: [{ scope: 'roles', access: 'declare' }],
        roles: [{ slug: VERB_ROLE, name: 'Manage team', capabilities: caps }],
    });
    after(async () => {
        perms._setGrantsInMemory(VERB_PLUGIN, []);
        if (roles.getRole(VERB_ROLE)) await roles.removeRole(VERB_ROLE);
    });

    it('a name that begins with a core verb is in no plugin\'s namespace; the same prefix one letter longer is', () => {
        assert.strictEqual(pluginRoles.isInPluginNamespace('manage_options', 'manage'), false);
        assert.strictEqual(pluginRoles.isInPluginNamespace('edit_flow_items', 'edit-flow'), false, 'a content type\'s capability (flow_item)');
        assert.strictEqual(pluginRoles.isInPluginNamespace('read_private_pages', 'read'), false);
        assert.strictEqual(pluginRoles.isInPluginNamespace('list_users', 'list'), false);
        assert.strictEqual(pluginRoles.capabilityOwner('manage_options', ['manage', 'conference-manager']), null);
        // Positive controls: only the verb itself followed by "_" is reserved.
        assert.strictEqual(pluginRoles.isInPluginNamespace('manager_access', 'manager'), true);
        assert.strictEqual(pluginRoles.isInPluginNamespace('editorial_access', 'editorial'), true);
        assert.strictEqual(pluginRoles.isInPluginNamespace('conference_manager_access', 'conference-manager'), true);
    });

    it('the manifest check refuses it with a reason; a plugin id that is not a verb passes', () => {
        const problems = pluginRoles.validateManifestRoles(VERB_PLUGIN, verbManifest(['manage_options']));
        assert.ok(problems.length > 0, 'plugin "manage" declared manage_options and was accepted');
        assert.match(problems.join(' | '), /"manage_options" is a name from the core's own capability vocabulary/);
        assert.match(pluginRoles.validateManifestRoles('edit-flow', {
            permissions: [{ scope: 'roles', access: 'declare' }],
            roles: [{ slug: 'edit_flow_team', name: 'Flow', capabilities: ['edit_flow_items'] }],
        }).join(' | '), /"edit_flow_items" is a name from the core's own capability vocabulary/);
        assert.deepStrictEqual(pluginRoles.validateManifestRoles('manager', {
            permissions: [{ scope: 'roles', access: 'declare' }],
            roles: [{ slug: 'manager_team', name: 'Managers', capabilities: ['manager_access'] }],
        }), []);
    });

    it('registration refuses it and writes nothing', async () => {
        const before = JSON.stringify(roles.getRoles());
        await assert.rejects(roles.registerPluginRoles(VERB_PLUGIN, verbManifest(['manage_options']), { installedPluginIds: [VERB_PLUGIN] }),
            (e: any) => e.code === 'PLUGIN_ROLES_REFUSED' && /manage_options/.test(e.message));
        assert.strictEqual(JSON.stringify(roles.getRoles()), before);
    });

    it('a stored record that says otherwise confers nothing of the core, is not forwarded, and the boot sync cuts it', async () => {
        const { updateOption } = require('../core/options');
        const tampered = JSON.parse(JSON.stringify(roles.getRoles()));
        tampered[VERB_ROLE] = { name: 'Manage team', capabilities: ['read', 'access_admin_panel', 'manage_options', 'manage_categories'], source: 'plugin', plugin: VERB_PLUGIN };
        await updateOption('wordjs_user_roles', tampered);
        await roles.loadRoles();
        perms._setGrantsInMemory(VERB_PLUGIN, ['roles:declare']);
        await seedUser('verbholder', VERB_ROLE);

        assert.deepStrictEqual(roles.getRoleCapabilities(VERB_ROLE).slice().sort(), ['access_admin_panel', 'read']);
        const User = require('../models/User');
        const holder = await User.findById(U.verbholder);
        assert.strictEqual(holder.can('manage_options'), false);
        assert.strictEqual(holder.can('manage_categories'), false);
        assert.deepStrictEqual((await as('verbholder', 'get', '/auth/me')).body.capabilities.slice().sort(), ['access_admin_panel', 'read']);
        assert.strictEqual((await as('verbholder', 'get', '/forms/submissions')).status, 403, 'a can(manage_options) route');
        assert.strictEqual((await as('admin', 'get', '/forms/submissions')).status, 200, 'positive control: the route answers an administrator');
        assert.deepStrictEqual(roles.pluginCapabilitiesFor(holder, VERB_PLUGIN, []), [], 'nothing forwarded to plugin "manage"');
        assert.deepStrictEqual(roles.pluginCapabilitiesFor({ role: 'administrator' }, VERB_PLUGIN, []), []);

        await roles.syncRoles({}, [VERB_PLUGIN]);
        assert.deepStrictEqual(roles.getRole(VERB_ROLE).capabilities, ['read', 'access_admin_panel']);
        const setRes = await as('admin', 'post', '/roles').send({ slug: VERB_ROLE, name: 'Manage team', capabilities: ['read', 'manage_options'] });
        assert.strictEqual(setRes.status, 400, 'and the admin API refuses to put it back');
        assert.strictEqual(setRes.body.code, 'rest_role_plugin_capability');
    });

    it('the reserved verbs cover every capability the core defines or checks (backend gates, built-in roles, content types, the admin screens)', () => {
        const found = new Map<string, string>(); // capability → where
        const add = (cap: string, where: string) => { if (!found.has(cap)) found.set(cap, where); };
        const srcRoot = path.resolve(__dirname, '..');
        const walk = (dir: string, out: string[] = []) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name === 'tests' || e.name === 'node_modules') continue;
                const abs = path.join(dir, e.name);
                if (e.isDirectory()) walk(abs, out);
                else if (/\.(ts|js)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(abs);
            }
            return out;
        };
        // Every literal handed to the permission middleware or to user.can().
        const GATE_RE = /\b(?:can|canAny|canAll|ownerOrCan)\(\s*(\[[^\]]*\]|'[a-z_]+'|"[a-z_]+")|\.can\(\s*('[a-z_]+'|"[a-z_]+")/g;
        for (const file of walk(srcRoot)) {
            const text = fs.readFileSync(file, 'utf8');
            for (const m of text.matchAll(GATE_RE)) {
                for (const lit of (m[1] || m[2]).matchAll(/['"]([a-z_]+)['"]/g)) add(lit[1], path.relative(srcRoot, file));
            }
        }
        const gateCount = found.size;
        // The built-in roles, the capability families of the built-in content types, and the admin screens' map.
        for (const slug of pluginRoles.CORE_ROLE_SLUGS) (roles.getRole(slug)?.capabilities || []).forEach((c: string) => add(c, `role ${slug}`));
        const { defaultOperationsFor } = require('../core/content-schema');
        for (const type of ['post', 'page']) {
            Object.values(defaultOperationsFor(type)).forEach((c: any) => add(String(c), `content type ${type}`));
            add(`read_private_${type}s`, `content type ${type}`);
        }
        const guard = require(path.resolve(__dirname, '../../../frontend/src/lib/adminAccess.ts'));
        for (const rule of guard.ADMIN_ROUTE_RULES) rule.anyOf.forEach((c: string) => add(c, `admin route ${rule.path}`));
        found.delete('*');

        assert.ok(gateCount >= 10, `the scan found the backend's capability gates (${gateCount})`);
        assert.ok(found.has('manage_options') && found.has('edit_others_posts') && found.has('edit_theme_options'));
        const unreserved = Array.from(found.entries()).filter(([cap]) => !pluginRoles.isCoreCapabilityName(cap));
        assert.deepStrictEqual(unreserved, [],
            'a core capability uses a verb missing from CORE_CAPABILITY_VERBS (core/plugin-roles.ts) — a plugin named after that verb could declare it');
    });
});

// Review round: the holes an adversarial review of the feature found, each pinned with a positive control.
describe('a plugin role reaches nothing outside its plugin — the review round', () => {
    const declare = (slug: string, caps: string[], name = 'Team') => ({
        permissions: [{ scope: 'roles', access: 'declare' }],
        roles: [{ slug, name, capabilities: caps }],
    });
    const created: string[] = [];
    // Each test removes the roles it made, so a later test's namespace enforcement (which orphans the role
    // of any plugin missing from the installed list it is given) never sees them.
    const cleanUp = async () => {
        for (const slug of Object.keys(roles.getRoles())) {
            if (created.some((p) => slug.startsWith(p))) await roles.removeRole(slug);
        }
    };
    afterEach(cleanUp);

    it('a capability that gates a content type is never a plugin role\'s — not registered, not conferred, not forwarded, not writable, cut at boot', async () => {
        // Plugin `evp` — its prefix is `evp_`. An administrator creates a content type whose operations happen
        // to carry that prefix (any name /^[a-z][a-z0-9_]*$/ is allowed there).
        const PLUGIN = 'evp';
        created.push('evp_');
        perms._setGrantsInMemory(PLUGIN, ['roles:declare']);
        // Registered BEFORE the type exists: the capability is the plugin's then.
        await roles.registerPluginRoles(PLUGIN, declare('evp_team', ['evp_access', 'evp_publish', 'evp_edit']), { installedPluginIds: [PLUGIN] });
        await seedUser('evholder', 'evp_team');
        assert.ok(roles.getRoleCapabilities('evp_team').includes('evp_publish'), 'precondition: no type gates it yet');

        const { legacyPostTypeToContentSchema, normalizeContentTypeSchema } = require('../core/content-schema');
        const schema = legacyPostTypeToContentSchema('evpitem', { label: 'Evp items', supports: ['title', 'editor'], showInRest: true });
        schema.permissions.operations = {
            create: 'evp_edit', edit: 'evp_edit', publish: 'evp_publish', delete: 'evp_delete',
            editPublished: 'evp_edit_published', deletePublished: 'evp_delete_published',
            editOthers: 'evp_edit_others', deleteOthers: 'evp_delete_others',
        };
        const made = await as('admin', 'post', '/types').send(normalizeContentTypeSchema(schema));
        assert.strictEqual(made.status, 201, JSON.stringify(made.body));
        try {
            // Conferred: the type's capabilities drop out at once; the plugin's own one stays (positive control).
            assert.deepStrictEqual(roles.getRoleCapabilities('evp_team').slice().sort(), ['access_admin_panel', 'evp_access', 'read']);
            const post = await as('evholder', 'post', '/posts').send({ title: 'Injected', content: '<p>x</p>', type: 'evpitem', status: 'publish' });
            assert.strictEqual(post.status, 403, `a plugin role created core content: ${post.status} ${JSON.stringify(post.body).slice(0, 200)}`);
            const adminPost = await as('admin', 'post', '/posts').send({ title: 'Control', content: '<p>x</p>', type: 'evpitem', status: 'publish' });
            assert.ok(adminPost.status === 200 || adminPost.status === 201, `control: the type works (${adminPost.status})`);
            // Forwarded: not to the plugin either.
            assert.deepStrictEqual(roles.pluginCapabilitiesFor({ role: 'evp_team' }, PLUGIN, [PLUGIN]), ['evp_access']);
            // Registration: refused, with the reason, and nothing written.
            const before = JSON.stringify(roles.getRoles());
            await assert.rejects(roles.registerPluginRoles(PLUGIN, declare('evp_team', ['evp_access', 'evp_publish']), { installedPluginIds: [PLUGIN] }),
                (e: any) => e.code === 'PLUGIN_ROLES_REFUSED' && /"evp_publish" gates a content type/.test(e.message));
            assert.strictEqual(JSON.stringify(roles.getRoles()), before, 'a refused registration must not half-apply');
            // The admin API refuses adding it; the plugin's own capability is accepted (positive control).
            const bad = await as('admin', 'post', '/roles').send({ slug: 'evp_team', name: 'Team', capabilities: ['read', 'evp_access', 'evp_delete'] });
            assert.strictEqual(bad.status, 400);
            assert.strictEqual(bad.body.code, 'rest_role_plugin_capability');
            // The boot sync cuts what is stored.
            await roles.syncRoles({}, [PLUGIN]);
            assert.deepStrictEqual(roles.getRole('evp_team').capabilities.slice().sort(), ['access_admin_panel', 'evp_access', 'read']);
        } finally {
            await as('admin', 'delete', '/types/evpitem');
            perms._setGrantsInMemory(PLUGIN, []);
        }
    });

    it('a grant revoked on another node reaches this node through the option-changed signal (multi-node)', async () => {
        const PLUGIN = 'mnp';
        created.push('mnp_');
        await perms.setGrants(PLUGIN, ['roles:declare']);
        await roles.registerPluginRoles(PLUGIN, declare('mnp_team', ['mnp_x']), { installedPluginIds: [PLUGIN] });
        assert.ok(roles.getRoleCapabilities('mnp_team').includes('mnp_x'));
        // Node A revokes: it writes the option; this node only hears the signal.
        const { getOption, updateOption } = require('../core/options');
        const stored = (await getOption('plugin_grants', {})) || {};
        await updateOption('plugin_grants', { ...stored, [PLUGIN]: [] });
        assert.ok(roles.getRoleCapabilities('mnp_team').includes('mnp_x'), 'precondition: the in-process mirror is stale until the signal');
        await require('../core/coherence').handleOptionChange('plugin_grants');
        assert.deepStrictEqual(roles.getRoleCapabilities('mnp_team').slice().sort(), ['access_admin_panel', 'read'], 'the revoke reached this node');
        // And the other direction: a grant from node A reaches this node too.
        await updateOption('plugin_grants', { ...stored, [PLUGIN]: ['roles:declare'] });
        await require('../core/coherence').handleOptionChange('plugin_grants');
        assert.ok(roles.getRoleCapabilities('mnp_team').includes('mnp_x'));
        await perms.removeGrants(PLUGIN);
    });

    it('a role slug in ANOTHER installed plugin\'s (nested) namespace is refused, and orphaned when that plugin arrives later', async () => {
        const OUTER = 'sqp';            // prefix sqp_
        const INNER = 'sqp-inner';      // prefix sqp_inner_ — nested inside sqp_
        created.push('sqp_');
        // While sqp-inner is installed, sqp may not take a slug in its namespace…
        await assert.rejects(roles.registerPluginRoles(OUTER, declare('sqp_inner_team', ['sqp_x'], 'Equipo'), { installedPluginIds: [OUTER, INNER] }),
            /role "sqp_inner_team" is in the namespace of plugin "sqp-inner"/);
        assert.strictEqual(roles.getRole('sqp_inner_team'), null);
        // …while a slug of its own is fine (positive control),
        await roles.registerPluginRoles(OUTER, declare('sqp_team', ['sqp_x']), { installedPluginIds: [OUTER, INNER] });
        assert.strictEqual(roles.getRole('sqp_team').plugin, OUTER);
        // …and with sqp-inner absent the nested slug is still sqp's.
        await roles.registerPluginRoles(OUTER, {
            permissions: [{ scope: 'roles', access: 'declare' }],
            roles: [
                { slug: 'sqp_team', name: 'Team', capabilities: ['sqp_x'] },
                { slug: 'sqp_inner_team', name: 'Equipo', capabilities: ['sqp_x'] },
            ],
        }, { installedPluginIds: [OUTER] });
        assert.strictEqual(roles.getRole('sqp_inner_team').plugin, OUTER);
        // sqp-inner is installed afterwards: the squatted slug is orphaned (it confers nothing), the other kept.
        const changed = await roles.enforcePluginRoleNamespaces([OUTER, INNER]);
        assert.ok(changed.includes('sqp_inner_team') && !changed.includes('sqp_team'), JSON.stringify(changed));
        assert.strictEqual(roles.getRole('sqp_inner_team').orphaned, true);
        assert.deepStrictEqual(roles.getRole('sqp_inner_team').capabilities.slice().sort(), ['access_admin_panel', 'read']);
        assert.strictEqual(roles.getRole('sqp_team').orphaned, undefined);
        assert.strictEqual(pluginRoles.roleSlugOwner('sqp_inner_team', [OUTER, INNER]), INNER);
        assert.strictEqual(pluginRoles.roleSlugOwner('sqp_team', [OUTER, INNER]), OUTER);
    });

    it('a namespace two installed plugins share is owned by neither: enforcement trims what the first one registered', async () => {
        created.push('a_b_', 'ab_');
        perms._setGrantsInMemory('a_b', ['roles:declare']);
        perms._setGrantsInMemory('ab', ['roles:declare']);
        await roles.registerPluginRoles('a_b', declare('a_b_team', ['a_b_access']), { installedPluginIds: ['a_b'] });
        await roles.registerPluginRoles('ab', declare('ab_team', ['ab_access']), { installedPluginIds: ['ab'] });
        assert.ok(roles.getRoleCapabilities('a_b_team').includes('a_b_access'), 'precondition: a-b was not installed yet');
        assert.strictEqual(pluginRoles.capabilityOwner('a_b_access', ['a_b']), 'a_b', 'control: alone, it owns its namespace');
        assert.strictEqual(pluginRoles.capabilityOwner('a_b_access', ['a_b', 'a-b']), null, 'a shared namespace has no owner');
        // a-b arrives (same prefix a_b_): the namespace is shared, so a_b's role loses what was in it.
        const changed = await roles.enforcePluginRoleNamespaces(['a_b', 'a-b', 'ab']);
        assert.ok(changed.includes('a_b_team') && !changed.includes('ab_team'), JSON.stringify(changed));
        assert.deepStrictEqual(roles.getRoleCapabilities('a_b_team').slice().sort(), ['access_admin_panel', 'read']);
        assert.ok(roles.getRoleCapabilities('ab_team').includes('ab_access'), 'control: a plugin with a namespace of its own keeps it');
        perms._setGrantsInMemory('a_b', []);
        perms._setGrantsInMemory('ab', []);
    });

    it('an administrator\'s edit to a plugin role survives every refresh from the manifest', async () => {
        const PLUGIN = 'rvp';
        created.push('rvp_');
        perms._setGrantsInMemory(PLUGIN, ['roles:declare']);
        const v1 = declare('rvp_team', ['rvp_access', 'rvp_reports']);
        await roles.registerPluginRoles(PLUGIN, v1, { installedPluginIds: [PLUGIN] });
        // The administrator closes the plugin's screens to the role and adds a capability of their own.
        await roles.setRole('rvp_team', { name: 'Team', capabilities: ['read', 'access_admin_panel', 'rvp_reports', 'rvp_extra'] }, { installedPluginIds: [PLUGIN] });
        assert.deepStrictEqual(roles.getRole('rvp_team').adminChanges, { added: ['rvp_extra'], removed: ['rvp_access'] });
        // A boot / activation / permission change refreshes it from the same manifest: the edit stays.
        await roles.registerPluginRoles(PLUGIN, v1, { installedPluginIds: [PLUGIN] });
        assert.deepStrictEqual(roles.getRoleCapabilities('rvp_team').slice().sort(), ['access_admin_panel', 'read', 'rvp_extra', 'rvp_reports']);
        // A new version of the plugin declares one more capability: it arrives, the edit still stands.
        await roles.registerPluginRoles(PLUGIN, declare('rvp_team', ['rvp_access', 'rvp_reports', 'rvp_new']), { installedPluginIds: [PLUGIN] });
        assert.deepStrictEqual(roles.getRoleCapabilities('rvp_team').slice().sort(), ['access_admin_panel', 'read', 'rvp_extra', 'rvp_new', 'rvp_reports']);
        // Giving the capability back and dropping the extra clears the record (the role is the plugin's again).
        await roles.setRole('rvp_team', { name: 'Team', capabilities: ['read', 'access_admin_panel', 'rvp_access', 'rvp_reports', 'rvp_new'] }, { installedPluginIds: [PLUGIN] });
        assert.strictEqual(roles.getRole('rvp_team').adminChanges, undefined);
        await roles.registerPluginRoles(PLUGIN, declare('rvp_team', ['rvp_access', 'rvp_reports', 'rvp_new']), { installedPluginIds: [PLUGIN] });
        assert.ok(roles.getRoleCapabilities('rvp_team').includes('rvp_access'));
        perms._setGrantsInMemory(PLUGIN, []);
    });

    it('a role edit made while a plugin-role write is counting holders is not overwritten (one writer at a time)', async () => {
        const PLUGIN = 'lup';
        created.push('lup_');
        await roles.registerPluginRoles(PLUGIN, declare('lup_team', ['lup_x']), { installedPluginIds: [PLUGIN] });
        const editor = roles.getRole('editor');
        assert.ok(editor.capabilities.includes('manage_categories'), 'precondition');
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => { release = r; });
        let counting = false;
        const deleting = roles.releasePluginRoles(PLUGIN, { countHolders: async () => { counting = true; await gate; return 0; } });
        while (!counting) await new Promise((r) => setTimeout(r, 5));
        // The administrator revokes a capability from the editor role while the plugin's delete is counting.
        const revoking = roles.setRole('editor', { name: editor.name, capabilities: editor.capabilities.filter((c: string) => c !== 'manage_categories') });
        release();
        await Promise.all([deleting, revoking]);
        const { getOption } = require('../core/options');
        assert.ok(!roles.getRoleCapabilities('editor').includes('manage_categories'), 'the revocation is kept in the cache');
        assert.ok(!(await getOption('wordjs_user_roles')).editor.capabilities.includes('manage_categories'), 'and in the database');
        assert.strictEqual(roles.getRole('lup_team'), null, 'and the plugin\'s role went with it');
        await roles.setRole('editor', { name: editor.name, capabilities: editor.capabilities });
    });

    it('a leftover plugin role cannot be deleted under its holders; a role of a plugin that is not installed is orphaned at boot', async () => {
        const PLUGIN = 'dgp';
        created.push('dgp_');
        perms._setGrantsInMemory(PLUGIN, ['roles:declare']);
        await roles.registerPluginRoles(PLUGIN, declare('dgp_team', ['dgp_x']), { installedPluginIds: [PLUGIN] });
        await seedUser('dgholder', 'dgp_team');
        assert.ok(roles.getRoleCapabilities('dgp_team').includes('dgp_x'), 'precondition');
        // The plugin's folder disappears without the delete route (removed by hand, a restored backup): the
        // boot sync, which knows the installed plugins, orphans its role.
        await roles.syncRoles({}, ['someotherplugin']);
        assert.strictEqual(roles.getRole('dgp_team').orphaned, true);
        assert.deepStrictEqual(roles.getRoleCapabilities('dgp_team').slice().sort(), ['access_admin_panel', 'read']);
        // Deleting it under its holder would leave them a dangling role the next plugin could hand back.
        const refused = await as('admin', 'delete', '/roles/dgp_team');
        assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
        assert.strictEqual(refused.body.code, 'rest_role_in_use');
        assert.strictEqual(refused.body.data.holders, 1);
        assert.ok(roles.getRole('dgp_team'));
        // Positive control: once the holder has another role, it goes.
        assert.strictEqual((await as('admin', 'put', `/users/${U.dgholder}`).send({ role: 'subscriber' })).status, 200);
        assert.strictEqual((await as('admin', 'delete', '/roles/dgp_team')).status, 200);
        assert.strictEqual(roles.getRole('dgp_team'), null);
        perms._setGrantsInMemory(PLUGIN, []);
    });

    it('a plugin\'s menu item may point at its own admin page only', () => {
        const { registerAdminMenu, unregisterAdminMenu, getAdminMenuItems } = require('../core/adminMenu');
        const ID = `menuprobe${process.pid}`;
        const dir = path.join(core.PLUGINS_DIR, ID);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            id: ID, name: 'Menu probe', isolated: true,
            frontend: { adminPage: { entry: './client/admin/page.tsx', slug: 'menuprobe-page' } },
        }));
        try {
            registerAdminMenu(ID, { href: '/admin/plugin/conference-manager', label: 'Not mine', cap: `${ID}_access` });
            registerAdminMenu(ID, { href: '/admin/plugin/%63onference-manager?tab=x', label: 'Encoded', cap: `${ID}_access` });
            registerAdminMenu(ID, { href: '/admin/plugin/menuprobe-page', label: 'Mine', cap: `${ID}_access` });
            registerAdminMenu(ID, { href: '/admin/plugin/menuprobe-page/sub?x=1', label: 'Mine too', cap: `${ID}_access` });
            const hrefs = getAdminMenuItems().filter((i: any) => i.plugin === ID).map((i: any) => i.href);
            assert.deepStrictEqual(hrefs.sort(), ['/admin/plugin/menuprobe-page', '/admin/plugin/menuprobe-page/sub?x=1']);
            // A plugin without an admin page has no plugin page to point at; the core keeps its freedom.
            registerAdminMenu('nopageplugin', { href: '/admin/plugin/menuprobe-page', label: 'x', cap: 'read' });
            assert.ok(!getAdminMenuItems().some((i: any) => i.plugin === 'nopageplugin'));
            registerAdminMenu('core', { href: '/admin/plugin/anything', label: 'Core', cap: 'read' });
            assert.ok(getAdminMenuItems().some((i: any) => i.plugin === 'core' && i.href === '/admin/plugin/anything'));
        } finally {
            unregisterAdminMenu(ID);
            unregisterAdminMenu('core');
            require('../core/adminMenu').initCoreMenus();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('naming another installed plugin\'s page as its own admin page does not make it its own', () => {
        const { registerAdminMenu, unregisterAdminMenu, getAdminMenuItems, adminPageOwner } = require('../core/adminMenu');
        const X = `borrower${process.pid}`;          // declares Y's page as its own
        const Y = `pageowner${process.pid}`;         // the plugin installed in that folder
        const ALIAS = `aliasowner${process.pid}`;    // folder ≠ its admin page slug (like youtube-videos → youtube)
        const write = (id: string, page: string) => {
            fs.mkdirSync(path.join(core.PLUGINS_DIR, id), { recursive: true });
            fs.writeFileSync(path.join(core.PLUGINS_DIR, id, 'manifest.json'), JSON.stringify({
                id, name: id, isolated: true, frontend: { adminPage: { entry: './client/admin/page.tsx', slug: page } },
            }));
        };
        const itemsOf = (id: string) => getAdminMenuItems().filter((i: any) => i.plugin === id).map((i: any) => i.href);
        try {
            write(Y, Y);
            write(ALIAS, `${ALIAS}-page`);
            // X's manifest names Y's page — and then ALIAS's page — as its own admin page: neither is X's.
            write(X, Y);
            registerAdminMenu(X, { href: `/admin/plugin/${Y}`, label: 'Borrowed', cap: `${X}_access` });
            write(X, `${ALIAS}-page`);
            registerAdminMenu(X, { href: `/admin/plugin/${ALIAS}-page`, label: 'Borrowed alias', cap: `${X}_access` });
            assert.deepStrictEqual(itemsOf(X), [], 'a borrowed page is refused');
            assert.strictEqual(adminPageOwner(Y), Y);
            assert.strictEqual(adminPageOwner(`${ALIAS}-page`), null, 'a page two installed plugins declare is nobody\'s');
            // Positive controls: each owner's own item is accepted, the alias one included (once X stops claiming it)
            // — Y's from inside its plugin context, where a bridged adminMenu.add runs (io-guard attributes the
            // filesystem to Y there, and the ownership check must still read what is installed).
            require('../core/plugin-context').runWithContext(Y, () => registerAdminMenu(Y, { href: `/admin/plugin/${Y}`, label: 'Mine', cap: `${Y}_access` }));
            write(X, `${X}-page`);
            registerAdminMenu(ALIAS, { href: `/admin/plugin/${ALIAS}-page`, label: 'Mine', cap: `${ALIAS}_access` });
            registerAdminMenu(X, { href: `/admin/plugin/${X}-page`, label: 'Mine', cap: `${X}_access` });
            assert.deepStrictEqual(itemsOf(Y), [`/admin/plugin/${Y}`]);
            assert.deepStrictEqual(itemsOf(ALIAS), [`/admin/plugin/${ALIAS}-page`]);
            assert.deepStrictEqual(itemsOf(X), [`/admin/plugin/${X}-page`]);
        } finally {
            for (const id of [X, Y, ALIAS]) {
                unregisterAdminMenu(id);
                fs.rmSync(path.join(core.PLUGINS_DIR, id), { recursive: true, force: true });
            }
        }
    });

    it('install and activation refuse an admin page another installed plugin answers to', async () => {
        const OWNER = `pgowner${process.pid}`;
        const TAKER = `pgtaker${process.pid}`;
        const manifestFor = (id: string, page: string) => ({
            id, name: id, version: '1.0.0', isolated: true,
            permissions: [{ scope: 'browser', access: 'script', reason: 'Its admin page runs in the browser.' }],
            frontend: { adminPage: { entry: './client/admin/page.tsx', slug: page } },
        });
        const upload = async (id: string, page: string) => {
            const zip = new AdmZip();
            zip.addFile(`${id}/manifest.json`, Buffer.from(JSON.stringify(manifestFor(id, page))));
            zip.addFile(`${id}/index.js`, Buffer.from("'use strict';\nexports.init = function () {};\n"));
            zip.addFile(`${id}/client/admin/page.tsx`, Buffer.from('export default function Page() { return null; }\n'));
            const t = routes.createInstallTmp();
            installTmps.push(t);
            zip.writeZip(t.zipPath);
            return routes.installPluginFromZip(t.zipPath, `${id}.zip`);
        };
        try {
            const owner = await upload(OWNER, OWNER);
            assert.strictEqual(owner.ok, true, owner.body && owner.body.error);
            // Upload: its admin page is another installed plugin's folder → refused, nothing left on disk.
            const taken = await upload(TAKER, OWNER);
            assert.strictEqual(taken.ok, false);
            assert.strictEqual(taken.status, 400);
            assert.match(taken.body.error, new RegExp(`Invalid admin page: Its admin page "${OWNER}"[^]*installed plugin "${OWNER}"`));
            assert.strictEqual(fs.existsSync(path.join(core.PLUGINS_DIR, TAKER)), false);
            // Positive control: the same plugin with an admin page of its own installs.
            const own = await upload(TAKER, `${TAKER}-page`);
            assert.strictEqual(own.ok, true, own.body && own.body.error);
            // Activation re-checks it: a manifest edited on disk to borrow the page is refused before any code runs.
            const manifestPath = path.join(core.PLUGINS_DIR, TAKER, 'manifest.json');
            fs.writeFileSync(manifestPath, JSON.stringify(manifestFor(TAKER, OWNER)));
            await perms.setGrants(TAKER, ['browser:script']);
            await assert.rejects(core.activatePlugin(TAKER), /Invalid admin page in manifest\.json: Its admin page/);
            assert.strictEqual(await core.isPluginActive(TAKER), false);
            // …and so is a plugin whose FOLDER another installed plugin declares as its admin page.
            fs.writeFileSync(manifestPath, JSON.stringify(manifestFor(TAKER, `${TAKER}-page`)));
            fs.writeFileSync(path.join(core.PLUGINS_DIR, OWNER, 'manifest.json'), JSON.stringify(manifestFor(OWNER, TAKER)));
            await assert.rejects(core.activatePlugin(TAKER), new RegExp(`installed plugin "${OWNER}" declares "${TAKER}" as its admin page`));
        } finally {
            for (const id of [TAKER, OWNER]) {
                try { await core.deactivatePlugin(id, { prune: false }); } catch { /* not active */ }
                fs.rmSync(path.join(core.PLUGINS_DIR, id), { recursive: true, force: true });
                await perms.removeGrants(id);
            }
        }
    });

    it('an activation refused for its roles is refused BEFORE the plugin\'s code runs (nothing of its init is left behind)', async () => {
        const ID = `dryprobe${process.pid}`;
        const DRY_ROLE = `${ID}_team`;
        created.push(DRY_ROLE);
        const manifest = {
            id: ID, name: 'Dry-run probe', version: '1.0.0', isolated: true,
            permissions: [
                { scope: 'database', access: 'write', reason: 'Creates the marker table its init leaves behind.' },
                { scope: 'roles', access: 'declare', reason: 'Declares the probe team role for these tests.' },
            ],
            roles: [{ slug: DRY_ROLE, name: 'Dry team', capabilities: [`${ID}_access`] }],
        };
        const code = [
            "'use strict';",
            'exports.init = async function (wordjs) {',
            "    await wordjs.db.createTable(wordjs.db.tablePrefix + 'marker', ['id INT_PK']);",
            '};',
            '',
        ].join('\n');
        const zip = new AdmZip();
        zip.addFile(`${ID}/manifest.json`, Buffer.from(JSON.stringify(manifest)));
        zip.addFile(`${ID}/index.js`, Buffer.from(code));
        const t = routes.createInstallTmp();
        installTmps.push(t);
        zip.writeZip(t.zipPath);
        const installed = await routes.installPluginFromZip(t.zipPath, `${ID}.zip`);
        assert.strictEqual(installed.ok, true, installed.body && installed.body.error);
        const marker = async () => !!(await dbAsync.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [`wjp_${ID}_marker`]));
        try {
            await perms.setGrants(ID, ['database:write', 'roles:declare']);
            // The declared slug is already an administrator's role: refused — and init() never ran.
            await roles.setRole(DRY_ROLE, { name: 'Squatter', capabilities: ['read'] });
            await assert.rejects(core.activatePlugin(ID), /already exists as a role created by an administrator/);
            assert.strictEqual(await core.isPluginActive(ID), false);
            assert.strictEqual(await marker(), false, 'the refused plugin\'s init ran (its table exists)');
            // Positive control: with the slug free the same activation runs init (the observable works).
            await roles.removeRole(DRY_ROLE);
            await core.activatePlugin(ID);
            assert.strictEqual(await marker(), true, 'control: init creates the marker table');
            assert.strictEqual(roles.getRole(DRY_ROLE).plugin, ID);
        } finally {
            try { await core.deactivatePlugin(ID, { prune: false }); } catch { /* not active */ }
            try { fs.rmSync(path.join(core.PLUGINS_DIR, ID), { recursive: true, force: true }); } catch { /* */ }
            await perms.removeGrants(ID);
        }
    });

    it('the capabilities forwarded to a plugin\'s routes respect the INSTALLED nested plugins, running or not', async () => {
        const OUTER = `fwd${process.pid}`;
        const INNER = `${OUTER}-inner`;
        const own = `${pluginRoles.pluginNamespacePrefix(OUTER)}own`;
        const innerCap = `${pluginRoles.pluginNamespacePrefix(INNER)}access`;
        created.push('fwdstaff');
        await roles.setRole('fwdstaff', { name: 'Forward staff', capabilities: ['read', innerCap, own] });
        const innerDir = path.join(core.PLUGINS_DIR, INNER);
        const project = () => require('../core/plugin-isolate').projectRouteUser({ id: 1, role: 'fwdstaff' }, OUTER);
        const pastCacheWindow = () => new Promise((r) => setTimeout(r, 2100)); // core/plugins.ts INSTALLED_IDS_TTL_MS
        await pastCacheWindow();
        assert.deepStrictEqual(project().pluginCapabilities, [innerCap, own].sort(), 'control: without the nested plugin both are OUTER\'s');
        fs.mkdirSync(innerDir, { recursive: true });
        fs.writeFileSync(path.join(innerDir, 'manifest.json'), JSON.stringify({ id: INNER, name: 'Inner', isolated: true }));
        try {
            await pastCacheWindow();
            // INNER is installed but not running: OUTER is still not told about INNER's capability.
            assert.deepStrictEqual(project().pluginCapabilities, [own]);
        } finally {
            fs.rmSync(innerDir, { recursive: true, force: true });
        }
    });
});

describe('end to end: install, activate, assign, forward, refuse, revoke, delete', () => {
    it('the upload gate refuses a roles block that reaches outside the namespace — nothing stays on disk', async () => {
        const bad = goodManifest();
        bad.roles[0].capabilities.push('manage_options');
        const r = await installProbe(bad);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, 400);
        assert.match(r.body.error, /Invalid roles:[\s\S]*manage_options/);
        assert.strictEqual(fs.existsSync(pluginDir()), false, 'a refused upload leaves nothing behind');

        const good = await installProbe(goodManifest());
        assert.strictEqual(good.ok, true, good.body && good.body.error);
    });

    it('activation WITHOUT the roles:declare grant runs the plugin but registers no role', async () => {
        await perms.setGrants(SLUG, ['express:register_route']);
        await core.activatePlugin(SLUG);
        assert.strictEqual(await core.isPluginActive(SLUG), true);
        assert.strictEqual(roles.getRole(ROLE), null, 'a declared-but-denied role must not exist');
        await core.deactivatePlugin(SLUG, { prune: false });
    });

    it('activation is REFUSED when a declared slug is already an administrator\'s role — and does not half-apply', async () => {
        await roles.setRole(ROLE, { name: 'Squatter', capabilities: ['read', 'edit_posts'] });
        await perms.setGrants(SLUG, ['express:register_route', 'roles:declare']);
        await assert.rejects(core.activatePlugin(SLUG), /already exists as a role created by an administrator/);
        assert.strictEqual(await core.isPluginActive(SLUG), false, 'the plugin must not be active');
        assert.strictEqual(require('../core/plugin-isolate').isIsolated(SLUG), false, 'its isolate was torn down');
        assert.deepStrictEqual(roles.getRole(ROLE), { name: 'Squatter', capabilities: ['read', 'edit_posts'] }, 'the existing role is untouched');
        await roles.removeRole(ROLE);
    });

    it('activation WITH the grant registers the role, with provenance, inside the namespace', async () => {
        await core.activatePlugin(SLUG);
        assert.strictEqual(await core.isPluginActive(SLUG), true);
        const role = roles.getRole(ROLE);
        assert.deepStrictEqual(role, {
            name: 'Probe team', description: 'Can open the probe screens.',
            capabilities: ['read', 'access_admin_panel', CAP], source: 'plugin', plugin: SLUG,
        });
        const list = await as('admin', 'get', '/roles');
        assert.strictEqual(list.status, 200);
        assert.strictEqual(list.body[ROLE].source, 'plugin');
        assert.strictEqual(list.body[ROLE].pluginInstalled, true);
    });

    it('an administrator assigns it; its holder holds read, access_admin_panel and the plugin capability — nothing else', async () => {
        const holders = async () => ((await as('admin', 'get', '/plugins')).body.find((p: any) => p.slug === SLUG) || {}).roles[0].holders;
        assert.strictEqual(await holders(), 0, 'the grant screen counts who already holds each declared role');
        const put = await as('admin', 'put', `/users/${U.member}`).send({ role: ROLE });
        assert.strictEqual(put.status, 200, JSON.stringify(put.body));
        assert.deepStrictEqual(await capsOf('member'), ['access_admin_panel', CAP, 'read'].sort());
        assert.strictEqual(await holders(), 1);
    });

    it('its holder reaches nothing of the core', async () => {
        assert.strictEqual((await as('member', 'get', '/users')).status, 403);
        assert.strictEqual((await as('member', 'get', '/settings/all')).status, 403);
        assert.strictEqual((await as('member', 'post', '/posts').send({ title: 'x' })).status, 403);
        assert.strictEqual((await as('member', 'get', '/roles')).status, 403);
        // Positive control: the same routes answer an editor/administrator.
        assert.strictEqual((await as('admin', 'get', '/settings/all')).status, 200);
    });

    it('a delegate holding promote_users cannot hand out the plugin role (it would amplify past their own caps)', async () => {
        const res = await as('promoter', 'put', `/users/${U.bystander}`).send({ role: ROLE });
        assert.strictEqual(res.status, 403);
        assert.match(res.body.message, /beyond your own/);
        // Positive control: a role within the delegate's own capabilities is assignable.
        assert.strictEqual((await as('promoter', 'put', `/users/${U.bystander}`).send({ role: 'subscriber' })).status, 200);
    });

    it('the plugin route sees ONLY the caller\'s capabilities in its own namespace', async () => {
        const whoami = (persona: string) => as(persona, 'get', `/plugin/${SLUG}/whoami`);
        // The child registers its route asynchronously after spawn: wait (bounded) for it to be mounted.
        let member: any = await whoami('member');
        for (let i = 0; i < 30 && member.status === 404; i++) {
            await new Promise((r) => setTimeout(r, 100));
            member = await whoami('member');
        }
        assert.strictEqual(member.status, 200, JSON.stringify(member.body));
        assert.deepStrictEqual(member.body.user.pluginCapabilities, [CAP]);
        assert.strictEqual(member.body.user.role, ROLE);
        // An administrator-made role carrying the capability: forwarded, and its foreign/core caps are not.
        assert.deepStrictEqual((await whoami('staff')).body.user.pluginCapabilities, [CAP]);
        assert.deepStrictEqual((await whoami('editor')).body.user.pluginCapabilities, []);
        // An administrator holds every capability the plugin's own roles confer.
        assert.deepStrictEqual((await whoami('admin')).body.user.pluginCapabilities, [CAP]);
    });

    it('the users bridge tells the plugin the SAME own-namespace capabilities of any account (who its screens are open to)', async () => {
        // The bridge object the isolate's RPC calls into (the users:read gate itself is pinned in plugin-api.test).
        const api = require('../core/plugin-api').createPluginApi(SLUG);
        assert.deepStrictEqual((await api.users.findById(U.member)).pluginCapabilities, [CAP]);
        assert.deepStrictEqual((await api.users.findById(U.staff)).pluginCapabilities, [CAP], 'an administrator-made role carrying the capability');
        assert.deepStrictEqual((await api.users.findById(U.editor)).pluginCapabilities, []);
        assert.deepStrictEqual((await api.users.findById(U.admin)).pluginCapabilities, [CAP]);
        assert.deepStrictEqual((await api.users.findByLogin('member')).pluginCapabilities, [CAP]);
        const found = await api.users.search('staff', 5);
        assert.deepStrictEqual(found.find((u: any) => u.id === U.staff).pluginCapabilities, [CAP]);
        // Never a core capability nor another plugin's: `staff` also holds edit_posts and otherplugin_access.
        assert.ok(!JSON.stringify(found).includes('edit_posts') && !JSON.stringify(found).includes('otherplugin_access'));
    });

    it('POST /roles refuses a core capability on the plugin role; a namespaced one is accepted', async () => {
        const bad = await as('admin', 'post', '/roles').send({ slug: ROLE, name: 'Probe team', capabilities: ['read', 'access_admin_panel', CAP, 'manage_options'] });
        assert.strictEqual(bad.status, 400);
        assert.strictEqual(bad.body.code, 'rest_role_plugin_capability');
        const foreign = await as('admin', 'post', '/roles').send({ slug: ROLE, name: 'Probe team', capabilities: ['read', 'conference_manager_access'] });
        assert.strictEqual(foreign.status, 400, 'another plugin\'s capability is refused too');
        assert.deepStrictEqual(roles.getRole(ROLE).capabilities, ['read', 'access_admin_panel', CAP], 'nothing was written');
        assert.strictEqual(roles.getRole(ROLE).source, 'plugin', 'provenance intact');

        const ok = await as('admin', 'post', '/roles').send({ slug: ROLE, name: 'Probe team', capabilities: ['read', 'access_admin_panel', CAP, `${PREFIX}reports`] });
        assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
        assert.strictEqual(roles.getRole(ROLE).plugin, SLUG, 'an admin edit keeps the provenance');
        assert.deepStrictEqual(await capsOf('member'), ['access_admin_panel', CAP, `${PREFIX}reports`, 'read'].sort());
    });

    it('updateRoleCapabilities is refused the same way and leaves the cache untouched', async () => {
        const beforeCaps = roles.getRole(ROLE).capabilities.slice();
        await assert.rejects(roles.updateRoleCapabilities(ROLE, ['*']), (e: any) => e.code === 'rest_role_plugin_capability');
        assert.deepStrictEqual(roles.getRole(ROLE).capabilities, beforeCaps);
    });

    it('the plugin role cannot be renamed or deleted while the plugin is installed', async () => {
        const rename = await as('admin', 'post', '/roles').send({ slug: ROLE, name: 'Renamed', capabilities: ['read'] });
        assert.strictEqual(rename.status, 409);
        assert.strictEqual(rename.body.code, 'rest_role_plugin_managed');
        const del = await as('admin', 'delete', `/roles/${ROLE}`);
        assert.strictEqual(del.status, 409);
        assert.ok(roles.getRole(ROLE), 'still there');
    });

    it('a tampered option cannot widen it: the effective capabilities ignore it, and the boot sync cuts it', async () => {
        const { updateOption } = require('../core/options');
        const tampered = JSON.parse(JSON.stringify(roles.getRoles()));
        tampered[ROLE].capabilities.push('manage_options', '*', 'list_users');
        tampered.editor = { ...tampered.editor, source: 'plugin', plugin: SLUG };
        await updateOption('wordjs_user_roles', tampered);
        await roles.loadRoles();
        const User = require('../models/User');
        const member = await User.findById(U.member);
        assert.strictEqual(member.can('manage_options'), false);
        assert.strictEqual(member.can('list_users'), false);
        assert.strictEqual(member.can('anything_at_all'), false, 'the stored "*" confers nothing');
        assert.strictEqual((await as('member', 'get', '/users')).status, 403);

        await roles.syncRoles({}, core.listInstalledPluginIds());
        assert.deepStrictEqual(roles.getRole(ROLE).capabilities.slice().sort(), ['access_admin_panel', CAP, `${PREFIX}reports`, 'read'].sort());
        assert.strictEqual(roles.getRole('editor').source, undefined, 'a core role never carries plugin provenance');
        assert.ok(roles.getRoleCapabilities('editor').includes('edit_others_posts'), 'and keeps its capabilities');
    });

    it('revoking roles:declare makes the role inert at once; granting it again restores it', async () => {
        const revoke = await as('admin', 'post', `/plugins/${SLUG}/permissions`).send({ granted: ['express:register_route'] });
        assert.strictEqual(revoke.status, 200, JSON.stringify(revoke.body));
        assert.deepStrictEqual(await capsOf('member'), ['access_admin_panel', 'read']);
        assert.ok(roles.getRole(ROLE), 'the role itself is kept');

        const grant = await as('admin', 'post', `/plugins/${SLUG}/permissions`).send({ granted: ['express:register_route', 'roles:declare'] });
        assert.strictEqual(grant.status, 200);
        assert.strictEqual(grant.body.rolesError, null);
        // Granting re-applies the manifest's definition — with the administrator's own edit on top (the
        // `reports` capability added through POST /roles above is not undone by the refresh).
        assert.deepStrictEqual(await capsOf('member'), ['access_admin_panel', CAP, `${PREFIX}reports`, 'read'].sort());
    });

    it('a plugin whose namespace nests inside this one takes those capabilities back, and keeps them', async () => {
        const SUB = `${SLUG}-sub`; // prefix `${PREFIX}sub_` — inside ours
        await roles.setRole(ROLE, { name: 'Probe team', capabilities: ['read', 'access_admin_panel', CAP, `${PREFIX}sub_x`] });
        const subDir = path.join(core.PLUGINS_DIR, SUB);
        fs.mkdirSync(subDir, { recursive: true });
        fs.writeFileSync(path.join(subDir, 'manifest.json'), JSON.stringify({ id: SUB, name: 'Sub', isolated: true }));
        try {
            // What every activation runs (here for the nested plugin, which declares no role at all).
            await core.syncPluginRoles(SUB, { id: SUB });
            assert.deepStrictEqual(roles.getRole(ROLE).capabilities, ['read', 'access_admin_panel', CAP]);
            // ...and the admin API cannot hand it back while that plugin is installed.
            const back = await as('admin', 'post', '/roles').send({ slug: ROLE, name: 'Probe team', capabilities: ['read', CAP, `${PREFIX}sub_x`] });
            assert.strictEqual(back.status, 400);
            assert.strictEqual(back.body.code, 'rest_role_plugin_capability');
            // A role of ours never carries a capability to the nested plugin's routes either.
            assert.deepStrictEqual(roles.pluginCapabilitiesFor({ role: ROLE }, SUB, [SLUG]), []);
        } finally {
            fs.rmSync(subDir, { recursive: true, force: true });
        }
        // The plugin that owns a namespace nested in ours is gone: the capability is ours again.
        assert.strictEqual((await as('admin', 'post', '/roles').send({ slug: ROLE, name: 'Probe team', capabilities: ['read', 'access_admin_panel', CAP, `${PREFIX}sub_x`] })).status, 201);
        // ...but it is never forwarded to a plugin with that nested id (a role of OURS reaches only us).
        assert.deepStrictEqual(roles.pluginCapabilitiesFor({ role: ROLE }, SUB, []), []);
        assert.deepStrictEqual(roles.pluginCapabilitiesFor({ role: ROLE }, SLUG, []), [CAP, `${PREFIX}sub_x`].sort());
    });

    it('a boot re-applies the manifest on disk to the roles of an active plugin, keeping the administrator\'s edits', async () => {
        await roles.setRole(ROLE, { name: 'Probe team', capabilities: ['read', 'access_admin_panel', CAP, `${PREFIX}drift`] });
        // The plugin was updated in place between two boots: its manifest now declares one more capability.
        const manifestPath = path.join(pluginDir(), 'manifest.json');
        const original = fs.readFileSync(manifestPath, 'utf8');
        const updated = goodManifest();
        updated.roles[0].capabilities = [CAP, `${PREFIX}fromdisk`];
        fs.writeFileSync(manifestPath, JSON.stringify(updated));
        try {
            // What a restart does for an active plugin: its child is gone, loadActivePlugins brings it back.
            require('../core/plugin-isolate').unloadIsolatedPlugin(SLUG);
            await core.loadActivePlugins();
            assert.strictEqual(require('../core/plugin-isolate').isIsolated(SLUG), true, 'precondition: the boot loaded it');
            assert.deepStrictEqual(roles.getRole(ROLE).capabilities.slice().sort(),
                ['access_admin_panel', CAP, `${PREFIX}drift`, `${PREFIX}fromdisk`, 'read'].sort());
        } finally {
            fs.writeFileSync(manifestPath, original);
        }
        // The administrator gives the role back its plain definition: nothing of theirs is left to keep.
        await roles.setRole(ROLE, { name: 'Probe team', capabilities: ['read', 'access_admin_panel', CAP, `${PREFIX}fromdisk`] });
        assert.strictEqual(roles.getRole(ROLE).adminChanges, undefined);
        require('../core/plugin-isolate').unloadIsolatedPlugin(SLUG);
        await core.loadActivePlugins();
        assert.deepStrictEqual(roles.getRole(ROLE).capabilities, ['read', 'access_admin_panel', CAP]);
    });

    it('deactivation keeps the role (inert while the plugin is off)', async () => {
        await core.deactivatePlugin(SLUG, { prune: false });
        assert.strictEqual(roles.getRole(ROLE).plugin, SLUG);
        assert.strictEqual(roles.getRole(ROLE).orphaned, undefined);
    });

    it('deleting the plugin orphans a role users still hold: they keep only read/access_admin_panel', async () => {
        const del = await as('admin', 'delete', `/plugins/${SLUG}`).send({ password: ADMIN_PASSWORD });
        assert.strictEqual(del.status, 200, JSON.stringify(del.body));
        assert.deepStrictEqual(del.body.cleanup.roles.orphaned, [ROLE]);
        const role = roles.getRole(ROLE);
        assert.strictEqual(role.orphaned, true);
        assert.deepStrictEqual(role.capabilities.slice().sort(), ['access_admin_panel', 'read']);
        assert.deepStrictEqual(await capsOf('member'), ['access_admin_panel', 'read']);
        // An orphaned plugin role gains nothing through the API either.
        const widen = await as('admin', 'post', '/roles').send({ slug: ROLE, name: 'Probe team', capabilities: ['read', CAP] });
        assert.strictEqual(widen.status, 400);
        // With its plugin gone the administrator may delete it — once nobody holds it any more.
        const held = await as('admin', 'delete', `/roles/${ROLE}`);
        assert.strictEqual(held.status, 409, JSON.stringify(held.body));
        assert.strictEqual(held.body.code, 'rest_role_in_use');
        assert.strictEqual((await as('admin', 'put', `/users/${U.member}`).send({ role: 'subscriber' })).status, 200);
        const remove = await as('admin', 'delete', `/roles/${ROLE}`);
        assert.strictEqual(remove.status, 200, JSON.stringify(remove.body));
    });

    it('a role nobody holds is removed with its plugin', async () => {
        await roles.registerPluginRoles('ghost', {
            permissions: [{ scope: 'roles', access: 'declare' }],
            roles: [{ slug: 'ghost_team', name: 'Ghost', capabilities: ['ghost_access'] }],
        }, { installedPluginIds: ['ghost'] });
        const r = await roles.releasePluginRoles('ghost');
        assert.deepStrictEqual(r.removed, ['ghost_team']);
        assert.strictEqual(roles.getRole('ghost_team'), null);
    });
});

/**
 * Every roles writer saves the WHOLE map. On a cluster this node's cache can be one broadcast behind
 * another node's edit, so a writer must compute the map on what the database holds (core/roles.ts
 * writeRoles: fresh read, guarded save, re-read when the row changed) — a map computed on the cache put a
 * capability another node had just revoked back into the database, and so on every node.
 */
describe('a roles write is computed on the stored map, never on this node\'s cache (multi-node)', () => {
    const RACE = `rolesrace${process.pid}`;
    const RACE_ROLE = `${RACE}_team`;
    const raceDir = () => path.join(core.PLUGINS_DIR, RACE);
    const EDITOR_CAPS = ['read', 'access_admin_panel', 'upload_files', 'edit_posts', 'edit_others_posts', 'edit_published_posts', 'publish_posts',
        'delete_posts', 'delete_others_posts', 'delete_published_posts', 'edit_pages', 'edit_others_pages', 'edit_published_pages',
        'publish_pages', 'delete_pages', 'delete_others_pages', 'delete_published_pages', 'manage_categories', 'moderate_comments'];
    /** The roles map the DATABASE holds (no cache tier). */
    const storedRoles = async () => JSON.parse((await dbAsync.get("SELECT option_value FROM options WHERE option_name = 'wordjs_user_roles'")).option_value);
    /** Node A revokes `cap` from the editor role: it saves the shared option; this node's roles cache has not heard of it. */
    async function nodeARevokes(cap: string) {
        const map = await storedRoles();
        map.editor.capabilities = map.editor.capabilities.filter((c: string) => c !== cap);
        await require('../core/options').updateOption('wordjs_user_roles', map);
    }
    const restoreEditor = () => roles.setRole('editor', { name: 'Editor', capabilities: EDITOR_CAPS });

    after(async () => {
        try { require('../core/plugin-isolate').unloadIsolatedPlugin(RACE); } catch { /* */ }
        try { fs.rmSync(raceDir(), { recursive: true, force: true }); } catch { /* */ }
        if (U.racer) await dbAsync.run("UPDATE user_meta SET meta_value = 'subscriber' WHERE user_id = ? AND meta_key = 'role'", [U.racer]);
        await roles.removeRole(RACE_ROLE);
        await restoreEditor();
    });

    it('granting roles:declare on this node keeps a capability node A revoked moments before', async () => {
        const manifest = goodManifest({ id: RACE, name: 'Roles race', roles: [{ slug: RACE_ROLE, name: 'Race team', capabilities: [`${RACE}_access`] }] });
        const zip = new AdmZip();
        zip.addFile(`${RACE}/manifest.json`, Buffer.from(JSON.stringify(manifest)));
        zip.addFile(`${RACE}/index.js`, Buffer.from(PROBE_CODE));
        const t = routes.createInstallTmp();
        installTmps.push(t);
        zip.writeZip(t.zipPath);
        const inst = await routes.installPluginFromZip(t.zipPath, `${RACE}.zip`);
        assert.strictEqual(inst.ok, true, inst.body && inst.body.error);
        await perms.setGrants(RACE, ['express:register_route']);
        await core.activatePlugin(RACE);
        assert.strictEqual(roles.getRole(RACE_ROLE), null, 'precondition: no role without the grant');

        await roles.loadRoles();
        assert.ok((await capsOf('editor')).includes('edit_others_posts'), 'precondition: the editor holds it');
        await nodeARevokes('edit_others_posts');
        assert.ok(!(await storedRoles()).editor.capabilities.includes('edit_others_posts'), 'node A saved its revocation');
        assert.ok(roles.getRoleCapabilities('editor').includes('edit_others_posts'), 'precondition: this node has not heard of it');

        const r = await as('admin', 'post', `/plugins/${RACE}/permissions`).send({ granted: ['express:register_route', 'roles:declare'] });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.rolesError, null);
        assert.strictEqual(roles.getRole(RACE_ROLE).plugin, RACE, 'control: the plugin role was registered');
        assert.ok(!(await storedRoles()).editor.capabilities.includes('edit_others_posts'), 'the revocation still stands in the database');
        assert.ok(!(await capsOf('editor')).includes('edit_others_posts'), 'and this node serves it');
        // Node A hears this node's write and reloads: the capability stays revoked everywhere.
        await require('../core/coherence').handleOptionChange('wordjs_user_roles');
        assert.ok(!(await capsOf('editor')).includes('edit_others_posts'));
    });

    it('deleting a plugin keeps a revocation that arrived while it counted its role\'s holders', async () => {
        await restoreEditor();
        assert.ok(roles.getRoleCapabilities('editor').includes('edit_others_posts'), 'precondition');
        await seedUser('racer', RACE_ROLE);
        await core.deactivatePlugin(RACE, { prune: false });

        const driver = database.getDbAsync();
        const originalGet = driver.get;
        let fired = false;
        let cacheWasRevoked: boolean | null = null;
        driver.get = async function (sql: string, params?: any[]) {
            if (!fired && /COUNT\(DISTINCT user_id\) AS holders/.test(String(sql))) {
                fired = true;
                // While the delete awaits this count, node A revokes and this node receives and applies its signal.
                await nodeARevokes('edit_others_posts');
                await require('../core/coherence').handleOptionChange('wordjs_user_roles');
                cacheWasRevoked = !roles.getRoleCapabilities('editor').includes('edit_others_posts');
            }
            return originalGet.call(this, sql, params);
        };
        try {
            const del = await as('admin', 'delete', `/plugins/${RACE}`).send({ password: ADMIN_PASSWORD });
            assert.strictEqual(del.status, 200, JSON.stringify(del.body));
            assert.deepStrictEqual(del.body.cleanup.roles.orphaned, [RACE_ROLE], 'control: the role was retired');
        } finally {
            driver.get = originalGet;
        }
        assert.strictEqual(fired, true, 'precondition: the revocation landed during the holder count');
        assert.strictEqual(cacheWasRevoked, true, 'precondition: this node had applied it');
        assert.ok(!(await storedRoles()).editor.capabilities.includes('edit_others_posts'), 'the revocation still stands in the database');
        assert.ok(!roles.getRoleCapabilities('editor').includes('edit_others_posts'), 'and in this node\'s cache');
        assert.strictEqual(roles.getRole(RACE_ROLE).orphaned, true);
    });

    it('every other roles writer keeps node A\'s revocation too: setRole, removeRole, syncRoles, namespace enforcement', async () => {
        const declare = (plugin: string) => ({ permissions: [{ scope: 'roles', access: 'declare' }], roles: [{ slug: `${plugin}_team`, name: 'Team', capabilities: [`${plugin}_x`] }] });
        // [writer, what it needs to have something to save, the write]
        const writers: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
            ['setRole', async () => undefined, () => roles.setRole('racecustom', { name: 'Race custom', capabilities: ['read'] })],
            ['removeRole', async () => undefined, () => roles.removeRole('racecustom')],
            // A plugin role of a plugin no longer installed: the boot sync orphans it (and saves).
            ['syncRoles', () => roles.registerPluginRoles('rsync', declare('rsync'), { installedPluginIds: ['rsync'] }), () => roles.syncRoles({}, ['someotherplugin'])],
            ['enforcePluginRoleNamespaces', () => roles.registerPluginRoles('renf', declare('renf'), { installedPluginIds: ['renf'] }), () => roles.enforcePluginRoleNamespaces(['someotherplugin'])],
        ];
        try {
            for (const [name, setup, write] of writers) {
                await restoreEditor();
                await setup();
                await roles.loadRoles();
                await nodeARevokes('moderate_comments');
                assert.ok(roles.getRoleCapabilities('editor').includes('moderate_comments'), `${name}: precondition, this node has not heard of it`);
                const before = JSON.stringify(await storedRoles());
                await write();
                assert.notStrictEqual(JSON.stringify(await storedRoles()), before, `${name}: control, the writer saved something`);
                assert.ok(!(await storedRoles()).editor.capabilities.includes('moderate_comments'), `${name} saved the revoked capability back`);
            }
        } finally {
            for (const slug of ['racecustom', 'rsync_team', 'renf_team']) await roles.removeRole(slug);
            await restoreEditor();
        }
    });
});

describe('the marketplace submission gate runs the same roles check (scripts/scan-plugin.mjs)', () => {
    it('refuses a submission whose role reaches outside its namespace, and passes the same submission without it', () => {
        const { spawnSync } = require('child_process');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-roles-scan-'));
        const submit = (slug: string, caps: string[]) => {
            const dir = path.join(root, 'marketplace', 'plugins', slug);
            fs.mkdirSync(dir, { recursive: true });
            const prefix = pluginRoles.pluginNamespacePrefix(slug);
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
                id: slug, name: slug, version: '1.0.0', description: 'A fixture submission that declares a role.',
                author: 'An Outside Author', license: 'MIT', repository: `https://example.org/outside/${slug}`, isolated: true,
                permissions: [{ scope: 'roles', access: 'declare', reason: 'Declares the team role that opens the fixture screens.' }],
                roles: [{ slug: `${prefix}team`, name: 'Team', capabilities: caps.map((c) => c.replace('{p}', prefix)) }],
            }, null, 2));
            fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT\n');
            fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');
        };
        submit('roles-escalating', ['{p}access', 'manage_options']);
        submit('roles-contained', ['{p}access']);
        try {
            const r = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/scan-plugin.mjs'), '--only=manifest', 'roles-escalating', 'roles-contained'], {
                env: { ...process.env, WORDJS_MARKETPLACE_ROOT: root }, encoding: 'utf8',
            });
            const out = `${r.stdout || ''}${r.stderr || ''}`;
            assert.strictEqual(r.status, 1, out);
            assert.match(out, /"manage_options" must start with "roles_escalating_"/, out);
            assert.match(out, /✓ roles-contained/, `the contained submission must pass the whole manifest check:\n${out}`);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
