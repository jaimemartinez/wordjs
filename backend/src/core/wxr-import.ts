/**
 * WordJS — WordPress WXR importer.
 *
 * Parses a WordPress eXtended RSS (WXR) export file and maps WordPress entities onto WordJS models:
 *   wp:author   -> users
 *   wp:category -> terms (taxonomy "category")   [parents resolved in a second pass]
 *   wp:tag      -> terms (taxonomy "post_tag")
 *   wp:term     -> terms (custom taxonomies, best-effort) and MENUS when the taxonomy is nav_menu
 *   item        -> posts / pages (+ post meta, terms, comments)
 *   attachment  -> media library entries, with the file DOWNLOADED (see core/wxr-media.ts)
 *   nav_menu_item -> menu items on the imported menus (see core/wxr-menus.ts)
 *
 * Design notes:
 * - IDEMPOTENT / RE-RUNNABLE. Existing users (by login/email), terms (by slug+taxonomy), posts
 *   (by slug+type), attachments (by SOURCE URL, then slug) and menu items (by their WXR item id) are
 *   reused/skipped, so a re-run does not duplicate content — and, for media, does not re-download a
 *   single byte. We deliberately do NOT wrap the whole import in one DB transaction: it spans thousands
 *   of statements, and a bulk import is far more robust as an incremental, resumable operation than an
 *   all-or-nothing one (this also sidesteps the pg-pool BEGIN/COMMIT footgun). Per-item failures are
 *   collected, not fatal — a media file whose download 404s is one line in the summary, not an abort.
 * - Original publish dates are preserved (Post.create stamps "now", so we backfill the real dates).
 * - MEDIA IS NO LONGER A FUTURE ENHANCEMENT. A WXR carries the URLs, not the binaries, so the importer
 *   fetches them — under the same egress/SSRF discipline core/webhooks.ts and routes/marketplace.ts
 *   use, with per-file and per-run size caps. The `media` option chooses download / link / skip.
 * - MENUS ARE IMPORTED, but never through the item loop: `nav_menu_item` is an INTERNAL post type and
 *   the refusal below stays exactly as strict as it was (that guard is what stops a crafted WXR
 *   fabricating `revision` rows). Menu items are collected here and written by core/wxr-menus.ts
 *   through models/Menu's own MenuItem.create().
 */

// fast-xml-parser v5 is a drop-in here: the CommonJS entry (`require`) still exports { XMLParser },
// and every option below (ignoreAttributes / attributeNamePrefix / parseTagValue /
// parseAttributeValue / trimValues / processEntities) is unchanged from v4 and produces byte-identical
// parse output for WXR — CDATA merging, attribute prefixing and entity decoding all match v4. This is
// pinned by src/tests/wxr-import.test.ts against a representative export fixture.
const { XMLParser } = require('fast-xml-parser');
const Post = require('../models/Post');
const User = require('../models/User');
const Term = require('../models/Term');
const Comment = require('../models/Comment');
const { dbAsync } = require('../config/database');
const { runContentMutation, recordContentEvent } = require('./content-outbox');
const { sanitizeMetaValue } = require('./sanitize-meta');
// ONE list of server-owned meta keys for every writer — the importer used to keep a two-key subset of
// its own (see the postmeta loop below for what that cost). metaKeyProblem is the FORM rule (type,
// emptiness, the prototype-manipulating names, the column's length bound) the routes apply too.
const { isProtectedPostMeta, metaKeyProblem } = require('./protected-meta');
// The attachment half. safeAttachedFile / safeAttachmentMetadata live there because that module is
// where a stored attachment path actually becomes a path; ATTACHMENT_OWNED_META below is the SAME
// validation applied one door earlier, to the postmeta the WXR names.
const {
    safeAttachedFile,
    safeAttachmentMetadata,
    collectUploadBases,
    rewriteUploadUrls,
    createMediaImporter,
} = require('./wxr-media');
const { importMenus } = require('./wxr-menus');

/**
 * Is this post type INTERNAL — registered, but marked `showInRest: false` (nav_menu_item, revision)?
 *
 * Deliberately NOT `!isRestExposedPostType(type)`: that also answers true for an UNREGISTERED type,
 * and a WXR full of a custom type this install has never heard of is the normal case for a migration.
 * Same distinction routes/posts.ts makes for existing content — the two must agree, and the shared
 * home for this predicate is core/post-capabilities (see the handoff note).
 */
const ALWAYS_INTERNAL_POST_TYPES: Set<string> = new Set(['nav_menu_item', 'revision']);

function isInternalPostType(type: unknown): boolean {
    const name = String(type || 'post');
    // Fail closed on the core internals whatever the registry says: initPostTypes() registers those two
    // ASYNCHRONOUSLY, and a CLI import can run before (or without) it. Same floor as routes/posts.ts.
    if (ALWAYS_INTERNAL_POST_TYPES.has(name)) return true;
    const { getPostType } = require('./post-types');
    const pt = getPostType(name);
    return !!(pt && pt.showInRest === false);
}

/**
 * Sanitize an imported postmeta value through the SAME sanitizer the posts routes use, so a crafted
 * WXR file can't smuggle stored XSS via _puck_data (a Puck block with a javascript: URL / unescaped
 * HTML field). WXR carries meta values as STRINGS; _puck_data is a serialized JSON object, so we parse
 * it, run sanitizeMetaValue over the structured tree, then re-stringify for storage. If it isn't valid
 * JSON (or sanitizing yields nothing usable), fall back to the raw string so import stays non-fatal and
 * non-_puck_data meta is preserved verbatim (sanitizeMetaValue is a no-op for other keys anyway).
 */
