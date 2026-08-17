import { cache } from "react";
import { getPosts, getPostById, getMenuByRef, getSettings, type MenuItem } from "@/lib/server-api";
import type { Post } from "@/lib/api";
import { toResolved, filterByCategory, type ResolvedPost } from "@/lib/resolvedPost";

/**
 * Fill the dynamic blocks with REAL posts before the page renders.
 *
 * PostsGrid and CategoryPosts used to build their own placeholder array — `Post Title 1`,
 * `Post Title 2` — and shipped that to production. A "latest posts" block that prints invented
 * titles is not an unfinished feature, it is a wrong one, so the placeholders are gone and the
 * blocks now render only what this resolver hands them (or an honest empty state).
 *
 * Resolved on the SERVER, before <Render>, for two reasons: the posts land in the SSR HTML where
 * crawlers and no-JS visitors can see them, and the browser makes no extra request. `getPosts` is
 * React-cached and tagged, so several dynamic blocks on one page share a single backend call.
 */

// The ResolvedPost shape + mapper live in resolvedPost.ts, SHARED with the editor canvas's
// client-side resolver (useEditorPosts) so author preview and published page can never drift.
export type { ResolvedPost };

// The ToC displays heading TEXT while HeadingBlock renders the same stored string as sanitized HTML —
// so the collected title is reduced to plain text here: strip tags first, then decode the basic
// entities (named + numeric), then collapse whitespace. Deliberately tiny and dependency-free (no
// sanitizer on this path): the result is rendered React-escaped (blocks.tsx renders {h.title}), so a
// decoded '<' stays inert text.
const HEADING_NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function headingPlainText(raw: string): string {
    const noTags = raw.replace(/<[^>]*>/g, "");
    return noTags
        .replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (match, dec, hex, name) => {
            if (dec || hex) {
                const cp = dec ? Number(dec) : parseInt(hex, 16);
                return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
            }
            const named = HEADING_NAMED_ENTITIES[String(name).toLowerCase()];
            return named ?? match;
        })
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Walk the Puck tree and give every dynamic block its `resolvedPosts`.
 *
 * Returns a NEW tree; the caller's data is never mutated (it is the cached API response, shared
 * across requests by React's cache — mutating it would leak one page's resolution into another).
 */
