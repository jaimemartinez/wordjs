/**
 * THE PUBLIC IDENTITY OF AN ACCOUNT IS NEVER ITS LOGIN — and an account is not an author until it
 * has published.
 *
 * Pinned against the REAL producers (User.create, migration 0017, Post.getAuthorsForIds,
 * Post._authorCondition) and the REAL anonymous routes (the author feed, `GET /posts`, a signed-in
 * comment) plus the one authenticated oracle next to them (`GET /users/:id`):
 *
 *   1. a new account with no display name of its own — or one that copied the login into it — is
 *      shown as `User <id>` under the slug `user-<id>`, never the login;
 *   2. the author feed answers 404 for an account with no published post, whatever spelling asks,
 *      and never resolves a login;
 *   3. a byline whose stored display name IS the login prints the placeholder (the read-side guard);
 *   4. migration 0017 repairs existing rows, renames the comments they left under the login, and keeps
 *      a published author's old slug (and nobody else's) — resolved ONLY when an administrator opts in,
 *      and otherwise answered on every anonymous surface exactly like an unknown slug;
 *   5. a signed-in commenter's stored name is their public one;
 *   6. `GET /users/:id` answers "someone else's" exactly like "no such id".
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-public-identity-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const PASSWORD = 'S3cret-passphrase!';

let dbAsync: any;
let app: any;
let request: any;
let User: any;
let Post: any;
let MIGRATIONS: any[];
let token: (id: number, login: string) => string;
let _seq = 0;

const migration0017 = () => MIGRATIONS.find((m: any) => m.id === '0017_public_identity_not_login');
const migrationCtx = () => ({
    exec: (sql: string) => dbAsync.exec(sql),
    run: (sql: string, params: any[] = []) => dbAsync.run(sql, params),
    get: (sql: string, params: any[] = []) => dbAsync.get(sql, params),
    all: (sql: string, params: any[] = []) => dbAsync.all(sql, params),
    isPostgres: false,
    driverName: 'sqlite-native',
});

/** A row exactly as an older install left it: display name = login, slug = the slugified login. */
async function seedLegacyUser(login: string, role = 'author', display = login, nicename = login.toLowerCase()): Promise<number> {
    const r = await dbAsync.run(
        'INSERT INTO users (user_login, user_pass, user_email, display_name, user_nicename) VALUES (?, ?, ?, ?, ?)',
        [login, 'x', `${login.toLowerCase()}@legacy.example`, display, nicename],
    );
    await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)", [r.lastID, role]);
    return r.lastID;
}

async function seedPost(authorId: number, status = 'publish'): Promise<number> {
    _seq++;
    const r = await dbAsync.run(
        "INSERT INTO posts (author_id, post_title, post_status, post_type, post_name, comment_status) VALUES (?, ?, ?, 'post', ?, 'open')",
        [authorId, `Identity post ${_seq}`, status, `identity-post-${_seq}`],
    );
    return r.lastID;
}

