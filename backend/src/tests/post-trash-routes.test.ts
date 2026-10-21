/**
 * THE TRASH, through the REAL posts router (supertest) — the seam where "Delete" stopped being honest.
 *
 * DELETE without ?force is a SOFT delete: the model turns it into post_status='trash'. Nothing in the
 * admin could reach that state (no trash tab, no client querying it), so the row vanished from every
 * view while the record sat intact in the database — the user confirmed "Delete" and got silent,
 * unrecoverable archiving. And the soft path wrote the status directly, WITHOUT recording where the post
 * came from, so even a restore built on top of it would have "restored" everything as a draft.
 *
 * Pinned here:
 *   • DELETE (no force) trashes AND records _wp_trash_meta_status / _wp_trash_meta_time;
 *   • the trashed row is INVISIBLE to status=any (as in WordPress) but LISTED by ?status=trash, with
 *     X-WP-Total agreeing — that pair is exactly what makes the row reachable again;
 *   • POST /:id/restore returns the post to the status it was trashed FROM (publish stays publish, a
 *     draft comes back a draft — not everything flattened to 'draft'), and clears the trash meta;
 *   • re-trashing an already-trashed post does not overwrite the recorded status (it would otherwise
 *     store 'trash' AS the original and restore straight back into the trash);
 *   • DELETE ?force=true really deletes: the row, its meta and its term relationships are gone;
 *   • authorization: the publish gate applies to restore (a contributor cannot put a trashed published
 *     post back LIVE), another author cannot restore someone else's post, and anonymous callers never
 *     see trash.
 *
 * Same config-repoint + CWD-sandbox ordering as the other supertest suites.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST (incidental writes stay out of the repo).
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-trash-routes-'));
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer / routers load.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

describe('the trash through the posts router', () => {
    let request: any;
    let app: any;
    let dbAsync: any;
    let Post: any;
    let adminToken: string, authorToken: string, author2Token: string, contributorToken: string;

    const as = (token: string) => (r: any) => r.set('Authorization', `Bearer ${token}`);

    async function seedUser(login: string, role: string): Promise<number> {
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            [login, 'x', `${login}@example.com`, login]
        );
        const row = await dbAsync.get(`SELECT id FROM users WHERE user_login = ?`, [login]);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [row.id, role]);
        return row.id;
    }

    const sign = (userId: number, username: string) =>
        jwt.sign({ userId, username }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

    /** Create a post as `token` and return its id. */
    async function mkPost(token: string, body: any): Promise<number> {
        const res = await as(token)(request(app).post('/api/v1/posts')).send({ type: 'post', ...body });
        assert.strictEqual(res.status, 201, `create failed: ${JSON.stringify(res.body)}`);
        return res.body.id;
    }

    /** Trash a post the way the admin table does: DELETE with no force. */
    async function trashPost(token: string, id: number) {
        const res = await as(token)(request(app).delete(`/api/v1/posts/${id}`));
        assert.strictEqual(res.status, 200, `trash failed: ${JSON.stringify(res.body)}`);
        return res;
    }

    const statusOf = async (id: number) => (await dbAsync.get('SELECT post_status FROM posts WHERE id = ?', [id]))?.post_status;
    const metaOf = (id: number, key: string) => Post.getMeta(id, key);

    /** Ids returned by a list call, so a row's presence/absence in a view is asserted directly. */
    async function listIds(token: string | null, query: any): Promise<{ ids: number[]; total: number }> {
        const base = request(app).get('/api/v1/posts').query({ type: 'post', per_page: 100, ...query });
        const res = await (token ? as(token)(base) : base);
        assert.strictEqual(res.status, 200);
        return { ids: res.body.map((p: any) => p.id), total: parseInt(res.headers['x-wp-total'], 10) };
    }

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        // The router's type gate (capsForType) resolves against the post-type registry, which boot
        // fills AFTER the DB connects — same here or every create 400s as an unregistered type.
        await require('../core/post-types').initPostTypes();
        Post = require('../models/Post');

        const adminId = await seedUser('admin', 'administrator');
        const authorId = await seedUser('author1', 'author');
        const author2Id = await seedUser('author2', 'author');
        const contributorId = await seedUser('contrib', 'contributor');
        adminToken = sign(adminId, 'admin');
        authorToken = sign(authorId, 'author1');
        author2Token = sign(author2Id, 'author2');
        contributorToken = sign(contributorId, 'contrib');

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '2mb' }));
        app.use('/api/v1/posts', require('../routes/posts'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.close?.(); } catch { /* */ }
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    // ─────────────────────────────────────────────────────── trash → visible → restore (the round trip)

    it('REGRESSION: DELETE without force trashes the post AND records the status it came from', async () => {
        const id = await mkPost(authorToken, { title: 'To be trashed', status: 'publish' });
        assert.strictEqual(await statusOf(id), 'publish');

        const res = await trashPost(authorToken, id);
        assert.strictEqual(res.body.status, 'trash', 'the payload tells the client where the post went');
        assert.strictEqual(await statusOf(id), 'trash');
        assert.strictEqual(await metaOf(id, '_wp_trash_meta_status'), 'publish',
            'without this the post has nothing to be restored TO (it used to silently become a draft)');
        assert.ok(Number(await metaOf(id, '_wp_trash_meta_time')) > 0, 'the trash timestamp is recorded');
    });

    it('REGRESSION: the trashed row is hidden from status=any but LISTED by ?status=trash', async () => {
        const id = await mkPost(authorToken, { title: 'Vanishing act', status: 'publish' });
        await trashPost(authorToken, id);

        const any = await listIds(adminToken, { status: 'any' });
        assert.ok(!any.ids.includes(id), 'a trashed post must not come back in the normal listing');

        const trash = await listIds(adminToken, { status: 'trash' });
        assert.ok(trash.ids.includes(id), 'THE FIX: the trash tab can reach the row again');
        assert.strictEqual(trash.total, trash.ids.length, 'X-WP-Total agrees with the filtered rows');

        // Every row in that view really is trashed (the filter is not leaking other statuses).
        const res = await as(adminToken)(request(app).get('/api/v1/posts')).query({ type: 'post', status: 'trash', per_page: 100 });
        assert.ok(res.body.every((p: any) => p.status === 'trash'));
    });

    it('restore returns the post to the status it was trashed FROM (publish stays publish)', async () => {
        const id = await mkPost(authorToken, { title: 'Round trip', status: 'publish' });
        await trashPost(authorToken, id);

        const res = await as(authorToken)(request(app).post(`/api/v1/posts/${id}/restore`)).send({});
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'publish');
        assert.strictEqual(await statusOf(id), 'publish');
        // The trash bookkeeping is cleared, so a second trash/restore cycle starts clean.
        assert.strictEqual(await metaOf(id, '_wp_trash_meta_status'), null);
        assert.strictEqual(await metaOf(id, '_wp_trash_meta_time'), null);

        const any = await listIds(adminToken, { status: 'any' });
        assert.ok(any.ids.includes(id), 'the restored post is back in the normal listing');
        const trash = await listIds(adminToken, { status: 'trash' });
        assert.ok(!trash.ids.includes(id), 'and gone from the trash');
    });

    it('a trashed DRAFT restores as a draft — not flattened, and never published by accident', async () => {
        const id = await mkPost(authorToken, { title: 'Draft round trip', status: 'draft' });
        await trashPost(authorToken, id);
        assert.strictEqual(await metaOf(id, '_wp_trash_meta_status'), 'draft');

        const res = await as(authorToken)(request(app).post(`/api/v1/posts/${id}/restore`)).send({});
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'draft');
    });

    it('re-trashing an already-trashed post keeps the ORIGINAL status recorded', async () => {
        const id = await mkPost(authorToken, { title: 'Double trashed', status: 'publish' });
        await trashPost(authorToken, id);
        await trashPost(authorToken, id);
        assert.strictEqual(await metaOf(id, '_wp_trash_meta_status'), 'publish',
            "re-recording would store 'trash' as the original and restore the post into the trash");

        const res = await as(authorToken)(request(app).post(`/api/v1/posts/${id}/restore`)).send({});
        assert.strictEqual(res.body.status, 'publish');
    });

    it('restoring a post that is not in the trash is a 400, not a silent status write', async () => {
        const id = await mkPost(authorToken, { title: 'Never trashed', status: 'draft' });
        const res = await as(authorToken)(request(app).post(`/api/v1/posts/${id}/restore`)).send({});
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'rest_post_not_trashed');
        assert.strictEqual(await statusOf(id), 'draft', 'the status is untouched');
    });

    // ─────────────────────────────────────────────────────────────────────────── permanent delete

    it('DELETE ?force=true deletes for real: row, meta and term relationships', async () => {
        const id = await mkPost(authorToken, { title: 'Gone for good', status: 'draft' });
        await as(authorToken)(request(app).post(`/api/v1/posts/${id}/meta`)).send({ key: 'k', value: 'v' });
        await dbAsync.run('INSERT INTO term_relationships (object_id, term_taxonomy_id) VALUES (?, ?)', [id, 1]);

        const res = await as(authorToken)(request(app).delete(`/api/v1/posts/${id}`)).query({ force: 'true' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.deleted, true);

        assert.strictEqual(await dbAsync.get('SELECT id FROM posts WHERE id = ?', [id]), undefined);
        const meta = await dbAsync.get('SELECT COUNT(*) AS n FROM post_meta WHERE post_id = ?', [id]);
        assert.strictEqual(Number(meta.n), 0);
        const rel = await dbAsync.get('SELECT COUNT(*) AS n FROM term_relationships WHERE object_id = ?', [id]);
        assert.strictEqual(Number(rel.n), 0);

        const trash = await listIds(adminToken, { status: 'trash' });
        assert.ok(!trash.ids.includes(id));
        assert.strictEqual((await as(adminToken)(request(app).get(`/api/v1/posts/${id}`))).status, 404);
    });

    it('a trashed post can be deleted permanently straight from the trash', async () => {
        const id = await mkPost(authorToken, { title: 'Trash then burn', status: 'draft' });
        await trashPost(authorToken, id);
        assert.strictEqual(await statusOf(id), 'trash');

        const res = await as(authorToken)(request(app).delete(`/api/v1/posts/${id}`)).query({ force: 'true' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await dbAsync.get('SELECT id FROM posts WHERE id = ?', [id]), undefined);
    });

    // ───────────────────────────────────────────────────────────────────────────────── authorization

    it('SECURITY: restore clears the publish gate — a contributor cannot put a live post back live', async () => {
        // The contributor's own post, published by an admin (the contributor cannot publish it), then
        // trashed: its recorded original status is 'publish'.
        const id = await mkPost(contributorToken, { title: 'Contrib post', status: 'draft' });
        assert.strictEqual((await as(adminToken)(request(app).put(`/api/v1/posts/${id}`)).send({ status: 'publish' })).status, 200);
        assert.strictEqual(await statusOf(id), 'publish');
        await trashPost(adminToken, id);
        assert.strictEqual(await metaOf(id, '_wp_trash_meta_status'), 'publish');

        const res = await as(contributorToken)(request(app).post(`/api/v1/posts/${id}/restore`)).send({});
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'pending', 'restoring must not publish for a user who cannot publish');
        assert.strictEqual(await statusOf(id), 'pending', 'and never went live on the way there');
    });

    it("SECURITY: an author cannot restore another author's trashed post", async () => {
        const id = await mkPost(authorToken, { title: "Author1's post", status: 'draft' });
        await trashPost(authorToken, id);

        const res = await as(author2Token)(request(app).post(`/api/v1/posts/${id}/restore`)).send({});
        assert.strictEqual(res.status, 403);
        assert.strictEqual(await statusOf(id), 'trash', 'still trashed');
        // ...and an admin (delete_others_posts) can.
        assert.strictEqual((await as(adminToken)(request(app).post(`/api/v1/posts/${id}/restore`)).send({})).status, 200);
        assert.strictEqual(await statusOf(id), 'draft');
    });

    it('restore requires authentication', async () => {
        const id = await mkPost(authorToken, { title: 'Anon restore attempt', status: 'draft' });
        await trashPost(authorToken, id);
        const res = await request(app).post(`/api/v1/posts/${id}/restore`).send({});
        assert.strictEqual(res.status, 401);
        assert.strictEqual(await statusOf(id), 'trash');
    });

    it("BOLA scoping: ?status=trash never leaks another author's trash, nor any trash to anonymous", async () => {
        const mine = await mkPost(authorToken, { title: 'Author1 trash', status: 'draft' });
        const theirs = await mkPost(author2Token, { title: 'Author2 trash', status: 'draft' });
        await trashPost(authorToken, mine);
        await trashPost(author2Token, theirs);

        const own = await listIds(author2Token, { status: 'trash' });
        assert.ok(own.ids.includes(theirs), 'an author sees their OWN trash');
        assert.ok(!own.ids.includes(mine), "and never author1's");

        const anon = await listIds(null, { status: 'trash' });
        assert.ok(!anon.ids.includes(mine) && !anon.ids.includes(theirs), 'anonymous callers see no trash at all');
    });
});
