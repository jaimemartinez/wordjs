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

/**
 * URL de la imagen destacada tal y como la API la manda HOY: `featuredMedia:{id,url,title}`
 * (backend Post.toJSON). El mapper leía `featuredImage`, una clave que la API nunca ha emitido, así
 * que ningún post con imagen destacada llegaba nunca con miniatura a PostsGrid/PostsList.
 * Se sigue tolerando la clave vieja (string, u objeto con `url`) por si algún caller la sintetiza.
 */
export function featuredImageUrl(raw: Record<string, unknown>): string | undefined {
    const candidates: unknown[] = [raw.featuredMedia, raw.featuredImage];
    for (const c of candidates) {
        if (typeof c === "string" && c.trim()) return c;
        if (c && typeof c === "object") {
            const url = (c as { url?: unknown }).url;
            if (typeof url === "string" && url.trim()) return url;
        }
    }
    return undefined;
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
        image: featuredImageUrl(raw),
    };
}

/**
 * El filtro por categoría que comparten los dos resolutores (coincidencia por slug).
 *
 * Era CÓDIGO MUERTO: leía `p.categories`, una clave que la API nunca mandaba (`Post.toJSON` no
 * serializaba los términos), así que un bloque CategoryPosts con categoría elegida devolvía SIEMPRE
 * lista vacía. Ahora `toJSON` emite `categories: [{id,name,slug}]` y este filtro funciona; se sigue
 * tolerando el `name` por si algún caller sintetiza posts sin slug.
 */
export function filterByCategory(all: Post[], categorySlug?: string): Post[] {
    const slug = String(categorySlug || "").trim().toLowerCase();
    if (!slug) return all;
    return all.filter((p) => {
        const cats = p.categories;
        return Array.isArray(cats) && cats.some((c) => (c.slug || c.name || "").toLowerCase() === slug);
    });
}
