/**
 * The category list as a tree: every category after its parent, children alphabetical, with its depth
 * for the indent. The admin listed categories flat and alphabetical, so the hierarchy (a WordPress import
 * brings plenty) was invisible. A category whose parent is missing (deleted, or past the loaded pages)
 * is shown at the top level instead of disappearing; a loop in stored data cannot hang the walk.
 */

export interface TreeCategory {
    id: number;
    name: string;
    parent?: number | null;
}

export function orderAsTree<T extends TreeCategory>(categories: T[]): Array<{ category: T; depth: number }> {
    const byId = new Map(categories.map((c) => [c.id, c]));
    const children = new Map<number, T[]>();
    for (const c of categories) {
        const parent = c.parent && byId.has(c.parent) && c.parent !== c.id ? c.parent : 0;
        const list = children.get(parent) ?? [];
        list.push(c);
        children.set(parent, list);
    }
    const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    const out: Array<{ category: T; depth: number }> = [];
    const seen = new Set<number>();
    const walk = (parent: number, depth: number) => {
        for (const c of (children.get(parent) ?? []).sort(byName)) {
            if (seen.has(c.id)) continue;
            seen.add(c.id);
            out.push({ category: c, depth });
            walk(c.id, depth + 1);
        }
    };
    walk(0, 0);
    // Members of a parent loop never hang off the root; show them rather than lose them.
    for (const c of categories.slice().sort(byName)) {
        if (!seen.has(c.id)) { seen.add(c.id); out.push({ category: c, depth: 0 }); walk(c.id, 1); }
    }
    return out;
}

/** `id` and every category below it — none of them can become its parent. */
export function selfAndDescendants(categories: TreeCategory[], id: number): Set<number> {
    const result = new Set<number>([id]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const c of categories) {
            if (c.parent && result.has(c.parent) && !result.has(c.id)) { result.add(c.id); grew = true; }
        }
    }
    return result;
}
