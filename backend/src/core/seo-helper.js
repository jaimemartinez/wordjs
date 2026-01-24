/**
 * WordJS - SEO Helper
 * Generates meta tags, sitemaps, and structured data
 */

const { getOption } = require('./options');

/**
 * Generate HTML meta tags for a post/page
 */
function generateMetaTags(post, options = {}) {
    const siteUrl = options.siteUrl || '';
    const siteName = options.siteName || 'WordJS';

    const title = post.seo_title || post.title;
    const description = post.seo_description || post.excerpt || '';
    const canonicalUrl = `${siteUrl}/${post.type === 'page' ? '' : 'blog/'}${post.slug}`;
    const ogImage = post.og_image || post.featured_image || `${siteUrl}/images/default-og.jpg`;

    const tags = [];

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
function generateJsonLd(post, options = {}) {
    const siteUrl = options.siteUrl || '';
    const siteName = options.siteName || 'WordJS';
    const siteDescription = options.siteDescription || '';

    const canonicalUrl = `${siteUrl}/${post.type === 'page' ? '' : 'blog/'}${post.slug}`;

    // Article schema
    const articleSchema = {
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
function generateWebsiteSchema(options = {}) {
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
function generateBreadcrumbSchema(breadcrumbs, siteUrl = '') {
    const items = breadcrumbs.map((crumb, index) => ({
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
async function generateSitemap(posts, options = {}) {
    const siteUrl = options.siteUrl || '';

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    // Homepage
    xml += '  <url>\n';
    xml += `    <loc>${siteUrl}/</loc>\n`;
    xml += '    <changefreq>daily</changefreq>\n';
    xml += '    <priority>1.0</priority>\n';
    xml += '  </url>\n';

    // Posts and pages
    for (const post of posts) {
        if (post.status !== 'publish' || post.noindex) continue;

        const url = post.type === 'page'
            ? `${siteUrl}/${post.slug}`
            : `${siteUrl}/blog/${post.slug}`;

        const lastmod = post.updated_at || post.created_at;
        const priority = post.type === 'page' ? '0.8' : '0.6';

        xml += '  <url>\n';
        xml += `    <loc>${url}</loc>\n`;
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
 */
function generateRobotsTxt(siteUrl = '') {
    return `User-agent: *
Allow: /

# Sitemap
Sitemap: ${siteUrl}/sitemap.xml

# Blocked paths
Disallow: /api/
Disallow: /admin/
Disallow: /_next/
`;
}

/**
 * Escape HTML entities
 */
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

module.exports = {
    generateMetaTags,
    generateJsonLd,
    generateWebsiteSchema,
    generateBreadcrumbSchema,
    generateSitemap,
    generateRobotsTxt,
    escapeHtml
};
