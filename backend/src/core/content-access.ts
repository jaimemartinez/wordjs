/**
 * WordJS — content access levels (members-only / gated content). THE GENERIC SEAM.
 *
 * Core does not know what a "member", a "tier" or a "subscription" is. It knows three things:
 *
 *   1. AN ENTRY MAY REQUIRE AN ACCESS LEVEL. The level is the post meta `_wjs_access` — an opaque,
 *      lowercase slug (`members`, `paid`, `tier:gold`, …). Empty or absent means public, as before.
 *      Any other value gates the entry, including one no provider recognises: an unknown level is a
 *      level nobody holds, so a misconfigured or deactivated provider fails CLOSED (teasers only),
 *      never open. Who wrote the level is the post's editor (the same capability gate as every other
 *      author-written meta key).
 *
 *   2. A VIEWER HOLDS A SET OF LEVELS. Core asks the `content_access_grants` filter once per viewer
 *      per request (value: string[], args: { userId, role }). A provider plugin — the bundled
 *      `memberships` plugin is one — answers with the levels that account holds. Anonymous viewers
 *      hold nothing and the filter is never asked for them. Whoever MANAGES the entry (its author,
 *      editors: core/post-capabilities canManagePostRecord) always reads it in full: the editor loads
 *      through the same projection, and a truncated tree saved back would destroy the body.
 *
 *   3. A LOCKED ENTRY IS SERVED AS ITS TEASER, ON EVERY SURFACE. The teaser is the part of the body
 *      before the ACCESS BREAK:
 *        · HTML (`post_content`): an `<hr class="wjs-access-break">` (it survives the content
 *          sanitizer; a comment marker would not). No break → no teaser: the body is withheld whole.
 *        · Verso tree (`_puck_data`): the first top-level item whose props carry
 *          `contentAccessBreak: true` — any block may declare it in its defaultProps, so the provider
 *          ships the block that draws its own paywall call-to-action. The break item itself is kept
 *          (it renders the call-to-action) and annotated `accessState: 'locked' | 'granted'` (+ `accessLevel`) so it
 *          knows which side of the wall the viewer is on.
 *      The excerpt is the author's own excerpt, or one generated from the TEASER — never from the body.
 *
 * Every read surface consumes this module rather than its own copy of the rule: the REST projection
 * (models/Post toJSON), the feeds (routes/seo), search (models/Post buildWhere), the comments of a
 * gated entry (routes/comments, models/Comment, the comments feed). Sitemaps list a gated entry's URL —
 * its page is public, it shows the teaser — and never carried a body to begin with.
 *
 * The public site's HTML is cached and anonymous (ISR), so it only ever contains the teaser: the full
 * body reaches a member in the browser, through the same REST projection, with their own session.
 */

const ACCESS_META_KEY = '_wjs_access';
const ACCESS_BREAK_CLASS = 'wjs-access-break';
const GRANTS_FILTER = 'content_access_grants';
const LEVELS_FILTER = 'content_access_levels';

/**
 * A level a provider may grant or offer. Values outside it are kept as gates but never granted. It starts
 * with a letter and is never a JSON literal: meta values are JSON-decoded on read, so a level stored as
 * `null`, `true` or `42` would come back as something that is not that string.
 */
const LEVEL_RE = /^[a-z][a-z0-9:_-]{0,63}$/;
const RESERVED_LEVELS = new Set(['null', 'true', 'false']);
const isLevel = (v: unknown): v is string => typeof v === 'string' && LEVEL_RE.test(v) && !RESERVED_LEVELS.has(v);
/** The level a non-string `_wjs_access` value gates with: nobody can hold it (fails closed). */
const INVALID_LEVEL = '#invalid';
/** Ceiling on what one provider answer may carry (levels per viewer, levels offered to the editor). */
const MAX_LEVELS = 64;

