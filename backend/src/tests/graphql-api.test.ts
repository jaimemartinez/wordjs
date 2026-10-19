/**
 * GRAPHQL API (phase 1, read-only) — parity with REST, and the server-protection limits.
 *
 * The GraphQL endpoint resolves every field through the REST read it mirrors (core/graphql/dispatch),
 * so the promise under test is PARITY: for the same caller, the same question asked over GraphQL and over
 * REST returns the same rows and the same field values — published, draft, private, password-protected
 * and non-public content alike. Every block runs the REST request and the GraphQL query side by side
 * and compares them, for an anonymous caller, the owner, another author and an editor, so a GraphQL
 * answer can never pass by being "plausible" on its own.
 *
 * The limits are tested where they bite: a too-deep or too-costly document is refused at validation,
 * before a single REST sub-request runs; `first` above the REST page cap is refused; introspection is
 * off in production unless the setting turns it on; the schema has no mutation root.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-graphql-api-${process.pid}-${Date.now()}.db`);
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
const P: Record<string, number> = {};
let db: any;
let seq = 0;

const tok = (id: number, login: string) => jwt.sign({ userId: id, username: login }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
const withAuth = (req: any, who: string | null) => (who ? req.set('Authorization', `Bearer ${tok(U[who], who)}`) : req);
const rest = (who: string | null, p: string) => withAuth((request(app) as any).get(`/api/v1${p}`), who);
const gqlRaw = (who: string | null, query: string, variables?: any) =>
    withAuth((request(app) as any).post('/api/v1/graphql').set('Accept', 'application/graphql-response+json, application/json'), who)
        .send({ query, variables });
async function gql(who: string | null, query: string, variables?: any) {
    const r = await gqlRaw(who, query, variables);
    assert.ok(!r.body.errors, `unexpected GraphQL errors: ${JSON.stringify(r.body.errors)}`);
    return r.body.data;
}

async function seedUser(login: string, role: string) {
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name, user_nicename) VALUES (?, 'x', ?, ?, ?)`,
        [login, `${login}@example.com`, `${login} display`, login]);
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

async function seedPost(key: string, author: number, status: string, extra: { content?: string; password?: string; type?: string; parent?: number } = {}) {
    seq++;
    const r = await db.run(
        `INSERT INTO posts (author_id, post_title, post_content, post_status, post_type, post_name, post_password, comment_status, post_parent, post_date, post_date_gmt)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        [author, `Title ${key}`, extra.content || `body of ${key}`, status, extra.type || 'post', `gql-${key}`, extra.password || '',
            extra.parent || 0, `2026-01-${String(10 + seq).padStart(2, '0')} 10:00:00`, `2026-01-${String(10 + seq).padStart(2, '0')} 10:00:00`]);
    P[key] = r.lastID;
    return r.lastID;
}

async function seedComment(postId: number, content: string, approved = '1') {
    const r = await db.run(
        `INSERT INTO comments (comment_post_id, comment_author, comment_author_email, comment_content, comment_approved, user_id, comment_type)
         VALUES (?, 'Guest', 'guest@example.com', ?, ?, 0, 'comment')`,
        [postId, content, approved]);
    return r.lastID;
}

const CALLERS: Array<string | null> = [null, 'alice', 'bob', 'editor'];
const label = (who: string | null) => who || 'anonymous';

/** The fields compared between REST and GraphQL — everything the two representations share. */
const NODE_FIELDS = 'id type slug status title excerpt content protected link menuOrder authorId parentId meta author { id name slug } categories { id name slug } tags { id } featuredMedia { id }';
function fromRest(p: any) {
    return {
        id: p.id, type: p.type, slug: p.slug, status: p.status, title: p.title, excerpt: p.excerpt, content: p.content,
        protected: p.protected, link: p.link, menuOrder: p.menuOrder, authorId: p.authorId, parentId: p.parent, meta: p.meta,
        author: p.author ? { id: p.author.id, name: p.author.displayName, slug: p.author.slug } : null,
        categories: p.categories, tags: (p.tags || []).map((t: any) => ({ id: t.id })),
        featuredMedia: p.featuredMedia ? { id: p.featuredMedia.id } : null,
    };
}

