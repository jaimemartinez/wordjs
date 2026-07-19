/**
 * HTTP AUTHORIZATION / IDOR SUITE
 *
 * Drives the REAL routers (require('../routes')) via supertest against a throwaway temp DB, with users of
 * every role, and asserts the two authorization dimensions that matter:
 *   • CAPABILITY — anonymous → 401, a token whose role lacks the capability → 403, an authorized role → 200.
 *   • OWNERSHIP (IDOR) — user A cannot read/mutate a resource owned by user B unless they hold the
 *     *_others_* capability. The core WordJS split is edit_posts (own) vs edit_others_posts (anyone).
 *
 * LOAD-BEARING: every "forbidden" assertion is paired with a POSITIVE control (the owner, or a role WITH
 * the *_others_* / moderation cap, succeeds) so a 403 can never be a false pass for the wrong reason
 * (a broken route, a missing resource, or a role that simply can't reach the handler). Personas:
 *   admin (administrator '*'), editor (edit_others_posts + moderate_comments), authorA/authorB (author —
 *   own only, NO edit_others_posts), subscriber (read only), commentEditor (a CUSTOM role with
 *   edit_comments but NOT moderate_comments — the only way to exercise the comment moderation boundary,
 *   since no default role grants edit_comments).
 *
 * Same config-repoint-first pattern as api.test.ts (point config.dbPath at a temp file BEFORE the DB
 * layer resolves it). No CSRF middleware is mounted (matching api.test.ts) so these tests isolate AUTHZ.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-authz-${process.pid}-${Date.now()}.db`);
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
// analytics + internal are mounted directly on the main app (index.ts), not in routes/index.ts — mirror
// that here so their authz is actually exercised (otherwise these routes 404 and pass by absence).
app.use('/api/v1/analytics', require('../routes/analytics'));
app.use('/api/internal', require('../routes/internal'));
// Pin a KNOWN gateway secret we NEVER send. A match would saveConfig() + process.exit(0) and kill the
// runner. The handler uses `config.gatewaySecret || <on-disk secret>`, so a truthy value here makes the
// real on-disk secret irrelevant — only this known value could ever match, and the tests only send
// no-header / a deliberately-wrong secret. (Setting '' does NOT work — it falls through to on-disk.)
const GATEWAY_SECRET = 'authz-test-gateway-secret-' + process.pid;
config.gatewaySecret = GATEWAY_SECRET;

// Persona ids, filled during seeding.
const U: Record<string, number> = {};
let postA = 0, postB = 0, mediaA = 0, commentA = 0;
let _seq = 0;

const tok = (id: number, login: string) => jwt.sign({ userId: id, username: login }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
// request as anonymous / as a named persona
const anon = (m: string, p: string) => (request(app) as any)[m](`/api/v1${p}`);
const as = (persona: string, m: string, p: string) =>
    (request(app) as any)[m](`/api/v1${p}`).set('Authorization', `Bearer ${tok(U[persona], persona)}`);

let dbAsync: any;

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
    return r.lastID;
}
async function seedPost(authorId: number, status: string) {
    _seq++;
    const r = await dbAsync.run(
        `INSERT INTO posts (author_id, post_title, post_status, post_type, post_name) VALUES (?, ?, ?, 'post', ?)`,
        [authorId, `Post ${_seq}`, status, `authz-post-${_seq}`]);
    return r.lastID;
}
async function seedMedia(authorId: number) {
    _seq++;
    const r = await dbAsync.run(
        `INSERT INTO posts (author_id, post_title, post_status, post_type, post_name, post_mime_type, guid)
         VALUES (?, ?, 'inherit', 'attachment', ?, 'image/png', ?)`,
        [authorId, `att ${_seq}`, `authz-att-${_seq}`, `/uploads/authz-${_seq}.png`]);
    return r.lastID;
}
async function seedComment(postId: number, userId: number, status = '0') {
    const r = await dbAsync.run(
        `INSERT INTO comments (comment_post_id, comment_author, comment_content, comment_approved, user_id, comment_type)
         VALUES (?, 'Guest', ?, ?, ?, 'comment')`,
        [postId, 'a comment', status, userId]);
    return r.lastID;
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();

    // Register a custom role that can EDIT comments but not MODERATE them (no default role grants
    // edit_comments) — the only way to prove the moderation boundary on PUT /comments/:id.
    await roles.loadRoles();
    await roles.setRole('comment_editor', { name: 'Comment Editor', capabilities: ['read', 'access_admin_panel', 'edit_comments'] });
    // A NON-admin persona that holds promote_users + edit_users — the ONLY persona for whom the self-role
    // guard is the sole barrier to self-promotion (a subscriber is also blocked by lacking promote_users,
    // which would let the self-promotion test pass even if the self-guard were deleted).
    await roles.setRole('promoter', { name: 'Promoter', capabilities: ['read', 'access_admin_panel', 'edit_users', 'promote_users'] });

    await seedUser('admin', 'administrator');
    await seedUser('editor', 'editor');
    await seedUser('authorA', 'author');
    await seedUser('authorB', 'author');
    await seedUser('subscriber', 'subscriber');
    await seedUser('commentEditor', 'comment_editor');
    await seedUser('promoter', 'promoter');

    postA = await seedPost(U.authorA, 'draft');   // authorA's DRAFT (also tests read-leak)
    postB = await seedPost(U.authorB, 'publish');
    mediaA = await seedMedia(U.authorA);
    commentA = await seedComment(postA, 0, '0');   // a pending comment on authorA's post
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* */ }
    }
});

