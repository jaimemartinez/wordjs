/**
 * FEATURED MEDIA IS ONLY WHAT THE READER MAY SEE (security: `_thumbnail_id` resolved to any post).
 *
 * THE DEFECT. Post.toJSON() resolved the author-written `_thumbnail_id` meta with Post.findById and copied
 * the row's title and file URL into `featuredMedia`, checking neither that the row was an attachment nor
 * that the reader could see it. So:
 *   - a contributor pointed their own draft at an editor's draft/private POST and read its title back;
 *   - an author published a post pointing at it, and every anonymous reader of GET /posts/:id, GET /posts
 *     and GET /posts/slug/:slug got the hidden title (walk the ids, get every unpublished title);
 *   - an attachment hanging off an unpublished entry — 404 on GET /media/:id — shipped its real /uploads
 *     URL to anonymous readers the same way.
 * Both the single-post path (loadFeaturedImage) and the batched list path (hydrateRelations) had it.
 *
 * THE TWIN. GET /media/:id answered an attachment row in ANY status: a draft attachment created through
 * the generic POST /posts surface (GET /posts/:id → 404) came back 200, title included, to anonymous
 * callers. Both surfaces now ask core/attachment-visibility.
 *
 * THE PARENT'S READ POLICY (last describe). The parent gate asked only "is the parent published", so a
 * published entry of a non-public type handed its attachments to everyone on GET /media/:id, the media
 * list and featuredMedia; the list also skipped the gate for any edit_others_posts holder.
 *
 * Everything here drives the REAL routers (require('../routes')) with real JWTs and real roles over a
 * real temp SQLite database; the assertions are on what each caller actually receives.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-featured-media-${STAMP}-`));
const TMP_DB = path.join(TMP_ROOT, 'wordjs.db');
const TMP_UPLOADS = path.join(TMP_ROOT, 'uploads');
fs.mkdirSync(TMP_UPLOADS, { recursive: true });

config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
config.uploads.dir = TMP_UPLOADS;
config.uploads.privateDir = path.join(TMP_ROOT, 'data', 'private-uploads');

const database = require('../config/database');
const roles = require('../core/roles');
const Post = require('../models/Post');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const SECRET = config.jwt.secret;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));

const U: Record<string, number> = {};
let dbAsync: any;
let seq = 0;

const tok = (id: number, login: string) => jwt.sign({ userId: id, username: login }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const as = (persona: string, m: string, p: string) =>
    (request(app) as any)[m](`/api/v1${p}`).set('Authorization', `Bearer ${tok(U[persona], persona)}`);
const anon = (m: string, p: string) => (request(app) as any)[m](`/api/v1${p}`);

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

const uniq = (label: string) => `${label}-${STAMP}-${++seq}`;

/** An attachment row exactly as Media.create leaves one (guid = its /uploads path, file in the meta). */
async function attachment(owner: string, opts: { title: string; file: string; status?: string; parent?: number }) {
    const row = await Post.create({
        authorId: U[owner], title: opts.title, type: 'attachment',
        status: opts.status || 'inherit', parent: opts.parent || 0, mimeType: 'image/png',
    });
    const isPrivate = opts.status === 'private';
    await dbAsync.run('UPDATE posts SET guid = ? WHERE id = ?', [isPrivate ? '' : `/uploads/${opts.file}`, row.id]);
    await Post.updateMeta(row.id, '_wp_attached_file', opts.file);
    return row.id as number;
}

/** A post written through the REAL create route, with `_thumbnail_id` in its meta bag. */
async function postWithThumbnail(persona: string, status: string, thumbnailId: number) {
    const title = uniq(`carrier-${persona}`);
    const res = await as(persona, 'post', '/posts').send({ title, content: '<p>x</p>', status, meta: { _thumbnail_id: String(thumbnailId) } });
    assert.strictEqual(res.status, 201, `create failed: ${res.status} ${JSON.stringify(res.body)}`);
    assert.strictEqual(String(res.body.meta._thumbnail_id), String(thumbnailId), 'the meta itself was stored');
    return { id: res.body.id as number, slug: res.body.slug as string, created: res.body };
}

