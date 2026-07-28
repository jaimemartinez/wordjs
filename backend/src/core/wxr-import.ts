/**
 * WordJS — WordPress WXR importer.
 *
 * Parses a WordPress eXtended RSS (WXR) export file and maps WordPress entities onto WordJS models:
 *   wp:author   -> users
 *   wp:category -> terms (taxonomy "category")   [parents resolved in a second pass]
 *   wp:tag      -> terms (taxonomy "post_tag")
 *   wp:term     -> terms (custom taxonomies, best-effort)
 *   item        -> posts / pages (+ post meta, terms, comments)
 *
 * Design notes:
 * - IDEMPOTENT / RE-RUNNABLE. Existing users (by login/email), terms (by slug+taxonomy) and posts
 *   (by slug+type) are reused/skipped, so a re-run does not duplicate content. We deliberately do NOT
 *   wrap the whole import in one DB transaction: it spans thousands of statements, and a bulk import
 *   is far more robust as an incremental, resumable operation than an all-or-nothing one (this also
 *   sidesteps the pg-pool BEGIN/COMMIT footgun). Per-item failures are collected, not fatal.
 * - Original publish dates are preserved (Post.create stamps "now", so we backfill the real dates).
 * - Attachments are skipped by default — the WXR carries only URLs, not the media binaries (remote
 *   media download is a future enhancement). nav_menu_item entries are skipped (menus differ enough).
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
const { sanitizeMetaValue } = require('./sanitize-meta');

/**
 * Sanitize an imported postmeta value through the SAME sanitizer the posts routes use, so a crafted
 * WXR file can't smuggle stored XSS via _puck_data (a Puck block with a javascript: URL / unescaped
 * HTML field). WXR carries meta values as STRINGS; _puck_data is a serialized JSON object, so we parse
 * it, run sanitizeMetaValue over the structured tree, then re-stringify for storage. If it isn't valid
 * JSON (or sanitizing yields nothing usable), fall back to the raw string so import stays non-fatal and
 * non-_puck_data meta is preserved verbatim (sanitizeMetaValue is a no-op for other keys anyway).
 */
function sanitizeImportedMeta(key: string, rawValue: string): string {
    if (key !== '_puck_data') return rawValue;
    let parsed: any;
    try { parsed = JSON.parse(rawValue); } catch { return rawValue; }
    if (!parsed || typeof parsed !== 'object') return rawValue;
    const sanitized = sanitizeMetaValue(key, parsed);
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
    };
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
    /** Create attachment post records (no file download). Off by default. */
    importAttachments?: boolean;
}

interface ImportSummary {
    site: { title: string; link: string };
    authors: { created: number; matched: number };
    terms: { categories: number; tags: number; custom: number };
    posts: { created: number; skipped: number };
    pages: { created: number; skipped: number };
    attachments: { created: number; skipped: number };
    comments: { created: number; skipped: number };
    navItems: { skipped: number };
    errors: string[];
}

async function importWxr(xml: string, options: ImportOptions): Promise<ImportSummary> {
    const parsed = parseWxr(xml);
    const defaultAuthorId = options.defaultAuthorId;
    const importComments = options.importComments !== false;
    const importAttachments = options.importAttachments === true;

    const summary: ImportSummary = {
        site: { title: parsed.site.title, link: parsed.site.link },
        authors: { created: 0, matched: 0 },
        terms: { categories: 0, tags: 0, custom: 0 },
        posts: { created: 0, skipped: 0 },
        pages: { created: 0, skipped: 0 },
        attachments: { created: 0, skipped: 0 },
        comments: { created: 0, skipped: 0 },
        navItems: { skipped: 0 },
        errors: [],
    };
    const pushError = (msg: string) => { if (summary.errors.length < 100) summary.errors.push(msg); };

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
    const catBySlug = new Map<string, number>();
    const catParentSlug = new Map<string, string>(); // childSlug -> parentSlug
    for (const c of parsed.categories) {
        const slug = text(c['wp:category_nicename']).trim();
        const name = text(c['wp:cat_name']).trim() || slug;
        if (!slug) continue;
        try {
            const id = await ensureTerm(slug, name, 'category', text(c['wp:category_description']));
            catBySlug.set(slug, id);
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
            tagBySlug.set(slug, await ensureTerm(slug, name, 'post_tag', text(t['wp:tag_description'])));
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
        try {
            customByTaxSlug.set(`${taxonomy}:${slug}`, await ensureTerm(slug, name, taxonomy, text(tm['wp:term_description'])));
            summary.terms.custom++;
        } catch (e: any) { pushError(`term "${taxonomy}:${slug}": ${e.message}`); }
    }

    // --- Pass C: items -> posts/pages -----------------------------------------------------------
    const oldToNewPost = new Map<string, number>();   // wp:post_id -> new post id
    const deferredParent = new Map<number, string>(); // new post id -> wp parent id (resolved later)
    const oldToNewComment = new Map<string, number>(); // wp comment_id -> new comment id
    const deferredCommentParent = new Map<number, string>(); // new comment id -> wp parent comment id

    for (const item of parsed.items) {
        const type = text(item['wp:post_type']) || 'post';
        const status = text(item['wp:status']) || 'draft';
        const oldId = text(item['wp:post_id']);

        if (type === 'nav_menu_item') { summary.navItems.skipped++; continue; }
        if (status === 'trash') { bumpSkip(summary, type); continue; }
        if (type === 'attachment' && !importAttachments) { summary.attachments.skipped++; continue; }

        const slug = (text(item['wp:post_name']).trim() || sanitizeFallbackSlug(text(item.title))).slice(0, 200);
        if (!slug) { bumpSkip(summary, type); continue; }

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
            const content = maybeAutop(rawContent);
            const excerpt = text(item['excerpt:encoded']);

            const post = await Post.create({
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
            const pDate = text(item['wp:post_date']);
            const pDateGmt = text(item['wp:post_date_gmt']);
            if (!isPlaceholderDate(pDate)) {
                const gmt = isPlaceholderDate(pDateGmt) ? pDate : pDateGmt;
                await dbAsync.run(
                    `UPDATE posts SET post_date = ?, post_date_gmt = ?, post_modified = ?, post_modified_gmt = ? WHERE id = ?`,
                    [pDate, gmt, pDate, gmt, post.id]
                );
            }

            if (oldId) oldToNewPost.set(oldId, post.id);
            const wpParent = text(item['wp:post_parent']);
            if (wpParent && wpParent !== '0') deferredParent.set(post.id, wpParent);

            // Post meta (skip volatile editor locks; keep everything else for fidelity).
            const SKIP_META = new Set(['_edit_lock', '_edit_last']);
            for (const pm of toArray(item['wp:postmeta'])) {
                const key = text(pm['wp:meta_key']).trim();
                if (!key || SKIP_META.has(key)) continue;
                try { await Post.updateMeta(post.id, key, sanitizeImportedMeta(key, text(pm['wp:meta_value']))); }
                catch { /* non-fatal */ }
            }

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
            if (catIds.length) await Post.setTerms(post.id, catIds, 'category');
            if (tagIds.length) await Post.setTerms(post.id, tagIds, 'post_tag');

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
            try { await dbAsync.run(`UPDATE posts SET post_parent = ? WHERE id = ?`, [parentNewId, newId]); }
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
