/**
 * AUDIT 2026-08 — POSTS / MEDIA / REVISIONS REMEDIATION SUITE (findings 1, 7, 8, 9, 14, 15)
 *
 * Every one of these defects survived a green suite, so the rule here is: exercise the REAL producer.
 * The HTTP assertions drive the actual routers (require('../routes')) through supertest with real JWTs
 * and real roles; the file-deletion assertions call the real Media.delete() against a real temp uploads
 * directory with real files on disk; the revision assertions go through the real POST
 * /revisions/:id/restore. Nothing here hand-builds the object under test.
 *
 * What is pinned, per finding:
 *   #1  arbitrary file delete — `_wp_attached_file` is post_meta, and Media.delete() joined it onto the
 *       uploads dir. Two layers: the SINK refuses to unlink outside uploads (fail-closed, and the size
 *       loop no longer inherits the main file's escape), and the SOURCE — both generic meta writers —
 *       refuses the key at all.
 *   #7  POST /posts/:id/meta enforced type+ownership but NOT edit_published_<type>s, so a contributor
 *       could replace the `_puck_data` of their own already-published page. Also: that write now leaves
 *       a revision behind.
 *   #8  a nav_menu_item is a `posts` row; the generic /posts routes let an editor rewrite its meta.
 *   #9  the generic create accepted the INTERNAL `revision` type, and `parent` was never authorized.
 *   #14 restoreRevision wrote raw SQL and never invalidated the cache or fired post_updated, so the
 *       row came back stale while the meta came back fresh — an INCOHERENT post, not merely an old one.
 *   #15 restoreRevision ran `DELETE FROM post_meta WHERE post_id = ?` and wiped every key added after
 *       the snapshot; and it round-tripped values through JSON.parse/String, which is lossy.
 *
 * Same config-repoint-first pattern as api.test.ts / authz-idor.test.ts: point config.dbPath AND
 * config.uploads.dir at temp locations BEFORE the DB layer and the media router resolve them.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_DB = path.join(os.tmpdir(), `wjs-audit-pmr-${STAMP}.db`);
// The sandbox the uploads live in, and a sibling directory that stands in for "the rest of the disk"
// (in the real exploit: backend/data/wordjs.db, wordjs-config.json, backend/dist/…).
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-audit-pmr-${STAMP}-`));
const TMP_UPLOADS = path.join(TMP_ROOT, 'uploads');
const OUTSIDE_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(TMP_UPLOADS, { recursive: true });
fs.mkdirSync(OUTSIDE_DIR, { recursive: true });

config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
config.uploads.dir = TMP_UPLOADS;

const database = require('../config/database');
const roles = require('../core/roles');
const Post = require('../models/Post');
const Media = require('../models/Media');
const { saveRevision, getRevisions, countRevisions } = require('../core/revisions');
const { addAction, removeAction } = require('../core/hooks');

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
        [authorId, `T${_seq}`, `body ${_seq}`, status, type, `audit-pmr-${_seq}`]);
    return r.lastID;
}

/** A menu item exactly as models/Menu.ts writes one: author_id 0, internal type, meta-carried URL. */
async function seedMenuItem(url: string) {
    _seq++;
    const r = await dbAsync.run(
        `INSERT INTO posts (author_id, post_title, post_status, post_type, post_name, menu_order)
         VALUES (0, ?, 'publish', 'nav_menu_item', ?, 1)`,
        [`Item ${_seq}`, `audit-pmr-item-${_seq}`]);
    await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [r.lastID, '_menu_item_url', url]);
    return r.lastID;
}

/**
 * An attachment row + the two meta keys Media.formatAttachment reads. `attachedFile` goes into
 * `_wp_attached_file` verbatim — this is the attacker-controlled value in finding #1.
 */
async function seedAttachment(authorId: number, attachedFile: string, sizes: Record<string, any> = {}) {
    _seq++;
    const r = await dbAsync.run(
        `INSERT INTO posts (author_id, post_title, post_status, post_type, post_name, post_mime_type, guid)
         VALUES (?, ?, 'inherit', 'attachment', ?, 'image/png', ?)`,
        [authorId, `att ${_seq}`, `audit-pmr-att-${_seq}`, `/uploads/${attachedFile}`]);
    await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
        [r.lastID, '_wp_attached_file', attachedFile]);
    await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
        [r.lastID, '_wp_attachment_metadata', JSON.stringify({ file: attachedFile, width: 1, height: 1, filesize: 1, sizes })]);
    return r.lastID;
}

