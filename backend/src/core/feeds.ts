/**
 * WordJS - Feeds & sitemap chunking
 *
 * WHAT THIS ADDS, AND WHY IT IS A SEPARATE MODULE FROM `seo-helper`.
 *
 * `seo-helper` owns two generators that a live site already depends on byte-for-byte: the single
 * `<urlset>` sitemap and the RSS 2.0 channel. Both keep their current output EXACTLY — this module
 * never rewrites them. What lives here is everything they could not do:
 *
 *   - a `<sitemapindex>` with chunked children, for the site that outgrows one file. sitemaps.org
 *     caps a sitemap at 50 000 URLs / 50 MB, and long before that cap a single generated file is a
 *     slow response holding the whole catalogue in memory. Above SITEMAP_MAX_URLS the index takes
 *     over; below it the old single file is served unchanged (see routes/seo.ts).
 *   - Atom 1.0 and JSON Feed 1.1 renderings of the SAME items the RSS channel carries.
 *   - the comments feed and the per-taxonomy feeds' item plumbing.
 *
 * THE ESCAPING POSTURE IS THE RSS ONE, DELIBERATELY. Every text node here goes through the SAME
 * `escapeHtml` the RSS channel uses (imported, not re-implemented — a second copy is how two
 * escapers drift until only one of them is really escaping), and no feed emits raw `post_content`:
 * the summary is the author's excerpt, or the content with its tags STRIPPED and truncated, which is
 * exactly what `generateRssFeed` has always published. JSON Feed has no markup layer, so its
 * `content_html` carries the same escaped text — a reader that renders it as HTML shows a
 * `<script>` in a title as the literal characters, which is the RSS behaviour expressed in JSON.
 *
 * ONE-WAY DEPENDENCY: this module requires `seo-helper`, never the other way round. `seo-helper` is
 * loaded during route registration and by plugins; a cycle here would hand one of the two a
 * half-initialised module object (the io-guard circular-require class of bug).
 */

const { escapeHtml } = require('./seo-helper');
const { toLanguageTag } = require('./language-tag');

/**
 * THE THRESHOLD, and the chunk size — deliberately the same number.
 *
 * `/sitemap.xml` stays a single `<urlset>` while the site has at most this many URLs (the homepage
 * counts), and becomes a `<sitemapindex>` the moment it has more. Each child then carries at most
 * this many URLs. Using one constant for both means the switch is exactly the point at which a
 * second file would have been needed, so no configuration can produce an index with a single child.
 *
 * 1 000 rather than the 50 000 the spec allows: the limit that bites first is generation time and
 * response size, not the standard's ceiling.
 */
const SITEMAP_MAX_URLS = 1000;

/**
 * How many content rows the sitemap query is allowed to pull in one pass. The old single-file route
 * read 10 000; the index needs to see everything it is going to advertise, and the same bounded read
 * backs BOTH the index and each child so the two can never disagree about what exists.
 */
const SITEMAP_FETCH_CAP = SITEMAP_MAX_URLS * 50;

/** What `/feed.xml` has always sent, and therefore the fallback when no option says otherwise. */
const DEFAULT_FEED_ITEMS = 20;

/** Ceiling for an operator-supplied `posts_per_rss`: an option row must not become a full export. */
const MAX_FEED_ITEMS = 100;

/** Same truncation the RSS description has always applied to a content-derived summary. */
const EXCERPT_CHARS = 280;

/** The kinds of child sitemap, in the order the index advertises them. */
const SITEMAP_KINDS = ['posts', 'pages', 'terms'] as const;

/**
 * The directory the sitemap children are PUBLISHED under, on the public origin.
 *
 * Not the flat `/sitemap-posts-1.xml` the backend answers to: the frontend serves these through an
 * App Router dynamic segment, and a folder named `sitemap-[chunk].xml` is not a dynamic route at all
 * (Next's own `isDynamicRoute()` answers false for it), while a bare `/[chunk]` at the root would
 * collide with the public `[slug]` page. So the children nest under a static segment, and the chunk
 * keeps its `<kind>-<n>.xml` tail — see `frontend/src/app/(public)/sitemap/[chunk]/route.ts`, whose
 * handler rebuilds the backend's file name by prepending `sitemap-` to the segment it received.
 */
const PUBLIC_SITEMAP_DIR = 'sitemap';

