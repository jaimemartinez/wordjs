/**
 * WordJS - SEO Tests
 * Unit tests for SEO functionality
 *
 * The suites at the BOTTOM of this file drive the real sitemap and feed routes over a real database
 * (see "Feeds and sitemap chunking"), so the CWD is moved into a temp root here, at the top, BEFORE
 * anything that resolves paths from the CWD at module load — the same ordering feed-language.test.ts
 * and sitemap-noindex.test.ts rely on.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

// Import SEO helper (mocking path for test)
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-seo-feeds-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

const appConfig = require('../config/app');
appConfig.dbPath = path.join(TMP_ROOT, 'test.db');
appConfig.dbDriver = 'sqlite-native';

describe('SEO Helper', () => {
    // Mock helper functions for testing
    const escapeHtml = (text: string | null | undefined) => {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;');
    };

    it('should escape HTML entities', () => {
        assert.strictEqual(escapeHtml('<script>'), '&lt;script&gt;');
        assert.strictEqual(escapeHtml('"test"'), '&quot;test&quot;');
        assert.strictEqual(escapeHtml("it's"), "it&#x27;s");
    });

    it('should handle empty strings', () => {
        assert.strictEqual(escapeHtml(''), '');
        assert.strictEqual(escapeHtml(null), '');
        assert.strictEqual(escapeHtml(undefined), '');
    });
});

describe('Meta Tags', () => {
    it('should validate meta tag structure', () => {
        const metaTag = '<meta name="description" content="Test description">';
        assert.ok(metaTag.includes('name='), 'Meta tag must have name');
        assert.ok(metaTag.includes('content='), 'Meta tag must have content');
    });

    it('should validate Open Graph tags', () => {
        const ogTags = [
            '<meta property="og:title" content="Title">',
            '<meta property="og:description" content="Desc">',
            '<meta property="og:image" content="image.jpg">'
        ];

        ogTags.forEach(tag => {
            assert.ok(tag.includes('property="og:'), 'OG tag must have og: prefix');
        });
    });

    it('should validate Twitter Card tags', () => {
        const twitterTags = [
            '<meta name="twitter:card" content="summary_large_image">',
            '<meta name="twitter:title" content="Title">'
        ];

        twitterTags.forEach(tag => {
            assert.ok(tag.includes('twitter:'), 'Twitter tag must have twitter: prefix');
        });
    });
});

describe('Sitemap XML', () => {
    it('should generate valid XML header', () => {
        const xml = '<?xml version="1.0" encoding="UTF-8"?>';
        assert.ok(xml.includes('<?xml'), 'Must have XML declaration');
        assert.ok(xml.includes('UTF-8'), 'Must use UTF-8 encoding');
    });

    it('should include urlset namespace', () => {
        const urlset = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
        assert.ok(urlset.includes('sitemaps.org'), 'Must reference sitemap schema');
    });

    it('should validate URL entry structure', () => {
        const entry = `
            <url>
                <loc>https://example.com/page</loc>
                <lastmod>2026-01-18</lastmod>
                <changefreq>weekly</changefreq>
                <priority>0.8</priority>
            </url>
        `;

        assert.ok(entry.includes('<loc>'), 'Must have loc element');
        assert.ok(entry.includes('<url>'), 'Must be wrapped in url element');
    });

    it('should validate priority values', () => {
        const isValidPriority = (p: string) => parseFloat(p) >= 0 && parseFloat(p) <= 1;

        assert.ok(isValidPriority('1.0'), '1.0 is valid');
        assert.ok(isValidPriority('0.5'), '0.5 is valid');
        assert.ok(isValidPriority('0.0'), '0.0 is valid');
        assert.ok(!isValidPriority('1.5'), '1.5 is invalid');
    });

    it('should validate changefreq values', () => {
        const validFreqs = ['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'];

        assert.ok(validFreqs.includes('daily'), 'daily is valid');
        assert.ok(validFreqs.includes('weekly'), 'weekly is valid');
        assert.ok(!validFreqs.includes('biweekly'), 'biweekly is invalid');
    });
});

describe('Robots.txt', () => {
    it('should have User-agent directive', () => {
        const robots = 'User-agent: *\nAllow: /';
        assert.ok(robots.includes('User-agent:'), 'Must have User-agent');
    });

    it('should include sitemap reference', () => {
        const robots = 'Sitemap: https://example.com/sitemap.xml';
        assert.ok(robots.includes('Sitemap:'), 'Should reference sitemap');
    });

    it('should block sensitive paths', () => {
        const robots = 'Disallow: /api/\nDisallow: /admin/';
        assert.ok(robots.includes('/api/'), 'Should block API');
        assert.ok(robots.includes('/admin/'), 'Should block admin');
    });
});

describe('JSON-LD Schema', () => {
    it('should have valid context', () => {
        const schema = { "@context": "https://schema.org" };
        assert.strictEqual(schema["@context"], "https://schema.org");
    });

    it('should define article type', () => {
        const schema = { "@type": "Article" };
        assert.ok(['Article', 'WebPage', 'BlogPosting'].includes(schema["@type"]));
    });

    it('should include required article properties', () => {
        const article = {
            "@type": "Article",
            "headline": "Title",
            "datePublished": "2026-01-18",
            "author": { "@type": "Person", "name": "Author" }
        };

        assert.ok(article.headline, 'Article must have headline');
        assert.ok(article.datePublished, 'Article must have datePublished');
        assert.ok(article.author, 'Article must have author');
    });

    it('should validate person schema', () => {
        const person = { "@type": "Person", "name": "John Doe" };
        assert.strictEqual(person["@type"], "Person");
        assert.ok(person.name, 'Person must have name');
    });

    it('should validate organization schema', () => {
        const org = {
            "@type": "Organization",
            "name": "Company",
            "logo": { "@type": "ImageObject", "url": "logo.png" }
        };
        assert.strictEqual(org["@type"], "Organization");
        assert.ok(org.name, 'Organization must have name');
    });
});

describe('Canonical URLs', () => {
    it('should generate valid canonical link', () => {
        const canonical = '<link rel="canonical" href="https://example.com/page">';
        assert.ok(canonical.includes('rel="canonical"'), 'Must have rel=canonical');
        assert.ok(canonical.includes('href='), 'Must have href');
    });

    it('should use absolute URLs', () => {
        const url = 'https://example.com/blog/post';
        assert.ok(url.startsWith('http'), 'Canonical must be absolute URL');
    });
});

console.log('Running WordJS SEO Tests...');

// ===================================================================================================
// FEEDS AND SITEMAP CHUNKING
//
// What is pinned here, and why each assertion exists:
//
//   1. THE FORMATS CANNOT DRIFT APART. Atom and JSON Feed are new renderings of the item set the RSS
//      channel has always published, so the expectations for them are DERIVED FROM THE REAL RSS
//      OUTPUT — parsed out of `generateRssFeed`'s own XML — rather than from a fixture written by
//      hand. A fixture would agree with whichever of the two producers it was copied from and go on
//      agreeing after the other one changed.
//   2. THE ESCAPING POSTURE IS THE OLD ONE. A `<script>` in a title has to come out of every feed
//      escaped, in the same way, from the same escaper.
//   3. THE SITEMAP SWITCH IS EXACT. At the threshold the response is byte-for-byte the single
//      `<urlset>` this site has always served; one URL later it is a `<sitemapindex>` whose children
//      hold every URL and no child holds more than the chunk size.
// ===================================================================================================

const {
    SITEMAP_MAX_URLS,
    DEFAULT_FEED_ITEMS,
    feedItems,
    generateAtomFeed,
    generateJsonFeed,
    sitemapChunks,
    sitemapChunkName,
    generateSitemapIndex,
    generateSitemapUrlset,
    resolveFeedLimit,
    publicSeoUrl,
} = require('../core/feeds');
const { generateRssFeed, generateRobotsTxt } = require('../core/seo-helper');

/**
 * THE FRONTEND'S HALF of the public-URL contract, written out here so the two halves are asserted
 * against each other rather than each against itself.
 *
 * `frontend/src/app/(public)/sitemap/[chunk]/route.ts` receives the last segment of the public URL,
 * rebuilds the backend's file name by prepending `sitemap-`, refuses anything that is not
 * `^sitemap-(posts|pages|terms)-\d+\.xml$`, and proxies it to the `/seo` mount. Given a `<loc>` the
 * index really printed, this returns the backend path that answers it — or null if the frontend
 * would have refused the URL, which is a failure, not a skip.
 */
