/**
 * GET /posts DECIDES WHO MAY READ A TYPE FROM ITS NAME — SO THE NAME MUST MEAN ONE THING TO EVERY ENGINE.
 *
 * The list picks its read policy with capsForType(type) — an exact JavaScript lookup — and then runs
 * `post_type = ?` with the same string. On MySQL/MariaDB the column is compared under utf8mb4_unicode_ci,
 * which ignores case, accents, zero-weight code points and (PAD SPACE) trailing spaces. So:
 *   · anonymous `?type=INVOICE` found no registered type, fell back to the publicly readable `post`
 *     policy (skipping the non-public clamp), and the query matched every published `invoice`;
 *   · an editor without edit_others_invoices listed every invoice in every status with `?type=Invoice&status=any`;
 *   · `?type=nav_menu_item%20` passed the internal-type refusal and listed the menu items.
 * The importer had the same comparison: `<wp:post_type>Revision</wp:post_type>` was "unregistered" to
 * its internal-type refusal and a revision to every later query on MySQL.
 *
 * NO MySQL SERVER RUNS IN THIS SUITE. The engine's comparison is MODELLED EXPLICITLY: the model layer's
 * two list queries are wrapped so the type they receive is folded the way utf8mb4_unicode_ci folds it
 * before SQLite (binary) compares it. Every row this suite stores carries a canonical lowercase type, so
 * "fold the probe, compare exactly" is the same relation as "compare under the collation".
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-posts-type-collation-'));
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

/** utf8mb4_unicode_ci (PAD SPACE), as far as type names go — the relation MySQL applies to post_type. */
function mysqlUnicodeCiFold(value: string): string {
    const { IGNORABLE_RANGES } = require('../core/protected-meta');
    let out = '';
    for (const ch of value.normalize('NFKD')) {
        const cp = ch.codePointAt(0) as number;
        if (cp >= 0x0300 && cp <= 0x036f) continue;
        if ((IGNORABLE_RANGES as Array<[number, number]>).some(([lo, hi]) => cp >= lo && cp <= hi)) continue;
        out += ch;
    }
    return out.toLowerCase().replace(/ß/g, 'ss').replace(/ +$/, '');
}

