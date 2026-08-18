/**
 * A post the author hid from search engines must not be SUBMITTED to them.
 *
 * THE BUG THIS PINS. The editor's SEO panel stores `noindex` in post_meta, and generateSitemap()
 * has always skipped `post.noindex` — but the sitemap route selected only
 * `post_name, post_type, post_status, post_modified, post_date`, so the flag it tested was
 * PERMANENTLY undefined. Every noindexed post kept appearing in /seo/sitemap.xml: the admin ticked
 * "ocultar de buscadores", the UI said saved, and WordJS went on handing the URL to Google.
 *
 * The test drives the REAL route over the REAL database through the REAL model writes
 * (Post.create + Post.updateMeta — the exact path the editor's save takes), because the defect was
 * a missing column in the route's SELECT: a hand-built fixture handed to generateSitemap() passes
 * happily both before and after the fix and proves nothing.
 *
 * Asserted here:
 *   1. a noindexed post is ABSENT from the sitemap while its ordinary sibling is present;
 *   2. every stored spelling of the flag hides the post, and only those (fail-OPEN: an unrecognised
 *      value must not de-list a live page);
 *   3. the sitemap's SHAPE is unchanged — same urlset, same homepage entry, same <lastmod> /
 *      <changefreq> / <priority> per URL, and no row duplicated by duplicate meta rows.
 *
 * Same CWD-sandbox ordering as feed-language.test.ts: chdir into a temp root BEFORE requiring
 * anything that resolves paths from the CWD at module load.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-sitemap-noindex-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

describe('the sitemap obeys the per-post noindex flag', () => {
    let request: any;
    let app: any;
    let dbAsync: any;
    let Post: any;

    /** Fetch the sitemap XML (asserting the route itself still works). */
    const sitemap = async (): Promise<string> => {
        const res = await request(app).get('/api/v1/seo/sitemap.xml');
        assert.strictEqual(res.status, 200, res.text);
        return res.text;
    };

    /** Every <loc> the sitemap prints, in order. */
    const locations = async (): Promise<string[]> => {
        const xml = await sitemap();
        return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((m: any) => m[1]);
    };

    /** Publish a post and return its id; `noindex` is written exactly as the editor writes it. */
    const publish = async (slug: string, noindex?: any): Promise<number> => {
        const post = await Post.create({
            authorId: 1, title: slug, content: '<p>x</p>', status: 'publish', type: 'post', slug,
        });
        const id = post.id ?? post;
        if (noindex !== undefined) await Post.updateMeta(id, 'noindex', noindex);
        return id;
    };

    before(async () => {
        request = require('supertest');

        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();

        const options = require('../core/options');
        await options.initDefaultOptions(config);
        await options.updateOption('siteurl', 'https://example.test');

        Post = require('../models/Post');

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '1mb' }));
        app.use('/api/v1/seo', require('../routes/seo'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        // Windows refuses to remove the CWD — step out of the temp root first.
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ------------------------------------------------------------------ 1. the exclusion

    it('leaves a noindexed post OUT while its ordinary sibling stays in', async () => {
        await publish('visible-uno');
        await publish('oculto-uno', true);

        const locs = await locations();
        assert.ok(locs.includes('https://example.test/visible-uno'), `visible post missing:\n${locs.join('\n')}`);
        assert.ok(
            !locs.includes('https://example.test/oculto-uno'),
            `a noindexed post must NOT be submitted to search engines:\n${locs.join('\n')}`,
        );
    });

    it('keeps a post whose flag was written and then turned back off', async () => {
        const id = await publish('vuelve-a-ser-visible', true);
        assert.ok(!(await locations()).includes('https://example.test/vuelve-a-ser-visible'));

        await Post.updateMeta(id, 'noindex', false);
        assert.ok(
            (await locations()).includes('https://example.test/vuelve-a-ser-visible'),
            'un-hiding a post must put it back in the sitemap',
        );
    });

    // ------------------------------------------------------------------ 2. the stored spellings

    it('hides the post for every spelling the flag is stored in — and only those', async () => {
        // The editor writes a real boolean (String()'d to 'true' by updateMeta); imports and legacy
        // content use the numeric / yes-no spellings.
        for (const hidden of [true, 'true', 'TRUE', '1', 1, 'yes', 'on']) {
            const slug = `oculto-${String(hidden).toLowerCase()}`;
            await publish(slug, hidden);
            assert.ok(
                !(await locations()).includes(`https://example.test/${slug}`),
                `${JSON.stringify(hidden)} must hide the post`,
            );
        }

        // Fail-OPEN: an unrecognised value leaves the page indexable rather than silently de-listing it.
        let n = 0;
        for (const visible of [false, 'false', '0', 0, '', 'no', 'off', 'quizás']) {
            const slug = `visible-${n++}`;
            await publish(slug, visible);
            assert.ok(
                (await locations()).includes(`https://example.test/${slug}`),
                `${JSON.stringify(visible)} must NOT hide the post`,
            );
        }
    });

    it('is not fooled by another post\'s meta or by an unrelated key', async () => {
        const id = await publish('otra-clave');
        await Post.updateMeta(id, 'seo_title', 'true');   // a DIFFERENT key whose value reads truthy
        assert.ok((await locations()).includes('https://example.test/otra-clave'));
    });

    // ------------------------------------------------------------------ 3. the shape is unchanged

    it('keeps the sitemap shape: one urlset, the homepage, and one entry per visible URL', async () => {
        const xml = await sitemap();
        assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
        assert.match(xml, /<\/urlset>$/);
        assert.match(xml, /<loc>https:\/\/example\.test\/<\/loc>\n\s*<changefreq>daily<\/changefreq>\n\s*<priority>1\.0<\/priority>/);
        // A content URL still carries its lastmod / changefreq / priority triplet.
        assert.match(xml, /<loc>https:\/\/example\.test\/visible-uno<\/loc>\n\s*<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>\n\s*<changefreq>weekly<\/changefreq>\n\s*<priority>0\.6<\/priority>/);

        const locs = await locations();
        assert.strictEqual(new Set(locs).size, locs.length, `no URL may be printed twice:\n${locs.join('\n')}`);
    });

    it('prints a post ONCE even when post_meta holds duplicate rows for it', async () => {
        // post_meta has no UNIQUE (post_id, meta_key) on legacy installs — a JOIN would have
        // multiplied the row. Insert the duplicate directly, which is the only way it happens.
        const id = await publish('duplicado');
        await dbAsync.run(
            'INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
            [id, 'noindex', 'false'],
        );
        await dbAsync.run(
            'INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
            [id, 'noindex', 'false'],
        );

        const locs = await locations();
        assert.strictEqual(
            locs.filter((l: string) => l === 'https://example.test/duplicado').length, 1,
            `duplicate meta rows must not duplicate the <url>:\n${locs.join('\n')}`,
        );
    });

    it('still excludes what it always excluded (drafts and trashed posts)', async () => {
        await Post.create({ authorId: 1, title: 'borrador', content: '', status: 'draft', type: 'post', slug: 'borrador' });
        assert.ok(!(await locations()).includes('https://example.test/borrador'));
    });
});
