/**
 * WordJS - Shortcode System
 * Equivalent to wp-includes/shortcodes.php
 */

const { escAttr, escUrl } = require('./formatting');

// Registered shortcodes
const shortcodes = new Map();
// Owner of each registered tag: a plugin slug, or null for core (no plugin on the stack). Registration
// is a GLOBAL, site-wide namespace, so without ownership it is last-writer-wins — an untrusted plugin
// could re-register a core tag (or another plugin's) and silently replace its rendered output on every
// page that uses it (stored defacement / content-integrity attack). We refuse cross-owner overwrites.
const shortcodeOwners = new Map<string, string | null>();

// Resolve the effective plugin (or null = core) of the CURRENT call, lazily to avoid an init-time cycle.
function currentOwner(): string | null {
    try { return require('./plugin-context').getEffectivePlugin() || null; }
    catch { return null; }
}

/**
 * Register a shortcode
 * Equivalent to add_shortcode()
 *
 * @param {string} tag - Shortcode tag
 * @param {Function} callback - Function(attrs, content, tag) => string
 */
function addShortcode(tag: string, callback: (...args: any[]) => any) {
    const owner = currentOwner();
    if (shortcodes.has(tag)) {
        const existing = shortcodeOwners.get(tag) ?? null;
        // Same owner may re-register (update); core (owner=null) may always (re)claim a tag. But a plugin
        // must NOT overwrite a tag owned by core or by a DIFFERENT plugin.
        if (owner !== null && existing !== owner) {
            console.warn(`[Security Block] Plugin '${owner}' tried to override shortcode '[${tag}]' owned by '${existing ?? 'core'}' — refused.`);
            return;
        }
    }
    // Wrap the callback so it ALWAYS runs in its owner's security context. Unlike hooks/timers/emitters,
    // doShortcodeAsync invokes the shortcode callback DIRECTLY, and it is called from Post.toJSON during
    // render with an EMPTY ALS store — so an unwrapped plugin/theme shortcode would execute as "core"/
    // trusted and slip past the option/cache/env context-gated guards (#20). Core (owner=null) stays raw.
    const stored = owner
        ? function (this: any, ...a: any[]) { const { runWithContext } = require('./plugin-context'); return runWithContext(owner, () => (callback as any).apply(this, a)); }
        : callback;
    shortcodes.set(tag, stored);
    shortcodeOwners.set(tag, owner);
}

/**
 * Remove a shortcode
 * Equivalent to remove_shortcode()
 */
function removeShortcode(tag: string) {
    // A plugin may only remove a tag it owns; core may remove any. Prevents one plugin unregistering
    // another plugin's / core's shortcode.
    const owner = currentOwner();
    if (owner !== null && shortcodes.has(tag) && (shortcodeOwners.get(tag) ?? null) !== owner) {
        console.warn(`[Security Block] Plugin '${owner}' tried to remove shortcode '[${tag}]' owned by '${shortcodeOwners.get(tag) ?? 'core'}' — refused.`);
        return;
    }
    shortcodes.delete(tag);
    shortcodeOwners.delete(tag);
}

/**
 * Check if shortcode exists
 * Equivalent to shortcode_exists()
 */
function shortcodeExists(tag: string) {
    return shortcodes.has(tag);
}

/**
 * Parse shortcode attributes
 * Equivalent to shortcode_parse_atts()
 */
