/**
 * CONTENT READ/WRITE AUTHORIZATION — the editorial and visibility rules the REST surface must apply to
 * entries that are past review (scheduled, private), to comments of entries a caller cannot read, to
 * internal post meta, and to password-protected entries.
 *
 * Each block is a regression for a defect that was reachable over HTTP:
 *  · a contributor could rewrite their OWN scheduled ('future') post after an editor approved it, and
 *    mark their own draft 'private', because only the literal 'publish' carried the published bar;
 *  · approved comments of drafts/private entries were listed (and fetched by id) anonymously, anyone
 *    could comment on a draft, and the 404/403 split revealed which post ids exist;
 *  · an anonymous comment search matched on the private comment_author_email (a LIKE oracle);
 *  · every meta key — `_wjs_review_comments`, the editorial review thread, included — was public;
 *  · a password-protected entry (WXR import keeps wp:post_password) was served in full, matched by
 *    search and summarised in feeds.
 *
 * Every refusal is paired with a positive control (an editor, the owner, a public entry), so a 403/404
 * can never pass because the route or the fixture is broken.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-content-read-authz-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));

const U: Record<string, number> = {};
let db: any;
let seq = 0;

const tok = (id: number, login: string) => jwt.sign({ userId: id, username: login }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
const anon = (m: string, p: string) => (request(app) as any)[m](`/api/v1${p}`);
const as = (who: string, m: string, p: string) => anon(m, p).set('Authorization', `Bearer ${tok(U[who], who)}`);

async function seedUser(login: string, role: string) {
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`, [login, `${login}@example.com`, login]);
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

async function seedPost(author: number, status: string, extra: { content?: string; password?: string; type?: string } = {}) {
    seq++;
    const r = await db.run(
        `INSERT INTO posts (author_id, post_title, post_content, post_status, post_type, post_name, post_password, comment_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
        [author, `T${seq}`, extra.content || 'body', status, extra.type || 'post', `cra-${seq}`, extra.password || '']);
    return r.lastID;
}

async function seedComment(postId: number, content: string, email = 'someone@example.com') {
    const r = await db.run(
        `INSERT INTO comments (comment_post_id, comment_author, comment_author_email, comment_content, comment_approved, user_id, comment_type)
         VALUES (?, 'Guest', ?, ?, '1', 0, 'comment')`,
        [postId, email, content]);
    return r.lastID;
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    db = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    await seedUser('editor', 'editor');
    await seedUser('author', 'author');
    await seedUser('contrib', 'contributor');
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { fs.rmSync(f, { force: true }); } catch { /* */ }
    }
});

