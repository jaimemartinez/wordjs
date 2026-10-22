/**
 * WordPress import fidelity and the visibility features it carries (QA of the three deploy modes):
 *   · M3-06 / X3-07 — a WordPress page whose slug matches unrelated content of this site (the sample
 *     "About") is imported under another slug instead of being dropped; a re-run still matches it;
 *   · M3-09 — sticky posts come over (`wp:is_sticky`) and `GET /posts?sticky=` lists them; `[gallery]`
 *     renders the post's images; a password-protected entry is unlocked with its password
 *     (POST /posts/:id/unlock) and its password can be changed and cleared;
 *   · M3-05 — a link-mode attachment's featured image points at the remote file, an attachment without
 *     `wp:post_mime_type` is typed by its extension, and a private-network source gets an importer
 *     message (not the plugin sandbox's) and stays refused for loopback even with the opt-in;
 *   · M3-16 — imported dates use the same clock as native posts (post_date derived from post_date_gmt).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-wxr-qa-'));
process.chdir(TMP_ROOT);
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
config.uploads.dir = path.join(TMP_ROOT, 'uploads');
const database = require('../config/database');
const jwt = require('jsonwebtoken');

let dbAsync: any, adminId: number, importWxr: any, Post: any, request: any, app: any, token: string;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('admin', 'x', 'admin@example.com', 'Admin')`);
    adminId = (await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`)).id;
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [adminId]);
    ({ importWxr } = require('../core/wxr-import'));
    Post = require('../models/Post');
    request = require('supertest');
    const express = require('express');
    const { errorHandler } = require('../middleware/errorHandler');
    app = express();
    app.use(express.json());
    app.use('/api/v1/posts', require('../routes/posts'));
    app.use(errorHandler);
    token = jwt.sign({ userId: adminId, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
});

after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

const SITE = 'https://old.example';
const wxr = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel><title>Old</title><link>${SITE}</link><wp:base_site_url>${SITE}</wp:base_site_url><wp:base_blog_url>${SITE}</wp:base_blog_url><wp:wxr_version>1.2</wp:wxr_version>
${items}
</channel></rss>`;
const item = (f: Record<string, string>, meta: Record<string, string> = {}) => `<item>
<title>${f.title || ''}</title><dc:creator><![CDATA[admin]]></dc:creator>
<content:encoded><![CDATA[${f.content || ''}]]></content:encoded><excerpt:encoded><![CDATA[]]></excerpt:encoded>
<wp:post_id>${f.id}</wp:post_id><wp:post_date>${f.date || '2013-03-15 15:41:09'}</wp:post_date><wp:post_date_gmt>${f.gmt || '2013-03-15 20:41:09'}</wp:post_date_gmt>
<wp:post_name>${f.slug}</wp:post_name><wp:status>${f.status || 'publish'}</wp:status><wp:post_parent>${f.parent || '0'}</wp:post_parent>
<wp:post_type>${f.type || 'post'}</wp:post_type><wp:post_password>${f.password || ''}</wp:post_password><wp:is_sticky>${f.sticky || '0'}</wp:is_sticky>
${f.url ? `<wp:attachment_url>${f.url}</wp:attachment_url>` : ''}${f.mime !== undefined ? `<wp:post_mime_type>${f.mime}</wp:post_mime_type>` : ''}
${Object.entries(meta).map(([k, v]) => `<wp:postmeta><wp:meta_key>${k}</wp:meta_key><wp:meta_value><![CDATA[${v}]]></wp:meta_value></wp:postmeta>`).join('')}
</item>`;

test('M3-06: a page whose slug is already used by unrelated content is imported under another slug, and a re-run matches it', async () => {
    const sample = await Post.create({ title: 'About', content: '<p>Sample about page</p>', status: 'publish', type: 'page', slug: 'about', authorId: adminId });
    const xml = wxr(item({ id: '2', title: 'About The Tests', slug: 'about', type: 'page', content: '<p>WordPress about</p>' })
        + item({ id: '3', title: 'Page Image Alignment', slug: 'page-image-alignment', type: 'page', parent: '2' }));
    const s1 = await importWxr(xml, { defaultAuthorId: adminId, media: 'skip' });
    assert.strictEqual(s1.pages.created, 2, JSON.stringify(s1));
    assert.ok(s1.errors.some((e: string) => /already has unrelated content/.test(e)), 'the rename is reported');
    const imported = await dbAsync.get(`SELECT id, post_name, post_content FROM posts WHERE post_title = 'About The Tests'`);
    assert.notStrictEqual(imported.post_name, 'about');
    assert.match(imported.post_content, /WordPress about/);
    const child = await dbAsync.get(`SELECT post_parent FROM posts WHERE post_name = 'page-image-alignment'`);
    assert.strictEqual(child.post_parent, imported.id, 'the children hang off the imported page, not the sample one');
    const untouched = await dbAsync.get(`SELECT post_content FROM posts WHERE id = ?`, [sample.id]);
    assert.match(untouched.post_content, /Sample about page/);
    // Run it again: the imported page is recognised (its marker), nothing is duplicated.
    const s2 = await importWxr(xml, { defaultAuthorId: adminId, media: 'skip' });
    assert.strictEqual(s2.pages.created, 0, JSON.stringify(s2));
    const count = await dbAsync.get(`SELECT COUNT(*) AS c FROM posts WHERE post_title = 'About The Tests'`);
    assert.strictEqual(Number(count.c), 1);
});

test('M3-16: an imported post keeps its moment, stored on this site\'s clock like a native post', async () => {
    await importWxr(wxr(item({ id: '10', title: 'Dated', slug: 'dated', date: '2013-03-15 15:41:09', gmt: '2013-03-15 20:41:09' })), { defaultAuthorId: adminId, media: 'skip' });
    const row = await dbAsync.get(`SELECT post_date, post_date_gmt FROM posts WHERE post_name = 'dated'`);
    assert.strictEqual(row.post_date_gmt, '2013-03-15 20:41:09');
    const expected = require('../core/formatting').formatDate(new Date(Date.UTC(2013, 2, 15, 20, 41, 9)));
    assert.strictEqual(row.post_date, expected, 'post_date is the gmt moment in the server clock, not the WordPress wall time');
});

test('M3-09: sticky posts come over and GET /posts?sticky= lists them', async () => {
    await importWxr(wxr(item({ id: '20', title: 'Sticky one', slug: 'sticky-one', sticky: '1' }) + item({ id: '21', title: 'Plain one', slug: 'plain-one' })), { defaultAuthorId: adminId, media: 'skip' });
    const stuck = await request(app).get('/api/v1/posts?sticky=true&per_page=100');
    assert.strictEqual(stuck.status, 200);
    assert.deepStrictEqual(stuck.body.map((p: any) => p.slug), ['sticky-one']);
    assert.strictEqual(stuck.body[0].sticky, true);
    const rest = await request(app).get('/api/v1/posts?sticky=false&per_page=100');
    assert.ok(!rest.body.some((p: any) => p.slug === 'sticky-one') && rest.body.some((p: any) => p.slug === 'plain-one'));
    // Unstick from the editor (PUT sticky:false).
    const id = stuck.body[0].id;
    const put = await request(app).put(`/api/v1/posts/${id}`).set('Authorization', `Bearer ${token}`).send({ sticky: false });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    const after = await request(app).get('/api/v1/posts?sticky=true');
    assert.deepStrictEqual(after.body, []);
});

test('M3-09: [gallery] renders the post\'s public images (bare, or by ids)', async () => {
    const parent = await Post.create({ title: 'Gallery post', content: '[gallery columns="2"]', status: 'publish', authorId: adminId });
    for (const n of [1, 2]) {
        await dbAsync.run(`INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_name, post_type, post_mime_type, post_parent, guid) VALUES (?, ?, '', ?, 'inherit', ?, 'attachment', 'image/jpeg', ?, ?)`,
            [adminId, `Img ${n}`, n === 1 ? 'A caption' : '', `img-${n}`, parent.id, `/uploads/2026/10/img-${n}.jpg`]);
    }
    await dbAsync.run(`INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_name, post_type, post_mime_type, post_parent, guid) VALUES (?, 'Secret', '', '', 'private', 'secret-img', 'attachment', 'image/jpeg', ?, '/x.jpg')`, [adminId, parent.id]);
    const res = await request(app).get(`/api/v1/posts/${parent.id}`);
    const html = res.body.content;
    assert.match(html, /class="gallery gallery-columns-2/);
    assert.strictEqual((html.match(/<img /g) || []).length, 2, 'two public images, the private one is left out');
    assert.match(html, /img-1\.jpg/);
    assert.match(html, /A caption/);
    const ids = (await dbAsync.all(`SELECT id FROM posts WHERE post_name IN ('img-2', 'img-1') ORDER BY post_name DESC`)).map((r: any) => r.id);
    const byIds = await Post.create({ title: 'By ids', content: `[gallery ids="${ids.join(',')}"]`, status: 'publish', authorId: adminId });
    const html2 = (await request(app).get(`/api/v1/posts/${byIds.id}`)).body.content;
    assert.ok(html2.indexOf('img-2') < html2.indexOf('img-1'), 'the order given by ids');
});

test('M3-09: a password-protected entry unlocks with its password; the editor can change and clear it', async () => {
    await importWxr(wxr(item({ id: '30', title: 'Protected', slug: 'protected-one', password: 'enter', content: '<p>Hidden body</p>' })), { defaultAuthorId: adminId, media: 'skip' });
    const row = await dbAsync.get(`SELECT id FROM posts WHERE post_name = 'protected-one'`);
    const anon = await request(app).get(`/api/v1/posts/${row.id}`);
    assert.strictEqual(anon.body.protected, true);
    assert.strictEqual(anon.body.content, '');
    assert.strictEqual(anon.body.password, undefined, 'the password never reaches a reader');
    const wrong = await request(app).post(`/api/v1/posts/${row.id}/unlock`).send({ password: 'nope' });
    assert.strictEqual(wrong.status, 403);
    // Near misses of any length are refused alike (constant-time match of the zero-padded bytes, plus
    // equal lengths — so the password followed by NUL bytes is not it either).
    for (const attempt of ['ente', 'enter ', 'ENTER', 'enterenter', 'éntér', 'enter\u0000']) {
        const r = await request(app).post(`/api/v1/posts/${row.id}/unlock`).send({ password: attempt });
        assert.strictEqual(r.status, 403, attempt);
    }
    const ok = await request(app).post(`/api/v1/posts/${row.id}/unlock`).send({ password: 'enter' });
    assert.strictEqual(ok.status, 200);
    assert.match(ok.body.content, /Hidden body/);
    const asAdmin = await request(app).get(`/api/v1/posts/${row.id}`).set('Authorization', `Bearer ${token}`);
    assert.strictEqual(asAdmin.body.password, 'enter', 'the editor sees the password');
    const cleared = await request(app).put(`/api/v1/posts/${row.id}`).set('Authorization', `Bearer ${token}`).send({ password: '' });
    assert.strictEqual(cleared.status, 200);
    const pub = await request(app).get(`/api/v1/posts/${row.id}`);
    assert.strictEqual(pub.body.protected, false);
    assert.match(pub.body.content, /Hidden body/);
    const notProtected = await request(app).post(`/api/v1/posts/${row.id}/unlock`).send({ password: 'enter' });
    assert.strictEqual(notProtected.status, 404);
});

test('M3-05: link mode — the featured image is the remote file, and a missing MIME type comes from the extension', async () => {
    const xml = wxr(
        item({ id: '40', title: 'With image', slug: 'with-image' }, { _thumbnail_id: '41' })
        + item({ id: '41', title: 'Remote photo', slug: 'remote-photo', type: 'attachment', status: 'inherit', url: `${SITE}/wp-content/uploads/2013/03/photo.jpg` }, { _wp_attached_file: '2013/03/photo.jpg' })
    );
    const s = await importWxr(xml, { defaultAuthorId: adminId, media: 'link' });
    assert.strictEqual(s.media.linked, 1, JSON.stringify(s.media));
    const att = await dbAsync.get(`SELECT post_mime_type FROM posts WHERE post_type = 'attachment' AND post_title = 'Remote photo'`);
    assert.strictEqual(att.post_mime_type, 'image/jpeg');
    const post = await dbAsync.get(`SELECT id FROM posts WHERE post_name = 'with-image'`);
    const res = await request(app).get(`/api/v1/posts/${post.id}`);
    assert.strictEqual(res.body.featuredMedia.url, `${SITE}/wp-content/uploads/2013/03/photo.jpg`);
    assert.strictEqual(res.body.featuredMedia.path, undefined, 'no local path for a file that is not here');
});

test('M3-05: a private-network source is refused with an importer message; loopback stays refused even with the opt-in', async () => {
    const xml = (host: string) => wxr(item({ id: '50', title: 'LAN photo', slug: `lan-photo-${host.replace(/\W/g, '')}`, type: 'attachment', status: 'inherit', url: `https://${host}/wp-content/uploads/2020/01/a.jpg` }, { _wp_attached_file: '2020/01/a.jpg' }))
        .replace(`<link>${SITE}</link>`, `<link>https://${host}</link>`).split(SITE).join(`https://${host}`);
    const refused = await importWxr(xml('10.255.255.1'), { defaultAuthorId: adminId, media: 'download' });
    const reason = refused.media.failures.map((f: any) => f.reason).join(' | ');
    assert.match(reason, /is on a private network/);
    assert.doesNotMatch(reason, /for plugins/);
    const loop = await importWxr(xml('127.0.0.1'), { defaultAuthorId: adminId, media: 'download', allowPrivateSource: true });
    assert.match(loop.media.failures.map((f: any) => f.reason).join(' | '), /no import may reach/);
});

test('S3-08: a save over a newer version is refused (409) when the editor sends the version it loaded', async () => {
    const created = await Post.create({ title: 'Two tabs', content: '<p>v1</p>', status: 'draft', authorId: adminId });
    const loaded = (await request(app).get(`/api/v1/posts/${created.id}`).set('Authorization', `Bearer ${token}`)).body.modified;
    // Tab A saves (a second later, so the stored modified moves on).
    await new Promise((r) => setTimeout(r, 1100));
    const a = await request(app).put(`/api/v1/posts/${created.id}`).set('Authorization', `Bearer ${token}`).send({ title: 'Two tabs A', expectedModified: loaded });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    // Tab B still holds the version it opened.
    const b = await request(app).put(`/api/v1/posts/${created.id}`).set('Authorization', `Bearer ${token}`).send({ title: 'Two tabs B', expectedModified: loaded });
    assert.strictEqual(b.status, 409);
    assert.strictEqual(b.body.code, 'rest_post_conflict');
    assert.strictEqual((await dbAsync.get('SELECT post_title FROM posts WHERE id = ?', [created.id])).post_title, 'Two tabs A', 'A\'s change survives');
    // Choosing to overwrite (no expectedModified) goes through, as every client without the field does.
    const forced = await request(app).put(`/api/v1/posts/${created.id}`).set('Authorization', `Bearer ${token}`).send({ title: 'Two tabs B' });
    assert.strictEqual(forced.status, 200);
});

test('M3-18 / X3-24: a .mov attachment is accepted (WordPress allows video/quicktime)', async () => {
    const xml = wxr(item({ id: '70', title: 'Slider video', slug: 'slider-video-mov', type: 'attachment', status: 'inherit', url: `${SITE}/wp-content/uploads/2014/01/slider.mov`, mime: 'video/quicktime' }, { _wp_attached_file: '2014/01/slider.mov' }));
    const s = await importWxr(xml, { defaultAuthorId: adminId, media: 'link' });
    assert.strictEqual(s.media.linked, 1, JSON.stringify(s.media));
    assert.ok(!s.media.failures.some((f: any) => /\.mov is not an allowed/.test(f.reason)), JSON.stringify(s.media.failures));
    const Media = require('../models/Media');
    assert.strictEqual(Media.getExtensionForMime('video/quicktime'), 'mov');
});

test('M3-18: WordPress site-editor records (wp_navigation, templates, styles) are left out and counted apart', async () => {
    const xml = wxr(
        item({ id: '80', title: 'Navigation', slug: 'navigation', type: 'wp_navigation', content: '<!-- wp:navigation-link /-->' })
        + item({ id: '81', title: 'Single', slug: 'single', type: 'wp_template' })
        + item({ id: '82', title: 'A real post', slug: 'a-real-post-m318' })
    );
    const s = await importWxr(xml, { defaultAuthorId: adminId, media: 'skip' });
    assert.strictEqual(s.posts.created, 1, 'only the real post is a post');
    assert.strictEqual(s.siteEditor.skipped, 2);
    const stray = await dbAsync.get("SELECT COUNT(*) AS c FROM posts WHERE post_type IN ('wp_navigation', 'wp_template')");
    assert.strictEqual(Number(stray.c), 0);
});