const CHUNK_NAME = /^sitemap-(posts|pages|terms)-\d+\.xml$/;
const backendPathOfChunk = (loc: string, siteUrl: string): string | null => {
    const publicPath = loc.startsWith(siteUrl) ? loc.slice(siteUrl.length) : loc;
    const segment = /^\/sitemap\/([^/]+)$/.exec(publicPath)?.[1];
    if (!segment) return null;
    const name = `sitemap-${segment}`;
    return CHUNK_NAME.test(name) ? `/api/v1/seo/${name}` : null;
};

/** Pull the `<item>` blocks out of a real RSS channel — the reference every other format is held to. */
const rssItemsOf = (xml: string) => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m: any) => ({
    title: (/<title>([\s\S]*?)<\/title>/.exec(m[1]) || [])[1],
    link: (/<link>([\s\S]*?)<\/link>/.exec(m[1]) || [])[1],
    guid: (/<guid[^>]*>([\s\S]*?)<\/guid>/.exec(m[1]) || [])[1],
    description: (/<description>([\s\S]*?)<\/description>/.exec(m[1]) || [])[1],
}));

const atomEntriesOf = (xml: string) => [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m: any) => ({
    id: (/<id>([\s\S]*?)<\/id>/.exec(m[1]) || [])[1],
    title: (/<title type="text">([\s\S]*?)<\/title>/.exec(m[1]) || [])[1],
    updated: (/<updated>([\s\S]*?)<\/updated>/.exec(m[1]) || [])[1],
    href: (/<link rel="alternate" type="text\/html" href="([^"]*)"\/>/.exec(m[1]) || [])[1],
    summary: (/<summary type="text">([\s\S]*?)<\/summary>/.exec(m[1]) || [])[1],
}));