/* ── ATTACHMENT META: A CORE-OWNED WRITE, NOT A REQUEST ───────────────────────────────────────────
 *
 * THE REGRESSION THIS BLOCK UNDOES. Swapping the importer's local `{_edit_lock, _edit_last}` skip-list
 * for `isProtectedPostMeta()` also banned `_wp_attached_file` — and the importer CREATES attachment
 * rows without downloading anything, so that key is the ONLY record of where the file lives. Every
 * WordPress migration since then reported `attachments: {created: N}` and produced N media items whose
 * sourceUrl is `/uploads/` and whose `mediaDetails.file` is empty: the documented migration (copy
 * wp-content/uploads, import the WXR) silently lost every image, with the summary saying it worked.
 *
 * THE DISTINCTION THAT WAS MISSING, and the one to keep. "Protected" describes the SURFACE, not the
 * bytes: it means "an untrusted CALLER may not name this key on a route". Media.create() writes
 * `_wp_attached_file` on every upload; an importer is core code doing the same job. What the importer
 * owes is not abstinence from the key but validation of the VALUE — because the value here does come
 * from a third party's XML, and Media.delete() turns it into an unlink() target.
 *
 * So the value is checked as a SHAPE, with the SAME predicate the sink uses (core/safe-path's
 * isPlainSegment, which Media._deletableFiles applies segment by segment): a relative path of plain
 * segments, no `..`, no separator tricks, no drive letter, no NTFS stream, no NUL. A value that does
 * not resolve is DROPPED — never stored, never repaired — so the row simply has no path, exactly as it
 * did while the key was banned outright. Everything that passes would have resolved inside uploads/
 * anyway, which is precisely the set a migration needs.
 */

/**
 * The protected keys the importer MAY write, and how each one's value is validated.
 * Anything not listed here keeps the untrusted-request policy (isProtectedPostMeta refuses it).
 */
const ATTACHMENT_OWNED_META: Record<string, (raw: string) => string | null> = {
    _wp_attached_file: safeAttachedFile,
    _wp_attachment_metadata: safeAttachmentMetadata,
};

/** Shared empty set for the meta copier's "nothing is already owned by core" case. */
const EMPTY_SKIP_KEYS: Set<string> = new Set();

/** How deep the `_puck_data` walk goes before it stops rewriting (a block tree is nowhere near this). */
const MAX_PUCK_REWRITE_DEPTH = 64;

/**
 * ONE reference to this install's uploads, as `<boundary><path>` — the unit the rename map is applied
 * to (see `rewrite` in importWxr, which explains why a substring swap is not good enough).
 *
 * Group 1 is the character in front of the marker, captured rather than looked behind so it is put back
 * verbatim; `^` covers a string that IS the reference, which is how a `_puck_data` `src` leaf arrives.
 * It must be a character no path can contain, so `.../wp-content/uploads/...` on a host we did not
 * rewrite is not mistaken for ours. Group 2 is the MAXIMAL run of characters a stored path can spell
 * inside a URL; every other byte — a quote, `?`, `#`, `&`, whitespace, `<` — ends the reference, and
 * anything a plain segment can hold but a URL cannot is percent-encoded before it gets here.
 */
const UPLOAD_REFERENCE = /(^|[^A-Za-z0-9._~%+-])\/uploads\/([A-Za-z0-9._~%+/-]+)/g;

/**
 * Apply `rewrite` to every STRING LEAF of a parsed block tree.
 *
 * WHY `_puck_data` NEEDS IT AT ALL. The upload-URL rewrite ran on `content` and `excerpt` only, and post
 * meta went through `applyPostMeta` untouched — but a Verso/Puck page's image `src` values live in
 * `_puck_data`, not in the body. A migrated site therefore came out half-rewritten: classic bodies
 * local, builder pages still hotlinking the old domain and silently breaking the day it goes away.
 *
 * Objects are rebuilt with defineProperty rather than `out[k] = v`, for the same reason
 * core/protected-meta's RESERVED_META_KEYS exists: `JSON.parse('{"__proto__":{…}}')` produces an OWN
 * property that a plain assignment would turn back into a prototype swap.
 */
function rewriteStringLeaves(node: any, rewrite: (s: string) => string, depth = 0): any {
    if (typeof node === 'string') return rewrite(node);
    if (depth >= MAX_PUCK_REWRITE_DEPTH) return node;
    if (Array.isArray(node)) return node.map((child) => rewriteStringLeaves(child, rewrite, depth + 1));
    if (node && typeof node === 'object') {
        const out: Record<string, any> = {};
        for (const [key, value] of Object.entries(node)) {
            Object.defineProperty(out, key, {
                value: rewriteStringLeaves(value, rewrite, depth + 1),
                enumerable: true, writable: true, configurable: true,
            });
        }
        return out;
    }
    return node;
}

function sanitizeImportedMeta(key: string, rawValue: string, rewrite: (s: string) => string): string {
    if (key !== '_puck_data') return rawValue;
    let parsed: any;
    try { parsed = JSON.parse(rawValue); } catch { return rawValue; }
    if (!parsed || typeof parsed !== 'object') return rawValue;
    const sanitized = rewriteStringLeaves(sanitizeMetaValue(key, parsed), rewrite);
    try { return JSON.stringify(sanitized); } catch { return rawValue; }
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,        // keep everything as strings; we parse ints explicitly
    parseAttributeValue: false,
    trimValues: true,
    // SECURITY: processEntities: false disables recursive entity expansion (Billion Laughs DoS). WXR
    // only uses the standard HTML entities (&amp; &lt; &gt; &quot; &apos;) which htmlEntities covers
    // without allowing user-defined DTD entities. fast-xml-parser is JS-pure so external entities are
    // inherently inert, but fail-closed on internal expansion is defense in depth.
    processEntities: false,
    htmlEntities: true,
    // CDATA is merged into the element's text value (default) — exactly what we want for
    // content:encoded / titles.
});