function parseAttrs(text: string) {
    if (!text) return {};

    const attrs: Record<string, any> = {};
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
 * Upper bound on the shortcodes expanded (or stripped) in ONE document. Every match costs a callback
 * invocation (and, in doShortcodeAsync, a pending Promise held until all of them settle), and the body
 * of a post is contributor-controlled and may be megabytes long: "[gallery]".repeat(1e6) would otherwise
 * queue a million handler calls on every serialization of that post. Real content uses a handful; past
 * the cap the remaining text is left exactly as written (unexpanded), never dropped.
 */
const MAX_SHORTCODES_PER_DOCUMENT = 2000;

interface ShortcodeMatch {
    index: number;  // offset of the opening '['
    end: number;    // offset just past the match
    tag: string;
    attrs: string;
    inner: string | undefined; // undefined when there is no [/tag] closer (self-closing / bare form)
}

/**
 * Find the shortcodes in `content`, in document order, in ONE linear pass.
 *
 * WHY NOT A REGEX. This used to be `\[(tags)([^\]]*?)(?:\/\]|\](?:([^\[]*?)\[\/\1\]|))` with the g
 * flag. Its attribute run is unbounded, so an opening `[tag` with no `]` after it scans to the end of the
 * document before failing — and the engine then retries at the NEXT `[tag`, which scans to the end
 * again. Post content of "[gallery ".repeat(n) was therefore O(n²): 360 KB took ~5 s and 1.4 MB ~90 s of
 * a blocked event loop, triggered by ANY contributor's draft on every Post.toJSON (content AND excerpt).
 *
 * This scanner reproduces that regex's matching EXACTLY (so every existing shortcode renders the same):
 *   - a match starts at a '[' immediately followed by a registered tag; the tags are tried in
 *     registration order and the first that is a prefix wins (the regex alternation; no word boundary);
 *   - the attributes run to the FIRST ']' after the tag (they may contain '['); if that ']' is preceded
 *     by '/' inside the run, the shortcode is self-closing and the '/' is not part of the attributes;
 *   - otherwise, if the first '[' after that ']' starts `[/tag]`, the text in between is the inner
 *     content and the match extends past the closer; if not, the match ends at the ']' (bare form);
 *   - when no ']' follows a `[tag` at all, no later `[tag` can match either, so scanning stops.
 * The next ']' and the next '[' are found with indexOf from a cursor that only moves forward, so each
 * character is inspected a bounded number of times: O(n · longest tag) per document.
 */
function scanShortcodes(content: string, limit: number = MAX_SHORTCODES_PER_DOCUMENT): ShortcodeMatch[] {
    const matches: ShortcodeMatch[] = [];
    if (!content || shortcodes.size === 0) return matches;
    const tagPattern = Array.from(shortcodes.keys()).map(escapeRegex).join('|');
    if (!tagPattern) return matches;
    // Sticky: tests the tag alternation AT a given '[' only (never searches ahead), in registration order.
    const openRe = new RegExp(`\\[(${tagPattern})`, 'y');

    let pos = 0;
    let nextClose = -2; // cached index of the first ']' at or after the last search start (-1: none left)
    while (matches.length < limit) {
        const open = content.indexOf('[', pos);
        if (open === -1) break;
        openRe.lastIndex = open;
        const m = openRe.exec(content);
        if (!m) { pos = open + 1; continue; }

        const tag = m[1];
        const attrsStart = open + m[0].length;
        if (nextClose !== -1 && nextClose < attrsStart) nextClose = content.indexOf(']', attrsStart);
        if (nextClose === -1) break; // no ']' anywhere ahead: nothing further can match

        const close = nextClose;
        if (close > attrsStart && content.charCodeAt(close - 1) === 47 /* '/' */) {
            matches.push({ index: open, end: close + 1, tag, attrs: content.slice(attrsStart, close - 1), inner: undefined });
            pos = close + 1;
            continue;
        }

        const attrs = content.slice(attrsStart, close);
        const innerStart = close + 1;
        const nextOpen = content.indexOf('[', innerStart);
        const closer = `[/${tag}]`;
        if (nextOpen !== -1 && content.startsWith(closer, nextOpen)) {
            matches.push({ index: open, end: nextOpen + closer.length, tag, attrs, inner: content.slice(innerStart, nextOpen) });
            pos = nextOpen + closer.length;
        } else {
            matches.push({ index: open, end: innerStart, tag, attrs, inner: undefined });
            pos = innerStart;
        }
    }
    return matches;
}

/**
 * Rebuild `content` with each match replaced by its replacement — one join, not a slice-and-concat per
 * match (which is O(n) per match, i.e. quadratic in the number of shortcodes).
 */
function spliceMatches(content: string, matches: ShortcodeMatch[], replacements: string[]) {
    const parts: string[] = [];
    let last = 0;
    for (let i = 0; i < matches.length; i++) {
        parts.push(content.slice(last, matches[i].index), replacements[i]);
        last = matches[i].end;
    }
    parts.push(content.slice(last));
    return parts.join('');
}

/**
 * Process shortcodes in content
 * Equivalent to do_shortcode()
 * 
 * @param {string} content - Content with shortcodes
 * @returns {string} - Processed content
 */
function doShortcode(content: string) {
    if (!content || shortcodes.size === 0) return content;

    // Match [tag attrs]content[/tag] or [tag attrs /] or [tag attrs] (see scanShortcodes)
    const matches = scanShortcodes(content);
    if (matches.length === 0) return content;

    const replacements = matches.map((mm) => {
        const callback = shortcodes.get(mm.tag);
        if (!callback) return content.slice(mm.index, mm.end);

        const parsedAttrs = parseAttrs(mm.attrs.trim());
        // String() mirrors what String.prototype.replace did with a replacer's return value.
        return String(callback(parsedAttrs, mm.inner || '', mm.tag));
    });
    return spliceMatches(content, matches, replacements);
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
async function doShortcodeAsync(content: string) {
    if (!content || shortcodes.size === 0) return content;

    // Collect matches first, then resolve callbacks concurrently, then splice them back in one pass.
    // String.replace can't await, hence this approach.
    const matches = scanShortcodes(content);
    if (matches.length === 0) return content;

    const replacements = await Promise.all(matches.map(async (mm) => {
        const full = content.slice(mm.index, mm.end);
        const callback = shortcodes.get(mm.tag);
        if (!callback) return full;
        const parsedAttrs = parseAttrs((mm.attrs || '').trim());
        try {
            const out = await callback(parsedAttrs, mm.inner || '', mm.tag);
            return out == null ? '' : String(out);
        } catch {
            return full; // leave the tag untouched if its handler errors
        }
    }));

    return spliceMatches(content, matches, replacements);
}

/**
 * Escape regex special characters
 */
function escapeRegex(str: string) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip all shortcodes from content
 * Equivalent to strip_shortcodes()
 */
function stripShortcodes(content: string) {
    if (!content || shortcodes.size === 0) return content;

    // Same linear scanner as doShortcode (this runs on every excerpt, i.e. every Post.toJSON).
    const matches = scanShortcodes(content);
    if (matches.length === 0) return content;
    return spliceMatches(content, matches, matches.map(() => ''));
}

// Register default shortcodes

// [gallery ids="1,2,3"]
addShortcode('gallery', (attrs: any) => {
    const ids = attrs.ids ? attrs.ids.split(',') : [];
    const columns = Number(attrs.columns) || 3;
    const size = attrs.size || 'thumbnail';

    return `<div class="gallery gallery-columns-${columns}" data-ids="${escAttr(ids.join(','))}" data-size="${escAttr(size)}"></div>`;
});

// [caption]content[/caption]
addShortcode('caption', (attrs: any, content: string) => {
    const id = attrs.id || '';
    const align = attrs.align || 'alignnone';
    const width = attrs.width === 'auto' || attrs.width === undefined ? 'auto' : Number(attrs.width) || 0;

    return `<figure id="${escAttr(id)}" class="wp-caption ${escAttr(align)}" style="width:${width}px">${content}<figcaption class="wp-caption-text">${escAttr(attrs.caption || '')}</figcaption></figure>`;
});

// [embed]url[/embed]
addShortcode('embed', (attrs: any, content: string) => {
    const url = content.trim();
    const safeUrl = escUrl(url);
    return `<div class="wp-embed" data-url="${safeUrl}"><a href="${safeUrl}">${escAttr(url)}</a></div>`;
});

// [audio src="url"]
addShortcode('audio', (attrs: any) => {
    const src = attrs.src || attrs[0] || '';
    const loop = attrs.loop === 'on' ? 'loop' : '';
    const autoplay = attrs.autoplay === 'on' ? 'autoplay' : '';

    return `<audio controls ${loop} ${autoplay}><source src="${escUrl(src)}">Your browser does not support audio.</audio>`;
});

// [video src="url"]
addShortcode('video', (attrs: any) => {
    const src = attrs.src || attrs[0] || '';
    const width = attrs.width || '100%';
    const height = attrs.height || 'auto';
    const poster = attrs.poster || '';

    return `<video controls width="${escAttr(width)}" height="${escAttr(height)}" poster="${escUrl(poster)}"><source src="${escUrl(src)}">Your browser does not support video.</video>`;
});

// [button]text[/button]
addShortcode('button', (attrs: any, content: string) => {
    const url = attrs.url || attrs.href || '#';
    const safeUrl = escUrl(url) || '#';
    const target = attrs.target || '_self';
    const className = attrs.class || 'wp-button';

    return `<a href="${safeUrl}" target="${escAttr(target)}" class="${escAttr(className)}">${content}</a>`;
});

// [columns]content[/columns]
addShortcode('columns', (attrs: any, content: string) => {
    const count = Number(attrs.count) || 2;
    return `<div class="wp-columns columns-${count}">${content}</div>`;
});

// [column]content[/column]
addShortcode('column', (attrs: any, content: string) => {
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
    parseAttrs,
    MAX_SHORTCODES_PER_DOCUMENT
};
