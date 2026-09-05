/**
 * WordJS — WXR navigation-menu import: the `nav_menu` / `nav_menu_item` half of core/wxr-import.ts.
 *
 * WHY MENU ITEMS CANNOT GO THROUGH THE ITEM LOOP. `nav_menu_item` is an INTERNAL post type
 * (showInRest:false), and core/wxr-import.ts refuses to create an internal type from a third party's
 * `wp:post_type` on purpose — that guard is what stops a crafted WXR hanging fabricated `revision` rows
 * off a real page. A menu item is therefore not "an item the loop should stop skipping": it is a
 * DIFFERENT WRITE, made by core through models/Menu's own MenuItem.create(), with the WXR supplying only
 * the fields that write already takes. The generic refusal stays exactly as strict as it was.
 *
 * WHAT A MENU IS IN THIS CODEBASE. `nav_menu` is a TAXONOMY: a menu is a term (models/Menu wraps
 * terms + term_taxonomy), an item is a `nav_menu_item` post joined to that term through
 * term_relationships, and the item's fields live in `_menu_item_*` post meta. That is exactly the
 * WordPress model the WXR was written from, so the mapping is a rename, not a translation.
 *
 * THE TWO PASSES. Item parents (`_menu_item_menu_item_parent`) and object references
 * (`_menu_item_object_id`) are WordPress ids, so they can only be resolved once every id on this side
 * exists — the same reason wxr-import.ts resolves post parents and threaded comments in later passes.
 *
 * IDEMPOTENCY. Every created item is stamped with the WXR's own `wp:post_id` under
 * `_wxr_menu_item_id`; a re-run indexes that key first and creates nothing it already has. Menus dedupe
 * on the term slug, which is what models/Menu already keys on.
 */

const Post = require('../models/Post');
const { Menu, MenuItem } = require('../models/Menu');

/** The meta key that makes a menu-item import idempotent across re-runs. */
const MENU_ITEM_SOURCE_META_KEY = '_wxr_menu_item_id';

/**
 * The link-safety gate for an imported menu url.
 *
 * WHY IT IS DUPLICATED HERE, AND WHAT SHOULD HAPPEN TO IT. Menu item urls render site-wide as
 * `<a href={item.url}>`, so a `javascript:`/`data:`/`vbscript:` url is stored XSS on every page — which
 * is why routes/menus.ts sanitizes on write (its XSS-03 note). `_menu_item_url` comes straight out of a
 * third party's XML, so the importer is the SECOND untrusted write surface for that column and owes the
 * same gate. routes/menus.ts' `safeMenuUrl` is a module-private function in a route file, so it cannot
 * be called from here; this is the same rule, kept deliberately identical line for line. The right fix
 * is to lift `safeMenuUrl` + `SAFE_URL_SCHEMES` + `URL_STRIPPED_CONTROLS` out of routes/menus.ts into a
 * core module both writers require — see the handoff note in documentation/wordpress-import.md.
 */
const SAFE_URL_SCHEMES: Set<string> = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const URL_STRIPPED_CONTROLS = /[\t\n\r]/g;
function safeMenuUrl(raw: unknown): string {
    if (raw === undefined || raw === null) return '';
    // Strip BEFORE deciding, and keep the stripped value: the WHATWG parser removes tab/LF/CR before
    // parsing, so validating the raw string would validate something the browser never sees.
    const value = String(raw).replace(URL_STRIPPED_CONTROLS, '').trim();
    if (!value) return '';
    // Authority-relative, in BOTH spellings: for a special scheme the parser treats `\` like `/`, so
    // `/\evil.example` is an external navigation that a bare `!startsWith('//')` waves through.
    if (/^\/[/\\]/.test(value)) return '#';
    if (value.startsWith('/') || value.startsWith('#') || value.startsWith('?')) return value;
    try {
        const parsed = new URL(value);
        return SAFE_URL_SCHEMES.has(parsed.protocol) ? value : '#';
    } catch {
        return '#';
    }
}

/**
 * CSS classes as WordPress exports them: `_menu_item_classes` is a PHP-serialized ARRAY
 * (`a:1:{i:0;s:9:"highlight";}`). Pull the string payloads out of that form, take a plain string as-is,
 * and keep only class-name-shaped tokens — the value lands in a `class` attribute.
 */
