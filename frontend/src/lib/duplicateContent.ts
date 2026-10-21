/**
 * What "Duplicate" in the posts/pages table creates: a draft copy of an entry.
 *
 * Kept as a pure function so the payload is testable without a browser. Two defects shaped it:
 *  • The copy kept the original's title inside `_puck_data.root` (and `root.props.title`), and the
 *    editor saves `root.props.title || root.title`. Opening the copy therefore wrote the ORIGINAL's
 *    title back over "(copy)", regenerated the slug from it, and "Preview" opened the original entry.
 *    The copied document now carries the copy's own title and no slug (the server assigns one).
 *  • The copy lost its categories, tags and SEO fields. They are carried over: the term ids, every
 *    unprefixed meta key (the SEO keys are unprefixed) and the few `_` keys that describe the entry
 *    itself — its template, featured image and access level. Other `_` keys belong to the server or
 *    to the original record (revision bookkeeping, edit locks, review threads) and are not copied.
 */
import type { Post } from "@/lib/api";
import { EDITOR_DATA_META_KEY } from "@/lib/editorGuards";
import { ACCESS_META_KEY, normalizeTermIds } from "@/lib/editorRootFields";

/** The `_`-prefixed meta keys that describe the entry and so belong in its copy. */
export const DUPLICATED_PRIVATE_META_KEYS: readonly string[] = ["_wjs_template", "_thumbnail_id", ACCESS_META_KEY];

/** Rewrites the editor document so it names the copy, not the original. Accepts the stored object or JSON string. */
export function retitleEditorDocument(raw: unknown, title: string): unknown {
    let doc: any = raw;
    const wasString = typeof raw === "string";
    if (wasString) {
        try { doc = JSON.parse(raw as string); } catch { return raw; }
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return raw;
    const root = doc.root && typeof doc.root === "object" ? doc.root : {};
    const props = root.props && typeof root.props === "object" ? { ...root.props } : {};
    props.title = title;
    delete props.slug;
    const nextRoot: Record<string, unknown> = { ...root, title, props };
    delete nextRoot.slug;
    const next = { ...doc, root: nextRoot };
    return wasString ? JSON.stringify(next) : next;
}

export function buildDuplicatePayload(full: Post, copySuffix = " (copy)") {
    const title = `${full.title || ""}${copySuffix}`;
    const meta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(full.meta || {})) {
        if (key === EDITOR_DATA_META_KEY) meta[key] = retitleEditorDocument(value, title);
        else if (!key.startsWith("_") || DUPLICATED_PRIVATE_META_KEYS.includes(key)) meta[key] = value;
    }
    const categories = normalizeTermIds(full.categories);
    const tags = normalizeTermIds(full.tags);
    return {
        title,
        content: full.content,
        excerpt: full.excerpt,
        type: full.type,
        status: "draft" as const,
        ...(categories.length ? { categories } : {}),
        ...(tags.length ? { tags } : {}),
        ...(Object.keys(meta).length ? { meta } : {}),
    };
}
