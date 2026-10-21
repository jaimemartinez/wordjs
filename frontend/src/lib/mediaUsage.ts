import type { MediaUsage } from "@/lib/api";
import { rewriteMediaString } from "@/lib/mediaDelivery";

/**
 * The media delete confirmation, with what the item is still used by appended: «Used as the featured
 * image of 2 entries: "Hello", "About". Deleting it removes it from them.» Titles the caller may not
 * edit are only counted.
 */
export function deleteMessage(base: string, usage: MediaUsage | null, t: (key: string) => string): string {
    if (!usage || usage.featuredIn <= 0) return base;
    const titles = usage.entries.map((e) => `«${e.title || `#${e.id}`}»`).slice(0, 5).join(", ");
    const lead = t("media.delete.featuredIn").replace("{n}", String(usage.featuredIn));
    return `${base}\n\n${lead}${titles ? ` ${titles}` : ""}. ${t("media.delete.featuredRemoved")}`;
}

/**
 * Where a post's featured image is served from: its site-relative `/uploads/…` path (rewritten to the
 * media bucket when the library lives there), else the absolute `url`. Undefined when there is none.
 */
export function featuredImageSrc(post: { featuredMedia?: { url?: string; path?: string } | null }, mediaBase: string): string | undefined {
    const fm = post.featuredMedia;
    if (!fm) return undefined;
    if (typeof fm.path === "string" && fm.path.startsWith("/uploads/")) {
        return mediaBase ? rewriteMediaString(fm.path, mediaBase) : fm.path;
    }
    return typeof fm.url === "string" && /^(https?:\/\/|\/)/i.test(fm.url) ? fm.url : undefined;
}
