/**
 * WordJS — an IMPORTED attachment is stored like an UPLOADED one.
 *
 * The WordPress importer wrote only the original file: no thumbnail/medium/large, no width ladder, no
 * WebP/AVIF (that code lived inside routes/media.ts), SVG attachments were refused outright (the sanitizer
 * lived there too), and nothing went to the S3 media bucket, so an import on an offloaded site left files
 * only one node had. The importer now calls the same core modules the upload route does
 * (core/media-derivatives, core/svg-sanitize, core/media-storage). Pinned through importWxr() against a
 * local HTTP server serving the attachments and a fake S3-compatible bucket.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-wxr-media-parity-${STAMP}-`));
const TMP_UPLOADS = path.join(TMP_ROOT, 'uploads');
fs.mkdirSync(TMP_UPLOADS, { recursive: true });
config.dbPath = path.join(TMP_ROOT, 'wordjs.db');
config.dbDriver = 'sqlite-native';
config.uploads.dir = TMP_UPLOADS;
config.uploads.privateDir = path.join(TMP_ROOT, 'data', 'private-uploads');
config.nodeEnv = 'test'; // the importer's loopback exception for the fixture server (see wxr-import.test.ts)

const database = require('../config/database');
const sharp = require('sharp');
const mediaStorage = require('../core/media-storage');

const ACCESS_KEY = 'AKIAWXRPARITYTEST';
const BUCKET = 'wjs-import';
const objects = new Map<string, Buffer>();
const bucket = http.createServer((req: any, res: any) => {
    const url = new URL(req.url, 'http://x');
    const key = decodeURIComponent(url.pathname.slice(`/${BUCKET}/`.length));
    const signed = String(req.headers.authorization || '').startsWith(`AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/`);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
        if (!signed) { res.statusCode = 403; return res.end(); }
        if (req.method === 'PUT') { objects.set(key, Buffer.concat(chunks)); res.statusCode = 200; return res.end(); }
        const o = objects.get(key);
        if (req.method === 'HEAD') { if (!o) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Length', String(o.length)); return res.end(); }
        if (req.method === 'GET') { if (!o) { res.statusCode = 404; return res.end(); } return res.end(o); }
        res.statusCode = 405; res.end();
    });
});

let files: Record<string, { type: string; body: Buffer }> = {};
const origin = { url: '' };
const fixtures = http.createServer((req: any, res: any) => {
    const f = files[req.url];
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.type, 'content-length': String(f.body.length) });
    res.end(f.body);
});

const HOSTILE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)">'
    + '<script>alert(2)</script><rect width="10" height="10" fill="red"/>'
    + '<a href="javascript:alert(3)"><circle r="2"/></a></svg>';

function wxr(items: Array<{ id: number; file: string; mime: string }>): string {
    const item = (a: { id: number; file: string; mime: string }) => `
	<item>
		<title>${path.basename(a.file)}</title>
		<link>https://old.example/?attachment_id=${a.id}</link>
		<pubDate>Mon, 03 Feb 2025 08:00:00 +0000</pubDate>
		<dc:creator><![CDATA[admin]]></dc:creator>
		<guid isPermaLink="false">${origin.url}/wp-content/uploads/${a.file}</guid>
		<content:encoded><![CDATA[]]></content:encoded>
		<excerpt:encoded><![CDATA[]]></excerpt:encoded>
		<wp:post_id>${a.id}</wp:post_id>
		<wp:post_date><![CDATA[2025-02-03 08:00:00]]></wp:post_date>
		<wp:post_name><![CDATA[att-${a.id}]]></wp:post_name>
		<wp:status><![CDATA[inherit]]></wp:status>
		<wp:post_parent>0</wp:post_parent>
		<wp:post_type><![CDATA[attachment]]></wp:post_type>
		<wp:post_mime_type><![CDATA[${a.mime}]]></wp:post_mime_type>
		<wp:attachment_url><![CDATA[${origin.url}/wp-content/uploads/${a.file}]]></wp:attachment_url>
		<wp:postmeta><wp:meta_key><![CDATA[_wp_attached_file]]></wp:meta_key><wp:meta_value><![CDATA[${a.file}]]></wp:meta_value></wp:postmeta>
	</item>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
	<title>Parity</title><link>https://old.example</link><description></description>
	<wp:wxr_version>1.2</wp:wxr_version>
	<wp:base_site_url>https://old.example</wp:base_site_url><wp:base_blog_url>https://old.example</wp:base_blog_url>
	<wp:author><wp:author_id>1</wp:author_id><wp:author_login><![CDATA[admin]]></wp:author_login><wp:author_email><![CDATA[admin@old.example]]></wp:author_email></wp:author>
${items.map(item).join('\n')}
</channel>
</rss>`;
}

/** The attachment row an import created for `file` (found by the source URL the importer stamps). */
const attachmentFor = async (file: string) => database.getDbAsync().get(
    `SELECT post_id AS id FROM post_meta WHERE meta_key = '_wxr_source_url' AND meta_value = ?`, [`${origin.url}/wp-content/uploads/${file}`]);
const meta = async (id: number, key: string) => {
    const row = await database.getDbAsync().get('SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = ?', [id, key]);
    return row ? row.meta_value : null;
};

