/**
 * WordJS - SEO Routes
 * Endpoints for sitemap.xml, robots.txt, and SEO-related endpoints
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const { getOption } = require('../core/options');
const { generateSitemap, generateRobotsTxt, generateRssFeed } = require('../core/seo-helper');
const {
    SITEMAP_MAX_URLS,
    SITEMAP_FETCH_CAP,
    feedItems,
    generateAtomFeed,
    generateJsonFeed,
    generateCommentsRssFeed,
    sitemapChunks,
    sitemapChunkName,
    generateSitemapIndex,
    generateSitemapUrlset,
    resolveFeedLimit,
    publicSeoUrl,
    isoDay,
} = require('../core/feeds');
const { toLanguageTag } = require('../core/language-tag');
const { authenticate } = require('../middleware/auth');
const { can } = require('../middleware/permissions');
const { requireRouteId, routeIdOrNull } = require('../core/query-params');

// THE ROUTE-ID CONTRACT — see core/query-params. `GET /seo/meta/:postId` guarded its id with
// `if (!postId)`, which catches NaN and 0 and nothing else: `/seo/meta/9999999999` sailed past it into
// `Post.findById` and became `22003 value out of range for type integer` — a 500 — on Postgres, and
// `/seo/meta/12abc` returned post 12's SEO metadata under a URL that is not post 12's.
//
// The refusal body is passed WHOLE (`{ body }`) instead of as a code/message pair because this route's
// own not-found answer is `{ error: 'Post not found' }`, with no `code` field at all. Sending the REST
// triple here would make a malformed id distinguishable from an absent one, which is the exact
// disclosure the contract exists to close.
router.param('postId', requireRouteId({ body: { error: 'Post not found' } }));

/**
 * @swagger
 * tags:
 *   name: SEO
 *   description: Search Engine Optimization endpoints
 */

/*
 * WHY EVERY PUBLIC OPERATION BELOW CARRIES `security: []`, AND WHY OMITTING IT IS NOT NEUTRAL.
 *
 * config/swagger.ts declares a DOCUMENT-level `security: [{ bearerAuth: [] }]`, which OpenAPI applies
 * to every operation that does not override it. An operation with no `security` key therefore does not
 * mean "unspecified" — it means "a JWT is REQUIRED". Every route in this file except `/seo/meta/{postId}`
 * is registered with no `authenticate` and no `optionalAuth`: they are fetched by crawlers and feed
 * readers with no credential at all. Leaving the key off published a spec that told swagger-ui to draw a
 * padlock on robots.txt and told a generated client to refuse the call unauthenticated.
 *
 * `security: []` (the EMPTY list) is the override that says "no credential"; the two-alternative form
 * (`- bearerAuth: []` then `- {}`) is for the optionalAuth routes elsewhere in the tree, which behave
 * differently when a credential is present. Nothing here behaves differently, so the empty list is the
 * truthful one. The admin preview at the bottom keeps its `bearerAuth`.
 */

/**
 * Is this RAW `post_meta.meta_value` the author's "hide from search engines" flag?
 *
 * The value arrives straight from SQL (no model layer, so no JSON.parse): the editor stores a
 * boolean, which Post.updateMeta String()s to `'true'` / `'false'`, while imported and legacy
 * content uses `1` / `'yes'` / `'on'`. Everything else — an absent row, `'false'`, `'0'`, junk —
 * means indexable. Deliberately fail-OPEN: reading "hidden" out of a value nobody recognises would
 * silently pull a live page out of the sitemap.
 */
function isNoindexMeta(value: any): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    // A value written through JSON.stringify arrives quoted (`"true"`) — unwrap before comparing.
    const normalized = value.trim().replace(/^"(.*)"$/, '$1').trim().toLowerCase();
    return ['true', '1', 'yes', 'on'].includes(normalized);
}

