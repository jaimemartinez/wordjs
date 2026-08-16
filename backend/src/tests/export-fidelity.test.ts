/**
 * WordJS — site export fidelity (regression suite for F7/H1 + F7/H2).
 *
 * Two data-loss bugs the F7 drills caught on the REAL dev corpus, both silent (HTTP 200, a file that
 * looks like an export, nothing inside it):
 *
 *   H1 — core/import-export.exportSite() asks Post.findAll({ status: 'any' }) and Post.buildWhere
 *        translated that into `post_status = 'any'`, a literal that matches no row. Measured on the
 *        live copy: 0 posts and 0 pages exported from an install holding 17 posts + 38 pages; the WXR
 *        came out at 874 bytes with ZERO <item>. Fixed in buildWhere (the one shared builder), so
 *        findAll() and count() cannot drift: 'any' = every status except trash/auto-draft.
 *
 *   H2 — exportToWXR() walked data.content.posts only, hard-coded <wp:post_type>post</wp:post_type>
 *        and emitted not a single <wp:postmeta>. Pages never appeared and `_puck_data` — the entire
 *        visual layout of every page — never left the install. Re-importing a WordJS export produced
 *        0 documents. Fixed on the exporter side; the importer already reads wp:postmeta.
 *
 * The round-trip below drives the REAL importer (core/wxr-import.importWxr) over the REAL exporter's
 * output and compares `_puck_data` BYTE for byte.
 *
 * IMPORTANT: `config.dbPath` is repointed to a temp file BEFORE requiring `../config/database` or
 * anything that transitively loads it (models bind dbAsync at require time). See wxr-import.test.ts.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Repoint the DB at a temp file FIRST.
const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-export-fidelity-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

// 2. Now it is safe to pull in the DB layer (and, later, the models / exporter / importer).
const database = require('../config/database');

/**
 * A Puck tree that is a FIXED POINT of the write sanitizer, so "byte-equal after a round-trip" is a
 * meaningful claim and not an accident: `content` holds already-clean HTML, and the awkward payload
 * (`]]>` — the CDATA terminator — plus raw & and <) lives in a prop the sanitizer passes through
 * verbatim. The fixed-point property itself is asserted below.
 */
const CDATA_BREAKOUT = 'a & b <c> ]]> fin';
function puckTree(label: string) {
    return {
        root: { props: { title: label } },
        content: [
            { type: 'Text', props: { id: 'txt-1', content: '<p>Hola</p>', note: CDATA_BREAKOUT } },
            { type: 'Hero', props: { id: 'hero-1', buttonLink: '/contacto', label: 'Ver más' } }
        ],
        zones: {}
    };
}

