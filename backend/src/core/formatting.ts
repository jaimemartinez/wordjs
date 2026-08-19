/**
 * WordJS - Formatting Functions
 * Equivalent to wp-includes/formatting.php
 */

const sanitizeHtml = require('sanitize-html');
const slugifyLib = require('slugify');
// THE CLASS CHANNEL, one function for the whole package. `withClassBound` wraps a sanitize-html config
// so every surviving element's `class` attribute is filtered token by token by the shared criterion
// (see core/sanitize-meta.ts, mirrored from frontend/src/components/blocks/safeStyle.ts). Requiring it
// here rather than re-declaring the rule is the point: this file is the write boundary for
// post_content AND for comments, and a comment is the one place in the tree where an ANONYMOUS writer
// reaches an ADMINISTRATOR's screen — admin/comments/page.tsx paints the moderation queue with
// dangerouslySetInnerHTML, and `class="fixed inset-0 z-50 w-full h-full bg-white"` around an
// attacker-chosen <a href> is a full-screen credential-phishing overlay inside /admin.
// sanitize-meta.ts requires nothing from this module, so there is no cycle.
const { withClassBound } = require('./sanitize-meta');

/**
 * The longest slug this function will produce.
 *
 * WHY A BOUND EXISTS AT ALL. A slug is written to a column MySQL must be able to INDEX, and MySQL
 * cannot index an unbounded type — so `posts.post_name`, `terms.slug`, `options.option_name` and
 * `post_meta.meta_key` all end up VARCHAR(255) there (declared by the TEXT rule, or narrowed by the
 * driver when the index is declared later; see drivers/mysql-text-rule.ts). The session now also runs
 * STRICT_TRANS_TABLES, which is the point of that change: a value that does not fit is an ERROR
 * instead of a silent truncation. Silent truncation was itself a defect — two long titles truncated
 * to the same 255 characters produced two posts with the SAME post_name — but replacing it with an
 * uncaught ERROR 1406 only moves the damage: `POST /posts` with a 300-character title answers 500.
 *
 * A slug that long is not meaningful to anyone, so the producer bounds it. 200 leaves 55 characters
 * of head-room for the `-2`, `-3`, … disambiguating suffix Post.generateUniqueSlug appends, so even a
 * heavily-collided long title stays inside 255.
 */
const MAX_SLUG_LENGTH = 200;

/**
 * Sanitize a string for use as a slug
 * Equivalent to sanitize_title()
 *
 * Bounded (see MAX_SLUG_LENGTH): the cut is made on the slug, at a `-` boundary when one is close
 * enough, so the result is still a whole-word slug and never ends in a stray separator.
 */
function sanitizeTitle(title: string) {
    const slug = slugifyLib(title, {
        lower: true,
        strict: true,
        locale: 'en'
    });
    return boundSlug(slug);
}

/**
 * Cut a slug down to MAX_SLUG_LENGTH characters. Exported so any other producer of a slug-shaped
 * value can apply the SAME bound rather than inventing a second one.
 */
function boundSlug(slug: string, maxLength: number = MAX_SLUG_LENGTH) {
    const s = String(slug == null ? '' : slug);
    if (s.length <= maxLength) return s;
    const cut = s.slice(0, maxLength);
    const lastSep = cut.lastIndexOf('-');
    // Prefer a word boundary, but never throw away more than a quarter of the budget chasing one.
    const bounded = lastSep >= Math.floor(maxLength * 0.75) ? cut.slice(0, lastSep) : cut;
    return bounded.replace(/-+$/, '');
}

/**
 * Sanitize HTML content
 * Equivalent to wp_kses()
 */