describe('scheduled and private entries carry the published bar', () => {
    test('a contributor cannot rewrite their own SCHEDULED post after approval; an editor can', async () => {
        const id = await seedPost(U.contrib, 'future', { content: 'reviewed copy' });
        await db.run("UPDATE posts SET post_date='2099-01-01 00:00:00', post_date_gmt='2099-01-01 00:00:00' WHERE id=?", [id]);

        const r = await as('contrib', 'put', `/posts/${id}`).send({ content: 'UNREVIEWED copy' });
        assert.strictEqual(r.status, 403);
        const row = await db.get('SELECT post_status, post_content FROM posts WHERE id=?', [id]);
        assert.strictEqual(row.post_content, 'reviewed copy');
        assert.strictEqual(row.post_status, 'future');

        const ok = await as('editor', 'put', `/posts/${id}`).send({ content: 'editor copy' });
        assert.strictEqual(ok.status, 200);
    });

    test('a contributor cannot delete their own scheduled or private post; the author role can delete its own', async () => {
        const fut = await seedPost(U.contrib, 'future');
        const priv = await seedPost(U.contrib, 'private');
        assert.strictEqual((await as('contrib', 'delete', `/posts/${fut}`)).status, 403);
        assert.strictEqual((await as('contrib', 'delete', `/posts/${priv}`)).status, 403);
        const own = await seedPost(U.author, 'future');
        assert.strictEqual((await as('author', 'delete', `/posts/${own}`)).status, 200);
    });

    test('a contributor cannot edit their own private post', async () => {
        const id = await seedPost(U.contrib, 'private');
        assert.strictEqual((await as('contrib', 'put', `/posts/${id}`).send({ title: 'x' })).status, 403);
        const own = await seedPost(U.author, 'private');
        assert.strictEqual((await as('author', 'put', `/posts/${own}`).send({ title: 'mine' })).status, 200);
    });

    test('a contributor cannot make a draft private (PUT or POST); an author can', async () => {
        const d = await seedPost(U.contrib, 'draft');
        const p = await as('contrib', 'put', `/posts/${d}`).send({ status: 'private' });
        assert.strictEqual(p.status, 403);
        assert.strictEqual((await db.get('SELECT post_status FROM posts WHERE id=?', [d])).post_status, 'draft');

        const c = await as('contrib', 'post', '/posts').send({ title: 'secretly live', status: 'private' });
        assert.strictEqual(c.status, 403);

        const a = await as('author', 'post', '/posts').send({ title: 'author private', status: 'private' });
        assert.strictEqual(a.status, 201);
        assert.strictEqual(a.body.status, 'private');
    });

    test('status is validated against the writable set', async () => {
        // An unknown value is already refused by the type's generated contract (whatever code it uses);
        // the route's own allowlist is what refuses the lifecycle-internal ones the contract accepts.
        const c = await as('editor', 'post', '/posts').send({ title: 'odd', status: 'whatever' });
        assert.strictEqual(c.status, 400);
        const ad = await as('contrib', 'post', '/posts').send({ title: 'odd', status: 'auto-draft' });
        assert.strictEqual(ad.status, 400);
        assert.strictEqual(ad.body.code, 'rest_invalid_param');

        const d = await seedPost(U.contrib, 'draft');
        const t = await as('contrib', 'put', `/posts/${d}`).send({ status: 'trash' });
        assert.strictEqual(t.status, 400, 'trashing goes through DELETE and its delete gate, not PUT');
        assert.strictEqual((await db.get('SELECT post_status FROM posts WHERE id=?', [d])).post_status, 'draft');

        // Positive control: an ordinary transition still works.
        const ok = await as('contrib', 'put', `/posts/${d}`).send({ status: 'pending' });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.body.status, 'pending');
    });
});

