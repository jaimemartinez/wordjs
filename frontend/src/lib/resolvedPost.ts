import type { Post } from "@/lib/api";

/**
 * The dynamic blocks' post shape and its mapping from the API `Post` — extracted from
 * resolveDynamicBlocks.ts so the EDITOR CANVAS can reuse the exact same derivation client-side
 * (useEditorPosts). One mapper, two callers: if the fields ever drift, the author preview and the
 * published page drift with them — keep it single-sourced here. (resolveDynamicBlocks imports
 * server-api and cannot be pulled into client bundles, hence the split.)
 */
export type ResolvedPost = {
    id: number;
    title: string;
    excerpt: string;
    href: string;
    date: string;
    image?: string;
};

/** Strip tags and clamp, so an excerpt built from HTML content stays plain text. */
export function toText(html: string | undefined | null, max = 160): string {
    if (!html) return "";
    const text = String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function toResolved(p: Post): ResolvedPost {
    const raw = (p as unknown as Record<string, unknown>);
    return {
        id: p.id,
        title: p.title || "(sin título)",
        excerpt: toText(p.excerpt || (raw.content as string)),
        href: `/${p.slug || p.id}`,
        // Locale-independent: formatting here would bake the SERVER's locale into the HTML and then
        // mismatch on hydration. The block formats it.
        date: (raw.date as string) || (raw.dateGmt as string) || "",
        image: (raw.featuredImage as string) || undefined,
    };
}

/** The category filter both resolvers share (slug match against the post's categories). */
export function filterByCategory(all: Post[], categorySlug?: string): Post[] {
    const slug = String(categorySlug || "").trim().toLowerCase();
    if (!slug) return all;
    return all.filter((p) => {
        const cats = (p as unknown as { categories?: Array<{ slug?: string; name?: string }> }).categories;
        return Array.isArray(cats) && cats.some((c) => (c.slug || c.name || "").toLowerCase() === slug);
    });
}