describe('site export fidelity — status:any (H1) and WXR postmeta (H2)', () => {
    let dbAsync: any;
    let Post: any, cache: any;
    let exportSite: any, exportToWXR: any, importWxr: any, sanitizeMetaValue: any;
    let adminId: number;

    // slug -> the exact bytes stored in post_meta._puck_data
    const storedPuck = new Map<string, string>();

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();

        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@test.local', 'Administrator']
        );
        adminId = (await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`)).id;

        Post = require('../models/Post');
        cache = require('../core/cache');
        ({ exportSite, exportToWXR } = require('../core/import-export'));
        ({ importWxr } = require('../core/wxr-import'));
        ({ sanitizeMetaValue } = require('../core/sanitize-meta'));

        // Seed one row per status that matters, across BOTH content types.
        const seed = [
            { type: 'post', slug: 'publicado', status: 'publish', puck: true },
            { type: 'post', slug: 'borrador', status: 'draft', puck: false },
            { type: 'post', slug: 'privado', status: 'private', puck: false },
            { type: 'post', slug: 'papelera', status: 'trash', puck: true },
            { type: 'post', slug: 'auto', status: 'auto-draft', puck: false },
            { type: 'page', slug: 'pagina-publicada', status: 'publish', puck: true },
            { type: 'page', slug: 'pagina-borrador', status: 'draft', puck: true }
        ];

        for (const s of seed) {
            const post = await Post.create({
                authorId: adminId,
                title: `T ${s.slug}`,
                content: `<p>cuerpo de ${s.slug}</p>`,
                excerpt: '',
                status: s.status,
                type: s.type,
                slug: s.slug
            });
            if (s.puck) {
                await Post.updateMeta(post.id, '_puck_data', puckTree(s.slug));
                const row = await dbAsync.get(
                    `SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = '_puck_data'`,
                    [post.id]
                );
                storedPuck.set(s.slug, row.meta_value);
            }
            // Volatile editor bookkeeping: must NEVER travel in an export (the importer skips it too).
            await Post.updateMeta(post.id, '_edit_lock', `1700000000:${adminId}`);
        }
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
    });

    it('the seeded _puck_data is a fixed point of the write sanitizer (premise of the byte checks)', () => {
        for (const [slug, raw] of storedPuck) {
            const resanitized = JSON.stringify(sanitizeMetaValue('_puck_data', JSON.parse(raw)));
            assert.strictEqual(resanitized, raw, `${slug}: the fixture must not change under the sanitizer`);
        }
    });

    // ---------------------------------------------------------------------------------------------
    // H1 — status:'any' means every status a reader may see, not the literal string 'any'.
    // ---------------------------------------------------------------------------------------------
    describe("H1 — Post.buildWhere resolves status:'any'", () => {
        it('findAll/count with status:any return publish+draft+private and exclude trash/auto-draft', async () => {
            const posts = await Post.findAll({ type: 'post', status: 'any', limit: 100 });
            assert.deepStrictEqual(
                posts.map((p: any) => p.postName).sort(),
                ['borrador', 'privado', 'publicado'],
                'status:any must not resolve to a literal post_status = "any"'
            );
            assert.strictEqual(await Post.count({ type: 'post', status: 'any' }), 3, 'count() must agree with findAll()');

            const pages = await Post.findAll({ type: 'page', status: 'any', limit: 100 });
            assert.deepStrictEqual(pages.map((p: any) => p.postName).sort(), ['pagina-borrador', 'pagina-publicada']);
        });

        it('an explicit status list still wins, and status:null means no filter at all', async () => {
            const onlyTrash = await Post.findAll({ type: 'post', includeStatuses: ['trash'], limit: 100 });
            assert.deepStrictEqual(onlyTrash.map((p: any) => p.postName), ['papelera']);

            const everything = await Post.findAll({ type: 'post', status: null, limit: 100 });
            assert.strictEqual(everything.length, 5, 'status:null is the explicit "give me literally everything" escape hatch');
        });

        it('exportSite() exports every post AND page instead of an empty site', async () => {
            const data = await exportSite();
            assert.deepStrictEqual(
                data.content.posts.map((p: any) => p.slug).sort(),
                ['borrador', 'privado', 'publicado'],
                'the bug exported 0 posts from a populated install'
            );
            assert.deepStrictEqual(
                data.content.pages.map((p: any) => p.slug).sort(),
                ['pagina-borrador', 'pagina-publicada']
            );
            assert.ok(!JSON.stringify(data.content.posts).includes('papelera'), 'trash must not be exported');
            assert.ok(!JSON.stringify(data.content.posts).includes('"auto"'), 'auto-draft must not be exported');
        });
    });

    // ---------------------------------------------------------------------------------------------
    // H2 — the WXR carries every type with its real post_type, plus wp:postmeta.
    // ---------------------------------------------------------------------------------------------
    describe('H2 — exportToWXR emits all content types and their postmeta', () => {
        let xml: string;

        before(async () => { xml = await exportToWXR(); });

        it('emits one <item> per exported post AND page, each with its real wp:post_type', () => {
            assert.strictEqual((xml.match(/<item>/g) || []).length, 5, 'pages used to be missing entirely');
            assert.strictEqual((xml.match(/<wp:post_type>post<\/wp:post_type>/g) || []).length, 3);
            assert.strictEqual(
                (xml.match(/<wp:post_type>page<\/wp:post_type>/g) || []).length,
                2,
                'post_type was hard-coded to "post" for every item'
            );
            for (const slug of ['publicado', 'borrador', 'privado', 'pagina-publicada', 'pagina-borrador']) {
                assert.ok(xml.includes(`<wp:post_name>${slug}</wp:post_name>`), `${slug} missing from the WXR`);
            }
            assert.ok(!xml.includes('papelera'), 'trashed content must not reach the export file');
        });

        it('emits <wp:postmeta> for _puck_data and drops the non-portable editor meta', () => {
            assert.strictEqual((xml.match(/<wp:postmeta>/g) || []).length, 3, 'not one postmeta was emitted before');
            assert.strictEqual((xml.match(/<wp:meta_key><!\[CDATA\[_puck_data\]\]><\/wp:meta_key>/g) || []).length, 3);
            assert.ok(!xml.includes('_edit_lock'), '_edit_lock is volatile editor state and must not travel');
        });

        it('splits a literal ]]> so the payload cannot break out of its CDATA section', () => {
            assert.ok(!/\]\]>\s*fin/.test(xml), 'a raw ]]> inside the payload would truncate the CDATA and corrupt the XML');
            assert.ok(xml.includes(']]]]><![CDATA[>'), 'the ]]> sequence must be split across two CDATA sections');
        });
    });

    // ---------------------------------------------------------------------------------------------
    // Round-trip: real exporter -> real importer, _puck_data byte-identical.
    // ---------------------------------------------------------------------------------------------
    describe('round-trip export -> import preserves _puck_data byte for byte', () => {
        let summary: any;

        before(async () => {
            const xml = await exportToWXR();

            // Re-import into the same (now emptied) install: the importer is idempotent by slug+type,
            // so the content has to be gone for it to actually create anything. Only one database can
            // exist per process (the driver binds config.dbPath at construction), which is exactly why
            // the F7 drill ran each leg in its own process.
            await dbAsync.run('DELETE FROM post_meta');
            await dbAsync.run('DELETE FROM posts');
            await dbAsync.run('DELETE FROM term_relationships');
            await cache.flush();

            assert.strictEqual((await dbAsync.get('SELECT COUNT(*) AS c FROM posts')).c, 0);

            summary = await importWxr(xml, { defaultAuthorId: adminId, importComments: false });
        });

        it('recreates every exported item', () => {
            assert.deepStrictEqual(summary.errors, []);
            assert.strictEqual(summary.posts.created, 3);
            assert.strictEqual(summary.pages.created, 2);
        });

        it('restores _puck_data with the exact bytes the editor stored', async () => {
            // Four documents carry a layout; the trashed one is deliberately not exported, so three
            // must come back byte-identical.
            assert.strictEqual(storedPuck.size, 4, 'fixture sanity');
            let checked = 0;
            for (const [slug, raw] of storedPuck) {
                if (slug === 'papelera') continue; // trashed: intentionally not exported
                const row = await dbAsync.get(
                    `SELECT pm.meta_value AS v FROM posts p
                       JOIN post_meta pm ON pm.post_id = p.id AND pm.meta_key = '_puck_data'
                      WHERE p.post_name = ?`,
                    [slug]
                );
                assert.ok(row, `${slug}: _puck_data did not survive the round-trip (0 documents before the fix)`);
                assert.strictEqual(row.v, raw, `${slug}: _puck_data must come back byte-identical`);
                checked++;
            }
            assert.strictEqual(checked, 3, 'three layouts had to be verified');
        });

        it('does not resurrect trashed content nor the volatile editor meta', async () => {
            assert.strictEqual((await dbAsync.get(`SELECT COUNT(*) AS c FROM posts WHERE post_name = 'papelera'`)).c, 0);
            assert.strictEqual((await dbAsync.get(`SELECT COUNT(*) AS c FROM post_meta WHERE meta_key = '_edit_lock'`)).c, 0);
        });
    });
});