/** Normalise a possibly-undefined / single / array node into an array. */
function toArray<T = any>(x: any): T[] {
    if (x === undefined || x === null) return [];
    return Array.isArray(x) ? x : [x];
}

/** Read the text value of a node that may be a bare string or an object with attributes (#text). */
function text(node: any): string {
    if (node === undefined || node === null) return '';
    if (typeof node === 'object') {
        if ('#text' in node) return node['#text'] == null ? '' : String(node['#text']);
        return '';
    }
    return String(node);
}

function attr(node: any, name: string): string {
    if (node && typeof node === 'object' && ('@_' + name) in node) return String(node['@_' + name]);
    return '';
}

/** One `wp:postmeta` value of an item by key, or ''. */
function metaValueOf(item: any, key: string): string {
    for (const pm of toArray(item['wp:postmeta'])) {
        if (text(pm['wp:meta_key']).trim() === key) return text(pm['wp:meta_value']);
    }
    return '';
}

const isPlaceholderDate = (d: string) => !d || d.startsWith('0000-00-00');

/**
 * Light wpautop: WordPress classic-editor content is stored as plain text with blank-line paragraph
 * breaks and relies on render-time wpautop. Gutenberg exports already contain block HTML. Only apply
 * paragraph wrapping when the content looks like classic plain text (no block comments, no block tags).
 */
