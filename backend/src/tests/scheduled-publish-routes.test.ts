/**
 * SCHEDULED PUBLISHING through the REAL posts router (supertest) — the author-facing seam.
 *
 * The model suite (scheduled-publish.test.ts) proves the engine; THIS suite pins the two places an
 * author actually touches it, which is exactly where the feature used to be unreachable/invisible:
 *
 *   • the admin LIST: status=any must include 'future' (the regression: a scheduled post vanished
 *     from the admin table until its publish moment), the explicit ?status=future filter works, and
 *     X-WP-Total counts scheduled posts — all WITHOUT widening the BOLA scoping (a non-privileged
 *     author only ever sees their OWN scheduled posts; anonymous callers never see any);
 *   • the editor's WRITE path: POST/PUT with status 'publish' + a future date schedules (arms exactly
 *     one flip event), re-dating re-arms it, moving to draft cancels it, publish-now flips it live —
 *     and the publish-capability gate treats 'future' AS publishing, so a contributor cannot schedule
 *     around review (neither via a future-dated 'publish' nor via an explicit status: 'future').
 *
 * Same config-repoint + CWD-sandbox ordering as the other supertest suites.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST (incidental writes stay out of the repo).
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-sched-routes-'));
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer / routers load.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const iso = (ms: number) => new Date(ms).toISOString();

describe('scheduled posts through the posts router', () => {
    let request: any;
    let app: any;
    let dbAsync: any;
    let scheduledPublish: any;
    let options: any;
    let adminToken: string, authorToken: string, author2Token: string, contributorToken: string;
    let authorId: number, author2Id: number;

    // Ids created by the flow tests, shared down the (sequential) suite.
    let scheduledId: number;      // author's scheduled post
    let scheduled2Id: number;     // author2's scheduled post
    const NOW = Date.now();
    const WHEN1 = NOW + 3_600_000;   // +1h
    const WHEN2 = NOW + 7_200_000;   // +2h

    const as = (token: string) => (r: any) => r.set('Authorization', `Bearer ${token}`);

    /** Count of pending flip events for a post id in the persisted 'cron' option blob. */
    async function eventCountFor(postId: number): Promise<number> {
        const events = await options.getOption('cron', {});
        const wanted = JSON.stringify([postId]);
        let n = 0;
        for (const ts of Object.keys(events || {})) {
            for (const key of Object.keys(events[ts] || {})) {
                const e = events[ts][key];
                if (e && e.hook === scheduledPublish.FUTURE_HOOK && JSON.stringify(e.args) === wanted) n++;
            }
        }
        return n;
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
        // The router's type gate (capsForType) resolves against the post-type registry, which boot
        // fills AFTER the DB connects — same here or every create 400s as an unregistered type.
        await require('../core/post-types').initPostTypes();
        scheduledPublish = require('../core/scheduled-publish');
        options = require('../core/options');

        const adminId = await seedUser('admin', 'administrator');
        authorId = await seedUser('author1', 'author');
        author2Id = await seedUser('author2', 'author');
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

        // A published and a draft post (author's), so filters have something to EXCLUDE.
        const mk = (body: any) => as(authorToken)(request(app).post('/api/v1/posts')).send(body);
        assert.strictEqual((await mk({ title: 'Live one', status: 'publish', type: 'post' })).status, 201);
        assert.strictEqual((await mk({ title: 'Draft one', status: 'draft', type: 'post' })).status, 201);
    });

    after(async () => {
        try { await database.close?.(); } catch { /* */ }
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    // ───────────────────────────────────────────────────────────────────────── editor write path

    it('POST publish + future date → 201 as future, exactly one flip event armed at that moment', async () => {
        const res = await as(authorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Scheduled by author', status: 'publish', type: 'post', date: iso(WHEN1) });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.status, 'future', 'a future-dated publish must come back as future');
        scheduledId = res.body.id;
        assert.strictEqual(await eventCountFor(scheduledId), 1, 'exactly one flip event armed');
        assert.strictEqual(await scheduledPublish.nextScheduledPublish(scheduledId), WHEN1, 'armed at the scheduled moment');
    });

    // ───────────────────────────────────────────────────────────────────────── admin list visibility

    it('REGRESSION: status=any includes the scheduled post (and X-WP-Total counts it)', async () => {
        const res = await as(adminToken)(request(app).get('/api/v1/posts'))
            .query({ status: 'any', type: 'post', per_page: 100 });
        assert.strictEqual(res.status, 200);
        const hit = res.body.find((p: any) => p.id === scheduledId);
        assert.ok(hit, "the scheduled post must appear in the admin 'All' listing");
        assert.strictEqual(hit.status, 'future', 'the payload carries the badge-driving status');
        assert.ok(parseInt(res.headers['x-wp-total'], 10) >= 3, 'the total counts publish+draft+future');
    });

    it('explicit ?status=future returns exactly the scheduled posts', async () => {
        const res = await as(adminToken)(request(app).get('/api/v1/posts'))
            .query({ status: 'future', type: 'post', per_page: 100 });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.length >= 1);
        assert.ok(res.body.every((p: any) => p.status === 'future'), 'only future posts in the filtered view');
        assert.ok(res.body.some((p: any) => p.id === scheduledId));
        assert.strictEqual(parseInt(res.headers['x-wp-total'], 10), res.body.length, 'count matches the filter');
    });

    it("BOLA scoping intact: a non-privileged author never sees another author's scheduled post", async () => {
        const created = await as(author2Token)(request(app).post('/api/v1/posts'))
            .send({ title: 'Scheduled by author2', status: 'publish', type: 'post', date: iso(WHEN1) });
        assert.strictEqual(created.status, 201);
        assert.strictEqual(created.body.status, 'future');
        scheduled2Id = created.body.id;

        for (const status of ['any', 'future']) {
            const res = await as(author2Token)(request(app).get('/api/v1/posts'))
                .query({ status, type: 'post', per_page: 100 });
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.some((p: any) => p.id === scheduled2Id), `own scheduled post visible via status=${status}`);
            assert.ok(!res.body.some((p: any) => p.id === scheduledId), `author1's scheduled post must NOT leak via status=${status}`);
        }
    });

    it('anonymous callers never see a scheduled post (any, future, and the default public list)', async () => {
        for (const query of [{ status: 'any' }, { status: 'future' }, {}]) {
            const res = await request(app).get('/api/v1/posts').query({ ...query, type: 'post', per_page: 100 });
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.every((p: any) => p.status === 'publish'), `only published content for anon (${JSON.stringify(query)})`);
            assert.ok(!res.body.some((p: any) => p.id === scheduledId || p.id === scheduled2Id), 'no scheduled post leaks');
        }
    });

    // ───────────────────────────────────────────────────────────────────────── reschedule / unschedule

    it('PUT with a new future date re-arms the single flip event (no orphans)', async () => {
        const res = await as(authorToken)(request(app).put(`/api/v1/posts/${scheduledId}`))
            .send({ status: 'publish', date: iso(WHEN2) });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'future', 'still scheduled, at the new moment');
        assert.strictEqual(await eventCountFor(scheduledId), 1, 're-dating leaves exactly one event');
        assert.strictEqual(await scheduledPublish.nextScheduledPublish(scheduledId), WHEN2, 'armed at the NEW moment');
    });

    it('unpublish (future → draft) cancels the pending flip event', async () => {
        const res = await as(authorToken)(request(app).put(`/api/v1/posts/${scheduledId}`))
            .send({ status: 'draft' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'draft');
        assert.strictEqual(await eventCountFor(scheduledId), 0, 'no orphan event survives leaving future');
        assert.strictEqual(await scheduledPublish.nextScheduledPublish(scheduledId), false);
    });

    it('publish-now (future → publish with a present date) goes live immediately, no event left', async () => {
        const res = await as(author2Token)(request(app).put(`/api/v1/posts/${scheduled2Id}`))
            .send({ status: 'publish', date: iso(Date.now() - 1000) });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'publish', 'an explicit present date beats the stored future one');
        assert.strictEqual(await eventCountFor(scheduled2Id), 0);
    });

    // ───────────────────────────────────────────────────────────────────────── capability gate

    it('a contributor cannot schedule around the publish gate (future-dated publish → pending, no event)', async () => {
        const res = await as(contributorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Contrib schedule attempt', status: 'publish', type: 'post', date: iso(WHEN1) });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.status, 'pending', 'downgraded to pending — scheduling IS publishing');
        assert.strictEqual(await eventCountFor(res.body.id), 0, 'no flip event for a pending post');
    });

    it("a contributor sending status 'future' explicitly is downgraded the same way", async () => {
        const res = await as(contributorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Contrib explicit future', status: 'future', type: 'post', date: iso(WHEN1) });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.status, 'pending', "explicit 'future' must clear the same publish bar");
        assert.strictEqual(await eventCountFor(res.body.id), 0);
    });
});
