/**
 * WordJS - Shortcode System
 * Equivalent to wp-includes/shortcodes.php
 */

const { escAttr, escUrl } = require('./formatting');
const log = require('./module-logger').moduleLogger('core/shortcodes');

// Registered shortcodes. Core tags (owner null) are one table shared by every site. A plugin's or theme's
// tags are recorded per SITE: in a multisite network each site runs its own worker of a plugin, and a tag
// registered by site A's worker must never render on site B, where the plugin may not even be active. On
// a single site the only plugin table is site 1's, so behaviour is what it always was.
//
// Ownership: a tag belongs to a plugin slug, or to core (null). Without ownership registration is
// last-writer-wins — an untrusted plugin could re-register a core tag (or another plugin's) and silently
// replace its rendered output on every page that uses it (stored defacement / content-integrity attack).
// We refuse cross-owner overwrites.
type PluginShortcode = { callback: (...args: any[]) => any; owner: string };
const coreShortcodes = new Map<string, (...args: any[]) => any>();
const siteShortcodes = new Map<number, Map<string, PluginShortcode>>();

const siteContext = require('./site-context');
/** The plugin tag table of the current site (site 1 outside any context, as the boot is). */
function pluginTable(create: boolean): Map<string, PluginShortcode> | undefined {
    const siteId = siteContext.currentSiteIdOrNull() ?? siteContext.PRIMARY_SITE_ID;
    let t = siteShortcodes.get(siteId);
    if (!t && create) { t = new Map(); siteShortcodes.set(siteId, t); }
    return t;
}

/** The handler and owner of `tag` on the current site: core first, then this site's plugins. */
function lookup(tag: string): { callback: (...args: any[]) => any; owner: string | null } | undefined {
    const core = coreShortcodes.get(tag);
    if (core) return { callback: core, owner: null };
    const entry = pluginTable(false)?.get(tag);
    return entry ? { callback: entry.callback, owner: entry.owner } : undefined;
}

/** Every tag registered for the current site, core tags first (registration order decides prefix matches). */
function tagsHere(): string[] {
    const tags = Array.from(coreShortcodes.keys());
    const site = pluginTable(false);
    if (site) for (const t of site.keys()) if (!coreShortcodes.has(t)) tags.push(t);
    return tags;
}

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
    if (owner === null) {
        coreShortcodes.set(tag, callback);
        return;
    }
    const existing = lookup(tag);
    if (existing && existing.owner !== owner) {
        log.warn(`[Security Block] Plugin '${owner}' tried to override shortcode '[${tag}]' owned by '${existing.owner ?? 'core'}' — refused.`);
        return;
    }
    // A plugin's handler always runs in that plugin's context (its sandbox), even when the shortcode
    // is expanded from host code — mirrors how plugin-registered hooks are wrapped (hooks.ts).
    const stored = function (this: any, ...a: any[]) { const { runWithContext } = require('./plugin-context'); return runWithContext(owner, () => (callback as any).apply(this, a)); };
    pluginTable(true)!.set(tag, { callback: stored, owner });
}

/**
 * Remove a shortcode
 * Equivalent to remove_shortcode()
 */
function removeShortcode(tag: string) {
    const owner = currentOwner();
    const existing = lookup(tag);
    if (owner !== null && existing && existing.owner !== owner) {
        log.warn(`[Security Block] Plugin '${owner}' tried to remove shortcode '[${tag}]' owned by '${existing.owner ?? 'core'}' — refused.`);
        return;
    }
    if (owner === null) coreShortcodes.delete(tag);
    pluginTable(false)?.delete(tag);
}

/**
 * Check if shortcode exists
 * Equivalent to shortcode_exists()
 */
