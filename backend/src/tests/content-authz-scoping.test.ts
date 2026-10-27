/**
 * CONTENT AUTHORIZATION FOLLOWS THE RECORD — five surfaces, each judged on the entry it touches.
 *
 *   1. THE TRASH IS READ-ONLY. A trashed entry is not edited in place by anyone — PUT, meta, language,
 *      translations and revision restore answer 409 rest_post_trashed — and DELETE / restore judge it by
 *      the status it had before the trash (`_wp_trash_meta_status`). The way out is POST /restore.
 *   2. COMMENT MODERATION IS SCOPED TO THE ENTRY (core/comment-scope): a moderator lists, reads and
 *      moderates only the comments of entries whose edit gate they pass, in the query (rows and
 *      X-WP-Total) and on every single-comment route; an edit_comments holder without moderate_comments
 *      gets no commenter email back from PUT.
 *   3. GET /media/:id/usage takes the item's read rule and counts only the entries the caller may read.
 *   4. Revision READS take canManagePostRecord: authorship alone (an author whose role was lowered) is not
 *      enough.
 *   5. /types hides the definition of a non-public type from callers who cannot edit its entries.
 *
 * MUTATION PROOF (verified once each): drop refuseTrashedEdit from PUT → the PUT cell fails; drop the
 * trash line of canEditPostRecord and the refusals → every 409 cell fails; drop withPreTrashStatus from
 * DELETE / restore → the force-delete / restore cells fail; drop moderatorViewer from GET /comments → the
 * list cells fail; drop refuseCommentModeration → the moderation cells fail; drop the canViewAttachment
 * check from /usage → its 404 cell fails; put back the isOwner shortcut in revisions → the revision cell
 * fails; drop canSeeTypeDefinition → the /types cells fail.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-content-authz-'));
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const express = require('express');
const request = require('supertest');

const U: Record<string, number> = {};
let db: any;
let app: any;
let seq = 0;

const tok = (login: string) => jwt.sign({ userId: U[login], username: login }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
const as = (who: string | null, method: string, url: string) => {
    const r = (request(app) as any)[method](`/api/v1${url}`);
    return who ? r.set('Authorization', `Bearer ${tok(who)}`) : r;
};

async function seedUser(login: string, role: string) {
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`, [login, `${login}@example.com`, login]);
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

async function seedEntry(author: number, status: string, type = 'post', parent = 0): Promise<number> {
    seq++;
    const date = '2020-01-01 00:00:00';
    const r = await db.run(
        `INSERT INTO posts (author_id, post_date, post_date_gmt, post_title, post_content, post_status, post_type, post_name, post_password, comment_status, post_modified, post_modified_gmt, post_parent)
         VALUES (?, ?, ?, ?, 'original body', ?, ?, ?, '', 'open', ?, ?, ?)`,
        [author, date, date, `Entry ${seq}`, status, type, `scope-${seq}`, date, date, parent]);
    return Number(r.lastID);
}

async function seedComment(postId: number, content: string, approved = '1'): Promise<number> {
    const r = await db.run(
        `INSERT INTO comments (comment_post_id, comment_author, comment_author_email, comment_author_ip, comment_content, comment_approved, user_id, comment_type, comment_parent)
         VALUES (?, 'Guest', 'guest@example.com', '203.0.113.9', ?, ?, 0, 'comment', 0)`,
        [postId, content, approved]);
    return Number(r.lastID);
}

const contentOf = async (id: number) => (await db.get('SELECT post_content FROM posts WHERE id = ?', [id])).post_content;
const statusOf = async (id: number) => (await db.get('SELECT post_status FROM posts WHERE id = ?', [id]))?.post_status;
const approvedOf = async (id: number) => (await db.get('SELECT comment_approved FROM comments WHERE comment_id = ?', [id]))?.comment_approved;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    db = database.getDbAsync();
    const postTypes = require('../core/post-types');
    await postTypes.initPostTypes();
    await postTypes.saveCustomPostType('ledger', { public: false, showInRest: true, capability_type: 'ledger', label: 'Ledger' });
    const roles = require('../core/roles');
    await roles.loadRoles();
    // Deletes published posts but cannot publish: the one shape for which restore's publish downgrade
    // is the barrier.
    await roles.setRole('trash_keeper', { name: 'Trash keeper', capabilities: ['read', 'edit_posts', 'delete_posts', 'delete_published_posts', 'delete_others_posts'] });
    await roles.setRole('comment_fixer', { name: 'Comment fixer', capabilities: ['read', 'edit_comments', 'edit_posts', 'edit_others_posts', 'edit_published_posts'] });
    await seedUser('admin', 'administrator');
    await seedUser('editor', 'editor');
    await seedUser('author', 'author');
    await seedUser('contrib', 'contributor');
    await seedUser('fixer', 'comment_fixer');
    await seedUser('keeper', 'trash_keeper');
    await seedUser('subscriber', 'subscriber');

    app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/v1/posts', require('../routes/posts'));
    app.use('/api/v1/revisions', require('../routes/revisions'));
    app.use('/api/v1/comments', require('../routes/comments'));
    app.use('/api/v1/media', require('../routes/media'));
    app.use('/api/v1/types', require('../routes/post-types'));
    app.use(require('../middleware/errorHandler').errorHandler);
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

// ─────────────────────────────────────────────────────────────────────────────────────── 1. the trash

describe('a trashed entry is read-only until it is restored', () => {
    let published = 0;
    let other = 0;
    let revisionId = 0;

    before(async () => {
        // The contributor's entry, published by an editor (with a revision from that edit), then trashed.
        published = await seedEntry(U.contrib, 'draft');
        const pub = await as('editor', 'put', `/posts/${published}`).send({ status: 'publish', content: 'approved body' });
        assert.strictEqual(pub.status, 200, JSON.stringify(pub.body));
        const revs = await as('editor', 'get', `/revisions/post/${published}`);
        assert.strictEqual(revs.status, 200, JSON.stringify(revs.body));
        revisionId = (revs.body.revisions || revs.body)[0]?.id;
        assert.ok(revisionId, `a revision exists: ${JSON.stringify(revs.body)}`);
        other = await seedEntry(U.contrib, 'draft');
        const trashed = await as('editor', 'delete', `/posts/${published}`);
        assert.strictEqual(trashed.status, 200, JSON.stringify(trashed.body));
        assert.strictEqual(await statusOf(published), 'trash');
    });

    const trashedRefusal = (res: any, label: string) => {
        assert.strictEqual(res.status, 409, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.code, 'rest_post_trashed', label);
    };

    it('PUT, meta, language, translations and revision restore answer 409 to its author', async () => {
        trashedRefusal(await as('contrib', 'put', `/posts/${published}`).send({ content: 'unreviewed rewrite' }), 'PUT');
        trashedRefusal(await as('contrib', 'post', `/posts/${published}/meta`).send({ key: '_puck_data', value: '{"content":[],"root":{}}' }), 'meta');
        trashedRefusal(await as('contrib', 'put', `/posts/${published}/language`).send({ language: 'fr' }), 'language');
        trashedRefusal(await as('contrib', 'post', `/posts/${published}/translations`).send({ translationId: other }), 'link translation');
        trashedRefusal(await as('contrib', 'post', `/posts/${other}/translations`).send({ translationId: published }), 'link translation (other side)');
        trashedRefusal(await as('contrib', 'delete', `/posts/${published}/translations`), 'unlink translation');
        trashedRefusal(await as('contrib', 'post', `/revisions/${revisionId}/restore`), 'revision restore');
        assert.strictEqual(await contentOf(published), 'approved body', 'the trashed entry was rewritten');
        assert.strictEqual(await require('../models/Post').getMeta(published, '_puck_data'), null);
    });

    it('and to an editor too: the way out is Restore', async () => {
        trashedRefusal(await as('editor', 'put', `/posts/${published}`).send({ content: 'edited in the trash' }), 'editor PUT');
        trashedRefusal(await as('editor', 'put', `/posts/${published}`).send({ status: 'draft' }), 'status out of the trash through PUT');
        assert.strictEqual(await statusOf(published), 'trash');
    });

    it('its author may neither delete it for good nor restore it: judged as the published entry it was', async () => {
        const force = await as('contrib', 'delete', `/posts/${published}?force=true`);
        assert.strictEqual(force.status, 403, JSON.stringify(force.body));
        const restore = await as('contrib', 'post', `/posts/${published}/restore`);
        assert.strictEqual(restore.status, 403, JSON.stringify(restore.body));
        assert.strictEqual(await statusOf(published), 'trash');
    });

    it('a trashed row with no recorded status is judged as published (the stricter answer)', async () => {
        const bare = await seedEntry(U.contrib, 'trash');
        assert.strictEqual((await as('contrib', 'delete', `/posts/${bare}?force=true`)).status, 403);
        assert.strictEqual((await as('editor', 'delete', `/posts/${bare}?force=true`)).status, 200);
    });

    it('controls: the author handles their own trashed draft, and an editor restores then edits', async () => {
        const draft = await seedEntry(U.contrib, 'draft');
        assert.strictEqual((await as('contrib', 'delete', `/posts/${draft}`)).status, 200);
        const back = await as('contrib', 'post', `/posts/${draft}/restore`);
        assert.strictEqual(back.status, 200, JSON.stringify(back.body));
        assert.strictEqual(back.body.status, 'draft');

        const restored = await as('editor', 'post', `/posts/${published}/restore`);
        assert.strictEqual(restored.status, 200, JSON.stringify(restored.body));
        assert.strictEqual(restored.body.status, 'publish');
        const edit = await as('editor', 'put', `/posts/${published}`).send({ content: 'edited after restore' });
        assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));
        assert.strictEqual(await contentOf(published), 'edited after restore');
    });

    it('a restore by someone who may delete it but not publish brings it back pending, never live', async () => {
        const id = await seedEntry(U.author, 'publish');
        assert.strictEqual((await as('editor', 'delete', `/posts/${id}`)).status, 200);
        const res = await as('keeper', 'post', `/posts/${id}/restore`);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.status, 'pending');
        assert.strictEqual(await statusOf(id), 'pending');
    });

    it('the shared gate itself refuses a trashed record (collab, presence and attachments ask it)', () => {
        const { canEditPostRecord } = require('../core/post-capabilities');
        const admin = { id: U.admin, can: () => true };
        assert.strictEqual(canEditPostRecord(admin, { id: 1, type: 'post', authorId: U.admin, postStatus: 'trash' }), false);
        assert.strictEqual(canEditPostRecord(admin, { id: 1, type: 'post', authorId: U.admin, postStatus: 'draft' }), true);
    });
});

// ─────────────────────────────────────────────────────────────────────────── 2. comment moderation

describe('comment moderation is scoped to the entry', () => {
    const C: Record<string, number> = {};
    let ledger = 0;
    let publicPost = 0;
    let trashedPost = 0;

    before(async () => {
        ledger = await seedEntry(U.admin, 'publish', 'ledger');
        publicPost = await seedEntry(U.author, 'publish');
        trashedPost = await seedEntry(U.author, 'publish');
        await as('editor', 'delete', `/posts/${trashedPost}`);
        C.ledgerApproved = await seedComment(ledger, 'scope-ledger-approved');
        C.ledgerPending = await seedComment(ledger, 'scope-ledger-pending', '0');
        C.publicPending = await seedComment(publicPost, 'scope-public-pending', '0');
        C.publicApproved = await seedComment(publicPost, 'scope-public-approved');
        C.trashSpam = await seedComment(trashedPost, 'scope-trash-pending', '0');
    });

    const texts = (res: any): string[] => (Array.isArray(res.body) ? res.body : []).map((c: any) => String(c.content?.rendered ?? c.content));
    const ledgerIn = (res: any) => texts(res).some((t) => t.includes('scope-ledger'));

    it('the list (rows and X-WP-Total) leaves out the comments of entries the moderator cannot edit', async () => {
        const res = await as('editor', 'get', '/comments?status=any&per_page=100');
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.ok(!ledgerIn(res), `served: ${JSON.stringify(texts(res))}`);
        assert.strictEqual(Number(res.headers['x-wp-total']), res.body.length, 'the total counts the hidden rows');
        assert.ok(texts(res).some((t) => t.includes('scope-public-pending')), 'control: their own scope is listed');
        assert.ok(texts(res).some((t) => t.includes('scope-trash-pending')), 'control: a trashed entry\'s spam is still theirs to clear');
        const named = await as('editor', 'get', `/comments?status=any&post=${ledger}`);
        assert.deepStrictEqual(named.body, []);
        assert.strictEqual(named.headers['x-wp-total'], '0');
        const search = await as('editor', 'get', '/comments?status=any&search=scope-ledger');
        assert.deepStrictEqual(search.body, []);
    });

    it('a single comment of such an entry is no comment at all, and cannot be moderated', async () => {
        for (const id of [C.ledgerApproved, C.ledgerPending]) {
            assert.strictEqual((await as('editor', 'get', `/comments/${id}`)).status, 404);
            // PUT takes edit_comments (no built-in role holds it): the custom role, which edits posts but
            // holds nothing for the ledger type.
            assert.strictEqual((await as('fixer', 'put', `/comments/${id}`).send({ content: 'rewritten' })).status, 404);
            for (const action of ['approve', 'unapprove', 'spam']) {
                assert.strictEqual((await as('editor', 'post', `/comments/${id}/${action}`)).status, 404, action);
            }
            assert.strictEqual((await as('editor', 'delete', `/comments/${id}?force=true`)).status, 404);
        }
        assert.strictEqual(await approvedOf(C.ledgerPending), '0');
        assert.strictEqual(await approvedOf(C.ledgerApproved), '1');
    });

    it('controls: the editor moderates the public entry, and the administrator moderates everything', async () => {
        const one = await as('editor', 'get', `/comments/${C.publicPending}`);
        assert.strictEqual(one.status, 200);
        assert.strictEqual(one.body.authorEmail, 'guest@example.com', 'the moderator view');
        assert.strictEqual((await as('editor', 'post', `/comments/${C.publicPending}/approve`)).status, 200);
        assert.strictEqual(await approvedOf(C.publicPending), '1');
        assert.strictEqual((await as('editor', 'post', `/comments/${C.trashSpam}/spam`)).status, 200);
        const all = await as('admin', 'get', '/comments?status=any&per_page=100');
        assert.ok(ledgerIn(all));
        assert.strictEqual((await as('admin', 'post', `/comments/${C.ledgerPending}/approve`)).status, 200);
    });

    it('PUT by an edit_comments holder without moderate_comments returns no commenter email or IP', async () => {
        const visible = await as('fixer', 'put', `/comments/${C.ledgerApproved}`).send({ content: 'x' });
        assert.strictEqual(visible.status, 404, 'the ledger is out of reach of the role');
        const res = await as('fixer', 'put', `/comments/${C.publicApproved}`).send({ content: 'typo fixed' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.authorEmail, undefined, JSON.stringify(res.body));
        assert.strictEqual(res.body.authorIp, undefined, JSON.stringify(res.body));
    });
});

// ─────────────────────────────────────────────────────────────────────────────── 3. media usage

describe('GET /media/:id/usage follows the item and each entry', () => {
    it('a hidden item answers 404, and only the entries the caller may read are counted', async () => {
        const privateDraft = await seedEntry(U.admin, 'draft');
        const hidden = await seedEntry(U.admin, 'inherit', 'attachment', privateDraft);
        const res = await as('author', 'get', `/media/${hidden}/usage`);
        assert.strictEqual(res.status, 404, JSON.stringify(res.body));

        const shared = await seedEntry(U.admin, 'inherit', 'attachment');
        const own = await seedEntry(U.author, 'publish');
        const othersDraft = await seedEntry(U.admin, 'draft');
        const Post = require('../models/Post');
        await Post.updateMeta(own, '_thumbnail_id', String(shared));
        await Post.updateMeta(othersDraft, '_thumbnail_id', String(shared));
        const usage = await as('author', 'get', `/media/${shared}/usage`);
        assert.strictEqual(usage.status, 200, JSON.stringify(usage.body));
        assert.strictEqual(usage.body.featuredIn, 1, JSON.stringify(usage.body));
        assert.deepStrictEqual(usage.body.entries.map((e: any) => e.id), [own]);
        // Control: the administrator sees both.
        const admin = await as('admin', 'get', `/media/${shared}/usage`);
        assert.strictEqual(admin.body.featuredIn, 2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────────── 4. revisions

describe('revision reads take the record\'s manage gate', () => {
    it('an author whose role was lowered no longer reads the history of their entry', async () => {
        await seedUser('formerAuthor', 'author');
        const id = await seedEntry(U.formerAuthor, 'draft');
        const edit = await as('formerAuthor', 'put', `/posts/${id}`).send({ content: 'second version' });
        assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));
        assert.strictEqual((await as('formerAuthor', 'get', `/revisions/post/${id}`)).status, 200, 'control: while an author');
        await db.run(`UPDATE user_meta SET meta_value = 'subscriber' WHERE user_id = ? AND meta_key = 'role'`, [U.formerAuthor]);
        await require('../core/cache').del(`user:${U.formerAuthor}`);
        const res = await as('formerAuthor', 'get', `/revisions/post/${id}`);
        assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────── 5. /types

describe('/types hides the definition of a non-public type from who cannot edit it', () => {
    it('anonymous and subscriber callers do not see it; an administrator does; public types stay public', async () => {
        for (const who of [null, 'subscriber']) {
            const list = await as(who, 'get', '/types');
            assert.strictEqual(list.status, 200);
            const names = list.body.map((t: any) => t.name);
            assert.ok(!names.includes('ledger'), `${who}: ${names}`);
            assert.ok(names.includes('post') && names.includes('page'), 'control: the public types');
            const schemas = await as(who, 'get', '/types/schemas');
            assert.ok(!schemas.body.some((s: any) => s.name === 'ledger'));
            assert.strictEqual((await as(who, 'get', '/types/ledger')).status, 404);
            assert.strictEqual((await as(who, 'get', '/types/ledger/schema')).status, 404);
            assert.strictEqual((await as(who, 'get', '/types/post')).status, 200);
        }
        const internal = await as(null, 'get', '/types?rest=false');
        assert.deepStrictEqual(internal.body, [], 'internal types are not public');
        const admin = await as('admin', 'get', '/types');
        assert.ok(admin.body.some((t: any) => t.name === 'ledger'));
        assert.strictEqual((await as('admin', 'get', '/types/ledger/schema')).status, 200);
    });
});
