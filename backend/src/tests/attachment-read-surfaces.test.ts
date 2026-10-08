/**
 * THE ROUTES THAT TAKE A POST ID (OR SLUG) AND HAND BACK ITS FIELDS ANSWER WHAT GET /posts/:id ANSWERS
 * (security, follow-up to attachment-list-visibility.test.ts).
 *
 * 1. GET /seo/meta/:postId kept its own copy of the read rule ("unpublished needs the author or
 *    edit_others_posts"): an editor read the title and slug of a hidden attachment (GET /media/:id → 404)
 *    and the unpublished entries of a type with its own capability family; a contributor the title and
 *    excerpt of every PUBLISHED entry of a `public: false` type (GET /posts/:id → 404); and anyone who may
 *    read a password-protected entry got its excerpt as the description.
 * 2. Translation refs: Post.toJSON lists the PUBLISHED siblings of a group, and they were filtered only when
 *    the post being serialized was of a non-public type — so the published entry of a `public: false` type
 *    linked to a public post handed its id and slug to every reader. POST /posts/:id/translations answered
 *    the raw group, members the caller may not read included.
 * 3. GET /posts/slug/:slug answered `rest_post_invalid_id` when a hidden row held the slug and
 *    `rest_post_invalid_slug` when none did: an exact-slug existence oracle (attachment slugs come from
 *    file names).
 * 4. Comments: an attachment the caller may not see could be commented on by id (201 vs 404 — existence),
 *    and its comments read; the collaboration channel answered 403 for it and 404 for a missing id.
 * 5. POST /posts and PUT /posts/:id: a `parent` naming an attachment the caller may not see answered 403
 *    where a missing id answers 400 — and an editor could create a post under it (201).
 *
 * Real routers, real JWTs and roles, a real temp SQLite database.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-attachment-reads-${STAMP}-`));
fs.mkdirSync(path.join(TMP_ROOT, 'uploads'), { recursive: true });

config.dbPath = path.join(TMP_ROOT, 'wordjs.db');
config.dbDriver = 'sqlite-native';
config.uploads.dir = path.join(TMP_ROOT, 'uploads');
config.uploads.privateDir = path.join(TMP_ROOT, 'data', 'private-uploads');

const database = require('../config/database');
const roles = require('../core/roles');
const Post = require('../models/Post');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));

const U: Record<string, number> = {};
let dbAsync: any;
let seq = 0;

const LEDGER_TYPE = 'ars_ledger';   // public:false, its own `arsledger` capability family
const PRIVATE_TYPE = 'ars_private'; // public:false, the plain `post` capability family
const MISSING_ID = 987654320;

const tok = (id: number, login: string) => jwt.sign({ userId: id, username: login }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
const call = (persona: string | null, m: string, p: string) => {
    const r = (request(app) as any)[m](`/api/v1${p}`);
    return persona ? r.set('Authorization', `Bearer ${tok(U[persona], persona)}`) : r;
};
const word = (label: string) => `${label}${process.pid}x${Date.now()}y${++seq}`.toLowerCase();

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

/** An entry of any type, written straight to the row. */
async function entry(owner: string, type: string, status: string, extra: { title?: string; excerpt?: string; password?: string } = {}) {
    const row = await Post.create({
        authorId: U[owner], title: extra.title || word('entry'), excerpt: extra.excerpt || '',
        type: 'post', status, password: extra.password || '',
    });
    if (type !== 'post') {
        await dbAsync.run('UPDATE posts SET post_type = ? WHERE id = ?', [type, row.id]);
        await Post._invalidatePostCacheById(row.id);
    }
    return row.id as number;
}

async function attachment(owner: string, title: string, opts: { status?: string; parent?: number } = {}) {
    const row = await Post.create({
        authorId: U[owner], title, type: 'attachment',
        status: opts.status || 'inherit', parent: opts.parent || 0, mimeType: 'image/png',
    });
    await dbAsync.run('UPDATE posts SET guid = ? WHERE id = ?', [`/uploads/${title}.png`, row.id]);
    await Post._invalidatePostCacheById(row.id);
    return row.id as number;
}