const locsOf = (xml: string) => [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((m: any) => m[1]);

/** The corpus every format renders: a plain post, a hostile title, and three rows a feed must skip. */
const FEED_FIXTURE = [
    {
        postStatus: 'publish', postType: 'post', postName: 'alpha',
        postTitle: 'Alpha & Omega', postExcerpt: 'The first one', postDate: '2026-02-03 04:05:06',
    },
    {
        postStatus: 'publish', postType: 'post', postName: 'beta',
        postTitle: '<script>alert("xss")</script>', postContent: '<p>Hola <b>mundo</b></p>',
        postDate: '2026-01-02 03:04:05',
    },
    { postStatus: 'draft', postType: 'post', postName: 'gamma', postTitle: 'A draft' },
    { postStatus: 'publish', postType: 'page', postName: 'delta', postTitle: 'A page' },
    { postStatus: 'publish', postType: 'post', postTitle: 'No slug at all' },
];

const FEED_OPTS = { siteUrl: 'https://example.test', title: 'Sitio', description: 'Desc', language: 'es_ES' };

describe('Feed formats render the RSS item set', () => {
    it('the Atom entries are the RSS items, one for one', () => {
        const rss = rssItemsOf(generateRssFeed(FEED_FIXTURE, FEED_OPTS));
        const atom = atomEntriesOf(generateAtomFeed(feedItems(FEED_FIXTURE, FEED_OPTS), FEED_OPTS));

        assert.strictEqual(rss.length, 2, 'the RSS channel publishes the two published posts');
        assert.strictEqual(atom.length, rss.length, 'Atom must carry exactly the items RSS carries');

        for (let i = 0; i < rss.length; i++) {
            assert.strictEqual(atom[i].id, rss[i].guid, 'the entry id is the RSS guid (the permalink)');
            assert.strictEqual(atom[i].href, rss[i].link, 'the entry link is the RSS link');
            assert.strictEqual(atom[i].title, rss[i].title, 'the entry title is the RSS title, escaped the same way');
            assert.strictEqual(atom[i].summary, rss[i].description, 'the summary is the RSS description');
        }
    });

    it('the JSON feed is 1.1 and every item carries id/url/content_html', () => {
        const rss = rssItemsOf(generateRssFeed(FEED_FIXTURE, FEED_OPTS));
        const json = JSON.parse(generateJsonFeed(feedItems(FEED_FIXTURE, FEED_OPTS), FEED_OPTS));

        assert.strictEqual(json.version, 'https://jsonfeed.org/version/1.1');
        assert.strictEqual(json.language, 'es-ES', 'the stored locale is rendered as a BCP 47 tag');
        assert.strictEqual(json.items.length, rss.length);

        for (let i = 0; i < rss.length; i++) {
            assert.strictEqual(json.items[i].id, rss[i].link, 'id is the permalink');
            assert.strictEqual(json.items[i].url, rss[i].link);
            assert.ok(json.items[i].content_html !== undefined, 'content_html is required by readers');
            assert.strictEqual(json.items[i].content_html, rss[i].description, 'same content as the RSS description');
            assert.match(json.items[i].date_published, /^\d{4}-\d{2}-\d{2}T/, 'date_published is RFC 3339');
        }
    });

    it('an Atom feed carries the elements a validator requires', () => {
        const xml = generateAtomFeed(feedItems(FEED_FIXTURE, FEED_OPTS), { ...FEED_OPTS, selfUrl: 'https://example.test/feed.atom' });

        assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/);
        assert.match(xml, /<id>[^<]+<\/id>/, 'the feed needs an id');
        assert.match(xml, /<title>Sitio<\/title>/);
        assert.match(xml, /<updated>\d{4}-\d{2}-\d{2}T[\d:.]+Z<\/updated>/, 'the feed needs an RFC 3339 updated');
        assert.match(xml, /<link rel="self" type="application\/atom\+xml" href="https:\/\/example\.test\/feed\.atom"\/>/);
        assert.match(xml, /<\/feed>$/);

        for (const entry of atomEntriesOf(xml)) {
            assert.ok(entry.id, 'every entry needs an id');
            assert.ok(entry.title !== undefined, 'every entry needs a title');
            assert.match(entry.updated, /^\d{4}-\d{2}-\d{2}T/, 'every entry needs an RFC 3339 updated');
        }

        // The feed's own <updated> is the newest ENTRY, not "now": a poll that finds nothing new must
        // see an unchanged value.
        const feedUpdated = (/<updated>([^<]+)<\/updated>/.exec(xml) || [])[1];
        assert.strictEqual(feedUpdated, new Date('2026-02-03 04:05:06').toISOString());
    });

    it('escapes a <script> in a title in every format', () => {
        const items = feedItems(FEED_FIXTURE, FEED_OPTS);
        const rss = generateRssFeed(FEED_FIXTURE, FEED_OPTS);
        const atom = generateAtomFeed(items, FEED_OPTS);
        const json = generateJsonFeed(items, FEED_OPTS);

        for (const [name, xml] of [['rss', rss], ['atom', atom]] as Array<[string, string]>) {
            assert.ok(!xml.includes('<script>'), `${name} must not carry a raw <script> tag`);
            assert.ok(xml.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'), `${name} must escape it`);
        }

        // JSON is not an HTML context, so the title stays plain text (as JSON Feed requires) while
        // content_html — the field a reader renders AS HTML — carries the escaped form.
        const parsed = JSON.parse(json);
        const hostile = parsed.items.find((item: any) => item.url.endsWith('/beta'));
        assert.strictEqual(hostile.title, '<script>alert("xss")</script>');
        assert.ok(!parsed.items.some((item: any) => String(item.content_html).includes('<script>')));
    });

    /**
     * ONE BAD SLUG USED TO KILL THE WHOLE CHANNEL, not the one entry.
     *
     * `<link>` and `<guid>` are XML TEXT NODES and were written raw, while the `<title>` and
     * `<description>` beside them went through `escapeHtml`. A slug (or a siteUrl) carrying `&`
     * therefore emitted a bare ampersand — not well-formed XML — and a strict reader rejects the whole
     * document, so every subscriber to the site feed stopped receiving anything. The scoped
     * category/tag/author channels are this same generator, so the blast radius was four more URLs.
     *
     * Asserted with a REAL parser rather than by regex: the claim is "a reader accepts this", and only
     * a parser can make that claim. The RSS rendering is then held against Atom's, which escaped the
     * same value correctly all along — two renderings of one item must not disagree about its
     * permalink.
     */
    it('a & in a slug does not make the RSS channel unparseable', () => {
        const { XMLValidator, XMLParser } = require('fast-xml-parser');
        const ampersand = [{
            postStatus: 'publish', postType: 'post', postName: 'ofertas-y&promos',
            postTitle: 'Ofertas', postExcerpt: 'x', postDate: '2026-03-04 05:06:07',
        }];

        const rss = generateRssFeed(ampersand, FEED_OPTS);
        const valid = XMLValidator.validate(rss);
        assert.strictEqual(valid, true, `a raw & makes the whole channel unreadable:\n${JSON.stringify(valid)}\n${rss}`);

        assert.ok(
            rss.includes('<link>https://example.test/ofertas-y&amp;promos</link>'),
            `the item link must be escaped:\n${rss}`,
        );
        assert.ok(
            rss.includes('<guid isPermaLink="true">https://example.test/ofertas-y&amp;promos</guid>'),
            `the guid is the same URL and must be escaped the same way:\n${rss}`,
        );

        // The parser un-escapes, so the value a reader ends up with is the real permalink — escaping
        // fixed the document without changing what it says.
        const parsed = new XMLParser({ ignoreAttributes: false }).parse(rss);
        assert.strictEqual(parsed.rss.channel.item.link, 'https://example.test/ofertas-y&promos');

        // Atom already escaped this value; RSS was the straggler. Now the two agree item for item.
        const atom = atomEntriesOf(generateAtomFeed(feedItems(ampersand, FEED_OPTS), FEED_OPTS));
        const rssItems = rssItemsOf(rss);
        assert.strictEqual(atom[0].href, rssItems[0].link, 'the Atom href and the RSS link are one URL, escaped once');
        assert.strictEqual(atom[0].id, rssItems[0].guid, 'the Atom id and the RSS guid are one URL, escaped once');
    });

    it('honours posts_per_rss, and keeps the historical count when it is unset', () => {
        assert.strictEqual(resolveFeedLimit(null), DEFAULT_FEED_ITEMS);
        assert.strictEqual(resolveFeedLimit(undefined), DEFAULT_FEED_ITEMS);
        assert.strictEqual(resolveFeedLimit(''), DEFAULT_FEED_ITEMS);
        assert.strictEqual(resolveFeedLimit('no'), DEFAULT_FEED_ITEMS, 'a junk option must not empty the feed');
        assert.strictEqual(resolveFeedLimit('0'), DEFAULT_FEED_ITEMS);
        assert.strictEqual(resolveFeedLimit('5'), 5);
        assert.strictEqual(resolveFeedLimit(5), 5);
        assert.strictEqual(resolveFeedLimit('100000'), 100, 'an option row must not become a full export');
    });
});

describe('Sitemap chunking', () => {
    const entries = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({
        loc: `https://example.test/${prefix}-${i}`,
        lastmod: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
        changefreq: 'weekly',
        priority: '0.6',
    }));

    it('cuts each kind into runs of at most the chunk size, numbered from 1', () => {
        const chunks = sitemapChunks({ posts: entries(2500, 'p'), pages: entries(1, 'pg'), terms: [] });

        assert.deepStrictEqual(
            chunks.map((c: any) => sitemapChunkName(c.kind, c.page)),
            ['sitemap-posts-1.xml', 'sitemap-posts-2.xml', 'sitemap-posts-3.xml', 'sitemap-pages-1.xml'],
        );
        assert.deepStrictEqual(chunks.map((c: any) => c.entries.length), [SITEMAP_MAX_URLS, SITEMAP_MAX_URLS, 500, 1]);
        for (const chunk of chunks) {
            assert.ok(chunk.entries.length <= SITEMAP_MAX_URLS, 'no chunk may exceed the chunk size');
        }
    });

    it('advertises no child for a kind with no entries', () => {
        const chunks = sitemapChunks({ posts: entries(3, 'p'), pages: [], terms: [] });
        assert.deepStrictEqual(chunks.map((c: any) => c.kind), ['posts']);
    });

    it('gives each child the newest lastmod it contains, and none when it has no dates', () => {
        const dated = sitemapChunks({ posts: entries(3, 'p'), pages: [], terms: [] });
        const undatedTerms = [{ loc: 'https://example.test/category/x', lastmod: null, changefreq: 'weekly', priority: '0.4' }];
        const xml = generateSitemapIndex(
            [...dated, ...sitemapChunks({ terms: undatedTerms })],
            { siteUrl: 'https://example.test' },
        );

        assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<sitemapindex xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
        assert.match(xml, /<loc>https:\/\/example\.test\/sitemap\/posts-1\.xml<\/loc>\n\s*<lastmod>2026-01-03<\/lastmod>/);
        assert.match(xml, /<loc>https:\/\/example\.test\/sitemap\/terms-1\.xml<\/loc>\n\s*<\/sitemap>/, 'a dateless chunk prints no lastmod');
        assert.match(xml, /<\/sitemapindex>$/);
        assert.ok(!xml.includes('/api/'), 'the index may not advertise a child under the prefix robots.txt disallows');
    });

    it('a child urlset keeps the per-URL shape of the single-file sitemap', () => {
        const xml = generateSitemapUrlset(entries(2, 'p'));
        assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
        assert.match(xml, /<url>\n\s*<loc>https:\/\/example\.test\/p-0<\/loc>\n\s*<lastmod>2026-01-01<\/lastmod>\n\s*<changefreq>weekly<\/changefreq>\n\s*<priority>0\.6<\/priority>\n\s*<\/url>/);
        assert.match(xml, /<\/urlset>$/);
    });

    it('escapes a & in a slug — the single-file generator never did', () => {
        const xml = generateSitemapUrlset([{ loc: 'https://example.test/a&b', changefreq: 'weekly', priority: '0.6' }]);
        assert.ok(xml.includes('<loc>https://example.test/a&amp;b</loc>'), 'a raw & is not well-formed XML');
    });
});