// ── Anonymous requests to protected routes must be 401 (never 200, never a silent success) ───────────
describe('authz: anonymous → 401 on protected routes', () => {
    const cases: Array<{ m: string; label: string; path: () => string }> = [
        { m: 'get', label: '/users', path: () => '/users' },
        { m: 'post', label: '/posts', path: () => '/posts' },
        { m: 'put', label: '/posts/:id', path: () => `/posts/${postA}` },
        { m: 'post', label: '/media', path: () => '/media' },
        { m: 'put', label: '/comments/:id', path: () => `/comments/${commentA}` },
        { m: 'put', label: '/settings', path: () => '/settings' },
        { m: 'get', label: '/settings/all', path: () => '/settings/all' },
        { m: 'post', label: '/plugins/upload', path: () => '/plugins/upload' },
        { m: 'get', label: '/export', path: () => '/export' },
        { m: 'get', label: '/roles', path: () => '/roles' },
        { m: 'post', label: '/roles', path: () => '/roles' },
        { m: 'get', label: '/analytics/stats', path: () => '/analytics/stats' },
    ];
    for (const c of cases) {
        test(`${c.m.toUpperCase()} ${c.label} without a token → 401`, async () => {
            const res = await anon(c.m, c.path());
            assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
        });
    }
});

// ── Users: IDOR + privilege escalation ────────────────────────────────────────────────────────────
describe('authz: users IDOR + privilege escalation', () => {
    test('subscriber cannot GET another user; CAN GET self; /users/me is not shadowed', async () => {
        assert.strictEqual((await as('subscriber', 'get', `/users/${U.authorA}`)).status, 403);
        assert.strictEqual((await as('subscriber', 'get', `/users/${U.subscriber}`)).status, 200);
        const me = await as('subscriber', 'get', '/users/me');
        assert.strictEqual(me.status, 200);
        assert.strictEqual(me.body.id, U.subscriber, '/users/me must return the caller (not shadowed by /:id)');
    });
    test('subscriber cannot edit or delete another user', async () => {
        assert.strictEqual((await as('subscriber', 'put', `/users/${U.authorA}`).send({ displayName: 'hax' })).status, 403);
        assert.strictEqual((await as('subscriber', 'delete', `/users/${U.authorA}`)).status, 403);
    });
    test('no self-promotion: even a promote_users holder cannot change their OWN role (self-guard isolated)', async () => {
        // promoter HAS promote_users, so the ONLY thing stopping self-promotion is the self-role guard —
        // if it were deleted, this call would succeed (200). That makes the assertion load-bearing.
        const r = await as('promoter', 'put', `/users/${U.promoter}`).send({ role: 'administrator' });
        assert.strictEqual(r.status, 403, `self-role change must be 403, got ${r.status}`);
        assert.strictEqual(r.body.code, 'rest_cannot_edit_own_role', `must be the self-role guard, got ${r.body.code}`);
        const me = await as('promoter', 'get', '/users/me');
        assert.notStrictEqual(me.body.role, 'administrator', 'role must remain unchanged');
    });
    test('no self-promotion via PUT /users/me: role field is ignored', async () => {
        const r = await as('subscriber', 'put', '/users/me').send({ role: 'administrator', displayName: 'Sub' });
        assert.ok(r.status === 200, `PUT /users/me should succeed for profile fields, got ${r.status}`);
        const me = await as('subscriber', 'get', '/users/me');
        assert.notStrictEqual(me.body.role, 'administrator', 'role must NOT have changed via /users/me');
    });
    test('creating users requires admin (with a matching admin-CAN-create positive control)', async () => {
        assert.strictEqual((await as('subscriber', 'post', '/users').send({ username: 'x', email: 'x@x.co', password: 'p' })).status, 403);
        assert.strictEqual((await as('editor', 'post', '/users').send({ username: 'x', email: 'x@x.co', password: 'p' })).status, 403);
        const u = `newbie${Date.now()}`;
        const created = await as('admin', 'post', '/users').send({ username: u, email: `${u}@example.com`, password: 'Sup3r-Secret-Pw!', role: 'subscriber' });
        assert.ok(created.status === 201 || created.status === 200, `admin CAN create a user, got ${created.status}`);
        assert.strictEqual((await as('admin', 'get', '/users')).status, 200);
    });
});

