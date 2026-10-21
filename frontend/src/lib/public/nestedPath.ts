/**
 * WORDPRESS-STYLE NESTED ADDRESSES.
 *
 * WordPress serves a child page at its whole ancestry (`/level-1/level-2/level-3`) and a child category
 * at `/category/parent/child`. WordJS serves every page at its own slug (`/level-3`) and every category
 * at `/category/<slug>`, so after a migration the old nested links answered 404 — and the two-segment
 * `/<category>/<post>` route served a page under ANY first segment (`/x/level-2`), duplicating it.
 *
 * The rule here: a nested address whose segments are EXACTLY the entry's ancestry is an old link to it and
 * permanently redirects to the entry's own address; any other prefix is a 404. Pure, so it is tested
 * without a server: the caller passes the lookups.
 */

export interface NestedNode {
    id: number;
    slug: string;
    parent?: number | string | null;
}

const MAX_DEPTH = 20;

function parentId(node: NestedNode): number {
    const n = typeof node.parent === "number" ? node.parent : parseInt(String(node.parent ?? ""), 10);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function sameSlug(a: string, b: string): boolean {
    let x = a, y = b;
    try { x = decodeURIComponent(a); } catch { /* keep as given */ }
    try { y = decodeURIComponent(b); } catch { /* keep as given */ }
    return x.toLowerCase() === y.toLowerCase();
}

/**
 * Do `prefix` (the segments before the entry's own, outermost first) name `node`'s ancestry exactly?
 * `byId` looks an ancestor up (null when it does not exist or cannot be read).
 */
export async function ancestryMatches(
    node: NestedNode,
    prefix: string[],
    byId: (id: number) => Promise<NestedNode | null>,
): Promise<boolean> {
    if (prefix.length === 0 || prefix.length > MAX_DEPTH) return false;
    let cursor = parentId(node);
    const seen = new Set<number>([node.id]);
    // Walk up from the nearest ancestor, matching the prefix from its END.
    for (let i = prefix.length - 1; i >= 0; i--) {
        if (!cursor || seen.has(cursor)) return false;
        seen.add(cursor);
        const ancestor = await byId(cursor);
        if (!ancestor || !sameSlug(ancestor.slug, prefix[i])) return false;
        cursor = parentId(ancestor);
    }
    // The whole ancestry, not a suffix of it: the outermost segment must be a top-level entry.
    return cursor === 0;
}

/** A category's or post's own address for the redirect (`/` + slug, path-encoded). */
export function ownPath(prefix: string, slug: string): string {
    return `${prefix}/${encodeURIComponent(slug)}`;
}
