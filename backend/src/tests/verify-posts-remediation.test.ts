/**
 * ADVERSARIAL VERIFICATION OF THE POSTS REMEDIATION (2026-08)
 *
 * The first remediation closed findings #1/#7/#8/#9/#14/#15 and a verification pass then attacked THAT
 * code and found the fixes leaking around their own guards. Every test here fails against the
 * remediated-but-unverified code, and each one pins a *mechanism*, not a symptom:
 *
 *   · TYPE CONFUSION AT THE GUARD. `isProtectedPostMeta`, `sanitizeMetaValue` and `isRevisionableMeta`
 *     all compare strings; better-sqlite3/mysql2 FLATTEN a one-element array parameter, so
 *     `{"key":["_wp_attached_file"]}` was "not protected" to all three and the exact string
 *     `_wp_attached_file` to the sink.
 *   · THE GUARD PARSED A DIFFERENT VALUE THAN THE SINK STORED. `parseInt("0.000007e6")` is 0 (so the
 *     parent was never authorized) while SQLite's INTEGER affinity reads 7 (so it was stored anyway).
 *   · THE GUARD NORMALIZED AND THE SINK DID NOT. `isRestExposedPostType('')` normalizes to 'post' and
 *     passes; `Post.findAllWithRelations({type: ''})` drops the type filter entirely, so
 *     `GET /posts?type=` listed every nav_menu_item to an anonymous caller.
 *   · ONE SURFACE FIXED, ITS TWIN LEFT OPEN. Three multilingual routes kept the two-part edit gate; the
 *     WXR importer kept its own two-key subset of the protected-meta list and its own nav_menu_item-only
 *     type filter.
 *   · THE FIX ITSELF BROKE SOMETHING. Unregistering a custom post type made its content unreachable for
 *     everyone including the admin; the published-post rule made the editorial review thread
 *     unwritable; an empty revision snapshot made a restore a visible no-op.
 *
 * Same config-repoint-first pattern as audit-posts-media-revisions.test.ts: point config.dbPath at a
 * temp file BEFORE the DB layer resolves it.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_DB = path.join(os.tmpdir(), `wjs-verify-posts-${STAMP}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const roles = require('../core/roles');
const Post = require('../models/Post');
const postTypes = require('../core/post-types');
const { saveRevision, getRevisions, restoreRevision } = require('../core/revisions');
const { isProtectedPostMeta } = require('../core/protected-meta');

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
let _seq = 0;

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
    return r.lastID;
}

async function seedPost(authorId: number, status: string, type = 'post') {
    _seq++;
    const r = await dbAsync.run(
        `INSERT INTO posts (author_id, post_title, post_content, post_status, post_type, post_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [authorId, `V${_seq}`, `body ${_seq}`, status, type, `verify-posts-${_seq}`]);
    return r.lastID;
}

async function seedMenuItem(url: string) {
    _seq++;
    const r = await dbAsync.run(
        `INSERT INTO posts (author_id, post_title, post_status, post_type, post_name, menu_order)
         VALUES (0, ?, 'publish', 'nav_menu_item', ?, 1)`,
        [`Item ${_seq}`, `verify-posts-item-${_seq}`]);
    await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [r.lastID, '_menu_item_url', url]);
    return r.lastID;
}

async function seedAttachment(authorId: number, attachedFile: string) {
    _seq++;
    const r = await dbAsync.run(
        `INSERT INTO posts (author_id, post_title, post_status, post_type, post_name, post_mime_type, guid)
         VALUES (?, ?, 'inherit', 'attachment', ?, 'image/png', ?)`,
        [authorId, `att ${_seq}`, `verify-posts-att-${_seq}`, `/uploads/${attachedFile}`]);
    await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
        [r.lastID, '_wp_attached_file', attachedFile]);
    return r.lastID;
}

const rawMeta = async (postId: number, key: string): Promise<string | null> => {
    const row = await dbAsync.get('SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = ?', [postId, key]);
    return row ? row.meta_value : null;
};
const parentOf = async (postId: number) => (await dbAsync.get('SELECT post_parent FROM posts WHERE id = ?', [postId])).post_parent;

/**
 * The EXPONENT/AFFINITY payload, built for an arbitrary target id.
 *
 * `0.<digits>e<len>` is 0 to parseInt (which stops at the '.') and exactly <digits> to SQLite's INTEGER
 * affinity — e.g. id 7 → '0.7e1', id 42 → '0.42e2'. This is the string that turned a 403 into a 201.
 */
