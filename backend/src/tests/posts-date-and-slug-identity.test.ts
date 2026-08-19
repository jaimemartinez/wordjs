/**
 * POSTS ROUTER — the publish DATE as a capability, and slug lookup as a TYPED identity.
 *
 * Two audit findings, both about the /posts routes handing out something the caller never earned:
 *
 *   #17 (routes half) — PUT/POST downgraded the STATUS when the actor lacks publish_<type>s and then
 *       forwarded `date` untouched. An explicit date is the ONLY thing that schedules (the model turns
 *       a future date into 'future' by itself), so the date was a publishing capability with no gate:
 *       a contributor could stamp their own draft in 2099, and `date` with NO status at all makes
 *       Post.update re-evaluate the CURRENT status — a future date on a published post unpublishes it.
 *
 *   #18 (read twin) — a slug is unique PER TYPE (generateUniqueSlug de-duplicates within one
 *       post_type), so a post `about` and a page `about` is an ordinary pair. GET /posts/slug/:slug
 *       looked the row up with NO type, and `WHERE post_name = ?` with nothing ordering it served
 *       whichever row came back first.
 *
 * Everything here goes through the REAL router with supertest and the REAL post-type registry: a
 * hand-built object would prove nothing about what the producer emits.
 *
 * Same config-repoint + CWD-sandbox ordering as the other supertest suites.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST (incidental writes stay out of the repo).
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-posts-date-slug-'));
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer / routers load.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const iso = (ms: number) => new Date(ms).toISOString();
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

describe('posts router: date capability + typed slug identity', () => {
    let request: any;
    let app: any;
    let dbAsync: any;
    let adminToken: string, authorToken: string, contributorToken: string;

    const as = (token: string) => (r: any) => r.set('Authorization', `Bearer ${token}`);

    /** The stored publication instant, straight out of the row the route wrote. */
    async function dateGmtOf(postId: number): Promise<string> {
        const row = await dbAsync.get('SELECT post_date_gmt FROM posts WHERE id = ?', [postId]);
        return String(row.post_date_gmt);
    }

    async function statusOf(postId: number): Promise<string> {
        const row = await dbAsync.get('SELECT post_status FROM posts WHERE id = ?', [postId]);
        return String(row.post_status);
    }

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

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        // The router's type gate (capsForType / isRestExposedPostType) resolves against the post-type
        // registry, which boot fills AFTER the DB connects — same here or every create 400s.
        await require('../core/post-types').initPostTypes();

        const adminId = await seedUser('admin', 'administrator');
        const authorId = await seedUser('author1', 'author');
        const contributorId = await seedUser('contrib', 'contributor');
        adminToken = sign(adminId, 'admin');
        authorToken = sign(authorId, 'author1');
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

    // ─────────────────────────────────────────────── #17: the date is a publishing capability

    it('PUT: a contributor sending {status:publish, date:2099} on their OWN draft moves neither', async () => {
        const created = await as(contributorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Contrib draft', status: 'draft', type: 'post' });
        assert.strictEqual(created.status, 201);
        const id = created.body.id;
        const before = await dateGmtOf(id);

        const res = await as(contributorToken)(request(app).put(`/api/v1/posts/${id}`))
            .send({ status: 'publish', date: FAR_FUTURE });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'pending', 'the status downgrade still happens');
        assert.strictEqual(
            await dateGmtOf(id), before,
            'the ungated date must NOT be written: post_date_gmt stays exactly where it was'
        );
        assert.ok(!(await dateGmtOf(id)).startsWith('2099'), 'no 2099 stamp survives the downgrade');
    });

    it('PUT: `date` with NO status is the same capability — a contributor cannot move it either', async () => {
        const created = await as(contributorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Contrib draft 2', status: 'draft', type: 'post' });
        assert.strictEqual(created.status, 201);
        const id = created.body.id;
        const before = await dateGmtOf(id);

        // Post.update re-evaluates the CURRENT status against a bare date, so this shape is how a
        // future date unpublishes live content without ever naming a status.
        const res = await as(contributorToken)(request(app).put(`/api/v1/posts/${id}`))
            .send({ date: FAR_FUTURE });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await dateGmtOf(id), before, 'a bare date is gated exactly like a dated publish');
        assert.strictEqual(await statusOf(id), 'draft', 'and the status cannot be flipped through it');
    });

    it('POST: the create path carries the same gate (contributor → pending, and dated NOW)', async () => {
        const res = await as(contributorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Contrib dated create', status: 'publish', type: 'post', date: FAR_FUTURE });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.status, 'pending', 'scheduling IS publishing — downgraded');
        const stored = await dateGmtOf(res.body.id);
        assert.ok(!stored.startsWith('2099'), `the dropped date must not land in the row (got ${stored})`);
    });

    it('CONTROL: a user who MAY publish still schedules — an explicit date is the only way to', async () => {
        const when = Date.now() + 3_600_000;
        const created = await as(authorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Author draft', status: 'draft', type: 'post' });
        assert.strictEqual(created.status, 201);

        const res = await as(authorToken)(request(app).put(`/api/v1/posts/${created.body.id}`))
            .send({ status: 'publish', date: iso(when) });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'future', 'the gate must not break scheduling for the capable');
        assert.ok((await dateGmtOf(created.body.id)).startsWith(iso(when).slice(0, 10)), 'the chosen day is stored');
    });

    // ─────────────────────────────────────────────── #18 twin: slug lookup is typed

    let postId: number, pageId: number;

    it('a post and a page may legally share a slug (generateUniqueSlug is per type)', async () => {
        const p = await as(adminToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'About the blog', slug: 'about', status: 'publish', type: 'post' });
        assert.strictEqual(p.status, 201);
        postId = p.body.id;

        const pg = await as(adminToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'About us', slug: 'about', status: 'publish', type: 'page' });
        assert.strictEqual(pg.status, 201);
        pageId = pg.body.id;

        const row = await dbAsync.get('SELECT post_name FROM posts WHERE id = ?', [pageId]);
        assert.strictEqual(row.post_name, 'about', 'the page keeps the slug — the collision is real, not de-duplicated');
        assert.notStrictEqual(postId, pageId);
    });

    it('GET /slug/:slug?type=page returns the PAGE, not whichever row came first', async () => {
        const res = await request(app).get('/api/v1/posts/slug/about').query({ type: 'page' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.id, pageId, 'the declared type decides the identity');
        assert.strictEqual(res.body.type, 'page');
    });

    it('GET /slug/:slug?type=post returns the POST', async () => {
        const res = await request(app).get('/api/v1/posts/slug/about').query({ type: 'post' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.id, postId);
        assert.strictEqual(res.body.type, 'post');
    });

    it('with NO declared type the answer is DETERMINISTIC (post wins) and repeats', async () => {
        for (let i = 0; i < 3; i++) {
            const res = await request(app).get('/api/v1/posts/slug/about');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.id, postId, 'same request, same row, every time');
        }
    });

    it('a page-only slug still resolves without a declared type (the precedence falls through)', async () => {
        const pg = await as(adminToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Contact', slug: 'contact-only', status: 'publish', type: 'page' });
        assert.strictEqual(pg.status, 201);

        const res = await request(app).get('/api/v1/posts/slug/contact-only');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.id, pg.body.id, 'pages stay reachable at the bare slug URL');
    });

    it('an INTERNAL type cannot be addressed by slug either (400, same rule as the list)', async () => {
        const res = await request(app).get('/api/v1/posts/slug/about').query({ type: 'nav_menu_item' });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.code, 'rest_invalid_post_type');
    });

    // UNREGISTERED is NOT internal — and this assertion used to say it was, which is how the two
    // guards over one invariant went on contradicting each other: the LIST accepts an unregistered
    // type (isInternalPostType) while this route refused it (isRestExposedPostType), so after a
    // `DELETE /types/book` the content was listable and not readable by slug. Both routes now ask the
    // same question, and an unregistered type simply resolves to "no such slug".
    it('an UNREGISTERED type is ADDRESSABLE (404 for a slug it has no row for), like the list', async () => {
        const res = await request(app).get('/api/v1/posts/slug/about').query({ type: 'not_a_type' });
        assert.strictEqual(res.status, 404, 'the list accepts this type; the slug route must not 400 on it');
        const list = await request(app).get('/api/v1/posts').query({ type: 'not_a_type' });
        assert.strictEqual(list.status, 200, 'the two guards must agree about what a type is');
    });
});