const row = (id: number) => dbAsync.get('SELECT user_login, display_name, user_nicename FROM users WHERE id = ?', [id]);

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await require('../core/roles').loadRoles();
    User = require('../models/User');
    Post = require('../models/Post');
    ({ MIGRATIONS } = require('../core/schema-migrations'));

    const express = require('express');
    const cookieParser = require('cookie-parser');
    request = require('supertest');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1', require('../routes'));
    const jwt = require('jsonwebtoken');
    token = (id, login) => jwt.sign({ userId: id, username: login }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    try { process.chdir(os.tmpdir()); } catch { /* */ }
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

describe('User.create never derives the public identity from the login', () => {
    it('no display name → `User <id>` and `user-<id>`', async () => {
        const created = await User.create({ username: 'quietuser', email: 'quiet@example.com', password: PASSWORD });
        const r = await row(created.id);
        assert.strictEqual(r.display_name, `User ${created.id}`);
        assert.strictEqual(r.user_nicename, `user-${created.id}`);
    });

    it('a display name that merely copies the login (any case) is treated as none', async () => {
        const created = await User.create({ username: 'copycat', email: 'copycat@example.com', password: PASSWORD, displayName: 'CopyCat' });
        const r = await row(created.id);
        assert.strictEqual(r.display_name, `User ${created.id}`);
        assert.strictEqual(r.user_nicename, `user-${created.id}`);
    });

    it('a real name is kept, but a slug that would spell the login is not', async () => {
        const created = await User.create({ username: 'john-smith', email: 'js@example.com', password: PASSWORD, displayName: 'John Smith' });
        const r = await row(created.id);
        assert.strictEqual(r.display_name, 'John Smith');
        assert.strictEqual(r.user_nicename, `user-${created.id}`, 'the slug must not be the login');
    });

    it('an explicit nicename equal to the login is discarded', async () => {
        const created = await User.create({
            username: 'wpimport', email: 'wp@example.com', password: PASSWORD, displayName: 'Imported Person', nicename: 'wpimport',
        });
        assert.strictEqual((await row(created.id)).user_nicename, 'imported-person');
    });
});

describe('the author feed', () => {
    it('is 404 for an account that has not published, by id or by slug', async () => {
        const created = await User.create({ username: 'lurker', email: 'lurker@example.com', password: PASSWORD, displayName: 'Lurking Larry' });
        await seedPost(created.id, 'draft');
        for (const seg of [String(created.id), 'lurking-larry']) {
            const res = await request(app).get(`/api/v1/seo/author/${seg}/feed.xml`);
            assert.strictEqual(res.status, 404, `/author/${seg}/feed.xml must not confirm a non-author account`);
        }
    });

    it('answers for a publisher, under the public name, and never by login', async () => {
        const created = await User.create({ username: 'writer9', email: 'w9@example.com', password: PASSWORD, displayName: 'Wren Writer' });
        await seedPost(created.id);
        const res = await request(app).get(`/api/v1/seo/author/${created.id}/feed.xml`);
        assert.strictEqual(res.status, 200, res.text);
        assert.ok(res.text.includes('Wren Writer'));
        assert.ok(!res.text.includes('writer9'), 'the login must not appear in the feed');
        assert.strictEqual((await request(app).get('/api/v1/seo/author/writer9/feed.xml')).status, 404);
    });

    it('never resolves a login even for an account with no slug', async () => {
        const id = await seedLegacyUser('noslug', 'author', 'Someone Else', '');
        await seedPost(id);
        assert.strictEqual((await request(app).get('/api/v1/seo/author/noslug/feed.xml')).status, 404);
        assert.deepStrictEqual(await Post.findAll({ author: 'noslug' }), [], '?author=<login> must not match');
        assert.strictEqual((await request(app).get(`/api/v1/seo/author/${id}/feed.xml`)).status, 200);
    });
});

describe('bylines', () => {
    it('a stored display name that IS the login prints the placeholder', async () => {
        const id = await seedLegacyUser('Byliner', 'author', 'byliner', 'byline-slug');
        const author = (await Post.getAuthorsForIds([id]))[id];
        assert.strictEqual(author.displayName, `User ${id}`);
        const postId = await seedPost(id);
        const res = await request(app).get(`/api/v1/posts/${postId}`);
        assert.strictEqual(res.status, 200, res.text);
        assert.ok(!JSON.stringify(res.body).toLowerCase().includes('byliner'), 'the REST post must not carry the login');
    });
});

describe('migration 0017 repairs existing rows', () => {
    let published = 0;
    let silent = 0;
    let commentId = 0;

    before(async () => {
        published = await seedLegacyUser('OldAuthor');
        silent = await seedLegacyUser('oldsubscriber', 'subscriber');
        const postId = await seedPost(published);
        const c = await dbAsync.run(
            "INSERT INTO comments (comment_post_id, comment_author, comment_content, comment_approved, user_id, comment_type) VALUES (?, ?, 'hi', '1', ?, 'comment')",
            [postId, 'oldauthor', published],
        );
        commentId = c.lastID;
        await migration0017().up(migrationCtx());
    });

    it('replaces login-equal display names and slugs', async () => {
        for (const id of [published, silent]) {
            const r = await row(id);
            assert.strictEqual(r.display_name, `User ${id}`);
            assert.strictEqual(r.user_nicename, `user-${id}`);
        }
    });

    it('renames the comments the account left under its login', async () => {
        const c = await dbAsync.get('SELECT comment_author FROM comments WHERE comment_id = ?', [commentId]);
        assert.strictEqual(c.comment_author, `User ${published}`);
    });

    it("keeps a PUBLISHED author's old slug (and nobody else's), but resolves none of it by default", async () => {
        const kept = await dbAsync.all("SELECT user_id FROM user_meta WHERE meta_key = 'previous_nicename'");
        assert.deepStrictEqual(kept.map((k: any) => k.user_id), [published]);

        // The retired slug was derived from the login: answered anonymously, it confirms the login. With
        // the opt-in OFF (the default) every anonymous surface answers it exactly like a slug nobody has.
        assert.deepStrictEqual(await Post.findAll({ author: 'oldauthor' }), [], '?author=<retired slug> must match nothing');
        const list = await request(app).get('/api/v1/posts').query({ author: 'oldauthor' });
        const unknownList = await request(app).get('/api/v1/posts').query({ author: 'nobody-has-this' });
        assert.deepStrictEqual(
            { status: list.status, body: list.body, total: list.headers['x-wp-total'] },
            { status: unknownList.status, body: unknownList.body, total: unknownList.headers['x-wp-total'] },
            'GET /posts?author= must answer a retired slug exactly like an unknown one',
        );
        const feed = await request(app).get('/api/v1/seo/author/oldauthor/feed.xml');
        const unknownFeed = await request(app).get('/api/v1/seo/author/nobody-has-this/feed.xml');
        assert.strictEqual(feed.status, 404);
        assert.deepStrictEqual({ status: feed.status, text: feed.text }, { status: unknownFeed.status, text: unknownFeed.text });
    });

    it('resolves the retired slug only once an administrator opts in', async () => {
        const { updateOption } = require('../core/options');
        await updateOption('author_legacy_slugs', '1');
        try {
            const viaOld = await Post.findAll({ author: 'oldauthor' });
            assert.strictEqual(viaOld.length, 1, 'the old archive URL lists the same posts when opted in');
            const feed = await request(app).get('/api/v1/seo/author/oldauthor/feed.xml');
            assert.strictEqual(feed.status, 200);
            assert.ok(feed.text.includes(`/author/user-${published}`), 'the channel must name the new canonical slug');
        } finally {
            await updateOption('author_legacy_slugs', '0');
        }
        assert.deepStrictEqual(await Post.findAll({ author: 'oldauthor' }), []);
    });

    it('the opt-in is an administrator setting a plugin cannot reach', () => {
        assert.strictEqual(require('../core/plugin-api').isProtectedOption('author_legacy_slugs'), true);
    });

    it('keeps the retired slug from being handed to someone else, and from being self-assigned', async () => {
        const created = await User.create({ username: 'newcomer', email: 'nc@example.com', password: PASSWORD, displayName: 'OldAuthor' });
        assert.strictEqual((await row(created.id)).user_nicename, 'oldauthor-2');
        await User.update(created.id, { meta: { previous_nicename: 'byline-slug' } });
        const forged = await dbAsync.get("SELECT 1 AS x FROM user_meta WHERE user_id = ? AND meta_key = 'previous_nicename'", [created.id]);
        assert.ok(!forged, 'previous_nicename must be a protected meta key');
    });

    it('is re-runnable', async () => {
        const before = await dbAsync.all('SELECT id, display_name, user_nicename FROM users ORDER BY id');
        await migration0017().up(migrationCtx());
        assert.deepStrictEqual(await dbAsync.all('SELECT id, display_name, user_nicename FROM users ORDER BY id'), before);
    });
});

describe('signed-in commenter', () => {
    it('is stored under the public name, not the login', async () => {
        const id = await seedLegacyUser('chatty', 'subscriber', 'Chatty', 'chatty-slug');
        const author = await seedLegacyUser('hostauthor', 'author', 'Host Author', 'host-author');
        const postId = await seedPost(author);
        const res = await request(app).post('/api/v1/comments')
            .set('Authorization', `Bearer ${token(id, 'chatty')}`)
            .send({ post: postId, content: 'A thoughtful remark about the post.' });
        assert.ok(res.status === 201 || res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
        const stored = await dbAsync.get('SELECT comment_author FROM comments WHERE comment_post_id = ? AND user_id = ?', [postId, id]);
        assert.strictEqual(stored.comment_author, `User ${id}`);
    });
});

describe('GET /users/:id', () => {
    it("answers someone else's id exactly like a missing one", async () => {
        const me = await seedLegacyUser('peeker', 'subscriber', 'Peeker', 'peeker-slug');
        const other = await seedLegacyUser('target', 'author', 'Target', 'target-slug');
        const auth = `Bearer ${token(me, 'peeker')}`;
        const a = await request(app).get(`/api/v1/users/${other}`).set('Authorization', auth);
        const b = await request(app).get('/api/v1/users/987654').set('Authorization', auth);
        assert.strictEqual(a.status, 404);
        assert.deepStrictEqual({ status: a.status, body: a.body }, { status: b.status, body: b.body });
        assert.strictEqual((await request(app).get(`/api/v1/users/${me}`).set('Authorization', auth)).status, 200);
    });
});