describe('comments follow the readability of their entry', () => {
    let draft = 0, priv = 0, pub = 0, prot = 0;
    before(async () => {
        draft = await seedPost(U.editor, 'draft');
        priv = await seedPost(U.editor, 'private');
        pub = await seedPost(U.editor, 'publish');
        prot = await seedPost(U.editor, 'publish', { password: 'hunter2' });
        for (const pid of [draft, priv, pub, prot]) await seedComment(pid, `note on ${pid}`);
    });

    test('anonymous list never includes comments of draft/private/protected entries', async () => {
        for (const pid of [draft, priv, prot]) {
            const l = await anon('get', `/comments?post=${pid}`);
            assert.strictEqual(l.status, 200);
            assert.strictEqual(l.body.length, 0, `post ${pid}`);
            assert.strictEqual(l.headers['x-wp-total'], '0');
        }
        const all = await anon('get', '/comments?per_page=100');
        const postIds = all.body.map((c: any) => c.postId);
        assert.ok(postIds.includes(pub), 'positive control: the published entry\'s comment is listed');
        for (const pid of [draft, priv, prot]) assert.ok(!postIds.includes(pid));
    });

    test('a moderator still sees them all; the owner sees their own private entry\'s comments', async () => {
        const m = await as('editor', 'get', `/comments?post=${priv}`);
        assert.strictEqual(m.body.length, 1);
        const own = await seedPost(U.author, 'private');
        await seedComment(own, 'on my private entry');
        const o = await as('author', 'get', `/comments?post=${own}`);
        assert.strictEqual(o.body.length, 1);
        assert.strictEqual((await anon('get', `/comments?post=${own}`)).body.length, 0);
    });

    test('GET /comments/:id answers the same 404 for a comment of an unreadable entry', async () => {
        const hidden = await seedComment(draft, 'hidden by id');
        const visible = await seedComment(pub, 'visible by id');
        const h = await anon('get', `/comments/${hidden}`);
        const missing = await anon('get', '/comments/99999999');
        assert.strictEqual(h.status, 404);
        assert.deepStrictEqual(h.body, missing.body);
        assert.strictEqual((await anon('get', `/comments/${visible}`)).status, 200);
        assert.strictEqual((await as('editor', 'get', `/comments/${hidden}`)).status, 200);
    });

    test('nobody can comment on a draft, and a draft answers like a missing post', async () => {
        const body = { content: 'hi', author_name: 'x', author_email: 'x@x.example' };
        const w = await anon('post', '/comments').send({ ...body, post: draft });
        const missing = await anon('post', '/comments').send({ ...body, post: 99999999 });
        assert.strictEqual(w.status, 404);
        assert.strictEqual(missing.status, 404);
        assert.deepStrictEqual(w.body, missing.body);
        assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM comments WHERE comment_post_id = ? AND comment_content = ?', [draft, 'hi'])).n, 0);
        const prv = await anon('post', '/comments').send({ ...body, post: priv });
        assert.strictEqual(prv.status, 404);
        const ok = await anon('post', '/comments').send({ ...body, content: 'on the public one', post: pub });
        assert.strictEqual(ok.status, 201, 'positive control: a published entry takes comments');
    });

    test('anonymous search does not match on the commenter email; a moderator\'s does', async () => {
        await seedComment(pub, 'nice', 'bob.hidden@victim.example');
        const q = `/comments?search=${encodeURIComponent('bob.hidden@vic')}`;
        const a = await anon('get', q);
        assert.strictEqual(a.status, 200);
        assert.strictEqual(a.body.length, 0);
        assert.strictEqual(a.headers['x-wp-total'], '0');
        const m = await as('editor', 'get', q);
        assert.strictEqual(m.body.length, 1);
        // Positive control: content search still works for everyone.
        assert.ok((await anon('get', '/comments?search=nice')).body.length >= 1);
    });
});

describe('internal post meta is not public', () => {
    let pub = 0;
    before(async () => {
        pub = await seedPost(U.contrib, 'publish');
        const meta: Array<[string, string]> = [
            ['_wjs_review_comments', JSON.stringify([{ author: 'editor', text: 'legal says do not publish the Q3 numbers' }])],
            ['_plugin_internal_state', 'secret'],
            ['_wjs_template', 'wide'],
            ['_thumbnail_id', '0'],
            ['seo_title', 'Public SEO title'],
        ];
        for (const [k, v] of meta) await db.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [pub, k, v]);
    });

    test('anonymous GET /posts/:id and /posts/:id/meta drop the review thread and unknown _ keys', async () => {
        for (const r of [(await anon('get', `/posts/${pub}`)).body.meta, (await anon('get', `/posts/${pub}/meta`)).body]) {
            assert.ok(!('_wjs_review_comments' in r));
            assert.ok(!('_plugin_internal_state' in r));
            assert.strictEqual(r._wjs_template, 'wide', 'keys the public site renders stay');
            assert.strictEqual(r.seo_title, 'Public SEO title');
        }
        const list = await anon('get', '/posts?per_page=100');
        const row = list.body.find((p: any) => p.id === pub);
        assert.ok(row && !('_wjs_review_comments' in row.meta));
    });

    test('the author (even unable to edit the published entry) and editors keep the full map', async () => {
        for (const who of ['contrib', 'editor']) {
            const r = await as(who, 'get', `/posts/${pub}/meta`);
            assert.ok(r.body._wjs_review_comments, who);
            const p = await as(who, 'get', `/posts/${pub}`);
            assert.ok(p.body.meta._wjs_review_comments, who);
        }
        // Another author is not one of the people working on this entry.
        assert.ok(!('_wjs_review_comments' in (await as('author', 'get', `/posts/${pub}/meta`)).body));
    });
});

