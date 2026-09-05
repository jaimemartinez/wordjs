/**
 * WordJS — WordPress WXR importer round-trip tests.
 *
 * This suite exists to lock the behaviour of core/wxr-import.ts across the fast-xml-parser v4 -> v5
 * upgrade (advisory GHSA-gh4j-gqv2-49f6). WXR import is data-integrity critical and previously had NO
 * test. The assertions below are byte-exact against a representative export fixture so any change in how
 * fast-xml-parser handles CDATA merging, attribute prefixing, entity decoding or value trimming would
 * fail loudly. The expected values were captured from the v4 parser output and confirmed identical under
 * v5.10.1 (raw parse of the fixture diffs clean between the two majors).
 *
 * IMPORTANT: `config.dbPath` is repointed to a temp file BEFORE requiring `../config/database` or
 * anything that transitively loads it (the importer + its models). See starter-content.test.ts / api.test.ts.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 1. Repoint the DB at a temp file FIRST.
const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-wxr-test-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
// The media pass writes real files, so give it a temp uploads root instead of the repo's ./uploads.
const TMP_UPLOADS = path.join(os.tmpdir(), `wordjs-wxr-uploads-${process.pid}-${Date.now()}`);
config.uploads.dir = TMP_UPLOADS;
// The importer's loopback exception — the ONLY way a test can serve its own fixtures over http —
// requires a non-production environment, exactly like core/webhooks.ts' allowPrivateTargets seam.
// Node's test runner gives each *.test.ts file its own process, so this cannot leak into another suite.
config.nodeEnv = 'test';

// 2. Now it is safe to pull in the DB layer (and, later, the importer).
const database = require('../config/database');

const FIXTURE = path.join(__dirname, 'fixtures', 'sample-export.wxr');
const MEDIA_FIXTURE = path.join(__dirname, 'fixtures', 'sample-media-menus.wxr');
const HOSTILE_FIXTURE = path.join(__dirname, 'fixtures', 'sample-media-hostile.wxr');
const CHAIN_FIXTURE = path.join(__dirname, 'fixtures', 'sample-media-chain.wxr');

// Byte-exact expected bodies as STORED (parse -> wpautop -> post-body sanitizer). The whole point of the
// fixture is that these survive the v5 upgrade unchanged. CDATA content is taken verbatim by the parser
// (entities stay escaped). Non-CDATA classic content has its &amp; decoded to & by processEntities, is
// wrapped by the importer's light wpautop, then the shared post-body sanitizer re-encodes the bare & back
// to &amp; on write — so the on-disk form matches the CDATA case. All of this is identical under v4 and v5.
const HELLO_CONTENT =
    '<p>First &amp; foremost, this body has literal <strong>entities</strong> &amp; markup.</p>\n' +
    '<p>A second paragraph with a &lt;tag&gt; that must stay escaped.</p>';
const CLASSIC_CONTENT =
    '<p>First paragraph in classic style with an &amp; ampersand.</p>\n' +
    '<p>Second paragraph separated by a blank line.</p>';

describe('WXR importer (fast-xml-parser v5)', () => {
    let dbAsync: any;
    let parseWxr: any, analyzeWxr: any, importWxr: any;
    let adminId: number;
    let xml: string;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();

        // A real admin to act as the fallback default author.
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@test.local', 'Administrator']
        );
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        adminId = admin.id;

        // Safe to load only after config.dbPath is repointed (models bind dbAsync at require time).
        ({ parseWxr, analyzeWxr, importWxr } = require('../core/wxr-import'));
        xml = fs.readFileSync(FIXTURE, 'utf-8');
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
        try { fs.rmSync(TMP_UPLOADS, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ---------------------------------------------------------------------------------------------
    // Parse fidelity — pure parser behaviour, no DB writes. These are the direct v4==v5 guards.
    // ---------------------------------------------------------------------------------------------
    describe('parse fidelity', () => {
        it('parses channel, authors, terms and decodes entities outside CDATA', () => {
            const p = parseWxr(xml);
            assert.strictEqual(p.wxrVersion, '1.2');
            assert.strictEqual(p.site.title, 'Fixture Blog');
            assert.strictEqual(p.site.link, 'https://fixture.example');
            assert.strictEqual(p.site.baseUrl, 'https://fixture.example');
            // description carries entities NOT in CDATA: &amp; and &quot; decode; a numeric ref stays literal
            // (this is the exact, unchanged fast-xml-parser behaviour under both v4 and v5).
            assert.strictEqual(p.site.description, 'Q &amp; A &#8212; a &quot;representative&quot; export');

            assert.strictEqual(p.authors.length, 1);
            assert.strictEqual(p.categories.length, 2);
            assert.strictEqual(p.tags.length, 1);
            assert.strictEqual(p.terms.length, 1);
            assert.strictEqual(p.items.length, 6);
        });

        it('merges CDATA into element text verbatim (content:encoded stays escaped)', () => {
            const p = parseWxr(xml);
            const hello = p.items.find((i: any) => String(i['wp:post_id']) === '101');
            assert.strictEqual(hello['content:encoded'], HELLO_CONTENT);
            // A CDATA cat_name with a raw ampersand comes through untouched.
            const news = p.categories.find((c: any) => c['wp:category_nicename'] === 'news');
            assert.strictEqual(news['wp:cat_name'], 'News & Updates');
        });

        it('parses element attributes with the @_ prefix', () => {
            const p = parseWxr(xml);
            const hello = p.items.find((i: any) => String(i['wp:post_id']) === '101');
            const cats = hello.category; // array of <category domain=".." nicename="..">
            assert.strictEqual(cats.length, 3);
            assert.strictEqual(cats[0]['@_domain'], 'category');
            assert.strictEqual(cats[0]['@_nicename'], 'news');
            assert.strictEqual(cats[0]['#text'], 'News & Updates');
        });

        it('keeps _puck_data CDATA as a parseable JSON string', () => {
            const p = parseWxr(xml);
            const hello = p.items.find((i: any) => String(i['wp:post_id']) === '101');
            const meta = hello['wp:postmeta'].find((m: any) => m['wp:meta_key'] === '_puck_data');
            const puck = JSON.parse(meta['wp:meta_value']);
            assert.strictEqual(puck.content[0].props.text, 'Hello');
            assert.strictEqual(puck.content[0].props.href, 'javascript:alert(1)'); // pre-sanitize (raw parse)
        });

        it('analyzeWxr counts every entity type by post_type', () => {
            const a = analyzeWxr(xml);
            assert.strictEqual(a.wxrVersion, '1.2');
            assert.deepStrictEqual(a.counts, {
                authors: 1, categories: 2, tags: 1, customTerms: 1,
                posts: 3, pages: 2, attachments: 0, navItems: 1, other: 0, comments: 3,
            });
        });
    });

    // ---------------------------------------------------------------------------------------------
    // Full import round-trip against a real (temp) SQLite database.
    // ---------------------------------------------------------------------------------------------
    describe('import round-trip', () => {
        let summary: any;

        it('imports posts, pages, terms, meta and comments with byte-fidelity', async () => {
            summary = await importWxr(xml, { defaultAuthorId: adminId, importComments: true });

            // ---- summary ----------------------------------------------------------------------
            assert.deepStrictEqual(summary.errors, [], 'import produced no per-item errors');
            assert.deepStrictEqual(summary.authors, { created: 1, matched: 0 });
            assert.deepStrictEqual(summary.terms, { categories: 2, tags: 1, custom: 1 });
            assert.deepStrictEqual(summary.posts, { created: 2, skipped: 1 }); // 101,102 created; 103 trash skipped
            assert.deepStrictEqual(summary.pages, { created: 2, skipped: 0 });
            assert.deepStrictEqual(summary.comments, { created: 3, skipped: 0 });
            assert.strictEqual(summary.navItems.skipped, 1);

            // ---- author mapping ---------------------------------------------------------------
            const jdoe = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'jdoe'`);
            assert.ok(jdoe, 'imported author jdoe created');
            assert.notStrictEqual(jdoe.id, adminId);

            // ---- hello-world post -------------------------------------------------------------
            const hello = await dbAsync.get(`SELECT * FROM posts WHERE post_name = 'hello-world' AND post_type = 'post'`);
            assert.ok(hello, 'hello-world post exists');
            assert.strictEqual(hello.post_status, 'publish');
            assert.strictEqual(hello.author_id, jdoe.id, 'post attributed to imported author, not admin');
            assert.strictEqual(hello.post_content, HELLO_CONTENT, 'CDATA body stored byte-for-byte');
            assert.strictEqual(hello.post_date, '2025-01-06 09:30:00', 'original publish date preserved');

            // ---- post meta: skip-list honoured, CDATA value verbatim, _puck_data sanitized -----
            const editLast = await dbAsync.get(
                `SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = '_edit_last'`, [hello.id]);
            assert.strictEqual(editLast, undefined, '_edit_last is on the skip-list');
            const note = await dbAsync.get(
                `SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = 'featured_note'`, [hello.id]);
            assert.strictEqual(note.meta_value, 'Keep this "as-is" & intact', 'plain meta preserved verbatim');
            const puckMeta = await dbAsync.get(
                `SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = '_puck_data'`, [hello.id]);
            const puck = JSON.parse(puckMeta.meta_value);
            assert.strictEqual(puck.content[0].props.text, 'Hello', 'puck text leaf preserved');
            assert.strictEqual(puck.content[0].props.href, '', 'javascript: URL neutralised by the meta sanitizer');

            // ---- terms attached + category hierarchy resolved ---------------------------------
            const cats = await dbAsync.all(
                `SELECT t.slug FROM term_relationships tr
                   JOIN term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
                   JOIN terms t ON t.term_id = tt.term_id
                  WHERE tr.object_id = ? AND tt.taxonomy = 'category' ORDER BY t.slug`, [hello.id]);
            assert.deepStrictEqual(cats.map((c: any) => c.slug), ['news', 'releases']);
            const tags = await dbAsync.all(
                `SELECT t.slug FROM term_relationships tr
                   JOIN term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
                   JOIN terms t ON t.term_id = tt.term_id
                  WHERE tr.object_id = ? AND tt.taxonomy = 'post_tag'`, [hello.id]);
            assert.deepStrictEqual(tags.map((t: any) => t.slug), ['howto']);

            const newsTerm = await dbAsync.get(`SELECT term_id FROM terms WHERE slug = 'news'`);
            const releasesTax = await dbAsync.get(
                `SELECT parent FROM term_taxonomy WHERE taxonomy = 'category' AND term_id =
                    (SELECT term_id FROM terms WHERE slug = 'releases')`);
            assert.strictEqual(releasesTax.parent, newsTerm.term_id, 'category parent hierarchy resolved');

            // ---- classic (non-CDATA) post body: entity-decoded + wpautop-wrapped ---------------
            const classic = await dbAsync.get(`SELECT post_content FROM posts WHERE post_name = 'classic'`);
            assert.strictEqual(classic.post_content, CLASSIC_CONTENT);

            // ---- hierarchical pages: child.post_parent -> parent.id ----------------------------
            const parent = await dbAsync.get(`SELECT id FROM posts WHERE post_name = 'parent-page'`);
            const child = await dbAsync.get(`SELECT post_parent FROM posts WHERE post_name = 'child-page'`);
            assert.strictEqual(child.post_parent, parent.id, 'child page reparented to imported parent');

            // ---- comments: content verbatim, threading + spam status --------------------------
            const comments = await dbAsync.all(
                `SELECT comment_content, comment_approved, comment_parent, comment_id
                   FROM comments WHERE comment_post_id = ? ORDER BY comment_id`, [hello.id]);
            assert.strictEqual(comments.length, 3);
            const top = comments.find((c: any) => c.comment_content === 'Great post &amp; thanks!');
            const reply = comments.find((c: any) => c.comment_content === 'A threaded reply.');
            const spam = comments.find((c: any) => c.comment_approved === 'spam');
            assert.ok(top && reply && spam, 'all three comments present with verbatim content');
            assert.strictEqual(reply.comment_parent, top.comment_id, 'threaded reply linked to its parent');

            // ---- skipped content really is absent ---------------------------------------------
            const trashed = await dbAsync.get(`SELECT id FROM posts WHERE post_name = 'trashed'`);
            assert.strictEqual(trashed, undefined, 'trash post not imported');
            const nav = await dbAsync.get(`SELECT id FROM posts WHERE post_name = 'nav'`);
            assert.strictEqual(nav, undefined, 'nav_menu_item not imported');
        });

        it('is idempotent — a second import creates no duplicates', async () => {
            const again = await importWxr(xml, { defaultAuthorId: adminId, importComments: true });

            assert.strictEqual(again.posts.created, 0, 'no new posts on re-run');
            assert.strictEqual(again.pages.created, 0, 'no new pages on re-run');
            assert.strictEqual(again.authors.matched, 1, 'author matched, not recreated');
            assert.strictEqual(again.authors.created, 0);

            const posts = await dbAsync.all(`SELECT id FROM posts WHERE post_name = 'hello-world'`);
            assert.strictEqual(posts.length, 1, 'exactly one hello-world post');
            const news = await dbAsync.all(`SELECT term_id FROM terms WHERE slug = 'news'`);
            assert.strictEqual(news.length, 1, 'terms not duplicated');
            const hello = await dbAsync.get(`SELECT id FROM posts WHERE post_name = 'hello-world'`);
            const comments = await dbAsync.all(`SELECT comment_id FROM comments WHERE comment_post_id = ?`, [hello.id]);
            assert.strictEqual(comments.length, 3, 'comments not duplicated (post skipped before comment pass)');
        });
    });

    // ---------------------------------------------------------------------------------------------
    // MEDIA + MENUS. Everything the importer used to report as "skipped" and leave to the operator.
    //
    // No network: the two fetchable attachments point at THIS test's own http.createServer (its port is
    // substituted into the fixture at load time), and the third points at an https loopback address that
    // the egress guard must refuse in every mode. `requests` records what the server was actually asked
    // for, which is how the "refused BEFORE connecting" assertion is made rather than assumed.
    // ---------------------------------------------------------------------------------------------
    describe('media + menu import', () => {
        let server: any;
        let origin: string;
        let mediaXml: string;
        let hostileXml: string;
        let chainXml: string;
        let requests: string[];
        let photoBytes: number;
        let chainABytes: Buffer;
        let chainBBytes: Buffer;

        const photoPath = '/wp-content/uploads/2025/01/photo.jpg';
        const missingPath = '/wp-content/uploads/2025/01/missing.png';
        // The HOSTILE fixture's two fetchable files. `other.jpg` is a DIFFERENT image served at a
        // different URL whose WXR claims `2025/01/photo.jpg` — the path `photo.jpg` above already holds.
        const otherPath = '/wp-content/uploads/2025/01/other.jpg';
        const legitPath = '/wp-content/uploads/2025/03/legit.jpg';
        // The CHAIN fixture's two files: an ordinary WordPress pair, where the second's own name is the
        // one the first is about to be disambiguated to.
        const chainAPath = '/wp-content/uploads/2025/05/chain.jpg';
        const chainBPath = '/wp-content/uploads/2025/05/chain-1.jpg';

        before(async () => {
            const sharp = require('sharp');
            // A REAL JPEG: the importer's magic-byte check refuses an image whose declared type its
            // signature does not confirm, so a fake body would (correctly) never be stored.
            const jpeg = await sharp({
                create: { width: 4, height: 3, channels: 3, background: { r: 10, g: 20, b: 30 } },
            }).jpeg().toBuffer();
            // Deliberately a DIFFERENT size, so "whose bytes are at this path" is answerable by reading
            // the file rather than by trusting a counter.
            const otherJpeg = await sharp({
                create: { width: 8, height: 6, channels: 3, background: { r: 200, g: 100, b: 50 } },
            }).jpeg().toBuffer();
            photoBytes = jpeg.length;
            // The chained pair, each a DIFFERENT image again, so "which attachment's bytes are at this
            // path" is answered by comparing the file to the buffer the server handed out — the cascade
            // bug swapped the two without changing how many files landed or how big the run looked.
            chainABytes = await sharp({
                create: { width: 16, height: 12, channels: 3, background: { r: 1, g: 2, b: 3 } },
            }).jpeg().toBuffer();
            chainBBytes = await sharp({
                create: { width: 32, height: 24, channels: 3, background: { r: 250, g: 240, b: 230 } },
            }).jpeg().toBuffer();

            const served: Record<string, Buffer> = {
                [photoPath]: jpeg,
                [otherPath]: otherJpeg,
                [legitPath]: otherJpeg,
                [chainAPath]: chainABytes,
                [chainBPath]: chainBBytes,
            };
            requests = [];
            server = http.createServer((req: any, res: any) => {
                requests.push(req.url);
                const body = Object.prototype.hasOwnProperty.call(served, req.url) ? served[req.url] : null;
                if (body) {
                    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(body.length) });
                    res.end(body);
                    return;
                }
                res.writeHead(404, { 'content-type': 'text/plain' });
                res.end('not found');
            });
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
            origin = `http://127.0.0.1:${server.address().port}`;
            mediaXml = fs.readFileSync(MEDIA_FIXTURE, 'utf-8').split('__ORIGIN__').join(origin);
            hostileXml = fs.readFileSync(HOSTILE_FIXTURE, 'utf-8').split('__ORIGIN__').join(origin);
            chainXml = fs.readFileSync(CHAIN_FIXTURE, 'utf-8').split('__ORIGIN__').join(origin);
        });

        after(async () => {
            if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
        });

        it('refuses an http:// attachment when the http opt-in is off — and never opens a connection', async () => {
            const summary = await importWxr(mediaXml, { defaultAuthorId: adminId, media: 'download' });

            assert.strictEqual(summary.media.mode, 'download');
            assert.strictEqual(summary.media.downloaded, 0, 'nothing downloaded with the opt-in off');
            assert.strictEqual(summary.media.failed, 3, 'all three attachments refused');
            assert.strictEqual(summary.attachments.created, 0);
            assert.strictEqual(requests.length, 0, 'the guard refused before any socket was opened');

            const byUrl = new Map<string, string>(
                summary.media.failures.map((f: any) => [f.url, f.reason])
            );
            assert.match(byUrl.get(`${origin}${photoPath}`), /http:\/\//, 'http source named in the reason');
            assert.match(byUrl.get(`${origin}${missingPath}`), /http:\/\//);
            // The SSRF guard itself — an https URL whose host resolves to a private address — is refused
            // by core/egress-guard, not by the scheme check, and stays refused with the opt-in ON.
            assert.match(
                byUrl.get('https://127.0.0.1/wp-content/uploads/2025/01/guarded.gif'),
                /blocked/i,
                'loopback https target refused by the egress guard'
            );

            // A refused download is reported, never thrown: the rest of the file imported normally.
            const post = await dbAsync.get(`SELECT id FROM posts WHERE post_name = 'media-post'`);
            assert.ok(post, 'the post itself still imported past the media failures');
        });

        it('downloads an attachment into the uploads dir with its media metadata, and reports failures', async () => {
            const summary = await importWxr(mediaXml, {
                defaultAuthorId: adminId, media: 'download', allowHttp: true,
            });

            assert.strictEqual(summary.media.downloaded, 1, 'the served attachment was fetched');
            assert.strictEqual(summary.media.failed, 2, '404 + SSRF-refused, both recorded');
            assert.strictEqual(summary.attachments.created, 1);
            assert.ok(summary.media.bytes > 0, 'downloaded byte total recorded');
            assert.ok(requests.includes(photoPath), 'the local server served the photo');

            const failed = summary.media.failures.map((f: any) => f.reason).join(' | ');
            assert.match(failed, /HTTP 404/, 'the 404 is reported per file, not thrown');
            assert.match(failed, /blocked/i, 'the loopback https target is still refused with http on');

            // ---- the row --------------------------------------------------------------------------
            const att = await dbAsync.get(
                `SELECT id, post_title, post_excerpt, post_content, post_mime_type, guid, post_parent, post_date
                   FROM posts WHERE post_type = 'attachment' AND post_name = 'photo'`);
            assert.ok(att, 'attachment row created');
            assert.strictEqual(att.post_mime_type, 'image/jpeg');
            assert.strictEqual(att.post_excerpt, 'The photo caption.', 'excerpt:encoded -> caption');
            assert.strictEqual(att.post_content, 'The photo description.', 'content:encoded -> description');
            assert.strictEqual(att.guid, '/uploads/2025/01/photo.jpg', 'guid is the portable relative path');
            assert.strictEqual(att.post_date, '2025-01-12 11:22:33', 'original upload date preserved');
            const parentPost = await dbAsync.get(`SELECT id FROM posts WHERE post_name = 'media-post'`);
            assert.strictEqual(att.post_parent, parentPost.id, 'wp:post_parent mapped to the imported post');

            // ---- the metadata ----------------------------------------------------------------------
            const meta: Record<string, string> = {};
            for (const row of await dbAsync.all(
                `SELECT meta_key, meta_value FROM post_meta WHERE post_id = ?`, [att.id])) {
                meta[row.meta_key] = row.meta_value;
            }
            assert.strictEqual(meta._wp_attached_file, '2025/01/photo.jpg', 'stored path preserved from the WXR');
            assert.strictEqual(meta._wp_attachment_image_alt, 'A photo', 'alt text mapped');
            assert.strictEqual(meta.photographer, 'Jane Doe', 'ordinary custom fields still copied');
            assert.strictEqual(meta._wxr_source_url, `${origin}${photoPath}`, 'source URL stamped for re-runs');
            const details = JSON.parse(meta._wp_attachment_metadata);
            assert.strictEqual(details.file, '2025/01/photo.jpg');
            assert.strictEqual(details.width, 4, 'intrinsic width read from the downloaded bytes');
            assert.strictEqual(details.height, 3);

            // ---- the file ---------------------------------------------------------------------------
            const onDisk = path.join(TMP_UPLOADS, '2025', '01', 'photo.jpg');
            assert.ok(fs.existsSync(onDisk), 'the file itself is under the uploads dir');
            assert.strictEqual(fs.statSync(onDisk).size, details.filesize, 'recorded size matches the bytes');
        });

        it('rewrites in-content upload URLs onto this install /uploads path', async () => {
            const post = await dbAsync.get(
                `SELECT post_content, post_excerpt FROM posts WHERE post_name = 'media-post'`);
            assert.ok(post.post_content.includes('/uploads/2025/01/photo.jpg'), 'img src rewritten');
            assert.ok(post.post_content.includes('/uploads/2025/01/missing.png'), 'href rewritten too');
            assert.ok(!post.post_content.includes(origin), 'no reference to the old host survives');
            assert.strictEqual(post.post_excerpt, 'See /uploads/2025/01/photo.jpg', 'excerpt rewritten');
        });

        it('imports the nav_menu term as a menu, with item types, order, hierarchy and location', async () => {
            const menu = await dbAsync.get(
                `SELECT t.term_id, t.name FROM terms t
                   JOIN term_taxonomy tt ON tt.term_id = t.term_id
                  WHERE t.slug = 'main-menu' AND tt.taxonomy = 'nav_menu'`);
            assert.ok(menu, 'the nav_menu term became a menu');
            assert.strictEqual(menu.name, 'Main Menu');

            const items = await dbAsync.all(
                `SELECT p.id, p.post_title, p.post_parent, p.menu_order, p.guid, p.post_name
                   FROM posts p
                   JOIN term_relationships tr ON tr.object_id = p.id
                   JOIN term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
                  WHERE tt.term_id = ? AND tt.taxonomy = 'nav_menu' AND p.post_type = 'nav_menu_item'
                  ORDER BY p.menu_order`, [menu.term_id]);
            assert.strictEqual(items.length, 3, 'three menu items, in menu_order');
            const [landing, docs, guides] = items;

            const metaOf = async (id: number) => {
                const out: Record<string, string> = {};
                for (const r of await dbAsync.all(
                    `SELECT meta_key, meta_value FROM post_meta WHERE post_id = ?`, [id])) out[r.meta_key] = r.meta_value;
                return out;
            };

            // 1. post_type item -> the imported page, by id, with a working local URL.
            const page = await dbAsync.get(`SELECT id FROM posts WHERE post_name = 'media-page'`);
            const landingMeta = await metaOf(landing.id);
            assert.strictEqual(landingMeta._menu_item_type, 'post_type');
            assert.strictEqual(landingMeta._menu_item_object, 'page', 'object is the OBJECT, not the type');
            assert.strictEqual(Number(landingMeta._menu_item_object_id), page.id, 'object id mapped through the id map');
            assert.strictEqual(landing.guid, '/media-page', 'url resolved from the linked page slug');
            assert.strictEqual(landingMeta._menu_item_classes, 'highlight', 'PHP-serialized classes unpacked');
            assert.strictEqual(landingMeta._menu_item_xfn, 'me');
            assert.strictEqual(landing.menu_order, 1);

            // 2. custom link -> its own url + target, and a CHILD of the first item.
            const docsMeta = await metaOf(docs.id);
            assert.strictEqual(docsMeta._menu_item_type, 'custom');
            assert.strictEqual(docs.guid, 'https://docs.example/start');
            assert.strictEqual(docsMeta._menu_item_target, '_blank');
            assert.strictEqual(docs.post_parent, landing.id, 'hierarchy resolved in the second pass');
            assert.strictEqual(Number(docsMeta._menu_item_menu_item_parent), landing.id, 'and mirrored in meta');

            // 3. taxonomy link -> the imported category, with the title taken from the term.
            const guidesTerm = await dbAsync.get(`SELECT term_id FROM terms WHERE slug = 'guides'`);
            const guidesMeta = await metaOf(guides.id);
            assert.strictEqual(guidesMeta._menu_item_type, 'taxonomy');
            assert.strictEqual(guidesMeta._menu_item_object, 'category');
            assert.strictEqual(Number(guidesMeta._menu_item_object_id), guidesTerm.term_id);
            assert.strictEqual(guides.guid, '/category/guides', 'category archive URL');
            assert.strictEqual(guides.post_title, 'Guides', 'empty item title falls back to the linked object');

            // Theme location, from the nav_menu_locations option the fixture carries.
            const locations = await dbAsync.get(`SELECT option_value FROM options WHERE option_name = 'nav_menu_locations'`);
            assert.ok(locations, 'nav_menu_locations written');
            assert.strictEqual(JSON.parse(locations.option_value).primary, menu.term_id);
        });

        it('is idempotent — a re-run downloads nothing and creates no second menu or item', async () => {
            const photoRequestsBefore = requests.filter((u) => u === photoPath).length;
            const again = await importWxr(mediaXml, {
                defaultAuthorId: adminId, media: 'download', allowHttp: true,
            });

            assert.strictEqual(again.media.downloaded, 0, 'no byte re-downloaded');
            assert.strictEqual(again.media.skipped, 1, 'the stored attachment skipped by source URL');
            assert.strictEqual(again.attachments.created, 0);
            assert.strictEqual(
                requests.filter((u) => u === photoPath).length, photoRequestsBefore,
                'a stored file is never re-fetched (a FAILED one is retried, which is the point of resumability)'
            );

            assert.strictEqual(again.menus.created, 0, 'menu matched, not recreated');
            assert.strictEqual(again.menus.matched, 1);
            assert.deepStrictEqual(again.menus.items, { created: 0, skipped: 3 });

            const attachments = await dbAsync.all(
                `SELECT id FROM posts WHERE post_type = 'attachment' AND post_name = 'photo'`);
            assert.strictEqual(attachments.length, 1, 'exactly one attachment row');
            const menus = await dbAsync.all(`SELECT term_id FROM terms WHERE slug = 'main-menu'`);
            assert.strictEqual(menus.length, 1, 'exactly one menu');
            const items = await dbAsync.all(`SELECT id FROM posts WHERE post_type = 'nav_menu_item'`);
            assert.strictEqual(items.length, 3, 'exactly three menu items');
        });

        // -----------------------------------------------------------------------------------------
        // THE HOSTILE HALF. Everything above is a well-behaved export; a WXR is a document a THIRD
        // PARTY wrote, and these are the four things it can say that the importer used to believe:
        // a path another attachment already holds, a path inside the negotiation cache, its own
        // idempotency keys, and a builder tree full of URLs the body-only rewrite never saw.
        //
        // Ordering is deliberate: the hostile file is imported AFTER sample-media-menus.wxr, so
        // `2025/01/photo.jpg` is a REAL stored attachment by the time the colliding item arrives.
        // -----------------------------------------------------------------------------------------
        const onDisk = (...segments: string[]) => path.join(TMP_UPLOADS, ...segments);
        const rawMeta = async (postId: number, key: string): Promise<string | null> => {
            const row = await dbAsync.get(
                `SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = ?`, [postId, key]);
            return row === undefined ? null : row.meta_value;
        };
        /**
         * The attachment the dedupe index says owns this source URL.
         *
         * Looked up by the KEY the importer actually dedupes on rather than by slug: Media.create()
         * derives an attachment's `post_name` from its title, not from the WXR's `wp:post_name`, so a
         * slug lookup would silently answer `undefined` and turn a real assertion into a vacuous one.
         */
        const attachmentBySourceUrl = async (url: string) => await dbAsync.get(
            `SELECT p.id AS id FROM posts p
               JOIN post_meta pm ON pm.post_id = p.id
              WHERE pm.meta_key = '_wxr_source_url' AND pm.meta_value = ? AND p.post_type = 'attachment'`,
            [url]);

        it('bounds the RUN and not merely each file: the stream is aborted when the budget is spent', async () => {
            const otherBefore = requests.filter((u) => u === otherPath).length;
            const legitBefore = requests.filter((u) => u === legitPath).length;

            // Eight bytes is less than one chunk, so the abort has to happen INSIDE the response —
            // which is the whole point: checked once per item against the bytes already STORED, this
            // cap bounded nothing a failing run downloaded.
            const summary = await importWxr(hostileXml, {
                defaultAuthorId: adminId, media: 'download', allowHttp: true, maxTotalBytes: 8,
            });

            assert.strictEqual(summary.media.downloaded, 0, 'nothing may be stored past the budget');
            assert.strictEqual(summary.media.bytes, 0);
            assert.ok(summary.media.fetchedBytes > 0,
                'bytes pulled off the socket are counted even when the item is refused');
            assert.match(summary.media.failures.map((f: any) => f.reason).join(' | '), /total cap/);

            assert.strictEqual(requests.filter((u) => u === otherPath).length, otherBefore + 1,
                'the first file is fetched, and aborted mid-response');
            assert.strictEqual(requests.filter((u) => u === legitPath).length, legitBefore,
                'once the budget is spent the next item is refused BEFORE the socket');
            assert.strictEqual(await attachmentBySourceUrl(`${origin}${otherPath}`), undefined,
                'a refused download leaves no row to dedupe the retry away');
            assert.strictEqual(await attachmentBySourceUrl(`${origin}${legitPath}`), undefined);
        });

        it('never writes over an existing upload: a colliding path is disambiguated, bytes and all', async () => {
            const photoOnDisk = onDisk('2025', '01', 'photo.jpg');
            const before = fs.statSync(photoOnDisk).size;
            assert.strictEqual(before, photoBytes, 'precondition: the first import owns this path');

            const summary = await importWxr(hostileXml, {
                defaultAuthorId: adminId, media: 'download', allowHttp: true,
            });
            assert.strictEqual(summary.media.downloaded, 2, JSON.stringify(summary.media.failures));

            const collide = await attachmentBySourceUrl(`${origin}${otherPath}`);
            assert.ok(collide, 'the colliding attachment still imports — it is moved, not refused');
            assert.strictEqual(await rawMeta(collide.id, '_wp_attached_file'), '2025/01/photo-1.jpg',
                'the WXR named a path it does not own; the row must record where the bytes REALLY went');

            assert.strictEqual(fs.statSync(photoOnDisk).size, before,
                'the FIRST attachment kept its own bytes (an import overwrote another upload)');
            const moved = onDisk('2025', '01', 'photo-1.jpg');
            assert.ok(fs.existsSync(moved), 'the colliding file was placed beside it, not on top of it');
            assert.notStrictEqual(fs.statSync(moved).size, before, 'and it is the OTHER image');

            // The rewrite has to follow the file: the body was written in the run BEFORE this one, which
            // is why the placement is planned up front rather than discovered while downloading.
            const post = await dbAsync.get(`SELECT post_content FROM posts WHERE post_name = 'hostile-post'`);
            assert.ok(post.post_content.includes('/uploads/2025/01/photo-1.jpg'),
                'the in-content URL points at the file that is actually there');
            assert.ok(!post.post_content.includes(origin), 'no reference to the old host survives');
        });

        it('refuses a dot-leading segment, so the image-negotiation cache is unreachable from a WXR', async () => {
            const { safeAttachedFile } = require('../core/wxr-media');
            assert.strictEqual(safeAttachedFile('.derivatives/ab/hijacked.webp'), null);
            assert.strictEqual(safeAttachedFile('2025/01/.hidden.jpg'), null);
            assert.strictEqual(safeAttachedFile('2025/01/photo.jpg'), '2025/01/photo.jpg',
                'an ordinary WordPress path is untouched');

            // End to end: the item whose `_wp_attached_file` named `.derivatives/…` fell back to the
            // path its own URL names, and nothing was written into the cache directory.
            const dotdir = await attachmentBySourceUrl(`${origin}${legitPath}`);
            assert.ok(dotdir, 'the item itself still imports — only its path claim is dropped');
            assert.strictEqual(await rawMeta(dotdir.id, '_wp_attached_file'), '2025/03/legit.jpg');
            assert.ok(fs.existsSync(onDisk('2025', '03', 'legit.jpg')));
            assert.strictEqual(fs.existsSync(onDisk('.derivatives')), false,
                'a WXR wrote into the immutable-cached derivative store');
        });

        it('a WXR cannot plant the importer own idempotency keys on an ordinary post', async () => {
            const { PROTECTED_POST_META } = require('../core/protected-meta');
            const { SOURCE_URL_META_KEY, REMOTE_URL_META_KEY } = require('../core/wxr-media');
            const { MENU_ITEM_SOURCE_META_KEY } = require('../core/wxr-menus');
            // The literals in core/protected-meta and the ones the importers write must be the same
            // three strings — the list is duplicated there on purpose, so pin it here.
            for (const key of [SOURCE_URL_META_KEY, REMOTE_URL_META_KEY, MENU_ITEM_SOURCE_META_KEY]) {
                assert.ok(PROTECTED_POST_META.has(key), `${key} is an idempotency key and must be protected`);
            }

            const plant = await dbAsync.get(`SELECT id FROM posts WHERE post_name = 'hostile-plant'`);
            assert.ok(plant, 'the post itself still imports — only the three keys are dropped');
            for (const key of [SOURCE_URL_META_KEY, REMOTE_URL_META_KEY, MENU_ITEM_SOURCE_META_KEY]) {
                assert.strictEqual(await rawMeta(plant.id, key), null,
                    `${key} was copied verbatim out of a third party's XML`);
            }
            assert.strictEqual(await rawMeta(plant.id, 'harmless_note'), 'ordinary meta must still import');

            // THE CONSEQUENCE the plant was aiming at: it names the source URL of a REAL attachment in
            // the same file, so if it had been stored the run above would have declared that attachment
            // "already imported" and pointed the id map at this post instead.
            const collide = await attachmentBySourceUrl(`${origin}${otherPath}`);
            assert.ok(collide, 'the planted key suppressed a real attachment');
            assert.notStrictEqual(collide.id, plant.id,
                'the dedupe index must point at the attachment, not at whoever claimed its URL');
        });

        it('rewrites upload URLs inside _puck_data, not only in the post body', async () => {
            const page = await dbAsync.get(`SELECT id FROM posts WHERE post_name = 'hostile-puck'`);
            assert.ok(page, 'the builder page imported');
            const stored = await rawMeta(page.id, '_puck_data');
            assert.ok(stored, '_puck_data is ordinary author content and must still import');
            assert.ok(!stored!.includes(origin),
                'a builder page kept hotlinking the old host while the classic bodies were rewritten');

            const puck = JSON.parse(stored as string);
            assert.strictEqual(puck.content[0].props.src, '/uploads/2025/01/photo.jpg',
                'the block image points at THIS install');
            assert.strictEqual(puck.content[0].props.href, '',
                'and the meta sanitizer still runs first (javascript: URL neutralised)');
        });

        it('link mode keeps the REMOTE url as the attachment sourceUrl', async () => {
            const remote = 'https://old.example/wp-content/uploads/2024/09/linked.jpg';
            const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>Linked</title>
    <wp:wxr_version>1.2</wp:wxr_version>
    <item>
      <title>Linked Photo</title>
      <dc:creator><![CDATA[admin]]></dc:creator>
      <content:encoded><![CDATA[]]></content:encoded>
      <excerpt:encoded><![CDATA[]]></excerpt:encoded>
      <wp:post_id>800</wp:post_id>
      <wp:post_name>linked-photo</wp:post_name>
      <wp:post_type>attachment</wp:post_type>
      <wp:status>inherit</wp:status>
      <wp:post_parent>0</wp:post_parent>
      <wp:attachment_url>${remote}</wp:attachment_url>
      <wp:post_mime_type><![CDATA[image/jpeg]]></wp:post_mime_type>
      <wp:postmeta><wp:meta_key>_wp_attached_file</wp:meta_key><wp:meta_value><![CDATA[2024/09/linked.jpg]]></wp:meta_value></wp:postmeta>
    </item>
  </channel>
</rss>`;
            const requestsBefore = requests.length;
            const summary = await importWxr(xml, { defaultAuthorId: adminId, media: 'link' });
            assert.strictEqual(summary.media.linked, 1, JSON.stringify(summary.media));
            assert.strictEqual(requests.length, requestsBefore, 'link mode fetches nothing');

            const row = await dbAsync.get(
                `SELECT id, guid FROM posts WHERE post_name = 'linked-photo' AND post_type = 'attachment'`);
            assert.strictEqual(row.guid, remote, 'the guid keeps what WordPress itself exports');

            // THE DEFECT: formatAttachment normalises any absolute guid containing `/uploads/` down to a
            // LOCAL path — which every stock WordPress URL contains — so a linked attachment resolved to
            // a file this mode deliberately never downloaded: a 404 counted as a `linked` success.
            const Media = require('../models/Media');
            const media = await Media.findById(row.id);
            assert.strictEqual(media.sourceUrl, remote, 'sourceUrl must point where the bytes actually are');
            assert.strictEqual(media.guid, remote);
            assert.strictEqual(media.mediaDetails.file, '2024/09/linked.jpg',
                'the WXR path is still recorded — it is what an operator copying uploads/ by hand needs');
        });

        // -----------------------------------------------------------------------------------------
        // THE TWO THINGS THAT GO WRONG *BETWEEN* ITEMS, rather than inside one. Both are about a path
        // being reused: the rename map's values living in the same namespace as its keys, and a
        // link-mode row naming a path some other row already owns.
        // -----------------------------------------------------------------------------------------

        it('applies the rename map in ONE pass, so a chained disambiguation cannot swap two images', async () => {
            // PRECONDITION: this install already holds `2025/05/chain.jpg`. A bare file is enough —
            // claimRelativePath counts the disk as well as the media library — and it is the ordinary
            // case: a re-import after the `_wxr_source_url` stamps were lost, a two-site merge, or a
            // hand-copied wp-content/uploads.
            const seedBytes = Buffer.from('a real upload that this import knows nothing about');
            const seedOnDisk = onDisk('2025', '05', 'chain.jpg');
            fs.mkdirSync(path.dirname(seedOnDisk), { recursive: true });
            fs.writeFileSync(seedOnDisk, seedBytes);

            const summary = await importWxr(chainXml, {
                defaultAuthorId: adminId, media: 'download', allowHttp: true,
            });
            assert.strictEqual(summary.media.downloaded, 2, JSON.stringify(summary.media.failures));

            // THE PLAN IS THE CHAIN: A's output name is B's input name, which is what a sequence of
            // substring swaps re-swapped. WordPress mints `chain-1.jpg` itself, so a source site
            // carrying both files is an ordinary export, not a crafted one.
            assert.ok(fs.readFileSync(seedOnDisk).equals(seedBytes),
                'the file that was already there keeps its own bytes');
            assert.ok(fs.readFileSync(onDisk('2025', '05', 'chain-1.jpg')).equals(chainABytes),
                'attachment A was moved to chain-1.jpg');
            assert.ok(fs.readFileSync(onDisk('2025', '05', 'chain-1-1.jpg')).equals(chainBBytes),
                'attachment B, whose own name A had just taken, was moved again');

            const a = await dbAsync.get(
                `SELECT post_content, post_excerpt FROM posts WHERE post_name = 'chain-post-a'`);
            assert.ok(a.post_content.includes('/uploads/2025/05/chain-1.jpg'),
                'the body of post A must point at attachment A');
            assert.ok(!a.post_content.includes('chain-1-1.jpg'),
                'post A was rewritten twice and now renders attachment B: the WRONG image, not a 404');
            assert.strictEqual(a.post_excerpt, 'See /uploads/2025/05/chain-1.jpg',
                'the excerpt goes through the same single pass');

            const b = await dbAsync.get(`SELECT post_content FROM posts WHERE post_name = 'chain-post-b'`);
            assert.ok(b.post_content.includes('/uploads/2025/05/chain-1-1.jpg'),
                'and the last link of the chain — the one that was already right — stays right');

            const puckPage = await dbAsync.get(`SELECT id FROM posts WHERE post_name = 'chain-puck'`);
            const puck = JSON.parse(await rawMeta(puckPage.id, '_puck_data') as string);
            assert.strictEqual(puck.content[0].props.src, '/uploads/2025/05/chain-1.jpg',
                'a _puck_data string leaf is rewritten by the same pass, so it cannot cascade either');

            // A SUBSTRING IS NOT A REFERENCE. Three things that merely CONTAIN a renamed path.
            const edges = await dbAsync.get(
                `SELECT post_content FROM posts WHERE post_name = 'chain-post-edges'`);
            assert.ok(edges.post_content.includes('/uploads/2025/05/chain.jpg.bak'),
                'a longer path this one is a prefix of must not be rewritten inside');
            assert.ok(!edges.post_content.includes('chain-1.jpg.bak'));
            assert.ok(edges.post_content.includes('/uploads/2025/05/my-chain.jpg'),
                'nor a longer file name, which the /uploads/ anchor already excludes');
            assert.ok(edges.post_content.includes('https://other.example/wp-content/uploads/2025/05/chain.jpg'),
                'nor the same path on a host whose files this install never moved');
        });

        it('deleting a link-mode attachment never unlinks the real upload that shares its path', async () => {
            const Media = require('../models/Media');
            const photoOnDisk = onDisk('2025', '01', 'photo.jpg');
            const originalBytes = fs.readFileSync(photoOnDisk);
            const owner = await attachmentBySourceUrl(`${origin}${photoPath}`);
            assert.ok(owner, 'precondition: a real attachment row owns 2025/01/photo.jpg');

            // `link` mode never claims a path: it downloads nothing, so it copies the WXR's own
            // `_wp_attached_file` verbatim. Under the YYYY/MM layout every WordPress uses, that value is
            // free to be one this install already holds — and it does not have to be hostile to be: the
            // same site exported twice, or two sites merged, produce it by themselves.
            const remote = 'https://old.example/wp-content/uploads/2025/01/photo.jpg';
            const aliasXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>Aliasing</title>
    <wp:wxr_version>1.2</wp:wxr_version>
    <item>
      <title>Aliasing Photo</title>
      <dc:creator><![CDATA[admin]]></dc:creator>
      <content:encoded><![CDATA[]]></content:encoded>
      <excerpt:encoded><![CDATA[]]></excerpt:encoded>
      <wp:post_id>810</wp:post_id>
      <wp:post_name>aliasing-photo</wp:post_name>
      <wp:post_type>attachment</wp:post_type>
      <wp:status>inherit</wp:status>
      <wp:post_parent>0</wp:post_parent>
      <wp:attachment_url>${remote}</wp:attachment_url>
      <wp:post_mime_type><![CDATA[image/jpeg]]></wp:post_mime_type>
      <wp:postmeta><wp:meta_key>_wp_attached_file</wp:meta_key><wp:meta_value><![CDATA[2025/01/photo.jpg]]></wp:meta_value></wp:postmeta>
    </item>
  </channel>
</rss>`;
            const summary = await importWxr(aliasXml, { defaultAuthorId: adminId, media: 'link' });
            assert.strictEqual(summary.media.linked, 1, JSON.stringify(summary.media));

            const linked = await attachmentBySourceUrl(remote);
            assert.ok(linked, 'the linked attachment imported');
            assert.notStrictEqual(linked.id, owner.id, 'two rows now name one file');
            assert.strictEqual(await rawMeta(linked.id, '_wp_attached_file'), '2025/01/photo.jpg',
                'the WXR path is still recorded verbatim — that is what an operator copying uploads/ needs');

            await Media.delete(linked.id);

            assert.strictEqual(await dbAsync.get(`SELECT id FROM posts WHERE id = ?`, [linked.id]), undefined,
                'the row itself still goes — the row is what the operator asked to remove');
            assert.ok(fs.existsSync(photoOnDisk),
                'a row that never wrote a byte unlinked a REAL upload that happened to share its path');
            assert.ok(fs.readFileSync(photoOnDisk).equals(originalBytes), 'and it is the same bytes');
            const survivor = await Media.findById(owner.id);
            assert.strictEqual(survivor.mediaDetails.file, '2025/01/photo.jpg',
                'the genuine attachment still resolves to its own file, not to a hole');

            // CONTROL: an attachment that DOES own its file still takes it with it. The gate is about
            // ownership, not about switching unlinking off.
            const controlRelative = '2099/12/control.jpg';
            const controlOnDisk = onDisk('2099', '12', 'control.jpg');
            const controlBytes = Buffer.from('bytes this row wrote for itself');
            fs.mkdirSync(path.dirname(controlOnDisk), { recursive: true });
            fs.writeFileSync(controlOnDisk, controlBytes);
            const control = await Media.create({
                authorId: adminId,
                title: 'Control Upload',
                filename: controlRelative,
                mimeType: 'image/jpeg',
                filePath: controlRelative,
                fileSize: controlBytes.length,
                width: 1,
                height: 1,
            });
            await Media.delete(control.id);
            assert.strictEqual(fs.existsSync(controlOnDisk), false,
                'an attachment that owns its file must still delete it');
        });
    });
});
