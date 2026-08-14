import { getPosts, getSettings, getMenuByLocation, getThemeChrome, getThemeManifest } from "@/lib/server-api";
import type { Post } from "@/lib/api";
import { toResolved, filterByCategory } from "@/lib/resolvedPost";
import { parseTemplateParts, type TemplateTree, type TemplateBlock } from "@/lib/templateData";
import { parseChromeData, buildChromeBindings, type ChromeBindings, type ChromeData } from "@/lib/chromeData";

/**
 * Give a THEME TEMPLATE's dynamic blocks their real posts — the theme system's query loop.
 *
 * A page's dynamic blocks get their posts from resolveDynamicBlocks, which walks a page's stored
 * `_puck_data`. A template is not a page: it is theme-shipped data with no post of its own, and it
 * renders on routes that already know which posts they are about. That difference is this file.
 *
 * THE ROUTE SUPPLIES THE POSTS. `resolveDynamicBlocks` only ever knows `getPosts("post","publish")`,
 * so a search template asking for a listing would have shown the newest posts rather than the search
 * results — a listing that renders confidently and answers the wrong question. Here the route passes
 * what it already fetched, and the fallback to "latest published" is what happens only when it has
 * nothing more specific to say.
 *
 * This is the data path the template contract said these blocks would join with, and not before: a
 * block that validates and then renders empty is the failure the whole contract exists to prevent.
 */

/** What a route knows about itself, handed to the template so a listing can answer the real question. */
export interface RouteContext {
    /**
     * The posts this route is already about — search results, a category's posts. Omit on routes
     * that have no such list (a page, a single post) and the resolver falls back to latest published.
     */
    posts?: Post[];
    /** Narrows a CategoryPosts block that declares no categorySlug of its own. */
    categorySlug?: string;
}

/** Only these derive content from the site; everything else in a template is structure. */
const NEEDS_POSTS = new Set(["PostsGrid", "CategoryPosts"]);

function needsPosts(list: unknown): boolean {
    if (!Array.isArray(list)) return false;
    for (const node of list) {
        if (!node || typeof node !== "object") continue;
        const b = node as TemplateBlock;
        if (b.type && NEEDS_POSTS.has(b.type)) return true;
        if (b.props && needsPosts((b.props as Record<string, unknown>).items)) return true;
    }
    return false;
}

function decorate(list: unknown, posts: Post[], ctx: RouteContext): unknown {
    if (!Array.isArray(list)) return list;
    return list.map((node) => {
        if (!node || typeof node !== "object") return node;
        const b = node as TemplateBlock;
        let props = b.props as Record<string, unknown> | undefined;

        // Containers first: a listing may sit inside a Section, a Grid or a column.
        if (props && Array.isArray(props.items)) {
            props = { ...props, items: decorate(props.items, posts, ctx) };
        }

        if (b.type && NEEDS_POSTS.has(b.type)) {
            const count = Math.max(1, Number(props?.count) || 6);
            const slug = String(props?.categorySlug || ctx.categorySlug || "").trim().toLowerCase();
            // Same best-effort rule the page resolver uses, and the same honesty about it: the list
            // endpoint takes no category filter, so an unmatched slug falls back to the newest posts
            // and `resolvedFiltered` tells the block which of the two it got.
            const inCategory = filterByCategory(posts, slug);
            const chosen = (inCategory.length ? inCategory : posts).slice(0, count);
            props = {
                ...props,
                resolvedPosts: chosen.map(toResolved),
                resolvedFiltered: slug ? inCategory.length > 0 : true,
            };
        }

        return props === b.props ? node : { ...b, props };
    });
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * NAMED TEMPLATE PARTS
 *
 * A `TemplatePart` block names a chrome/<name>.json the theme ships. Resolving it here — on the
 * server, before render — is what makes the theme.json `templateParts` declaration mean something
 * instead of being a field nothing reads.
 *
 * TWO GATES, and both must pass or the block renders nothing:
 *   1. the name must be DECLARED in the active theme's theme.json `templateParts` (fail-closed: an
 *      invalid declaration drops every part, so a theme cannot half-load its furniture);
 *   2. the file must validate against the chrome contract v1 — the same closed allowlist, the same
 *      href rules and the same budgets the site's own header and footer go through.
 * The declaration gate is the important one: without it, `name` would be a theme-supplied string
 * choosing which file to fetch, and this codebase's rule is that data fills slots and never chooses.
 */