function parseMenuClasses(raw: string): string {
    if (!raw) return '';
    const tokens: string[] = /^a:\d+:\{/.test(raw)
        ? [...raw.matchAll(/s:\d+:"([^"]*)"/g)].map((m) => m[1])
        : raw.split(/\s+/);
    return tokens
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t.length <= 64 && /^[A-Za-z0-9_-]+$/.test(t))
        .join(' ');
}

/** One `nav_menu_item`, already flattened out of the XML by wxr-import.ts (which owns the accessors). */
interface WxrMenuItemInput {
    sourceId: string;
    /** Slug of the `<category domain="nav_menu" nicename="…">` this item belongs to. */
    menuSlug: string;
    menuName: string;
    title: string;
    menuOrder: number;
    meta: Record<string, string>;
}

/** A `wp:term` whose taxonomy is `nav_menu`. */
interface WxrMenuInput {
    slug: string;
    name: string;
    description: string;
    /** The WXR's own `wp:term_id`, so `nav_menu_locations` can be keyed by id as WordPress stores it. */
    sourceId: string;
}

interface MenuImportInput {
    menus: WxrMenuInput[];
    items: WxrMenuItemInput[];
    /** WP post id -> new post id, from the importer's item pass. */
    postIdMap: Map<string, number>;
    /** WP term id -> new term id, from the importer's taxonomy pass. */
    termIdMap: Map<string, number>;
    /** Parsed `nav_menu_locations`, or null when the WXR carries none / an unreadable one. */
    locations: Record<string, string> | null;
    dbAsync: any;
}

interface MenuImportSummary {
    menus: { created: number; matched: number };
    items: { created: number; skipped: number };
    locations: { assigned: number; unassigned: number; reason: string | null };
    errors: string[];
}

/** Find-or-create the `nav_menu` term for a menu, returning its term_id. */
async function ensureMenu(slug: string, name: string, description: string): Promise<{ id: number; created: boolean }> {
    const existing = await Menu.findBySlug(slug);
    if (existing) return { id: existing.id, created: false };
    const created = await Menu.create({ name: name || slug, slug, description });
    return { id: created.id, created: true };
}

/**
 * The URL an imported item should link to.
 *
 * A `custom` item carries its own. An object reference does not: WordPress resolves it at render time
 * from the linked object, so the importer has to resolve it against THIS install's public routes —
 * `/{slug}` for a post or page (the one-segment catch-all), `/category/{slug}`, `/tag/{slug}` and
 * `/taxonomy/{taxonomy}/{term}` for the taxonomy archives. An object we could not map keeps whatever
 * `_menu_item_url` the export happened to carry, and otherwise becomes `''` — which the menus route and
 * the public nav both render as `#`, i.e. visibly unresolved rather than silently wrong.
 */
async function resolveItemUrl(
    type: string,
    object: string,
    mappedId: number | null,
    rawUrl: string,
    dbAsync: any,
): Promise<string> {
    if (type === 'custom' || mappedId === null) return safeMenuUrl(rawUrl);
    if (type === 'post_type') {
        const row = await dbAsync.get('SELECT post_name FROM posts WHERE id = ?', [mappedId]);
        if (row && row.post_name) return `/${encodeURIComponent(row.post_name)}`;
        return safeMenuUrl(rawUrl);
    }
    if (type === 'taxonomy') {
        const row = await dbAsync.get('SELECT slug FROM terms WHERE term_id = ?', [mappedId]);
        if (row && row.slug) {
            const slug = encodeURIComponent(row.slug);
            if (object === 'category') return `/category/${slug}`;
            if (object === 'post_tag') return `/tag/${slug}`;
            return `/taxonomy/${encodeURIComponent(object || 'category')}/${slug}`;
        }
    }
    return safeMenuUrl(rawUrl);
}

/**
 * Import every menu and menu item the WXR carries. Per-item failures are collected, never thrown — a
 * broken menu must not abort a content migration that already succeeded.
 */
