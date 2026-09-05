/**
 * WordJS - SEO Helper
 * Generates meta tags, sitemaps, and structured data
 */

const { toLanguageTag } = require('./language-tag');

interface SeoOptions {
    siteUrl?: string;
    siteName?: string;
    siteDescription?: string;
}

/**
 * Generate HTML meta tags for a post/page
 */
function generateMetaTags(post: any, options: SeoOptions = {}) {
    const siteUrl = options.siteUrl || '';
    const siteName = options.siteName || 'WordJS';

    const title = post.seo_title || post.title;
    const description = post.seo_description || post.excerpt || '';
    const canonicalUrl = `${siteUrl}/${post.slug}`; // live canonical is /<slug> for posts AND pages
    const ogImage = post.og_image || post.featured_image || `${siteUrl}/images/default-og.jpg`;

    const tags: string[] = [];

    // Basic meta
    tags.push(`<title>${escapeHtml(title)} | ${escapeHtml(siteName)}</title>`);
    tags.push(`<meta name="description" content="${escapeHtml(description)}">`);

    // Canonical
    tags.push(`<link rel="canonical" href="${canonicalUrl}">`);

    // Robots
    if (post.noindex) {
        tags.push(`<meta name="robots" content="noindex, nofollow">`);
    } else {
        tags.push(`<meta name="robots" content="index, follow">`);
    }

    // Open Graph
    tags.push(`<meta property="og:type" content="article">`);
    tags.push(`<meta property="og:title" content="${escapeHtml(title)}">`);
    tags.push(`<meta property="og:description" content="${escapeHtml(description)}">`);
    tags.push(`<meta property="og:url" content="${canonicalUrl}">`);
    tags.push(`<meta property="og:site_name" content="${escapeHtml(siteName)}">`);
    tags.push(`<meta property="og:image" content="${ogImage}">`);

    // Twitter Card
    tags.push(`<meta name="twitter:card" content="summary_large_image">`);
    tags.push(`<meta name="twitter:title" content="${escapeHtml(title)}">`);
    tags.push(`<meta name="twitter:description" content="${escapeHtml(description)}">`);
    tags.push(`<meta name="twitter:image" content="${ogImage}">`);

    // Article specific
    if (post.type === 'post') {
        tags.push(`<meta property="article:published_time" content="${post.created_at}">`);
        tags.push(`<meta property="article:modified_time" content="${post.updated_at}">`);
    }

    return tags.join('\n    ');
}

/**
 * Generate JSON-LD structured data
 */
function generateJsonLd(post: any, options: SeoOptions = {}) {
    const siteUrl = options.siteUrl || '';
    const siteName = options.siteName || 'WordJS';
    // (no siteDescription here: the Article's "description" comes from the POST, and the publisher
    //  Organization node has no description field — the local was read and then never used.)

    const canonicalUrl = `${siteUrl}/${post.slug}`; // live canonical is /<slug> for posts AND pages

    // Article schema
    const articleSchema: Record<string, any> = {
        "@context": "https://schema.org",
        "@type": post.type === 'post' ? "Article" : "WebPage",
        "headline": post.seo_title || post.title,
        "description": post.seo_description || post.excerpt || '',
        "url": canonicalUrl,
        "datePublished": post.created_at,
        "dateModified": post.updated_at,
        "author": {
            "@type": "Person",
            "name": post.author_name || "Unknown"
        },
        "publisher": {
            "@type": "Organization",
            "name": siteName,
            "logo": {
                "@type": "ImageObject",
                "url": `${siteUrl}/images/logo.png`
            }
        }
    };

    if (post.og_image || post.featured_image) {
        articleSchema.image = post.og_image || post.featured_image;
    }

    return `<script type="application/ld+json">${JSON.stringify(articleSchema)}</script>`;
}

/**
 * Generate WebSite schema for homepage
 */
function generateWebsiteSchema(options: SeoOptions = {}) {
    const siteUrl = options.siteUrl || '';
    const siteName = options.siteName || 'WordJS';
    const siteDescription = options.siteDescription || '';

    const schema = {
        "@context": "https://schema.org",
        "@type": "WebSite",
        "name": siteName,
        "description": siteDescription,
        "url": siteUrl,
        "potentialAction": {
            "@type": "SearchAction",
            "target": `${siteUrl}/search?q={search_term_string}`,
            "query-input": "required name=search_term_string"
        }
    };

    return `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
}

/**
 * Generate breadcrumb schema
 */
function generateBreadcrumbSchema(breadcrumbs: any[], siteUrl = '') {
    const items = breadcrumbs.map((crumb: any, index: number) => ({
        "@type": "ListItem",
        "position": index + 1,
        "name": crumb.name,
        "item": crumb.url ? `${siteUrl}${crumb.url}` : undefined
    }));

    const schema = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": items
    };

    return `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
}

/**
 * Generate XML sitemap
 */
