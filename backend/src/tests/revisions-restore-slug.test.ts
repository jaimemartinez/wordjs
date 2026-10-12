/**
 * RESTORING A REVISION DOES NOT GIVE BACK A PUBLIC URL SOMEBODY ELSE NOW HOLDS.
 *
 * POST/PUT /posts keep every publicly routed type in ONE slug namespace (Post.generateUniqueSlug), so an
 * Author cannot publish a post `contact` over the page `contact`. But a revision snapshot carries the slug
 * (revision-snapshots RESTORABLE_COLUMNS includes post_name) and restoreRevision wrote it back RAW:
 *   1. an Author publishes the post `contact` while no page holds that URL, then renames it `about-me`;
 *   2. an editor creates the page `contact` — the slug is free, so the page gets it;
 *   3. the Author restores the first version of their post: post_name is `contact` again, and the post
 *      and the page share the URL (and on the same type, the unique index answers a 500 instead).
 * The restore now sends a slug other than the entry's current one through generateUniqueSlug, exactly as
 * Post.update does, so the post comes back as `contact-2` and /contact still serves the page.
 *
 * MUTATION PROOF: delete the generateUniqueSlug step in core/revisions restoreRevision and the post is
 * restored to `contact`.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-restore-slug-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const express = require('express');
const request = require('supertest');

const B = config.api.prefix;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(B, require('../routes'));

const U: Record<string, number> = {};
let dbAsync: any;
const as = (login: string) => `Bearer ${jwt.sign({ userId: U[login], username: login }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}`;

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
        [login, 'x', `${login}@example.com`, login]);
    await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)", [r.lastID, role]);
    U[login] = r.lastID;
}
const slugOf = async (id: number) => (await dbAsync.get('SELECT post_name FROM posts WHERE id = ?', [id])).post_name;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await require('../core/roles').loadRoles();
    await seedUser('writer', 'author');
    await seedUser('chief', 'editor');
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

describe('a revision restore and the shared slug namespace', () => {
    let postId = 0, pageId = 0;

    it('an Author restoring an old version does not take the page\'s URL back', async () => {
        const created = await request(app).post(`${B}/posts`).set('Authorization', as('writer'))
            .send({ title: 'Contact me', slug: 'contact', status: 'publish', content: '<p>v1</p>' });
        assert.strictEqual(created.status, 201, JSON.stringify(created.body));
        postId = created.body.id;
        assert.strictEqual(await slugOf(postId), 'contact');

        const renamed = await request(app).put(`${B}/posts/${postId}`).set('Authorization', as('writer'))
            .send({ slug: 'about-me', content: '<p>v2</p>' });
        assert.strictEqual(renamed.status, 200, JSON.stringify(renamed.body));
        assert.strictEqual(await slugOf(postId), 'about-me');

        const page = await request(app).post(`${B}/posts`).set('Authorization', as('chief'))
            .send({ title: 'Contact', slug: 'contact', type: 'page', status: 'publish', content: '<p>the real contact page</p>' });
        assert.strictEqual(page.status, 201, JSON.stringify(page.body));
        pageId = page.body.id;
        assert.strictEqual(await slugOf(pageId), 'contact', 'the slug was free, so the page holds it');

        // The version captured while the post was `contact`.
        const rows = await dbAsync.all("SELECT id FROM posts WHERE post_type = 'revision' AND post_parent = ? ORDER BY id ASC", [postId]);
        assert.ok(rows.length >= 1, 'the post has history');
        const restored = await request(app).post(`${B}/revisions/${rows[0].id}/restore`).set('Authorization', as('writer')).send({});
        assert.strictEqual(restored.status, 200, JSON.stringify(restored.body));

        const body = (await dbAsync.get('SELECT post_content FROM posts WHERE id = ?', [postId])).post_content;
        assert.ok(String(body).includes('v1'), 'the restore itself happened');
        assert.strictEqual(await slugOf(postId), 'contact-2', 'the post may not hold the page\'s URL');
        assert.strictEqual(await slugOf(pageId), 'contact');

        const served = await request(app).get(`${B}/posts/slug/contact`);
        assert.strictEqual(served.status, 200);
        assert.strictEqual(served.body.id, pageId, '/contact serves the page');
    });

    it('restoring a version whose slug is still the entry\'s own keeps it (no spurious -2)', async () => {
        const created = await request(app).post(`${B}/posts`).set('Authorization', as('writer'))
            .send({ title: 'Stable', slug: 'stable-slug', status: 'publish', content: '<p>a</p>' });
        assert.strictEqual(created.status, 201, JSON.stringify(created.body));
        const id = created.body.id;
        const edited = await request(app).put(`${B}/posts/${id}`).set('Authorization', as('writer')).send({ content: '<p>b</p>' });
        assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
        const rows = await dbAsync.all("SELECT id FROM posts WHERE post_type = 'revision' AND post_parent = ? ORDER BY id ASC", [id]);
        const restored = await request(app).post(`${B}/revisions/${rows[0].id}/restore`).set('Authorization', as('writer')).send({});
        assert.strictEqual(restored.status, 200, JSON.stringify(restored.body));
        assert.strictEqual(await slugOf(id), 'stable-slug');
    });

    it('a restore onto a slug another entry of the SAME type holds is a renamed restore, not a 500', async () => {
        const a = await request(app).post(`${B}/posts`).set('Authorization', as('writer'))
            .send({ title: 'Shared', slug: 'shared', status: 'publish', content: '<p>first</p>' });
        const aId = a.body.id;
        await request(app).put(`${B}/posts/${aId}`).set('Authorization', as('writer')).send({ slug: 'moved-away' });
        const b = await request(app).post(`${B}/posts`).set('Authorization', as('chief'))
            .send({ title: 'Shared too', slug: 'shared', status: 'publish', content: '<p>second</p>' });
        assert.strictEqual(b.status, 201, JSON.stringify(b.body));
        assert.strictEqual(await slugOf(b.body.id), 'shared');
        const rows = await dbAsync.all("SELECT id FROM posts WHERE post_type = 'revision' AND post_parent = ? ORDER BY id ASC", [aId]);
        const restored = await request(app).post(`${B}/revisions/${rows[0].id}/restore`).set('Authorization', as('writer')).send({});
        assert.strictEqual(restored.status, 200, JSON.stringify(restored.body));
        assert.strictEqual(await slugOf(aId), 'shared-2');
        assert.strictEqual(await slugOf(b.body.id), 'shared');
    });
});