async function importMenus(input: MenuImportInput): Promise<MenuImportSummary> {
    const { items, postIdMap, termIdMap, dbAsync } = input;
    const summary: MenuImportSummary = {
        menus: { created: 0, matched: 0 },
        items: { created: 0, skipped: 0 },
        locations: { assigned: 0, unassigned: 0, reason: null },
        errors: [],
    };
    const pushError = (msg: string) => { if (summary.errors.length < 100) summary.errors.push(msg); };

    // --- Pass M1: menus -------------------------------------------------------------------------
    // Every menu named by a `wp:term`, PLUS every menu an item references but the export forgot to
    // declare (a WXR trimmed by hand, or one exported from a plugin that writes items only).
    const declared = new Map<string, WxrMenuInput>();
    for (const m of input.menus) if (m.slug) declared.set(m.slug, m);
    for (const it of items) {
        if (it.menuSlug && !declared.has(it.menuSlug)) {
            declared.set(it.menuSlug, { slug: it.menuSlug, name: it.menuName || it.menuSlug, description: '', sourceId: '' });
        }
    }

    const menuIdBySlug = new Map<string, number>();
    const menuIdBySourceId = new Map<string, number>();
    for (const m of declared.values()) {
        try {
            const { id, created } = await ensureMenu(m.slug, m.name, m.description);
            menuIdBySlug.set(m.slug, id);
            if (m.sourceId) menuIdBySourceId.set(m.sourceId, id);
            if (created) summary.menus.created++; else summary.menus.matched++;
        } catch (e: any) {
            pushError(`menu "${m.slug}": ${e.message}`);
        }
    }

    // --- Pass M2: items -------------------------------------------------------------------------
    // Index what a previous run already created, keyed by the WXR's own item id.
    //
    // SCOPED TO `post_type = 'nav_menu_item'`. Unscoped, this answered from ANY post's meta — and
    // `_wxr_menu_item_id` used to be writable through the routes' generic meta bag and copyable verbatim
    // out of a third party's XML, so a planted row made a real menu item vanish (counted as `skipped`,
    // indistinguishable from a re-run) and pointed pass M3's `post_parent` update at an arbitrary post.
    // The key is in core/protected-meta's PROTECTED_POST_META now as well: the ban stops new plants, the
    // scope stops the ones already in the table from being believed.
    const existingBySourceId = new Map<string, number>();
    const priorRows = await dbAsync.all(
        `SELECT pm.post_id AS post_id, pm.meta_value AS meta_value
           FROM post_meta pm
           JOIN posts p ON p.id = pm.post_id
          WHERE pm.meta_key = ? AND p.post_type = ?`,
        [MENU_ITEM_SOURCE_META_KEY, 'nav_menu_item']
    );
    for (const row of priorRows || []) {
        if (typeof row.meta_value === 'string' && row.meta_value) existingBySourceId.set(row.meta_value, Number(row.post_id));
    }

    const newIdBySourceId = new Map<string, number>(existingBySourceId);
    const deferredParent = new Map<number, string>(); // new item id -> WP parent item id

    for (const it of items) {
        const menuId = it.menuSlug ? menuIdBySlug.get(it.menuSlug) : undefined;
        if (menuId === undefined) { summary.items.skipped++; continue; } // no menu to attach it to
        if (it.sourceId && existingBySourceId.has(it.sourceId)) { summary.items.skipped++; continue; }

        try {
            const meta = it.meta || {};
            const type = ['post_type', 'taxonomy', 'custom'].includes(meta._menu_item_type)
                ? meta._menu_item_type
                : 'custom';
            const object = String(meta._menu_item_object || '').slice(0, 64);
            const rawObjectId = String(meta._menu_item_object_id || '').trim();
            const mappedId = type === 'post_type'
                ? (postIdMap.get(rawObjectId) ?? null)
                : type === 'taxonomy'
                    ? (termIdMap.get(rawObjectId) ?? null)
                    : null;

            const url = await resolveItemUrl(type, object, mappedId, String(meta._menu_item_url || ''), dbAsync);
            // WordPress leaves an item's <title> empty when it should display the linked object's own
            // title, so an empty title is a REFERENCE, not a blank label — resolve it the same way.
            const title = it.title || (await linkedTitle(type, mappedId, dbAsync)) || url || 'Menu item';
            const target = meta._menu_item_target === '_blank' ? '_blank' : '_self';

            const created = await MenuItem.create({
                menuId,
                title,
                url,
                target,
                type,
                objectId: mappedId ?? 0,
                parent: 0, // resolved in pass M3
                order: it.menuOrder,
                classes: parseMenuClasses(String(meta._menu_item_classes || '')),
            });
            if (!created || !created.id) throw new Error('MenuItem.create returned nothing');

            // MenuItem.create writes `_menu_item_object` = the TYPE, conflating WordPress's two fields
            // (`_menu_item_type` is post_type|taxonomy|custom; `_menu_item_object` is page|post|category|
            // post_tag|…). Restore the distinction the WXR carries, and add the keys the model does not
            // know about, so a later menu editor and a re-export both see the real reference.
            if (object) await Post.updateMeta(created.id, '_menu_item_object', object);
            if (meta._menu_item_xfn) await Post.updateMeta(created.id, '_menu_item_xfn', String(meta._menu_item_xfn).slice(0, 255));
            if (it.sourceId) {
                await Post.updateMeta(created.id, MENU_ITEM_SOURCE_META_KEY, it.sourceId);
                newIdBySourceId.set(it.sourceId, created.id);
            }

            const wpParent = String(meta._menu_item_menu_item_parent || '').trim();
            if (wpParent && wpParent !== '0') deferredParent.set(created.id, wpParent);
            summary.items.created++;
        } catch (e: any) {
            summary.items.skipped++;
            pushError(`menu item "${it.title || it.sourceId}": ${e.message}`);
        }
    }

    // --- Pass M3: item hierarchy ----------------------------------------------------------------
    // BOTH columns, because both are read: MenuItem.findByMenu prefers the meta and falls back to
    // posts.post_parent, and models/Menu's buildTree walks the value findByMenu returns.
    for (const [newId, wpParent] of deferredParent) {
        const parentNewId = newIdBySourceId.get(wpParent);
        if (parentNewId === undefined) continue;
        try {
            await dbAsync.run('UPDATE posts SET post_parent = ? WHERE id = ?', [parentNewId, newId]);
            await Post.updateMeta(newId, '_menu_item_menu_item_parent', String(parentNewId));
        } catch (e: any) {
            pushError(`menu item parent ${newId}: ${e.message}`);
        }
    }

    // --- Pass M4: theme locations (best effort) --------------------------------------------------
    // WXR 1.2 has no options section, so this is only ever present in an export that was widened by
    // hand or by a plugin. When it is absent — the normal case — every menu is imported UNASSIGNED and
    // the summary says so, rather than guessing which menu belongs in which theme slot.
    if (!input.locations) {
        summary.locations.unassigned = menuIdBySlug.size;
        summary.locations.reason = 'the WXR carried no readable nav_menu_locations option';
    } else {
        for (const [location, ref] of Object.entries(input.locations)) {
            const key = String(ref);
            const menuId = menuIdBySourceId.get(key) ?? menuIdBySlug.get(key) ?? null;
            if (menuId === null) { summary.locations.unassigned++; continue; }
            try {
                await Menu.setLocation(location, menuId);
                summary.locations.assigned++;
            } catch (e: any) {
                summary.locations.unassigned++;
                pushError(`menu location "${location}": ${e.message}`);
            }
        }
    }

    return summary;
}

/** The title of the object a menu item points at, for an item whose own `<title>` is empty. */
async function linkedTitle(type: string, mappedId: number | null, dbAsync: any): Promise<string> {
    if (mappedId === null) return '';
    try {
        if (type === 'post_type') {
            const row = await dbAsync.get('SELECT post_title FROM posts WHERE id = ?', [mappedId]);
            return row?.post_title || '';
        }
        if (type === 'taxonomy') {
            const row = await dbAsync.get('SELECT name FROM terms WHERE term_id = ?', [mappedId]);
            return row?.name || '';
        }
    } catch { /* a title fallback is never worth failing an item over */ }
    return '';
}

module.exports = {
    MENU_ITEM_SOURCE_META_KEY,
    safeMenuUrl,
    parseMenuClasses,
    importMenus,
};
