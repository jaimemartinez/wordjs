/**
 * EVERY VALUE A WRITE TAKES FROM A REQUEST BODY HAS ITS SHAPE CHECKED BEFORE IT IS USED.
 *
 *   1. IDS IN A BODY are ids an id column can hold (core/query-params bodyId): a comment's post and
 *      parent, a form's pageId, a post's parent and menu_order, a media folder and the media ids moved
 *      into it, a category's parent, a menu item's parent. An out-of-range value is answered by the route
 *      (400/404) and never reaches a query — on Postgres it was an error, a 500. The models' findById
 *      answer null for such an id whatever route forgot to ask. Proven on SQLite by watching the driver:
 *      no query may receive a parameter outside the 32-bit id range.
 *   2. POST /roles stores a role only with a string name and a bounded list of capability names; the
 *      capabilities list survives a role stored before the check.
 *   3. PUT /comments/:id runs the create path's normalizers (author as text, a valid email) and answers
 *      400 for an unknown status.
 *   4. A webhook's `active` is a boolean.
 *   5. PUT /menus/items/:itemId writes only the item's fields, each checked; a menu location is a name.
 *   6. A taxonomy's public / showInRest / showInMenu flags are booleans, whatever the body spread.
 *
 * MUTATION PROOF (verified once each): drop bodyId from POST /comments, or the isStorableId guard from
 * Post/Comment/Term.findById → the driver watcher fails; drop the shape check in setRole → the roles
 * cells fail; drop the status allowlist in PUT /comments → its 400 becomes a 500; drop assertActiveFlag
 * → the webhook cell fails; drop the field allowlist in PUT /menus/items → the menu cells fail; drop the
 * re-applied flags after the spread → the taxonomy cell fails; ask whether `status` was SENT instead of
 * whether it differs from the stored one → the moderation-gate cell fails.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-body-shapes-'));
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const express = require('express');
const request = require('supertest');

const MAX_ID = 2147483647;
const HUGE = 9999999999;
const U: Record<string, number> = {};
let db: any;
let app: any;
let publicPost = 0;
let menuId = 0;
let itemId = 0;

const tok = (login: string) => jwt.sign({ userId: U[login], username: login }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
const as = (who: string | null, method: string, url: string) => {
    const r = (request(app) as any)[method](`/api/v1${url}`);
    return who ? r.set('Authorization', `Bearer ${tok(who)}`) : r;
};

// ── the driver watcher: every parameter any query receives while `watching` is on ──
let watching = false;
const outOfRange: string[] = [];
function watchDriver() {
    const driver = database.getDbAsync();
    for (const method of ['get', 'all', 'run']) {
        const original = driver[method].bind(driver);
        driver[method] = (sql: string, params?: any[]) => {
            if (watching && Array.isArray(params)) {
                for (const p of params) {
                    const n = typeof p === 'number' ? p : (typeof p === 'string' && /^[0-9]{10,}$/.test(p) ? Number(p) : NaN);
                    if (Number.isFinite(n) && Math.abs(n) > MAX_ID) outOfRange.push(`${String(sql).replace(/\s+/g, ' ').slice(0, 80)} ← ${p}`);
                }
            }
            return original(sql, params);
        };
    }
}

async function seedUser(login: string, role: string) {
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`, [login, `${login}@example.com`, login]);
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    db = database.getDbAsync();
    await require('../core/options').initDefaultOptions(config);
    await require('../core/post-types').initPostTypes();
    await require('../core/post-types').initTaxonomies();
    await require('../core/roles').loadRoles();
    await seedUser('admin', 'administrator');
    const date = '2020-01-01 00:00:00';
    publicPost = Number((await db.run(
        `INSERT INTO posts (author_id, post_date, post_date_gmt, post_title, post_content, post_status, post_type, post_name, post_password, comment_status, post_modified, post_modified_gmt)
         VALUES (?, ?, ?, 'Open', 'body', 'publish', 'post', 'open-post', '', 'open', ?, ?)`, [U.admin, date, date, date, date])).lastID);

    app = express();
    app.use(express.json());
    app.use('/api/v1/comments', require('../routes/comments'));
    app.use('/api/v1/forms', require('../routes/forms'));
    app.use('/api/v1/posts', require('../routes/posts'));
    app.use('/api/v1/media', require('../routes/media'));
    app.use('/api/v1/categories', require('../routes/categories'));
    app.use('/api/v1/menus', require('../routes/menus'));
    app.use('/api/v1/roles', require('../routes/roles'));
    app.use('/api/v1/taxonomies', require('../routes/taxonomies'));
    app.use(require('../middleware/errorHandler').errorHandler);

    const menu = await as('admin', 'post', '/menus').send({ name: 'Main' });
    assert.strictEqual(menu.status, 201, JSON.stringify(menu.body));
    menuId = menu.body.id;
    const item = await as('admin', 'post', `/menus/${menuId}/items`).send({ title: 'Home', url: '/' });
    assert.strictEqual(item.status, 201, JSON.stringify(item.body));
    itemId = item.body.id;
    watchDriver();
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

describe('ids in a request body', () => {
    it('are answered by the route, and none reaches a query', async () => {
        outOfRange.length = 0;
        watching = true;
        try {
            const cells: Array<[string, any, number[]]> = [
                ['POST /comments post', await as(null, 'post', '/comments').send({ post: HUGE, content: 'hi', author_name: 'A', author_email: 'a@example.com' }), [404]],
                ['POST /comments post (string)', await as(null, 'post', '/comments').send({ post: String(HUGE), content: 'hi', author_name: 'A', author_email: 'a@example.com' }), [404]],
                ['POST /comments parent', await as(null, 'post', '/comments').send({ post: publicPost, parent: HUGE, content: 'hi', author_name: 'A', author_email: 'a@example.com' }), [400]],
                ['POST /forms/submit pageId', await as(null, 'post', '/forms/submit').send({ formName: 'Contact', pageId: HUGE, fields: { a: 'b' } }), [400]],
                ['PUT /posts parent', await as('admin', 'put', `/posts/${publicPost}`).send({ parent: HUGE }), [400]],
                ['PUT /posts menu_order', await as('admin', 'put', `/posts/${publicPost}`).send({ menu_order: HUGE }), [400]],
                ['POST /media/folders parent', await as('admin', 'post', '/media/folders').send({ name: 'F', parent: HUGE }), [400]],
                ['POST /media/folders/move folder', await as('admin', 'post', '/media/folders/move').send({ folder: HUGE, ids: [publicPost] }), [400]],
                ['POST /media/folders/move ids', await as('admin', 'post', '/media/folders/move').send({ folder: 0, ids: [HUGE] }), [400]],
                ['POST /categories parent', await as('admin', 'post', '/categories').send({ name: 'C', parent: HUGE }), [400]],
                ['POST /menus/:id/items parent', await as('admin', 'post', `/menus/${menuId}/items`).send({ title: 'T', parent: HUGE }), [400]],
            ];
            const wrong = cells.filter(([, res, ok]) => !ok.includes(res.status)).map(([label, res]) => `${label}: ${res.status} ${JSON.stringify(res.body)}`);
            assert.deepStrictEqual(wrong, []);
            for (const [model, call] of [
                ['Post', () => require('../models/Post').findById(HUGE)],
                ['Comment', () => require('../models/Comment').findById(HUGE)],
                ['Term', () => require('../models/Term').findById(HUGE)],
            ] as Array<[string, () => Promise<any>]>) {
                assert.strictEqual(await call(), null, model);
            }
        } finally {
            watching = false;
        }
        assert.deepStrictEqual(outOfRange, [], 'an out-of-range id reached the driver');
    });

    it('controls: an ordinary id still works', async () => {
        const c = await as(null, 'post', '/comments').send({ post: String(publicPost), content: 'hello there', author_name: 'A', author_email: 'a@example.com', parent: '0' });
        assert.strictEqual(c.status, 201, JSON.stringify(c.body));
        const order = await as('admin', 'put', `/posts/${publicPost}`).send({ menu_order: -3 });
        assert.strictEqual(order.status, 200, JSON.stringify(order.body));
    });
});

describe('POST /roles', () => {
    it('refuses a role whose capabilities are not a list of names, or whose name is not text', async () => {
        for (const body of [
            { slug: 'bad_role', name: 'Bad', capabilities: { edit_posts: 'yes' } },
            { slug: 'bad_role', name: 'Bad', capabilities: 'edit_posts' },
            { slug: 'bad_role', name: 'Bad', capabilities: ['read', 7] },
            { slug: 'bad_role', name: 'Bad', capabilities: new Array(501).fill('read') },
            { slug: 'bad_role', name: { en: 'Bad' }, capabilities: ['read'] },
        ]) {
            const res = await as('admin', 'post', '/roles').send(body);
            assert.strictEqual(res.status, 400, `${JSON.stringify(body).slice(0, 80)}: ${res.status} ${JSON.stringify(res.body)}`);
        }
        const caps = await as('admin', 'get', '/roles/capabilities');
        assert.strictEqual(caps.status, 200, JSON.stringify(caps.body));
        const ok = await as('admin', 'post', '/roles').send({ slug: 'good_role', name: 'Good', capabilities: ['read'] });
        assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
        // WordPress's map form is taken, and stored as the list every reader expects.
        const map = await as('admin', 'post', '/roles').send({ slug: 'map_role', name: 'Map', capabilities: { read: true, edit_posts: false } });
        assert.strictEqual(map.status, 201, JSON.stringify(map.body));
        assert.deepStrictEqual(require('../core/roles').getRole('map_role').capabilities, ['read']);
    });
});

describe('PUT /comments/:id', () => {
    it('normalizes the author and email like the create path, and refuses an unknown status', async () => {
        const id = Number((await db.run(
            `INSERT INTO comments (comment_post_id, comment_author, comment_author_email, comment_content, comment_approved, user_id, comment_type, comment_parent)
             VALUES (?, 'Guest', 'g@example.com', 'text', '0', 0, 'comment', 0)`, [publicPost])).lastID);
        const status = await as('admin', 'put', `/comments/${id}`).send({ status: 'bogus' });
        assert.strictEqual(status.status, 400, JSON.stringify(status.body));
        const email = await as('admin', 'put', `/comments/${id}`).send({ author_email: 'not-an-address' });
        assert.strictEqual(email.status, 400, JSON.stringify(email.body));
        const author = await as('admin', 'put', `/comments/${id}`).send({ author: '<b>Ann</b> ', status: 'approve' });
        assert.strictEqual(author.status, 200, JSON.stringify(author.body));
        const row = await db.get('SELECT comment_author, comment_author_email, comment_approved FROM comments WHERE comment_id = ?', [id]);
        assert.strictEqual(row.comment_author, 'Ann');
        assert.strictEqual(row.comment_author_email, 'g@example.com');
        assert.strictEqual(row.comment_approved, '1', 'the WordPress alias is folded');
    });
});

describe('a webhook\'s active flag', () => {
    it('is a boolean on create and update', async () => {
        const Webhook = require('../models/Webhook');
        await assert.rejects(() => Webhook.create({ userId: U.admin, url: 'https://hooks.example.com/x', active: 'false' }), /active must be true or false/);
        const id = Number((await db.run(
            `INSERT INTO webhooks (user_id, name, url, events, secret, secret_prefix, active, failure_count) VALUES (?, 'W', 'https://hooks.example.com/x', '*', 'whsec_x', 'whsec_x', 0, 0)`,
            [U.admin])).lastID);
        await assert.rejects(() => Webhook.update(id, { active: 'false' }), /active must be true or false/);
        assert.strictEqual(Number((await db.get('SELECT active FROM webhooks WHERE id = ?', [id])).active), 0);
        await Webhook.update(id, { active: true });
        assert.strictEqual(Number((await db.get('SELECT active FROM webhooks WHERE id = ?', [id])).active), 1);
    });
});

describe('PUT /comments/:id: the moderation gate is decided on the stored status', () => {
    it('edit_comments without moderate_comments: echoing the stored status passes, changing it is 403', async () => {
        await require('../core/roles').setRole('comment_fixer', { name: 'Comment fixer', capabilities: ['read', 'edit_comments', 'edit_posts', 'edit_others_posts', 'edit_published_posts'] });
        await seedUser('fixer', 'comment_fixer');
        const id = Number((await db.run(
            `INSERT INTO comments (comment_post_id, comment_author, comment_author_email, comment_content, comment_approved, user_id, comment_type, comment_parent)
             VALUES (?, 'Guest', 'g@example.com', 'text', '0', 0, 'comment', 0)`, [publicPost])).lastID);
        // The editor's form sends the whole comment back, its current status included.
        const echo = await as('fixer', 'put', `/comments/${id}`).send({ content: 'typo fixed', status: 'hold' });
        assert.strictEqual(echo.status, 200, JSON.stringify(echo.body));
        assert.strictEqual((await db.get('SELECT comment_content FROM comments WHERE comment_id = ?', [id])).comment_content, 'typo fixed');
        for (const status of ['1', 'approve', 'spam', 'trash']) {
            const res = await as('fixer', 'put', `/comments/${id}`).send({ content: 'sneaky', status });
            assert.strictEqual(res.status, 403, `${status}: ${res.status} ${JSON.stringify(res.body)}`);
            assert.strictEqual(res.body.code, 'rest_forbidden');
        }
        const row = await db.get('SELECT comment_content, comment_approved FROM comments WHERE comment_id = ?', [id]);
        assert.strictEqual(row.comment_approved, '0', 'the status did not move');
        assert.strictEqual(row.comment_content, 'typo fixed', 'a refused request writes nothing');
    });
});

describe('PUT /menus/items/:itemId and the menu location', () => {
    it('checks each field and ignores the ones an item does not have', async () => {
        for (const body of [{ title: { x: 1 } }, { title: '' }, { order: 1.5 }, { order: HUGE }, { classes: ['a'] }, { url: { href: '/' } }]) {
            const res = await as('admin', 'put', `/menus/items/${itemId}`).send(body);
            assert.strictEqual(res.status, 400, `${JSON.stringify(body)}: ${res.status} ${JSON.stringify(res.body)}`);
        }
        const ok = await as('admin', 'put', `/menus/items/${itemId}`).send({ id: 999, type: 'post_type', title: 'Start', order: '2', menuId: 77 });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        assert.strictEqual(ok.body.title, 'Start');
        const row = await db.get('SELECT post_title, menu_order FROM posts WHERE id = ?', [itemId]);
        assert.strictEqual(row.post_title, 'Start');
        assert.strictEqual(Number(row.menu_order), 2);
    });

    it('a location is a name, not a list', async () => {
        const res = await as('admin', 'post', `/menus/${menuId}/location`).send({ location: ['header', 'footer'] });
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        const ok = await as('admin', 'post', `/menus/${menuId}/location`).send({ location: 'header' });
        assert.ok(ok.status < 300, JSON.stringify(ok.body));
    });
});

describe('a new taxonomy\'s flags', () => {
    it('are booleans after the body spread', async () => {
        const res = await as('admin', 'post', '/taxonomies').send({ name: 'genre', label: 'Genre', public: 'nope', showInRest: 'yes', showInMenu: 1 });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        const got = require('../core/post-types').getTaxonomy('genre');
        for (const flag of ['public', 'showInRest', 'showInMenu']) assert.strictEqual(typeof got[flag], 'boolean', `${flag}: ${JSON.stringify(got[flag])}`);
    });
});