/** status + body, for "answers exactly as" comparisons. */
async function answer(persona: string | null, m: string, p: string, body?: any) {
    const req = call(persona, m, p);
    const res = body === undefined ? await req : await req.send(body);
    return { status: res.status, body: res.body };
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    for (const [login, role] of [['admin', 'administrator'], ['editor', 'editor'], ['authorA', 'author'],
        ['authorB', 'author'], ['contributor', 'contributor']]) await seedUser(login, role);
    for (const body of [{ name: LEDGER_TYPE, public: false, capability_type: 'arsledger' }, { name: PRIVATE_TYPE, public: false }]) {
        const res = await call('admin', 'post', '/types').send(body);
        assert.strictEqual(res.status, 201, `type ${body.name}: ${res.status} ${JSON.stringify(res.body)}`);
    }
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

describe('1. GET /seo/meta/:postId takes the content API read rule', () => {
    let hiddenAtt: number, hiddenToken: string;
    let ledgerDraft: number, ledgerToken: string;
    let privatePublished: number, privateToken: string, privateExcerpt: string;
    let protectedPost: number, protectedExcerpt: string;
    let publicPost: number, publicToken: string;

    before(async () => {
        const ledger = await entry('admin', LEDGER_TYPE, 'publish');
        hiddenToken = word('hiddenscan');
        hiddenAtt = await attachment('authorB', hiddenToken, { parent: ledger });
        ledgerToken = word('ledgerdraft');
        ledgerDraft = await entry('admin', LEDGER_TYPE, 'draft', { title: ledgerToken });
        privateToken = word('privatepub');
        privateExcerpt = word('privateexcerpt');
        privatePublished = await entry('authorA', PRIVATE_TYPE, 'publish', { title: privateToken, excerpt: privateExcerpt });
        protectedExcerpt = word('protectedexcerpt');
        protectedPost = await entry('authorA', 'post', 'publish', { excerpt: protectedExcerpt, password: 'open-sesame' });
        publicToken = word('publicpost');
        publicPost = await entry('authorA', 'post', 'publish', { title: publicToken });
    });

    test('every refusal is the 404 of a missing id and leaks nothing', async () => {
        assert.strictEqual((await call('editor', 'get', `/media/${hiddenAtt}`)).status, 404, 'precondition: hidden from the editor');
        assert.strictEqual((await call('contributor', 'get', `/posts/${privatePublished}`)).status, 404, 'precondition: hidden from the contributor');
        const missing = await answer('editor', 'get', `/seo/meta/${MISSING_ID}`);
        assert.strictEqual(missing.status, 404);
        const wrong: string[] = [];
        for (const [persona, id, secret, label] of [
            ['editor', hiddenAtt, hiddenToken, 'attachment of a ledger entry'],
            ['editor', ledgerDraft, ledgerToken, 'unpublished entry of a type with its own capability family'],
            ['contributor', privatePublished, privateToken, 'published entry of a public:false type'],
            ['authorB', privatePublished, privateExcerpt, 'published entry of a public:false type (author)'],
        ] as Array<[string, number, string, string]>) {
            const got = await answer(persona, 'get', `/seo/meta/${id}`);
            if (JSON.stringify(got) !== JSON.stringify(missing)) wrong.push(`${persona} / ${label}: ${got.status} ${JSON.stringify(got.body)}`);
            if (JSON.stringify(got.body).includes(secret)) wrong.push(`${persona} / ${label}: leaks ${secret}`);
        }
        assert.deepStrictEqual(wrong, []);
    });

    test('a password-protected entry: the excerpt reaches only who manages it', async () => {
        const reader = await call('authorB', 'get', `/seo/meta/${protectedPost}`);
        assert.strictEqual(reader.status, 200);
        assert.ok(!JSON.stringify(reader.body).includes(protectedExcerpt), 'a reader who does not manage it gets no excerpt');
        const owner = await call('authorA', 'get', `/seo/meta/${protectedPost}`);
        assert.strictEqual(owner.status, 200);
        assert.strictEqual(owner.body.description, protectedExcerpt);
    });

    test('unchanged: who may read the entry still gets its metadata', async () => {
        const pub = await call('contributor', 'get', `/seo/meta/${publicPost}`);
        assert.strictEqual(pub.status, 200);
        assert.strictEqual(pub.body.title, publicToken);
        for (const [persona, id, title] of [['admin', hiddenAtt, hiddenToken], ['admin', ledgerDraft, ledgerToken],
            ['authorA', privatePublished, privateToken], ['editor', privatePublished, privateToken]] as Array<[string, number, string]>) {
            const res = await call(persona, 'get', `/seo/meta/${id}`);
            assert.strictEqual(res.status, 200, `${persona} ${title}`);
            assert.strictEqual(res.body.title, title);
        }
    });
});

describe('2. translation refs name only siblings the reader may read', () => {
    let publicPost: number, hiddenSibling: number, hiddenSlug: string;

    before(async () => {
        publicPost = await entry('authorA', 'post', 'publish');
        hiddenSibling = await entry('admin', PRIVATE_TYPE, 'publish');
        hiddenSlug = (await Post.findById(hiddenSibling)).postName;
        await Post.setLanguage(publicPost, 'en');
        await Post.setLanguage(hiddenSibling, 'fr');
        assert.ok(await Post.linkTranslations(publicPost, hiddenSibling));
    });

    test('anonymous: the public post does not name a published entry of a public:false type', async () => {
        assert.strictEqual((await call(null, 'get', `/posts/${hiddenSibling}`)).status, 404, 'precondition: unreadable');
        const slug = (await Post.findById(publicPost)).postName;
        const wrong: string[] = [];
        const single = await call(null, 'get', `/posts/${publicPost}`);
        const bySlug = await call(null, 'get', `/posts/slug/${encodeURIComponent(slug)}`);
        const list = await call(null, 'get', '/posts?per_page=100');
        const inList = (list.body as any[]).find((p) => p.id === publicPost);
        for (const [label, body] of [['single', single.body], ['slug', bySlug.body], ['list', inList]] as Array<[string, any]>) {
            assert.ok(body, label);
            const refs = Array.isArray(body.translations) ? body.translations : [];
            if (refs.some((t: any) => t.id === hiddenSibling) || JSON.stringify(refs).includes(hiddenSlug)) wrong.push(label);
        }
        assert.deepStrictEqual(wrong, []);
    });

    test('who may read the sibling still sees it', async () => {
        const res = await call('admin', 'get', `/posts/${publicPost}`);
        assert.ok(res.body.translations.some((t: any) => t.id === hiddenSibling));
    });

    test('POST /posts/:id/translations answers the members the caller may read, not the raw group', async () => {
        // The admin builds a set holding an unpublished ledger entry; the editor then links their own post
        // to the admin's published post in that set, which folds the whole set in.
        const adminPost = await entry('admin', 'post', 'publish');
        const ledgerDraft = await entry('admin', LEDGER_TYPE, 'draft');
        const ledgerSlug = (await Post.findById(ledgerDraft)).postName;
        const editorPost = await entry('editor', 'post', 'draft');
        await Post.setLanguage(adminPost, 'en');
        await Post.setLanguage(ledgerDraft, 'de');
        await Post.setLanguage(editorPost, 'es');
        assert.ok(await Post.linkTranslations(adminPost, ledgerDraft));
        assert.strictEqual((await call('editor', 'get', `/posts/${ledgerDraft}`)).status, 404, 'precondition: unreadable');

        const res = await call('editor', 'post', `/posts/${editorPost}/translations`).send({ translationId: adminPost });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const ids = (res.body.translations as any[]).map((t) => t.id);
        assert.ok(ids.includes(adminPost), 'the linked post is listed');
        assert.ok(!ids.includes(ledgerDraft) && !JSON.stringify(res.body).includes(ledgerSlug), 'the unreadable member is not');
        // ...though it stays in the group.
        const raw = await Post.getTranslations(editorPost, undefined, { includeUnpublished: true });
        assert.ok(raw.some((t: any) => t.id === ledgerDraft));
    });
});

describe('3. GET /posts/slug/:slug answers one body for hidden and missing', () => {
    test('a hidden attachment, another user\'s draft and a public:false entry answer exactly as no row', async () => {
        const ledger = await entry('admin', LEDGER_TYPE, 'publish');
        const attTitle = word('scanfile');
        const att = await attachment('authorB', attTitle, { parent: ledger });
        const attSlug = (await Post.findById(att)).postName;
        const draft = await entry('authorB', 'post', 'draft');
        const draftSlug = (await Post.findById(draft)).postName;
        const priv = await entry('admin', PRIVATE_TYPE, 'publish');
        const privSlug = (await Post.findById(priv)).postName;
        const nobody = word('nobodyhasthisslug');

        const wrong: string[] = [];
        for (const [persona, query, held] of [
            ['editor', '?type=attachment', attSlug],
            [null, '?type=attachment', attSlug],
            [null, '', draftSlug],
            ['authorA', '', draftSlug],
            [null, `?type=${PRIVATE_TYPE}`, privSlug],
            [null, '', privSlug],
        ] as Array<[string | null, string, string]>) {
            const missing = await answer(persona, 'get', `/posts/slug/${nobody}${query}`);
            const hidden = await answer(persona, 'get', `/posts/slug/${encodeURIComponent(held)}${query}`);
            assert.strictEqual(missing.status, 404);
            if (JSON.stringify(hidden) !== JSON.stringify(missing)) {
                wrong.push(`${persona || 'anonymous'} ${held}${query}: ${JSON.stringify(hidden)} vs ${JSON.stringify(missing)}`);
            }
        }
        assert.deepStrictEqual(wrong, []);
        // Control: who may read it gets it.
        const ok = await call('admin', 'get', `/posts/slug/${encodeURIComponent(attSlug)}?type=attachment`);
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.body.id, att);
    });
});