const affinityPayload = (id: number) => `0.${id}e${String(id).length}`;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();

    await postTypes.initPostTypes();
    await roles.loadRoles();

    await seedUser('admin', 'administrator');
    await seedUser('editor', 'editor');
    await seedUser('authorA', 'author');
    await seedUser('authorB', 'author');
    await seedUser('contributor', 'contributor');
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* */ }
    }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A NON-STRING meta key defeats every string guard on the way to a driver that stringifies it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('POST /posts/:id/meta refuses a non-string key (type confusion)', () => {
    test('an ARRAY key reaches the protected row as a string — it must be a 400, not a 200', async () => {
        const attId = await seedAttachment(U.authorA, '2026/08/victim.png');

        // Control: the string form is already refused.
        const asString = await as('authorA', 'post', `/posts/${attId}/meta`)
            .send({ key: '_wp_attached_file', value: '../data/wordjs.db' });
        assert.strictEqual(asString.status, 403, 'precondition: the string key is refused');

        const res = await as('authorA', 'post', `/posts/${attId}/meta`)
            .send({ key: ['_wp_attached_file'], value: '2026/08/other-users-file.png' });

        assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
        assert.strictEqual(await rawMeta(attId, '_wp_attached_file'), '2026/08/victim.png',
            'the array key was flattened by the driver and rewrote the protected row');
    });

    test('an ARRAY key also walks past sanitizeMetaValue and the revision snapshot', async () => {
        const draft = await seedPost(U.authorA, 'draft');

        const res = await as('authorA', 'post', `/posts/${draft}/meta`).send({
            key: ['_puck_data'],
            value: { content: [{ type: 'Text', props: { text: '<img src=x onerror=alert(1)>' } }], root: { props: {} } },
        });

        assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
        assert.strictEqual(await rawMeta(draft, '_puck_data'), null,
            'an UNSANITIZED page tree was stored, and no revision was taken before it');
    });

    test('an object key and an empty key are refused too; a plain string still works', async () => {
        const draft = await seedPost(U.authorA, 'draft');
        assert.strictEqual((await as('authorA', 'post', `/posts/${draft}/meta`).send({ key: { a: 1 }, value: 'x' })).status, 400);
        assert.strictEqual((await as('authorA', 'post', `/posts/${draft}/meta`).send({ key: '', value: 'x' })).status, 400);
        assert.strictEqual((await as('authorA', 'post', `/posts/${draft}/meta`).send({ key: '_probe', value: 'ok' })).status, 200);
        assert.strictEqual(await rawMeta(draft, '_probe'), 'ok');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The protected-meta comparison must not be the DB's to make.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('core/protected-meta compares independently of the column collation', () => {
    test('case, accent and trailing-space variants are protected (utf8mb4_unicode_ci matches them)', () => {
        assert.strictEqual(isProtectedPostMeta('_wp_attached_file'), true);
        assert.strictEqual(isProtectedPostMeta('_WP_ATTACHED_FILE'), true, 'MySQL _ci matches this to the real row');
        assert.strictEqual(isProtectedPostMeta('_Wp_Attached_File'), true);
        assert.strictEqual(isProtectedPostMeta('_wp_attached_filé'), true, 'MySQL _ai matches an accented variant');
        assert.strictEqual(isProtectedPostMeta('_wp_attached_file '), true, 'MySQL PAD SPACE ignores the trailing space');
        assert.strictEqual(isProtectedPostMeta('_WP_TRASH_META_STATUS'), true);
    });

    test('REGRESSION GUARD: author-written keys stay writable', () => {
        for (const k of ['_puck_data', '_wjs_template', '_thumbnail_id', 'seo_title', '_wjs_review_comments', '_wp_attached_file_backup']) {
            assert.strictEqual(isProtectedPostMeta(k), false, `${k} must remain writable`);
        }
    });

    test('the route refuses the upper-case variant too', async () => {
        const attId = await seedAttachment(U.authorA, '2026/08/case.png');
        const res = await as('authorA', 'post', `/posts/${attId}/meta`)
            .send({ key: '_WP_ATTACHED_FILE', value: '../data/wordjs.db' });
        assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
        assert.strictEqual(await rawMeta(attId, '_wp_attached_file'), '2026/08/case.png');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// `parent` — the authorized value and the stored value must be the same number.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('POST/PUT /posts normalize `parent` ONCE and store what they authorized', () => {
    test('the affinity payload no longer skips the gate on create', async () => {
        const foreign = await seedPost(U.authorB, 'publish');

        // Control: the honest form is a 403.
        const control = await as('contributor', 'post', '/posts').send({ title: 'c', parent: foreign });
        assert.strictEqual(control.status, 403, 'precondition: the parent gate refuses this caller');

        const res = await as('contributor', 'post', '/posts').send({ title: 'exploit', parent: affinityPayload(foreign) });
        assert.notStrictEqual(res.status, 201, 'a 403 became a 201 — the gate parsed 0 and the column got the real id');
        assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);

        const grafted = await dbAsync.all('SELECT id FROM posts WHERE post_parent = ? AND post_type = ?', [foreign, 'post']);
        assert.strictEqual(grafted.length, 0, 'a post was grafted under a record the caller cannot edit');
    });

    test('the exponent payload no longer authorizes N and store N*1000', async () => {
        const mine = await seedPost(U.authorA, 'draft');
        const res = await as('authorA', 'post', '/posts').send({ title: 'exp', parent: `${mine}e3` });
        assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    });

    test('PUT /posts/:id is the twin surface and behaves identically', async () => {
        const foreign = await seedPost(U.authorB, 'publish');
        const own = await seedPost(U.authorA, 'draft');

        const res = await as('authorA', 'put', `/posts/${own}`).send({ parent: affinityPayload(foreign) });
        assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
        assert.strictEqual(await parentOf(own), 0, 'the post was re-parented under a record the caller cannot edit');
    });

    test('REGRESSION GUARD: parent "" is legal and stores the INTEGER 0 (STRICT_TRANS_TABLES)', async () => {
        const created = await as('authorA', 'post', '/posts').send({ title: 'no parent', parent: '', menu_order: '' });
        assert.strictEqual(created.status, 201, `expected 201, got ${created.status}`);
        const stored = await dbAsync.get('SELECT post_parent, menu_order FROM posts WHERE id = ?', [created.body.id]);
        assert.strictEqual(stored.post_parent, 0, "'' reached post_parent verbatim — MySQL raises ERROR 1366 on that");
        assert.strictEqual(typeof stored.post_parent, 'number');
        assert.strictEqual(stored.menu_order, 0);
        assert.strictEqual(typeof stored.menu_order, 'number');

        const updated = await as('authorA', 'put', `/posts/${created.body.id}`).send({ parent: '', menu_order: '' });
        assert.strictEqual(updated.status, 200, `expected 200, got ${updated.status}`);
        const after = await dbAsync.get('SELECT post_parent, menu_order FROM posts WHERE id = ?', [created.body.id]);
        assert.strictEqual(after.post_parent, 0);
        assert.strictEqual(after.menu_order, 0);
    });

    test('POSITIVE CONTROL: a real parent, sent as a number and as digits, still works', async () => {
        const mine = await seedPost(U.authorA, 'draft');
        const a = await as('authorA', 'post', '/posts').send({ title: 'num', parent: mine });
        assert.strictEqual(a.status, 201);
        assert.strictEqual(await parentOf(a.body.id), mine);

        const b = await as('authorA', 'post', '/posts').send({ title: 'str', parent: String(mine) });
        assert.strictEqual(b.status, 201);
        assert.strictEqual(await parentOf(b.body.id), mine);
    });

    test('an omitted parent leaves post_parent untouched on update', async () => {
        const mine = await seedPost(U.authorA, 'draft');
        const child = await as('authorA', 'post', '/posts').send({ title: 'child', parent: mine });
        assert.strictEqual(child.status, 201);
        const res = await as('authorA', 'put', `/posts/${child.body.id}`).send({ title: 'renamed' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await parentOf(child.body.id), mine, 'a title-only PUT reset the parent');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET /posts?type= — the guard normalized, the query did not.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('GET /posts resolves `type` ONCE', () => {
    test('an ANONYMOUS `?type=` (empty) must not enumerate nav_menu_item rows', async () => {
        const item = await seedMenuItem('https://legit.example/');

        const res = await anon('get', '/posts?type=');
        assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
        const types = new Set((res.body || []).map((p: any) => p.type));
        assert.ok(!types.has('nav_menu_item'), 'the empty type dropped the filter and listed the whole navigation');
        assert.ok(!(res.body || []).some((p: any) => p.id === item), 'the menu item id was disclosed');
    });

    test('an ARRAY type is a 400, not a value the model receives whole', async () => {
        const res = await anon('get', '/posts').query({ 'type[]': 'post' });
        assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    });

    test('POSITIVE CONTROLS: the default and an explicit type behave as before; internal stays 400', async () => {
        assert.strictEqual((await anon('get', '/posts')).status, 200);
        assert.strictEqual((await anon('get', '/posts?type=post')).status, 200);
        assert.strictEqual((await as('editor', 'get', '/posts?type=nav_menu_item&status=any')).status, 400);
    });

    test('the SLUG route is the twin and refuses an array type as well', async () => {
        const res = await anon('get', '/posts/slug/anything').query({ 'type[]': 'post' });
        assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The CREATE path has the same guard/sink pair, and had the same mismatch.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('POST /posts stores the type it validated', () => {
    test('type "" is validated as `post` — so it must be STORED as `post`, not as an empty column', async () => {
        const res = await as('admin', 'post', '/posts').send({ title: 'empty type', type: '' });
        assert.strictEqual(res.status, 201, `expected 201, got ${res.status}`);
        const row = await dbAsync.get('SELECT post_type FROM posts WHERE id = ?', [res.body.id]);
        assert.strictEqual(row.post_type, 'post',
            'an empty post_type row is invisible to every typed query — it can never be listed or migrated again');
    });

    test('an ARRAY type is refused instead of being flattened by the driver', async () => {
        const res = await as('admin', 'post', '/posts').send({ title: 'array type', type: ['post'] });
        assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The shared gate must cover EVERY mutating route in the file, not five of eight.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the multilingual routes use the SAME three-part gate', () => {
    test("a contributor cannot move their editor-published post between language editions", async () => {
        const pub = await seedPost(U.contributor, 'publish');
        const other = await seedPost(U.contributor, 'publish');

        assert.strictEqual((await as('contributor', 'put', `/posts/${pub}`).send({ title: 'x' })).status, 403,
            'precondition: PUT already refuses this caller');

        const lang = await as('contributor', 'put', `/posts/${pub}/language`).send({ language: 'de-DE' });
        assert.strictEqual(lang.status, 403, `language: expected 403, got ${lang.status}`);
        const row = await dbAsync.get('SELECT post_language FROM posts WHERE id = ?', [pub]);
        assert.ok(!row.post_language, 'the published post changed language edition');

        const link = await as('contributor', 'post', `/posts/${pub}/translations`).send({ translationId: other });
        assert.strictEqual(link.status, 403, `link: expected 403, got ${link.status}`);

        const unlink = await as('contributor', 'delete', `/posts/${pub}/translations`);
        assert.strictEqual(unlink.status, 403, `unlink: expected 403, got ${unlink.status}`);
    });

    test('POSITIVE CONTROL: the same contributor still manages the language of their own DRAFT', async () => {
        const draft = await seedPost(U.contributor, 'draft');
        const res = await as('contributor', 'put', `/posts/${draft}/language`).send({ language: 'de-DE' });
        assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The published-post rule must not swallow the editorial review thread.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('NON-CONTENT meta keys keep the downgraded gate', () => {
    test('a contributor may answer the review thread on their own PUBLISHED entry', async () => {
        const pub = await seedPost(U.contributor, 'publish');

        const res = await as('contributor', 'post', `/posts/${pub}/meta`)
            .send({ key: '_wjs_review_comments', value: [{ c: 'fixed the typo' }] });
        assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
        assert.ok(await rawMeta(pub, '_wjs_review_comments'), 'the review thread write was rejected');
    });

    test('the allowlist does NOT leak to content keys on the same post', async () => {
        const pub = await seedPost(U.contributor, 'publish');
        await Post.updateMeta(pub, '_puck_data', { content: [], root: { props: { t: 'approved' } } });

        for (const key of ['_puck_data', '_wjs_template', '_thumbnail_id', 'seo_title']) {
            const res = await as('contributor', 'post', `/posts/${pub}/meta`).send({ key, value: 'HIJACKED' });
            assert.strictEqual(res.status, 403, `${key}: expected 403, got ${res.status}`);
        }
        assert.ok(String(await rawMeta(pub, '_puck_data')).includes('approved'));
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Unregistering a post type must not orphan its content.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('an UNREGISTERED type is not an INTERNAL type', () => {
    test('content of a removed custom type stays readable, editable, listable and deletable by an admin', async () => {
        postTypes.registerPostType('auditbook', { label: 'Books', public: true, showInRest: true });
        const created = await as('admin', 'post', '/posts').send({ title: 'A book', type: 'auditbook' });
        assert.strictEqual(created.status, 201, `precondition: expected 201, got ${created.status}`);
        const bookId = created.body.id;

        // One admin click: DELETE /types/auditbook.
        postTypes.unregisterPostType('auditbook');

        assert.strictEqual((await as('admin', 'get', `/posts/${bookId}`)).status, 200, 'orphaned content became unreadable');
        assert.strictEqual((await as('admin', 'put', `/posts/${bookId}`).send({ title: 'A book (migrated)' })).status, 200,
            'orphaned content became uneditable — it cannot even be migrated out');
        assert.strictEqual((await as('admin', 'get', '/posts?type=auditbook&status=any')).status, 200,
            'orphaned content became unlistable, so it cannot be found');
        assert.strictEqual((await as('admin', 'delete', `/posts/${bookId}?force=true`)).status, 200,
            'orphaned content became undeletable');
    });

    test('INTERNAL types stay refused even before initPostTypes has registered them', async () => {
        // ALWAYS_INTERNAL_POST_TYPES is the floor: unregister the registry entry and the answer must
        // not change, because initPostTypes() is async and requests are served before it resolves.
        postTypes.unregisterPostType('revision');
        try {
            const item = await seedMenuItem('https://example.com/about');
            assert.strictEqual((await as('editor', 'get', `/posts/${item}`)).status, 404,
                'nav_menu_item is hard-coded internal precisely so the registry race cannot open it');

            const mint = await as('contributor', 'post', '/posts').send({ title: 'forged', type: 'revision' });
            assert.strictEqual(mint.status, 400, `expected 400, got ${mint.status}`);
        } finally {
            await postTypes.initPostTypes();
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// One revision semantics for both write surfaces.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('PUT and the meta route snapshot at the SAME instant', () => {
    test('PUT /posts/:id captures the state it is about to destroy', async () => {
        const draft = await seedPost(U.editor, 'draft');
        await Post.update(draft, { title: 'BEFORE', content: 'before body' });
        await Post.updateMeta(draft, '_puck_data', { content: [], root: { props: { t: 'v1' } } });

        const res = await as('editor', 'put', `/posts/${draft}`)
            .send({ title: 'AFTER', content: 'after body', meta: { _puck_data: { content: [], root: { props: { t: 'v2' } } } } });
        assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);

        const revs = await getRevisions(draft, { limit: 5 });
        assert.ok(revs.length > 0, 'the explicit save left no revision at all');
        assert.strictEqual(revs[0].title, 'BEFORE',
            'the snapshot holds the post-write state — the meta route holds the pre-write one, so a revision means two things');
        assert.ok(String(await rawMeta(revs[0].id, '_puck_data')).includes('"v1"'),
            'the snapshot must carry the meta being replaced');
    });

    test('BOTH surfaces fail CLOSED: no recovery point, no destructive write', async () => {
        const draft = await seedPost(U.editor, 'draft');
        await Post.update(draft, { title: 'KEEP', content: 'keep body' });
        await Post.updateMeta(draft, '_puck_data', { content: [], root: { props: { t: 'keep' } } });

        // core/revisions destructures the SAME dbAsync object, so patching .run is what its
        // saveRevision will call. Only the revision INSERT is failed.
        const realRun = dbAsync.run.bind(dbAsync);
        let blocked = 0;
        dbAsync.run = async (sql: string, params: any) => {
            if (/INSERT INTO posts/i.test(sql)) { blocked++; throw new Error('boom: revision insert failed'); }
            return await realRun(sql, params);
        };
        try {
            const put = await as('editor', 'put', `/posts/${draft}`).send({ title: 'DESTROYED', content: 'gone' });
            assert.strictEqual(put.status, 500, `PUT: expected 500, got ${put.status}`);

            const meta = await as('editor', 'post', `/posts/${draft}/meta`)
                .send({ key: '_puck_data', value: { content: [], root: { props: { t: 'gone' } } } });
            assert.strictEqual(meta.status, 500, `meta: expected 500, got ${meta.status}`);
        } finally {
            dbAsync.run = realRun;
        }

        assert.ok(blocked > 0, 'the fault injection must actually have fired');
        const row = await dbAsync.get('SELECT post_title, post_content FROM posts WHERE id = ?', [draft]);
        assert.strictEqual(row.post_title, 'KEEP', 'the write happened with no recovery point behind it');
        assert.strictEqual(row.post_content, 'keep body');
        assert.ok(String(await rawMeta(draft, '_puck_data')).includes('keep'), 'the page tree was destroyed unrecoverably');
    });

    test('an autosave still skips the snapshot', async () => {
        const draft = await seedPost(U.editor, 'draft');
        const res = await as('editor', 'put', `/posts/${draft}`).send({ title: 'auto', autosave: true });
        assert.strictEqual(res.status, 200);
        assert.strictEqual((await getRevisions(draft, { limit: 5 })).length, 0, 'autosaves must not churn the revision cap');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A restore must be exact even when the snapshot has no versioned meta at all.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('restoreRevision clears versioned meta a snapshot does not carry', () => {
    test('an EMPTY snapshot really rolls _puck_data back to absent (it was a silent no-op)', async () => {
        const legacy = await seedPost(U.editor, 'publish');
        await Post.update(legacy, { title: 'CLASSIC', content: '<p>classic body</p>' });

        const revId = await saveRevision(legacy);
        assert.ok(revId, 'precondition: the snapshot exists');
        const snapRows = await dbAsync.get('SELECT COUNT(*) AS c FROM post_meta WHERE post_id = ?', [revId]);
        assert.strictEqual(snapRows.c, 0, 'precondition: this snapshot captured NO versioned meta');

        // The author opens Verso and saves: a page tree now exists where the revision has none.
        await Post.updateMeta(legacy, '_puck_data', { content: [{ type: 'X' }], root: { props: {} } });

        assert.strictEqual(await restoreRevision(revId), true);

        assert.strictEqual(await rawMeta(legacy, '_puck_data'), null,
            'PostContent renders _puck_data over the classic body, so leaving it makes the restore invisible');
        const row = await dbAsync.get('SELECT post_content FROM posts WHERE id = ?', [legacy]);
        assert.strictEqual(row.post_content, '<p>classic body</p>');
    });

    test('REGRESSION GUARD: the delete stays SCOPED — unversioned meta survives', async () => {
        const p = await seedPost(U.editor, 'draft');
        const revId = await saveRevision(p);
        await Post.updateMeta(p, '_wjs_review_comments', [{ c: 'keep me' }]);
        await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [p, '_wp_trash_meta_status', 'publish']);

        assert.strictEqual(await restoreRevision(revId), true);

        assert.ok(await rawMeta(p, '_wjs_review_comments'), 'the empty-snapshot delete reached beyond the versioned set');
        assert.strictEqual(await rawMeta(p, '_wp_trash_meta_status'), 'publish');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The WXR importer is the OTHER door into `posts` and `post_meta`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the WXR importer honours the same two invariants as the routes', () => {
    const wxrItem = (opts: { title: string; slug: string; type: string; status: string; meta?: Record<string, string> }) => {
        const meta = Object.entries(opts.meta || {}).map(([k, v]) => `
    <wp:postmeta>
      <wp:meta_key><![CDATA[${k}]]></wp:meta_key>
      <wp:meta_value><![CDATA[${v}]]></wp:meta_value>
    </wp:postmeta>`).join('');
        return `
  <item>
    <title>${opts.title}</title>
    <wp:post_id>${++_seq + 9000}</wp:post_id>
    <wp:post_name>${opts.slug}</wp:post_name>
    <wp:post_type>${opts.type}</wp:post_type>
    <wp:status>${opts.status}</wp:status>
    <content:encoded><![CDATA[<p>body</p>]]></content:encoded>${meta}
  </item>`;
    };

    test('post_type=revision from the XML is skipped, and protected meta is never written', async () => {
        const { importWxr } = require('../core/wxr-import');
        const victim = await seedPost(U.editor, 'publish');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/">
<channel>
  <title>Hostile</title>
  <link>https://hostile.example</link>${wxrItem({ title: 'Forged history', slug: 'forged-history', type: 'revision', status: 'inherit' })}${wxrItem({
            title: 'Ordinary post', slug: 'verify-wxr-ordinary', type: 'post', status: 'publish',
            meta: {
                _wp_attached_file: '../../data/wordjs.db',
                _wp_trash_meta_status: 'publish',
                _edit_lock: '123:1',
                _wjs_template: 'landing',
            },
        })}
</channel>
</rss>`;

        await importWxr(xml, { defaultAuthorId: U.admin, importComments: false });

        const forged = await dbAsync.all(`SELECT id FROM posts WHERE post_type = 'revision' AND post_name = 'forged-history'`);
        assert.strictEqual(forged.length, 0, 'a `revision` row was created straight from a third party XML file');

        const ordinary = await dbAsync.get(`SELECT id FROM posts WHERE post_name = 'verify-wxr-ordinary'`);
        assert.ok(ordinary, 'precondition: the ordinary item DID import');
        assert.strictEqual(await rawMeta(ordinary.id, '_wp_attached_file'), null,
            'the importer wrote the key Media.delete() turns into an unlink target');
        assert.strictEqual(await rawMeta(ordinary.id, '_wp_trash_meta_status'), null);
        assert.strictEqual(await rawMeta(ordinary.id, '_edit_lock'), null);
        // REGRESSION GUARD: author content still travels.
        assert.strictEqual(await rawMeta(ordinary.id, '_wjs_template'), 'landing');

        // And nothing got grafted onto the real post.
        const children = await dbAsync.all(`SELECT id FROM posts WHERE post_parent = ? AND post_type = 'revision'`, [victim]);
        assert.strictEqual(children.length, 0);
    });

    test('the exporter drops exactly what the importer refuses (no drift between the two ends)', () => {
        const { PROTECTED_POST_META } = require('../core/protected-meta');
        const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'import-export.ts'), 'utf8');
        assert.ok(src.includes('new Set(PROTECTED_POST_META)'),
            'NON_PORTABLE_META must DERIVE from the protected list, not restate a subset of it');
        assert.ok(PROTECTED_POST_META.has('_wp_attached_file'));
    });
});
