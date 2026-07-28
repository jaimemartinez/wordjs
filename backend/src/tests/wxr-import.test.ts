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

// 1. Repoint the DB at a temp file FIRST.
const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-wxr-test-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

// 2. Now it is safe to pull in the DB layer (and, later, the importer).
const database = require('../config/database');

const FIXTURE = path.join(__dirname, 'fixtures', 'sample-export.wxr');

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
});