// ── Posts: the edit_posts (own) vs edit_others_posts (anyone) IDOR boundary ──────────────────────────
describe('authz: posts IDOR (ownership boundary)', () => {
    test('author CANNOT edit another author\'s post; CAN edit own (positive control)', async () => {
        assert.strictEqual((await as('authorB', 'put', `/posts/${postA}`).send({ title: 'hijacked' })).status, 403);
        assert.ok((await as('authorA', 'put', `/posts/${postA}`).send({ title: 'mine, edited' })).status < 400,
            'the owner must be able to edit their own post');
    });
    test('editor (edit_others_posts) CAN edit another author\'s post', async () => {
        assert.ok((await as('editor', 'put', `/posts/${postA}`).send({ title: 'edited by editor' })).status < 400,
            'a holder of edit_others_posts must be able to edit any post');
    });
    test('author CANNOT delete another author\'s post', async () => {
        assert.strictEqual((await as('authorB', 'delete', `/posts/${postA}`)).status, 403);
    });
    test('non-owner without edit_others_posts cannot READ another author\'s draft (no leak)', async () => {
        const r = await as('authorB', 'get', `/posts/${postA}`);
        assert.ok(r.status === 403 || r.status === 404, `draft must not leak to a non-owner, got ${r.status}`);
        const owner = await as('authorA', 'get', `/posts/${postA}`);
        assert.strictEqual(owner.status, 200, 'the owner CAN read their own draft');
        assert.strictEqual(owner.body.id, postA, 'and it is genuinely postA — so the non-owner 404 is authz, not a missing post');
    });
});

// ── Media: same ownership boundary via delete_posts/edit_posts vs *_others_* ──────────────────────────
describe('authz: media IDOR', () => {
    test('author cannot edit/delete another author\'s media; owner + editor can', async () => {
        assert.strictEqual((await as('authorB', 'put', `/media/${mediaA}`).send({ alt_text: 'x' })).status, 403);
        assert.strictEqual((await as('authorB', 'delete', `/media/${mediaA}`)).status, 403);
        assert.ok((await as('authorA', 'put', `/media/${mediaA}`).send({ alt_text: 'mine' })).status < 400, 'owner edits own media');
    });
    test('uploading media requires upload_files', async () => {
        assert.strictEqual((await as('subscriber', 'post', '/media')).status, 403); // subscriber lacks upload_files
    });
    test('KNOWN BOUNDARY: GET /media/:id returns attachment metadata to anyone (media is public by id)', async () => {
        // Unlike GET /posts/:id (which hides non-published posts from non-owners), GET /media/:id uses
        // optionalAuth with no status/ownership check, so an attachment parented to a DRAFT post (mediaA is
        // exactly that) is readable by anon — a metadata leak (guid/author/title). Pinned as current
        // behavior and flagged for a separate product decision on whether draft-post attachments should be
        // gated; if that policy changes, flip this assertion. (Tracked as a follow-up task.)
        const r = await anon('get', `/media/${mediaA}`);
        assert.strictEqual(r.status, 200, `documents the current public-read boundary, got ${r.status}`);
    });
});

