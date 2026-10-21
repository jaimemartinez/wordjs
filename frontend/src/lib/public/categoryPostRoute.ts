import type { Post } from "@/lib/api";
import { getCategoryPostBySlug, getPostById } from "@/lib/server-api";
import { ancestryMatches, ownPath } from "@/lib/public/nestedPath";

/**
 * What `/<first>/<second>` names. A POST under one of its categories renders here (canonical `/<slug>`),
 * and under any other first segment redirects to its own address. A PAGE (or any other entry) is the
 * WordPress nested address `/<parent>/<child>`: it redirects to `/<child>` when `first` IS its parent,
 * and is a 404 otherwise — `/anything/<page>` used to serve the page, duplicating it under every prefix.
 */
export async function resolveCategoryPost(first: string, second: string): Promise<{ post: Post } | { redirect: string } | null> {
    const post = await getCategoryPostBySlug(second);
    if (!post) return null;
    const own = ownPath("", post.slug || String(post.id));
    if (post.type === "post") {
        const cats = Array.isArray(post.categories) ? post.categories : [];
        const wanted = first.toLowerCase();
        if (cats.length > 0 && !cats.some((c) => String(c.slug || "").toLowerCase() === wanted)) return { redirect: own };
        return { post };
    }
    return (await ancestryMatches(post, [first], getPostById)) ? { redirect: own } : null;
}