before(async () => {
    config.nodeEnv = 'test';
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    db = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    await seedUser('editor', 'editor');
    await seedUser('alice', 'author');
    await seedUser('bob', 'author');

    await seedPost('pub', U.alice, 'publish', { content: 'public body' });
    await seedPost('pub2', U.bob, 'publish');
    await seedPost('aliceDraft', U.alice, 'draft', { content: 'alice draft body' });
    await seedPost('alicePrivate', U.alice, 'private', { content: 'alice private body' });
    await seedPost('bobDraft', U.bob, 'draft');
    await seedPost('locked', U.bob, 'publish', { content: 'locked secret body', password: 'hunter2' });
    await seedPost('page', U.editor, 'publish', { type: 'page' });
    await seedPost('childPage', U.editor, 'publish', { type: 'page', parent: P.page });
    await seedPost('pageDraft', U.editor, 'draft', { type: 'page' });

    const Term = require('../models/Term');
    const Post = require('../models/Post');
    const news = await Term.create({ name: 'News', taxonomy: 'category' });
    P.newsTerm = news.termId;
    await Post.setTerms(P.pub, [news.termId], 'category');

    P.c1 = await seedComment(P.pub, 'approved one');
    P.c2 = await seedComment(P.pub, 'approved two');
    P.cHeld = await seedComment(P.pub, 'held for moderation', '0');
    P.cDraft = await seedComment(P.aliceDraft, 'comment on a draft');
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { fs.rmSync(f, { force: true }); } catch { /* */ }
    }
});

