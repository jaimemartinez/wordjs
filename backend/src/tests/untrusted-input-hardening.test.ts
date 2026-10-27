/**
 * UNTRUSTED INPUT THAT BECOMES MARKUP, A NETWORK TARGET OR A TABLE WRITE.
 *
 *   A. escUrl / the core shortcodes: whatever URL a post body names, the attribute it lands in stays
 *      one attribute (quotes inside a mailto:/tel: URL are percent-encoded and every sink escapes), and a
 *      media source is http(s) only.
 *   B. The SVG sanitizer: URL attributes are scheme-checked (xlink:href included), `style` keeps only
 *      presentation properties with plain values or a same-document url(#id), <image> takes no data:
 *      URL, and camelCase SVG elements survive.
 *   C. seo-helper exports only the generators something calls (sitemap, robots.txt, RSS).
 *   D. The egress guard: benchmarking (198.18.0.0/15) and local-use NAT64 (64:ff9b:1::/48) are internal,
 *      and isLoopbackIp recognises this machine in every numeric spelling.
 *   E. The site import's custom tables: only a plugin's or theme's own wjp_<slug>_ table of something
 *      installed here; the export carries nothing else either.
 *
 * CWD/DB sandbox ordering as in safe-sql.test.ts: chdir into a temp root and repoint config.dbPath
 * BEFORE the DB layer is required.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-untrusted-input-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins', 'shop-kit'), { recursive: true });
fs.mkdirSync(path.join(TMP_ROOT, 'themes', 'quiet'), { recursive: true });
process.chdir(TMP_ROOT);
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
});
after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

/** Every attribute name of every start tag in `html` (a quote that escaped its attribute shows up here). */
function attributeNames(html: string): string[] {
    const names: string[] = [];
    for (const tag of html.match(/<[a-z][^>]*>/gi) || []) {
        const body = tag.replace(/^<[a-z0-9]+/i, '').replace(/"[^"]*"/g, '""');
        for (const m of body.matchAll(/([a-z-]+)\s*=/gi)) names.push(m[1].toLowerCase());
    }
    return names;
}