/**
 * WHERE a generated SEO document is PUBLISHED — the one function every producer of such a URL goes
 * through, so the sitemap index, the feeds' `self` links and robots.txt cannot drift apart.
 *
 * `doc` is the document's own name as the BACKEND knows it, i.e. relative to the `/seo` mount:
 * `sitemap.xml`, `sitemap-posts-1.xml`, `feed.xml`, `feed.atom`, `feed.json`, `comments/feed.xml`,
 * `category/<slug>/feed.xml`, … The result is the PUBLIC address of that same document, which is the
 * site root — NOT `<siteUrl>/api/v1/seo/…`. Two reasons the mount is not an address a document may
 * print: robots.txt tells crawlers `Disallow: /api/`, so every URL advertised under it is one they
 * are being told to skip; and it is not a URL any reader would guess for a feed. The frontend
 * publishes each of these documents at exactly the URL this function returns and proxies the request
 * back to the mount.
 *
 * The ONE rewrite is the sitemap child: `sitemap-posts-1.xml` is served at `/sitemap/posts-1.xml`.
 */
function publicSeoUrl(siteUrl: string, doc: string): string {
    const base = String(siteUrl ?? '').replace(/\/+$/, '');
    const name = String(doc ?? '').replace(/^\/+/, '');
    const chunk = /^sitemap-(?:[a-z]+)-\d+\.xml$/.test(name)
        ? `${PUBLIC_SITEMAP_DIR}/${name.slice('sitemap-'.length)}`
        : name;
    return `${base}/${chunk}`;
}

interface FeedItem {
    /** Stable identity AND the permalink: the same `/${slug}` URL the RSS `<guid>` publishes. */
    id: string;
    url: string;
    title: string;
    /** Raw stored date; each renderer formats it in its own required format. */
    date: any;
    /** Plain text — never markup. Escaped at render time, exactly like the RSS description. */
    summary: string;
}

interface SitemapEntry {
    loc: string;
    lastmod?: string | null;
    changefreq: string;
    priority: string;
}

interface SitemapChunk {
    kind: string;
    page: number;
    entries: SitemapEntry[];
}

/** RFC 3339 / ISO 8601, for Atom `<updated>` and JSON Feed `date_published`. */
function rfc3339(value: any): string {
    const t = new Date(value);
    return isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString();
}

/** RFC 822, for the RSS `<pubDate>` of the comments channel — same rule as `generateRssFeed`. */
function rfc822(value: any): string {
    const t = new Date(value);
    return isNaN(t.getTime()) ? new Date().toUTCString() : t.toUTCString();
}

/** `YYYY-MM-DD`, the `<lastmod>` precision the existing sitemap prints. */
function isoDay(value: any): string | null {
    if (!value) return null;
    const t = new Date(value);
    return isNaN(t.getTime()) ? null : t.toISOString().split('T')[0];
}

/** Tag-stripped, whitespace-collapsed, truncated — the summary rule `generateRssFeed` applies. */
function plainSummary(post: any): string {
    const authored = post.postExcerpt || post.excerpt;
    if (authored) return String(authored);
    return String(post.postContent || post.content || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, EXCERPT_CHARS);
}

/**
 * The ONE item source every feed renders from.
 *
 * The filter is the RSS channel's filter, character for character: published posts only (never a
 * page, never a draft), and never a row without a slug — a feed entry whose link is `/undefined` is
 * worse than an absent entry. The URL is `/${slug}`, which is what the live page declares as its
 * rel=canonical and what the sitemap submits; all three must agree.
 *
 * That the RSS output and this extraction agree is not asserted by inspection: the test suite parses
 * the REAL `generateRssFeed` XML and compares it item-for-item against what this returns, so a
 * future change to one of them fails rather than drifts.
 */
function feedItems(posts: any[], options: { siteUrl?: string } = {}): FeedItem[] {
    const siteUrl = options.siteUrl || '';
    const items: FeedItem[] = [];

    for (const post of posts || []) {
        const status = post.postStatus || post.status;
        const type = post.postType || post.type;
        const slug = post.postName || post.slug;
        if (status !== 'publish' || type !== 'post' || !slug) continue;

        const url = `${siteUrl}/${slug}`;
        items.push({
            id: url,
            url,
            title: String(post.postTitle || post.title || slug),
            date: post.postDate || post.date || post.created_at,
            summary: plainSummary(post),
        });
    }

    return items;
}

/**
 * Atom 1.0.
 *
 * The required elements are all present and all derived, never optional-in-practice: a feed carries
 * `<id>`, `<title>` and `<updated>`, and every entry carries its own `<id>`, `<title>` and
 * `<updated>`. `<updated>` for the feed is the newest entry's date (not "now"), so a poll that finds
 * nothing new sees an unchanged value — the whole point of the element for a client that caches.
 */