describe('GraphQL ↔ REST parity (same caller, same answer)', () => {
    for (const status of ['publish', 'draft', 'private', 'any']) {
        test(`posts(status: ${status}) lists exactly what GET /posts?status=${status} lists, for every caller`, async () => {
            for (const who of CALLERS) {
                const r = await rest(who, `/posts?status=${status}&per_page=50`);
                assert.strictEqual(r.status, 200);
                const data = await gql(who, `query($s: String) { posts(status: $s, first: 50) { totalCount nodes { ${NODE_FIELDS} } } }`, { s: status });
                assert.deepStrictEqual(data.posts.nodes, r.body.map(fromRest), `${label(who)} / ${status}`);
                assert.strictEqual(data.posts.totalCount, Number(r.headers['x-wp-total']), `${label(who)} / ${status} total`);
            }
        });
    }

    test('the parity covers the cases that matter: drafts are the owner\'s and the editor\'s, never anonymous', async () => {
        const ids = async (who: string | null) =>
            (await gql(who, '{ posts(status: "any", first: 50) { nodes { id } } }')).posts.nodes.map((n: any) => n.id);
        assert.ok(!(await ids(null)).includes(P.aliceDraft));
        assert.ok((await ids('alice')).includes(P.aliceDraft));
        assert.ok(!(await ids('bob')).includes(P.aliceDraft));
        assert.ok((await ids('editor')).includes(P.aliceDraft));
        assert.ok((await ids('editor')).includes(P.alicePrivate));
    });

    test('anonymous: a non-published status is an empty list in REST and GraphQL, never the published entries', async () => {
        for (const status of ['draft', 'pending', 'private', 'future']) {
            const r = await rest(null, `/posts?status=${status}&per_page=50`);
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(r.body, [], `REST / ${status}`);
            assert.strictEqual(Number(r.headers['x-wp-total']), 0, `REST / ${status} total`);
            const data = await gql(null, `query($s: String) { posts(status: $s, first: 50) { totalCount nodes { id } } }`, { s: status });
            assert.deepStrictEqual(data.posts, { totalCount: 0, nodes: [] }, `GraphQL / ${status}`);
        }
        // `any` still lists what an anonymous caller may see: the published entries.
        const any = (await rest(null, '/posts?status=any&per_page=50')).body.map((p: any) => p.id);
        assert.ok(any.includes(P.pub) && !any.includes(P.aliceDraft));
    });

    test('link is the canonical /<slug> address for posts and pages (no trailing slash, no /post/ prefix)', async () => {
        const post = (await rest(null, `/posts/${P.pub}`)).body;
        assert.match(post.link, /^https?:\/\/[^/]+\/[^/]+$/, post.link);
        assert.ok(post.link.endsWith(`/${post.slug}`), post.link);
        const page = (await rest(null, `/posts/${P.page}`)).body;
        assert.ok(page.link.endsWith(`/${page.slug}`) && !page.link.endsWith('/'), page.link);
        const node = await gql(null, `{ contentNode(id: ${P.pub}) { link } }`);
        assert.strictEqual(node.contentNode.link, post.link);
    });

    test('post(id:) is null exactly where GET /posts/:id is 404, and equal where it is 200', async () => {
        for (const who of CALLERS) {
            for (const key of ['pub', 'aliceDraft', 'alicePrivate', 'bobDraft', 'locked', 'page']) {
                const r = await rest(who, `/posts/${P[key]}`);
                const data = await gql(who, `query($id: Int) { contentNode(id: $id) { ${NODE_FIELDS} } }`, { id: P[key] });
                if (r.status === 404) assert.strictEqual(data.contentNode, null, `${label(who)} / ${key} must be hidden`);
                else assert.deepStrictEqual(data.contentNode, fromRest(r.body), `${label(who)} / ${key}`);
            }
        }
    });

    test('a password-protected entry hides its body over GraphQL exactly as over REST', async () => {
        const anon = await gql(null, `{ contentNode(id: ${P.locked}) { protected content excerpt } }`);
        assert.deepStrictEqual(anon.contentNode, { protected: true, content: '', excerpt: '' });
        const owner = await gql('bob', `{ contentNode(id: ${P.locked}) { content } }`);
        assert.match(owner.contentNode.content, /locked secret body/);
        // Search must not match the hidden body either — same FTS path as REST.
        const found = await gql(null, '{ posts(search: "secret", first: 10) { nodes { id } } }');
        const r = await rest(null, '/posts?search=secret&per_page=10');
        assert.deepStrictEqual(found.posts.nodes.map((n: any) => n.id), r.body.map((p: any) => p.id));
        assert.ok(!found.posts.nodes.some((n: any) => n.id === P.locked));
    });

    test('slug lookups and type narrowing follow GET /posts/slug/:slug', async () => {
        for (const who of CALLERS) {
            for (const key of ['pub', 'aliceDraft', 'page']) {
                const r = await rest(who, `/posts/slug/gql-${key}`);
                const data = await gql(who, `{ contentNode(slug: "gql-${key}") { id } }`);
                assert.strictEqual(data.contentNode ? data.contentNode.id : null, r.status === 200 ? r.body.id : null, `${label(who)} / ${key}`);
            }
        }
        // A slug that is a dot segment cannot re-aim the internal REST path; it is simply not found.
        assert.deepStrictEqual(await gql(null, '{ a: contentNode(slug: "..") { id } b: contentNode(slug: "a..b") { id } }'), { a: null, b: null });
        // page(id:) never answers with a post, post(id:) never with a page.
        const mixed = await gql(null, `{ page(id: ${P.pub}) { id } post(id: ${P.page}) { id } realPage: page(id: ${P.page}) { id } }`);
        assert.deepStrictEqual(mixed, { page: null, post: null, realPage: { id: P.page } });
    });

    test('pages(status: any) and a page\'s parent follow REST', async () => {
        for (const who of CALLERS) {
            const r = await rest(who, '/posts?type=page&status=any&per_page=50');
            const data = await gql(who, '{ pages(status: "any", first: 50) { nodes { id } } }');
            assert.deepStrictEqual(data.pages.nodes.map((n: any) => n.id), r.body.map((p: any) => p.id), label(who));
        }
        const child = await gql(null, `{ page(id: ${P.childPage}) { parent { id title } } }`);
        assert.deepStrictEqual(child.page.parent, { id: P.page, title: 'Title page' });
    });

    test('comments: approved only, and only on entries the caller may read — same as GET /comments', async () => {
        for (const who of CALLERS) {
            for (const postKey of ['pub', 'aliceDraft']) {
                const r = await rest(who, `/comments?post=${P[postKey]}&per_page=50`);
                const data = await gql(who, `{ comments(postId: ${P[postKey]}, first: 50) { totalCount nodes { id content status } } }`);
                assert.deepStrictEqual(data.comments.nodes.map((c: any) => c.id), r.body.map((c: any) => c.id), `${label(who)} / ${postKey}`);
                assert.ok(!data.comments.nodes.some((c: any) => c.id === P.cHeld), 'an unapproved comment is never listed');
            }
        }
        const anonDraft = await gql(null, `{ comments(postId: ${P.aliceDraft}) { nodes { id } } }`);
        assert.deepStrictEqual(anonDraft.comments.nodes, []);
        const nested = await gql(null, `{ post(id: ${P.pub}) { comments(first: 10) { nodes { id } } } }`);
        assert.deepStrictEqual(nested.post.comments.nodes.map((c: any) => c.id).sort(), [P.c1, P.c2].sort());
    });

    test('categories, tags, taxonomies, types, menus and settings are the REST payloads', async () => {
        const cats = await rest(null, '/categories');
        const data = await gql(null, '{ categories(first: 100) { nodes { id name slug count } } taxonomies { name } contentTypes { name } menus { id } settings { title all } }');
        assert.deepStrictEqual(data.categories.nodes.map((t: any) => t.id), cats.body.map((t: any) => t.id));
        assert.deepStrictEqual(data.taxonomies.map((t: any) => t.name), (await rest(null, '/taxonomies')).body.map((t: any) => t.name));
        assert.deepStrictEqual(data.contentTypes.map((t: any) => t.name), (await rest(null, '/types')).body.map((t: any) => t.name));
        const settings = (await rest(null, '/settings')).body;
        assert.deepStrictEqual(data.settings.all, settings);
        assert.strictEqual(data.settings.title, settings.blogname);
        // The settings map is the PUBLIC subset — the admin email is not in it.
        assert.ok(!Object.prototype.hasOwnProperty.call(data.settings.all, 'admin_email'));

        const byCat = await gql(null, `{ category(id: ${P.newsTerm}) { name contentNodes { nodes { id } } } posts(categories: ["news"]) { nodes { id } } }`);
        assert.strictEqual(byCat.category.name, 'News');
        assert.deepStrictEqual(byCat.category.contentNodes.nodes.map((n: any) => n.id), [P.pub]);
        assert.deepStrictEqual(byCat.posts.nodes.map((n: any) => n.id), [P.pub]);
    });

    test('authors expose only public identity; viewer is null anonymously and the caller otherwise', async () => {
        const data = await gql(null, `{ post(id: ${P.pub}) { author { id name slug } } viewer { id } }`);
        assert.deepStrictEqual(data.post.author, { id: U.alice, name: 'alice display', slug: 'alice' });
        assert.strictEqual(data.viewer, null);
        const me = await gql('editor', '{ viewer { id name role } }');
        assert.deepStrictEqual(me.viewer, { id: U.editor, name: 'editor display', role: 'editor' });
        const authorFields = (await gql(null, '{ __type(name: "Author") { fields { name } } }')).__type.fields.map((f: any) => f.name);
        assert.deepStrictEqual(authorFields.sort(), ['id', 'name', 'slug']);
    });
});