describe('WXR media import stores attachments the way an upload does', () => {
    let importWxr: any;
    let adminId = 0;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        const db = database.getDbAsync();
        const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('admin', 'x', 'admin@test.local', 'Admin')`);
        adminId = r.lastID;
        ({ importWxr } = require('../core/wxr-import'));
        await new Promise<void>((resolve) => fixtures.listen(0, '127.0.0.1', () => resolve()));
        origin.url = `http://127.0.0.1:${fixtures.address().port}`;
        await new Promise<void>((resolve) => bucket.listen(0, '127.0.0.1', () => resolve()));
    });

    after(async () => {
        for (const k of Object.values(mediaStorage.ENV_BY_FIELD) as string[]) delete process.env[k];
        await new Promise<void>((resolve) => fixtures.close(() => resolve()));
        await new Promise<void>((resolve) => bucket.close(() => resolve()));
        try { await database.closeDatabase(); } catch { /* */ }
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    it('an imported JPEG gets the size ladder and its WebP derivatives, recorded in its metadata', async () => {
        const jpeg = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: { r: 30, g: 90, b: 160 } } }).jpeg().toBuffer();
        files = { '/wp-content/uploads/2025/02/hero.jpg': { type: 'image/jpeg', body: jpeg } };
        const summary = await importWxr(wxr([{ id: 901, file: '2025/02/hero.jpg', mime: 'image/jpeg' }]), { defaultAuthorId: adminId, media: 'download', allowHttp: true });
        assert.strictEqual(summary.media.downloaded, 1, JSON.stringify(summary.media));
        const row = await attachmentFor('2025/02/hero.jpg');
        const md = JSON.parse(await meta(row.id, '_wp_attachment_metadata'));
        assert.strictEqual(md.width, 2000);
        assert.strictEqual(md.height, 1500);
        for (const name of ['thumbnail', 'medium', 'large', 'w640', 'w960', 'w1280', 'w1920']) {
            assert.ok(md.sizes[name], `size ${name} recorded`);
            assert.ok(fs.existsSync(path.join(TMP_UPLOADS, '2025', '02', md.sizes[name].file)), `size ${name} on disk`);
        }
        assert.ok(md.sources && md.sources['image/webp'], 'full-size WebP recorded');
        assert.ok(fs.existsSync(path.join(TMP_UPLOADS, '2025', '02', md.sources['image/webp'].file)));
    });

    it('an imported SVG is stored sanitized, never as the export sent it', async () => {
        files = { '/wp-content/uploads/2025/02/logo.svg': { type: 'image/svg+xml', body: Buffer.from(HOSTILE_SVG) } };
        const summary = await importWxr(wxr([{ id: 902, file: '2025/02/logo.svg', mime: 'image/svg+xml' }]), { defaultAuthorId: adminId, media: 'download', allowHttp: true });
        assert.strictEqual(summary.media.downloaded, 1, JSON.stringify(summary.media));
        const stored = fs.readFileSync(path.join(TMP_UPLOADS, '2025', '02', 'logo.svg'), 'utf8');
        assert.match(stored, /<rect/);
        assert.doesNotMatch(stored, /<script|onload|javascript:/i);
    });

    it('with an S3 media store, the original and every derivative go to the bucket and the row is offloaded', async () => {
        process.env.WORDJS_MEDIA_STORAGE = 's3';
        process.env.WORDJS_MEDIA_S3_BUCKET = BUCKET;
        process.env.WORDJS_MEDIA_S3_REGION = 'auto';
        process.env.WORDJS_MEDIA_S3_ENDPOINT = `http://127.0.0.1:${bucket.address().port}`;
        process.env.WORDJS_MEDIA_S3_ACCESS_KEY_ID = ACCESS_KEY;
        process.env.WORDJS_MEDIA_S3_SECRET_ACCESS_KEY = 'wxr-parity-secret-key-0123456789';
        try {
            const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
            files = { '/wp-content/uploads/2025/03/banner.png': { type: 'image/png', body: png } };
            const summary = await importWxr(wxr([{ id: 903, file: '2025/03/banner.png', mime: 'image/png' }]), { defaultAuthorId: adminId, media: 'download', allowHttp: true });
            assert.strictEqual(summary.media.downloaded, 1, JSON.stringify(summary.media));
            const row = await attachmentFor('2025/03/banner.png');
            const md = JSON.parse(await meta(row.id, '_wp_attachment_metadata'));
            const keys = Array.from(objects.keys());
            assert.ok(keys.some((k) => k.endsWith('2025/03/banner.png')), JSON.stringify(keys));
            assert.ok(keys.some((k) => k.endsWith(`2025/03/${md.sizes.thumbnail.file}`)), 'the thumbnail is in the bucket');
            assert.ok(await meta(row.id, '_wjs_media_storage'), 'the row says where its bytes are');
            assert.strictEqual(fs.existsSync(path.join(TMP_UPLOADS, '2025', '03', 'banner.png')), false, 'no local copy is kept');
        } finally {
            for (const k of Object.values(mediaStorage.ENV_BY_FIELD) as string[]) delete process.env[k];
        }
    });
});