describe('4. comments and the collaboration channel treat a hidden attachment as a missing post', () => {
    let hiddenAtt: number, privateAtt: number, commentId: number;
    // An attachment ROW set to 'publish' (possible through PUT /posts/:id) hanging off the same hidden entry.
    // POST /comments only takes entries in a commentable state ('publish' or 'private'), so this is the row on
    // which the attachment rule — not the state rule — is what refuses a caller who may not see it; and the
    // site-wide comment list, whose public filter passes a published row of a public type, must apply that
    // rule as well (tested below).
    let hiddenPublishedAtt: number, publishedCommentId: number;

    const approvedComment = async (postId: number) => {
        const r = await dbAsync.run(
            `INSERT INTO comments (comment_post_id, comment_author, comment_author_email, comment_content, comment_approved, comment_date, comment_date_gmt, comment_type)
             VALUES (?, 'Visitor', 'visitor@example.com', ?, '1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'comment')`,
            [postId, word('approvedcomment')]);
        return Number(r.lastID);
    };

    before(async () => {
        const ledger = await entry('admin', LEDGER_TYPE, 'publish');
        hiddenAtt = await attachment('authorB', word('ledgerphoto'), { parent: ledger });
        hiddenPublishedAtt = await attachment('authorB', word('ledgerpubphoto'), { status: 'publish', parent: ledger });
        // authorB's PRIVATE, unattached item: visible to its uploader and edit_others_posts, not to authorA.
        privateAtt = await attachment('authorB', word('privatephoto'), { status: 'private' });
        commentId = await approvedComment(hiddenAtt);
        publishedCommentId = await approvedComment(hiddenPublishedAtt);
    });

    test('POST /comments: same 404 as a missing post id, nothing stored', async () => {
        const wrong: string[] = [];
        for (const [persona, id] of [['editor', hiddenAtt], ['authorA', hiddenAtt], [null, hiddenAtt], ['authorA', privateAtt],
            ['editor', hiddenPublishedAtt], ['authorA', hiddenPublishedAtt], [null, hiddenPublishedAtt]] as Array<[string | null, number]>) {
            const guest = persona ? {} : { author_name: 'Guest', author_email: 'guest@example.com' };
            const text = word('probe');
            const missing = await answer(persona, 'post', '/comments', { post: MISSING_ID, content: word('probe'), ...guest });
            const hidden = await answer(persona, 'post', '/comments', { post: id, content: text, ...guest });
            if (JSON.stringify(hidden) !== JSON.stringify(missing)) {
                wrong.push(`${persona || 'anonymous'} on ${id}: ${hidden.status} ${JSON.stringify(hidden.body)} vs ${missing.status}`);
            }
            const stored = await dbAsync.get('SELECT comment_id FROM comments WHERE comment_content LIKE ?', [`%${text}%`]);
            if (stored) wrong.push(`${persona || 'anonymous'} on ${id}: a comment was stored`);
        }
        assert.deepStrictEqual(wrong, []);
        // Control: who may see it may comment on it — when it is in a commentable state. An 'inherit' row is
        // not one, for anybody: it answers the same 404 to an administrator too.
        const ok = await call('admin', 'post', '/comments').send({ post: hiddenPublishedAtt, content: word('admincomment') });
        assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
        const inherit = await answer('admin', 'post', '/comments', { post: hiddenAtt, content: word('admincomment') });
        const missing = await answer('admin', 'post', '/comments', { post: MISSING_ID, content: word('admincomment') });
        assert.deepStrictEqual(inherit, missing);
    });

    test('reading its comments: GET /comments/:id and ?post= answer as for nothing', async () => {
        const missingComment = await answer('authorA', 'get', `/comments/${MISSING_ID}`);
        const hiddenComment = await answer('authorA', 'get', `/comments/${commentId}`);
        assert.deepStrictEqual(hiddenComment, missingComment);

        const missingList = await call('authorA', 'get', `/comments?post=${MISSING_ID}`);
        for (const id of [hiddenAtt, hiddenPublishedAtt]) {
            const hiddenList = await call('authorA', 'get', `/comments?post=${id}`);
            assert.deepStrictEqual(hiddenList.body, missingList.body, `?post=${id}`);
            assert.deepStrictEqual(hiddenList.body, []);
            assert.strictEqual(hiddenList.headers['x-wp-total'], missingList.headers['x-wp-total']);
            assert.strictEqual(hiddenList.headers['x-wp-totalpages'], missingList.headers['x-wp-totalpages']);
        }
        // The 'publish' row's comment is "no such comment" too, although its own status alone would pass.
        assert.deepStrictEqual(await answer('authorA', 'get', `/comments/${publishedCommentId}`), missingComment);
        assert.deepStrictEqual(await answer(null, 'get', `/comments/${publishedCommentId}`), await answer(null, 'get', `/comments/${MISSING_ID}`));

        // A holder of moderate_comments still reads it: the moderation queue is site-wide, and the attachment
        // rule of the comment routes is for callers without that capability.
        const mod = await call('admin', 'get', `/comments/${commentId}`);
        assert.strictEqual(mod.status, 200);
    });

    test('the site-wide list, its replies and its totals: an attachment\'s comments reach only who may see the attachment', async () => {
        // An editor's content capabilities without moderate_comments (whose holders see the whole moderation
        // queue — the control at the end) and, like every editor here, without the ledger type's family.
        const editorCaps: string[] = roles.getRole('editor').capabilities;
        await roles.setRole('ars_content_editor', { name: 'Content editor', capabilities: editorCaps.filter((c) => c !== 'moderate_comments') });
        await seedUser('contentEditor', 'ars_content_editor');
        await seedUser('subscriber', 'subscriber');
        await seedUser('ledgerAuthor', 'author');

        // A published entry of the `public: false` ledger type: readable by its author, by nobody else here
        // who lacks moderate_comments. Its attachment row is 'publish' — the public filter of the list
        // judges that row's own status and type, which pass.
        const ledger = await entry('ledgerAuthor', LEDGER_TYPE, 'publish');
        const att = await attachment('authorB', word('ledgerlisted'), { status: 'publish', parent: ledger });
        const token = word('attachmentthread');
        const insert = async (content: string, parent: number) => Number((await dbAsync.run(
            `INSERT INTO comments (comment_post_id, comment_author, comment_author_email, comment_content, comment_approved, comment_date, comment_date_gmt, comment_type, comment_parent)
             VALUES (?, 'Visitor', 'visitor@example.com', ?, '1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'comment', ?)`,
            [att, content, parent])).lastID);
        const top = await insert(`${token} first`, 0);
        const reply = await insert(`${token} reply`, top);

        for (const persona of ['contentEditor', 'subscriber', 'authorA']) {
            assert.strictEqual((await call(persona, 'get', `/media/${att}`)).status, 404, `precondition: hidden from ${persona}`);
        }
        assert.strictEqual((await call('ledgerAuthor', 'get', `/media/${att}`)).status, 200, 'precondition: visible to the entry\'s author');

        const wrong: string[] = [];
        for (const persona of [null, 'subscriber', 'contentEditor', 'authorA']) {
            const who = persona || 'anonymous';
            const searched = await call(persona, 'get', `/comments?search=${token}`);
            if (searched.status !== 200 || JSON.stringify(searched.body) !== '[]') wrong.push(`${who} ?search: ${searched.status} ${JSON.stringify(searched.body)}`);
            if (searched.headers['x-wp-total'] !== '0' || searched.headers['x-wp-totalpages'] !== '0') {
                wrong.push(`${who} ?search totals: ${searched.headers['x-wp-total']}/${searched.headers['x-wp-totalpages']}`);
            }
            const replies = await call(persona, 'get', `/comments?parent=${top}`);
            if (JSON.stringify(replies.body) !== '[]' || replies.headers['x-wp-total'] !== '0') {
                wrong.push(`${who} ?parent: ${JSON.stringify(replies.body)} total ${replies.headers['x-wp-total']}`);
            }
            const everything = await call(persona, 'get', '/comments?per_page=100');
            const listed = (everything.body as any[]).filter((c) => c.postId === att || [top, reply].includes(c.id));
            if (listed.length) wrong.push(`${who} site-wide list: ${JSON.stringify(listed)}`);
        }
        const feed = await call(null, 'get', '/seo/comments/feed.xml');
        if (feed.status !== 200 || feed.text.includes(token)) wrong.push(`comments feed: ${feed.status}`);
        assert.deepStrictEqual(wrong, []);

        // Whoever may read the entry gets the comments and counts them.
        const reader = await call('ledgerAuthor', 'get', `/comments?search=${token}`);
        assert.deepStrictEqual((reader.body as any[]).map((c) => c.id).sort(), [top, reply].sort());
        assert.strictEqual(reader.headers['x-wp-total'], '2');
        const readerReplies = await call('ledgerAuthor', 'get', `/comments?parent=${top}`);
        assert.deepStrictEqual((readerReplies.body as any[]).map((c) => c.id), [reply]);
        // Control: a holder of moderate_comments sees the site-wide moderation queue, this thread included.
        const moderator = await call('editor', 'get', `/comments?search=${token}`);
        assert.strictEqual(moderator.headers['x-wp-total'], '2');
    });

    test('the collaboration channel: a hidden attachment answers as a missing post', async () => {
        const missing = await answer('editor', 'post', `/collab/${MISSING_ID}/presence`, { siteId: 'x', sel: {} });
        const hidden = await answer('editor', 'post', `/collab/${hiddenAtt}/presence`, { siteId: 'x', sel: {} });
        assert.strictEqual(missing.status, 404);
        assert.deepStrictEqual(hidden, missing);
    });
});