describe('API token scopes apply per field, as on REST', () => {
    test('a posts:read token reads its user\'s drafts through GraphQL, and is anonymous for every other resource', async () => {
        const ApiToken = require('../models/ApiToken');
        const { token } = await ApiToken.generate({ userId: U.alice, name: 'gql', scopes: ['posts:read'] });
        const bearer = (q: string) => (request(app) as any).post('/api/v1/graphql').set('Authorization', `Bearer ${token}`).send({ query: q });
        const r = await bearer(`{ contentNode(id: ${P.aliceDraft}) { id } viewer { id } }`);
        assert.ok(!r.body.errors, JSON.stringify(r.body.errors));
        // posts:read covers GET /posts/:id; it does not cover GET /users/me, so the viewer is anonymous —
        // exactly what the same token gets from the two REST endpoints.
        assert.deepStrictEqual(r.body.data, { contentNode: { id: P.aliceDraft }, viewer: null });
        const restPosts = await (request(app) as any).get(`/api/v1/posts/${P.aliceDraft}`).set('Authorization', `Bearer ${token}`);
        assert.strictEqual(restPosts.status, 200);
        const restMe = await (request(app) as any).get('/api/v1/users/me').set('Authorization', `Bearer ${token}`);
        assert.notStrictEqual(restMe.status, 200);

        const { token: mediaOnly } = await ApiToken.generate({ userId: U.alice, name: 'gql-media', scopes: ['media:read'] });
        const m = await (request(app) as any).post('/api/v1/graphql').set('Authorization', `Bearer ${mediaOnly}`)
            .send({ query: `{ contentNode(id: ${P.aliceDraft}) { id } }` });
        assert.deepStrictEqual(m.body.data, { contentNode: null }, 'a media-only token is anonymous for posts');
    });
});