function shortcodeExists(tag: string) {
    return !!lookup(tag);
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
    if (!content) return matches;
    const tagPattern = tagsHere().map(escapeRegex).join('|');
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
/** The handler for `tag` on the current site (another site's plugin tags are not registered here). */
function runnableShortcode(tag: string): ((...args: any[]) => any) | undefined {
    return lookup(tag)?.callback;
}

function doShortcode(content: string) {
    if (!content || tagsHere().length === 0) return content;

    // Match [tag attrs]content[/tag] or [tag attrs /] or [tag attrs] (see scanShortcodes)
    const matches = scanShortcodes(content);
    if (matches.length === 0) return content;

    const replacements = matches.map((mm) => {
        const callback = runnableShortcode(mm.tag);
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
async function doShortcodeAsync(content: string, context: { postId?: number } = {}) {
    if (!content || tagsHere().length === 0) return content;

    // Collect matches first, then resolve callbacks concurrently, then splice them back in one pass.
    // String.replace can't await, hence this approach.
    const matches = scanShortcodes(content);
    if (matches.length === 0) return content;

    const replacements = await Promise.all(matches.map(async (mm) => {
        const full = content.slice(mm.index, mm.end);
        const callback = runnableShortcode(mm.tag);
        if (!callback) return full;
        const parsedAttrs = parseAttrs((mm.attrs || '').trim());
        try {
            // The core [gallery] (not one a plugin registered in its place) renders its images here.
            const out = callback === coreGallerySync
                ? await renderGallery(parsedAttrs, context)
                : await callback(parsedAttrs, mm.inner || '', mm.tag, context);
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
    if (!content || tagsHere().length === 0) return content;

    // Same linear scanner as doShortcode (this runs on every excerpt, i.e. every Post.toJSON).
    const matches = scanShortcodes(content);
    if (matches.length === 0) return content;
    return spliceMatches(content, matches, matches.map(() => ''));
}

// Register default shortcodes

// [gallery ids="1,2,3"] — the synchronous form keeps its placeholder <div> (its output is pinned for
// every sync caller); the rendered gallery is the ASYNC form below, which is what the public body uses.
const coreGallerySync = (attrs: any) => {
    const ids = attrs.ids ? attrs.ids.split(',') : [];
    const columns = Number(attrs.columns) || 3;
    const size = attrs.size || 'thumbnail';

    return `<div class="gallery gallery-columns-${columns}" data-ids="${escAttr(ids.join(','))}" data-size="${escAttr(size)}"></div>`;
};
addShortcode('gallery', coreGallerySync);

// [gallery ids="1,2,3" columns="3"] — or bare [gallery]: the images attached to the post, as WordPress
// does. It rendered an empty <div> before, so every gallery a WordPress import carried showed nothing.
// Only PUBLIC image attachments are listed (a private upload's URL never reaches a public page), at most
// 100, in the order given (ids) or the attachments' menu order.
async function renderGallery(attrs: any, context: any): Promise<string> {
    const columns = Math.min(9, Math.max(1, Number(attrs.columns) || 3));
    const size = String(attrs.size || 'thumbnail');
    const { dbAsync } = require('../config/database');
    const { PUBLIC_ATTACHMENT_STATUS } = require('./private-media');
    const listed = String(attrs.ids || attrs.include || '').split(',').map((s: string) => parseInt(s, 10)).filter((n: number) => Number.isSafeInteger(n) && n > 0).slice(0, 100);
    let rows: any[] = [];
    if (listed.length) {
        const found = await dbAsync.all(
            `SELECT id, guid, post_title, post_excerpt FROM posts WHERE post_type = 'attachment' AND post_status = ? AND post_mime_type LIKE 'image/%' AND id IN (${listed.map(() => '?').join(',')})`,
            [PUBLIC_ATTACHMENT_STATUS, ...listed]
        );
        const byId = new Map(found.map((r: any) => [Number(r.id), r]));
        rows = listed.map((id: number) => byId.get(id)).filter(Boolean);
    } else if (context && Number.isSafeInteger(context.postId)) {
        rows = await dbAsync.all(
            `SELECT id, guid, post_title, post_excerpt FROM posts WHERE post_type = 'attachment' AND post_status = ? AND post_mime_type LIKE 'image/%' AND post_parent = ? ORDER BY menu_order, id LIMIT 100`,
            [PUBLIC_ATTACHMENT_STATUS, context.postId]
        );
    }
    if (!rows.length) return '';
    const Media = require('../models/Media');
    const items: string[] = [];
    for (const row of rows) {
        let src = String(row.guid || '');
        try { const m = await Media.findById(Number(row.id)); if (m && m.sourceUrl) src = m.sourceUrl; } catch { /* keep the guid */ }
        if (!/^(\/uploads\/|https?:\/\/)/.test(src)) continue;
        const caption = String(row.post_excerpt || '').trim();
        items.push(`<figure class="gallery-item"><img src="${escAttr(src)}" alt="${escAttr(row.post_title || '')}" loading="lazy" style="width:100%;height:auto;display:block" />${caption ? `<figcaption class="gallery-caption">${escAttr(caption)}</figcaption>` : ''}</figure>`);
    }
    if (!items.length) return '';
    return `<div class="gallery gallery-columns-${columns} gallery-size-${escAttr(size)}" style="display:grid;grid-template-columns:repeat(${columns},minmax(0,1fr));gap:0.75rem">${items.join('')}</div>`;
}

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
