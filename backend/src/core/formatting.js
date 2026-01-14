/**
 * WordJS - Formatting Functions
 * Equivalent to wp-includes/formatting.php
 */

const sanitizeHtml = require('sanitize-html');
const slugifyLib = require('slugify');

/**
 * Sanitize a string for use as a slug
 * Equivalent to sanitize_title()
 */
function sanitizeTitle(title) {
    return slugifyLib(title, {
        lower: true,
        strict: true,
        locale: 'en'
    });
}

/**
 * Sanitize HTML content
 * Equivalent to wp_kses()
 */
function sanitizeContent(content, allowedTags = null) {
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
            'a': ['href', 'title', 'target', 'rel'],
            'img': ['src', 'alt', 'title', 'width', 'height'],
            'div': ['class', 'id', 'style'],
            'section': ['class', 'id', 'style'],
            '*': ['class', 'id', 'style']
        },
        allowedSchemes: ['http', 'https', 'mailto']
    };

    return sanitizeHtml(content, allowedTags || defaultAllowed);
}

/**
 * Escape HTML entities
 * Equivalent to esc_html()
 */
function escHtml(text) {
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
function escAttr(text) {
    return escHtml(text);
}

/**
 * Escape URL
 * Equivalent to esc_url()
 */
function escUrl(url) {
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
function nl2br(text) {
    if (!text) return '';
    return String(text).replace(/\n/g, '<br>');
}

/**
 * Auto-paragraph text
 * Equivalent to wpautop()
 */
function autop(text) {
    if (!text) return '';

    // Normalize line breaks
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Split by double newlines (paragraphs)
    const paragraphs = text.split(/\n\n+/);

    return paragraphs
        .map(p => p.trim())
        .filter(p => p.length > 0)
        .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
        .join('\n');
}

/**
 * Truncate text to specified length
 * Equivalent to wp_trim_words()
 */
function trimWords(text, numWords = 55, more = '...') {
    if (!text) return '';
    const words = text.split(/\s+/);
    if (words.length <= numWords) return text;
    return words.slice(0, numWords).join(' ') + more;
}

/**
 * Strip all HTML tags
 * Equivalent to wp_strip_all_tags()
 */
function stripTags(text) {
    if (!text) return '';
    return sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
}

/**
 * Generate excerpt from content
 * Equivalent to wp_trim_excerpt()
 */
function generateExcerpt(content, length = 55) {
    const stripped = stripTags(content);
    return trimWords(stripped, length);
}

/**
 * Format date
 * @param {string|Date} date - Date to format
 * @param {string} format - Format string (simple implementation)
 */
function formatDate(date, format = 'Y-m-d H:i:s') {
    const d = new Date(date);

    const pad = (n) => String(n).padStart(2, '0');

    const replacements = {
        'Y': d.getFullYear(),
        'm': pad(d.getMonth() + 1),
        'd': pad(d.getDate()),
        'H': pad(d.getHours()),
        'i': pad(d.getMinutes()),
        's': pad(d.getSeconds())
    };

    let result = format;
    for (const [key, value] of Object.entries(replacements)) {
        result = result.replace(new RegExp(key, 'g'), value);
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
