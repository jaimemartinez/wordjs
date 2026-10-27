/**
 * conference-manager 2.17.0 — the TEAM ROLE: the WordJS role the plugin's manifest declares.
 *
 * The user's rule: a conference team member must be able to open ONLY the conference-manager admin page.
 * The plugin's half of that (the core enforces the role's capabilities and the admin route guard):
 *   - the manifest REQUESTS the permission `roles:declare` and declares ONE role, `conference_manager_team`,
 *     whose only capability is the plugin's own `conference_manager_access` (both under the plugin's
 *     namespace prefix, which the core requires);
 *   - the admin menu entry needs that capability (administrators hold every capability), so the entry —
 *     and with the core's route guard, the page — exists only for administrators and the team role;
 *   - only accounts whose WordJS role gives access to the panel may join the team (POST /staff/members):
 *     the team role, or another role an administrator gave the capability to (an editor who also runs
 *     registrations — the administrator keeps the 2.15 ability to put an editor on the team); a role change
 *     or a reactivation (PUT) is held to the same rule, while deactivating never is;
 *   - a member whose account does NOT have that access (an editor added before 2.17.0, a role changed in
 *     Usuarios) keeps their row but gets no section, and the team list flags them;
 *   - the WordJS role is read from the request on every call (the permission cache cannot outlive a role
 *     change).
 * Every assertion drives the REAL plugin (fixtures/conference-manager-harness.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { bootPlugin, PLUGIN_DIR, ADMIN, type HarnessUser } from './fixtures/conference-manager-harness';

const TEAM_ROLE = 'conference_manager_team';
const TEAM_CAP = 'conference_manager_access';
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'));

const ANA: HarnessUser = { id: 10, role: TEAM_ROLE, userLogin: 'ana', userEmail: 'ana@example.test', displayName: 'Ana' };
const EDDIE: HarnessUser = { id: 11, role: 'editor', userLogin: 'eddie', userEmail: 'eddie@example.test', displayName: 'Eddie' };
const SUE: HarnessUser = { id: 12, role: 'subscriber', userLogin: 'sue', userEmail: 'sue@example.test', displayName: 'Sue' };
const ROOT2: HarnessUser = { id: 13, role: 'administrator', userLogin: 'root2', userEmail: 'root2@example.test', displayName: 'Root 2' };
const USERS = [ANA, EDDIE, SUE, ROOT2];

/** A team role (staff_roles) that opens Inscripciones (view) — what the members below get. */
async function makeStaffRole(p: any, name = 'Recepción') {
    const r = await p.call('post', '/staff/roles', { body: { name, permissions: { inscriptions: 'view' } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.id as number;
}

test('manifest: requests roles:declare and declares one namespaced role whose only capability is the plugin\'s own', () => {
    assert.strictEqual(manifest.version, '2.36.22');
    const perms = (manifest.permissions || []).map((p: any) => `${p.scope}:${p.access}`);
    assert.ok(perms.includes('roles:declare'), `roles:declare must be requested: ${perms.join(', ')}`);
    assert.ok(Array.isArray(manifest.roles) && manifest.roles.length === 1, 'exactly one declared role');
    const prefix = String(manifest.id).replace(/[^a-z0-9]/g, '_') + '_';
    assert.strictEqual(prefix, 'conference_manager_');
    const role = manifest.roles[0];
    assert.strictEqual(role.slug, TEAM_ROLE);
    assert.strictEqual(role.name, 'Equipo de conferencia');
    assert.ok(role.slug.startsWith(prefix));
    assert.deepStrictEqual(role.capabilities, [TEAM_CAP]);
    for (const c of role.capabilities) assert.ok(c.startsWith(prefix), `capability ${c} outside the plugin namespace`);
});

test('admin menu: the entry needs the team capability, not access_admin_panel', async () => {
    const p = await bootPlugin({ users: USERS });
    const item = p.menu.find((m: any) => m.href === '/admin/plugin/conference-manager');
    assert.ok(item, 'menu item registered');
    assert.strictEqual(item.cap, TEAM_CAP);
    assert.ok(manifest.roles[0].capabilities.includes(item.cap), 'the declared role holds the menu capability');
});

test('POST /staff/members: only accounts with the WordJS team role can join', async () => {
    const p = await bootPlugin({ users: USERS });
    const roleId = await makeStaffRole(p);

    for (const u of [EDDIE, SUE]) {
        const r = await p.call('post', '/staff/members', { body: { user_id: u.id, role_id: roleId } });
        assert.strictEqual(r.status, 400, `${u.role}: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'not_team_role');
        assert.match(r.body.error, /Equipo de conferencia/);
        assert.match(r.body.error, /Usuarios/);
    }
    assert.strictEqual(p.q('SELECT * FROM wjp_conference_manager_staff_members').length, 0, 'nobody was added');

    const admin = await p.call('post', '/staff/members', { body: { user_id: ROOT2.id, role_id: roleId } });
    assert.strictEqual(admin.status, 400);
    assert.match(admin.body.error, /administradores/i);

    const ok = await p.call('post', '/staff/members', { body: { user_id: ANA.id, role_id: roleId } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const rows = p.q('SELECT user_id, active FROM wjp_conference_manager_staff_members');
    assert.deepStrictEqual(rows, [{ user_id: ANA.id, active: 1 }]);
});

test('a team member with the role works; the same member without it gets nothing — and a role change is seen at once', async () => {
    const p = await bootPlugin({ users: USERS });
    const roleId = await makeStaffRole(p);
    assert.strictEqual((await p.call('post', '/staff/members', { body: { user_id: ANA.id, role_id: roleId } })).status, 200);

    const asTeam = { ...ANA };
    const list = await p.call('get', '/list', { user: asTeam });
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const me = await p.call('get', '/staff/me', { user: asTeam });
    assert.strictEqual(me.body.isStaff, true);
    assert.strictEqual(me.body.teamRole, true);
    assert.strictEqual(me.body.member, true);
    assert.strictEqual(me.body.permissions.inscriptions, 'view');

    // Same account, role changed in Usuarios (the host forwards the new role on the very next request):
    // within the permission cache window, still no access.
    const asEditor = { ...ANA, role: 'editor' };
    const denied = await p.call('get', '/list', { user: asEditor });
    assert.strictEqual(denied.status, 403);
    const me2 = await p.call('get', '/staff/me', { user: asEditor });
    assert.strictEqual(me2.body.isStaff, false);
    assert.strictEqual(me2.body.teamRole, false);
    assert.strictEqual(me2.body.member, true, 'still on the list — never silently removed');
    assert.ok(Object.values(me2.body.permissions).every(v => v === 'none'));
    const ins = await p.call('get', '/inscriptions?conference_id=1', { user: asEditor });
    assert.strictEqual(ins.status, 403);

    // And back: the role is given back → access again, immediately.
    assert.strictEqual((await p.call('get', '/list', { user: asTeam })).status, 200);
});

test('when the host forwards the caller plugin capabilities, the team role must still carry the team capability', async () => {
    const p = await bootPlugin({ users: USERS });
    const roleId = await makeStaffRole(p);
    assert.strictEqual((await p.call('post', '/staff/members', { body: { user_id: ANA.id, role_id: roleId } })).status, 200);
    // core/plugin-isolate.ts projectRouteUser: req.user.pluginCapabilities = the caller's capabilities in
    // this plugin's namespace. With the capability → in; the capability taken off the role → out.
    const withCap = { ...ANA, extra: { pluginCapabilities: [TEAM_CAP] } };
    const withoutCap = { ...ANA, extra: { pluginCapabilities: [] } };
    assert.strictEqual((await p.call('get', '/list', { user: withCap })).status, 200);
    assert.strictEqual((await p.call('get', '/list', { user: withoutCap })).status, 403);
    const me = await p.call('get', '/staff/me', { user: withoutCap });
    assert.deepStrictEqual([me.body.isStaff, me.body.teamRole, me.body.member], [false, false, true]);
});

test('an administrator can still put an editor on the team: by giving the editor role the team capability', async () => {
    // 2.15.0 let an administrator add any non-administrator account. 2.17.0 keeps that function: what opens
    // the panel is the CAPABILITY, which the team role carries and an administrator may give to any other
    // role in Usuarios › Roles (core/plugin-roles.ts: only this plugin's namespace, nothing of the core's).
    const editorWithCap: HarnessUser = { ...EDDIE, extra: { pluginCapabilities: [TEAM_CAP] } };
    const editorWithout: HarnessUser = { ...SUE, id: 21, role: 'editor', userLogin: 'ed2', extra: { pluginCapabilities: [] } };
    const p = await bootPlugin({ users: [ANA, editorWithCap, editorWithout, SUE, ROOT2] });
    const roleId = await makeStaffRole(p);
    // The users bridge tells the plugin each account's own-namespace capabilities (core/plugin-api.ts).
    const picker = await p.call('get', '/staff/user-search?q=');
    const by = new Map(picker.body.users.map((u: any) => [u.id, u]));
    assert.strictEqual((by.get(editorWithCap.id) as any).team_role, true, 'an editor whose role holds the capability may join');
    assert.strictEqual((by.get(editorWithout.id) as any).team_role, false);
    const added = await p.call('post', '/staff/members', { body: { user_id: editorWithCap.id, role_id: roleId } });
    assert.strictEqual(added.status, 200, JSON.stringify(added.body));
    const refused = await p.call('post', '/staff/members', { body: { user_id: editorWithout.id, role_id: roleId } });
    assert.strictEqual(refused.status, 400);
    assert.strictEqual(refused.body.code, 'not_team_role');
    assert.match(refused.body.error, /conference_manager_access/);
    // The editor works in the panel — with the sections of their team role, nothing more.
    assert.strictEqual((await p.call('get', '/list', { user: editorWithCap })).status, 200);
    const me = await p.call('get', '/staff/me', { user: editorWithCap });
    assert.deepStrictEqual([me.body.isStaff, me.body.teamRole, me.body.permissions.inscriptions, me.body.permissions.settings], [true, true, 'view', 'none']);
    // The capability taken off the editor role again: out at once (still on the list, flagged).
    const editorNoMore = { ...editorWithCap, extra: { pluginCapabilities: [] } };
    assert.strictEqual((await p.call('get', '/list', { user: editorNoMore })).status, 403);
});

test('the team list says whether the team role exists and opens the panel (roles:declare granted)', async () => {
    const p = await bootPlugin({ users: USERS });
    // The host gives an administrator every capability the plugin's REGISTERED roles confer.
    const ready = await p.call('get', '/staff/members', { user: { ...ADMIN, extra: { pluginCapabilities: [TEAM_CAP] } } });
    assert.strictEqual(ready.body.roles_ready, true);
    // An in-place update to 2.17.0 keeps the old grants: roles:declare not granted → the role does not exist.
    const notReady = await p.call('get', '/staff/members', { user: { ...ADMIN, extra: { pluginCapabilities: [] } } });
    assert.strictEqual(notReady.body.roles_ready, false);
    // A host that forwards no capabilities cannot tell: no claim either way.
    assert.strictEqual((await p.call('get', '/staff/members')).body.roles_ready, null);
});

test('without the users:read grant the administrator can still change a member\'s team role or reactivate them (as in 2.15)', async () => {
    const p = await bootPlugin({ users: USERS });
    const roleId = await makeStaffRole(p);
    const otherRole = await makeStaffRole(p, 'Tesorería');
    assert.strictEqual((await p.call('post', '/staff/members', { body: { user_id: ANA.id, role_id: roleId } })).status, 200);
    const ana = p.one('SELECT id FROM wjp_conference_manager_staff_members WHERE user_id = ?', ANA.id).id;
    assert.strictEqual((await p.call('put', `/staff/members/${ana}`, { body: { active: false } })).status, 200);
    p.setUsersGrant(false);
    const change = await p.call('put', `/staff/members/${ana}`, { body: { role_id: otherRole } });
    assert.strictEqual(change.status, 200, JSON.stringify(change.body));
    const on = await p.call('put', `/staff/members/${ana}`, { body: { active: true } });
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    assert.deepStrictEqual(p.one('SELECT role_id, active FROM wjp_conference_manager_staff_members WHERE id = ?', ana), { role_id: otherRole, active: 1 });
    // The lookup only spares a pointless edit: the gate is permsOf, on every request — an account without
    // access reactivated this way still reaches nothing.
    p.exec('INSERT INTO wjp_conference_manager_staff_members (user_id, role_id, active) VALUES (?, ?, 0)', EDDIE.id, roleId);
    const eddie = p.one('SELECT id FROM wjp_conference_manager_staff_members WHERE user_id = ?', EDDIE.id).id;
    assert.strictEqual((await p.call('put', `/staff/members/${eddie}`, { body: { active: true } })).status, 200);
    assert.strictEqual((await p.call('get', '/list', { user: EDDIE })).status, 403);
    p.setUsersGrant(true);
});

test('a legacy member without the team role: flagged in the list, locked against role change / reactivation, deactivatable', async () => {
    const p = await bootPlugin({ users: USERS });
    const roleId = await makeStaffRole(p);
    const otherRole = await makeStaffRole(p, 'Tesorería');
    // Added before 2.17.0, when any non-administrator could join.
    p.exec('INSERT INTO wjp_conference_manager_staff_members (user_id, role_id, active, added_by) VALUES (?, ?, 1, ?)', EDDIE.id, roleId, 'boss');
    assert.strictEqual((await p.call('post', '/staff/members', { body: { user_id: ANA.id, role_id: roleId } })).status, 200);
    const eddie = p.one('SELECT id FROM wjp_conference_manager_staff_members WHERE user_id = ?', EDDIE.id).id;
    const ana = p.one('SELECT id FROM wjp_conference_manager_staff_members WHERE user_id = ?', ANA.id).id;

    const members = await p.call('get', '/staff/members');
    assert.strictEqual(members.status, 200);
    const byUser = new Map(members.body.members.map((m: any) => [m.user_id, m]));
    assert.strictEqual((byUser.get(EDDIE.id) as any).team_role, false);
    assert.strictEqual((byUser.get(EDDIE.id) as any).user.role, 'editor');
    assert.strictEqual((byUser.get(ANA.id) as any).team_role, true);
    assert.strictEqual(members.body.team_role, TEAM_ROLE);

    // The legacy member reaches nothing.
    assert.strictEqual((await p.call('get', '/list', { user: EDDIE })).status, 403);

    // Role change → 400; reactivation → 400; deactivation → 200 (no lookup needed).
    const change = await p.call('put', `/staff/members/${eddie}`, { body: { role_id: otherRole } });
    assert.strictEqual(change.status, 400, JSON.stringify(change.body));
    assert.strictEqual(change.body.code, 'not_team_role');
    assert.strictEqual(p.one('SELECT role_id FROM wjp_conference_manager_staff_members WHERE id = ?', eddie).role_id, roleId, 'role unchanged');
    const off = await p.call('put', `/staff/members/${eddie}`, { body: { active: false } });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    assert.strictEqual(p.one('SELECT active FROM wjp_conference_manager_staff_members WHERE id = ?', eddie).active, 0);
    const on = await p.call('put', `/staff/members/${eddie}`, { body: { active: true } });
    assert.strictEqual(on.status, 400);
    assert.strictEqual(p.one('SELECT active FROM wjp_conference_manager_staff_members WHERE id = ?', eddie).active, 0, 'still inactive');
    // Deactivating works even without the users:read grant (it never looks the account up).
    p.setUsersGrant(false);
    assert.strictEqual((await p.call('put', `/staff/members/${ana}`, { body: { active: false } })).status, 200);
    p.setUsersGrant(true);

    // A member WITH the role: role change and reactivation work as before.
    assert.strictEqual((await p.call('put', `/staff/members/${ana}`, { body: { role_id: otherRole, active: true } })).status, 200);
    assert.deepStrictEqual(p.one('SELECT role_id, active FROM wjp_conference_manager_staff_members WHERE id = ?', ana), { role_id: otherRole, active: 1 });

    // Switching them off never needs access — not even in the same request as a role change — and the role
    // of someone who stays switched off can change too.
    p.exec('UPDATE wjp_conference_manager_staff_members SET active = 1 WHERE id = ?', eddie);
    const offAndRole = await p.call('put', `/staff/members/${eddie}`, { body: { role_id: otherRole, active: false } });
    assert.strictEqual(offAndRole.status, 200, JSON.stringify(offAndRole.body));
    assert.deepStrictEqual(p.one('SELECT role_id, active FROM wjp_conference_manager_staff_members WHERE id = ?', eddie), { role_id: otherRole, active: 0 });
    assert.strictEqual((await p.call('put', `/staff/members/${eddie}`, { body: { role_id: roleId } })).status, 200);
    assert.strictEqual(p.one('SELECT active FROM wjp_conference_manager_staff_members WHERE id = ?', eddie).active, 0, 'still off');

    // Removing the legacy member stays possible.
    assert.strictEqual((await p.call('delete', `/staff/members/${eddie}`)).status, 200);
});

test('PUT /staff/members on a member whose WordJS account is gone answers 404, not a role message', async () => {
    const p = await bootPlugin({ users: USERS });
    const roleId = await makeStaffRole(p);
    p.exec('INSERT INTO wjp_conference_manager_staff_members (user_id, role_id, active) VALUES (?, ?, 1)', 999, roleId);
    const id = p.one('SELECT id FROM wjp_conference_manager_staff_members WHERE user_id = 999').id;
    const r = await p.call('put', `/staff/members/${id}`, { body: { role_id: roleId } });
    assert.strictEqual(r.status, 404);
    const members = await p.call('get', '/staff/members');
    assert.strictEqual(members.body.members[0].team_role, null, 'unknown account → unknown, not «lacks the role»');
});

test('GET /staff/user-search: each user carries its WordJS role and whether it may join', async () => {
    const p = await bootPlugin({ users: USERS });
    const r = await p.call('get', '/staff/user-search?q=');
    assert.strictEqual(r.status, 200);
    const by = new Map(r.body.users.map((u: any) => [u.id, u]));
    assert.deepStrictEqual([(by.get(ANA.id) as any).role, (by.get(ANA.id) as any).team_role], [TEAM_ROLE, true]);
    assert.deepStrictEqual([(by.get(EDDIE.id) as any).role, (by.get(EDDIE.id) as any).team_role], ['editor', false]);
    assert.deepStrictEqual([(by.get(ADMIN.id) as any).role, (by.get(ADMIN.id) as any).team_role], ['administrator', false]);
    assert.strictEqual(r.body.team_role, TEAM_ROLE);
});

test('team management stays administrators-only and administrators keep every section', async () => {
    const p = await bootPlugin({ users: USERS });
    const roleId = await makeStaffRole(p);
    assert.strictEqual((await p.call('post', '/staff/members', { body: { user_id: ANA.id, role_id: roleId } })).status, 200);
    for (const [m, u] of [['get', '/staff/members'], ['get', '/staff/roles'], ['get', '/staff/user-search']] as const) {
        assert.strictEqual((await p.call(m, u, { user: ANA })).status, 403, `${m} ${u} for a team member`);
    }
    const me = await p.call('get', '/staff/me');
    assert.strictEqual(me.body.isAdmin, true);
    assert.ok(Object.values(me.body.permissions).every(v => v !== 'none'));
    assert.strictEqual((await p.call('get', '/list')).status, 200);
});