describe('cursor pagination', () => {
    test('walking posts(first: 1) with after: endCursor visits REST\'s order exactly once', async () => {
        const restIds = (await rest('editor', '/posts?status=any&per_page=50')).body.map((p: any) => p.id);
        const seen: number[] = [];
        let after: string | null = null;
        for (let guard = 0; guard < 50; guard++) {
            const data: any = await gql('editor', 'query($a: String) { posts(status: "any", first: 1, after: $a) { nodes { id } pageInfo { hasNextPage endCursor } } }', { a: after });
            seen.push(...data.posts.nodes.map((n: any) => n.id));
            if (!data.posts.pageInfo.hasNextPage) break;
            after = data.posts.pageInfo.endCursor;
        }
        assert.deepStrictEqual(seen, restIds);
    });

    test('a cursor taken with one page size still lines up with another (window straddles two REST pages)', async () => {
        const restIds = (await rest('editor', '/posts?status=any&per_page=50')).body.map((p: any) => p.id);
        const first = await gql('editor', '{ posts(status: "any", first: 1) { edges { cursor } } }');
        const next = await gql('editor', 'query($a: String) { posts(status: "any", first: 3, after: $a) { nodes { id } } }', { a: first.posts.edges[0].cursor });
        assert.deepStrictEqual(next.posts.nodes.map((n: any) => n.id), restIds.slice(1, 4));
    });

    test('a forged cursor and an out-of-range page size are refused as bad input', async () => {
        const bad = await gqlRaw(null, '{ posts(after: "not-a-cursor") { nodes { id } } }');
        assert.strictEqual(bad.body.errors[0].extensions.code, 'BAD_USER_INPUT');
        const big = await gqlRaw(null, '{ posts(first: 101) { nodes { id } } }');
        assert.strictEqual(big.body.errors[0].extensions.code, 'BAD_USER_INPUT');
        const zero = await gqlRaw(null, '{ posts(first: 0) { nodes { id } } }');
        assert.strictEqual(zero.body.errors[0].extensions.code, 'BAD_USER_INPUT');
    });
});