/**
 * The content rows the sitemap prints, in ONE query used by `/sitemap.xml` AND by every child
 * sitemap.
 *
 * Only the columns the sitemap prints — findAll dragged up to 10 000 FULL rows (post_content
 * included) through the model layer to emit slug + lastmod. The cap is now SITEMAP_FETCH_CAP, high
 * enough that a chunked site's index and children see the whole catalogue rather than its first page.
 *
 * Plus the ONE meta the sitemap has to obey: `noindex`. A post the author hid from search engines
 * must not be SUBMITTED to them either — generateSitemap has always skipped `post.noindex`, but
 * nothing ever selected it, so the flag was permanently undefined. A correlated scalar subquery, not
 * a JOIN: post_meta has no UNIQUE (post_id, meta_key) on legacy installs, and a duplicate row would
 * print the same <url> twice.
 *
 * SHARED ON PURPOSE. The index advertises which children exist and each child prints a slice; if the
 * two read the catalogue differently — a different filter, a different ORDER BY, a different cap —
 * a URL falls between them and is never submitted at all. One loader, one ordering, one filter.
 */
async function loadSitemapContent() {
    const { dbAsync } = require('../config/database');
    const rows = await dbAsync.all(
        "SELECT p.post_name, p.post_type, p.post_status, p.post_modified, p.post_date, " +
        "(SELECT pm.meta_value FROM post_meta pm WHERE pm.post_id = p.id AND pm.meta_key = 'noindex' LIMIT 1) AS noindex_meta " +
        "FROM posts p " +
        "WHERE p.post_type IN ('post', 'page') AND p.post_status = 'publish' " +
        `ORDER BY p.post_date DESC LIMIT ${Number(SITEMAP_FETCH_CAP)}`
    );
    return rows.map((r: any) => ({
        postName: r.post_name, postType: r.post_type, postStatus: r.post_status,
        postModified: r.post_modified, postDate: r.post_date,
        noindex: isNoindexMeta(r.noindex_meta),
    }));
}

/** One `<url>` block, with the changefreq/priority/lastmod the single-file sitemap has always used. */
function contentEntry(post: any, siteUrl: string) {
    return {
        loc: `${siteUrl}/${post.postName}`, // matches the page's rel=canonical — /<slug> for posts AND pages
        lastmod: isoDay(post.postModified || post.postDate),
        changefreq: 'weekly',
        priority: post.postType === 'page' ? '0.8' : '0.6',
    };
}

/**
 * The taxonomy archives, for the terms child sitemap. Only terms that actually have content
 * (`count > 0`) — an empty archive is a thin page, and submitting it is how a site earns a
 * "crawled, currently not indexed" pile.
 */
async function loadTermEntries(siteUrl: string) {
    const { dbAsync } = require('../config/database');
    const rows = await dbAsync.all(
        "SELECT t.slug, tt.taxonomy FROM terms t " +
        "JOIN term_taxonomy tt ON t.term_id = tt.term_id " +
        "WHERE tt.taxonomy IN ('category', 'post_tag') AND tt.count > 0 AND t.slug <> '' " +
        `ORDER BY tt.taxonomy ASC, t.slug ASC LIMIT ${Number(SITEMAP_FETCH_CAP)}`
    );
    return rows.map((r: any) => ({
        loc: `${siteUrl}/${r.taxonomy === 'category' ? 'category' : 'tag'}/${r.slug}`,
        lastmod: null, // a term carries no date; a fabricated one would just re-crawl the archive
        changefreq: 'weekly',
        priority: '0.4',
    }));
}

/** The homepage entry, identical to the one the single-file sitemap prints first. */
function homeEntry(siteUrl: string) {
    return { loc: `${siteUrl}/`, lastmod: null, changefreq: 'daily', priority: '1.0' };
}

/**
 * Group the catalogue the way the index chunks it — posts, pages, terms (the order SITEMAP_KINDS
 * fixes). The homepage LEADS the `pages` group rather than getting a child of its own: that group
 * therefore always exists, and `/` is always the first URL of `sitemap-pages-1.xml`.
 */
async function sitemapGroups(content: any[], siteUrl: string) {
    const visible = content.filter((post: any) => post.postStatus === 'publish' && !post.noindex && post.postName);
    return {
        posts: visible.filter((p: any) => p.postType !== 'page').map((p: any) => contentEntry(p, siteUrl)),
        pages: [homeEntry(siteUrl), ...visible.filter((p: any) => p.postType === 'page').map((p: any) => contentEntry(p, siteUrl))],
        terms: await loadTermEntries(siteUrl),
    };
}

