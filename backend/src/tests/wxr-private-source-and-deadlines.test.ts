/**
 * THE WORDPRESS IMPORT'S PRIVATE-SOURCE OPTION, AND ABSOLUTE DEADLINES ON HOST-SIDE DOWNLOADS.
 *
 *   1. "Allow downloads from this site's private address" is honoured on the primary site only (or with
 *      WORDJS_IMPORT_ALLOW_PRIVATE_SOURCE=1): on another site of a network core ignores it and the route
 *      refuses it with 403, and the import screen is told not to offer it.
 *   2. The exemption never reaches this machine: loopback is judged on the numeric address, so
 *      ::ffff:127.0.0.1 and the other spellings are refused like 127.0.0.1.
 *   3. From a private-network source only files whose content signature proves their declared type are
 *      stored: a text/JSON/CSV body (no signature) is refused, a real PNG is stored.
 *   4. A server that trickles bytes under the idle timeout is cut off at the absolute deadline — the
 *      WXR media fetch and the marketplace download alike.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-wxr-private-'));
process.chdir(TMP_ROOT);
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
config.uploads.dir = path.join(TMP_ROOT, 'uploads');
// The fixtures are served over http://127.0.0.1 — the importer's and marketplace's development seam.
config.nodeEnv = 'development';
const database = require('../config/database');
const siteContext = require('../core/site-context');
const jwt = require('jsonwebtoken');

// A 1x1 PNG: a body whose signature proves image/png.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const FILES: Record<string, { type: string; body: Buffer }> = {
    '/wp-content/uploads/2020/01/notes.txt': { type: 'text/plain', body: Buffer.from('internal admin page\n') },
    '/wp-content/uploads/2020/01/data.json': { type: 'application/json', body: Buffer.from('{"secret":true}') },
    '/wp-content/uploads/2020/01/pixel.png': { type: 'image/png', body: PNG },
};
const fixtures = http.createServer((req: any, res: any) => {
    const f = FILES[String(req.url)];
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.type, 'content-length': String(f.body.length) });
    res.end(f.body);
});
// Answers at once, then sends one byte every 100 ms forever: never idle, never finished.
const trickle = http.createServer((_req: any, res: any) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    const timer = setInterval(() => { try { res.write('x'); } catch { clearInterval(timer); } }, 100);
    res.on('close', () => clearInterval(timer));
});
let fixturesPort = 0;
let tricklePort = 0;

/** A non-loopback private IPv4 of this machine (the "WordPress on the LAN"), or null. */
function lanAddress(): string | null {
    const egress = require('../core/egress-guard');
    for (const list of Object.values(os.networkInterfaces()) as any[]) {
        for (const a of list || []) {
            if (a.family === 'IPv4' && !a.internal && egress.isBlockedIp(a.address) && !egress.isNeverExemptIp(a.address)) return a.address;
        }
    }
    return null;
}

let adminId = 0;
let importWxr: any;
before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    const db = database.getDbAsync();
    await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('admin', 'x', 'admin@example.com', 'Admin')`);
    adminId = (await db.get(`SELECT id FROM users WHERE user_login = 'admin'`)).id;
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [adminId]);
    ({ importWxr } = require('../core/wxr-import'));
    await new Promise<void>((r) => fixtures.listen(0, '0.0.0.0', r));
    fixturesPort = fixtures.address().port;
    await new Promise<void>((r) => trickle.listen(0, '127.0.0.1', r));
    tricklePort = trickle.address().port;
});
after(async () => {
    fixtures.close(); trickle.close();
    try { fixtures.closeAllConnections(); trickle.closeAllConnections(); } catch { /* */ }
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

let seq = 0;
/** A one-attachment WXR whose site (and attachment) live at `origin`. */
function wxr(origin: string, file: string, mime: string): string {
    const id = 7000 + (++seq);
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel><title>LAN</title><link>${origin}</link><wp:base_site_url>${origin}</wp:base_site_url><wp:base_blog_url>${origin}</wp:base_blog_url><wp:wxr_version>1.2</wp:wxr_version>
<item><title>a${id}</title><dc:creator><![CDATA[admin]]></dc:creator><content:encoded><![CDATA[]]></content:encoded><excerpt:encoded><![CDATA[]]></excerpt:encoded>
<wp:post_id>${id}</wp:post_id><wp:post_date>2020-01-01 00:00:00</wp:post_date><wp:post_date_gmt>2020-01-01 00:00:00</wp:post_date_gmt>
<wp:post_name>a${id}</wp:post_name><wp:status>inherit</wp:status><wp:post_parent>0</wp:post_parent><wp:post_type>attachment</wp:post_type><wp:post_password></wp:post_password><wp:is_sticky>0</wp:is_sticky>
<wp:attachment_url>${origin}/wp-content/uploads/${file}</wp:attachment_url><wp:post_mime_type>${mime}</wp:post_mime_type>
<wp:postmeta><wp:meta_key>_wp_attached_file</wp:meta_key><wp:meta_value><![CDATA[${file.replace(/(\.[a-z]+)$/, `-${id}$1`)}]]></wp:meta_value></wp:postmeta>
</item></channel></rss>`;
}
const reasons = (s: any) => s.media.failures.map((f: any) => f.reason).join(' | ');

