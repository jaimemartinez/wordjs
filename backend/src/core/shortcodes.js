/**
 * WordJS - Shortcode System
 * Equivalent to wp-includes/shortcodes.php
 */

// Registered shortcodes
const shortcodes = new Map();

/**
 * Register a shortcode
 * Equivalent to add_shortcode()
 * 
 * @param {string} tag - Shortcode tag
 * @param {Function} callback - Function(attrs, content, tag) => string
 */
function addShortcode(tag, callback) {
    shortcodes.set(tag, callback);
}

/**
 * Remove a shortcode
 * Equivalent to remove_shortcode()
 */
function removeShortcode(tag) {
    shortcodes.delete(tag);
}

/**
 * Check if shortcode exists
 * Equivalent to shortcode_exists()
 */
function shortcodeExists(tag) {
    return shortcodes.has(tag);
}

/**
 * Parse shortcode attributes
 * Equivalent to shortcode_parse_atts()
 */
function parseAttrs(text) {
    if (!text) return {};

    const attrs = {};
    // Match key="value" or key='value' or key=value or just value
    const regex = /(\w+)\s*=\s*["']([^"']*)["']|(\w+)\s*=\s*(\S+)|(\w+)/g;
    let match;
    let index = 0;

    while ((match = regex.exec(text)) !== null) {
        if (match[1]) {
            // key="value"
            attrs[match[1]] = match[2];
        } else if (match[3]) {
            // key=value
            attrs[match[3]] = match[4];
        } else if (match[5]) {
            // positional attribute
            attrs[index++] = match[5];
        }
    }

    return attrs;
}

/**
 * Process shortcodes in content
 * Equivalent to do_shortcode()
 * 
 * @param {string} content - Content with shortcodes
 * @returns {string} - Processed content
 */
function doShortcode(content) {
    if (!content || shortcodes.size === 0) return content;

    // Build regex pattern for all registered shortcodes
    const tagPattern = Array.from(shortcodes.keys()).map(escapeRegex).join('|');
    if (!tagPattern) return content;

    // Match [tag attrs]content[/tag] or [tag attrs /] or [tag attrs]
    const pattern = new RegExp(
        `\\[(${tagPattern})([^\\]]*?)(?:\\/\\]|\\](?:([^\\[]*?)\\[\\/\\1\\]|))`,
        'g'
    );

    return content.replace(pattern, (match, tag, attrs, innerContent) => {
        const callback = shortcodes.get(tag);
        if (!callback) return match;

        const parsedAttrs = parseAttrs(attrs.trim());
        return callback(parsedAttrs, innerContent || '', tag);
    });
}

/**
 * Escape regex special characters
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip all shortcodes from content
 * Equivalent to strip_shortcodes()
 */
function stripShortcodes(content) {
    if (!content || shortcodes.size === 0) return content;

    const tagPattern = Array.from(shortcodes.keys()).map(escapeRegex).join('|');
    if (!tagPattern) return content;

    const pattern = new RegExp(
        `\\[(${tagPattern})[^\\]]*?(?:\\/\\]|\\](?:[^\\[]*?\\[\\/\\1\\]|))`,
        'g'
    );

    return content.replace(pattern, '');
}

// Register default shortcodes

// [gallery ids="1,2,3"]
addShortcode('gallery', (attrs) => {
    const ids = attrs.ids ? attrs.ids.split(',') : [];
    const columns = attrs.columns || 3;
    const size = attrs.size || 'thumbnail';

    return `<div class="gallery gallery-columns-${columns}" data-ids="${ids.join(',')}" data-size="${size}"></div>`;
});

// [caption]content[/caption]
addShortcode('caption', (attrs, content) => {
    const id = attrs.id || '';
    const align = attrs.align || 'alignnone';
    const width = attrs.width || 'auto';

    return `<figure id="${id}" class="wp-caption ${align}" style="width:${width}px">${content}<figcaption class="wp-caption-text">${attrs.caption || ''}</figcaption></figure>`;
});

// [embed]url[/embed]
addShortcode('embed', (attrs, content) => {
    const url = content.trim();
    return `<div class="wp-embed" data-url="${url}"><a href="${url}">${url}</a></div>`;
});

// [audio src="url"]
addShortcode('audio', (attrs) => {
    const src = attrs.src || attrs[0] || '';
    const loop = attrs.loop === 'on' ? 'loop' : '';
    const autoplay = attrs.autoplay === 'on' ? 'autoplay' : '';

    return `<audio controls ${loop} ${autoplay}><source src="${src}">Your browser does not support audio.</audio>`;
});

// [video src="url"]
addShortcode('video', (attrs) => {
    const src = attrs.src || attrs[0] || '';
    const width = attrs.width || '100%';
    const height = attrs.height || 'auto';
    const poster = attrs.poster || '';

    return `<video controls width="${width}" height="${height}" poster="${poster}"><source src="${src}">Your browser does not support video.</video>`;
});

// [button]text[/button]
addShortcode('button', (attrs, content) => {
    const url = attrs.url || attrs.href || '#';
    const target = attrs.target || '_self';
    const className = attrs.class || 'wp-button';

    return `<a href="${url}" target="${target}" class="${className}">${content}</a>`;
});

// [columns]content[/columns]
addShortcode('columns', (attrs, content) => {
    const count = attrs.count || 2;
    return `<div class="wp-columns columns-${count}">${content}</div>`;
});

// [column]content[/column]
addShortcode('column', (attrs, content) => {
    const width = attrs.width || '';
    const style = width ? `style="width:${width}"` : '';
    return `<div class="wp-column" ${style}>${content}</div>`;
});

module.exports = {
    addShortcode,
    removeShortcode,
    shortcodeExists,
    doShortcode,
    stripShortcodes,
    parseAttrs
};