describe('server protection', () => {
    test('a query deeper than the limit is refused before any resolver runs', async () => {
        let deep = 'id';
        for (let i = 0; i < 12; i++) deep = `parent { ${deep} }`;
        const r = await gqlRaw(null, `{ post(id: ${P.pub}) { ${deep} } }`);
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.body.data, undefined, 'nothing executed');
        assert.ok(r.body.errors.some((e: any) => e.extensions && e.extensions.code === 'GRAPHQL_DEPTH_LIMIT'));
    });

    test('a depth bomb hidden in fragments is measured with the fragments expanded', async () => {
        const r = await gqlRaw(null, `
            fragment A on ContentNode { parent { parent { parent { parent { id } } } } }
            fragment B on ContentNode { parent { parent { parent { ...A } } } }
            { post(id: ${P.pub}) { parent { parent { ...B } } } }`);
        assert.strictEqual(r.status, 400);
        assert.ok(r.body.errors.some((e: any) => e.extensions && e.extensions.code === 'GRAPHQL_DEPTH_LIMIT'));
    });

    test('a chain of fragments that each spread the next one twice is measured in linear time', async () => {
        // F1 { ...F2 ...F2 } F2 { ...F3 ...F3 } … — expanded naively that is 2^40 walks.
        const N = 40;
        const frags: string[] = [];
        for (let i = 1; i < N; i++) frags.push(`fragment F${i} on ContentNode { ...F${i + 1} ...F${i + 1} }`);
        frags.push(`fragment F${N} on ContentNode { author { name } }`);
        const doc = `${frags.join('\n')}\n{ post(id: ${P.pub}) { ...F1 } }`;
        const t0 = Date.now();
        const r = await gqlRaw(null, doc);
        const ms = Date.now() - t0;
        assert.ok(ms < 200, `refused in ${ms}ms`);
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.body.data, undefined, 'nothing executed');
        assert.ok(r.body.errors.some((e: any) => e.extensions && e.extensions.code === 'GRAPHQL_COST_LIMIT'));
    });

    test('a fragment reused under one type is measured once and still counted at every spread', () => {
        // Memoisation must not under-count: the spreads cost exactly what the same fields written out do.
        const { measureOperation } = require('../core/graphql/limits');
        const { parse, TypeInfo, ValidationContext } = require('graphql');
        const { buildCoreSchema } = require('../core/graphql/schema');
        const schema = buildCoreSchema();
        const opts = { maxDepth: 99, maxCost: 1e9, maxPageSize: 100 };
        const measureDoc = (src: string) => {
            const doc = parse(src);
            const ctx = new ValidationContext(schema, doc, new TypeInfo(schema), () => {});
            const op = doc.definitions.find((d: any) => d.kind === 'OperationDefinition');
            return measureOperation(ctx, op.selectionSet, schema.getQueryType(), opts);
        };
        const spread = measureDoc(`fragment A on ContentNode { author { name } }
            { post(id: 1) { ...A ...A } other: post(id: 2) { ...A } }`);
        const inline = measureDoc(`{ post(id: 1) { a1: author { name } a2: author { name } } other: post(id: 2) { author { name } } }`);
        assert.deepStrictEqual(spread, inline);
    });

    test('a query whose cost exceeds the limit is refused (nested pages multiply)', async () => {
        const r = await gqlRaw(null, '{ posts(first: 100) { nodes { comments(first: 100) { nodes { id } } } } }');
        assert.strictEqual(r.status, 400);
        assert.ok(r.body.errors.some((e: any) => e.extensions && e.extensions.code === 'GRAPHQL_COST_LIMIT'));
    });

    test('aliases are counted one by one and a variable page size is assumed to be the maximum', async () => {
        const aliases = Array.from({ length: 40 }, (_, i) => `a${i}: posts(first: 100) { nodes { id title } }`).join(' ');
        const r = await gqlRaw(null, `{ ${aliases} }`);
        assert.ok(r.body.errors.some((e: any) => e.extensions && e.extensions.code === 'GRAPHQL_COST_LIMIT'));
        const v = await gqlRaw(null, 'query($n: Int) { posts(first: $n) { nodes { comments(first: $n) { nodes { id } } } } }', { n: 1 });
        assert.ok(v.body.errors.some((e: any) => e.extensions && e.extensions.code === 'GRAPHQL_COST_LIMIT'));
    });

    test('an ordinary page query fits well inside the limits', async () => {
        const data = await gql(null, '{ posts(first: 20) { totalCount nodes { id title author { name } featuredMedia { url } categories { name } } } settings { title } }');
        assert.ok(data.posts.totalCount >= 1);
    });

    test('introspection is off in production unless the setting turns it on, and on in development', async () => {
        const { updateOption, deleteOption } = require('../core/options');
        const q = '{ __schema { queryType { name } } }';
        config.nodeEnv = 'production';
        try {
            const off = await gqlRaw(null, q);
            assert.strictEqual(off.status, 400);
            assert.match(JSON.stringify(off.body.errors), /introspection/i);
            await updateOption('graphql_introspection', '1');
            const on = await gqlRaw(null, q);
            assert.deepStrictEqual(on.body.data, { __schema: { queryType: { name: 'Query' } } });
        } finally {
            config.nodeEnv = 'test';
            await (deleteOption ? deleteOption('graphql_introspection') : updateOption('graphql_introspection', ''));
        }
        const dev = await gqlRaw(null, q);
        assert.deepStrictEqual(dev.body.data, { __schema: { queryType: { name: 'Query' } } });
    });

    test('the schema is read-only: a mutation is refused by validation', async () => {
        const r = await gqlRaw('editor', `mutation { deletePost(id: ${P.pub}) }`);
        assert.ok(r.body.errors && r.body.errors.length > 0);
        assert.ok(!r.body.data, 'nothing executed');
        assert.strictEqual((await rest(null, `/posts/${P.pub}`)).status, 200, 'the entry is untouched');
    });

    test('GET carries queries too (and the endpoint is never shared-cacheable)', async () => {
        const r = await (request(app) as any).get('/api/v1/graphql').query({ query: `{ post(id: ${P.pub}) { id } }` }).set('Accept', 'application/json');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.data, { post: { id: P.pub } });
        assert.strictEqual(r.headers['cache-control'], 'no-store');
    });

    test('an oversized document is refused by the parser token cap', async () => {
        const fields = Array.from({ length: 6000 }, () => 'id').join(' ');
        const r = await gqlRaw(null, `{ post(id: ${P.pub}) { ${fields} } }`);
        assert.strictEqual(r.status, 400);
        assert.match(JSON.stringify(r.body.errors), /token/i);
    });
});

