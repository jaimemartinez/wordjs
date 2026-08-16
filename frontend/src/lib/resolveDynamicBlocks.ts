import { cache } from "react";
import { getPosts, getPostById } from "@/lib/server-api";
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

/**
 * Walk the Puck tree and give every dynamic block its `resolvedPosts`.
 *
 * Returns a NEW tree; the caller's data is never mutated (it is the cached API response, shared
 * across requests by React's cache — mutating it would leak one page's resolution into another).
 */
export const resolveDynamicBlocks = cache(async (data: unknown): Promise<unknown> => {
    if (!data || typeof data !== "object") return data;

    const DYNAMIC = new Set(["PostsGrid", "CategoryPosts"]);

    // Only pay for fetches the page actually needs: posts for the dynamic listings, referenced
    // wjs_symbol posts for Symbol blocks.
    let needPosts = false;
    const symbolIds = new Set<number>();
    const scan = (nodes: unknown): void => {
        if (!Array.isArray(nodes)) return;
        for (const n of nodes) {
            if (!n || typeof n !== "object") continue;
            const node = n as { type?: string; props?: Record<string, unknown> };
            if (node.type && DYNAMIC.has(node.type)) needPosts = true;
            if (node.type === "Symbol") {
                const id = Number((node.props as { symbolId?: unknown } | undefined)?.symbolId);
                if (Number.isFinite(id) && id > 0) symbolIds.add(id);
            }
            if (node.props) for (const v of Object.values(node.props)) if (Array.isArray(v)) scan(v);
        }
    };
    scan((data as { content?: unknown }).content);
    if (!needPosts && symbolIds.size === 0) return data;

    const all = needPosts ? (await getPosts("post", "publish")) || [] : [];

    // Symbol contents, keyed by id. A deleted/foreign reference resolves to [] — the block renders
    // nothing on the public site (its editor states handle the authoring side).
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
                // decorate() the symbol's own items too, so a dynamic block INSIDE a symbol still
                // gets its real posts on the public site.
                props = { ...props, resolvedSymbolItems: decorate(symbolItems.get(id) ?? []) };
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

/**
 * Convenience for the public routes: hand back the post with its Puck data resolved.
 *
 * Copies rather than mutates — the Post comes from a React-cached fetch shared across the request,
 * and writing into it would let one route's resolution leak into another's.
 */
export async function withResolvedBlocks<T extends Post>(post: T): Promise<T> {
    const versoData = (post as unknown as { meta?: Record<string, unknown> }).meta?._puck_data;
    if (!versoData) return post;
    const resolved = await resolveDynamicBlocks(versoData);
    if (resolved === versoData) return post;
    const meta = { ...(post as unknown as { meta: Record<string, unknown> }).meta, _puck_data: resolved };
    return { ...post, meta } as T;
}