/** Every public read of one published post: single, by slug, and its entry in the batched list. */
async function anonymousReads(id: number, slug: string) {
    const single = await anon('get', `/posts/${id}`);
    const bySlug = await anon('get', `/posts/slug/${encodeURIComponent(slug)}`);
    const list = await anon('get', '/posts?per_page=100');
    assert.strictEqual(single.status, 200);
    assert.strictEqual(bySlug.status, 200);
    assert.strictEqual(list.status, 200);
    const inList = (list.body as any[]).find((p) => p.id === id);
    assert.ok(inList, 'the published carrier is in the anonymous list');
    return { single, bySlug, list, inList };
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    await seedUser('admin', 'administrator');
    await seedUser('editor', 'editor');
    await seedUser('authorA', 'author');
    await seedUser('authorB', 'author');
    await seedUser('contributor', 'contributor');
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

describe('a `_thumbnail_id` that names a post which is not an attachment projects nothing', () => {
    test('a contributor cannot read an editor\'s draft title back through their own draft', async () => {
        const hidden = uniq('EDITOR-DRAFT-TITLE');
        const target = await Post.create({ authorId: U.editor, title: hidden, type: 'post', status: 'draft' });
        assert.strictEqual((await as('contributor', 'get', `/posts/${target.id}`)).status, 404, 'the target itself is hidden from the contributor');

        const own = await postWithThumbnail('contributor', 'draft', target.id);
        assert.strictEqual(own.created.featuredMedia, undefined, 'not in the create response either');
        assert.ok(!JSON.stringify(own.created).includes(hidden));
        const res = await as('contributor', 'get', `/posts/${own.id}`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.featuredMedia, undefined, 'no featuredMedia for a non-attachment row');
        assert.ok(!JSON.stringify(res.body).includes(hidden), 'the hidden title appears nowhere in the response');
    });

    test('an author publishing a pointer at a PRIVATE post leaks its title to no anonymous reader (single, slug, list)', async () => {
        const hidden = uniq('EDITOR-PRIVATE-TITLE');
        const target = await Post.create({ authorId: U.editor, title: hidden, type: 'post', status: 'private' });
        const carrier = await postWithThumbnail('authorA', 'publish', target.id);
        const { single, bySlug, list, inList } = await anonymousReads(carrier.id, carrier.slug);
        for (const body of [single.body, bySlug.body, inList]) {
            assert.strictEqual(body.featuredMedia, undefined, 'no featuredMedia for a private post');
        }
        for (const res of [single, bySlug, list]) {
            assert.ok(!JSON.stringify(res.body).includes(hidden), 'the private title appears nowhere');
        }
    });

    test('not even a PUBLISHED page becomes "featured media": only an attachment is ever projected', async () => {
        const page = await Post.create({ authorId: U.editor, title: uniq('Published page'), type: 'page', status: 'publish' });
        const carrier = await postWithThumbnail('authorA', 'publish', page.id);
        const { single, inList } = await anonymousReads(carrier.id, carrier.slug);
        assert.strictEqual(single.body.featuredMedia, undefined);
        assert.strictEqual(inList.featuredMedia, undefined);
    });
});

describe('an attachment inherits the visibility of the entry it hangs off', () => {
    let attId: number;
    let draftParentId: number;
    let carrier: { id: number; slug: string };
    const FILE = `secret-${STAMP}/2026/plan.png`;

    before(async () => {
        const parent = await Post.create({ authorId: U.authorB, title: uniq('Unannounced launch'), type: 'post', status: 'draft' });
        draftParentId = parent.id;
        attId = await attachment('authorB', { title: uniq('Launch plan'), file: FILE, parent: draftParentId });
        carrier = await postWithThumbnail('authorA', 'publish', attId);
    });

    test('anonymous readers get neither its title nor its /uploads URL — the same answer as GET /media/:id', async () => {
        assert.strictEqual((await anon('get', `/media/${attId}`)).status, 404, 'GET /media/:id hides it');
        const { single, bySlug, list, inList } = await anonymousReads(carrier.id, carrier.slug);
        for (const body of [single.body, bySlug.body, inList]) assert.strictEqual(body.featuredMedia, undefined);
        for (const res of [single, bySlug, list]) {
            assert.ok(!JSON.stringify(res.body).includes(FILE), 'the file path appears nowhere');
        }
    });

    test('another author (neither the parent\'s writer nor edit_others_posts) gets nothing either', async () => {
        const res = await as('authorA', 'get', `/posts/${carrier.id}`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.featuredMedia, undefined);
        assert.strictEqual((await as('authorA', 'get', `/media/${attId}`)).status, 404);
    });

    test('the parent\'s writer and an editor see it, with its real path', async () => {
        for (const persona of ['authorB', 'editor']) {
            const res = await as(persona, 'get', `/posts/${carrier.id}`);
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.featuredMedia, `${persona} sees the featured image`);
            assert.strictEqual(res.body.featuredMedia.id, attId);
            assert.strictEqual(res.body.featuredMedia.path, `/uploads/${FILE}`);
            const list = await as(persona, 'get', '/posts?per_page=100');
            const entry = (list.body as any[]).find((p) => p.id === carrier.id);
            assert.strictEqual(entry.featuredMedia && entry.featuredMedia.path, `/uploads/${FILE}`, `${persona}: the list path agrees`);
        }
    });

    test('once the parent is published, everybody sees it (the rule follows the parent, not a snapshot)', async () => {
        await Post.update(draftParentId, { status: 'publish' });
        const { single, inList } = await anonymousReads(carrier.id, carrier.slug);
        assert.strictEqual(single.body.featuredMedia && single.body.featuredMedia.path, `/uploads/${FILE}`);
        assert.strictEqual(inList.featuredMedia && inList.featuredMedia.path, `/uploads/${FILE}`);
    });
});