/** Read a meta value EXACTLY as stored — no JSON.parse — so a lossy round trip cannot hide. */
const rawMeta = async (postId: number, key: string): Promise<string | null> => {
    const row = await dbAsync.get('SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = ?', [postId, key]);
    return row ? row.meta_value : null;
};

const touch = (p: string, body = 'canary') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();

    // The registry is what decides showInRest, and the whole of finding #8/#9 lives on that flag —
    // without initPostTypes() getPostType('nav_menu_item') is null and the test would pass for the
    // WRONG reason (unregistered, not internal).
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();

    await seedUser('admin', 'administrator');
    await seedUser('editor', 'editor');
    await seedUser('authorA', 'author');
    await seedUser('authorB', 'author');
    // contributor: edit_posts + delete_posts, but NO edit_published_posts and NO edit_others_posts —
    // the only persona for whom the publish half of the gate is the sole barrier.
    await seedUser('contributor', 'contributor');
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* */ }
    }
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// #1 — layer 1: the SINK. Media.delete() must not unlink outside the uploads directory.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('#1 Media.delete containment (core/safe-path)', () => {
    test('POSITIVE CONTROL: a legitimate attachment still deletes its file AND every size', async () => {
        const main = path.join(TMP_UPLOADS, '2026', '08', 'ok.png');
        const thumb = path.join(TMP_UPLOADS, '2026', '08', 'ok-150x150.png');
        touch(main); touch(thumb);

        const id = await seedAttachment(U.authorA, '2026/08/ok.png', {
            thumbnail: { file: 'ok-150x150.png', width: 150, height: 150 }
        });

        assert.strictEqual(await Media.delete(id, true), true);
        assert.strictEqual(fs.existsSync(main), false, 'the main file must be deleted');
        assert.strictEqual(fs.existsSync(thumb), false, 'the size file must be deleted');
    });

    test('an escaping _wp_attached_file deletes NOTHING (fail-closed), and the row still goes', async () => {
        // The audit payload, adapted to this sandbox: one '..' out of uploads/ into a sibling dir.
        const victim = path.join(OUTSIDE_DIR, 'wordjs.db');
        touch(victim, 'the database');

        const id = await seedAttachment(U.authorA, '../data/wordjs.db');
        assert.strictEqual(await Media.delete(id, true), true);

        assert.strictEqual(fs.existsSync(victim), true, 'ARBITRARY FILE DELETE: a file outside uploads/ was unlinked');
        assert.strictEqual(await Post.findById(id), null, 'the attachment row must still be removed (no undeletable rows)');
    });

    test('a size file cannot inherit the main file\'s escape, nor escape on its own', async () => {
        const victimA = path.join(OUTSIDE_DIR, 'privkey.pem');
        const victimB = path.join(OUTSIDE_DIR, 'wordjs-config.json');
        touch(victimA); touch(victimB);
        const main = path.join(TMP_UPLOADS, '2026', '08', 'sizes.png');
        touch(main);

        // (a) main escapes → the old loop re-based EVERY size on dirname(escapedMain): N deletions.
        const idA = await seedAttachment(U.authorA, '../data/privkey.pem', {
            thumbnail: { file: 'wordjs-config.json' }
        });
        await Media.delete(idA, true);
        assert.strictEqual(fs.existsSync(victimA), true, 'main path escaped containment');
        assert.strictEqual(fs.existsSync(victimB), true, 'a size inherited the main path escape');

        // (b) main is legitimate but ONE size escapes → that size is dropped, the main file still goes.
        const idB = await seedAttachment(U.authorA, '2026/08/sizes.png', {
            thumbnail: { file: '../../data/wordjs-config.json' }
        });
        await Media.delete(idB, true);
        assert.strictEqual(fs.existsSync(victimB), true, 'a size path escaped containment');
        assert.strictEqual(fs.existsSync(main), false, 'the legitimate main file must still be deleted');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// #1 — layer 2: the SOURCE. Neither generic meta writer may set a server-owned key.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('#1 protected post meta is refused by BOTH generic write surfaces', () => {
    test('POST /posts/:id/meta with _wp_attached_file → 403 and the stored path is unchanged', async () => {
        const attId = await seedAttachment(U.authorA, '2026/08/keepme.png');

        const res = await as('authorA', 'post', `/posts/${attId}/meta`)
            .send({ key: '_wp_attached_file', value: '../data/wordjs.db' });

        assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
        assert.strictEqual(res.body.code, 'rest_protected_meta');
        assert.strictEqual(await rawMeta(attId, '_wp_attached_file'), '2026/08/keepme.png');
    });

    test('the `meta` bag of PUT /posts/:id silently SKIPS the key (models/User.ts shape)', async () => {
        const attId = await seedAttachment(U.authorA, '2026/08/bagkeep.png');

        const res = await as('authorA', 'put', `/posts/${attId}`)
            .send({ meta: { _wp_attached_file: '../data/wordjs.db', _wp_attachment_metadata: { sizes: {} } } });

        assert.ok(res.status < 400, `the request itself is legitimate; got ${res.status}`);
        assert.strictEqual(await rawMeta(attId, '_wp_attached_file'), '2026/08/bagkeep.png',
            'the protected key was written through the meta bag');
    });

    test('the `meta` bag of POST /posts skips it too — and STILL writes author content', async () => {
        const res = await as('authorA', 'post', '/posts').send({
            title: 'bag create',
            meta: { _wp_attached_file: '../data/wordjs.db', _wjs_template: 'landing', _puck_data: { content: [], root: { props: {} } } }
        });
        assert.strictEqual(res.status, 201, `expected 201, got ${res.status}`);

        assert.strictEqual(await rawMeta(res.body.id, '_wp_attached_file'), null, 'the protected key was created');
        // REGRESSION GUARD: _wjs_template / _puck_data look internal but ARE author content — the editor
        // writes them through this exact bag on every save. Protecting them would break the page builder.
        assert.strictEqual(await rawMeta(res.body.id, '_wjs_template'), 'landing');
        assert.ok(await rawMeta(res.body.id, '_puck_data'), 'the page tree must still be writable');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// #7 — POST /posts/:id/meta must enforce edit_published_<type>s, and must snapshot.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('#7 POST /posts/:id/meta uses the SAME gate as PUT /posts/:id', () => {
    test('a contributor cannot rewrite _puck_data of their own PUBLISHED post (PUT says 403; meta must too)', async () => {
        const pub = await seedPost(U.contributor, 'publish');
        await Post.updateMeta(pub, '_puck_data', { content: [], root: { props: { t: 'approved' } } });

        // The control that proves the two surfaces disagreed: PUT already refused this exact caller.
        const put = await as('contributor', 'put', `/posts/${pub}`).send({ title: 'hijack' });
        assert.strictEqual(put.status, 403, 'precondition: PUT already refuses a contributor on a published post');

        const res = await as('contributor', 'post', `/posts/${pub}/meta`)
            .send({ key: '_puck_data', value: { content: [], root: { props: { t: 'HIJACKED' } } } });
        assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);

        const stored = JSON.parse((await rawMeta(pub, '_puck_data')) as string);
        assert.strictEqual(stored.root.props.t, 'approved', 'the published page body was replaced');
    });

    test('POSITIVE CONTROL: the same contributor may still write meta on their own DRAFT — and it leaves a revision', async () => {
        const draft = await seedPost(U.contributor, 'draft');
        await Post.updateMeta(draft, '_puck_data', { content: [], root: { props: { t: 'v1' } } });
        const before = await countRevisions(draft);

        const res = await as('contributor', 'post', `/posts/${draft}/meta`)
            .send({ key: '_puck_data', value: { content: [], root: { props: { t: 'v2' } } } });
        assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);

        assert.strictEqual(await countRevisions(draft), before + 1,
            'a content write through the meta route must leave a recovery point');
        // The snapshot must hold the PREVIOUS tree — a snapshot taken after the write recovers nothing.
        const revs = await getRevisions(draft, { limit: 5 });
        const snap = await rawMeta(revs[0].id, '_puck_data');
        assert.ok(String(snap).includes('"v1"'), 'the revision must capture the value being overwritten');
    });

    test('a NON-content key does not churn the revision history', async () => {
        const draft = await seedPost(U.contributor, 'draft');
        const before = await countRevisions(draft);
        const res = await as('contributor', 'post', `/posts/${draft}/meta`).send({ key: '_wjs_review_comments', value: [] });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await countRevisions(draft), before, 'only revisionable keys snapshot');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// #8 — internal post types are not addressable through the generic /posts routes.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('#8 the generic /posts surface refuses internal (showInRest:false) types', () => {
    test('an Editor gets 404 on POST /posts/<nav_menu_item>/meta, and the URL is untouched', async () => {
        const item = await seedMenuItem('https://example.com/about');

        const res = await as('editor', 'post', `/posts/${item}/meta`)
            .send({ key: '_menu_item_url', value: 'https://phishing.example/login' });

        assert.strictEqual(res.status, 404, `expected 404, got ${res.status}`);
        assert.strictEqual(await rawMeta(item, '_menu_item_url'), 'https://example.com/about',
            'site navigation was rewritten through the generic posts API');
    });

    test('read and delete of a menu item are 404 too, and the list rejects the type', async () => {
        const item = await seedMenuItem('https://example.com/contact');

        assert.strictEqual((await as('editor', 'get', `/posts/${item}`)).status, 404);
        assert.strictEqual((await as('editor', 'get', `/posts/${item}/meta`)).status, 404);
        assert.strictEqual((await as('editor', 'put', `/posts/${item}`).send({ title: 'x' })).status, 404);
        // ?force=true is what made the delete real rather than a trash move.
        assert.strictEqual((await as('editor', 'delete', `/posts/${item}?force=true`)).status, 404);
        assert.strictEqual((await as('editor', 'get', '/posts?type=nav_menu_item&status=any')).status, 400);

        assert.ok(await Post.findById(item), 'the menu item must still exist');
    });

    test('POSITIVE CONTROL: an ordinary post is unaffected by the type guard', async () => {
        const p = await seedPost(U.authorA, 'publish');
        assert.strictEqual((await as('editor', 'get', `/posts/${p}`)).status, 200);
        assert.strictEqual((await as('editor', 'get', '/posts?type=post')).status, 200);
        assert.strictEqual((await as('editor', 'post', `/posts/${p}/meta`).send({ key: '_probe', value: 'ok' })).status, 200);
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// #9 — creation must reject internal types, and must authorize `parent`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('#9 POST /posts rejects the internal `revision` type and an unauthorized parent', () => {
    test('a contributor cannot mint a `revision` row pointing at someone else\'s post', async () => {
        const victim = await seedPost(U.editor, 'publish');

        const res = await as('contributor', 'post', '/posts')
            .send({ title: 'forged history', content: 'x', type: 'revision', parent: victim });

        assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
        assert.strictEqual(res.body.code, 'rest_invalid_post_type');

        const rows = await dbAsync.all(`SELECT id FROM posts WHERE post_parent = ? AND post_type = 'revision'`, [victim]);
        assert.strictEqual(rows.length, 0, 'a forged revision row was created');
    });

    test('`parent` takes the parent\'s own edit gate on create AND on update', async () => {
        const foreign = await seedPost(U.authorB, 'publish');

        const created = await as('authorA', 'post', '/posts').send({ title: 'child', parent: foreign });
        assert.strictEqual(created.status, 403, `create: expected 403, got ${created.status}`);

        const own = await seedPost(U.authorA, 'draft');
        const updated = await as('authorA', 'put', `/posts/${own}`).send({ parent: foreign });
        assert.strictEqual(updated.status, 403, `update: expected 403, got ${updated.status}`);

        const row = await dbAsync.get('SELECT post_parent FROM posts WHERE id = ?', [own]);
        assert.strictEqual(row.post_parent, 0, 'the post was re-parented under a record the caller cannot edit');
    });

    test('POSITIVE CONTROL: a parent the caller CAN edit is accepted', async () => {
        const mine = await seedPost(U.authorA, 'draft');
        const res = await as('authorA', 'post', '/posts').send({ title: 'child ok', parent: mine });
        assert.strictEqual(res.status, 201, `expected 201, got ${res.status}`);
        assert.strictEqual(res.body.parent, mine);
    });

    test('a revision row that is not post_status=inherit is not history', async () => {
        const parent = await seedPost(U.editor, 'publish');
        _seq++;
        await dbAsync.run(
            `INSERT INTO posts (author_id, post_title, post_status, post_type, post_parent, post_name)
             VALUES (?, 'forged', 'draft', 'revision', ?, ?)`,
            [U.contributor, parent, `audit-pmr-forged-${_seq}`]);

        assert.strictEqual((await getRevisions(parent, { limit: 10 })).length, 0);
        assert.strictEqual(await countRevisions(parent), 0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// #14 + #15 — restoring a revision, through the REAL route.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('#14/#15 restoreRevision is a post write and a SCOPED meta restore', () => {
    test('restore invalidates the cache and fires post_updated; findById is already fresh', async () => {
        const postId = await seedPost(U.editor, 'publish');
        await Post.update(postId, { title: 'ORIGINAL', content: 'original body' });
        await Post.updateMeta(postId, '_puck_data', { content: [], root: { props: { t: 'original' } } });

        const revId = await saveRevision(postId);
        assert.ok(revId, 'precondition: the snapshot exists');

        await Post.update(postId, { title: 'EDITED', content: 'edited body' });
        await Post.updateMeta(postId, '_puck_data', { content: [], root: { props: { t: 'edited' } } });

        // Warm the row cache exactly the way the real request does (authorizeForPost → Post.findById).
        const warm = await Post.findById(postId);
        assert.strictEqual(warm.postTitle, 'EDITED');

        const fired: any[] = [];
        const listener = (id: any) => { fired.push(id); };
        addAction('post_updated', listener);

        try {
            const res = await as('editor', 'post', `/revisions/${revId}/restore`);
            assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);

            // #14: the response to the NEXT read must not mix a cached row with fresh meta.
            const fresh = await Post.findById(postId);
            assert.strictEqual(fresh.postTitle, 'ORIGINAL', 'Post.findById served the pre-restore row from cache');
            assert.strictEqual(fresh.postContent, 'original body');
            const json = await fresh.toJSON();
            assert.ok(String(JSON.stringify(json.meta)).includes('"original"'),
                'row and meta must describe the same version');

            assert.ok(fired.includes(postId), 'post_updated never fired — no revalidation, no webhook, no purge');
        } finally {
            removeAction('post_updated', listener);
        }
    });

    test('restore does NOT wipe meta the snapshot never captured, and is byte-faithful', async () => {
        const postId = await seedPost(U.editor, 'draft');
        await Post.updateMeta(postId, '_puck_data', { content: [], root: { props: { t: 'v1' } } });
        // A value whose TEXT differs from its JSON round trip: "1.50" → parse → 1.5 → String → "1.5".
        await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [postId, 'seo_title', '1.50']);

        const revId = await saveRevision(postId);

        // Written AFTER the snapshot — the editorial review thread, plugin meta, the trash-restore
        // status. The old restore deleted every one of them.
        await Post.updateMeta(postId, '_wjs_review_comments', [{ c: 'looks good' }]);
        await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [postId, '_wp_trash_meta_status', 'publish']);
        await Post.updateMeta(postId, '_puck_data', { content: [], root: { props: { t: 'v2' } } });

        const res = await as('editor', 'post', `/revisions/${revId}/restore`);
        assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);

        assert.ok(String(await rawMeta(postId, '_puck_data')).includes('"v1"'), 'the versioned key must be rolled back');
        assert.ok(await rawMeta(postId, '_wjs_review_comments'), 'the review thread was destroyed by the restore');
        assert.strictEqual(await rawMeta(postId, '_wp_trash_meta_status'), 'publish',
            'losing this makes Post.untrash bring a published post back as a draft');
        assert.strictEqual(await rawMeta(postId, 'seo_title'), '1.50', 'the value survived a lossy JSON round trip');
    });

    test('a snapshot with a versioned key CLEARS one added later (the restore stays exact)', async () => {
        const postId = await seedPost(U.editor, 'draft');
        await Post.updateMeta(postId, '_puck_data', { content: [], root: { props: { t: 'base' } } });
        const revId = await saveRevision(postId);

        await Post.updateMeta(postId, '_thumbnail_id', '42');
        assert.strictEqual(await rawMeta(postId, '_thumbnail_id'), '42');

        assert.strictEqual((await as('editor', 'post', `/revisions/${revId}/restore`)).status, 200);
        assert.strictEqual(await rawMeta(postId, '_thumbnail_id'), null,
            'a versioned key absent from the snapshot must be cleared, not kept');
    });
});
