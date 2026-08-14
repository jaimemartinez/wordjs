import { getPosts } from "@/lib/server-api";
import type { Post } from "@/lib/api";
import { toResolved, filterByCategory } from "@/lib/resolvedPost";
import type { TemplateTree, TemplateBlock } from "@/lib/templateData";

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

/**
 * Returns a NEW tree with every dynamic block resolved, or the tree untouched when it has none —
 * a template made only of structure must not cost a post fetch.
 */
export async function resolveTemplateBlocks(
    tree: TemplateTree,
    ctx: RouteContext = {},
): Promise<TemplateTree> {
    if (!needsPosts(tree.content)) return tree;
    const posts = ctx.posts ?? ((await getPosts("post", "publish")) || []);
    return { ...tree, content: decorate(tree.content, posts, ctx) as TemplateBlock[] };
}