describe('password-protected entries', () => {
    let pp = 0;
    before(async () => {
        pp = await seedPost(U.editor, 'publish', { content: 'members-only zebracorn secret', password: 'hunter2' });
        await db.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [pp, '_puck_data', JSON.stringify({ content: [{ type: 'Text', props: { text: 'zebracorn' } }] })]);
    });

    test('anonymous reads get protected:true with no body, excerpt or page tree', async () => {
        const r = await anon('get', `/posts/${pp}`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.protected, true);
        assert.strictEqual(r.body.content, '');
        assert.strictEqual(r.body.excerpt, '');
        assert.ok(!('_puck_data' in r.body.meta));
        assert.ok(r.body.title, 'the title stays, like WordPress');
        const slug = await anon('get', `/posts/slug/${r.body.slug}`);
        assert.strictEqual(slug.body.content, '');
        assert.ok(!JSON.stringify((await anon('get', `/posts/${pp}/meta`)).body).includes('zebracorn'));
        // Positive control: an ordinary entry is not protected.
        const open = await seedPost(U.editor, 'publish', { content: 'open body' });
        const o = await anon('get', `/posts/${open}`);
        assert.strictEqual(o.body.protected, false);
        assert.match(o.body.content, /open body/);
    });

    test('an editor still reads the protected body', async () => {
        const r = await as('editor', 'get', `/posts/${pp}`);
        assert.strictEqual(r.body.protected, true);
        assert.match(r.body.content, /zebracorn/);
        assert.ok(r.body.meta._puck_data);
    });

    test('anonymous search does not match on a protected body; an editor\'s search does', async () => {
        const a = await anon('get', '/posts?search=zebracorn');
        assert.strictEqual(a.status, 200);
        assert.ok(!a.body.some((p: any) => p.id === pp));
        assert.strictEqual(a.headers['x-wp-total'], '0');
        const e = await as('editor', 'get', '/posts?search=zebracorn');
        assert.ok(e.body.some((p: any) => p.id === pp));
    });

    test('feeds publish a placeholder instead of the summary; the sitemap omits the entry', async () => {
        const seo = express();
        seo.use('/', require('../routes/seo'));
        for (const feed of ['/feed.xml', '/feed.atom', '/feed.json']) {
            const r = await (request(seo) as any).get(feed);
            assert.strictEqual(r.status, 200, feed);
            const text = r.text || String(r.body);
            assert.ok(!text.includes('zebracorn'), `${feed} leaks the protected body`);
            assert.ok(text.includes('There is no excerpt because this is a protected post.'), feed);
        }
        const slug = (await db.get('SELECT post_name FROM posts WHERE id=?', [pp])).post_name;
        const openSlug = (await db.get("SELECT post_name FROM posts WHERE post_status='publish' AND post_type='post' AND post_password='' ORDER BY id DESC LIMIT 1")).post_name;
        // Below the chunking threshold the index route serves the single urlset itself.
        const sm = await (request(seo) as any).get('/sitemap.xml');
        assert.strictEqual(sm.status, 200);
        assert.ok(String(sm.text).includes(openSlug), 'positive control: unprotected entries are listed');
        assert.ok(!String(sm.text).includes(`/${slug}<`), 'the protected entry is not submitted');
    });

    test('comments on a protected entry cannot be added anonymously', async () => {
        const w = await anon('post', '/comments').send({ post: pp, content: 'hi', author_name: 'x', author_email: 'x@x.example' });
        assert.strictEqual(w.status, 404);
    });
});