describe('ordinary public media is unchanged', () => {
    test('an unattached public attachment is projected for anonymous readers in every path', async () => {
        const file = `public-${STAMP}/cover.png`;
        const title = uniq('Cover');
        const id = await attachment('authorA', { title, file });
        const carrier = await postWithThumbnail('authorA', 'publish', id);
        const { single, bySlug, inList } = await anonymousReads(carrier.id, carrier.slug);
        for (const body of [single.body, bySlug.body, inList]) {
            assert.deepStrictEqual(
                { id: body.featuredMedia.id, path: body.featuredMedia.path, title: body.featuredMedia.title },
                { id, path: `/uploads/${file}`, title });
            assert.match(body.featuredMedia.url, new RegExp(`/uploads/public-${STAMP}/cover\\.png$`));
        }
    });

    test('a stored `_thumbnail_id` that is not an id (legacy/imported meta) is simply no featured image', async () => {
        // The write contract refuses these today; an older row or an import can still hold one.
        const id = await attachment('authorA', { title: uniq('Real'), file: `garbage-${STAMP}/r.png` });
        for (const value of [`${id}abc`, '1 OR 1=1', '-1', '0']) {
            const post = await Post.create({ authorId: U.authorA, title: uniq('garbage'), type: 'post', status: 'publish' });
            await Post.updateMeta(post.id, '_thumbnail_id', value);
            const read = await anon('get', `/posts/${post.id}`);
            assert.strictEqual(read.status, 200);
            assert.strictEqual(read.body.featuredMedia, undefined, `value ${JSON.stringify(value)}`);
            const list = await anon('get', '/posts?per_page=100');
            assert.strictEqual((list.body as any[]).find((p) => p.id === post.id).featuredMedia, undefined, `list, value ${JSON.stringify(value)}`);
        }
    });
});

describe('a PRIVATE attachment: only who may edit it, and never with a public URL', () => {
    let privId: number;
    let carrier: { id: number; slug: string };
    const FILE = `private-${STAMP}/ebook.png`;

    before(async () => {
        privId = await attachment('authorB', { title: uniq('Paid ebook cover'), file: FILE, status: 'private' });
        carrier = await postWithThumbnail('authorA', 'publish', privId);
    });

    test('anonymous readers and another author get nothing', async () => {
        const { single, inList } = await anonymousReads(carrier.id, carrier.slug);
        assert.strictEqual(single.body.featuredMedia, undefined);
        assert.strictEqual(inList.featuredMedia, undefined);
        assert.strictEqual((await as('authorA', 'get', `/posts/${carrier.id}`)).body.featuredMedia, undefined);
    });

    test('its owner and an administrator get the authenticated download route, never /uploads', async () => {
        for (const persona of ['authorB', 'admin']) {
            const res = await as(persona, 'get', `/posts/${carrier.id}`);
            assert.strictEqual(res.status, 200);
            const fm = res.body.featuredMedia;
            assert.ok(fm, `${persona} sees the private featured image`);
            assert.strictEqual(fm.path, `/api/v1/media/${privId}/file`);
            assert.ok(fm.url.endsWith(`/api/v1/media/${privId}/file`), fm.url);
            assert.ok(!JSON.stringify(fm).includes('/uploads/'), 'no public path for a private file');
        }
    });
});