describe('schema extension seam', () => {
    const graphql = require('../core/graphql');
    const { addAction, removeAction } = require('../core/hooks');

    after(() => {
        graphql.unregisterGraphQLExtensions('test-ext');
        graphql.unregisterGraphQLExtensions('test-bad');
    });

    test('an extension adds types and fields; its resolvers can reuse the REST dispatcher', async () => {
        graphql.registerGraphQLExtension({
            owner: 'test-ext',
            typeDefs: `
                type ReadingTime { minutes: Int! }
                extend type ContentNode { readingTime: ReadingTime }
                extend type Query { postTitle(id: Int!): String }`,
            resolvers: {
                ContentNode: { readingTime: (p: any) => ({ minutes: Math.max(1, Math.round(String(p.content || '').split(/\s+/).length / 200)) }) },
                Query: {
                    postTitle: {
                        cost: { rest: true },
                        resolve: async (_r: any, { id }: any, ctx: any) => {
                            const r = await ctx.rest.get(`/posts/${id}`);
                            return r.status === 200 ? r.body.title : null;
                        },
                    },
                },
            },
        });
        const data = await gql(null, `{ post(id: ${P.pub}) { readingTime { minutes } } t: postTitle(id: ${P.pub}) hidden: postTitle(id: ${P.aliceDraft}) }`);
        assert.deepStrictEqual(data, { post: { readingTime: { minutes: 1 } }, t: 'Title pub', hidden: null });
        // The dispatcher carries the caller: the owner sees her draft's title through the extension.
        const own = await gql('alice', `{ postTitle(id: ${P.aliceDraft}) }`);
        assert.strictEqual(own.postTitle, 'Title aliceDraft');
    });

    test('an extension may not reroute a core field, and a broken one is skipped without breaking the endpoint', async () => {
        graphql.registerGraphQLExtension({
            owner: 'test-bad',
            typeDefs: 'type Evil { x: Int }',
            resolvers: { Query: { posts: () => ({ items: [], start: 0, first: 1, total: 0 }) } },
        });
        graphql.registerGraphQLExtension({ owner: 'test-bad', typeDefs: 'this is not SDL' });
        const data = await gql(null, '{ posts(first: 50) { totalCount } }');
        assert.strictEqual(data.posts.totalCount, Number((await rest(null, '/posts?per_page=50')).headers['x-wp-total']));
        const evil = await gql(null, '{ __type(name: "Evil") { name } }');
        assert.strictEqual(evil.__type, null, 'the refused extension contributed nothing');
    });

    test('the wordjs_graphql_register_types hook registers host extensions and the schema follows the hook', async () => {
        const cb = (register: any) => register({ owner: 'test-hook', typeDefs: 'extend type Query { hookPing: String }', resolvers: { Query: { hookPing: () => 'pong' } } });
        addAction('wordjs_graphql_register_types', cb);
        try {
            assert.deepStrictEqual(await gql(null, '{ hookPing }'), { hookPing: 'pong' });
        } finally {
            removeAction('wordjs_graphql_register_types', cb);
        }
        const gone = await gqlRaw(null, '{ hookPing }');
        assert.strictEqual(gone.status, 400, 'the field disappears with the callback');
    });

    test('sandboxed plugins cannot subscribe to the host-only registration hook', () => {
        const hookAccess = require('../core/hook-access');
        const policy = hookAccess.getHookPolicy('wordjs_graphql_register_types');
        assert.strictEqual(policy && policy.kind, 'denied');
    });
});