// WHERE THESE DOCUMENTS ARE PUBLISHED IS NOT WHERE THEY ARE GENERATED.
//
// Every URL this router PRINTS — the `<loc>` of each sitemap child, each feed's `self` link, the
// `Sitemap:` line of robots.txt — goes through `publicSeoUrl()` (core/feeds.ts), which addresses the
// document at the site root. It used to be `siteUrl + req.baseUrl`, i.e. `<siteUrl>/api/v1/seo/…`:
// the router's own mount, and the very prefix the robots.txt below tells crawlers to skip
// (`Disallow: /api/`). Every child sitemap was therefore submitted at a URL the same file forbids,
// and every feed self-identified at a URL no reader would guess. The frontend publishes each of
// these documents at the public URL and proxies the request back here, so the generator stays in one
// place while the advertisement is an address the outside world can actually use.

/**
 * THE SWITCH, resolved ONCE for both the index and the children.
 *
 * Counted over what the single file would print — the homepage plus every visible post and page —
 * because that is the file whose size is the problem. At or below SITEMAP_MAX_URLS nothing changes:
 * the same generator produces the same bytes it always has, so an ordinary site's sitemap does not
 * move the day this route learns to chunk. Above it, the response becomes an index and the URLs move
 * into children of at most SITEMAP_MAX_URLS each.
 *
 * The children come from the same call, so exactly one representation of the sitemap is live at any
 * moment: while the site is small the children do not exist (a chunk URL is a 404, not a second copy
 * of the same URLs), and while it is chunked the index advertises every child that answers.
 */
async function sitemapPlan(req: Request) {
    const siteUrl = await getOption('siteurl', `${req.protocol}://${req.get('host')}`);
    const content = await loadSitemapContent();
    const visible = content.filter((post: any) => post.postStatus === 'publish' && !post.noindex && post.postName);
    const chunked = visible.length + 1 > SITEMAP_MAX_URLS; // + the homepage

    return {
        siteUrl,
        content,
        chunked,
        // Only a chunked site pays for the taxonomy query.
        chunks: chunked ? sitemapChunks(await sitemapGroups(content, siteUrl)) : [],
    };
}

/**
 * @swagger
 * /seo/sitemap.xml:
 *   get:
 *     summary: Get dynamic XML sitemap (a urlset, or a sitemapindex once the site outgrows one file)
 *     tags: [SEO]
 *     security: []
 *     responses:
 *       200:
 *         description: XML sitemap
 *         content:
 *           application/xml:
 *             schema:
 *               type: string
 */
router.get('/sitemap.xml', async (req: Request, res: Response) => {
    try {
        const plan = await sitemapPlan(req);

        const xml = plan.chunked
            ? generateSitemapIndex(plan.chunks, { siteUrl: plan.siteUrl })
            : await generateSitemap(plan.content, { siteUrl: plan.siteUrl });

        res.set('Content-Type', 'application/xml');
        res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
        res.send(xml);
    } catch (error) {
        console.error('Sitemap error:', error);
        res.status(500).send('Error generating sitemap');
    }
});

/**
 * @swagger
 * /seo/sitemap-{kind}-{page}.xml:
 *   get:
 *     summary: One chunk of the sitemap index (posts, pages or terms), at most 1000 URLs
 *     tags: [SEO]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: kind
 *         required: true
 *         schema:
 *           type: string
 *           enum: [posts, pages, terms]
 *       - in: path
 *         name: page
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: XML urlset
 *       404:
 *         description: No such chunk
 */
router.get('/sitemap-:kind-:page.xml', async (req: Request, res: Response) => {
    try {
        const plan = await sitemapPlan(req);

        // The chunk is looked up in the SAME list the index advertises, so a name the index never
        // printed is a 404 rather than an empty urlset — including every chunk of a site that has
        // since shrunk back below the threshold, and every chunk of a site that never crossed it.
        const name = sitemapChunkName(String(req.params.kind), Number(req.params.page));
        const chunk = plan.chunks.find((c: any) => sitemapChunkName(c.kind, c.page) === name);
        if (!chunk) {
            res.status(404).set('Content-Type', 'text/plain').send('Sitemap not found');
            return;
        }

        res.set('Content-Type', 'application/xml');
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(generateSitemapUrlset(chunk.entries));
    } catch (error) {
        console.error('Sitemap chunk error:', error);
        res.status(500).send('Error generating sitemap');
    }
});