/**
 * THE ONE PLACE A PUBLIC SEO URL IS BUILT.
 *
 * Three producers print these strings — the `<sitemapindex>`, every feed's `self` link, and the
 * `Sitemap:` line of robots.txt — and they were three separate spellings, all of them pointing at
 * `<siteUrl>/api/v1/seo/…`: the router's mount, which robots.txt tells crawlers to `Disallow`. What
 * is pinned here is that they now share ONE function, and what that function maps to.
 */
describe('publicSeoUrl — the public address of a generated document', () => {
    const SITE = 'https://example.test';

    it('publishes each document at the site root, never under the API mount', () => {
        assert.strictEqual(publicSeoUrl(SITE, 'sitemap.xml'), `${SITE}/sitemap.xml`);
        assert.strictEqual(publicSeoUrl(SITE, 'feed.xml'), `${SITE}/feed.xml`);
        assert.strictEqual(publicSeoUrl(SITE, 'feed.atom'), `${SITE}/feed.atom`);
        assert.strictEqual(publicSeoUrl(SITE, 'feed.json'), `${SITE}/feed.json`);
        assert.strictEqual(publicSeoUrl(SITE, 'comments/feed.xml'), `${SITE}/comments/feed.xml`);
        assert.strictEqual(publicSeoUrl(SITE, 'category/noticias/feed.xml'), `${SITE}/category/noticias/feed.xml`);
        assert.strictEqual(publicSeoUrl(SITE, 'author/7/feed.xml'), `${SITE}/author/7/feed.xml`);
    });

    it('rewrites a sitemap CHILD into the segment the frontend route really serves', () => {
        // `sitemap-posts-1.xml` is the backend's file name; `/sitemap/posts-1.xml` is its address.
        for (const kind of ['posts', 'pages', 'terms']) {
            const name = sitemapChunkName(kind, 2);
            const url = publicSeoUrl(SITE, name);
            assert.strictEqual(url, `${SITE}/sitemap/${kind}-2.xml`);
            // …and the frontend rebuilds exactly the backend file name from it.
            assert.strictEqual(backendPathOfChunk(url, SITE), `/api/v1/seo/${name}`);
        }
    });

    it('joins one way only, whatever spelling the caller brings', () => {
        assert.strictEqual(publicSeoUrl(`${SITE}/`, 'feed.xml'), `${SITE}/feed.xml`, 'a trailing slash is not a second slash');
        assert.strictEqual(publicSeoUrl(`${SITE}///`, 'feed.xml'), `${SITE}/feed.xml`);
        assert.strictEqual(publicSeoUrl(SITE, '/tag/verde/feed.xml'), `${SITE}/tag/verde/feed.xml`, 'a leading slash is absorbed');
        // Only the real chunk shape is rewritten — a page whose slug merely starts that way is not.
        assert.strictEqual(publicSeoUrl(SITE, 'sitemap-posts-1.txt'), `${SITE}/sitemap-posts-1.txt`);
        assert.strictEqual(publicSeoUrl(SITE, 'sitemap-posts.xml'), `${SITE}/sitemap-posts.xml`);
    });

    it('robots.txt advertises the sitemap through the same function, not a second spelling', () => {
        const robots = generateRobotsTxt(SITE, publicSeoUrl(SITE, 'sitemap.xml'));
        assert.ok(robots.includes(`Sitemap: ${publicSeoUrl(SITE, 'sitemap.xml')}`));
        assert.ok(robots.includes('Disallow: /api/'), 'the prefix that made the old URLs unreachable is still blocked');
        // The default keeps the string this generator has always printed for a one-argument caller.
        assert.strictEqual(generateRobotsTxt(SITE), robots);
    });
});