describe('5. a post\'s parent: an attachment the caller may not see answers as a missing parent', () => {
    let hiddenAtt: number, privateAtt: number, ownAtt: number, visibleAtt: number, foreignPublishedAtt: number;
    const parentOf = async (id: number) => Number((await dbAsync.get('SELECT post_parent FROM posts WHERE id = ?', [id])).post_parent);
    const rowsTitled = async (title: string) => (await dbAsync.all('SELECT id FROM posts WHERE post_title = ?', [title])).length;

    before(async () => {
        const ledger = await entry('admin', LEDGER_TYPE, 'publish');
        hiddenAtt = await attachment('authorB', word('ledgerparent'), { parent: ledger });
        privateAtt = await attachment('authorB', word('privateparent'), { status: 'private' });
        ownAtt = await attachment('authorA', word('ownparent'));
        visibleAtt = await attachment('authorB', word('visibleparent'), { parent: await entry('authorB', 'post', 'draft') });
        foreignPublishedAtt = await attachment('authorA', word('foreignpubparent'), { parent: await entry('authorB', 'post', 'publish') });
    });

    test('POST /posts: the same 400 as a missing parent id, and nothing created', async () => {
        assert.strictEqual((await call('editor', 'get', `/media/${hiddenAtt}`)).status, 404, 'precondition: hidden from the editor');
        assert.strictEqual((await call('authorA', 'get', `/media/${privateAtt}`)).status, 404, 'precondition: hidden from the author');
        const wrong: string[] = [];
        for (const [persona, id] of [['editor', hiddenAtt], ['authorA', hiddenAtt], ['authorA', privateAtt]] as Array<[string, number]>) {
            const missing = await answer(persona, 'post', '/posts', { title: word('missingparent'), parent: MISSING_ID });
            assert.strictEqual(missing.status, 400, JSON.stringify(missing.body));
            const title = word('hiddenparent');
            const hidden = await answer(persona, 'post', '/posts', { title, parent: id });
            if (JSON.stringify(hidden) !== JSON.stringify(missing)) {
                wrong.push(`${persona} on ${id}: ${hidden.status} ${JSON.stringify(hidden.body)} vs ${missing.status} ${JSON.stringify(missing.body)}`);
            }
            if (await rowsTitled(title)) wrong.push(`${persona} on ${id}: a post was created under it`);
        }
        assert.deepStrictEqual(wrong, []);
    });

    test('PUT /posts/:id: the same 400 as a missing parent id, and the parent is not changed', async () => {
        const wrong: string[] = [];
        for (const [persona, id] of [['editor', hiddenAtt], ['authorA', hiddenAtt], ['authorA', privateAtt]] as Array<[string, number]>) {
            const own = await entry(persona, 'post', 'draft');
            const missing = await answer(persona, 'put', `/posts/${own}`, { parent: MISSING_ID });
            assert.strictEqual(missing.status, 400, JSON.stringify(missing.body));
            const hidden = await answer(persona, 'put', `/posts/${own}`, { parent: id });
            if (JSON.stringify(hidden) !== JSON.stringify(missing)) {
                wrong.push(`${persona} on ${id}: ${hidden.status} ${JSON.stringify(hidden.body)} vs ${missing.status} ${JSON.stringify(missing.body)}`);
            }
            if (await parentOf(own) !== 0) wrong.push(`${persona} on ${id}: the post was re-parented under it`);
        }
        assert.deepStrictEqual(wrong, []);
    });

    test('a parent the caller sees and may edit still works; one whose entry they may not edit is 403', async () => {
        const mine = await call('authorA', 'post', '/posts').send({ title: word('underown'), parent: ownAtt });
        assert.strictEqual(mine.status, 201, JSON.stringify(mine.body));
        assert.strictEqual(await parentOf(mine.body.id), ownAtt);

        const edited = await call('editor', 'post', '/posts').send({ title: word('undervisible'), parent: visibleAtt });
        assert.strictEqual(edited.status, 201, JSON.stringify(edited.body));
        assert.strictEqual(await parentOf(edited.body.id), visibleAtt);

        const own = await entry('editor', 'post', 'draft');
        const moved = await call('editor', 'put', `/posts/${own}`).send({ parent: visibleAtt });
        assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
        assert.strictEqual(await parentOf(own), visibleAtt);

        // authorA's own upload, hanging off authorB's published post: authorA sees it but may not edit that post.
        assert.strictEqual((await call('authorA', 'get', `/posts/${foreignPublishedAtt}`)).status, 200, 'precondition: visible to the author');
        const title = word('underforeign');
        const refused = await call('authorA', 'post', '/posts').send({ title, parent: foreignPublishedAtt });
        assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
        assert.strictEqual(await rowsTitled(title), 0);
    });
});
