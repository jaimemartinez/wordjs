/**
 * WordJS — shared meta sanitizer.
 *
 * The Puck page tree (_puck_data) is stored verbatim in post_meta and rendered as HTML at many
 * independent public sites, so it MUST be sanitized on every write path. This logic originally lived
 * in routes/posts.ts; it is extracted here so non-route write paths (e.g. the WXR importer) sanitize
 * meta through the EXACT same code instead of bypassing it. Behavior is intentionally identical to the
 * former posts.ts implementation.
 */

const sanitizeHtml = require('sanitize-html');

// Sanitization Config
const sanitize = (html: string) => {
    return sanitizeHtml(html, {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'iframe']),
        allowedAttributes: {
            ...sanitizeHtml.defaults.allowedAttributes,
            'img': ['src', 'alt', 'width', 'height', 'class'],
            'iframe': ['src', 'width', 'height', 'allowfullscreen', 'frameborder', 'allow'],
            '*': ['class', 'style', 'id']
        },
        allowedIframeHostnames: ['www.youtube.com', 'player.vimeo.com']
    });
};

// Field names within a Puck component's `props` that may carry rich HTML and are rendered through a
// dangerouslySetInnerHTML/innerHTML path on the public site → sanitize their HTML.
const PUCK_HTML_FIELDS = new Set(['content', 'html', 'text', 'title', 'heading', 'description', 'caption', 'body']);
// Field names that hold a URL and are rendered into src/href → strip ONLY dangerous schemes. NOTE:
// 'icon' is intentionally NOT here — it carries a FontAwesome class token (e.g. 'fa-rocket'), not a URL,
// and must be left untouched. We must also PRESERVE relative paths ('/uploads/x.png'), fragments ('#'),
// and protocol-relative URLs — blanking those (as a strict absolute-http(s)-only escaper does) silently
// corrupts the page builder (broken images/links/icons on every save).
const PUCK_URL_FIELDS = new Set(['url', 'src', 'href', 'link', 'image', 'poster']);

// Permissive URL sanitizer for Puck URL fields: keep relative/absolute/fragment/mailto/tel URLs, drop
// only script-bearing schemes. (An <img src="javascript:..."> is inert anyway; an <a href> is the real
// sink — both are covered.)
function safePuckUrl(v: string): string {
    const t = String(v).split('').filter((c) => { const n = c.charCodeAt(0); return n > 0x20 && (n < 0x7f || n > 0xa0); }).join('').toLowerCase();
    if (/^(?:javascript|data|vbscript|file):/.test(t)) return '';
    return v;
}

/**
 * Sanitize untrusted meta on write. The Puck tree (_puck_data) is stored verbatim and trusted at many
 * independent public render sites; a single block that pipes a field into innerHTML without escaping is
 * author-privilege stored XSS. Walk the structure and sanitize ONLY string leaves (preserving the JSON
 * shape): HTML-bearing fields via the post-body sanitizer, URL-bearing fields via an allow-list of
 * schemes. Non-HTML/URL strings are left untouched.
 */
function sanitizePuckTree(node: any, keyHint: string | null = null): any {
    if (Array.isArray(node)) {
        return node.map((item) => sanitizePuckTree(item, keyHint));
    }
    if (node && typeof node === 'object') {
        const out: any = Array.isArray(node) ? [] : {};
        for (const [k, v] of Object.entries(node)) {
            out[k] = sanitizePuckTree(v, k);
        }
        return out;
    }
    if (typeof node === 'string') {
        const lower = keyHint ? String(keyHint).toLowerCase() : '';
        if (PUCK_HTML_FIELDS.has(lower)) {
            return sanitize(node);
        }
        // VALUE-BASED (not key-based): run EVERY other string leaf through safePuckUrl. It ONLY blanks a
        // value that STARTS with a script/dangerous scheme (javascript:/data:/vbscript:/file:) and returns
        // everything else untouched — so it closes stored XSS via URL-bearing props whose key we didn't
        // enumerate (e.g. CTABanner/PricingTable `buttonLink`, a menu `to`, etc.) while preserving labels,
        // classes, colors, relative paths, fragments. (XSS-01: the old key-name allowlist missed buttonLink.)
        return safePuckUrl(node);
    }
    return node;
}

/**
 * Sanitize a single meta value before persisting. Currently targets _puck_data (the serialized Puck
 * page tree) which is rendered as HTML on the public site; structured JSON shape is preserved.
 */
function sanitizeMetaValue(key: string, value: any) {
    if (key === '_puck_data' && value) {
        if (typeof value === 'object') return sanitizePuckTree(value);
        // XSS-02: _puck_data sent as a JSON STRING (some clients/imports do) bypassed the object-only
        // guard entirely. Parse → sanitize → re-stringify; a non-JSON string isn't a Puck tree so leave it.
        if (typeof value === 'string') {
            try { return JSON.stringify(sanitizePuckTree(JSON.parse(value))); }
            catch { return value; }
        }
    }
    return value;
}

module.exports = { sanitize, sanitizePuckTree, sanitizeMetaValue, PUCK_HTML_FIELDS, PUCK_URL_FIELDS, safePuckUrl };