describe('a type parameter names the same rows to the authorization and to the database', () => {
    let request: any, app: any, dbAsync: any, Post: any;
    let editorToken: string, adminToken: string;
    let editorId: number;
    const invoiceIds: number[] = [];
    const menuItemIds: number[] = [];
    const restore: Array<() => void> = [];

    const as = (token: string) => (r: any) => r.set('Authorization', `Bearer ${token}`);
    const sign = (userId: number, username: string) =>
        jwt.sign({ userId, username }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

    async function seedUser(login: string, role: string): Promise<number> {
        await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            [login, 'x', `${login}@example.com`, login]);
        const row = await dbAsync.get(`SELECT id FROM users WHERE user_login = ?`, [login]);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [row.id, role]);
        return row.id;
    }

    async function seedRow(type: string, status: string, slug: string, authorId: number): Promise<number> {
        const r = await dbAsync.run(
            `INSERT INTO posts (author_id, post_date, post_date_gmt, post_content, post_title, post_status, post_name, post_type, post_modified, post_modified_gmt)
             VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [authorId, `<p>${slug} body</p>`, slug, status, slug, type]);
        return Number(r.lastID);
    }

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        const postTypes = require('../core/post-types');
        await postTypes.initPostTypes();
        // A REST-addressable but NON-PUBLIC custom type with its own capability family.
        postTypes.registerPostType('invoice', { public: false, capability_type: 'invoice', label: 'Invoices' });

        const adminId = await seedUser('admin', 'administrator');
        editorId = await seedUser('editor1', 'editor');
        adminToken = sign(adminId, 'admin');
        editorToken = sign(editorId, 'editor1');

        invoiceIds.push(await seedRow('invoice', 'publish', 'invoice-acme', adminId));
        invoiceIds.push(await seedRow('invoice', 'draft', 'invoice-draft', adminId));
        invoiceIds.push(await seedRow('invoice', 'private', 'invoice-private', adminId));
        menuItemIds.push(await seedRow('nav_menu_item', 'publish', 'menu-item-1', adminId));
        await seedRow('post', 'publish', 'ordinary-post', adminId);

        // THE ENGINE MODEL: the database folds the type it is asked for before it compares.
        Post = require('../models/Post');
        for (const method of ['findAllWithRelations', 'count']) {
            const real = Post[method];
            Post[method] = function (opts: any, ...rest: any[]) {
                const folded = opts && typeof opts.type === 'string' ? { ...opts, type: mysqlUnicodeCiFold(opts.type) } : opts;
                return real.call(this, folded, ...rest);
            };
            restore.push(() => { Post[method] = real; });
        }

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use('/api/v1/posts', require('../routes/posts'));
        app.use(errorHandler);
    });

    after(async () => {
        for (const r of restore) r();
        try { await database.closeDatabase(); } catch { /* */ }
        process.chdir(os.tmpdir());
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    const ids = (res: any): number[] => (Array.isArray(res.body) ? res.body.map((p: any) => p.id) : []);

    it('the model is faithful: the canonical spelling and its collation twins select the same rows', async () => {
        for (const twin of ['INVOICE', 'Invoice', 'invoice ', 'invoíce', 'invoice\u200b']) {
            const rows = await Post.findAllWithRelations({ type: twin, status: 'publish', limit: 10, offset: 0 });
            assert.deepStrictEqual(rows.map((p: any) => p.id), [invoiceIds[0]], `${JSON.stringify(twin)} must model as invoice`);
        }
    });

    it('anonymous: a non-public type is not listed under ANY spelling', async () => {
        // Control first: the canonical name is clamped to nothing for an anonymous caller.
        const canonical = await request(app).get('/api/v1/posts').query({ type: 'invoice' });
        assert.strictEqual(canonical.status, 200);
        assert.deepStrictEqual(ids(canonical), []);

        for (const twin of ['INVOICE', 'Invoice', 'invoice ', 'invoíce', 'invoice\u200b']) {
            const res = await request(app).get('/api/v1/posts').query({ type: twin });
            assert.deepStrictEqual(ids(res).filter((id) => invoiceIds.includes(id)), [],
                `${JSON.stringify(twin)} listed invoices to an anonymous caller`);
            assert.strictEqual(res.status, 400, `${JSON.stringify(twin)} → ${res.status}`);
            assert.strictEqual(res.body.code, 'rest_invalid_post_type');
            assert.strictEqual(res.headers['x-wp-total'], undefined, 'no total announced for the refused spelling');
        }
    });

    it('an editor without the type\'s capabilities gets no drafts or private entries through a twin spelling', async () => {
        const canonical = await as(editorToken)(request(app).get('/api/v1/posts')).query({ type: 'invoice', status: 'any' });
        assert.strictEqual(canonical.status, 200);
        assert.deepStrictEqual(ids(canonical), [], 'control: the editor holds no invoice capability');

        for (const twin of ['Invoice', 'INVOICE ']) {
            const res = await as(editorToken)(request(app).get('/api/v1/posts')).query({ type: twin, status: 'any' });
            assert.deepStrictEqual(ids(res).filter((id) => invoiceIds.includes(id)), [],
                `${JSON.stringify(twin)} listed invoices in every status to an editor`);
            assert.strictEqual(res.status, 400);
        }
    });

    it('the internal-type refusal holds under every spelling (menu items stay off the generic list)', async () => {
        for (const twin of ['nav_menu_item ', 'NAV_MENU_ITEM', 'nav_menu_item\u200b', 'Revision']) {
            const res = await request(app).get('/api/v1/posts').query({ type: twin });
            assert.deepStrictEqual(ids(res).filter((id) => menuItemIds.includes(id)), [], `${JSON.stringify(twin)} listed menu items`);
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.code, 'rest_invalid_post_type');
        }
    });

    it('no over-block: the canonical names still work for the people who may read them', async () => {
        const admin = await as(adminToken)(request(app).get('/api/v1/posts')).query({ type: 'invoice', status: 'any' });
        assert.strictEqual(admin.status, 200);
        assert.deepStrictEqual(ids(admin).sort(), [...invoiceIds].sort(), 'the administrator lists every invoice');

        const posts = await request(app).get('/api/v1/posts');
        assert.strictEqual(posts.status, 200);
        assert.strictEqual(posts.body.length, 1, 'the default list is unchanged');

        const orphan = await request(app).get('/api/v1/posts').query({ type: 'not_a_type' });
        assert.strictEqual(orphan.status, 200, 'an unregistered type in the canonical alphabet stays listable');

        const slugTyped = await request(app).get('/api/v1/posts/slug/ordinary-post').query({ type: 'post' });
        assert.strictEqual(slugTyped.status, 200);
    });

    it('the slug route applies the same spelling rule as the list (one rule, no second guard to drift)', async () => {
        const slugTwin = await request(app).get('/api/v1/posts/slug/ordinary-post').query({ type: 'POST' });
        assert.strictEqual(slugTwin.status, 400);
        assert.strictEqual(slugTwin.body.code, 'rest_invalid_post_type');
    });

    describe('twin: the WXR importer\'s internal-type refusal', () => {
        let seq = 0;
        const item = (type: string, slug: string, status: string) => `
  <item>
    <title>${slug}</title>
    <wp:post_id>${++seq + 7000}</wp:post_id>
    <wp:post_name>${slug}</wp:post_name>
    <wp:post_type><![CDATA[${type}]]></wp:post_type>
    <wp:status>${status}</wp:status>
    <wp:post_parent>0</wp:post_parent>
    <content:encoded><![CDATA[<p>body</p>]]></content:encoded>
  </item>`;

        it('a type the database reads as `revision` or `nav_menu_item` is not imported under another spelling', async () => {
            const { importWxr } = require('../core/wxr-import');
            const twins: Array<[string, string]> = [
                ['Revision', 'wxr-forged-rev-1'],
                ['REVISION', 'wxr-forged-rev-2'],
                ['revisio\u0301n', 'wxr-forged-rev-3'],
                ['NAV_MENU_ITEM', 'wxr-forged-menu-1'],
                ['nav_menu_item\u200b', 'wxr-forged-menu-2'],
            ];
            const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/">
<channel>
  <title>Hostile</title>
  <link>https://hostile.example</link>${twins.map(([t, s]) => item(t, s, 'inherit')).join('')}${item('post', 'wxr-ordinary-r3', 'publish')}
</channel>
</rss>`;
            await importWxr(xml, { defaultAuthorId: 1, importComments: false });

            const rows = await dbAsync.all(`SELECT post_name, post_type FROM posts WHERE post_name LIKE 'wxr-%'`);
            const internal = rows.filter((r: any) => ['revision', 'nav_menu_item'].includes(mysqlUnicodeCiFold(String(r.post_type))));
            assert.deepStrictEqual(internal, [], 'rows MySQL reads as revisions / menu items were created from a third party file');
            assert.ok(rows.some((r: any) => r.post_name === 'wxr-ordinary-r3' && r.post_type === 'post'), 'precondition: the ordinary item imported');
        });
    });
});