/** Everything a resolved part needs at render time. Injected by us — a template may not carry it. */
interface ResolvedPart { data: ChromeData; bindings: ChromeBindings }

function collectPartNames(list: unknown, out: Set<string>): void {
    if (!Array.isArray(list)) return;
    for (const node of list) {
        if (!node || typeof node !== "object") continue;
        const b = node as TemplateBlock;
        const props = (b.props || {}) as Record<string, unknown>;
        if (b.type === "TemplatePart" && typeof props.name === "string") out.add(props.name);
        collectPartNames(props.items, out);
    }
}

function decorateParts(list: unknown, parts: Map<string, ResolvedPart>): unknown {
    if (!Array.isArray(list)) return list;
    return list.map((node) => {
        if (!node || typeof node !== "object") return node;
        const b = node as TemplateBlock;
        let props = b.props as Record<string, unknown> | undefined;
        if (props && Array.isArray(props.items)) props = { ...props, items: decorateParts(props.items, parts) };
        if (b.type === "TemplatePart") {
            const resolved = parts.get(String(props?.name ?? ""));
            // An undeclared or invalid part stays unresolved on purpose: the renderer emits nothing
            // for it, and the doctor is where the author is told why (TEMPLATE_PART_UNKNOWN /
            // TEMPLATE_PART_MISSING / CHROME_INVALID).
            if (resolved) props = { ...props, resolvedPart: resolved.data, resolvedBindings: resolved.bindings };
        }
        return props === b.props ? node : { ...b, props };
    });
}

/**
 * Fetch + validate every part a template references and the theme declares. Menus and settings are
 * the SAME cache()d reads the public layout already made this request, so a part costs one static
 * file fetch and nothing else.
 */
async function resolveParts(names: Set<string>, themeSlug: string): Promise<Map<string, ResolvedPart>> {
    const out = new Map<string, ResolvedPart>();
    const declared = parseTemplateParts(await getThemeManifest(themeSlug));
    const usable = [...names].filter((n) => declared.has(n));
    if (!usable.length) return out;
    const [settings, headerMenu, footerMenu] = await Promise.all([
        getSettings().catch(() => null) as Promise<Record<string, string> | null>,
        getMenuByLocation("header").catch(() => null),
        getMenuByLocation("footer").catch(() => null),
    ]);
    const bindings = buildChromeBindings(settings, headerMenu?.items, footerMenu?.items);
    const raws = await Promise.all(usable.map((n) => getThemeChrome(themeSlug, n).catch(() => null)));
    usable.forEach((name, i) => {
        const parsed = parseChromeData(raws[i]);
        if (parsed.ok && parsed.data) out.set(name, { data: parsed.data, bindings });
    });
    return out;
}

/**
 * Returns a NEW tree with every dynamic block resolved, or the tree untouched when it has none —
 * a template made only of structure must not cost a fetch of any kind.
 */
export async function resolveTemplateBlocks(
    tree: TemplateTree,
    ctx: RouteContext = {},
    themeSlug?: string,
): Promise<TemplateTree> {
    const partNames = new Set<string>();
    if (themeSlug) collectPartNames(tree.content, partNames);
    if (!needsPosts(tree.content) && partNames.size === 0) return tree;

    let content = tree.content as unknown;
    if (needsPosts(tree.content)) {
        const posts = ctx.posts ?? ((await getPosts("post", "publish")) || []);
        content = decorate(content, posts, ctx);
    }
    if (partNames.size > 0) {
        const parts = await resolveParts(partNames, themeSlug as string);
        if (parts.size > 0) content = decorateParts(content, parts);
    }
    return { ...tree, content: content as TemplateBlock[] };
}
