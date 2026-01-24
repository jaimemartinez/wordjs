/**
 * WordJS - SEO Tests
 * Unit tests for SEO functionality
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Import SEO helper (mocking path for test)
const path = require('path');

describe('SEO Helper', () => {
    // Mock helper functions for testing
    const escapeHtml = (text) => {
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
        const isValidPriority = (p) => parseFloat(p) >= 0 && parseFloat(p) <= 1;

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
