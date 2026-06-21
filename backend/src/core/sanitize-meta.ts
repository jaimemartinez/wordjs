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
const sanitize = (html) => {
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
function sanitizePuckTree(node: any, keyHint: string | null = null) {
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
    if (typeof node === 'string' && keyHint) {
        const lower = String(keyHint).toLowerCase();
        if (PUCK_URL_FIELDS.has(lower)) {
            // Strip only script-bearing schemes; preserve relative/fragment/absolute URLs (escUrl was too
            // strict — it blanked relative paths + '#', corrupting the page builder).
            return safePuckUrl(node);
        }
        if (PUCK_HTML_FIELDS.has(lower)) {
            return sanitize(node);
        }
    }
    return node;
}

/**
 * Sanitize a single meta value before persisting. Currently targets _puck_data (the serialized Puck
 * page tree) which is rendered as HTML on the public site; structured JSON shape is preserved.
 */
function sanitizeMetaValue(key, value) {
    if (key === '_puck_data' && value && typeof value === 'object') {
        return sanitizePuckTree(value);
    }
    return value;
}

module.exports = { sanitize, sanitizePuckTree, sanitizeMetaValue, PUCK_HTML_FIELDS, PUCK_URL_FIELDS, safePuckUrl };