/** `<hr … class="… wjs-access-break …" …>` — attribute order and quoting as the sanitizer emits them. */
const HTML_BREAK_RE = /<hr\b[^>]*\bclass\s*=\s*["'][^"']*\bwjs-access-break\b[^"']*["'][^>]*>/i;

export interface ContentAccess {
    /** The level the entry requires ('' = public). */
    level: string;
    /** The entry requires a level. */
    gated: boolean;
    /** This viewer reads the full body. */
    granted: boolean;
}

/**
 * The level an entry requires, from its meta map (JSON-decoded, Post.getAllMeta shape; '' when public).
 * Whitespace-only counts as public. Any value that is not a string — `null`, `[]`, `{}`, a number — was
 * stored as non-blank text, which the SQL gate (gatedPostSql) counts as gated: it gates here too, with a
 * level nobody holds, so every surface agrees and none fails open.
 */
function requiredLevel(meta: Record<string, unknown> | null | undefined): string {
    if (!meta || typeof meta !== 'object') return '';
    if (!Object.prototype.hasOwnProperty.call(meta, ACCESS_META_KEY)) return '';
    const raw = (meta as any)[ACCESS_META_KEY];
    if (raw === undefined) return '';
    if (typeof raw !== 'string') return INVALID_LEVEL;
    return raw.trim().slice(0, 200);
}

/** requiredLevel for a STORED meta_value (raw text), decoded the way Post.getAllMeta decodes it. */
function requiredLevelFromStored(text: unknown): string {
    if (text === undefined || text === null) return '';
    let value: unknown;
    try { value = JSON.parse(String(text)); } catch { value = text; }
    return requiredLevel({ [ACCESS_META_KEY]: value });
}

/** Keep only well-formed level slugs, deduplicated and bounded. */
function cleanLevels(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out = new Set<string>();
    for (const v of value) {
        if (!isLevel(v)) continue;
        out.add(v);
        if (out.size >= MAX_LEVELS) break;
    }
    return Array.from(out);
}

/**
 * The levels a viewer holds. Memoized per user OBJECT: the auth middleware builds one per request, so
 * a listing of fifty gated entries asks the provider once, and a later request (after an upgrade or a
 * cancellation) asks again. A provider that fails or times out answers "nothing" (fail closed).
 */
const grantsMemo: WeakMap<object, Promise<Set<string>>> = new WeakMap();

function viewerGrants(user: any): Promise<Set<string>> {
    if (!user || typeof user !== 'object' || !user.id) return Promise.resolve(new Set());
    const hit = grantsMemo.get(user);
    if (hit) return hit;
    const p = (async () => {
        try {
            const { applyFilters, hasFilter } = require('./hooks');
            if (!hasFilter(GRANTS_FILTER)) return new Set<string>();
            const role = typeof user.getRole === 'function' ? user.getRole() : (typeof user.role === 'string' ? user.role : undefined);
            const value = await applyFilters(GRANTS_FILTER, [], { userId: Number(user.id), role: role || null });
            return new Set(cleanLevels(value));
        } catch {
            return new Set<string>();
        }
    })();
    grantsMemo.set(user, p);
    return p;
}

/**
 * What this viewer may read of this entry. `meta` is the entry's meta map (Post.getAllMeta shape).
 * Managers of the entry read everything; everyone else needs the level among their grants.
 */
async function accessFor(viewer: any, post: any, meta: Record<string, unknown> | null | undefined): Promise<ContentAccess> {
    const level = requiredLevel(meta);
    if (!level) return { level: '', gated: false, granted: true };
    const { canManagePostRecord } = require('./post-capabilities');
    if (viewer && canManagePostRecord(viewer, post)) return { level, gated: true, granted: true };
    const grants = await viewerGrants(viewer);
    return { level, gated: true, granted: grants.has(level) };
}

/**
 * May this viewer read the gated part of this entry? The async companion of post-capabilities'
 * canReadPostContent (which callers still ask first) for surfaces that hold a row, not a meta map:
 * the comments of an entry are part of what its level unlocks.
 */
async function canReadGatedContent(viewer: any, post: any): Promise<boolean> {
    if (!post) return false;
    const cached = post._metaCache;
    const meta = cached !== undefined && cached !== null
        ? cached
        : { [ACCESS_META_KEY]: (await gatedLevelsForIds([Number(post.id)])).get(Number(post.id)) || '' };
    return (await accessFor(viewer, post, meta)).granted;
}

/** The HTML before the access break, or '' when the body has none (withheld whole). */
function teaserHtml(html: unknown): string {
    const s = typeof html === 'string' ? html : '';
    const m = HTML_BREAK_RE.exec(s);
    return m ? s.slice(0, m.index) : '';
}

/** Does this Verso item declare itself an access break? */
function isBreakItem(item: any): boolean {
    return !!(item && typeof item === 'object' && item.props && item.props.contentAccessBreak === true);
}

/**
 * Does this item, or anything nested in its props (slots) — or in the legacy `zones` entries it owns,
 * however deep — contain a break? Returns that break item.
 */
function findNestedBreak(value: any, depth = 0, zones: Record<string, any> | null = null): any | null {
    if (!value || typeof value !== 'object' || depth > 32) return null;
    if (Array.isArray(value)) {
        for (const v of value) {
            const hit = findNestedBreak(v, depth + 1, zones);
            if (hit) return hit;
        }
        return null;
    }
    if (isBreakItem(value)) return value;
    for (const k of Object.keys(value)) {
        const hit = findNestedBreak(value[k], depth + 1, zones);
        if (hit) return hit;
    }
    // An item (props.id) owns the zones keyed `<id>:<zone>`: their items render inside it.
    if (zones && value.props && typeof value.props.id === 'string') {
        for (const [key, items] of Object.entries(zones)) {
            if (key.split(':')[0] !== value.props.id) continue;
            const hit = findNestedBreak(items, depth + 1, zones);
            if (hit) return hit;
        }
    }
    return null;
}

/** Root props a locked reader keeps: everything but the excerpt the editor seeds from the FULL body. */
function teaserRoot(root: any): any {
    if (!root || typeof root !== 'object') return root;
    if (!root.props || typeof root.props !== 'object' || !('excerpt' in root.props)) return root;
    const props = { ...root.props };
    delete props.excerpt;
    return { ...root, props };
}

/** A stored tree, whatever its shape: an object, or the same object JSON-encoded once more. */
function asTree(data: any): any {
    if (typeof data === 'string') {
        try { return JSON.parse(data); } catch { return null; }
    }
    return data;
}

/** Every `props.id` inside a subtree — the ids whose legacy `zones` entries the teaser may keep. */
function collectIds(value: any, out: Set<string>, depth = 0): void {
    if (!value || typeof value !== 'object' || depth > 32) return;
    if (Array.isArray(value)) { for (const v of value) collectIds(v, out, depth + 1); return; }
    if (value.props && typeof value.props.id === 'string') out.add(value.props.id);
    for (const k of Object.keys(value)) collectIds(value[k], out, depth + 1);
}

function withBreakState(item: any, state: 'locked' | 'granted', level: string): any {
    return { ...item, props: { ...(item.props || {}), accessState: state, accessLevel: level } };
}

/**
 * The Verso tree a LOCKED viewer receives: the top-level items before the first break, then the break
 * itself (annotated `locked`). A break nested inside a container cuts before that container and the
 * break is lifted to the top level, so the call-to-action still renders. No break → no items. Legacy
 * `zones` entries survive only for the items that survive. `root` (title, SEO, template) stays.
 */
function teaserVersoData(input: any, level = ''): any {
    // Fails CLOSED: a tree that is not `{ content: [...] }` (a double-encoded string, zones-only legacy
    // data, anything else) has no teaser this module can cut, so the locked reader gets none of it.
    const data = asTree(input);
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.content)) {
        const root = data && typeof data === 'object' && !Array.isArray(data) ? teaserRoot(data.root) : undefined;
        return root ? { root, content: [] } : { content: [] };
    }
    const legacyZones = data.zones && typeof data.zones === 'object' ? data.zones : null;
    const kept: any[] = [];
    for (const item of data.content) {
        if (isBreakItem(item)) { kept.push(withBreakState(item, 'locked', level)); break; }
        // (`item` itself is not a break: its props, its slots and the legacy zones it owns are searched.)
        const nested = findNestedBreak(item, 0, legacyZones);
        if (nested) { kept.push(withBreakState(nested, 'locked', level)); break; }
        kept.push(item);
    }
    const hasBreak = kept.some(isBreakItem);
    const content = hasBreak ? kept : [];
    const out: any = { ...data, content };
    if ('root' in data) out.root = teaserRoot(data.root);
    if (data.zones && typeof data.zones === 'object') {
        const ids = new Set<string>();
        collectIds(content, ids);
        const zones: Record<string, unknown> = {};
        // Zones of kept items may themselves own zones: walk until no new id appears.
        let grew = true;
        while (grew) {
            grew = false;
            for (const [key, items] of Object.entries(data.zones)) {
                if (key in zones) continue;
                const owner = key.split(':')[0];
                if (!ids.has(owner)) continue;
                zones[key] = items;
                const before = ids.size;
                collectIds(items, ids);
                if (ids.size !== before) grew = true;
            }
        }
        out.zones = zones;
    }
    return out;
}

