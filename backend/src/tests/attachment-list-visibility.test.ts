/**
 * ATTACHMENTS FOLLOW THEIR PARENT ENTRY ON EVERY SURFACE — LISTS AND TOTALS, BYTES, THE GENERIC /posts
 * SURFACE AND WRITES (security, follow-up to featured-media-visibility.test.ts).
 *
 * 1. THE PAGER ORACLE. GET /media decided visibility AFTER the query and subtracted only the items hidden
 *    on the CURRENT page from a total that counted everything. Any other page — a page past the end above
 *    all — and every `?search=` (FTS5 prefix / LIKE substring over the title, which defaults to the upload's
 *    filename) therefore still counted hidden attachments: existence, count, and the title one character at
 *    a time. The rule is now part of the query (core/attachment-visibility attachmentVisibilityCondition,
 *    through Post.buildWhere), for the rows and the count alike. TWIN: GET /posts?type=attachment.
 *    The SQL is DERIVED from the JS rule; the cross-check here compares the two on a matrix of real rows
 *    for every role, including the boot window before the type registry has loaded.
 * 2. THE BYTES. GET /media/:id/file asked only "may edit the item", so an editor downloaded the private
 *    file of a published entry of a type with its own capability family while GET /media/:id was 404.
 * 3. THE GENERIC /posts SURFACE AND WRITES. /posts/:id, its meta (with `_wp_attached_file`), the slug
 *    route, the list, translations, revisions, presence and collaboration showed or accepted such an
 *    attachment; PUT/DELETE /media/:id edited and deleted it. Reads now take the parent's read rule,
 *    writes the parent's edit rule.
 * 4. A PASSWORD-PROTECTED entry's featured image — even an UNATTACHED library image — is withheld
 *    (featuredMedia and `_thumbnail_id`) from a reader who does not manage the entry.
 * 5. One query for the parents of a media page instead of one Post.findById per parent.
 *
 * Everything drives the REAL routers with real JWTs and roles over a real temp SQLite database.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-attachment-lists-${STAMP}-`));
const TMP_UPLOADS = path.join(TMP_ROOT, 'uploads');
const TMP_PRIVATE = path.join(TMP_ROOT, 'data', 'private-uploads');
fs.mkdirSync(TMP_UPLOADS, { recursive: true });

config.dbPath = path.join(TMP_ROOT, 'wordjs.db');
config.dbDriver = 'sqlite-native';
config.uploads.dir = TMP_UPLOADS;
config.uploads.privateDir = TMP_PRIVATE;

const database = require('../config/database');
const roles = require('../core/roles');
const Post = require('../models/Post');
const User = require('../models/User');
const { canViewAttachment } = require('../core/attachment-visibility');

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

const PRIVATE_TYPE = 'alv_invoice';   // public:false, the plain `post` capability family
const LEDGER_TYPE = 'alv_ledger';     // public:false, its own `ledger` capability family
const UNKNOWN_TYPE = 'alv_gone';      // never registered: an entry whose type the registry does not know

const tok = (id: number, login: string) => jwt.sign({ userId: id, username: login }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const call = (persona: string | null, m: string, p: string) => {
    const r = (request(app) as any)[m](`/api/v1${p}`);
    return persona ? r.set('Authorization', `Bearer ${tok(U[persona], persona)}`) : r;
};
/** One FTS token per call: unique, alphanumeric, so a search for it is about these rows alone. */
const word = (label: string) => `${label}${process.pid}x${Date.now()}y${++seq}`.toLowerCase();

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

/** An entry of any type (the type is written straight to the row, so unregistered names are possible). */
async function entry(owner: string, type: string, status: string, password = '') {
    const row = await Post.create({ authorId: U[owner], title: word('entry'), type: 'post', status, password });
    if (type !== 'post') {
        await dbAsync.run('UPDATE posts SET post_type = ? WHERE id = ?', [type, row.id]);
        await Post._invalidatePostCacheById(row.id);
    }
    return row.id as number;
}