describe('twin: GET /media/:id applies the same rule to an attachment row in any other status', () => {
    test('a draft attachment created through POST /posts is 404 to anonymous callers, visible to its writer', async () => {
        const hidden = uniq('CONTRIB-DRAFT-ATTACHMENT');
        const created = await as('contributor', 'post', '/posts').send({ title: hidden, type: 'attachment', status: 'draft' });
        assert.strictEqual(created.status, 201, `create failed: ${created.status} ${JSON.stringify(created.body)}`);
        const id = created.body.id;
        assert.strictEqual((await anon('get', `/posts/${id}`)).status, 404, 'GET /posts/:id hides the draft row');

        const anonymous = await anon('get', `/media/${id}`);
        assert.strictEqual(anonymous.status, 404);
        assert.ok(!JSON.stringify(anonymous.body).includes(hidden));
        assert.strictEqual((await as('authorA', 'get', `/media/${id}`)).status, 404, 'another author: 404');

        const own = await as('contributor', 'get', `/media/${id}`);
        assert.strictEqual(own.status, 200);
        assert.strictEqual(own.body.title, hidden);
        assert.strictEqual((await as('editor', 'get', `/media/${id}`)).status, 200, 'an editor reads it');

        // ...and as a featured image it follows the same rule.
        const carrier = await postWithThumbnail('authorA', 'publish', id);
        const { single, inList } = await anonymousReads(carrier.id, carrier.slug);
        assert.strictEqual(single.body.featuredMedia, undefined);
        assert.strictEqual(inList.featuredMedia, undefined);
    });

    test('public media is unchanged on GET /media/:id (unattached inherit item, anonymous 200)', async () => {
        const title = uniq('Public media');
        const id = await attachment('authorA', { title, file: `pub-${STAMP}/a.png` });
        const res = await anon('get', `/media/${id}`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.title, title);
        assert.strictEqual(res.body.sourceUrl, `/uploads/pub-${STAMP}/a.png`);
    });

    test('a non-attachment id is 404 on GET /media/:id', async () => {
        const page = await Post.create({ authorId: U.editor, title: uniq('Plain post'), type: 'post', status: 'publish' });
        assert.strictEqual((await anon('get', `/media/${page.id}`)).status, 404);
    });
});

/**
 * THE PARENT'S READ POLICY, NOT ONLY ITS STATUS.
 *
 * The inheritance rule asked one question of the parent — `postStatus === 'publish'` — and never whether
 * the READER may read it. So the published entry of a `public: false` type (GET /posts/:id → 404 for an
 * anonymous caller) handed its attachments to everybody: GET /media/:id answered 200 with the file's
 * /uploads URL, the anonymous media list listed it (and counted it), and any public post naming it as
 * featured image projected it. The media LIST kept its own copy of the rule and had the same hole, plus
 * one more: it skipped the parent check altogether for any holder of edit_others_posts, whatever the
 * parent's type and capability family.
 *
 * Search-scoped list reads use one alphanumeric token per item, so the assertions (presence AND the
 * X-WP-Total the pager advertises) are about that item alone, whatever else the file created.
 */