describe('A. escUrl and the shortcode URL sinks', () => {
    const { escUrl, escMediaUrl } = require('../core/formatting');
    const { doShortcode } = require('../core/shortcodes');

    it('escUrl never returns a quote, angle bracket or backtick, whatever the scheme', () => {
        for (const raw of [
            'mailto:a@example.com" onmouseover="alert(1)',
            "tel:123' onfocus='x",
            'mailto:a@example.com?subject=<b>`x`</b>',
            'https://example.com/a"b\'c<d>e',
        ]) {
            const out = escUrl(raw);
            assert.ok(out, `still a URL: ${raw}`);
            assert.doesNotMatch(out, /["'<>`\s]/, `${raw} → ${out}`);
        }
        assert.strictEqual(escUrl('javascript:alert(1)'), '');
        assert.strictEqual(escUrl('https://example.com/x?a=1&b=2'), 'https://example.com/x?a=1&b=2');
    });

    it('a media source is http(s) only', () => {
        assert.strictEqual(escMediaUrl('mailto:a@example.com'), '');
        assert.strictEqual(escMediaUrl('tel:123'), '');
        assert.strictEqual(escMediaUrl('https://cdn.example/a.mp3'), 'https://cdn.example/a.mp3');
    });

    it('[button], [embed], [audio] and [video] keep each URL inside its own attribute', () => {
        const cases = [
            `[button url='mailto:a@example.com" onmouseover="alert(1)']Go[/button]`,
            `[embed]mailto:a@example.com" onmouseover="alert(1)[/embed]`,
            `[audio src='mailto:a@example.com" onplay="alert(1)']`,
            `[video src='tel:1" onerror="alert(1)' poster='tel:1" onerror="alert(2)']`,
        ];
        for (const body of cases) {
            const html = doShortcode(body);
            const names = attributeNames(html);
            assert.ok(!names.some((n) => n.startsWith('on')), `${body}\n→ ${html}\n(attributes: ${names.join(', ')})`);
        }
        // mailto:/tel: are refused as media; the element renders with an empty source.
        assert.match(doShortcode(`[audio src="mailto:a@example.com"]`), /<source src="">/);
        assert.match(doShortcode(`[video src="tel:123"]`), /<source src="">/);
        // Ordinary URLs are unchanged (the & of a query string is entity-escaped in the attribute).
        assert.match(doShortcode('[button url="https://example.com/p?a=1&b=2"]Go[/button]'), /href="https:\/\/example\.com\/p\?a=1&amp;b=2"/);
        assert.match(doShortcode('[audio src="https://cdn.example/a.mp3"]'), /<source src="https:\/\/cdn\.example\/a\.mp3">/);
    });

    it('content stored HTML-escaped (&amp;, &quot;) is decoded once: no double escaping, and no way out of the attribute', () => {
        // The post sanitizer stores `&` as `&amp;`: the link must still carry ?a=1&b=2, escaped exactly once.
        assert.match(doShortcode('[button url="https://example.com/p?a=1&amp;b=2"]Go[/button]'), /href="https:\/\/example\.com\/p\?a=1&amp;b=2"/);
        assert.match(doShortcode('[embed]https://example.com/v?x=1&amp;y=2[/embed]'), /href="https:\/\/example\.com\/v\?x=1&amp;y=2">https:\/\/example\.com\/v\?x=1&amp;y=2<\/a>/);
        for (const body of [
            '[button url="mailto:a@example.com&quot; onmouseover=&quot;alert(1)"]Go[/button]',
            '[button url="mailto:a@example.com&#34; onmouseover=&#x22;alert(1)"]Go[/button]',
            '[embed]mailto:a@example.com&quot; onfocus=&quot;alert(1)[/embed]',
        ]) {
            const html = doShortcode(body);
            assert.ok(!attributeNames(html).some((n) => n.startsWith('on')), `${body}\n→ ${html}`);
        }
    });
});

describe('B. the SVG sanitizer', () => {
    const { sanitizeSvg } = require('../core/svg-sanitize');

    it('scheme-checks href and xlink:href on every element', () => {
        for (const svg of [
            '<svg><use xlink:href="javascript:alert(1)"/></svg>',
            '<svg><use href="javascript:alert(1)"/></svg>',
            '<svg><use xlink:href=" jav&#x09;ascript:alert(1)"/></svg>',
        ]) {
            assert.doesNotMatch(sanitizeSvg(svg), /javascript/i, svg);
        }
        assert.match(sanitizeSvg('<svg><use xlink:href="#icon"/></svg>'), /xlink:href="#icon"/, 'a same-document reference stays');
    });

    it('an <image> loads http(s) only — never a data: document', () => {
        assert.doesNotMatch(sanitizeSvg('<svg><image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/></svg>'), /data:/);
        assert.doesNotMatch(sanitizeSvg('<svg><image xlink:href="data:text/html,x"/></svg>'), /data:/);
        assert.match(sanitizeSvg('<svg><image href="https://cdn.example/a.png"/></svg>'), /href="https:\/\/cdn\.example\/a\.png"/);
    });

    it('style keeps presentation properties with plain values or url(#id), and nothing else', () => {
        const out = sanitizeSvg('<svg><rect style="fill:url(https://tracker.example/p.png);stroke:#000;behavior:url(x.htc);opacity:.5;background-image:url(//x)"/></svg>');
        assert.doesNotMatch(out, /tracker|behavior|background|\/\/x/, out);
        assert.match(out, /stroke:#000/);
        assert.match(out, /opacity:\.5|opacity:0\.5/);
        assert.match(sanitizeSvg('<svg><rect style="fill:url(#grad)"/></svg>'), /fill:url\(#grad\)/);
    });

    it('camelCase SVG elements survive (they are not lower-cased out of the allowlist)', () => {
        const out = sanitizeSvg('<svg><defs><linearGradient id="g"><stop offset="0"/></linearGradient><clipPath id="c"><rect/></clipPath></defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></svg>');
        assert.match(out, /<linearGradient id="g">/);
        assert.match(out, /<clipPath id="c">/);
        assert.match(out, /<feGaussianBlur stdDeviation="2">/);
    });
});

describe('C. seo-helper', () => {
    it('exports only the generators the server uses; no unescaped JSON-LD builders remain', () => {
        const seo = require('../core/seo-helper');
        for (const gone of ['generateJsonLd', 'generateWebsiteSchema', 'generateBreadcrumbSchema', 'generateMetaTags']) {
            assert.strictEqual(seo[gone], undefined, `${gone} is still exported`);
        }
        for (const kept of ['generateSitemap', 'generateRobotsTxt', 'generateRssFeed', 'escapeHtml']) {
            assert.strictEqual(typeof seo[kept], 'function', kept);
        }
    });
});

describe('D. the egress guard', () => {
    const egress = require('../core/egress-guard');

    it('198.18.0.0/15 (benchmarking) is internal', () => {
        assert.strictEqual(egress.isBlockedIp('198.18.0.1'), true);
        assert.strictEqual(egress.isBlockedIp('198.19.255.254'), true);
        assert.strictEqual(egress.isBlockedIp('::ffff:198.18.0.1'), true);
        assert.strictEqual(egress.isBlockedIp('198.17.255.255'), false);
        assert.strictEqual(egress.isBlockedIp('198.20.0.1'), false);
    });

    it('64:ff9b:1::/48 (local-use NAT64) is internal whatever it embeds; the well-known prefix is unchanged', () => {
        assert.strictEqual(egress.isBlockedIp('64:ff9b:1::808:808'), true);
        assert.strictEqual(egress.isBlockedIp('64:ff9b:1:abcd::1'), true);
        assert.strictEqual(egress.isNeverExemptIp('64:ff9b:1::a9fe:a9fe'), true, 'its metadata spelling is never approvable');
        assert.strictEqual(egress.isBlockedIp('64:ff9b::808:808'), false, 'public NAT64 targets stay reachable');
        assert.strictEqual(egress.isBlockedIp('64:ff9b::a00:1'), true);
    });

    it('isLoopbackIp recognises this machine in every numeric spelling, and nothing else', () => {
        for (const ip of ['127.0.0.1', '127.1.2.3', '0.0.0.0', '::1', '0:0:0:0:0:0:0:1', '::', '[::1]',
            '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:0001', '64:ff9b::7f00:1', '2002:7f00:1::', 'not-an-ip']) {
            assert.strictEqual(egress.isLoopbackIp(ip), true, ip);
        }
        for (const ip of ['10.0.0.5', '192.168.1.20', '::ffff:10.0.0.5', 'fd00::5', '8.8.8.8', '2001:db8::1']) {
            assert.strictEqual(egress.isLoopbackIp(ip), false, ip);
        }
    });
});

describe('E. the site import and export of custom tables', () => {
    it('imports only the tables of a plugin or theme installed here', async () => {
        const { importSite } = require('../core/import-export');
        const dbAsync = database.getDbAsync();
        await dbAsync.exec('CREATE TABLE IF NOT EXISTS wordjs_locks (name TEXT PRIMARY KEY, owner TEXT, expires_at INTEGER)');
        const before = (await dbAsync.get('SELECT COUNT(*) AS n FROM wordjs_locks')).n;
        const results = await importSite({
            content: {
                custom_tables: [
                    { name: 'wordjs_locks', schema: { columns: ['name TEXT'] }, rows: [{ name: 'held', owner: 'import', expires_at: 9999999999999 }] },
                    { name: 'wjp_absent_orders', schema: { columns: ['id INT_PK', 'total TEXT'] }, rows: [{ id: 1, total: '9' }] },
                    { name: 'wjp_shop_kit_orders', schema: { columns: ['id INT_PK', 'total TEXT'] }, rows: [{ id: 1, total: '12' }] },
                    { name: 'wjp_quiet_notes', schema: { columns: ['id INT_PK', 'body TEXT'] }, rows: [{ id: 1, body: 'hi' }] },
                ],
            },
        }, {});
        const errors = results.errors.join(' | ');
        assert.match(errors, /refusing to import table 'wordjs_locks'/, errors);
        assert.match(errors, /refusing to import table 'wjp_absent_orders'/, errors);
        assert.strictEqual((await dbAsync.get('SELECT COUNT(*) AS n FROM wordjs_locks')).n, before, 'nothing was written into wordjs_locks');
        assert.strictEqual(await dbAsync.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wjp_absent_orders'`), undefined);
        assert.strictEqual((await dbAsync.get('SELECT total FROM wjp_shop_kit_orders WHERE id = 1')).total, '12', 'an installed plugin\'s table is imported');
        assert.strictEqual((await dbAsync.get('SELECT body FROM wjp_quiet_notes WHERE id = 1')).body, 'hi', 'an installed theme\'s table is imported');
    });

    it('exports plugin and theme tables only', async () => {
        const { exportSite } = require('../core/import-export');
        const dbAsync = database.getDbAsync();
        await dbAsync.exec('CREATE TABLE IF NOT EXISTS engine_scratch (k TEXT)');
        const data = await exportSite({});
        const names = (data.content.custom_tables || []).map((t: any) => t.name);
        assert.ok(names.includes('wjp_shop_kit_orders'), names.join(', '));
        assert.ok(names.every((n: string) => /^wjp_/.test(n)), `only wjp_ tables travel: ${names.join(', ')}`);
    });
});

describe('F. multipart limits on the site import and the font upload', () => {
    it('too many fields, or an oversized field, are refused before the handler runs', async () => {
        const express = require('express');
        const request = require('supertest');
        const jwt = require('jsonwebtoken');
        const db = database.getDbAsync();
        await require('../core/roles').loadRoles();
        await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('mpadmin', 'x', 'mp@example.com', 'MP')`);
        const id = (await db.get(`SELECT id FROM users WHERE user_login = 'mpadmin'`)).id;
        await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [id]);
        const token = jwt.sign({ userId: id, username: 'mpadmin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
        const { errorHandler } = require('../middleware/errorHandler');
        const app = express();
        app.use(express.json());
        app.use('/api/v1', require('../routes/export'));
        app.use('/api/v1/fonts', require('../routes/fonts'));
        app.use(errorHandler);

        const DATA = JSON.stringify({ content: {} });
        const multerRefusal = (r: any) => JSON.stringify(r.body);
        // The site import: a valid archive plus 40 stray fields used to be accepted (no field cap).
        let many = request(app).post('/api/v1/import').set('Authorization', `Bearer ${token}`).field('data', DATA);
        for (let i = 0; i < 40; i++) many = many.field(`f${i}`, 'x');
        const r1 = await many;
        assert.strictEqual(r1.status, 400, `many fields: ${r1.status} ${multerRefusal(r1)}`);
        assert.match(multerRefusal(r1), /Too many fields/i);

        // The font upload: its own field cap and a small per-field size (it reads no text field at all).
        let fontFields = request(app).post('/api/v1/fonts').set('Authorization', `Bearer ${token}`);
        for (let i = 0; i < 40; i++) fontFields = fontFields.field(`f${i}`, 'x');
        const r2 = await fontFields;
        assert.strictEqual(r2.status, 400);
        assert.match(multerRefusal(r2), /Too many fields/i);
        const r3 = await request(app).post('/api/v1/fonts').set('Authorization', `Bearer ${token}`).field('note', 'x'.repeat(64 * 1024));
        assert.strictEqual(r3.status, 400);
        assert.match(multerRefusal(r3), /Field value too long/i);
        // An ordinary import still goes through the same multipart path.
        const ok = await request(app).post('/api/v1/import').set('Authorization', `Bearer ${token}`).field('data', JSON.stringify({ content: {} }));
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    });
});

describe('G. named properties (DOM clobbering) and embeds on the write side', () => {
    const { sanitizeContent } = require('../core/formatting');
    const { sanitize } = require('../core/sanitize-meta');

    it('post and comment HTML: every author id is namespaced once; name never survives on content elements', () => {
        const out = sanitizeContent('<p id="__next_f">a</p><div id="intro">b</div><span id="user-content-x">c</span><a name="cookie" id="top" href="#intro">d</a>');
        assert.match(out, /id="user-content-__next_f"/);
        assert.match(out, /id="user-content-intro"/);
        assert.match(out, /id="user-content-x"/);
        assert.match(out, /id="user-content-top"/);
        assert.doesNotMatch(out, /user-content-user-content-|name=/);
        assert.match(out, /href="#intro"/, 'the in-page link is kept as written (the site resolves the prefixed target)');
        assert.strictEqual(sanitizeContent(out), out, 'idempotent: saving twice does not prefix twice');
        // A caller-supplied config is bounded too.
        assert.match(sanitizeContent('<p id="x">a</p>', { allowedTags: ['p'], allowedAttributes: { p: ['id'] } }), /id="user-content-x"/);
    });

    it('rich text (block props): ids namespaced, name only on form controls, embed sandbox and allow are the site\'s', () => {
        const out = sanitize('<h2 id="faq">F</h2><img name="getElementById" src="https://cdn.example/a.png"><input name="q"><iframe src="https://www.youtube.com/embed/aqz-KE-bpKQ" sandbox="allow-scripts allow-same-origin allow-top-navigation allow-popups" allow="camera; microphone"></iframe>');
        assert.match(out, /id="user-content-faq"/);
        assert.doesNotMatch(out, /name="getElementById"/);
        assert.match(out, /<input name="user-content-q"/);
        assert.match(out, /sandbox="allow-scripts allow-same-origin allow-presentation"/);
        assert.match(out, /allow="autoplay; encrypted-media; fullscreen; picture-in-picture"/);
        assert.doesNotMatch(out, /top-navigation|allow-popups|camera|microphone/);
    });
});