describe('the sitemap and the feeds over the real routes', () => {
    let request: any;
    let app: any;
    let dbAsync: any;
    let Post: any;
    let Term: any;
    let updateOption: any;

    const SITE = 'https://example.test';

    const get = async (url: string) => {
        const res = await request(app).get(url);
        return res;
    };

    const ok = async (url: string) => {
        const res = await get(url);
        assert.strictEqual(res.status, 200, `${url} -> ${res.status} ${res.text}`);
        return res;
    };

    /** Publish a post through the real model path and return its id. */
    const publish = async (slug: string, extra: any = {}) => {
        const post = await Post.create({
            authorId: 1, title: extra.title || slug, content: extra.content || '<p>x</p>',
            excerpt: extra.excerpt, status: 'publish', type: extra.type || 'post', slug,
            date: extra.date,
        });
        return post.id ?? post;
    };

    before(async () => {
        request = require('supertest');
        const database = require('../config/database');

        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();

        const options = require('../core/options');
        updateOption = options.updateOption;
        await options.initDefaultOptions(appConfig);
        await options.updateOption('siteurl', SITE);
        await options.updateOption('blogname', 'Sitio');

        Post = require('../models/Post');
        Term = require('../models/Term');

        // TWO users on purpose: every post published below belongs to the first one, so an author feed
        // that forgot its filter would still look right if the site had a single author.
        await dbAsync.run(
            "INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('root', 'x', 'root@example.test', 'Root')",
        );
        await dbAsync.run(
            "INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('ana', 'x', 'ana@example.test', 'Ana Autora')",
        );

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '1mb' }));
        app.use('/api/v1/seo', require('../routes/seo'));
        app.use(errorHandler);
    });

    after(async () => {
        const database = require('../config/database');
        try { await database.closeDatabase(); } catch { /* ignore */ }
        // Windows refuses to remove the CWD — step out of the temp root first.
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ------------------------------------------------------------------ the feeds

    it('/feed.xml is still the RSS 2.0 channel it always was', async () => {
        await publish('uno', { title: 'Uno', excerpt: 'El primero' });

        const res = await ok('/api/v1/seo/feed.xml');
        assert.match(res.headers['content-type'], /application\/rss\+xml/);
        assert.match(res.text, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<rss version="2\.0"/);
        // The self link is the PUBLIC feed URL. It used to be the generator's `<siteUrl>/feed`
        // default — an address nothing has ever served.
        assert.match(res.text, /<atom:link href="https:\/\/example\.test\/feed\.xml" rel="self"/, 'the site channel points at itself');
        assert.ok(res.text.includes('<link>https://example.test/uno</link>'));
    });

    it('/feed.atom serves an Atom document with the same items', async () => {
        const res = await ok('/api/v1/seo/feed.atom');
        assert.match(res.headers['content-type'], /application\/atom\+xml/);

        const rss = rssItemsOf((await ok('/api/v1/seo/feed.xml')).text);
        const atom = atomEntriesOf(res.text);
        assert.strictEqual(atom.length, rss.length);
        assert.deepStrictEqual(atom.map((e: any) => e.id), rss.map((i: any) => i.guid));
        assert.match(res.text, /<link rel="self" type="application\/atom\+xml" href="https:\/\/example\.test\/feed\.atom"\/>/);
    });

    it('/feed.json serves JSON Feed 1.1', async () => {
        const res = await ok('/api/v1/seo/feed.json');
        assert.match(res.headers['content-type'], /application\/feed\+json/);

        const json = JSON.parse(res.text);
        assert.strictEqual(json.version, 'https://jsonfeed.org/version/1.1');
        assert.strictEqual(json.feed_url, `${SITE}/feed.json`);
        assert.ok(json.items.length >= 1);
        for (const item of json.items) {
            assert.ok(item.id && item.url && item.content_html !== undefined);
        }
    });

    it('a <script> in a post title reaches no feed unescaped', async () => {
        await publish('hostil', { title: '<script>alert("xss")</script>', excerpt: 'x' });

        for (const url of ['/api/v1/seo/feed.xml', '/api/v1/seo/feed.atom']) {
            const res = await ok(url);
            assert.ok(!res.text.includes('<script>'), `${url} leaked a raw <script>`);
            assert.ok(res.text.includes('&lt;script&gt;'), `${url} did not escape the title`);
        }

        const json = JSON.parse((await ok('/api/v1/seo/feed.json')).text);
        assert.ok(!json.items.some((item: any) => String(item.content_html).includes('<script>')));
    });

    it('a category feed carries only that category\'s posts', async () => {
        const noticias = await Term.create({ name: 'Noticias', taxonomy: 'category', slug: 'noticias' });
        const otra = await Term.create({ name: 'Otra', taxonomy: 'category', slug: 'otra' });

        const dentro = await publish('en-noticias', { title: 'En noticias' });
        const fuera = await publish('en-otra', { title: 'En otra' });
        await Post.setTerms(dentro, [noticias.termId], 'category');
        await Post.setTerms(fuera, [otra.termId], 'category');

        const res = await ok('/api/v1/seo/category/noticias/feed.xml');
        const links = rssItemsOf(res.text).map((i: any) => i.link);

        assert.deepStrictEqual(links, [`${SITE}/en-noticias`], `the category feed must be scoped:\n${res.text}`);
        assert.match(res.text, /<title>Sitio — Noticias<\/title>/, 'the channel says which scope it is');
        assert.match(res.text, /<link>https:\/\/example\.test\/category\/noticias<\/link>/);
        assert.match(res.text, /<atom:link href="https:\/\/example\.test\/category\/noticias\/feed\.xml" rel="self"/);
    });

    it('a tag feed is the same channel scoped to a tag, and an unknown slug is a 404', async () => {
        const etiqueta = await Term.create({ name: 'Verde', taxonomy: 'post_tag', slug: 'verde' });
        const etiquetado = await publish('etiquetado', { title: 'Etiquetado' });
        await Post.setTerms(etiquetado, [etiqueta.termId], 'post_tag');

        const res = await ok('/api/v1/seo/tag/verde/feed.xml');
        assert.deepStrictEqual(rssItemsOf(res.text).map((i: any) => i.link), [`${SITE}/etiquetado`]);

        assert.strictEqual((await get('/api/v1/seo/tag/no-existe/feed.xml')).status, 404);
        // A category slug is not a tag slug: the taxonomy is part of the lookup, not decoration.
        assert.strictEqual((await get('/api/v1/seo/tag/noticias/feed.xml')).status, 404);
    });

    it('an author feed carries only that author\'s posts', async () => {
        const ana = await dbAsync.get("SELECT id FROM users WHERE user_login = 'ana'");
        const suyo = await publish('de-ana', { title: 'De Ana' });
        await dbAsync.run('UPDATE posts SET author_id = ? WHERE id = ?', [ana.id, suyo]);

        const res = await ok('/api/v1/seo/author/ana/feed.xml');
        assert.deepStrictEqual(rssItemsOf(res.text).map((i: any) => i.link), [`${SITE}/de-ana`]);
        assert.match(res.text, /<title>Sitio — Ana Autora<\/title>/);

        // The public author ARCHIVE is keyed by the numeric user id (the /users router is behind
        // auth, so a post's serialised author is a bare number). The feed answers to that spelling
        // too, or a reader that follows the archive's autodiscovery link lands on a 404.
        const byId = await ok(`/api/v1/seo/author/${ana.id}/feed.xml`);
        assert.deepStrictEqual(rssItemsOf(byId.text).map((i: any) => i.link), [`${SITE}/de-ana`]);

        assert.strictEqual((await get('/api/v1/seo/author/nadie/feed.xml')).status, 404);
        assert.strictEqual((await get('/api/v1/seo/author/9999/feed.xml')).status, 404);
    });

    /**
     * ONE CHANNEL, ONE ADDRESS — whichever spelling of the URL the reader arrived by.
     *
     * An author is reachable by two spellings (nicename, numeric id — login only while the nicename
     * is empty) and a term by however
     * many the database's collation treats as equal. Both routes used to print the RAW REQUEST SEGMENT
     * into `<link>` and into the `rel=self`, so the channel identified itself differently depending on
     * how it was asked for. A reader that follows the archive's autodiscovery and a reader that was
     * handed the other spelling then hold two feeds with two `self` URLs and the same items, and every
     * post arrives twice.
     *
     * THE TERM HALF NEEDS A CASE-INSENSITIVE COLLATION TO SHOW ITSELF, WHICH SQLITE DOES NOT HAVE.
     * MySQL's default collation is case-insensitive, so `/category/NOTICIAS/feed.xml` really does
     * resolve the `noticias` row there; under the suite's SQLite it 404s, and the defect would be
     * invisible to every test that could be written against this database — the "only breaks on the
     * other driver" trap. So the ONE thing MySQL does differently is simulated at the driver seam, for
     * the duration of one request and for the terms lookup only: the route is the real route, the row
     * it resolves is a real row, and the only fiction is that the comparison ignores case.
     */
    it('a scoped channel names the row it resolved, never the segment it was asked for', async () => {
        // ── the author half: three spellings, one channel identity ────────────────────────────────
        const ana = await dbAsync.get("SELECT id FROM users WHERE user_login = 'ana'");
        // user_nicename is WordPress's public author slug and this install leaves it empty, so set it
        // here: with it populated the canonical spelling differs from BOTH the login and the id, which
        // is what makes this assertion falsifiable rather than a tautology.
        // While the nicename is empty the login IS the identity (a legacy row): it must resolve …
        assert.strictEqual((await get('/api/v1/seo/author/ana/feed.xml')).status, 200);
        await dbAsync.run('UPDATE users SET user_nicename = ? WHERE id = ?', ['ana-autora', ana.id]);
        // … and once a nicename exists the login must NOT: a public feed that answered 200/404 by whether
        // a LOGIN exists would be a login-enumeration oracle for the sign-in form.
        assert.strictEqual((await get('/api/v1/seo/author/ana/feed.xml')).status, 404,
            'a user with a nicename must not be reachable by login');

        for (const segment of ['ana-autora', String(ana.id)]) {
            const res = await ok(`/api/v1/seo/author/${segment}/feed.xml`);
            assert.ok(
                res.text.includes(`<link>${SITE}/author/ana-autora</link>`),
                `/author/${segment}/feed.xml pointed its channel at a non-canonical archive:\n${res.text}`,
            );
            assert.match(
                res.text,
                /<atom:link href="https:\/\/example\.test\/author\/ana-autora\/feed\.xml" rel="self"/,
                `/author/${segment}/feed.xml self-identified at a second URL`,
            );
        }

        // Put the fixture back the way the other tests expect it (login-addressable, nicename empty).
        await dbAsync.run("UPDATE users SET user_nicename = '' WHERE id = ?", [ana.id]);

        // ── the term half: a case-insensitive collation resolves a row the segment does not spell ──
        const driver = require('../config/database').getDbAsync();
        const realGet = driver.get.bind(driver);
        driver.get = (sql: string, params?: any[]) =>
            /FROM terms/i.test(String(sql)) && Array.isArray(params)
                ? realGet(sql, params.map((p: any) => (typeof p === 'string' ? p.toLowerCase() : p)))
                : realGet(sql, params);

        let res: any;
        try {
            res = await ok('/api/v1/seo/category/NOTICIAS/feed.xml');
        } finally {
            driver.get = realGet;
        }

        assert.ok(
            res.text.includes(`<link>${SITE}/category/noticias</link>`),
            `the channel must point at the term's own slug, not at the spelling in the URL:\n${res.text}`,
        );
        assert.match(
            res.text,
            /<atom:link href="https:\/\/example\.test\/category\/noticias\/feed\.xml" rel="self"/,
            'the self URL must be the canonical one, or a reader subscribes twice',
        );
        assert.ok(!res.text.includes('NOTICIAS'), `no uppercase spelling may survive into the document:\n${res.text}`);
        // The shim is gone and the route is its normal, case-sensitive self again.
        assert.strictEqual((await get('/api/v1/seo/category/NOTICIAS/feed.xml')).status, 404);
    });

    it('the comments feed publishes approved comments and no commenter PII', async () => {
        const post = await publish('comentado', { title: 'Comentado' });
        await dbAsync.run(
            'INSERT INTO comments (comment_post_id, comment_author, comment_author_email, comment_author_ip, comment_content, comment_approved) VALUES (?, ?, ?, ?, ?, ?)',
            [post, 'Bea', 'bea@example.test', '203.0.113.9', 'Me gusta', '1'],
        );
        await dbAsync.run(
            'INSERT INTO comments (comment_post_id, comment_author, comment_author_email, comment_author_ip, comment_content, comment_approved) VALUES (?, ?, ?, ?, ?, ?)',
            [post, 'Spammer', 'spam@example.test', '203.0.113.10', 'Compra esto', '0'],
        );

        const res = await ok('/api/v1/seo/comments/feed.xml');
        assert.match(res.headers['content-type'], /application\/rss\+xml/);

        const items = rssItemsOf(res.text);
        assert.strictEqual(items.length, 1, `only the approved comment may appear:\n${res.text}`);
        assert.match(items[0].title, /Comment on Comentado by Bea/);
        assert.match(items[0].link, /https:\/\/example\.test\/comentado#comment-\d+/);
        assert.ok(!res.text.includes('bea@example.test'), 'a feed must not publish commenter e-mail');
        assert.ok(!res.text.includes('203.0.113.9'), 'a feed must not publish commenter IP');
        assert.ok(!res.text.includes('Compra esto'), 'an unapproved comment must not appear');
    });

    it('posts_per_rss caps every feed', async () => {
        await updateOption('posts_per_rss', '2');
        try {
            assert.strictEqual(rssItemsOf((await ok('/api/v1/seo/feed.xml')).text).length, 2);
            assert.strictEqual(atomEntriesOf((await ok('/api/v1/seo/feed.atom')).text).length, 2);
            assert.strictEqual(JSON.parse((await ok('/api/v1/seo/feed.json')).text).items.length, 2);
        } finally {
            await updateOption('posts_per_rss', '');
        }
    });

    // ------------------------------------------------------------------ the sitemap

        it('the single-file sitemap escapes <loc> exactly as the chunked one does', async () => {
        // The chunked urlset (generateSitemapUrlset) escaped <loc>; the single-file generateSitemap did
        // not — a slug with an ampersand made /sitemap.xml unparseable while its siblings were fine. Both
        // writers now share the rule, and a real XML parser is the only witness that counts here.
        await publish('ofertas-y&promos', { title: 'Ofertas' });
        const res = await ok('/api/v1/seo/sitemap.xml');
        assert.ok(res.text.includes('<urlset'), 'expected the single-file urlset');
        assert.ok(res.text.includes('ofertas-y&amp;promos'), 'the ampersand must be escaped inside <loc>');
        assert.ok(!/<loc>[^<]*&(?!amp;|lt;|gt;|quot;|#)[^<]*<\/loc>/.test(res.text), 'a bare & survived inside a <loc>');
        const { XMLValidator } = require('fast-xml-parser');
        assert.strictEqual(XMLValidator.validate(res.text), true, 'a feed reader must accept the document');
    });

it('below the threshold the sitemap is the single urlset it always was', async () => {
        const res = await ok('/api/v1/seo/sitemap.xml');
        assert.match(res.text, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
        assert.match(res.text, /<\/urlset>$/);
        assert.ok(!res.text.includes('<sitemapindex'), 'a small site must not be handed an index');
        assert.match(res.text, /<loc>https:\/\/example\.test\/<\/loc>\n\s*<changefreq>daily<\/changefreq>\n\s*<priority>1\.0<\/priority>/);
        assert.match(res.text, /<loc>https:\/\/example\.test\/uno<\/loc>\n\s*<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>\n\s*<changefreq>weekly<\/changefreq>\n\s*<priority>0\.6<\/priority>/);
        assert.strictEqual((await get('/api/v1/seo/sitemap-posts-1.xml')).status, 404, 'no children exist below the threshold');
    });

    it('past the threshold it becomes a sitemapindex whose children hold every URL', async () => {
        // Straight INSERTs, in batches: the model path is the right one for a handful of posts and the
        // wrong one for a thousand — what is being exercised here is the route's counting and slicing,
        // and every column the sitemap reads is set explicitly.
        const total = SITEMAP_MAX_URLS + 5;
        for (let start = 0; start < total; start += 100) {
            const rows = Math.min(100, total - start);
            const values = Array.from({ length: rows }, () => '(?, ?, ?, ?, ?, ?, 1)').join(', ');
            const params: any[] = [];
            for (let i = 0; i < rows; i++) {
                const n = start + i;
                const day = String((n % 27) + 1).padStart(2, '0');
                params.push(`Masivo ${n}`, `masivo-${n}`, 'post', 'publish', `2025-06-${day} 10:00:00`, `2025-06-${day} 10:00:00`);
            }
            await dbAsync.run(
                'INSERT INTO posts (post_title, post_name, post_type, post_status, post_date, post_modified, author_id) VALUES ' + values,
                params,
            );
        }

        const index = await ok('/api/v1/seo/sitemap.xml');
        assert.match(index.text, /<sitemapindex xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
        assert.ok(!index.text.includes('<urlset'), 'the index advertises children, it does not inline them');

        const children = locsOf(index.text);
        assert.ok(children.length >= 3, `expected at least posts-1, posts-2 and pages-1:\n${index.text}`);
        // A child is advertised at its PUBLIC address — the one the frontend serves and a crawler is
        // allowed to fetch — not under the `/api/` prefix the same site's robots.txt disallows.
        for (const child of children) {
            assert.ok(child.startsWith(`${SITE}/sitemap/`), `a child must be advertised publicly: ${child}`);
            assert.ok(!child.includes('/api/'), `a child must not be advertised under a disallowed prefix: ${child}`);
        }
        assert.ok(children.some((c: string) => c.endsWith('/sitemap/posts-2.xml')), 'the posts must be chunked');
        assert.ok(children.some((c: string) => c.endsWith('/sitemap/pages-1.xml')), 'the homepage lives in the pages chunk');
        assert.ok(children.some((c: string) => c.endsWith('/sitemap/terms-1.xml')), 'the taxonomy archives get a chunk');
        assert.match(index.text, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/, 'a dated chunk advertises its newest lastmod');

        // Every child resolves, none exceeds the chunk size, and together they hold every URL the site
        // has — the failure this guards against is a URL falling between the index and the children.
        //
        // Each `<loc>` is turned back into a backend path the way the FRONTEND route does it, so the
        // two halves of the public-URL contract are tested against each other: an index that printed
        // a shape the proxy would refuse fails here with a null path, not with a silent skip.
        let seen: string[] = [];
        for (const child of children) {
            const backendPath = backendPathOfChunk(child, SITE);
            assert.ok(backendPath, `the frontend proxy could not rebuild a backend path from ${child}`);
            const res = await ok(backendPath!);
            const locs = locsOf(res.text);
            assert.match(res.text, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
            assert.ok(locs.length > 0 && locs.length <= SITEMAP_MAX_URLS, `${child} holds ${locs.length} URLs`);
            seen = seen.concat(locs);
        }

        const content = await dbAsync.get(
            "SELECT COUNT(*) AS n FROM posts WHERE post_status = 'publish' AND post_type IN ('post', 'page') AND post_name <> ''",
        );
        const terms = await dbAsync.get(
            "SELECT COUNT(*) AS n FROM terms t JOIN term_taxonomy tt ON t.term_id = tt.term_id WHERE tt.taxonomy IN ('category', 'post_tag') AND tt.count > 0",
        );
        assert.strictEqual(seen.length, Number(content.n) + Number(terms.n) + 1, 'children must hold every URL, plus the homepage');
        assert.strictEqual(new Set(seen).size, seen.length, 'no URL may be published by two children');
        assert.ok(seen.includes(`${SITE}/`), 'the homepage must still be submitted');
        assert.ok(seen.includes(`${SITE}/category/noticias`), 'a taxonomy archive is submitted in index mode');
    });

    it('a chunk the index never advertised is a 404', async () => {
        assert.strictEqual((await get('/api/v1/seo/sitemap-posts-99.xml')).status, 404);
        assert.strictEqual((await get('/api/v1/seo/sitemap-inventado-1.xml')).status, 404);
        assert.strictEqual((await get('/api/v1/seo/sitemap-posts-abc.xml')).status, 404);
    });

    it('robots.txt still points at the sitemap', async () => {
        const res = await ok('/api/v1/seo/robots.txt');
        assert.ok(res.text.includes(`Sitemap: ${SITE}/sitemap.xml`), 'the advertisement is unchanged');
        assert.strictEqual(
            res.text.match(/^Sitemap: (.*)$/m)?.[1],
            publicSeoUrl(SITE, 'sitemap.xml'),
            'the advertisement comes from the same function the document is published by',
        );
    });

    /**
     * THE WHOLE POINT, ASSERTED OVER THE REAL ROUTES: nothing a crawler or a reader parses out of
     * these documents may send it back to `/api/v1/seo`. Every URL that used to point there was
     * either forbidden by this site's own robots.txt or unguessable — and one route getting it right
     * while another kept `req.baseUrl` is exactly the drift `publicSeoUrl` exists to make impossible.
     */
    it('no document these routes publish advertises the API mount', async () => {
        const documents = [
            '/api/v1/seo/sitemap.xml', '/api/v1/seo/robots.txt',
            '/api/v1/seo/feed.xml', '/api/v1/seo/feed.atom', '/api/v1/seo/feed.json',
            '/api/v1/seo/comments/feed.xml',
            '/api/v1/seo/category/noticias/feed.xml', '/api/v1/seo/tag/verde/feed.xml',
            '/api/v1/seo/author/ana/feed.xml',
        ];
        for (const url of documents) {
            const res = await ok(url);
            assert.ok(!res.text.includes('/api/v1/seo'), `${url} still prints the mount:\n${res.text.slice(0, 400)}`);
        }
    });
});