/**
 * @swagger
 * /seo/robots.txt:
 *   get:
 *     summary: Get dynamic robots.txt
 *     tags: [SEO]
 *     security: []
 *     responses:
 *       200:
 *         description: robots.txt content
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 */
router.get('/robots.txt', async (req: Request, res: Response) => {
    try {
        const siteUrl = await getOption('siteurl', `${req.protocol}://${req.get('host')}`);
        const robotsTxt = generateRobotsTxt(siteUrl, publicSeoUrl(siteUrl, 'sitemap.xml'));

        res.set('Content-Type', 'text/plain');
        res.set('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
        res.send(robotsTxt);
    } catch (error) {
        console.error('Robots.txt error:', error);
        res.status(500).send('Error generating robots.txt');
    }
});

/**
 * @swagger
 * /seo/feed.xml:
 *   get:
 *     summary: RSS 2.0 feed of the latest published posts
 *     tags: [SEO]
 *     security: []
 *     responses:
 *       200:
 *         description: RSS feed
 *         content:
 *           application/rss+xml:
 *             schema:
 *               type: string
 */
/**
 * Everything every feed needs, read once and in one place: the four channel options and the item
 * count. The `self` URL is NOT one of them — each route builds its own through `publicSeoUrl`,
 * because it is the one thing that differs between the channels this helper is shared by.
 *
 * WPLANG holds a LOCALE (`en_US` — locale files are named by that exact spelling); RSS <language>
 * wants a BCP 47 TAG, whose subtag separator is a hyphen. Convert here, at the boundary, instead of
 * storing a second spelling that could drift from the first.
 *
 * The item count comes from `posts_per_rss` when an admin has set it and otherwise stays at the 20
 * this route has always sent — see resolveFeedLimit for why `posts_per_page` is NOT the fallback.
 */
async function feedChannel(req: Request) {
    const siteUrl = await getOption('siteurl', `${req.protocol}://${req.get('host')}`);
    return {
        siteUrl,
        title: await getOption('blogname', 'WordJS Site'),
        description: await getOption('blogdescription', ''),
        language: toLanguageTag(await getOption('WPLANG', 'en')),
        limit: resolveFeedLimit(await getOption('posts_per_rss', null)),
    };
}

/** Feeds are public, cacheable and short-lived — the same 15 minutes RSS has always advertised. */
function sendFeed(res: Response, contentType: string, body: string) {
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=900'); // 15 min
    res.send(body);
}

router.get('/feed.xml', async (req: Request, res: Response) => {
    try {
        const channel = await feedChannel(req);
        const posts = await Post.findAll({ type: 'post', status: 'publish', limit: channel.limit });
        // The self link is stated rather than left to the generator's default: that default is
        // `<siteUrl>/feed`, an address nothing has ever served, so this channel was the only one
        // pointing at a URL that 404s.
        const xml = generateRssFeed(posts, { ...channel, selfUrl: publicSeoUrl(channel.siteUrl, 'feed.xml') });

        sendFeed(res, 'application/rss+xml; charset=utf-8', xml);
    } catch (error) {
        console.error('RSS feed error:', error);
        res.status(500).send('Error generating feed');
    }
});

/**
 * @swagger
 * /seo/feed.atom:
 *   get:
 *     summary: Atom 1.0 feed of the latest published posts
 *     tags: [SEO]
 *     security: []
 *     responses:
 *       200:
 *         description: Atom feed
 *         content:
 *           application/atom+xml:
 *             schema:
 *               type: string
 */
router.get('/feed.atom', async (req: Request, res: Response) => {
    try {
        const channel = await feedChannel(req);
        const posts = await Post.findAll({ type: 'post', status: 'publish', limit: channel.limit });
        const xml = generateAtomFeed(feedItems(posts, channel), {
            ...channel,
            selfUrl: publicSeoUrl(channel.siteUrl, 'feed.atom'),
        });

        sendFeed(res, 'application/atom+xml; charset=utf-8', xml);
    } catch (error) {
        console.error('Atom feed error:', error);
        res.status(500).send('Error generating feed');
    }
});

/**
 * @swagger
 * /seo/feed.json:
 *   get:
 *     summary: JSON Feed 1.1 of the latest published posts
 *     tags: [SEO]
 *     security: []
 *     responses:
 *       200:
 *         description: JSON feed
 *         content:
 *           application/feed+json:
 *             schema:
 *               type: string
 */
router.get('/feed.json', async (req: Request, res: Response) => {
    try {
        const channel = await feedChannel(req);
        const posts = await Post.findAll({ type: 'post', status: 'publish', limit: channel.limit });
        const json = generateJsonFeed(feedItems(posts, channel), {
            ...channel,
            selfUrl: publicSeoUrl(channel.siteUrl, 'feed.json'),
        });

        // res.send() of a STRING, not res.json() of an object: the body is already serialised and the
        // content type is the JSON Feed one, not application/json.
        sendFeed(res, 'application/feed+json; charset=utf-8', json);
    } catch (error) {
        console.error('JSON feed error:', error);
        res.status(500).send('Error generating feed');
    }
});

/**
 * A scoped RSS channel: the SAME generator and the same item shape as `/feed.xml`, over a filtered
 * post list, with the `link`/`selfUrl` that say which scope it is.
 *
 * `posts` is loaded by the caller because each scope selects differently; what is shared here is
 * everything a reader can tell apart, so a category feed cannot end up shaped unlike the site feed.
 */
async function sendScopedRss(req: Request, res: Response, scope: { posts: any[]; name: string; link: string; selfPath: string }) {
    const channel = await feedChannel(req);
    const xml = generateRssFeed(scope.posts, {
        ...channel,
        title: `${channel.title} — ${scope.name}`,
        link: scope.link,
        selfUrl: publicSeoUrl(channel.siteUrl, scope.selfPath),
    });
    sendFeed(res, 'application/rss+xml; charset=utf-8', xml);
}

/** A slug arriving in a URL: bounded before it becomes a query. Anything longer is not a slug. */
function usableSlug(value: any): string | null {
    const slug = String(value ?? '');
    return slug.length > 0 && slug.length <= 200 ? slug : null;
}

function feedNotFound(res: Response) {
    res.status(404).set('Content-Type', 'text/plain').send('Feed not found');
}

/** The published posts in one taxonomy term, newest first — the feed's window, not the archive's. */
async function postsInTerm(termTaxonomyId: number, limit: number) {
    const { dbAsync } = require('../config/database');
    const rows = await dbAsync.all(
        'SELECT p.* FROM posts p ' +
        'JOIN term_relationships tr ON p.id = tr.object_id ' +
        "WHERE tr.term_taxonomy_id = ? AND p.post_status = 'publish' AND p.post_type = 'post' " +
        'ORDER BY p.post_date DESC LIMIT ?',
        [termTaxonomyId, limit],
    );
    return rows.map((row: any) => new Post(row));
}

/** Resolve `slug` inside one taxonomy, or null. Returns the row the relationship table joins on. */
async function findTerm(slug: string, taxonomy: string) {
    const { dbAsync } = require('../config/database');
    return await dbAsync.get(
        'SELECT t.name, t.slug, tt.term_taxonomy_id FROM terms t ' +
        'JOIN term_taxonomy tt ON t.term_id = tt.term_id ' +
        'WHERE t.slug = ? AND tt.taxonomy = ? LIMIT 1',
        [slug, taxonomy],
    );
}

/**
 * A CHANNEL IDENTIFIES ITSELF BY THE ROW IT RESOLVED, NEVER BY THE SEGMENT IT WAS ASKED FOR.
 *
 * The two URLs below were built from the RAW request segment. That is the same string as `term.slug`
 * only while the database compares slugs case-sensitively: MySQL's default collation does not, so
 * `/category/NEWS/feed.xml` resolves the `news` row and then prints `<link>{siteUrl}/category/NEWS` and
 * a `rel=self` of `/category/NEWS/feed.xml` — a second spelling of a channel the frontend archive
 * deliberately canonicalises the other way (it builds its basePath from `term.slug` precisely so the
 * two spellings are ONE address). A feed that self-identifies at a second URL is how a reader ends up
 * subscribed twice to the same channel, with every item duplicated in their reader.
 *
 * So the resolved values are the ones that reach the markup, and the request segment is used for
 * nothing but the lookup.
 */
async function sendTermFeed(req: Request, res: Response, taxonomy: string, prefix: string) {
    const slug = usableSlug(req.params.slug);
    if (!slug) return feedNotFound(res);

    const term = await findTerm(slug, taxonomy);
    if (!term) return feedNotFound(res);

    const canonical = String(term.slug || slug);
    const channel = await feedChannel(req);
    const posts = await postsInTerm(term.term_taxonomy_id, channel.limit);

    await sendScopedRss(req, res, {
        posts,
        name: String(term.name || canonical),
        link: `${channel.siteUrl}/${prefix}/${canonical}`,
        selfPath: `/${prefix}/${canonical}/feed.xml`,
    });
}

/**
 * @swagger
 * /seo/category/{slug}/feed.xml:
 *   get:
 *     summary: RSS 2.0 feed of the published posts in one category
 *     tags: [SEO]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: RSS feed
 *       404:
 *         description: No such category
 */
router.get('/category/:slug/feed.xml', async (req: Request, res: Response) => {
    try {
        await sendTermFeed(req, res, 'category', 'category');
    } catch (error) {
        console.error('Category feed error:', error);
        res.status(500).send('Error generating feed');
    }
});

/**
 * @swagger
 * /seo/tag/{slug}/feed.xml:
 *   get:
 *     summary: RSS 2.0 feed of the published posts with one tag
 *     tags: [SEO]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: RSS feed
 *       404:
 *         description: No such tag
 */
router.get('/tag/:slug/feed.xml', async (req: Request, res: Response) => {
    try {
        await sendTermFeed(req, res, 'post_tag', 'tag');
    } catch (error) {
        console.error('Tag feed error:', error);
        res.status(500).send('Error generating feed');
    }
});

/**
 * @swagger
 * /seo/author/{slug}/feed.xml:
 *   get:
 *     summary: RSS 2.0 feed of one author's published posts
 *     tags: [SEO]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: RSS feed
 *       404:
 *         description: No such author
 */
router.get('/author/:slug/feed.xml', async (req: Request, res: Response) => {
    try {
        const slug = usableSlug(req.params.slug);
        if (!slug) return feedNotFound(res);

        // An author is addressed by user_nicename (WordPress's public author slug) — but nothing in
        // WordJS populates that column yet, so user_login is accepted as the same identity, AND so is
        // the numeric user id, because that is what the public author ARCHIVE is keyed by (the /users
        // router is authenticated, so a post's serialised author is a bare number with no name on it).
        // An all-digits segment is therefore read as an id: a user whose LOGIN is digits is not
        // reachable here, which is the right trade when the archive URL it must match is the id.
        // Only the id and the display name are read — an author feed must not become an e-mail
        // enumeration.
        const { dbAsync } = require('../config/database');
        // A digit-only segment is a ROUTE ID and goes through the same bounded parser as every other
        // public id (1-10 digits, <= MAX_ROUTE_ID): `Number('99999999999999999999')` is a perfectly
        // valid JS number that Postgres refuses as an integer with a 500, the class this file's
        // header says it closed. Out of range is simply "no such author".
        const digitsOnly = /^\d+$/.test(slug);
        const routeId = digitsOnly ? routeIdOrNull(slug) : null;
        if (digitsOnly && routeId === null) return feedNotFound(res);
        const user = routeId !== null
            ? await dbAsync.get('SELECT id, display_name, user_login, user_nicename FROM users WHERE id = ? LIMIT 1', [routeId])
            : await dbAsync.get(
                "SELECT id, display_name, user_login, user_nicename FROM users " +
                // user_login is a fallback for a row whose nicename is EMPTY, never an alias for one that
                // has a nicename: otherwise `/author/<login>/feed.xml` answers 200 or 404 by whether that
                // LOGIN exists, and a public feed becomes a login-enumeration oracle for the sign-in form.
                "WHERE (user_nicename = ? AND user_nicename <> '') " +
                "OR (user_login = ? AND (user_nicename IS NULL OR user_nicename = '')) LIMIT 1",
                [slug, slug],
            );
        if (!user) return feedNotFound(res);

        // SAME RULE AS sendTermFeed: two spellings resolve one author (nicename and numeric id; login only
        // while the nicename is empty), 
        // and the channel has to name ONE of them or a reader that arrives by the id subscribes to a
        // second copy of the same feed. `user_nicename` is the public author slug and wins when it is
        // populated. When it is EMPTY the fallback is the numeric id — the SAME rule as
        // `Post.getAuthorsForIds` (which serialises `slug: nicename || id`), so the archive the frontend
        // canonicalises on `author.slug` and this channel name the same URL. The login is never an
        // output: the lookup above accepts it for a nicename-less row so an old subscription keeps
        // working, but a channel that printed it would publish the sign-in name of an account.
        const canonical = String(user.user_nicename || user.id);
        const channel = await feedChannel(req);
        const posts = await Post.findAll({ type: 'post', status: 'publish', author: user.id, limit: channel.limit });

        await sendScopedRss(req, res, {
            posts,
            name: String(user.display_name || user.user_login || canonical),
            link: `${channel.siteUrl}/author/${canonical}`,
            selfPath: `/author/${canonical}/feed.xml`,
        });
    } catch (error) {
        console.error('Author feed error:', error);
        res.status(500).send('Error generating feed');
    }
});

/**
 * @swagger
 * /seo/comments/feed.xml:
 *   get:
 *     summary: RSS 2.0 feed of the latest approved comments
 *     tags: [SEO]
 *     security: []
 *     responses:
 *       200:
 *         description: RSS feed
 *         content:
 *           application/rss+xml:
 *             schema:
 *               type: string
 */
router.get('/comments/feed.xml', async (req: Request, res: Response) => {
    try {
        const channel = await feedChannel(req);

        // APPROVED comments on PUBLISHED, unprotected content only, and only the columns a reader may
        // see: the public comments API withholds the commenter's e-mail and IP from everyone but a
        // moderator, and an unauthenticated feed is the last place they may reappear — so they are
        // not selected at all. Pingbacks/trackbacks are excluded (WordJS sends none and imports none).
        const { dbAsync } = require('../config/database');
        const rows = await dbAsync.all(
            'SELECT c.comment_id, c.comment_author, c.comment_date, c.comment_content, ' +
            'p.post_name, p.post_title FROM comments c ' +
            'JOIN posts p ON p.id = c.comment_post_id ' +
            "WHERE c.comment_approved = '1' AND p.post_status = 'publish' " +
            "AND p.post_type IN ('post', 'page') AND p.post_password = '' " +
            "AND c.comment_type IN ('comment', '') " +
            'ORDER BY c.comment_date DESC LIMIT ?',
            [channel.limit],
        );

        const xml = generateCommentsRssFeed(rows, {
            ...channel,
            title: `${channel.title} — Comments`,
            selfUrl: publicSeoUrl(channel.siteUrl, 'comments/feed.xml'),
        });

        sendFeed(res, 'application/rss+xml; charset=utf-8', xml);
    } catch (error) {
        console.error('Comments feed error:', error);
        res.status(500).send('Error generating feed');
    }
});

/**
 * @swagger
 * /seo/meta/{postId}:
 *   get:
 *     summary: Get SEO metadata for a post (Admin Preview)
 *     tags: [SEO]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: postId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: SEO metadata
 */
router.get('/meta/:postId', authenticate, can('edit_posts'), async (req: Request, res: Response) => {
    try {
        // `:postId` is typed `string | string[]`; parseInt ToString()s it either way - same value.
        const postId = parseInt(String(req.params.postId), 10);
        if (!postId) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const post = await Post.findById(postId);

        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        // SECURITY: this is an admin-preview contract (security: bearerAuth in the swagger). It was
        // registered with NO middleware, leaking unpublished title/excerpt/keywords to anyone. Require
        // auth + edit_posts above; additionally hide non-published posts authored by others from a
        // non-privileged editor.
        if (post.postStatus !== 'publish') {
            const isOwner = post.authorId === req.user.id;
            if (!isOwner && !req.user.can('edit_others_posts')) {
                return res.status(404).json({ error: 'Post not found' });
            }
        }

        res.json({
            title: post.seo_title || post.postTitle || post.title,
            description: post.seo_description || post.postExcerpt || post.excerpt || '',
            keywords: post.seo_keywords || '',
            og_image: post.og_image || post.featured_image || '',
            noindex: post.noindex || false,
            canonical: `/${post.postName || post.slug}` // live canonical is /<slug> for posts AND pages
        });
    } catch (error) {
        console.error('SEO meta error:', error);
        res.status(500).json({ error: 'Error fetching SEO data' });
    }
});

module.exports = router;