function maybeAutop(content: string): string {
    if (!content) return '';
    const looksLikeHtml = /<!--\s*wp:|<\/(p|div|section|article|ul|ol|h[1-6]|figure|blockquote)>/i.test(content);
    if (looksLikeHtml) return content;
    const blocks = content.replace(/\r\n/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    if (blocks.length === 0) return content;
    return blocks.map((b) => `<p>${b.replace(/\n/g, '<br />')}</p>`).join('\n');
}

function mapCommentApproved(raw: string): string | null {
    const v = (raw || '').toLowerCase();
    if (v === '1' || v === 'approve' || v === 'approved') return '1';
    if (v === '0' || v === 'hold' || v === 'unapproved' || v === '') return '0';
    if (v === 'spam') return 'spam';
    return null; // trash / post-trashed / unknown -> skip
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

interface WxrParsed {
    wxrVersion: string;
    site: { title: string; link: string; description: string; baseUrl: string };
    authors: any[];
    categories: any[];
    tags: any[];
    terms: any[];
    items: any[];
    /**
     * `<wp:option>` name/value pairs. WXR 1.2 has NO options section, so this is empty for every export
     * WordPress produces on its own; it is read because the one thing the importer would want from it —
     * `nav_menu_locations` — is exactly what a widened export or a migration plugin adds here.
     */
    options: any[];
}

function parseWxr(xml: string): WxrParsed {
    const doc = parser.parse(xml);
    const channel = doc?.rss?.channel;
    if (!channel) {
        throw new Error('Not a valid WordPress WXR file (missing <rss><channel>).');
    }
    return {
        wxrVersion: text(channel['wp:wxr_version']) || 'unknown',
        site: {
            title: text(channel.title),
            link: text(channel.link),
            description: text(channel.description),
            baseUrl: text(channel['wp:base_site_url']) || text(channel['wp:base_blog_url']),
        },
        authors: toArray(channel['wp:author']),
        categories: toArray(channel['wp:category']),
        tags: toArray(channel['wp:tag']),
        terms: toArray(channel['wp:term']),
        items: toArray(channel.item),
        options: toArray(channel['wp:option']),
    };
}

/**
 * The theme-location -> menu mapping the export carried, or null when there is none we can read.
 *
 * WordPress stores this option PHP-serialized, which we deliberately do not parse: a hand-rolled PHP
 * deserializer over third-party bytes is a liability, and guessing is worse than saying "unassigned".
 * A JSON value — what a widened export or WordJS's own tooling would write — is read. Values may be
 * either the menu's WXR `wp:term_id` (how WordPress stores it) or its slug; wxr-menus resolves both.
 */
function readNavMenuLocations(options: any[]): Record<string, string> | null {
    for (const opt of options) {
        if (text(opt['wp:option_name']).trim() !== 'nav_menu_locations') continue;
        const raw = text(opt['wp:option_value']).trim();
        if (!raw) continue;
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { return null; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const out: Record<string, string> = {};
        for (const [location, ref] of Object.entries(parsed)) {
            if (typeof location === 'string' && location && (typeof ref === 'string' || typeof ref === 'number')) {
                out[location] = String(ref);
            }
        }
        return Object.keys(out).length ? out : null;
    }
    return null;
}

/** Dry-run: parse and count entities without writing anything. */
function analyzeWxr(xml: string) {
    const p = parseWxr(xml);
    let posts = 0, pages = 0, attachments = 0, navItems = 0, other = 0, comments = 0;
    for (const item of p.items) {
        const type = text(item['wp:post_type']) || 'post';
        comments += toArray(item['wp:comment']).length;
        if (type === 'post') posts++;
        else if (type === 'page') pages++;
        else if (type === 'attachment') attachments++;
        else if (type === 'nav_menu_item') navItems++;
        else other++;
    }
    return {
        wxrVersion: p.wxrVersion,
        site: p.site,
        counts: {
            authors: p.authors.length,
            categories: p.categories.length,
            tags: p.tags.length,
            customTerms: p.terms.length,
            posts, pages, attachments, navItems, other, comments,
        },
    };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

interface ImportOptions {
    /** Fallback author id for items whose WP author isn't (or can't be) imported. */
    defaultAuthorId: number;
    importComments?: boolean;
    /**
     * What to do with `attachment` items:
     *   'download' (DEFAULT) — fetch the file from `wp:attachment_url` and store it in the media library;
     *   'link'               — create the record but keep the REMOTE url, fetching nothing;
     *   'skip'               — do not bring attachments over at all.
     */
    media?: 'download' | 'skip' | 'link';
    /**
     * LEGACY, kept because routes/import.ts still sends it. An explicit `false` means "no attachments"
     * and maps to `media: 'skip'`; `media` wins whenever it is given.
     */
    importAttachments?: boolean;
    /** Allow `http://` attachment sources. OFF by default — a migration source that is not https is a downgrade. */
    allowHttp?: boolean;
    /** Per-file download ceiling in bytes (default 50 MB). */
    maxFileBytes?: number;
    /** Whole-run download ceiling in bytes (default 1 GB). */
    maxTotalBytes?: number;
    /** Per-file download timeout in ms (default 30 s). */
    timeoutMs?: number;
    /**
     * Rewrite `…/wp-content/uploads/…` URLs in post bodies to this install's `/uploads/…`.
     * Defaults to true in `download` mode (we know the files are there) and false otherwise.
     */
    rewriteUrls?: boolean;
}

interface ImportSummary {
    site: { title: string; link: string };
    authors: { created: number; matched: number };
    terms: { categories: number; tags: number; custom: number };
    posts: { created: number; skipped: number };
    pages: { created: number; skipped: number };
    attachments: { created: number; skipped: number };
    comments: { created: number; skipped: number };
    /** Nav items NOT imported (no menu to attach them to, already present, or a per-item failure). */
    navItems: { skipped: number };
    /** The media pass: what was fetched, what was not, and exactly why not, per file. */
    media: {
        mode: string;
        downloaded: number;
        linked: number;
        skipped: number;
        failed: number;
        /** Bytes that landed in the media library. */
        bytes: number;
        /** Bytes pulled off the network, refused and failed items included — what `maxTotalBytes` bounds. */
        fetchedBytes: number;
        failures: { url: string; reason: string }[];
    };
    /** The menu pass: menus, their items, and whether any theme location could be assigned. */
    menus: {
        created: number;
        matched: number;
        items: { created: number; skipped: number };
        locations: { assigned: number; unassigned: number; reason: string | null };
    };
    errors: string[];
}

async function importWxr(xml: string, options: ImportOptions): Promise<ImportSummary> {
    const parsed = parseWxr(xml);
    const defaultAuthorId = options.defaultAuthorId;
    const importComments = options.importComments !== false;

    const media = createMediaImporter(options);
    const attachmentItems = parsed.items.filter((i: any) => (text(i['wp:post_type']) || 'post') === 'attachment');
    // Rewriting is ON exactly when we know where the files ended up. In `link` mode the whole point is
    // that the bodies keep pointing at the old site; in `skip` mode nothing was placed under /uploads,
    // so an operator who copies wp-content/uploads by hand opts in explicitly.
    const rewriteUrls = options.rewriteUrls === undefined ? media.mode === 'download' : options.rewriteUrls === true;
    const uploadBases = rewriteUrls
        ? collectUploadBases(
            attachmentItems.map((i: any) => text(i['wp:attachment_url']).trim()).filter(Boolean),
            parsed.site.baseUrl,
        )
        : [];
    /**
     * The base swap, PLUS the handful of files whose stored path is not the one their URL named.
     *
     * The second step is normally a no-op: a placement only moves when the path the WXR asked for was
     * already taken (see MediaImporter.claimRelativePath). When it does move, the swap alone would leave
     * every `<img src>` pointing at the file that was already there — the wrong image behind a live URL —
     * so the rename is applied on top of the `/uploads/<path>` the first step just produced.
     *
     * ONE PASS, NEVER N — the map's values live in the SAME namespace as its keys. Applying it as a
     * sequence of substring swaps fed each swap's output into the next, and claimRelativePath mints an
     * alternative by the very rule that names the file beside it: with `2025/01/photo.jpg` already on
     * this install, a WXR carrying both `photo.jpg` and the `photo-1.jpg` WordPress itself minted next to
     * it plans `photo.jpg -> photo-1.jpg` AND `photo-1.jpg -> photo-1-1.jpg`, so the first swap's output
     * was re-swapped by the second and every reference to the FIRST attachment came out on the SECOND
     * one's bytes. Not a 404 an operator would notice — the wrong image, permanently, on a live page.
     * So the string is scanned ONCE and each `/uploads/<path>` reference is resolved against the map,
     * which makes a rewritten span final by construction, whatever order the map was built in.
     *
     * A REFERENCE, NOT A SUBSTRING. The match is bounded on both sides, because `photo.jpg` occurs
     * inside plenty of things that are not it. On the right, the run of path characters after
     * `/uploads/` must equal a key exactly, so `/uploads/2025/01/photo.jpg.bak` and the
     * `photo-1024x768.jpg` derivative are left alone; because that run is MAXIMAL, "equal to a key" is
     * the longest match by construction and no key can win over a longer one. On the left, the marker
     * must not itself be the tail of a longer path, so a body still hotlinking
     * `https://other.example/wp-content/uploads/2025/01/photo.jpg` — a host the base swap did not own,
     * and whose files this install did not move — keeps pointing where it pointed.
     */
    const renames = media.pathRenames();
    const rewrite = (body: string) => {
        if (!body) return body;
        const out = uploadBases.length ? rewriteUploadUrls(body, uploadBases) : body;
        // The MAP is captured, never its contents: planPlacements() fills this very Map, and it has not
        // run yet when this closure is made — a WXR lists a post before the attachment it embeds.
        if (renames.size === 0) return out;
        return out.replace(UPLOAD_REFERENCE, (match: string, before: string, target: string) => {
            const moved = renames.get(target);
            return moved === undefined ? match : `${before}/uploads/${moved}`;
        });
    };

    const summary: ImportSummary = {
        site: { title: parsed.site.title, link: parsed.site.link },
        authors: { created: 0, matched: 0 },
        terms: { categories: 0, tags: 0, custom: 0 },
        posts: { created: 0, skipped: 0 },
        pages: { created: 0, skipped: 0 },
        attachments: { created: 0, skipped: 0 },
        comments: { created: 0, skipped: 0 },
        navItems: { skipped: 0 },
        media: media.stats,
        menus: {
            created: 0, matched: 0,
            items: { created: 0, skipped: 0 },
            locations: { assigned: 0, unassigned: 0, reason: null },
        },
        errors: [],
    };
    const pushError = (msg: string) => { if (summary.errors.length < 100) summary.errors.push(msg); };
    await media.prepare(dbAsync);
    // WHERE each file will go, decided before the first body is written. A WXR routinely lists a post
    // BEFORE the attachment it embeds, so a placement that had to move a file has to be known now — by
    // the time the attachment is imported, the bodies referencing it are already in the database.
    media.planPlacements(attachmentItems.map((i: any) => ({
        attachmentUrl: text(i['wp:attachment_url']).trim(),
        attachedFile: metaValueOf(i, '_wp_attached_file'),
        mimeType: text(i['wp:post_mime_type']),
    })));

    // --- Pass A: authors -> users (map by WP login) ---------------------------------------------
    const authorByLogin = new Map<string, number>();
    for (const a of parsed.authors) {
        const login = text(a['wp:author_login']).trim();
        if (!login) continue;
        try {
            const email = text(a['wp:author_email']).trim() || `${login}@imported.local`;
            const display = text(a['wp:author_display_name']).trim() || login;
            let user = await User.findByLogin(login);
            if (!user) user = await User.findByEmail(email);
            if (user) {
                authorByLogin.set(login, user.id);
                summary.authors.matched++;
            } else {
                const created = await User.create({
                    username: login,
                    email,
                    // WP never exports password hashes; imported users must reset to log in.
                    password: require('crypto').randomBytes(24).toString('hex'),
                    displayName: display,
                    role: 'author',
                });
                authorByLogin.set(login, created.id);
                summary.authors.created++;
            }
        } catch (e: any) {
            pushError(`author "${login}": ${e.message}`);
        }
    }

    // --- Pass B: categories + tags + custom terms ----------------------------------------------
    // category parent in WXR is the parent category's *nicename* (slug), resolved in a 2nd pass.
    //
    // WP term_id -> new term_id. Terms are MATCHED by slug (that is the dedupe key), but a menu item
    // references its taxonomy target by ID — so the id map has to be built here, while both halves are
    // in hand, or `_menu_item_object_id` is unresolvable later.
    const termIdMap = new Map<string, number>();
    const noteTermId = (wpId: string, newId: number) => { if (wpId) termIdMap.set(wpId, newId); };
    /** `wp:term` entries whose taxonomy is nav_menu — menus, handled by the menu pass, not as terms. */
    const menuTerms: { slug: string; name: string; description: string; sourceId: string }[] = [];
    const catBySlug = new Map<string, number>();
    const catParentSlug = new Map<string, string>(); // childSlug -> parentSlug
    for (const c of parsed.categories) {
        const slug = text(c['wp:category_nicename']).trim();
        const name = text(c['wp:cat_name']).trim() || slug;
        if (!slug) continue;
        try {
            const id = await ensureTerm(slug, name, 'category', text(c['wp:category_description']));
            catBySlug.set(slug, id);
            noteTermId(text(c['wp:term_id']).trim(), id);
            summary.terms.categories++;
            const parent = text(c['wp:category_parent']).trim();
            if (parent) catParentSlug.set(slug, parent);
        } catch (e: any) { pushError(`category "${slug}": ${e.message}`); }
    }
    // Resolve category hierarchy now that all category term_ids exist.
    for (const [childSlug, parentSlug] of catParentSlug) {
        const childId = catBySlug.get(childSlug);
        const parentId = catBySlug.get(parentSlug);
        if (childId && parentId) {
            try {
                await dbAsync.run(
                    `UPDATE term_taxonomy SET parent = ? WHERE term_id = ? AND taxonomy = 'category'`,
                    [parentId, childId]
                );
            } catch { /* non-fatal */ }
        }
    }

    const tagBySlug = new Map<string, number>();
    for (const t of parsed.tags) {
        const slug = text(t['wp:tag_slug']).trim();
        const name = text(t['wp:tag_name']).trim() || slug;
        if (!slug) continue;
        try {
            const id = await ensureTerm(slug, name, 'post_tag', text(t['wp:tag_description']));
            tagBySlug.set(slug, id);
            noteTermId(text(t['wp:term_id']).trim(), id);
            summary.terms.tags++;
        } catch (e: any) { pushError(`tag "${slug}": ${e.message}`); }
    }

    // Custom taxonomy terms (best-effort).
    const customByTaxSlug = new Map<string, number>();
    for (const tm of parsed.terms) {
        const taxonomy = text(tm['wp:term_taxonomy']).trim();
        const slug = text(tm['wp:term_slug']).trim();
        const name = text(tm['wp:term_name']).trim() || slug;
        if (!taxonomy || !slug) continue;
        if (taxonomy === 'category' || taxonomy === 'post_tag') continue; // handled above
        // nav_menu is a taxonomy too, but a nav_menu TERM is a MENU — models/Menu owns creating it, and
        // it is counted as a menu rather than as one more custom term. Creating it here as well would
        // be harmless (same term, same dedupe) but would double-count it in two places in the summary.
        if (taxonomy === 'nav_menu') {
            menuTerms.push({
                slug, name,
                description: text(tm['wp:term_description']),
                sourceId: text(tm['wp:term_id']).trim(),
            });
            continue;
        }
        try {
            const id = await ensureTerm(slug, name, taxonomy, text(tm['wp:term_description']));
            customByTaxSlug.set(`${taxonomy}:${slug}`, id);
            noteTermId(text(tm['wp:term_id']).trim(), id);
            summary.terms.custom++;
        } catch (e: any) { pushError(`term "${taxonomy}:${slug}": ${e.message}`); }
    }

    // --- Pass C: items -> posts/pages -----------------------------------------------------------
    const oldToNewPost = new Map<string, number>();   // wp:post_id -> new post id
    const deferredParent = new Map<number, string>(); // new post id -> wp parent id (resolved later)
    const oldToNewComment = new Map<string, number>(); // wp comment_id -> new comment id
    const deferredCommentParent = new Map<number, string>(); // new comment id -> wp parent comment id
    /** `nav_menu_item` items, collected here and written by the menu pass (never by this loop). */
    const menuItems: any[] = [];

    /** Backfill the original publish/modified dates (Post.create and Media.create both stamp "now"). */
    const restoreDates = async (item: any, newId: number) => {
        const pDate = text(item['wp:post_date']);
        const pDateGmt = text(item['wp:post_date_gmt']);
        if (isPlaceholderDate(pDate)) return;
        const gmt = isPlaceholderDate(pDateGmt) ? pDate : pDateGmt;
        await dbAsync.run(
            `UPDATE posts SET post_date = ?, post_date_gmt = ?, post_modified = ?, post_modified_gmt = ? WHERE id = ?`,
            [pDate, gmt, pDate, gmt, newId]
        );
    };

    /**
     * Copy an item's `wp:postmeta` onto the new row.
     *
     * Post meta: refuse the SERVER-OWNED keys, keep everything else for fidelity.
     *
     * The local SKIP_META set here was `{_edit_lock, _edit_last}` — a strict SUBSET of
     * core/protected-meta, and the two never learned about each other. So the importer wrote
     * `_wp_attached_file`, `_wp_attachment_metadata` and `_wp_trash_meta_status` verbatim from a third
     * party's XML, while the module that owns that list states that no generic path can. It matters most
     * for `_wp_attached_file`, because Media.delete() turns that value into an unlink target
     * (core/safe-path contains it — but the source is supposed to be closed too). One list, consulted by
     * every writer.
     *
     * WITH ONE EXPLICIT EXCEPTION, restored after that list cost every migration its media: an
     * ATTACHMENT's own path keys are a CORE-OWNED write, validated by SHAPE instead of refused by NAME.
     * See ATTACHMENT_OWNED_META for the full reasoning.
     *
     * `skipKeys` is the third state that download mode needs: when core/wxr-media actually PLACED the
     * bytes, Media.create()'s `_wp_attached_file` is the truth about where they are, and letting the
     * WXR's own value overwrite it would point the row at a file that is not there.
     *
     * THE IMPORTER'S OWN KEYS ARE REFUSED HERE TOO, and by the same list. `_wxr_source_url`,
     * `_wxr_menu_item_id` and `_wxr_remote_url` are now in PROTECTED_POST_META, so the
     * `isProtectedPostMeta` branch below drops them wherever they appear — which is the point: they are
     * the keys the NEXT run indexes to decide what it has already imported, so a WXR that plants one on
     * an ordinary post could make the importer skip a real attachment and point its id map at that post.
     * Core still writes them directly (Post.updateMeta in wxr-media / wxr-menus), exactly as it writes
     * `_wp_attached_file`: protection is a rule about the SURFACE, not the bytes.
     */
    const applyPostMeta = async (newId: number, item: any, type: string, skipKeys: Set<string>) => {
        for (const pm of toArray(item['wp:postmeta'])) {
            const key = text(pm['wp:meta_key']).trim();
            // The FORM rule the routes apply too: a key that is empty, over the column's bound, or one of
            // the prototype-manipulating names (`__proto__` poisons the map getAllMeta returns) is not a
            // key, whichever door it came through.
            if (metaKeyProblem(key) !== null) continue;
            if (skipKeys.has(key)) continue;

            const coreOwned = type === 'attachment'
                ? Object.prototype.hasOwnProperty.call(ATTACHMENT_OWNED_META, key) && ATTACHMENT_OWNED_META[key]
                : null;
            if (coreOwned) {
                const safe = coreOwned(text(pm['wp:meta_value']));
                if (!safe) continue; // unresolvable shape → no path at all, never a repaired one
                await Post.updateMeta(newId, key, safe);
                continue;
            }

            if (isProtectedPostMeta(key)) continue;
            await Post.updateMeta(newId, key, sanitizeImportedMeta(key, text(pm['wp:meta_value']), rewrite));
        }
    };

    /** One `wp:postmeta` value by key, or ''. */
    const metaValue = metaValueOf;

    for (const item of parsed.items) {
        const type = text(item['wp:post_type']) || 'post';
        const status = text(item['wp:status']) || 'draft';
        const oldId = text(item['wp:post_id']);

        // A MENU ITEM IS NOT AN ITEM THIS LOOP CREATES. It is collected for the menu pass, which writes
        // it through models/Menu's own MenuItem.create() — the internal-type refusal below is untouched.
        if (type === 'nav_menu_item') {
            if (status === 'trash') summary.navItems.skipped++;
            else menuItems.push(item);
            continue;
        }

        // AN INTERNAL POST TYPE IS NOT IMPORTABLE. The invariant "a showInRest:false type is never
        // created from outside" was put on the ROUTE (POST /posts) and the importer is the other door:
        // `wp:post_type` came straight out of a third party's XML and only `nav_menu_item` was filtered,
        // so `revision` walked in. With `wp:status = inherit` those rows pass getRevisions/
        // countRevisions' own filter, and pass D resolves `wp:post_parent` against posts that ALREADY
        // exist — so a crafted WXR hangs fabricated history off a real page and makes the next ordinary
        // save prune the genuine history (limitRevisions deletes oldest-first). The import is admin-only,
        // so this is an invariant restored, not an escalation closed.
        //
        // UNREGISTERED is not INTERNAL: a WXR carrying a custom type this install does not know must
        // still import (that is most of what a migration IS), exactly as routes/posts.ts distinguishes
        // the two for existing content.
        if (isInternalPostType(type)) { bumpSkip(summary, type); continue; }
        if (status === 'trash') { bumpSkip(summary, type); continue; }

        const slug = (text(item['wp:post_name']).trim() || sanitizeFallbackSlug(text(item.title))).slice(0, 200);
        if (!slug) { bumpSkip(summary, type); continue; }

        // --- attachments: a network fetch and an uploads write, both owned by core/wxr-media ---------
        if (type === 'attachment') {
            const creator = text(item['dc:creator']).trim();
            const outcome = await media.importAttachment({
                sourceId: oldId,
                slug,
                title: text(item.title),
                description: text(item['content:encoded']),
                caption: text(item['excerpt:encoded']),
                alt: metaValue(item, '_wp_attachment_image_alt'),
                attachmentUrl: text(item['wp:attachment_url']).trim(),
                attachedFile: metaValue(item, '_wp_attached_file'),
                mimeType: text(item['wp:post_mime_type']),
                authorId: (creator && authorByLogin.get(creator)) || defaultAuthorId,
            });
            // An already-present attachment still has to answer `wp:post_parent` references (a featured
            // image points AT the post, and the post's `_thumbnail_id` points back at this row).
            if (outcome.postId !== null && oldId) oldToNewPost.set(oldId, outcome.postId);
            if (outcome.outcome === 'skipped' || outcome.outcome === 'failed') {
                summary.attachments.skipped++;
                if (outcome.outcome === 'failed') pushError(`attachment "${slug}": ${outcome.reason}`);
                continue;
            }
            try {
                // In download mode Media.create() already wrote where the bytes ARE; the WXR's own copy
                // of those keys must not overwrite it with a path we did not use.
                const owned = outcome.ownsPathMeta
                    ? new Set(['_wp_attached_file', '_wp_attachment_metadata'])
                    : new Set<string>();
                await applyPostMeta(outcome.postId as number, item, 'attachment', owned);
                await restoreDates(item, outcome.postId as number);
            } catch (e: any) {
                pushError(`attachment meta "${slug}": ${e.message}`);
            }
            const wpParentAtt = text(item['wp:post_parent']);
            if (wpParentAtt && wpParentAtt !== '0') deferredParent.set(outcome.postId as number, wpParentAtt);
            summary.attachments.created++;
            continue;
        }

        try {
            // Idempotency: skip if a post with this slug+type already exists.
            const existing = await Post.findBySlug(slug, type);
            if (existing) {
                if (oldId) oldToNewPost.set(oldId, existing.id);
                bumpSkip(summary, type);
                continue;
            }

            const creator = text(item['dc:creator']).trim();
            const authorId = (creator && authorByLogin.get(creator)) || defaultAuthorId;
            const rawContent = text(item['content:encoded']);
            // Point in-content media at THIS install's uploads. Done on the raw body BEFORE wpautop so a
            // classic post's URLs are rewritten too, and it is a pure prefix swap — the file lands at the
            // path the old URL already named, which is why the stored path is preserved verbatim.
            const content = rewrite(maybeAutop(rawContent));
            const excerpt = rewrite(text(item['excerpt:encoded']));

            const post = await runContentMutation(async () => {
                const createdPost = await Post.create({
                    authorId,
                    title: text(item.title),
                    content,
                    excerpt,
                    status,
                    type,
                    slug,
                    parent: 0, // resolved in pass D
                    menuOrder: parseInt(text(item['wp:menu_order']) || '0', 10) || 0,
                    commentStatus: text(item['wp:comment_status']) || 'open',
                    pingStatus: text(item['wp:ping_status']) || 'open',
                    password: text(item['wp:post_password']),
                    mimeType: text(item['wp:post_mime_type']),
                });

            // Preserve the original publish/modified dates (Post.create stamps "now").
            await restoreDates(item, createdPost.id);

            await applyPostMeta(createdPost.id, item, type, EMPTY_SKIP_KEYS);

            // Terms: attach category + post_tag references that we imported.
            const catIds: number[] = [];
            const tagIds: number[] = [];
            for (const cat of toArray(item.category)) {
                const domain = attr(cat, 'domain');
                const nicename = attr(cat, 'nicename');
                if (!nicename) continue;
                if (domain === 'category' && catBySlug.has(nicename)) catIds.push(catBySlug.get(nicename)!);
                else if (domain === 'post_tag' && tagBySlug.has(nicename)) tagIds.push(tagBySlug.get(nicename)!);
            }
            if (catIds.length) await Post.setTerms(createdPost.id, catIds, 'category');
            if (tagIds.length) await Post.setTerms(createdPost.id, tagIds, 'post_tag');
                return createdPost;
            });

            if (oldId) oldToNewPost.set(oldId, post.id);
            const wpParent = text(item['wp:post_parent']);
            if (wpParent && wpParent !== '0') deferredParent.set(post.id, wpParent);

            // Comments
            if (importComments) {
                for (const cm of toArray(item['wp:comment'])) {
                    const ctype = (text(cm['wp:comment_type']) || 'comment').toLowerCase();
                    if (ctype === 'pingback' || ctype === 'trackback') { summary.comments.skipped++; continue; }
                    const approved = mapCommentApproved(text(cm['wp:comment_approved']));
                    const author = text(cm['wp:comment_author']).trim();
                    const email = text(cm['wp:comment_author_email']).trim();
                    const body = text(cm['wp:comment_content']);
                    if (approved === null || !author || !email || !body) { summary.comments.skipped++; continue; }
                    try {
                        const created = await Comment.create({
                            postId: post.id,
                            author,
                            authorEmail: email,
                            authorUrl: text(cm['wp:comment_author_url']),
                            authorIp: text(cm['wp:comment_author_IP']),
                            content: body,
                            status: approved,
                            type: 'comment',
                            parent: 0, // resolved in pass E
                        });
                        const newCommentId = created.commentId ?? created.id; // Comment model exposes commentId
                        const cOld = text(cm['wp:comment_id']);
                        if (cOld) oldToNewComment.set(`${oldId}:${cOld}`, newCommentId);
                        const cParent = text(cm['wp:comment_parent']);
                        if (cParent && cParent !== '0') deferredCommentParent.set(newCommentId, `${oldId}:${cParent}`);
                        summary.comments.created++;
                    } catch (e: any) {
                        summary.comments.skipped++;
                        pushError(`comment on "${slug}": ${e.message}`);
                    }
                }
            }

            bumpCreated(summary, type);
        } catch (e: any) {
            pushError(`item "${slug}" (${type}): ${e.message}`);
            bumpSkip(summary, type);
        }
    }

    // --- Pass D: resolve post parents (hierarchical pages) --------------------------------------
    for (const [newId, wpParent] of deferredParent) {
        const parentNewId = oldToNewPost.get(wpParent);
        if (parentNewId) {
            try {
                await runContentMutation(async () => {
                    const prior = await dbAsync.get('SELECT post_status, post_type, post_name FROM posts WHERE id = ?', [newId]);
                    await dbAsync.run(`UPDATE posts SET post_parent = ? WHERE id = ?`, [parentNewId, newId]);
                    if (prior) recordContentEvent('post.updated', Number(newId), {
                        data: { parent: parentNewId },
                        previousStatus: prior.post_status,
                        previousType: prior.post_type,
                        previousSlug: prior.post_name,
                    });
                });
            }
            catch { /* non-fatal */ }
        }
    }

    // --- Pass E: resolve threaded comment parents ----------------------------------------------
    for (const [newCommentId, oldParentKey] of deferredCommentParent) {
        const parentNewId = oldToNewComment.get(oldParentKey);
        if (parentNewId) {
            try { await dbAsync.run(`UPDATE comments SET comment_parent = ? WHERE comment_id = ?`, [parentNewId, newCommentId]); }
            catch { /* non-fatal */ }
        }
    }

    // --- Pass F: menus ---------------------------------------------------------------------------
    // LAST, and necessarily so: a menu item's `_menu_item_object_id` points at a post or a term, so it
    // can only be resolved once every id on this side exists. Runs even when the WXR declares no
    // `nav_menu` term, because an item's own `<category domain="nav_menu">` can name a menu the export
    // forgot to declare.
    if (menuTerms.length > 0 || menuItems.length > 0) {
        try {
            const menuSummary = await importMenus({
                menus: menuTerms,
                items: menuItems.map((item: any) => {
                    const navCat = toArray(item.category).find((c: any) => attr(c, 'domain') === 'nav_menu');
                    const meta: Record<string, string> = {};
                    for (const pm of toArray(item['wp:postmeta'])) {
                        const key = text(pm['wp:meta_key']).trim();
                        // Only the `_menu_item_*` family crosses over — it is what MenuItem.create takes,
                        // and it keeps a crafted WXR from smuggling arbitrary meta onto an internal type.
                        if (key.startsWith('_menu_item_')) meta[key] = text(pm['wp:meta_value']);
                    }
                    return {
                        sourceId: text(item['wp:post_id']).trim(),
                        menuSlug: navCat ? attr(navCat, 'nicename') : '',
                        menuName: navCat ? text(navCat) : '',
                        title: text(item.title),
                        menuOrder: parseInt(text(item['wp:menu_order']) || '0', 10) || 0,
                        meta,
                    };
                }),
                postIdMap: oldToNewPost,
                termIdMap,
                locations: readNavMenuLocations(parsed.options),
                dbAsync,
            });
            summary.menus.created = menuSummary.menus.created;
            summary.menus.matched = menuSummary.menus.matched;
            summary.menus.items = menuSummary.items;
            summary.menus.locations = menuSummary.locations;
            // navItems.skipped keeps its meaning — nav items that did NOT become menu items — so the
            // field an existing caller already reads stays true rather than gaining a second definition.
            summary.navItems.skipped += menuSummary.items.skipped;
            for (const err of menuSummary.errors) pushError(err);
        } catch (e: any) {
            pushError(`menus: ${e.message}`);
        }
    }

    return summary;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Find-or-create a term, returning its numeric term_id. */
async function ensureTerm(slug: string, name: string, taxonomy: string, description = ''): Promise<number> {
    const existing = await Term.findBySlug(slug, taxonomy);
    if (existing) return existing.termId ?? existing.term_id ?? existing.id;
    const created = await Term.create({ name, taxonomy, slug, description, parent: 0 });
    return created.termId ?? created.term_id ?? created.id;
}

function sanitizeFallbackSlug(title: string): string {
    return (title || '')
        .toLowerCase()
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 200);
}

function bumpCreated(s: ImportSummary, type: string) {
    if (type === 'page') s.pages.created++;
    else if (type === 'attachment') s.attachments.created++;
    else s.posts.created++;
}
function bumpSkip(s: ImportSummary, type: string) {
    if (type === 'page') s.pages.skipped++;
    else if (type === 'attachment') s.attachments.skipped++;
    else s.posts.skipped++;
}

module.exports = { parseWxr, analyzeWxr, importWxr };