async function generateSitemap(posts: any[], options: SeoOptions = {}) {
    const siteUrl = options.siteUrl || '';

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    // Homepage
    xml += '  <url>\n';
    xml += `    <loc>${escapeHtml(siteUrl)}/</loc>\n`;
    xml += '    <changefreq>daily</changefreq>\n';
    xml += '    <priority>1.0</priority>\n';
    xml += '  </url>\n';

    // Posts and pages
    for (const post of posts) {
        const status = post.postStatus || post.status;
        const noindex = post.noindex === true || post.noindex === 'true';

        if (status !== 'publish' || noindex) continue;

        const type = post.postType || post.type;
        const slug = post.postName || post.slug;

        if (!slug) continue;

        // Live pages declare rel=canonical as `/${slug}` for BOTH posts and pages (see the
        // (public) routes' canonicalPath) — the sitemap must submit the same URL or Search
        // Console flags every entry as "duplicate, submitted URL not selected as canonical".
        void type;
        const url = `${siteUrl}/${slug}`;

        const lastmod = post.postModified || post.updated_at || post.postDate || post.created_at;
        const priority = type === 'page' ? '0.8' : '0.6';

        xml += '  <url>\n';
        xml += `    <loc>${escapeHtml(url)}</loc>\n`;
        if (lastmod) {
            xml += `    <lastmod>${new Date(lastmod).toISOString().split('T')[0]}</lastmod>\n`;
        }
        xml += `    <changefreq>weekly</changefreq>\n`;
        xml += `    <priority>${priority}</priority>\n`;
        xml += '  </url>\n';
    }

    xml += '</urlset>';

    return xml;
}

/**
 * Generate robots.txt content
 *
 * `sitemapUrl` is passed in rather than assembled here: the sitemap's public address is decided in
 * ONE place (`publicSeoUrl` in core/feeds.ts), and this file printing its own second spelling of it
 * is exactly how the advertisement and the document that answers it come apart. The default keeps
 * the string this function has always emitted for any caller that supplies only the site URL.
 */
function generateRobotsTxt(siteUrl = '', sitemapUrl = `${siteUrl}/sitemap.xml`) {
    return `User-agent: *
Allow: /

# Sitemap
Sitemap: ${sitemapUrl}

# Blocked paths
Disallow: /api/
Disallow: /admin/
Disallow: /_next/
`;
}

/**
 * Escape HTML entities
 */
function escapeHtml(text: any) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

/**
 * Generate an RSS 2.0 feed for the latest published posts.
 * URL scheme matches the live pages' rel=canonical: /<slug>.
 *
 * `options.language` is a stored LOCALE, not a finished tag: `<language>` is a BCP 47 language tag,
 * so it goes through toLanguageTag() here rather than being escaped and hoped for. That is also why
 * it needs no escapeHtml — the tag is rebuilt from matched subtags, so only [A-Za-z0-9-] can survive,
 * and an unparseable locale becomes `en` instead of an escaped invalid value. This is the last line
 * before the markup; the caller (routes/seo) converts too, and both must, because a second caller
 * with a raw option is exactly how the invalid value got in.
 */
function generateRssFeed(posts: any[], options: { siteUrl?: string; title?: string; description?: string; language?: string; link?: string; selfUrl?: string } = {}) {
    const siteUrl = options.siteUrl || '';
    const rfc822 = (d: any) => { const t = new Date(d); return isNaN(t.getTime()) ? new Date().toUTCString() : t.toUTCString(); };

    // A SCOPED channel (a category/tag/author feed) is the same generator pointed at a filtered post
    // list, plus the two URLs that identify WHICH channel it is: where it belongs (`link`) and where
    // it lives (`selfUrl`). Both are optional and, when absent, render the exact strings this function
    // has always rendered — the site feed's bytes do not move because a scoped feed exists. The
    // supplied values are escaped; the defaults are not, deliberately, because escaping them would
    // change today's output for a siteUrl containing an XML metacharacter.
    const channelLink = options.link ? escapeHtml(options.link) : `${siteUrl}/`;
    const selfHref = options.selfUrl ? escapeHtml(options.selfUrl) : `${siteUrl}/feed`;

    let items = '';
    for (const post of posts) {
        const status = post.postStatus || post.status;
        const type = post.postType || post.type;
        const slug = post.postName || post.slug;
        if (status !== 'publish' || type !== 'post' || !slug) continue;
        const url = `${siteUrl}/${slug}`; // must match the page's rel=canonical (see generateSitemap)
        const title = escapeHtml(post.postTitle || post.title || slug);
        const rawExcerpt = post.postExcerpt || post.excerpt ||
            String(post.postContent || post.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280);
        // THE ITEM URL IS ESCAPED, and it is not decoration: `<link>` and `<guid>` are XML TEXT NODES,
        // so a slug (or a siteUrl) carrying `&` used to emit a bare ampersand — which is not
        // well-formed XML. A strict reader rejects the WHOLE channel, not the one entry, so a single
        // bad slug silently killed every RSS feed on the site; and since the scoped category/tag/author
        // channels are this same generator, one slug took four more public URLs down with it. The
        // twins already agreed on the rule and this one was the straggler: `generateSitemapUrlset`
        // escapes `<loc>` and `generateAtomFeed` escapes the very same value in `<id>`/`href`, so the
        // two renderings of one item used to disagree about their own permalink.
        items += '    <item>\n';
        items += `      <title>${title}</title>\n`;
        items += `      <link>${escapeHtml(url)}</link>\n`;
        items += `      <guid isPermaLink="true">${escapeHtml(url)}</guid>\n`;
        items += `      <pubDate>${rfc822(post.postDate || post.date || post.created_at)}</pubDate>\n`;
        items += `      <description>${escapeHtml(rawExcerpt)}</description>\n`;
        items += '    </item>\n';
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeHtml(options.title || 'WordJS Site')}</title>
    <link>${channelLink}</link>
    <description>${escapeHtml(options.description || '')}</description>
    <language>${toLanguageTag(options.language)}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${selfHref}" rel="self" type="application/rss+xml"/>
${items}  </channel>
</rss>`;
}

module.exports = {
    generateMetaTags,
    generateJsonLd,
    generateWebsiteSchema,
    generateBreadcrumbSchema,
    generateSitemap,
    generateRobotsTxt,
    generateRssFeed,
    escapeHtml
};