/** The full tree a GRANTED viewer receives, with its top-level breaks annotated `granted`. */
function grantedVersoData(data: any, level = ''): any {
    if (!data || typeof data !== 'object' || !Array.isArray(data.content)) return data;
    if (!data.content.some(isBreakItem)) return data;
    return { ...data, content: data.content.map((item: any) => (isBreakItem(item) ? withBreakState(item, 'granted', level) : item)) };
}

/**
 * SQL: "this posts row requires an access level". `idCol` is the posts id column as the caller's query
 * names it (`id`, `p.id`, `comments.comment_post_id`). Same rule as requiredLevel: non-blank value.
 */
function gatedPostSql(idCol: string): string {
    return `EXISTS (SELECT 1 FROM post_meta wjs_am WHERE wjs_am.post_id = ${idCol} ` +
        `AND wjs_am.meta_key = '${ACCESS_META_KEY}' AND TRIM(COALESCE(wjs_am.meta_value, '')) <> '')`;
}

/** The required level of each of these posts that is gated (id → level). One query. */
async function gatedLevelsForIds(ids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const clean = Array.from(new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0)));
    if (!clean.length) return out;
    const { dbAsync } = require('../config/database');
    for (let i = 0; i < clean.length; i += 500) {
        const chunk = clean.slice(i, i + 500);
        const rows = await dbAsync.all(
            `SELECT post_id, meta_value FROM post_meta WHERE meta_key = ? AND post_id IN (${chunk.map(() => '?').join(',')})`,
            [ACCESS_META_KEY, ...chunk],
        );
        for (const row of rows || []) {
            const level = requiredLevelFromStored(row.meta_value);
            if (level) out.set(Number(row.post_id), level);
        }
    }
    return out;
}

