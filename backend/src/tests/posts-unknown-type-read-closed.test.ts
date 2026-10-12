/**
 * AN ENTRY OF A TYPE THE REGISTRY DOES NOT KNOW IS NOT PUBLIC.
 *
 * Every read decision used `capsForType(type) || capsFor('post')` — and the `post` family is publicly
 * readable — so the published entries of any unregistered type were served to anonymous callers. Three
 * ordinary ways to get such entries, none needing a collation trick:
 *   · a WordPress import keeps every post type it finds (contact-form submission stores such as
 *     flamingo_inbound, whose title is the visitor's email address; shop_coupon, whose title is the code);
 *   · an administrator deletes a non-public custom type — its entries stay, and became world-readable;
 *   · at boot, every custom type is unregistered until initPostTypes() resolves, after the listener opens.
 *
 * The read side now fails closed (core/post-capabilities readPolicyForType) on every surface that serves
 * entries: the list (?type=), GET /posts/:id, GET /posts/slug/:slug (typed and untyped — the untyped one
 * is what the public /[slug] page calls), the public comment list (now a positive list of public types),
 * and the SEO meta preview (its twin: a contributor read published entries of NON-PUBLIC registered types
 * there). The author and editors keep access, so orphaned content can still be found and migrated, and
 * the built-in types keep their public policy even before the registry is loaded.
 *
 * MUTATION PROOF: put `capsForType(t) || capsFor('post')` back in canReadPostRecord / the list / the
 * comment filter (or the old status-only check in routes/seo.ts) and the matching tests below fail.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-unknown-type-read-'));
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

describe('reads of an unregistered post type fail closed', () => {
    let request: any, app: any, dbAsync: any;
    const tokens: Record<string, string> = {};
    const users: Record<string, number> = {};
    let inboundId = 0, couponId = 0, invoiceId = 0, secretId = 0, publicPostId = 0;

    const sign = (login: string) =>
        jwt.sign({ userId: users[login], username: login }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
    const as = (login: string) => (r: any) => r.set('Authorization', `Bearer ${tokens[login]}`);

    async function seedUser(login: string, role: string) {
        await dbAsync.run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
            [login, 'x', `${login}@example.com`, login]);
        const row = await dbAsync.get('SELECT id FROM users WHERE user_login = ?', [login]);
        await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)", [row.id, role]);
        users[login] = row.id;
        tokens[login] = sign(login);
    }

    async function seedRow(type: string, slug: string, title: string, authorId: number): Promise<number> {
        const r = await dbAsync.run(
            `INSERT INTO posts (author_id, post_date, post_date_gmt, post_content, post_title, post_status, post_name, post_type, post_modified, post_modified_gmt)
             VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, 'publish', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [authorId, `<p>${title} body</p>`, title, slug, type]);
        return Number(r.lastID);
    }

    async function seedComment(postId: number, text: string) {
        await dbAsync.run(
            `INSERT INTO comments (comment_post_id, comment_author, comment_author_email, comment_content, comment_approved, user_id, comment_type)
             VALUES (?, 'Visitor', 'visitor@example.com', ?, '1', 0, 'comment')`, [postId, text]);
    }

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        const postTypes = require('../core/post-types');
        await postTypes.initPostTypes();
        await require('../core/roles').loadRoles();

        await seedUser('admin', 'administrator');
        await seedUser('importer', 'author');     // owns the imported rows
        await seedUser('editor1', 'editor');
        await seedUser('contrib', 'contributor');

        // (1) What a WordPress import leaves behind: published rows of types this install never registered.
        inboundId = await seedRow('flamingo_inbound', 'inbound-1', 'jane.doe@example.org', users.importer);
        couponId = await seedRow('shop_coupon', 'spring-sale', 'SPRING-90-OFF', users.importer);
        await seedComment(inboundId, 'comment on the private submission');

        // (2) A non-public custom type the administrator later deletes.
        await postTypes.saveCustomPostType('invoice', { public: false, showInRest: true, capability_type: 'invoice', label: 'Invoices' });
        invoiceId = await seedRow('invoice', 'invoice-acme', 'ACME invoice', users.admin);
        await seedComment(invoiceId, 'comment on the invoice');

        // A non-public type that stays registered (the SEO twin) and an ordinary public post (the control).
        await postTypes.saveCustomPostType('secretdoc', { public: false, showInRest: true, capability_type: 'secretdoc', label: 'Secret docs' });
        secretId = await seedRow('secretdoc', 'board-minutes', 'Board minutes', users.admin);
        publicPostId = await seedRow('post', 'hello-world', 'Hello world', users.admin);
        await seedComment(publicPostId, 'comment on the public post');

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use('/api/v1/posts', require('../routes/posts'));
        app.use('/api/v1/comments', require('../routes/comments'));
        app.use('/api/v1/seo', require('../routes/seo'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* */ }
        process.chdir(os.tmpdir());
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    const ids = (res: any): number[] => (Array.isArray(res.body) ? res.body.map((p: any) => p.id) : []);

    it('control: an ordinary published post is public on every surface', async () => {
        assert.deepStrictEqual(ids(await request(app).get('/api/v1/posts').query({ type: 'post' })), [publicPostId]);
        assert.strictEqual((await request(app).get(`/api/v1/posts/${publicPostId}`)).status, 200);
        assert.strictEqual((await request(app).get('/api/v1/posts/slug/hello-world')).status, 200);
    });

    it('anonymous: imported entries of an unregistered type are not listed, fetched by id or fetched by slug', async () => {
        for (const [type, id, slug] of [['flamingo_inbound', inboundId, 'inbound-1'], ['shop_coupon', couponId, 'spring-sale']] as const) {
            const list = await request(app).get('/api/v1/posts').query({ type });
            assert.strictEqual(list.status, 200);
            assert.deepStrictEqual(ids(list), [], `?type=${type} listed the entries`);
            assert.strictEqual(list.headers['x-wp-total'], '0');
            assert.strictEqual((await request(app).get(`/api/v1/posts/${id}`)).status, 404, `GET /posts/${id}`);
            // Untyped (what the public /<slug> page asks) and typed.
            assert.strictEqual((await request(app).get(`/api/v1/posts/slug/${slug}`)).status, 404, `slug ${slug}`);
            assert.strictEqual((await request(app).get(`/api/v1/posts/slug/${slug}`).query({ type })).status, 404);
            const search = await request(app).get('/api/v1/posts').query({ type, search: 'example.org' });
            assert.deepStrictEqual(ids(search), [], 'search does not reach them either');
        }
    });

    it('deleting a non-public custom type does not publish its entries', async () => {
        assert.strictEqual((await request(app).get(`/api/v1/posts/${invoiceId}`)).status, 404, 'non-public while registered');
        const removed = await require('../core/post-types').deleteCustomPostType('invoice');
        assert.ok(removed, 'the type was deleted');
        assert.strictEqual(require('../core/post-types').getPostType('invoice'), null);
        assert.strictEqual((await request(app).get(`/api/v1/posts/${invoiceId}`)).status, 404, 'still not public once unregistered');
        assert.deepStrictEqual(ids(await request(app).get('/api/v1/posts').query({ type: 'invoice' })), []);
        assert.strictEqual((await request(app).get('/api/v1/posts/slug/invoice-acme')).status, 404);
    });

    it('anonymous: the public comment list does not serve comments of those entries', async () => {
        const all = await request(app).get('/api/v1/comments');
        assert.strictEqual(all.status, 200, JSON.stringify(all.body));
        const texts = (all.body as any[]).map((c: any) => String(c.content && (c.content.rendered ?? c.content) || c.comment_content || ''));
        assert.ok(texts.some((t) => t.includes('public post')), `control comment missing: ${JSON.stringify(all.body)}`);
        assert.ok(!texts.some((t) => t.includes('private submission') || t.includes('invoice')), `leaked: ${JSON.stringify(texts)}`);
        for (const id of [inboundId, invoiceId]) {
            const one = await request(app).get('/api/v1/comments').query({ post: id });
            assert.deepStrictEqual(one.body, [], `?post=${id} served its comments`);
        }
    });

    it('the owner and editors still read them (orphaned content stays reachable)', async () => {
        assert.strictEqual((await as('importer')(request(app).get(`/api/v1/posts/${inboundId}`))).status, 200, 'its author');
        assert.strictEqual((await as('editor1')(request(app).get(`/api/v1/posts/${couponId}`))).status, 200, 'an editor');
        assert.strictEqual((await as('admin')(request(app).get(`/api/v1/posts/${invoiceId}`))).status, 200, 'an administrator');
        const listed = await as('editor1')(request(app).get('/api/v1/posts').query({ type: 'flamingo_inbound' }));
        assert.deepStrictEqual(ids(listed), [inboundId]);
        // ...but a contributor who neither wrote them nor edits others' content does not.
        assert.strictEqual((await as('contrib')(request(app).get(`/api/v1/posts/${inboundId}`))).status, 404);
    });

    it('twin: GET /seo/meta/:id answers a contributor only for entries they may read', async () => {
        const control = await as('contrib')(request(app).get(`/api/v1/seo/meta/${publicPostId}`));
        assert.strictEqual(control.status, 200, JSON.stringify(control.body));
        for (const id of [secretId, inboundId, invoiceId]) {
            const res = await as('contrib')(request(app).get(`/api/v1/seo/meta/${id}`));
            assert.strictEqual(res.status, 404, `seo meta of ${id}: ${res.status} ${JSON.stringify(res.body)}`);
        }
        assert.strictEqual((await as('admin')(request(app).get(`/api/v1/seo/meta/${secretId}`))).status, 200, 'an administrator still previews it');
    });

    it('twin: a public post does not name its published translation sibling of an unregistered type', async () => {
        // The public post and the imported coupon are linked as translations of each other. The
        // serializer keeps a sibling without loading it only when the READ policy of its type is public
        // (routes/posts isPublicTranslationRef); the write fallback (`post`) called the coupon public.
        const group = `unknown-type-group-${process.pid}`;
        await dbAsync.run('UPDATE posts SET post_language = ?, translation_group = ? WHERE id = ?', ['en', group, publicPostId]);
        await dbAsync.run('UPDATE posts SET post_language = ?, translation_group = ? WHERE id = ?', ['es', group, couponId]);
        const Post = require('../models/Post');
        await Post._invalidatePostCacheById(publicPostId);
        await Post._invalidatePostCacheById(couponId);
        try {
            const anon = await request(app).get(`/api/v1/posts/${publicPostId}`);
            assert.strictEqual(anon.status, 200, JSON.stringify(anon.body));
            const named = (anon.body.translations || []).map((t: any) => t.id);
            assert.ok(!named.includes(couponId), `the coupon was named to an anonymous reader: ${JSON.stringify(anon.body.translations)}`);
            // Control: an editor may read the coupon, so it is listed for them.
            const editor = await as('editor1')(request(app).get(`/api/v1/posts/${publicPostId}`));
            assert.ok((editor.body.translations || []).some((t: any) => t.id === couponId), `control: ${JSON.stringify(editor.body.translations)}`);
        } finally {
            await dbAsync.run('UPDATE posts SET post_language = NULL, translation_group = NULL WHERE id IN (?, ?)', [publicPostId, couponId]);
            await Post._invalidatePostCacheById(publicPostId);
            await Post._invalidatePostCacheById(couponId);
        }
    });

    it('before the registry is loaded, built-in types keep their policy and custom types are closed', () => {
        // The boot window: index.ts accepts requests before initPostTypes() resolves. Model it with an
        // empty registry — patched on the module's own exports, because core/post-capabilities resolves
        // the registry module once and keeps that object (a replaced require.cache entry is not seen).
        const postTypes = require('../core/post-types');
        const saved = { getPostType: postTypes.getPostType, getContentTypeSchema: postTypes.getContentTypeSchema, getPostTypes: postTypes.getPostTypes };
        Object.assign(postTypes, { getPostType: () => null, getContentTypeSchema: () => null, getPostTypes: () => [] });
        try {
            const { canReadPostRecord } = require('../core/post-capabilities');
            assert.strictEqual(canReadPostRecord(null, { postType: 'post', postStatus: 'publish' }), true, 'post stays public');
            assert.strictEqual(canReadPostRecord(null, { postType: 'page', postStatus: 'publish' }), true, 'page stays public');
            assert.strictEqual(canReadPostRecord(null, { postType: 'secretdoc', postStatus: 'publish' }), false, 'a custom type is closed');
            assert.strictEqual(canReadPostRecord(null, { postType: 'nav_menu_item', postStatus: 'publish' }), false);
            // Control: the registry really looks empty to the read policy (secretdoc is closed for that
            // reason here, not because its registered declaration says so).
            assert.strictEqual(require('../core/post-capabilities').capsForType('secretdoc'), null, 'the empty registry was not seen');
        } finally {
            Object.assign(postTypes, saved);
        }
    });
});