/** An attachment row exactly as Media.create leaves one (guid = its /uploads path, file in the meta). */
async function attachment(owner: string, opts: { title: string; file?: string; status?: string; parent?: number }) {
    const row = await Post.create({
        authorId: U[owner], title: opts.title, type: 'attachment',
        status: opts.status || 'inherit', parent: opts.parent || 0, mimeType: 'image/png',
    });
    const file = opts.file || `${word('f')}/${row.id}.png`;
    await dbAsync.run('UPDATE posts SET guid = ? WHERE id = ?', [opts.status === 'private' ? '' : `/uploads/${file}`, row.id]);
    await Post.updateMeta(row.id, '_wp_attached_file', file);
    await Post._invalidatePostCacheById(row.id);
    return row.id as number;
}

async function listTotals(persona: string | null, p: string) {
    const res = await call(persona, 'get', p);
    assert.strictEqual(res.status, 200, `${p}: ${res.status} ${JSON.stringify(res.body)}`);
    return { ids: (res.body as any[]).map((m) => m.id), total: res.headers['x-wp-total'], pages: res.headers['x-wp-totalpages'], text: JSON.stringify(res.body) };
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
    await seedUser('subscriber', 'subscriber');
    for (const body of [{ name: PRIVATE_TYPE, public: false }, { name: LEDGER_TYPE, public: false, capability_type: 'ledger' }]) {
        const res = await call('admin', 'post', '/types').send(body);
        assert.strictEqual(res.status, 201, `type ${body.name}: ${res.status} ${JSON.stringify(res.body)}`);
    }
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

describe('1. X-WP-Total / X-WP-TotalPages count only what the caller may see', () => {
    let T: string;
    let visibleId: number;
    const hidden: number[] = [];

    before(async () => {
        T = word('ledgerdoc');
        const ledger = await entry('admin', LEDGER_TYPE, 'publish');
        for (const suffix of ['a', 'b', 'c']) hidden.push(await attachment('authorB', { title: `${T}${suffix}`, parent: ledger }));
        visibleId = await attachment('authorB', { title: `${T}v` });
    });

    for (const persona of [null, 'subscriber', 'authorA', 'editor']) {
        test(`${persona || 'anonymous'}: every page, a page past the end and a prefix search count the ONE visible item`, async () => {
            for (const page of [1, 2, 3, 50]) {
                const r = await listTotals(persona, `/media?search=${T}&per_page=1&page=${page}`);
                assert.strictEqual(r.total, '1', `page ${page}: X-WP-Total`);
                assert.strictEqual(r.pages, '1', `page ${page}: X-WP-TotalPages`);
                assert.deepStrictEqual(r.ids, page === 1 ? [visibleId] : [], `page ${page}: rows`);
            }
            // The title walk: `<prefix>a` matches only a hidden item; past the first page it used to say 1.
            for (const page of [1, 2]) {
                const r = await listTotals(persona, `/media?search=${T}a&page=${page}`);
                assert.strictEqual(r.total, '0', `prefix search, page ${page}`);
                assert.strictEqual(r.pages, '0');
                assert.ok(!r.text.includes(`${T}a`));
            }
        });
    }

    test('the twin: GET /posts?type=attachment counts the same set (editor holds edit_others_posts, not the ledger family)', async () => {
        for (const page of [1, 2, 50]) {
            const r = await listTotals('editor', `/posts?type=attachment&status=inherit&search=${T}&per_page=1&page=${page}`);
            assert.strictEqual(r.total, '1', `page ${page}`);
            assert.strictEqual(r.pages, '1');
            assert.ok(hidden.every((id) => !r.ids.includes(id)));
        }
    });

    test('who may read the ledger entry sees and counts all four, on both lists', async () => {
        const media = await listTotals('admin', `/media?search=${T}&per_page=1&page=2`);
        assert.strictEqual(media.total, '4');
        assert.strictEqual(media.pages, '4');
        const posts = await listTotals('admin', `/posts?type=attachment&status=inherit&search=${T}&per_page=100`);
        assert.strictEqual(posts.total, '4');
        assert.deepStrictEqual([...posts.ids].sort(), [...hidden, visibleId].sort());
    });
});

/**
 * 1a. AN ENTRY WHOSE TYPE THE REGISTRY DOES NOT KNOW IS NOT PUBLIC, AND NEITHER ARE ITS ATTACHMENTS.
 *
 * The read policy of an unregistered type fails closed (core/post-capabilities readPolicyForType: a
 * WordPress import's contact-form store, a deleted non-public custom type). The parent rule asks that
 * policy (parentAllowsAttachment → canReadPostContent → canReadPostRecord), and the media list's SQL is
 * derived from the same predicates — so the attachments of such an entry are hidden from anonymous
 * callers on GET /media/:id, in GET /media and in its totals, while its author and whoever edits others'
 * `post`-family entries keep them. MUTATION PROOF: put `capsForType(t) || capsFor('post')` back in place
 * of readPolicyForType in canReadPostRecord and every anonymous assertion below fails.
 */
describe('1a. an attachment of an entry of an UNKNOWN type is not public on any media surface', () => {
    let T: string;
    let hiddenId: number;
    let controlId: number;

    before(async () => {
        T = word('unknownparent');
        const orphan = await entry('authorA', UNKNOWN_TYPE, 'publish');
        assert.strictEqual(require('../core/post-types').getPostType(UNKNOWN_TYPE), null, 'precondition: the type is not registered');
        hiddenId = await attachment('authorB', { title: `${T}hidden`, parent: orphan });
        const control = await entry('authorA', 'post', 'publish');
        controlId = await attachment('authorB', { title: `${T}control`, parent: control });
    });

    for (const persona of [null, 'subscriber', 'contributor']) {
        test(`${persona || 'anonymous'}: GET /media/:id is 404 and the list and its totals leave it out`, async () => {
            assert.strictEqual((await call(persona, 'get', `/media/${hiddenId}`)).status, 404, 'GET /media/:id served it');
            assert.strictEqual((await call(persona, 'get', `/media/${controlId}`)).status, 200, 'control: the public post\'s attachment');
            for (const page of [1, 2]) {
                const r = await listTotals(persona, `/media?search=${T}&per_page=1&page=${page}`);
                assert.strictEqual(r.total, '1', `page ${page}: X-WP-Total counted it`);
                assert.strictEqual(r.pages, '1', `page ${page}: X-WP-TotalPages`);
                assert.deepStrictEqual(r.ids, page === 1 ? [controlId] : [], `page ${page}: rows`);
                assert.ok(!r.text.includes(`${T}hidden`), 'its title reached the list');
            }
            const prefix = await listTotals(persona, `/media?search=${T}hidden`);
            assert.strictEqual(prefix.total, '0', 'a title search counted it');
        });
    }

    test('its author and an editor (edit_others_posts) still see and count it', async () => {
        for (const persona of ['authorA', 'editor', 'admin']) {
            assert.strictEqual((await call(persona, 'get', `/media/${hiddenId}`)).status, 200, `${persona}: GET /media/:id`);
            const r = await listTotals(persona, `/media?search=${T}&per_page=100`);
            assert.strictEqual(r.total, '2', `${persona}: X-WP-Total`);
            assert.deepStrictEqual([...r.ids].sort((a, b) => a - b), [hiddenId, controlId].sort((a, b) => a - b), `${persona}: rows`);
        }
    });
});

describe('1b. the SQL condition IS the JS rule (cross-check on a matrix of real rows)', () => {
    let MT: string;
    const created: number[] = [];

    before(async () => {
        MT = word('matrix');
        const types = ['post', 'page', PRIVATE_TYPE, LEDGER_TYPE, 'nav_menu_item', UNKNOWN_TYPE, ''];
        for (const type of types) {
            for (const status of ['publish', 'draft', 'private']) {
                for (const password of ['', 'pw']) {
                    for (const owner of ['authorA', 'editor']) {
                        const parent = await entry(owner, type, status, password);
                        created.push(await attachment('authorB', { title: `${MT} p${parent}`, parent }));
                    }
                }
            }
        }
        // The attachment's own half: every status class × owner, unattached and dangling.
        for (const status of ['inherit', 'private', 'draft', 'publish', 'trash']) {
            for (const owner of ['authorA', 'editor', 'contributor']) {
                created.push(await attachment(owner, { title: `${MT} s${status}`, status }));
                created.push(await attachment(owner, { title: `${MT} d${status}`, status, parent: 987654321 }));
            }
        }
        // ...and an own private item under a ledger entry: both halves at once.
        const ledger = await entry('admin', LEDGER_TYPE, 'publish');
        created.push(await attachment('editor', { title: `${MT} mixed`, status: 'private', parent: ledger }));
    });

    async function compare(label: string) {
        const all = await Post.findAll({ type: 'attachment', status: null, search: MT, limit: 100000 });
        const universe = all.filter((p: any) => created.includes(p.id));
        assert.strictEqual(universe.length, created.length, 'every matrix row is searchable');
        const parents: Map<number, any> = await Post.findByIds(universe.map((p: any) => p.postParent));
        for (const persona of [null, 'subscriber', 'contributor', 'authorA', 'authorB', 'editor', 'admin']) {
            const user = persona ? await User.findById(U[persona]) : null;
            const expected = universe
                .filter((p: any) => canViewAttachment(user, p, p.postParent ? (parents.get(p.postParent) || null) : null))
                .map((p: any) => p.id).sort((a: number, b: number) => a - b);
            const rows = await Post.findAll({ type: 'attachment', status: null, search: MT, limit: 100000, attachmentViewer: { user } });
            const got = rows.map((p: any) => p.id).filter((id: number) => created.includes(id)).sort((a: number, b: number) => a - b);
            const who = `${label}/${persona || 'anonymous'}`;
            assert.deepStrictEqual(got, expected, `${who}: the query selects exactly what canViewAttachment allows`);
            assert.strictEqual(await Post.count({ type: 'attachment', status: null, search: MT, attachmentViewer: { user } }), expected.length, `${who}: count`);
            // Sanity: the comparison is not vacuous. (In the boot window every type is the `post` family, so
            // an editor legitimately sees the whole matrix there.)
            if (label === 'loaded' && persona !== 'admin') assert.ok(expected.length < universe.length, `${who}: the matrix hides something`);
            if (persona === null) assert.ok(expected.length > 0, `${who}: the matrix shows something`);
        }
    }

    test('registry loaded', async () => { await compare('loaded'); });

    test('a read-policy change in the predicates (unknown types not public) reaches the SQL untouched', async () => {
        // Simulates the fail-closed policy for types the registry does not know: every unregistered name
        // resolves to a non-public declaration. Nothing in the SQL builder knows about it — it re-derives.
        const postTypes = require('../core/post-types');
        const saved = postTypes.getContentTypeSchema;
        const closed = saved(PRIVATE_TYPE);
        postTypes.getContentTypeSchema = (name: string) => saved(name) || (postTypes.getPostType(name) ? null : closed);
        try {
            await compare('unknown-closed');
            const anonymous = await Post.findAll({ type: 'attachment', status: null, search: MT, limit: 100000, attachmentViewer: { user: null } });
            const parents: Map<number, any> = await Post.findByIds(anonymous.map((p: any) => p.postParent));
            assert.ok(!anonymous.some((p: any) => parents.get(p.postParent) && parents.get(p.postParent).postType === UNKNOWN_TYPE),
                'no attachment of an unknown-type entry reaches anonymous callers under that policy');
        } finally {
            postTypes.getContentTypeSchema = saved;
        }
    });

    test('boot window (the registry knows no type yet)', async () => {
        const postTypes = require('../core/post-types');
        const saved = { getPostType: postTypes.getPostType, getContentTypeSchema: postTypes.getContentTypeSchema };
        postTypes.getPostType = () => null;
        postTypes.getContentTypeSchema = () => null;
        try { await compare('boot'); } finally {
            postTypes.getPostType = saved.getPostType;
            postTypes.getContentTypeSchema = saved.getContentTypeSchema;
        }
    });
});

describe('2. GET /media/:id/file applies the parent rule to the BYTES', () => {
    const BYTES = `TOP-SECRET-LEDGER-BYTES-${STAMP}`;
    let id: number;
    let publicParentId: number;

    before(async () => {
        const ledger = await entry('admin', LEDGER_TYPE, 'publish');
        const rel = `ledger-${STAMP}/secret.png`;
        fs.mkdirSync(path.join(TMP_PRIVATE, `ledger-${STAMP}`), { recursive: true });
        fs.writeFileSync(path.join(TMP_PRIVATE, rel), BYTES);
        // The editor's OWN private upload, attached to an entry the editor may not read.
        id = await attachment('editor', { title: word('ledgerfile'), file: rel, status: 'private', parent: ledger });

        const rel2 = `public-parent-${STAMP}/ok.png`;
        fs.mkdirSync(path.join(TMP_PRIVATE, `public-parent-${STAMP}`), { recursive: true });
        fs.writeFileSync(path.join(TMP_PRIVATE, rel2), `OK-${BYTES}`);
        const pub = await entry('authorA', 'post', 'publish');
        publicParentId = await attachment('editor', { title: word('okfile'), file: rel2, status: 'private', parent: pub });
    });

    test('the editor gets 404 and not one byte, exactly as GET /media/:id', async () => {
        assert.strictEqual((await call('editor', 'get', `/media/${id}`)).status, 404, 'precondition: the metadata is hidden');
        const res = await call('editor', 'get', `/media/${id}/file`).buffer(true);
        assert.strictEqual(res.status, 404);
        assert.ok(!String(res.text || res.body).includes(BYTES), 'no bytes');
    });

    test('an administrator downloads it; the editor downloads their private file of a readable entry', async () => {
        const admin = await call('admin', 'get', `/media/${id}/file`).buffer(true).parse((r: any, cb: any) => {
            const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
        assert.strictEqual(admin.status, 200);
        assert.strictEqual(Buffer.from(admin.body).toString(), BYTES);
        const own = await call('editor', 'get', `/media/${publicParentId}/file`).buffer(true).parse((r: any, cb: any) => {
            const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
        assert.strictEqual(own.status, 200);
        assert.strictEqual(Buffer.from(own.body).toString(), `OK-${BYTES}`);
    });
});

describe('3. the generic /posts surface and every write follow the parent', () => {
    let attId: number;
    let slug: string;
    let token: string;
    const FILE = `ledger-${STAMP}/scan.png`;

    before(async () => {
        const ledger = await entry('admin', LEDGER_TYPE, 'publish');
        token = word('ledgerscan');
        attId = await attachment('authorB', { title: token, file: FILE, parent: ledger });
        slug = (await Post.findById(attId)).postName;
    });

    test('reads: the editor (edit_others_posts, not the ledger family) gets 404 on every read route', async () => {
        assert.strictEqual((await call('editor', 'get', `/media/${attId}`)).status, 404, 'precondition');
        // Every surface is asked before anything is asserted, so a regression names ALL the routes it reopens.
        const wrong: string[] = [];
        for (const p of [`/posts/${attId}`, `/posts/${attId}/meta`, `/posts/slug/${encodeURIComponent(slug)}?type=attachment`,
            `/posts/${attId}/translations`, `/revisions/post/${attId}`]) {
            const res = await call('editor', 'get', p);
            const leaks = JSON.stringify(res.body).includes(FILE) || JSON.stringify(res.body).includes(token);
            if (res.status !== 404 || leaks) wrong.push(`GET ${p} -> ${res.status}${leaks ? ' (leaks)' : ''}`);
        }
        const list = await listTotals('editor', `/posts?type=attachment&status=inherit&search=${token}`);
        if (list.ids.length || list.total !== '0') wrong.push(`GET /posts?type=attachment -> ${list.ids.length} rows, X-WP-Total ${list.total}`);
        assert.deepStrictEqual(wrong, []);
    });

    test('writes: the editor can neither edit nor delete it, through /media or /posts, and nothing changes', async () => {
        const attempts: Array<[string, string, any, number]> = [
            ['put', `/media/${attId}`, { title: 'pwned' }, 404],
            ['put', `/media/${attId}`, { visibility: 'private' }, 404],
            ['put', `/posts/${attId}`, { title: 'pwned' }, 404],
            ['post', `/posts/${attId}/meta`, { key: 'alt_note', value: 'pwned' }, 404],
            ['put', `/posts/${attId}/language`, { language: 'fr' }, 404],
            ['delete', `/posts/${attId}/translations`, undefined, 404],
            // Each surface answers what it answers for a MISSING post: presence 403 for both, the
            // collaboration channel 404 for both (attachment-read-surfaces.test.ts pins the equality).
            ['post', `/presence/${attId}`, {}, 403],
            ['post', `/collab/${attId}/presence`, { siteId: 'x', sel: {} }, 404],
            // The two deletes last, so a regression of one still lets the others be observed.
            ['delete', `/posts/${attId}?force=true`, undefined, 404],
            ['delete', `/media/${attId}`, undefined, 404],
        ];
        const wrong: string[] = [];
        for (const [m, p, body, expected] of attempts) {
            const req = call('editor', m, p);
            const res = body === undefined ? await req : await req.send(body);
            if (res.status !== expected) wrong.push(`${m.toUpperCase()} ${p} -> ${res.status} (want ${expected})`);
        }
        assert.deepStrictEqual(wrong, []);

        const row = await dbAsync.get('SELECT post_title, post_status, post_language FROM posts WHERE id = ?', [attId]);
        assert.ok(row, 'the row still exists');
        assert.strictEqual(row.post_title, token, 'the title is unchanged');
        assert.strictEqual(row.post_status, 'inherit', 'neither made private nor trashed');
        assert.ok(!row.post_language, 'no language set');
        assert.ok(!(await Post.getMeta(attId, 'alt_note')), 'no meta written');
    });

    test('an administrator still reads and edits it on both surfaces', async () => {
        const read = await call('admin', 'get', `/posts/${attId}/meta`);
        assert.strictEqual(read.status, 200);
        assert.strictEqual(read.body._wp_attached_file, FILE);
        assert.strictEqual((await call('admin', 'put', `/media/${attId}`).send({ alt: 'scan' })).status, 200);
    });

    test('visible but its entry not editable: 403, unchanged; its own entry: 200', async () => {
        // authorA's upload hanging off authorB's PUBLISHED public post: authorA sees it, may not edit B's post.
        const bPost = await entry('authorB', 'post', 'publish');
        const id = await attachment('authorA', { title: word('onbpost'), parent: bPost });
        assert.strictEqual((await call('authorA', 'get', `/media/${id}`)).status, 200, 'precondition: visible');
        const wrong: string[] = [];
        for (const [m, p, body] of [['put', `/media/${id}`, { title: 'changed' }], ['put', `/posts/${id}`, { title: 'changed' }], ['delete', `/media/${id}`, undefined]] as Array<[string, string, any]>) {
            const req = call('authorA', m, p);
            const res = body === undefined ? await req : await req.send(body);
            if (res.status !== 403) wrong.push(`${m.toUpperCase()} ${p} -> ${res.status}`);
        }
        assert.deepStrictEqual(wrong, []);
        const row = await dbAsync.get('SELECT post_title FROM posts WHERE id = ?', [id]);
        assert.ok(row && row.post_title.startsWith('onbpost'), 'unchanged and not deleted');

        const aPost = await entry('authorA', 'post', 'publish');
        const own = await attachment('authorA', { title: word('onapost'), parent: aPost });
        const res = await call('authorA', 'put', `/media/${own}`).send({ title: 'renamed' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.title, 'renamed');
    });
});

describe('4. a password-protected entry\'s featured image is withheld whatever it names', () => {
    let id: number;
    let slug: string;
    let imageId: number;
    const FILE = `cover-${STAMP}/members.png`;

    before(async () => {
        imageId = await attachment('authorA', { title: word('libraryimage'), file: FILE }); // UNATTACHED
        const row = await Post.create({ authorId: U.authorA, title: word('membersonly'), type: 'post', status: 'publish', password: 'open-sesame' });
        id = row.id;
        slug = row.postName;
        await Post.updateMeta(id, '_thumbnail_id', String(imageId));
    });

    test('anonymous and a reader who does not manage it: no featuredMedia, no _thumbnail_id, on every read', async () => {
        const wrong: string[] = [];
        for (const persona of [null, 'authorB']) {
            const who = persona || 'anonymous';
            const single = await call(persona, 'get', `/posts/${id}`);
            const bySlug = await call(persona, 'get', `/posts/slug/${encodeURIComponent(slug)}`);
            const list = await call(persona, 'get', '/posts?per_page=100');
            const meta = await call(persona, 'get', `/posts/${id}/meta`);
            const inList = (list.body as any[]).find((p) => p.id === id);
            assert.ok(inList, 'the entry itself stays listed');
            assert.strictEqual(meta.status, 200);
            for (const [label, body] of [['single', single.body], ['slug', bySlug.body], ['list', inList]] as Array<[string, any]>) {
                if (body.featuredMedia !== undefined) wrong.push(`${who} ${label}: featuredMedia`);
                if ('_thumbnail_id' in body.meta) wrong.push(`${who} ${label}: meta._thumbnail_id`);
                if (JSON.stringify(body).includes(FILE)) wrong.push(`${who} ${label}: the file path`);
            }
            if ('_thumbnail_id' in meta.body) wrong.push(`${who} GET /posts/:id/meta: _thumbnail_id`);
        }
        assert.deepStrictEqual(wrong, []);
    });

    test('its author and an editor (who manage it) still get both', async () => {
        for (const persona of ['authorA', 'editor']) {
            const single = await call(persona, 'get', `/posts/${id}`);
            assert.strictEqual(single.body.featuredMedia && single.body.featuredMedia.path, `/uploads/${FILE}`, persona);
            assert.strictEqual(String(single.body.meta._thumbnail_id), String(imageId));
            const meta = await call(persona, 'get', `/posts/${id}/meta`);
            assert.strictEqual(String(meta.body._thumbnail_id), String(imageId));
        }
    });

    test('unchanged: the same image on an unprotected post is projected to anonymous readers', async () => {
        const open = await Post.create({ authorId: U.authorA, title: word('opencover'), type: 'post', status: 'publish' });
        await Post.updateMeta(open.id, '_thumbnail_id', String(imageId));
        const res = await call(null, 'get', `/posts/${open.id}`);
        assert.strictEqual(res.body.featuredMedia && res.body.featuredMedia.path, `/uploads/${FILE}`);
    });
});

describe('5. the parents of a media page are resolved with ONE query', () => {
    test('GET /media with ten attachments of ten different entries: no Post.findById, one IN query', async () => {
        const T = word('pageparents');
        for (let i = 0; i < 10; i++) {
            const parent = await entry('authorA', 'post', 'publish');
            await attachment('authorA', { title: `${T} ${i}`, parent });
        }
        const realDb = database.getDbAsync();
        const originalAll = realDb.all;
        const originalFindById = Post.findById;
        let findByIdCalls = 0;
        const inQueries: string[] = [];
        Post.findById = async (...args: any[]) => { findByIdCalls++; return originalFindById.apply(Post, args); };
        realDb.all = async (sql: string, ...rest: any[]) => {
            if (/FROM posts WHERE id IN/i.test(String(sql))) inQueries.push(String(sql));
            return originalAll.call(realDb, sql, ...rest);
        };
        try {
            const r = await listTotals(null, `/media?search=${T}&per_page=100`);
            assert.strictEqual(r.ids.length, 10);
            assert.strictEqual(r.total, '10');
        } finally {
            Post.findById = originalFindById;
            realDb.all = originalAll;
        }
        assert.strictEqual(findByIdCalls, 0, 'no per-parent Post.findById');
        assert.strictEqual(inQueries.length, 1, 'one query for every parent of the page');
    });
});