describe('an attachment is visible only to who may READ its parent (type policy, internal types, password)', () => {
    const PRIVATE_TYPE = 'fmv_invoice';   // public:false, the plain `post` capability family
    const LEDGER_TYPE = 'fmv_ledger';     // public:false, its own `ledger` capability family

    const word = (label: string) => `${label}${process.pid}x${Date.now()}y${++seq}`.toLowerCase();

    /** What one caller (null = anonymous) learns about one attachment through BOTH media surfaces. */
    async function mediaView(persona: string | null, id: number, token: string) {
        const one = persona ? await as(persona, 'get', `/media/${id}`) : await anon('get', `/media/${id}`);
        const q = `/media?per_page=100&search=${encodeURIComponent(token)}`;
        const list = persona ? await as(persona, 'get', q) : await anon('get', q);
        assert.strictEqual(list.status, 200);
        return {
            status: one.status,
            listed: (list.body as any[]).some((m) => m.id === id),
            total: list.headers['x-wp-total'],
            text: JSON.stringify(one.body) + JSON.stringify(list.body),
        };
    }

    async function assertHidden(persona: string | null, id: number, token: string, file: string) {
        const v = await mediaView(persona, id, token);
        const who = persona || 'anonymous';
        assert.strictEqual(v.status, 404, `${who}: GET /media/:id is 404`);
        assert.strictEqual(v.listed, false, `${who}: absent from the media list`);
        assert.strictEqual(v.total, '0', `${who}: not counted in X-WP-Total`);
        assert.ok(!v.text.includes(file) && !v.text.includes(token), `${who}: neither its path nor its title leaks`);
    }

    async function assertVisible(persona: string | null, id: number, token: string) {
        const v = await mediaView(persona, id, token);
        const who = persona || 'anonymous';
        assert.strictEqual(v.status, 200, `${who}: GET /media/:id is 200`);
        assert.strictEqual(v.listed, true, `${who}: listed`);
        assert.strictEqual(v.total, '1', `${who}: counted`);
    }

    before(async () => {
        for (const body of [{ name: PRIVATE_TYPE, public: false }, { name: LEDGER_TYPE, public: false, capability_type: 'ledger' }]) {
            const res = await as('admin', 'post', '/types').send(body);
            assert.strictEqual(res.status, 201, `type ${body.name}: ${res.status} ${JSON.stringify(res.body)}`);
        }
    });

    after(async () => {
        await dbAsync.run('DELETE FROM posts WHERE post_type IN (?, ?)', [PRIVATE_TYPE, LEDGER_TYPE]);
        for (const name of [PRIVATE_TYPE, LEDGER_TYPE]) await as('admin', 'delete', `/types/${name}`);
    });

    test('the PUBLISHED entry of a public:false type hides its attachment from anonymous readers on every surface', async () => {
        const entry = await Post.create({ authorId: U.authorB, title: uniq('Invoice 0042'), type: PRIVATE_TYPE, status: 'publish' });
        assert.strictEqual((await anon('get', `/posts/${entry.id}`)).status, 404, 'precondition: the entry itself is not public');

        const token = word('invoicescan');
        const file = `invoices-${STAMP}/0042.png`;
        const id = await attachment('authorB', { title: token, file, parent: entry.id });

        await assertHidden(null, id, token, file);
        await assertHidden('authorA', id, token, file); // logged in, but may not read the entry either

        // ...and as the featured image of a public post: single, by slug, and in the batched list.
        const carrier = await postWithThumbnail('authorA', 'publish', id);
        const { single, bySlug, list, inList } = await anonymousReads(carrier.id, carrier.slug);
        for (const body of [single.body, bySlug.body, inList]) assert.strictEqual(body.featuredMedia, undefined);
        for (const res of [single, bySlug, list]) assert.ok(!JSON.stringify(res.body).includes(file), 'the path appears nowhere');

        // Who may read the entry still sees its attachment, everywhere.
        for (const persona of ['authorB', 'editor', 'admin']) await assertVisible(persona, id, token);
        const editorView = await as('editor', 'get', `/posts/${carrier.id}`);
        assert.strictEqual(editorView.body.featuredMedia && editorView.body.featuredMedia.path, `/uploads/${file}`);
    });

    test('the parent TYPE\'s capability family decides, not edit_others_posts (published and draft parents)', async () => {
        // An editor holds edit_others_posts but nothing of the `ledger` family, so GET /posts/:id refuses
        // both entries; the old list path waved every edit_others_posts holder through without a look.
        const published = await Post.create({ authorId: U.admin, title: uniq('Ledger live'), type: LEDGER_TYPE, status: 'publish' });
        const draft = await Post.create({ authorId: U.admin, title: uniq('Ledger draft'), type: LEDGER_TYPE, status: 'draft' });
        for (const entry of [published, draft]) {
            assert.strictEqual((await as('editor', 'get', `/posts/${entry.id}`)).status, 404, 'precondition: the editor may not read it');
            const token = word('ledgerfile');
            const file = `ledger-${STAMP}/${entry.id}.png`;
            const id = await attachment('authorB', { title: token, file, parent: entry.id });
            await assertHidden('editor', id, token, file);
            await assertHidden(null, id, token, file);
            await assertVisible('admin', id, token);
        }
    });

    test('a PASSWORD-PROTECTED entry\'s attachments are part of what the password protects', async () => {
        // The usual shape: the entry's own image, attached to it and used as its featured image.
        const entry = await Post.create({ authorId: U.authorB, title: uniq('Members only'), type: 'post', status: 'publish', password: 'open-sesame' });
        const token = word('membersphoto');
        const file = `members-${STAMP}/photo.png`;
        const id = await attachment('authorB', { title: token, file, parent: entry.id });
        await Post.updateMeta(entry.id, '_thumbnail_id', String(id));

        await assertHidden(null, id, token, file);
        await assertHidden('authorA', id, token, file);
        // The entry itself stays published and addressable; its featured image is not projected to a
        // reader who does not manage it — single, by slug, and the batched list.
        const { single, bySlug, list, inList } = await anonymousReads(entry.id, entry.postName);
        for (const body of [single.body, bySlug.body, inList]) assert.strictEqual(body.featuredMedia, undefined, 'anonymous: no featuredMedia');
        for (const res of [single, bySlug, list]) assert.ok(!JSON.stringify(res.body).includes(file), 'the path appears nowhere');
        const other = await as('authorA', 'get', `/posts/${entry.id}`);
        assert.strictEqual(other.status, 200);
        assert.strictEqual(other.body.featuredMedia, undefined, 'authorA: no featuredMedia');

        // Its author and an editor (who manage the entry) see it, featured image included.
        for (const persona of ['authorB', 'editor']) {
            await assertVisible(persona, id, token);
            const read = await as(persona, 'get', `/posts/${entry.id}`);
            assert.strictEqual(read.body.featuredMedia && read.body.featuredMedia.path, `/uploads/${file}`, persona);
        }
    });

    test('an INTERNAL parent (a published nav_menu_item) never makes its attachment public, even before the type registry has loaded', async () => {
        const menuItem = await Post.create({ authorId: U.admin, title: uniq('Menu item'), type: 'nav_menu_item', status: 'publish' });
        const token = word('menuicon');
        const file = `menu-${STAMP}/icon.png`;
        const id = await attachment('admin', { title: token, file, parent: menuItem.id });
        await assertHidden(null, id, token, file);
        await assertVisible('admin', id, token);

        // initPostTypes() is async and runs after the listener opens: until it resolves the registry
        // knows no type at all and every one falls back to the public `post` family. An attachment of
        // ordinary published content must stay visible in that window; one of an internal row must not.
        const ordinaryParent = await Post.create({ authorId: U.authorA, title: uniq('Ordinary'), type: 'post', status: 'publish' });
        const ordinaryToken = word('ordinaryimg');
        const ordinaryId = await attachment('authorA', { title: ordinaryToken, file: `ord-${STAMP}/a.png`, parent: ordinaryParent.id });
        const postTypes = require('../core/post-types');
        const saved = { getPostType: postTypes.getPostType, getContentTypeSchema: postTypes.getContentTypeSchema };
        postTypes.getPostType = () => null;
        postTypes.getContentTypeSchema = () => null;
        try {
            await assertHidden(null, id, token, file);
            await assertVisible(null, ordinaryId, ordinaryToken);
        } finally {
            postTypes.getPostType = saved.getPostType;
            postTypes.getContentTypeSchema = saved.getContentTypeSchema;
        }
    });

    test('unchanged: published public parents, and a draft PAGE for its author and an editor', async () => {
        const page = await Post.create({ authorId: U.authorB, title: uniq('Public page'), type: 'page', status: 'publish' });
        const token = word('pagehero');
        const id = await attachment('authorB', { title: token, file: `page-${STAMP}/hero.png`, parent: page.id });
        for (const persona of [null, 'authorA', 'editor']) await assertVisible(persona, id, token);

        const draftPage = await Post.create({ authorId: U.authorB, title: uniq('Draft page'), type: 'page', status: 'draft' });
        const draftToken = word('draftpagehero');
        const draftFile = `draftpage-${STAMP}/hero.png`;
        const draftId = await attachment('authorB', { title: draftToken, file: draftFile, parent: draftPage.id });
        for (const persona of ['authorB', 'editor', 'admin']) await assertVisible(persona, draftId, draftToken);
        for (const persona of [null, 'authorA']) await assertHidden(persona, draftId, draftToken, draftFile);
    });
});