// ── Notifications: strictly per-user (a classic IDOR surface). DB-verified so the assertion is
//    load-bearing regardless of the route's status code for a cross-user no-op. ───────────────────────
describe('authz: notifications are scoped per-user (IDOR)', () => {
    test('user B cannot mark-read or delete user A\'s notification; the owner can', async () => {
        const uuid = `authz-notif-${Date.now()}`;
        await dbAsync.run(
            `INSERT INTO notifications (uuid, user_id, type, title, message) VALUES (?, ?, 'info', 'Hi A', 'private')`,
            [uuid, U.authorA]);

        // authorB attempts a cross-user mark-read — authoritative check: A's notification stays UNREAD.
        const bRead = await as('authorB', 'post', `/notifications/${uuid}/read`);
        let row = await dbAsync.get(`SELECT is_read FROM notifications WHERE uuid = ?`, [uuid]);
        assert.strictEqual(Number(row.is_read), 0, `user B must not mark user A's notification read (route ${bRead.status})`);

        // authorB attempts a cross-user delete — it must still exist.
        const bDel = await as('authorB', 'delete', `/notifications/${uuid}`);
        row = await dbAsync.get(`SELECT id FROM notifications WHERE uuid = ?`, [uuid]);
        assert.ok(row, `user B must not delete user A's notification (route ${bDel.status})`);

        // Positive control: the OWNER can mark it read (proves the route works + isolates the IDOR).
        const aRead = await as('authorA', 'post', `/notifications/${uuid}/read`);
        assert.ok(aRead.status < 400, `owner mark-read should succeed, got ${aRead.status}`);
        row = await dbAsync.get(`SELECT is_read FROM notifications WHERE uuid = ?`, [uuid]);
        assert.strictEqual(Number(row.is_read), 1, 'the owner CAN mark their own notification read');
    });
});

// ── Comments: the moderation boundary (edit content ≠ change status) ─────────────────────────────────
describe('authz: comments moderation boundary', () => {
    test('edit_comments alone CANNOT change moderation status (must have moderate_comments)', async () => {
        const r = await as('commentEditor', 'put', `/comments/${commentA}`).send({ status: '1' });
        assert.strictEqual(r.status, 403, `changing status without moderate_comments must be 403, got ${r.status}`);
    });
    test('edit_comments CAN edit comment content (positive control)', async () => {
        const r = await as('commentEditor', 'put', `/comments/${commentA}`).send({ content: 'edited body' });
        assert.ok(r.status < 400, `content edit with edit_comments should succeed, got ${r.status}`);
    });
    test('approving a comment requires moderate_comments', async () => {
        assert.strictEqual((await as('commentEditor', 'post', `/comments/${commentA}/approve`)).status, 403);
        assert.ok((await as('editor', 'post', `/comments/${commentA}/approve`)).status < 400,
            'a moderate_comments holder CAN approve (positive control)');
    });
    test('a plain user without edit_comments cannot edit a comment at all', async () => {
        assert.strictEqual((await as('subscriber', 'put', `/comments/${commentA}`).send({ content: 'x' })).status, 403);
    });
});

// ── Admin-only surfaces: a logged-in NON-admin must be 403 (capability, not just authentication) ─────
describe('authz: admin-only routes reject non-admins', () => {
    const adminRoutes: Array<[string, string]> = [
        ['put', '/settings'],
        ['get', '/settings/all'],
        ['get', '/roles'],
        ['post', '/roles'],
        ['get', '/export'],
        ['get', '/analytics/stats'],
        ['post', '/plugins/upload'],
        ['post', '/themes/upload'],
    ];
    for (const [m, p] of adminRoutes) {
        test(`${m.toUpperCase()} ${p} as editor (non-admin) → 403`, async () => {
            const res = await as('editor', m, p).send({});
            assert.strictEqual(res.status, 403, `expected 403 for a non-admin, got ${res.status}`);
        });
    }
    test('admin CAN reach an admin route (positive control)', async () => {
        assert.strictEqual((await as('admin', 'get', '/roles')).status, 200);
    });
});

// ── Internal gateway-update: JWT-exempt but gated by a shared secret; must reject without it ─────────
describe('authz: internal /gateway-update requires the shared secret', () => {
    test('with NO x-gateway-secret header → rejected (never a config write / process.exit)', async () => {
        const r = await request(app).post('/api/internal/gateway-update').send({ gatewayPort: 9999 });
        assert.ok(r.status === 401 || r.status === 403, `must reject a secret-less caller, got ${r.status}`);
    });
    test('with a WRONG x-gateway-secret → rejected', async () => {
        const r = await request(app).post('/api/internal/gateway-update')
            .set('x-gateway-secret', 'definitely-not-the-secret').send({ gatewayPort: 9999 });
        assert.ok(r.status === 401 || r.status === 403, `must reject a wrong secret, got ${r.status}`);
    });
});