export const resolveDynamicBlocks = cache(async (data: unknown): Promise<unknown> => {
    if (!data || typeof data !== "object") return data;

    const DYNAMIC = new Set(["PostsGrid", "CategoryPosts"]);

    // A NavMenu binds to the site menu by REFERENCE (a location key or a menu id) — it never stores the
    // items. This turns one such reference into a stable string so equal refs on one page fetch once,
    // and so the same key can be recomputed in decorate() to pick the right list back out.
    const navRefOf = (p: Record<string, unknown> | undefined): { key: string; ref: { source?: string; location?: string; menuId?: number | string } } => {
        const source = String(p?.source ?? "location") === "menu" ? "menu" : "location";
        if (source === "menu") {
            const id = Number(p?.menuId);
            const safe = Number.isFinite(id) && id > 0 ? id : 0;
            return { key: `menu:${safe}`, ref: { source, menuId: safe } };
        }
        const location = String(p?.location || "header");
        return { key: `location:${location}`, ref: { source, location } };
    };

    // Only pay for fetches the page actually needs: posts for the dynamic listings, referenced
    // wjs_symbol posts for Symbol blocks, and the menu behind each distinct NavMenu reference.
    let needPosts = false;
    let needIdentity = false;
    let needToc = false;
    const symbolIds = new Set<number>();
    const menuRefs = new Map<string, { source?: string; location?: string; menuId?: number | string }>();
    // ONE collector, TWO passes: the page tree first, then — once symbol contents are fetched — each
    // symbol's own content, so a NavMenu/SiteLogo/PostsGrid living ONLY inside a symbol still
    // schedules its fetch (decorate() recurses into symbols, so their needs must be collected too).
    // `collectSymbolIds` is false on the symbol pass: depth is capped at 1 — a Symbol nested inside a
    // symbol never renders, so its interior must not schedule further fetches.
    const collect = (nodes: unknown, collectSymbolIds: boolean): void => {
        if (!Array.isArray(nodes)) return;
        for (const n of nodes) {
            if (!n || typeof n !== "object") continue;
            const node = n as { type?: string; props?: Record<string, unknown> };
            if (node.type && DYNAMIC.has(node.type)) needPosts = true;
            if (node.type === "SiteLogo") needIdentity = true;
            if (node.type === "TableOfContents") needToc = true;
            if (node.type === "Symbol" && collectSymbolIds) {
                const id = Number((node.props as { symbolId?: unknown } | undefined)?.symbolId);
                if (Number.isFinite(id) && id > 0) symbolIds.add(id);
            }
            if (node.type === "NavMenu" || node.type === "MegaMenu") {
                // MegaMenu shares NavMenu's binding contract exactly (source/location/menuId → one
                // resolved fetch per distinct ref); its inline panels are ordinary slot arrays, so
                // the generic recursion below decorates anything nested inside them.
                const { key, ref } = navRefOf(node.props);
                menuRefs.set(key, ref);
            }
            if (node.props) for (const v of Object.values(node.props)) if (Array.isArray(v)) collect(v, collectSymbolIds);
        }
    };
    collect((data as { content?: unknown }).content, true);
    if (!needPosts && !needIdentity && !needToc && symbolIds.size === 0 && menuRefs.size === 0) return data;

    // Symbol contents FIRST (their ids are known from the page pass), keyed by id. A deleted/foreign
    // reference resolves to [] — the block renders nothing on the public site (its editor states
    // handle the authoring side).
    const symbolItems = new Map<number, unknown[]>();
    await Promise.all(
        [...symbolIds].map(async (id) => {
            try {
                const post = (await getPostById(id)) as (Post & { meta?: Record<string, unknown> }) | null;
                const content = post && (post as { type?: string }).type === "wjs_symbol"
                    ? ((post.meta?._puck_data as { content?: unknown } | undefined)?.content)
                    : undefined;
                symbolItems.set(id, Array.isArray(content) ? content : []);
            } catch {
                symbolItems.set(id, []);
            }
        })
    );
    // Second collection pass, over the fetched symbol interiors, BEFORE the data fetches below — this
    // is what lets a symbol-only header (NavMenu + SiteLogo inside a reusable Symbol) carry its real
    // menu and identity on the public site instead of decorating against empty maps.
    for (const items of symbolItems.values()) collect(items, false);

    // Every heading that carries a real anchor, in DOCUMENT ORDER — the raw material a
    // TableOfContents block filters by level. Walked AFTER the symbol fetch so a symbol's anchored
    // headings land at the symbol's own position in the page order. Three collection rules:
    //  - duplicate ids keep the FIRST occurrence only (duplicate React keys, plus the scroll-spy's
    //    last-wins link map vs getElementById's first-wins target, would bind the active state to the
    //    wrong entry);
    //  - the title is reduced to PLAIN TEXT (headingPlainText above) so the index shows what the
    //    visitor sees, not literal markup/entities;
    //  - OffCanvas interiors are skipped (a heading inside a closed drawer cannot be scrolled to —
    //    its ToC link would be permanently dead).
    const headings: Array<{ id: string; level: string; title: string }> = [];
    const seenHeadingIds = new Set<string>();
    const collectHeadings = (nodes: unknown, inDrawer: boolean): void => {
        if (!Array.isArray(nodes)) return;
        for (const n of nodes) {
            if (!n || typeof n !== "object") continue;
            const node = n as { type?: string; props?: Record<string, unknown> };
            if (node.type === "Heading" && !inDrawer) {
                const p = node.props as { elementId?: unknown; level?: unknown; title?: unknown } | undefined;
                const id = typeof p?.elementId === "string" ? p.elementId.trim() : "";
                if (id && !seenHeadingIds.has(id)) {
                    seenHeadingIds.add(id);
                    headings.push({
                        id,
                        level: typeof p?.level === "string" ? p.level : "h2",
                        title: headingPlainText(typeof p?.title === "string" ? p.title : ""),
                    });
                }
            }
            if (node.type === "Symbol") {
                const id = Number((node.props as { symbolId?: unknown } | undefined)?.symbolId);
                // The symbol's headings, at the symbol's position. A symbol nested inside a symbol
                // was never fetched (depth cap 1), so its lookup is empty — nothing to walk.
                collectHeadings(symbolItems.get(id) ?? [], inDrawer);
            }
            const drawer = inDrawer || node.type === "OffCanvas";
            if (node.props) for (const v of Object.values(node.props)) if (Array.isArray(v)) collectHeadings(v, drawer);
        }
    };
    collectHeadings((data as { content?: unknown }).content, false);

    const all = needPosts ? (await getPosts("post", "publish")) || [] : [];

    // Site identity (blogname + site_logo) for SiteLogo blocks — the single settings read is React-cached
    // and tagged, so it collapses with every other `/settings` read on the page. Injected as a plain
    // serializable object; a null/failed read becomes empty strings (the block's empty path handles it).
    const identity = needIdentity
        ? await (async () => {
            try {
                const s = await getSettings();
                return {
                    blogname: typeof s?.blogname === "string" ? s.blogname : "",
                    siteLogo: typeof s?.site_logo === "string" ? s.site_logo : "",
                };
            } catch {
                return { blogname: "", siteLogo: "" };
            }
        })()
        : null;

    // Each distinct menu reference resolved ONCE, keyed by its ref string. A deleted/foreign/empty
    // reference resolves to [] — the block renders nothing on the public site (its editor state shows
    // the authoring notice). The nav_menu store stays the source of truth; this only reads it.
    const menuItems = new Map<string, MenuItem[]>();
    await Promise.all(
        [...menuRefs].map(async ([key, ref]) => {
            try {
                const res = await getMenuByRef(ref);
                menuItems.set(key, Array.isArray(res?.items) ? (res!.items as MenuItem[]) : []);
            } catch {
                menuItems.set(key, []);
            }
        })
    );

    const decorate = (nodes: unknown): unknown => {
        if (!Array.isArray(nodes)) return nodes;
        return nodes.map((n) => {
            if (!n || typeof n !== "object") return n;
            const node = n as { type?: string; props?: Record<string, unknown> };
            let props = node.props;

            // Recurse into slots first (a dynamic block can sit inside Columns/Grid/Section).
            if (props) {
                let next: Record<string, unknown> | null = null;
                for (const [k, v] of Object.entries(props)) {
                    if (Array.isArray(v) && v.some((x) => x && typeof x === "object" && "type" in (x as object))) {
                        (next ||= { ...props })[k] = decorate(v);
                    }
                }
                if (next) props = next;
            }

            if (node.type === "Symbol") {
                const id = Number((props as { symbolId?: unknown } | undefined)?.symbolId);
                // decorate() the symbol's own items too — their needs were collected by the second
                // collect() pass above, so a dynamic block INSIDE a symbol gets the same real
                // posts / menu / identity / headings a page-level one does.
                props = { ...props, resolvedSymbolItems: decorate(symbolItems.get(id) ?? []) };
            }

            if (node.type === "NavMenu" || node.type === "MegaMenu") {
                // The flat item array for THIS node's reference (same key the scan collected). A missing
                // ref → [], so the block's empty path runs (nothing on public, notice while editing).
                const { key } = navRefOf(props);
                props = { ...props, resolvedMenu: menuItems.get(key) ?? [] };
            }

            if (node.type === "SiteLogo") {
                // The resolved site identity — same object for every SiteLogo on the page. Empty strings
                // when settings are missing, so the block's empty path runs.
                props = { ...props, resolvedIdentity: identity ?? { blogname: "", siteLogo: "" } };
            }

            if (node.type === "TableOfContents") {
                // Every anchored heading on the page (the block filters by its own level range). Same list
                // for every ToC; empty → the block's empty path runs (nothing on public, notice editing).
                props = { ...props, resolvedHeadings: headings };
            }

            if (node.type && DYNAMIC.has(node.type)) {
                const count = Math.max(1, Number(props?.count) || 6);
                const slug = String(props?.categorySlug || "").trim().toLowerCase();
                // Category filtering is best-effort: the list endpoint does not take a category
                // filter, so an unmatched slug falls back to the newest posts rather than showing
                // nothing. The block says which it is.
                const inCategory = filterByCategory(all, slug);
                const chosen = (inCategory.length ? inCategory : all).slice(0, count);
                props = { ...props, resolvedPosts: chosen.map(toResolved), resolvedFiltered: slug ? inCategory.length > 0 : true };
            }

            return props === node.props ? n : { ...node, props };
        });
    };

    return { ...(data as object), content: decorate((data as { content?: unknown }).content) };
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * PER-POST context: Breadcrumbs + LangSwitcher.
 *
 * These depend on the CONCRETE post, not just the block tree — the ancestor trail, whether it is the
 * front page, and the sibling translations. That is exactly why this pass is SEPARATE from the
 * `cache(data)`d resolver above and NON-cached: two different pages can carry byte-identical
 * `_puck_data` (a shared template) yet need different trails, so injecting per-post here — keyed off
 * the post, into a fresh tree — is the only way to avoid one page showing another's breadcrumb.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

const POST_CTX_TYPES = new Set(["Breadcrumbs", "LangSwitcher"]);

type TrailCrumb = { label: string; href?: string };
interface PostContext {
    trail: TrailCrumb[];
    isFront: boolean;
    translations: { language: string; currentHref: string; items: Array<{ language: string; href: string }> };
}

// Does the tree contain any type in `types`? Short-circuits on the first hit so a page with no
// per-post block skips the fetches entirely.
function treeHasType(data: unknown, types: Set<string>): boolean {
    let found = false;
    const walk = (nodes: unknown): void => {
        if (found || !Array.isArray(nodes)) return;
        for (const n of nodes) {
            if (!n || typeof n !== "object") continue;
            const node = n as { type?: string; props?: Record<string, unknown> };
            if (node.type && types.has(node.type)) { found = true; return; }
            if (node.props) for (const v of Object.values(node.props)) if (Array.isArray(v)) walk(v);
        }
    };
    walk((data as { content?: unknown })?.content);
    return found;
}

const slugToHref = (slug: unknown): string => (typeof slug === "string" && slug ? `/${slug}` : "/");

// Build the trail / front-page flag / translations for THIS post. Ancestors walk `post_parent` up the
// chain (capped) via React-cached getPostById; a failed hop just ends the walk (best-effort trail).
async function buildPostContext(post: Post): Promise<PostContext> {
    const p = post as unknown as {
        id?: unknown; title?: unknown; slug?: unknown; parent?: unknown; language?: unknown;
        translations?: Array<{ language?: unknown; slug?: unknown }>;
    };

    const ancestors: TrailCrumb[] = [];
    let parentId = Number(p?.parent) || 0;
    let guard = 0;
    const seen = new Set<number>();
    while (parentId > 0 && guard < 6 && !seen.has(parentId)) {
        seen.add(parentId);
        guard++;
        let ap: { title?: unknown; slug?: unknown; parent?: unknown } | null = null;
        try { ap = (await getPostById(parentId)) as unknown as { title?: unknown; slug?: unknown; parent?: unknown }; } catch { ap = null; }
        if (!ap) break;
        ancestors.unshift({ label: typeof ap.title === "string" ? ap.title : "…", href: slugToHref(ap.slug) });
        parentId = Number(ap.parent) || 0;
    }
    // The current page is the LAST crumb and carries no href (the component marks it aria-current).
    const trail: TrailCrumb[] = [...ancestors, { label: typeof p?.title === "string" ? p.title : "…" }];

    let isFront = false;
    try {
        const s = await getSettings();
        // The anonymous /settings read identifies the static front page as `homepage_id` — the
        // WordPress-named show_on_front/page_on_front pair lives in the admin-only settings list
        // (and is vestigial: nothing in the product sets it), so it NEVER reaches this public
        // fetch. NaN / 0 ("no static front page") can never equal a real post id.
        const hid = Number(s?.homepage_id);
        isFront = Number.isFinite(hid) && hid > 0 && hid === Number(p?.id);
    } catch { /* settings read failed — false, so breadcrumbs show on the front too (fail-open) */ }

    const list = Array.isArray(p?.translations) ? p.translations : [];
    const translations = {
        language: typeof p?.language === "string" ? p.language : "",
        currentHref: slugToHref(p?.slug),
        items: list
            .filter((t) => t && typeof t.language === "string" && typeof t.slug === "string" && t.slug)
            .map((t) => ({ language: t.language as string, href: slugToHref(t.slug) })),
    };

    return { trail, isFront, translations };
}

// Inject a READY per-post context into Breadcrumbs / LangSwitcher nodes. PURE + synchronous: it returns
// a NEW tree and never mutates its input — the whole point, since its input is the SHARED, cache()d
// resolver output. Exported so the cross-post-leak guard can prove that two different contexts injected
// into the SAME tree produce different trails without touching the network or React's request cache.
export function applyPostContext<T>(data: T, ctx: PostContext): T {
    if (!data || typeof data !== "object") return data;
    const inject = (nodes: unknown): unknown => {
        if (!Array.isArray(nodes)) return nodes;
        return nodes.map((n) => {
            if (!n || typeof n !== "object") return n;
            const node = n as { type?: string; props?: Record<string, unknown> };
            let props = node.props;
            if (props) {
                let next: Record<string, unknown> | null = null;
                for (const [k, v] of Object.entries(props)) {
                    if (Array.isArray(v) && v.some((x) => x && typeof x === "object" && "type" in (x as object))) {
                        (next ||= { ...props })[k] = inject(v);
                    }
                }
                if (next) props = next;
            }
            if (node.type === "Breadcrumbs") props = { ...props, resolvedTrail: ctx.trail, resolvedIsFront: ctx.isFront };
            if (node.type === "LangSwitcher") props = { ...props, resolvedTranslations: ctx.translations };
            return props === node.props ? n : { ...node, props };
        });
    };
    return { ...(data as object), content: inject((data as { content?: unknown }).content) } as T;
}

export type { PostContext };

// Returns the SAME tree reference when there is nothing to inject (so withResolvedBlocks can skip the
// copy); otherwise builds the per-post context and hands it to the pure applyPostContext above.
async function injectPostContext<T>(data: T, post: Post): Promise<T> {
    if (!data || typeof data !== "object" || !treeHasType(data, POST_CTX_TYPES)) return data;
    const ctx = await buildPostContext(post);
    return applyPostContext(data, ctx);
}

/**
 * Convenience for the public routes: hand back the post with its Puck data resolved.
 *
 * Two passes: the cache(data) resolver (posts / menu / identity / headings / symbols) then the
 * per-post pass (breadcrumbs / language switcher). Copies rather than mutates — the Post comes from a
 * React-cached fetch shared across the request, and writing into it would let one route's resolution
 * leak into another's.
 */
export async function withResolvedBlocks<T extends Post>(post: T): Promise<T> {
    const versoData = (post as unknown as { meta?: Record<string, unknown> }).meta?._puck_data;
    if (!versoData) return post;
    const resolved = await resolveDynamicBlocks(versoData);
    const withCtx = await injectPostContext(resolved, post);
    if (withCtx === versoData) return post;
    const meta = { ...(post as unknown as { meta: Record<string, unknown> }).meta, _puck_data: withCtx };
    return { ...post, meta } as T;
}
