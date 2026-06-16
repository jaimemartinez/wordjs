/**
 * WordJS - Shortcode System
 * Equivalent to wp-includes/shortcodes.php
 */

const { escAttr, escUrl } = require('./formatting');

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
 * Process shortcodes in content, awaiting async callbacks.
 * Same matching as doShortcode(), but a callback may return a Promise<string> — required for
 * shortcodes whose handler needs to await (e.g. fetching data) or that live in an isolated plugin
 * worker (the bridge handler RPCs the worker and resolves asynchronously). Sync callbacks work too
 * (awaiting a non-Promise is a no-op). Call this from async rendering paths instead of doShortcode.
 *
 * @param {string} content
 * @returns {Promise<string>}
 */
async function doShortcodeAsync(content) {
    if (!content || shortcodes.size === 0) return content;

    const tagPattern = Array.from(shortcodes.keys()).map(escapeRegex).join('|');
    if (!tagPattern) return content;

    const pattern = new RegExp(
        `\\[(${tagPattern})([^\\]]*?)(?:\\/\\]|\\](?:([^\\[]*?)\\[\\/\\1\\]|))`,
        'g'
    );

    // Collect matches first (regex .exec loop), then resolve callbacks concurrently, then splice
    // back-to-front so earlier indices stay valid. String.replace can't await, hence this approach.
    const matches: Array<{ index: number; length: number; full: string; tag: string; attrs: string; inner: string }> = [];
    let m;
    while ((m = pattern.exec(content)) !== null) {
        matches.push({ index: m.index, length: m[0].length, full: m[0], tag: m[1], attrs: m[2], inner: m[3] });
    }
    if (matches.length === 0) return content;

    const replacements = await Promise.all(matches.map(async (mm) => {
        const callback = shortcodes.get(mm.tag);
        if (!callback) return mm.full;
        const parsedAttrs = parseAttrs((mm.attrs || '').trim());
        try {
            const out = await callback(parsedAttrs, mm.inner || '', mm.tag);
            return out == null ? '' : String(out);
        } catch (e) {
            return mm.full; // leave the tag untouched if its handler errors
        }
    }));

    let result = content;
    for (let i = matches.length - 1; i >= 0; i--) {
        result = result.slice(0, matches[i].index) + replacements[i] + result.slice(matches[i].index + matches[i].length);
    }
    return result;
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
    const columns = Number(attrs.columns) || 3;
    const size = attrs.size || 'thumbnail';

    return `<div class="gallery gallery-columns-${columns}" data-ids="${escAttr(ids.join(','))}" data-size="${escAttr(size)}"></div>`;
});

// [caption]content[/caption]
addShortcode('caption', (attrs, content) => {
    const id = attrs.id || '';
    const align = attrs.align || 'alignnone';
    const width = attrs.width === 'auto' || attrs.width === undefined ? 'auto' : Number(attrs.width) || 0;

    return `<figure id="${escAttr(id)}" class="wp-caption ${escAttr(align)}" style="width:${width}px">${content}<figcaption class="wp-caption-text">${escAttr(attrs.caption || '')}</figcaption></figure>`;
});

// [embed]url[/embed]
addShortcode('embed', (attrs, content) => {
    const url = content.trim();
    const safeUrl = escUrl(url);
    return `<div class="wp-embed" data-url="${safeUrl}"><a href="${safeUrl}">${escAttr(url)}</a></div>`;
});

// [audio src="url"]
addShortcode('audio', (attrs) => {
    const src = attrs.src || attrs[0] || '';
    const loop = attrs.loop === 'on' ? 'loop' : '';
    const autoplay = attrs.autoplay === 'on' ? 'autoplay' : '';

    return `<audio controls ${loop} ${autoplay}><source src="${escUrl(src)}">Your browser does not support audio.</audio>`;
});

// [video src="url"]
addShortcode('video', (attrs) => {
    const src = attrs.src || attrs[0] || '';
    const width = attrs.width || '100%';
    const height = attrs.height || 'auto';
    const poster = attrs.poster || '';

    return `<video controls width="${escAttr(width)}" height="${escAttr(height)}" poster="${escUrl(poster)}"><source src="${escUrl(src)}">Your browser does not support video.</video>`;
});

// [button]text[/button]
addShortcode('button', (attrs, content) => {
    const url = attrs.url || attrs.href || '#';
    const safeUrl = escUrl(url) || '#';
    const target = attrs.target || '_self';
    const className = attrs.class || 'wp-button';

    return `<a href="${safeUrl}" target="${escAttr(target)}" class="${escAttr(className)}">${content}</a>`;
});

// [columns]content[/columns]
addShortcode('columns', (attrs, content) => {
    const count = Number(attrs.count) || 2;
    return `<div class="wp-columns columns-${count}">${content}</div>`;
});

// [column]content[/column]
addShortcode('column', (attrs, content) => {
    const width = attrs.width || '';
    const style = width ? `style="width:${escAttr(width)}"` : '';
    return `<div class="wp-column" ${style}>${content}</div>`;
});

module.exports = {
    addShortcode,
    removeShortcode,
    shortcodeExists,
    doShortcode,
    doShortcodeAsync,
    stripShortcodes,
    parseAttrs
};