function sanitizeContent(content: string, allowedTags: any = null) {
    const defaultAllowed = {
        allowedTags: [
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'p', 'br', 'hr',
            'ul', 'ol', 'li',
            'strong', 'b', 'em', 'i', 'u', 's', 'strike',
            'a', 'img',
            'blockquote', 'pre', 'code',
            'table', 'thead', 'tbody', 'tr', 'th', 'td',
            'div', 'span', 'section',
            'figure', 'figcaption'
        ],
        allowedAttributes: {
            'a': ['href', 'title', 'target', 'rel', 'class', 'id', 'style'],
            'img': ['src', 'alt', 'title', 'width', 'height', 'class', 'id', 'style'],
            'div': ['class', 'id', 'style'],
            'span': ['class', 'id', 'style'],
            'p': ['class', 'id', 'style'],
            'table': ['class', 'id', 'style'],
            'td': ['class', 'id', 'style', 'colspan', 'rowspan'],
            'th': ['class', 'id', 'style', 'colspan', 'rowspan'],
            '*': ['class', 'id'] // Remove blanket 'style' permission
        },
        allowedStyles: {
            '*': {
                // Typography
                'color': [/^#(0x)?[0-9a-f]+$/i, /^rgb\(/, /^[a-z]+$/i],
                'text-align': [/^left$/, /^right$/, /^center$/, /^justify$/],
                'font-size': [/^\d+(?:px|em|rem|%)$/],
                'font-weight': [/^\d+$/, /^bold$/, /^normal$/],
                'font-family': [/^.+$/], // Allow font families but basic check
                'text-decoration': [/^underline$/, /^line-through$/, /^none$/],

                // Layout & Box Model
                'width': [/^\d+(?:px|em|%|vw)$/],
                'height': [/^\d+(?:px|em|%|vh)$/],
                'padding': [/^\d+(?:px|em|%)$/, /^0$/],
                'padding-left': [/^\d+(?:px|em|%)$/],
                'padding-right': [/^\d+(?:px|em|%)$/],
                'padding-top': [/^\d+(?:px|em|%)$/],
                'padding-bottom': [/^\d+(?:px|em|%)$/],
                'margin': [/^\d+(?:px|em|%|auto)$/, /^0$/],
                'margin-left': [/^\d+(?:px|em|%|auto)$/],
                'margin-right': [/^\d+(?:px|em|%|auto)$/],
                'margin-top': [/^\d+(?:px|em|%)$/],
                'margin-bottom': [/^\d+(?:px|em|%)$/],

                // Visuals
                'background-color': [/^#(0x)?[0-9a-f]+$/i, /^rgb\(/, /^[a-z]+$/i],
                'border': [/^.+$/],
                'border-radius': [/^\d+(?:px|em|%)$/],

                // Disallow: position, z-index, background-image (unless strictly validated), etc.
            }
        },
        allowedSchemes: ['http', 'https', 'mailto', 'tel']
    };

    // The bound is applied to the config that is actually USED, not only to the default one: the
    // `allowedTags` parameter replaces the whole configuration, so a caller that passes its own would
    // otherwise re-open the channel this function exists to close. withClassBound preserves whatever
    // transformTags that config declares.
    return sanitizeHtml(content, withClassBound(allowedTags || defaultAllowed));
}

/**
 * Escape HTML entities
 * Equivalent to esc_html()
 */
function escHtml(text: any) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Escape attribute value
 * Equivalent to esc_attr()
 */
function escAttr(text: any) {
    return escHtml(text);
}

/**
 * Escape URL
 * Equivalent to esc_url()
 */
function escUrl(url: string) {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        const allowedProtocols = ['http:', 'https:', 'mailto:', 'tel:'];
        if (!allowedProtocols.includes(parsed.protocol)) {
            return '';
        }
        return parsed.href;
    } catch {
        return '';
    }
}

/**
 * Convert line breaks to <br> tags
 * Equivalent to nl2br()
 */
function nl2br(text: any) {
    if (!text) return '';
    return String(text).replace(/\n/g, '<br>');
}

/**
 * Auto-paragraph text
 * Equivalent to wpautop()
 */
function autop(text: string) {
    if (!text) return '';

    // Normalize line breaks
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Split by double newlines (paragraphs)
    const paragraphs = text.split(/\n\n+/);

    return paragraphs
        .map((p: string) => p.trim())
        .filter((p: string) => p.length > 0)
        .map((p: string) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
        .join('\n');
}

/**
 * Truncate text to specified length
 * Equivalent to wp_trim_words()
 */
function trimWords(text: string, numWords = 55, more = '...') {
    if (!text) return '';
    const words = text.split(/\s+/);
    if (words.length <= numWords) return text;
    return words.slice(0, numWords).join(' ') + more;
}

/**
 * Strip all HTML tags
 * Equivalent to wp_strip_all_tags()
 */
function stripTags(text: any) {
    if (!text) return '';
    return sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
}

/**
 * Generate excerpt from content
 * Equivalent to wp_trim_excerpt()
 */
function generateExcerpt(content: any, length = 55) {
    const stripped = stripTags(content);
    return trimWords(stripped, length);
}

/**
 * Format date
 * @param {string|Date} date - Date to format
 * @param {string} format - Format string (simple implementation)
 */
function formatDate(date: string | Date, format = 'Y-m-d H:i:s') {
    const d = new Date(date);

    const pad = (n: number) => String(n).padStart(2, '0');

    const replacements: Record<string, string | number> = {
        'Y': d.getFullYear(),
        'm': pad(d.getMonth() + 1),
        'd': pad(d.getDate()),
        'H': pad(d.getHours()),
        'i': pad(d.getMinutes()),
        's': pad(d.getSeconds())
    };

    let result = format;
    for (const [key, value] of Object.entries(replacements)) {
        result = result.replace(new RegExp(key, 'g'), String(value));
    }

    return result;
}

/**
 * Get current GMT timestamp
 */
function currentTimeGMT() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Get current local timestamp
 */
function currentTime() {
    const now = new Date();
    return formatDate(now);
}

module.exports = {
    sanitizeTitle,
    boundSlug,
    MAX_SLUG_LENGTH,
    sanitizeContent,
    escHtml,
    escAttr,
    escUrl,
    nl2br,
    autop,
    trimWords,
    stripTags,
    generateExcerpt,
    formatDate,
    currentTimeGMT,
    currentTime
};
