/**
 * NO COMMENT SURFACE SERVES THE APPROVED COMMENTS OF AN ENTRY THE READER MAY NOT READ — the whole matrix.
 *
 * Earlier rounds closed the comment list for drafts, private and protected entries (content-read-authz)
 * and for entries of an unknown type (posts-unknown-type-read-closed), one surface or one kind of entry
 * at a time. This file walks every pair at once, so a surface that judges one kind of entry differently
 * from the others shows up as one red cell:
 *
 *   entries   — a published post and page (the controls), a published entry of a REGISTERED type with
 *               `public: false`, a published entry of a type the registry does not know, a draft, a
 *               pending, a private, a scheduled (`future`) and a trashed post, a password-protected
 *               published post, and an internal-type row (nav_menu_item) — each with one APPROVED comment;
 *   callers   — anonymous, and a logged-in subscriber (who reads nothing beyond the public site);
 *   surfaces  — GET /comments (the list and X-WP-Total), GET /comments?post=<id>, GET /comments?search=,
 *               GET /comments?parent=<a hidden comment> (replies), GET /comments/:id, and the comments
 *               RSS feed (GET /seo/comments/feed.xml).
 *
 * The assertion is on what is served: the comment texts in each answer and the totals, never only on
 * status codes. A moderator still sees everything, and an author still reads the comments of their own
 * private entry (the positive controls that keep the filter from passing by serving nothing).
 *
 * MUTATION PROOF: let the public filter of GET /comments name every registered type instead of the
 * public ones (8 cells fail), drop the status/password half of Comment._buildWhere's EXISTS (16), or drop
 * the readability check of GET /comments/:id (18).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-comments-matrix-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use('/api/v1', require('../routes'));

const U: Record<string, number> = {};
let db: any;
let seq = 0;

const tok = (login: string) => jwt.sign({ userId: U[login], username: login }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
const get = (who: string | null, p: string) => {
    const r = request(app).get(`/api/v1${p}`);
    return who ? r.set('Authorization', `Bearer ${tok(who)}`) : r;
};

async function seedUser(login: string, role: string) {
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`, [login, `${login}@example.com`, login]);
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

async function seedEntry(author: number, status: string, type: string, opts: { password?: string; future?: boolean } = {}): Promise<number> {
    seq++;
    const date = opts.future ? '2999-01-01 00:00:00' : '2020-01-01 00:00:00';
    const r = await db.run(
        `INSERT INTO posts (author_id, post_date, post_date_gmt, post_title, post_content, post_status, post_type, post_name, post_password, comment_status, post_modified, post_modified_gmt)
         VALUES (?, ?, ?, ?, 'body', ?, ?, ?, ?, 'open', ?, ?)`,
        [author, date, date, `Entry ${seq}`, status, type, `matrix-${seq}`, opts.password || '', date, date]);
    return Number(r.lastID);
}

async function seedComment(postId: number, content: string, opts: { parent?: number; approved?: string } = {}): Promise<number> {
    const r = await db.run(
        `INSERT INTO comments (comment_post_id, comment_author, comment_author_email, comment_content, comment_approved, user_id, comment_type, comment_parent)
         VALUES (?, 'Guest', 'guest@example.com', ?, ?, 0, 'comment', ?)`,
        [postId, content, opts.approved || '1', opts.parent || 0]);
    return Number(r.lastID);
}

// name → { post id, approved comment id }. The comment text is `cmx-<name>`, so an answer is read by name.
const E: Record<string, { post: number; comment: number }> = {};
const VISIBLE = ['post', 'page'];
const HIDDEN = ['nonpublic_type', 'unknown_type', 'draft', 'pending', 'private', 'future', 'trash', 'protected', 'internal'];
let hiddenReply = 0;

const textsOf = (res: any): string[] => (Array.isArray(res.body) ? res.body : []).map((c: any) => String(c.content && (c.content.rendered ?? c.content)));
const namesIn = (res: any): string[] => textsOf(res).map((t) => (/cmx-([a-z_]+)/.exec(t) || [])[1]).filter(Boolean).sort();

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    db = database.getDbAsync();
    const postTypes = require('../core/post-types');
    await postTypes.initPostTypes();
    await postTypes.saveCustomPostType('memo', { public: false, showInRest: true, capability_type: 'memo', label: 'Memos' });
    await require('../core/roles').loadRoles();
    await seedUser('author', 'author');
    await seedUser('subscriber', 'subscriber');
    await seedUser('editor', 'editor');

    const a = U.author;
    const entries: Record<string, number> = {
        post: await seedEntry(a, 'publish', 'post'),
        page: await seedEntry(a, 'publish', 'page'),
        nonpublic_type: await seedEntry(a, 'publish', 'memo'),
        unknown_type: await seedEntry(a, 'publish', 'shop_coupon'),
        draft: await seedEntry(a, 'draft', 'post'),
        pending: await seedEntry(a, 'pending', 'post'),
        private: await seedEntry(a, 'private', 'post'),
        future: await seedEntry(a, 'future', 'post', { future: true }),
        trash: await seedEntry(a, 'trash', 'post'),
        protected: await seedEntry(a, 'publish', 'post', { password: 'open-sesame' }),
        internal: await seedEntry(a, 'publish', 'nav_menu_item'),
    };
    for (const [name, post] of Object.entries(entries)) E[name] = { post, comment: await seedComment(post, `cmx-${name} says hello`) };
    // A reply under a hidden entry's comment, and a still-pending comment on the public post.
    hiddenReply = await seedComment(E.draft.post, 'cmx-draft reply', { parent: E.draft.comment });
    await seedComment(E.post.post, 'cmx-pending_on_public', { approved: '0' });
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

for (const who of [null, 'subscriber'] as const) {
    const label = who || 'anonymous';
    describe(`${label}`, () => {
        it('GET /comments lists only the public entries\' approved comments, and X-WP-Total counts only those', async () => {
            const res = await get(who, '/comments?per_page=100');
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.deepStrictEqual(namesIn(res), VISIBLE.slice().sort());
            assert.strictEqual(res.headers['x-wp-total'], String(VISIBLE.length));
            assert.strictEqual(res.headers['x-wp-totalpages'], '1');
        });

        for (const name of HIDDEN) {
            it(`?post= of the ${name} entry: nothing, and a total of 0`, async () => {
                const res = await get(who, `/comments?post=${E[name].post}`);
                assert.strictEqual(res.status, 200);
                assert.deepStrictEqual(textsOf(res), [], `served: ${JSON.stringify(textsOf(res))}`);
                assert.strictEqual(res.headers['x-wp-total'], '0');
            });
            it(`GET /comments/:id of the ${name} entry's comment: the 404 of a missing comment`, async () => {
                const res = await get(who, `/comments/${E[name].comment}`);
                assert.strictEqual(res.status, 404, JSON.stringify(res.body));
                assert.strictEqual(res.body.code, 'rest_comment_invalid_id');
                assert.ok(!JSON.stringify(res.body).includes('cmx-'), 'no comment text in the refusal');
            });
        }

        it('?post= of a public entry serves its approved comments only (control)', async () => {
            const res = await get(who, `/comments?post=${E.post.post}`);
            assert.deepStrictEqual(namesIn(res), ['post']);
            assert.strictEqual(res.headers['x-wp-total'], '1');
            assert.strictEqual((await get(who, `/comments/${E.page.comment}`)).status, 200);
        });

        it('?search= and ?parent= reach no hidden comment', async () => {
            const res = await get(who, '/comments?per_page=100&search=says%20hello');
            assert.deepStrictEqual(namesIn(res), VISIBLE.slice().sort());
            assert.strictEqual(res.headers['x-wp-total'], String(VISIBLE.length));
            const replies = await get(who, `/comments?parent=${E.draft.comment}`);
            assert.deepStrictEqual(textsOf(replies), []);
            assert.strictEqual(replies.headers['x-wp-total'], '0');
            assert.strictEqual((await get(who, `/comments/${hiddenReply}`)).status, 404);
        });
    });
}

describe('the comments feed', () => {
    it('carries only the public entries\' comments', async () => {
        const res = await get(null, '/seo/comments/feed.xml');
        assert.strictEqual(res.status, 200);
        const xml = String(res.text);
        for (const name of VISIBLE) assert.ok(xml.includes(`cmx-${name}`), `the feed lost ${name}`);
        for (const name of [...HIDDEN, 'pending_on_public']) assert.ok(!xml.includes(`cmx-${name}`), `the feed served ${name}`);
        assert.ok(!xml.includes('cmx-draft reply'));
    });
});

describe('the positive controls', () => {
    it('a moderator sees every approved comment, pending ones included on request', async () => {
        const res = await get('editor', '/comments?per_page=100&status=any');
        const names = namesIn(res);
        for (const name of [...VISIBLE, ...HIDDEN, 'pending_on_public']) assert.ok(names.includes(name), `the moderator lost ${name}`);
    });

    it('the author reads the comments of their own private and draft entries', async () => {
        for (const name of ['private', 'draft']) {
            const res = await get('author', `/comments?post=${E[name].post}`);
            assert.ok(namesIn(res).includes(name), `${name}: ${JSON.stringify(textsOf(res))}`);
            assert.strictEqual((await get('author', `/comments/${E[name].comment}`)).status, 200);
        }
    });
});
