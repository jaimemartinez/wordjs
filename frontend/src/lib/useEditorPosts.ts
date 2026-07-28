"use client";

import React from "react";
import { postsApi, type Post } from "@/lib/api";
import { toResolved, filterByCategory, type ResolvedPost } from "./resolvedPost";

/**
 * EDITOR-CANVAS resolver for the dynamic blocks (PostsGrid / CategoryPosts).
 *
 * On the public site the SSR pass (resolveDynamicBlocks) injects `resolvedPosts` before <Render>,
 * so the blocks show real content. The editor canvas has no server pass — the blocks used to fall
 * through to their empty state even on a site full of posts, which reads as "fake/no data" while
 * editing. This hook fetches the REAL published posts once per editor session (one shared promise,
 * however many dynamic blocks the page has) and applies the same category/count derivation as the
 * server resolver, via the shared mapper in resolvedPost.ts.
 *
 * Inert outside the editor: when `resolvedPosts` was injected (public site) or `editing` is false,
 * it returns the injected value untouched and never fetches.
 */
let publishedPromise: Promise<Post[]> | null = null;
const fetchPublished = (): Promise<Post[]> =>
    (publishedPromise ||= postsApi.list("post", "publish").catch(() => {
        publishedPromise = null; // a failed fetch may retry on the next mount
        return [] as Post[];
    }));

export function useEditorPosts(
    editing: boolean,
    injected: ResolvedPost[] | undefined,
    categorySlug: string | undefined,
    count: number
): ResolvedPost[] {
    const hasInjected = Array.isArray(injected) && injected.length > 0;
    const [all, setAll] = React.useState<Post[] | null>(null);
    React.useEffect(() => {
        if (!editing || hasInjected) return;
        let dead = false;
        fetchPublished().then((posts) => { if (!dead) setAll(posts); });
        return () => { dead = true; };
    }, [editing, hasInjected]);

    if (hasInjected) return injected as ResolvedPost[];
    if (!editing || !all) return [];
    const inCategory = filterByCategory(all, categorySlug);
    return (inCategory.length ? inCategory : all)
        .slice(0, Math.max(1, Number(count) || 6))
        .map(toResolved);
}