/**
 * Posts (model instances or raw rows) as an ANONYMOUS reader sees them: a gated entry's body is
 * replaced by its teaser. Shallow copies — the caller's objects (and the model cache) are untouched.
 * The feeds run their summaries over this, so a gated entry publishes its own excerpt or its teaser.
 */
async function anonymousTeaserView<T extends Record<string, any>>(posts: T[]): Promise<T[]> {
    const list = Array.isArray(posts) ? posts : [];
    const gated = await gatedLevelsForIds(list.map((p) => Number(p && (p.id ?? p.ID))));
    if (!gated.size) return list;
    return list.map((p) => {
        if (!p || !gated.has(Number(p.id ?? p.ID))) return p;
        const copy: any = Object.assign(Object.create(Object.getPrototypeOf(p)), p);
        const teaser = teaserHtml(p.postContent !== undefined ? p.postContent : (p.post_content !== undefined ? p.post_content : p.content));
        if ('postContent' in copy) copy.postContent = teaser;
        if ('post_content' in copy) copy.post_content = teaser;
        if ('content' in copy) copy.content = teaser;
        return copy as T;
    });
}

/**
 * The levels the post editor offers, from the `content_access_levels` filter
 * (value: Array<{ value, label }>). Empty when no provider is active — the editor then hides the field.
 */
async function offeredLevels(): Promise<Array<{ value: string; label: string }>> {
    try {
        const { applyFilters, hasFilter } = require('./hooks');
        if (!hasFilter(LEVELS_FILTER)) return [];
        const value = await applyFilters(LEVELS_FILTER, []);
        if (!Array.isArray(value)) return [];
        const out: Array<{ value: string; label: string }> = [];
        const seen = new Set<string>();
        for (const v of value) {
            const slug = v && typeof v.value === 'string' ? v.value : '';
            if (!isLevel(slug) || seen.has(slug)) continue;
            seen.add(slug);
            const label = typeof v.label === 'string' && v.label.trim() ? v.label.trim().slice(0, 120) : slug;
            out.push({ value: slug, label });
            if (out.length >= MAX_LEVELS) break;
        }
        return out;
    } catch {
        return [];
    }
}

/**
 * A meta map as THIS viewer may read it: for a gated entry the viewer does not hold, the page-builder
 * tree becomes its teaser; for one it holds, the breaks are annotated `granted`. Shared by the REST
 * projection (models/Post toJSON) and GET /posts/:id/meta, so the two can never disagree.
 */
function projectGatedMeta(meta: Record<string, any> | null | undefined, access: ContentAccess): Record<string, any> | null | undefined {
    if (!access.gated || !meta || typeof meta !== 'object' || !Object.prototype.hasOwnProperty.call(meta, '_puck_data')) return meta;
    const locked = !access.granted;
    const tree = meta._puck_data;
    if (tree === null || tree === undefined || tree === '') return meta;
    return { ...meta, _puck_data: locked ? teaserVersoData(tree, access.level) : grantedVersoData(asTree(tree) || tree, access.level) };
}

module.exports = {
    ACCESS_META_KEY, ACCESS_BREAK_CLASS, GRANTS_FILTER, LEVELS_FILTER, LEVEL_RE, INVALID_LEVEL, isLevel,
    requiredLevel, requiredLevelFromStored, cleanLevels, viewerGrants, accessFor, canReadGatedContent,
    teaserHtml, teaserVersoData, grantedVersoData, isBreakItem, projectGatedMeta,
    gatedPostSql, gatedLevelsForIds, anonymousTeaserView, offeredLevels,
};
