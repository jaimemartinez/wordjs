/**
 * ONE PUBLIC URL, ONE ENTRY — an Author could take over a published page's address with a post.
 *
 * The public site resolves a bare slug WITHOUT a type (/<slug>, /pages/<slug> and /<archive>/<slug> all
 * call GET /posts/slug/:slug), walking the types in a fixed precedence, while Post.generateUniqueSlug
 * only de-duplicated WITHIN one type. An Author (publish_posts, no page capability at all: POST /posts
 * {type:'page'} and PUT on the page both answer 403) published a post `contact`, got the slug `contact`,
 * and — because `post` came before `page` — /contact served the Author's content in place of the page,
 * menu entry and sitemap line included. The same held for every custom type's entry (the untyped
 * fallback comes after `post`).
 *
 * Now every publicly routed type shares one slug namespace (the second entry gets `contact-2`,
 * whichever side comes second), and pairs that already exist resolve to the page.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-posts-slug-namespace-'));
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

describe('the slug namespace the public site resolves in is the one the writers keep unique', () => {
    let request: any, app: any, dbAsync: any;
    let adminToken: string, editorToken: string, authorToken: string;
    let authorId: number;

    const as = (token: string) => (r: any) => r.set('Authorization', `Bearer ${token}`);
    const sign = (userId: number, username: string) =>
        jwt.sign({ userId, username }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

    async function seedUser(login: string, role: string): Promise<number> {
        await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            [login, 'x', `${login}@example.com`, login]);
        const row = await dbAsync.get(`SELECT id FROM users WHERE user_login = ?`, [login]);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [row.id, role]);
        return row.id;
    }

    /** What an anonymous visitor of /<slug> is served (the frontend asks with no type). */
    async function publicIdAt(slug: string): Promise<number | null> {
        const res = await request(app).get(`/api/v1/posts/slug/${slug}`);
        return res.status === 200 ? res.body.id : null;
    }

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        const postTypes = require('../core/post-types');
        await postTypes.initPostTypes();
        postTypes.registerPostType('book', { public: true, capability_type: 'post', label: 'Books' });

        const adminId = await seedUser('admin', 'administrator');
        const editorId = await seedUser('editor1', 'editor');
        authorId = await seedUser('author1', 'author');
        adminToken = sign(adminId, 'admin');
        editorToken = sign(editorId, 'editor1');
        authorToken = sign(authorId, 'author1');

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use('/api/v1/posts', require('../routes/posts'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* */ }
        process.chdir(os.tmpdir());
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    it('an Author\'s published post cannot take a published page\'s URL', async () => {
        const page = await as(editorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Contact', slug: 'contact', status: 'publish', type: 'page', content: '<p>Write to us at office@example.com</p>' });
        assert.strictEqual(page.status, 201);
        assert.strictEqual(await publicIdAt('contact'), page.body.id, 'precondition: /contact is the page');

        // Precondition: the Author holds no page capability at all.
        const denied = await as(authorToken)(request(app).put(`/api/v1/posts/${page.body.id}`)).send({ title: 'x' });
        assert.strictEqual(denied.status, 403);

        const post = await as(authorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Contact', slug: 'contact', status: 'publish', type: 'post', content: '<p>Send your card details to evil@example.net</p>' });
        assert.strictEqual(post.status, 201, 'the Author may still publish the post');
        assert.notStrictEqual(post.body.slug, 'contact', 'it gets its own slug');
        assert.strictEqual(await publicIdAt('contact'), page.body.id, '/contact still serves the page');
        assert.strictEqual(await publicIdAt(post.body.slug), post.body.id, 'the post lives at its own URL');
    });

    it('…nor by renaming an existing post of theirs onto it', async () => {
        const page = await as(editorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Support', slug: 'support', status: 'publish', type: 'page' });
        assert.strictEqual(page.status, 201);
        const post = await as(authorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Harmless', slug: 'harmless', status: 'publish', type: 'post' });
        assert.strictEqual(post.status, 201);
        const renamed = await as(authorToken)(request(app).put(`/api/v1/posts/${post.body.id}`)).send({ slug: 'support' });
        assert.strictEqual(renamed.status, 200);
        assert.notStrictEqual(renamed.body.slug, 'support', 'the rename claimed the page\'s slug');
        assert.strictEqual(await publicIdAt('support'), page.body.id);
    });

    it('…nor a custom type\'s entry URL (the untyped fallback came after `post`)', async () => {
        const book = await as(adminToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Intro', slug: 'intro', status: 'publish', type: 'book' });
        assert.strictEqual(book.status, 201);
        assert.strictEqual(await publicIdAt('intro'), book.body.id, 'precondition: /books/intro → the book');

        const post = await as(authorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Intro', slug: 'intro', status: 'publish', type: 'post' });
        assert.strictEqual(post.status, 201);
        assert.notStrictEqual(post.body.slug, 'intro');
        assert.strictEqual(await publicIdAt('intro'), book.body.id, 'the book keeps its URL');
    });

    it('the namespace is shared both ways: a page created after a post gets its own slug too', async () => {
        const post = await as(authorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'News', slug: 'news', status: 'publish', type: 'post' });
        const page = await as(editorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'News', slug: 'news', status: 'publish', type: 'page' });
        assert.strictEqual(post.body.slug, 'news');
        assert.notStrictEqual(page.body.slug, 'news');
        assert.strictEqual(await publicIdAt('news'), post.body.id);
    });

    it('a pair that predates the shared namespace resolves to the page, not to the post', async () => {
        const page = await as(editorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Legal', slug: 'legal', status: 'publish', type: 'page' });
        assert.strictEqual(page.status, 201);
        // An Author's shadowing post written before this release (straight into the table — the API no
        // longer lets anyone create the pair).
        await dbAsync.run(
            `INSERT INTO posts (author_id, post_date, post_date_gmt, post_content, post_title, post_status, post_name, post_type, post_modified, post_modified_gmt)
             VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '<p>shadow</p>', 'Legal', 'publish', 'legal', 'post', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [authorId]);
        assert.strictEqual(await publicIdAt('legal'), page.body.id);

        // Re-saving the post under the slug it already has keeps it (the editor re-sends the slug on
        // every save): the shared namespace decides NEW claims, it does not move existing entries.
        const shadow = await dbAsync.get(`SELECT id FROM posts WHERE post_type = 'post' AND post_name = 'legal'`);
        const resaved = await as(adminToken)(request(app).put(`/api/v1/posts/${shadow.id}`)).send({ title: 'Legal (post)', slug: 'legal' });
        assert.strictEqual(resaved.status, 200);
        assert.strictEqual(resaved.body.slug, 'legal', 'a re-save is not a rename');
        assert.strictEqual(await publicIdAt('legal'), page.body.id, 'and the page keeps the bare URL');
    });

    it('the importers keep a source site\'s per-type permalinks (a WordPress post and page may share one)', async () => {
        const Post = require('../models/Post');
        const imported = await Post.create({ authorId, title: 'Imported', slug: 'imported-pair', status: 'publish', type: 'post', slugScope: 'type' });
        const importedPage = await Post.create({ authorId, title: 'Imported page', slug: 'imported-pair', status: 'publish', type: 'page', slugScope: 'type' });
        assert.strictEqual(imported.postName, 'imported-pair');
        assert.strictEqual(importedPage.postName, 'imported-pair', 'the importer scope is per type');
        assert.strictEqual(await publicIdAt('imported-pair'), importedPage.id, 'and the bare URL is the page');
        // Without the importer scope, the same create is de-duplicated across types.
        const api = await Post.create({ authorId, title: 'API', slug: 'imported-pair', status: 'publish', type: 'post' });
        assert.notStrictEqual(api.postName, 'imported-pair');
    });

    it('a NON-PUBLIC type keeps its own namespace: it is never served at a public URL, and its slugs are not revealed', async () => {
        const postTypes = require('../core/post-types');
        postTypes.registerPostType('memo', { public: false, capability_type: 'post', label: 'Memos' });
        const memo = await as(adminToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Layoffs', slug: 'layoffs-2027', status: 'private', type: 'memo' });
        assert.strictEqual(memo.status, 201, JSON.stringify(memo.body));
        const post = await as(authorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Layoffs', slug: 'layoffs-2027', status: 'draft', type: 'post' });
        assert.strictEqual(post.status, 201);
        assert.strictEqual(post.body.slug, 'layoffs-2027', 'a -2 here told the Author that a private memo holds this slug');
    });

    it('types never served by slug keep their own namespace (no churn for media and internal rows)', async () => {
        await dbAsync.run(
            `INSERT INTO posts (author_id, post_date, post_date_gmt, post_content, post_title, post_status, post_name, post_type, post_mime_type, post_modified, post_modified_gmt)
             VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '', 'photo', 'inherit', 'photo', 'attachment', 'image/png', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [authorId]);
        const post = await as(authorToken)(request(app).post('/api/v1/posts'))
            .send({ title: 'Photo', slug: 'photo', status: 'publish', type: 'post' });
        assert.strictEqual(post.body.slug, 'photo', 'an attachment does not push a post off its slug');
        const Post = require('../models/Post');
        assert.strictEqual(await Post.generateUniqueSlug('photo', 'attachment'), 'photo-2', 'attachments stay unique among themselves');
    });
});