describe('the private-source option', () => {
    const lan = lanAddress();

    it('from a LAN source on the primary site: a signature-less body is refused, a proven image is stored', { skip: lan ? false : 'no private IPv4 on this machine' }, async () => {
        const origin = `http://${lan}:${fixturesPort}`;
        for (const [file, mime] of [['2020/01/notes.txt', 'text/plain'], ['2020/01/data.json', 'application/json']]) {
            const s = await importWxr(wxr(origin, file, mime), { defaultAuthorId: adminId, media: 'download', allowHttp: true, allowPrivateSource: true });
            assert.strictEqual(s.media.downloaded, 0, `${file}: ${JSON.stringify(s.media)}`);
            assert.match(reasons(s), /signature could not be verified .* private-network source requires/, file);
        }
        const ok = await importWxr(wxr(origin, '2020/01/pixel.png', 'image/png'), { defaultAuthorId: adminId, media: 'download', allowHttp: true, allowPrivateSource: true });
        assert.strictEqual(ok.media.downloaded, 1, JSON.stringify(ok.media));
    });

    it('a text file from a PUBLIC source keeps importing as before (the rule is for private sources only)', async () => {
        const wm = require('../core/wxr-media');
        assert.strictEqual(await wm._magicByteProblem(Buffer.from('plain text'), 'text/plain', false), null);
        assert.match(String(await wm._magicByteProblem(Buffer.from('plain text'), 'text/plain', true)), /private-network source requires/);
        assert.match(String(await wm._magicByteProblem(PNG, 'image/jpeg', true)), /does not match the declared image\/jpeg/);
        assert.strictEqual(await wm._magicByteProblem(PNG, 'image/png', true), null);
    });

    it('loopback stays refused in every spelling, even with the option', async () => {
        for (const host of ['127.0.0.1', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::1]']) {
            const s = await importWxr(wxr(`https://${host}:${fixturesPort}`, '2020/01/pixel.png', 'image/png'), { defaultAuthorId: adminId, media: 'download', allowPrivateSource: true });
            assert.strictEqual(s.media.downloaded, 0, host);
            assert.match(reasons(s), /no import may reach/, `${host}: ${reasons(s)}`);
        }
    });

    it('on a secondary site of a network the option is ignored by core and refused by the route', async () => {
        const lan = lanAddress() || '192.168.1.20';
        const wm = require('../core/wxr-media');
        const saved = (config as any).multisite;
        (config as any).multisite = { enabled: true };
        try {
            assert.strictEqual(siteContext.runWithSite(1, () => wm.privateSourceAllowed()), true);
            assert.strictEqual(siteContext.runWithSite(2, () => wm.privateSourceAllowed()), false);
            // Core: the importer treats it as not set there, whatever its caller passed.
            const settingsOn = (site: number) => siteContext.runWithSite(site, () => wm.createMediaImporter({ media: 'download', privateSourceHost: String(lan) }).settings.privateSourceHost);
            assert.strictEqual(settingsOn(1), String(lan));
            assert.strictEqual(settingsOn(2), null);
            // The operator's explicit opt-in opens it there too.
            process.env.WORDJS_IMPORT_ALLOW_PRIVATE_SOURCE = '1';
            assert.strictEqual(siteContext.runWithSite(2, () => wm.privateSourceAllowed()), true);
        } finally {
            delete process.env.WORDJS_IMPORT_ALLOW_PRIVATE_SOURCE;
            (config as any).multisite = saved;
        }
    });

    it('the route answers 403 for the option where it is not allowed, and tells the screen not to offer it', async () => {
        const express = require('express');
        const request = require('supertest');
        const wm = require('../core/wxr-media');
        const realAllowed = wm.privateSourceAllowed;
        // The route reads the rule through core/wxr-media; drive both answers without a network.
        delete require.cache[require.resolve('../routes/import')];
        let allowed = false;
        wm.privateSourceAllowed = () => allowed;
        try {
            const router = require('../routes/import');
            const { errorHandler } = require('../middleware/errorHandler');
            const app = express();
            app.use(express.json());
            app.use('/api/v1/import', router);
            app.use(errorHandler);
            const token = jwt.sign({ userId: adminId, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
            const file = Buffer.from(wxr('https://old.example', '2020/01/pixel.png', 'image/png'));
            const post = (url: string, fields: Record<string, string>) => {
                let r = request(app).post(url).set('Authorization', `Bearer ${token}`);
                for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
                return r.attach('file', file, 'export.xml');
            };
            const analyzed = await post('/api/v1/import/wordpress/analyze', {});
            assert.strictEqual(analyzed.status, 200, JSON.stringify(analyzed.body));
            assert.strictEqual(analyzed.body.privateSourceAllowed, false);
            const refused = await post('/api/v1/import/wordpress', { media: 'skip', allowPrivateSource: '1' });
            assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
            assert.strictEqual(refused.body.code, 'private_source_not_allowed');
            const plain = await post('/api/v1/import/wordpress', { media: 'skip', allowPrivateSource: '0' });
            assert.strictEqual(plain.status, 200, JSON.stringify(plain.body));
            allowed = true;
            assert.strictEqual((await post('/api/v1/import/wordpress/analyze', {})).body.privateSourceAllowed, true);
        } finally {
            wm.privateSourceAllowed = realAllowed;
            delete require.cache[require.resolve('../routes/import')];
        }
    });
});

describe('absolute download deadlines', () => {
    it('a WXR attachment that trickles under the idle timeout is cut off at the deadline', { timeout: 20000 }, async () => {
        const started = Date.now();
        const s = await importWxr(wxr(`http://127.0.0.1:${tricklePort}`, '2020/01/slow.png', 'image/png'), {
            defaultAuthorId: adminId, media: 'download', allowHttp: true, timeoutMs: 5000, deadlineMs: 700,
        });
        assert.strictEqual(s.media.downloaded, 0);
        assert.match(reasons(s), /exceeded its time limit/, reasons(s));
        assert.ok(Date.now() - started < 4000, `cut off at the deadline, not the idle timeout (${Date.now() - started} ms)`);
    });

    it('a marketplace download that trickles is cut off at the deadline', { timeout: 20000 }, async () => {
        const { _fetchRemote } = require('../routes/marketplace');
        const started = Date.now();
        await assert.rejects(_fetchRemote(`http://127.0.0.1:${tricklePort}/plugin.zip`, 10 * 1024 * 1024, 0, Date.now() + 700), /tiempo máximo/);
        assert.ok(Date.now() - started < 4000, `${Date.now() - started} ms`);
    });
});

describe('WXR text and the import form', () => {
    it('entities in text nodes are decoded (titles, attachment URLs); CDATA stays verbatim; a DOCTYPE is refused', async () => {
        const { parseWxr } = require('../core/wxr-import');
        const doc = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel><title>Q &amp; A</title><link>https://old.example</link><wp:base_site_url>https://old.example</wp:base_site_url><wp:wxr_version>1.2</wp:wxr_version>
<item><title>Tom &amp; Jerry&#8217;s &quot;show&quot;</title><content:encoded><![CDATA[<p>Fish &amp; chips &lt;b&gt;</p>]]></content:encoded>
<wp:post_id>1</wp:post_id><wp:post_type>attachment</wp:post_type><wp:attachment_url>https://old.example/a.jpg?w=1&amp;h=2</wp:attachment_url></item>
</channel></rss>`;
        const p = parseWxr(doc);
        assert.strictEqual(p.site.title, 'Q & A');
        const item = p.items[0];
        assert.strictEqual(String(item.title), 'Tom & Jerry’s "show"');
        assert.strictEqual(String(item['wp:attachment_url']), 'https://old.example/a.jpg?w=1&h=2');
        assert.strictEqual(String(item['content:encoded']), '<p>Fish &amp; chips &lt;b&gt;</p>', 'CDATA is markup, taken as written');

        const bomb = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><rss version="2.0"><channel><title>&b;</title></channel></rss>`;
        assert.throws(() => parseWxr(bomb), /not a valid WordPress WXR file \(a DOCTYPE declaration is not allowed\)/i);
        assert.throws(() => parseWxr(bomb.replace('<!DOCTYPE', '<!doctype')), /DOCTYPE declaration is not allowed/);
    });

    it('a form option sent twice is refused (an array never reads as the opt-out it carries)', async () => {
        const express = require('express');
        const request = require('supertest');
        delete require.cache[require.resolve('../routes/import')];
        const router = require('../routes/import');
        const { errorHandler } = require('../middleware/errorHandler');
        const app = express();
        app.use(express.json());
        app.use('/api/v1/import', router);
        app.use(errorHandler);
        const token = jwt.sign({ userId: adminId, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
        const file = Buffer.from(wxr('https://old.example', '2020/01/pixel.png', 'image/png'));
        for (const field of ['importAttachments', 'importComments', 'media', 'allowHttp', 'allowPrivateSource', 'defaultAuthorId']) {
            const res = await request(app).post('/api/v1/import/wordpress').set('Authorization', `Bearer ${token}`)
                .field(field, '0').field(field, '0').attach('file', file, 'export.xml');
            assert.strictEqual(res.status, 400, `${field}: ${JSON.stringify(res.body)}`);
            assert.strictEqual(res.body.code, 'rest_invalid_param');
            assert.match(res.body.message, new RegExp(field));
        }
        const once = await request(app).post('/api/v1/import/wordpress').set('Authorization', `Bearer ${token}`)
            .field('importAttachments', '0').attach('file', file, 'export.xml');
        assert.strictEqual(once.status, 200, JSON.stringify(once.body));
        assert.strictEqual(once.body.summary.media.mode, 'skip', 'the single opt-out applies');
    });
});