function generateAtomFeed(
    items: FeedItem[],
    options: { siteUrl?: string; title?: string; description?: string; language?: string; selfUrl?: string; feedId?: string; link?: string } = {},
): string {
    const siteUrl = options.siteUrl || '';
    const alternate = options.link || `${siteUrl}/`;
    const selfUrl = options.selfUrl || `${siteUrl}/feed.atom`;
    const feedId = options.feedId || selfUrl;

    const newest = items.reduce((acc: number | null, item) => {
        const t = new Date(item.date).getTime();
        return isNaN(t) ? acc : acc === null || t > acc ? t : acc;
    }, null);

    let entries = '';
    for (const item of items) {
        entries += '  <entry>\n';
        entries += `    <id>${escapeHtml(item.id)}</id>\n`;
        entries += `    <title type="text">${escapeHtml(item.title)}</title>\n`;
        entries += `    <link rel="alternate" type="text/html" href="${escapeHtml(item.url)}"/>\n`;
        entries += `    <updated>${rfc3339(item.date)}</updated>\n`;
        entries += `    <published>${rfc3339(item.date)}</published>\n`;
        entries += `    <summary type="text">${escapeHtml(item.summary)}</summary>\n`;
        entries += '  </entry>\n';
    }

    const subtitle = options.description
        ? `  <subtitle>${escapeHtml(options.description)}</subtitle>\n`
        : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${toLanguageTag(options.language)}">
  <id>${escapeHtml(feedId)}</id>
  <title>${escapeHtml(options.title || 'WordJS Site')}</title>
${subtitle}  <updated>${rfc3339(newest === null ? Date.now() : newest)}</updated>
  <link rel="alternate" type="text/html" href="${escapeHtml(alternate)}"/>
  <link rel="self" type="application/atom+xml" href="${escapeHtml(selfUrl)}"/>
${entries}</feed>`;
}

/**
 * JSON Feed 1.1.
 *
 * `version` is the literal spec URL — a reader identifies the format by it, so it is not a place for
 * a version number of ours. `content_html` carries the SAME escaped text the RSS `<description>`
 * does (see the module header): the feed never publishes raw post markup, so a `<script>` in a title
 * or an excerpt reaches a reader as text in both formats.
 */
function generateJsonFeed(
    items: FeedItem[],
    options: { siteUrl?: string; title?: string; description?: string; language?: string; selfUrl?: string; link?: string } = {},
): string {
    const siteUrl = options.siteUrl || '';

    const feed: Record<string, any> = {
        version: 'https://jsonfeed.org/version/1.1',
        title: options.title || 'WordJS Site',
        home_page_url: options.link || `${siteUrl}/`,
        feed_url: options.selfUrl || `${siteUrl}/feed.json`,
        language: toLanguageTag(options.language),
        items: items.map((item) => ({
            id: item.id,
            url: item.url,
            title: item.title,
            content_html: escapeHtml(item.summary),
            content_text: item.summary,
            date_published: rfc3339(item.date),
        })),
    };

    if (options.description) feed.description = options.description;

    return JSON.stringify(feed);
}

/**
 * The comments channel (RSS 2.0), rendered here rather than through `generateRssFeed` because a
 * comment is not a post: its identity is `#comment-<id>` on the post's permalink, which is a
 * fragment and therefore NOT a permalink of its own (`isPermaLink="false"`).
 *
 * The caller decides which comments exist; what this guarantees is that nothing beyond author NAME,
 * date, post and text can be printed — the commenter's e-mail and IP are private data the public
 * comments API also withholds, and a feed is the easiest place to leak them by accident.
 */
function generateCommentsRssFeed(
    comments: any[],
    options: { siteUrl?: string; title?: string; description?: string; language?: string; selfUrl?: string; link?: string } = {},
): string {
    const siteUrl = options.siteUrl || '';
    const selfUrl = options.selfUrl || `${siteUrl}/comments/feed.xml`;

    let items = '';
    for (const comment of comments || []) {
        const slug = comment.postName || comment.post_name;
        const id = comment.commentId ?? comment.comment_id;
        if (!slug || id === undefined || id === null) continue;

        const url = `${siteUrl}/${slug}#comment-${id}`;
        const author = String(comment.commentAuthor || comment.comment_author || 'Anonymous');
        const postTitle = String(comment.postTitle || comment.post_title || slug);
        const body = String(comment.commentContent || comment.comment_content || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, EXCERPT_CHARS);

        items += '    <item>\n';
        items += `      <title>${escapeHtml(`Comment on ${postTitle} by ${author}`)}</title>\n`;
        items += `      <link>${escapeHtml(url)}</link>\n`;
        items += `      <guid isPermaLink="false">${escapeHtml(url)}</guid>\n`;
        items += `      <pubDate>${rfc822(comment.commentDate || comment.comment_date)}</pubDate>\n`;
        items += `      <description>${escapeHtml(body)}</description>\n`;
        items += '    </item>\n';
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeHtml(options.title || 'Comments')}</title>
    <link>${escapeHtml(options.link || `${siteUrl}/`)}</link>
    <description>${escapeHtml(options.description || '')}</description>
    <language>${toLanguageTag(options.language)}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${escapeHtml(selfUrl)}" rel="self" type="application/rss+xml"/>
${items}  </channel>
</rss>`;
}

/**
 * Split the grouped URLs into the children the index will advertise.
 *
 * Chunking rule: within a kind, entries keep their incoming order and are cut into runs of at most
 * SITEMAP_MAX_URLS, numbered from 1 — `sitemap-posts-1.xml`, `sitemap-posts-2.xml`, … A kind with no
 * entries produces no child at all (an empty `<urlset>` is a URL a crawler fetches for nothing).
 */
function sitemapChunks(groups: { posts?: SitemapEntry[]; pages?: SitemapEntry[]; terms?: SitemapEntry[] }): SitemapChunk[] {
    const chunks: SitemapChunk[] = [];

    for (const kind of SITEMAP_KINDS) {
        const entries = (groups as any)[kind] || [];
        for (let index = 0; index < entries.length; index += SITEMAP_MAX_URLS) {
            chunks.push({
                kind,
                page: Math.floor(index / SITEMAP_MAX_URLS) + 1,
                entries: entries.slice(index, index + SITEMAP_MAX_URLS),
            });
        }
    }

    return chunks;
}

/** The file name a chunk is published under — the one place the naming scheme is written down. */
function sitemapChunkName(kind: string, page: number): string {
    return `sitemap-${kind}-${page}.xml`;
}

/**
 * `<sitemapindex>` over the chunks. Each child's `<lastmod>` is the newest `<lastmod>` inside it, so
 * a crawler can skip a chunk it has already seen; a chunk whose entries carry no dates (taxonomy
 * archives have none) prints no `<lastmod>` rather than a fabricated one.
 *
 * The children are advertised at their PUBLIC address (`publicSeoUrl`), never at the API mount this
 * router happens to be bolted onto: a `<loc>` a crawler is told to `Disallow` is a submitted URL that
 * is never fetched.
 */
function generateSitemapIndex(chunks: SitemapChunk[], options: { siteUrl?: string } = {}): string {
    const siteUrl = options.siteUrl || '';

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    for (const chunk of chunks) {
        const lastmod = chunk.entries
            .map((entry) => entry.lastmod)
            .filter((value): value is string => Boolean(value))
            .sort()
            .pop();

        xml += '  <sitemap>\n';
        xml += `    <loc>${escapeHtml(publicSeoUrl(siteUrl, sitemapChunkName(chunk.kind, chunk.page)))}</loc>\n`;
        if (lastmod) xml += `    <lastmod>${lastmod}</lastmod>\n`;
        xml += '  </sitemap>\n';
    }

    xml += '</sitemapindex>';
    return xml;
}

/**
 * A child `<urlset>`: the same per-URL block the single-file sitemap prints, so a chunked site and a
 * small site publish identically-shaped URLs. `<loc>` is escaped here, because a slug carrying `&`
 * produces XML a validator rejects — the same rule `generateRssFeed` now applies to its `<link>` and
 * `<guid>` and `generateAtomFeed` applies to its `<id>` and `href`. Every generator that prints an
 * item URL escapes it; there is no longer a straggler.
 */
function generateSitemapUrlset(entries: SitemapEntry[]): string {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    for (const entry of entries) {
        xml += '  <url>\n';
        xml += `    <loc>${escapeHtml(entry.loc)}</loc>\n`;
        if (entry.lastmod) xml += `    <lastmod>${entry.lastmod}</lastmod>\n`;
        xml += `    <changefreq>${entry.changefreq}</changefreq>\n`;
        xml += `    <priority>${entry.priority}</priority>\n`;
        xml += '  </url>\n';
    }

    xml += '</urlset>';
    return xml;
}

/**
 * Resolve how many items a feed carries.
 *
 * `posts_per_rss` is honoured when an admin has set it (clamped to something a feed can be). When it
 * is absent the answer is DEFAULT_FEED_ITEMS — what `/feed.xml` has always sent — and deliberately
 * NOT `posts_per_page`: that option exists on every install with a value of 10, so reading it here
 * would silently halve the length of every existing site's feed as a side effect of adding Atom.
 */
function resolveFeedLimit(raw: any): number {
    const parsed = parseInt(String(raw ?? ''), 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, MAX_FEED_ITEMS);
    return DEFAULT_FEED_ITEMS;
}

module.exports = {
    SITEMAP_MAX_URLS,
    SITEMAP_FETCH_CAP,
    SITEMAP_KINDS,
    PUBLIC_SITEMAP_DIR,
    publicSeoUrl,
    DEFAULT_FEED_ITEMS,
    MAX_FEED_ITEMS,
    EXCERPT_CHARS,
    feedItems,
    generateAtomFeed,
    generateJsonFeed,
    generateCommentsRssFeed,
    sitemapChunks,
    sitemapChunkName,
    generateSitemapIndex,
    generateSitemapUrlset,
    resolveFeedLimit,
    rfc3339,
    isoDay,
};
