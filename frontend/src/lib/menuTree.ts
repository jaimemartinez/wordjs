/**
 * The menu editor's tree (QA S1-14): items in display order with their depth, and the moves the editor
 * offers — up/down among siblings, indent under the previous sibling, outdent to the parent's level.
 * Every move is a list of `{ id, order?, parent? }` writes for PUT /menus/items/:id, so the editor
 * stays a thin caller and the rules are tested here.
 */

export interface TreeItem {
    id: number;
    order: number;
    parent?: number | string | null;
}

export interface MenuWrite { id: number; order?: number; parent?: number }

const parentOf = (item: TreeItem, ids: Set<number>): number => {
    const p = Number(item.parent) || 0;
    return p && ids.has(p) && p !== item.id ? p : 0;
};

/** Items in display order (each parent before its children), with depth. A dangling parent is top level. */
export function flattenMenu<T extends TreeItem>(items: T[]): Array<{ item: T; depth: number }> {
    const ids = new Set(items.map((i) => i.id));
    const children = new Map<number, T[]>();
    for (const it of items) {
        const p = parentOf(it, ids);
        children.set(p, [...(children.get(p) || []), it]);
    }
    const out: Array<{ item: T; depth: number }> = [];
    const seen = new Set<number>();
    const walk = (parent: number, depth: number) => {
        for (const it of (children.get(parent) || []).sort((a, b) => a.order - b.order || a.id - b.id)) {
            if (seen.has(it.id)) continue;
            seen.add(it.id);
            out.push({ item: it, depth });
            walk(it.id, depth + 1);
        }
    };
    walk(0, 0);
    for (const it of items) if (!seen.has(it.id)) { seen.add(it.id); out.push({ item: it, depth: 0 }); }
    return out;
}

/** The item's siblings (same parent), in order. */
function siblingsOf<T extends TreeItem>(items: T[], item: T): T[] {
    const ids = new Set(items.map((i) => i.id));
    const p = parentOf(item, ids);
    return items.filter((i) => parentOf(i, ids) === p).sort((a, b) => a.order - b.order || a.id - b.id);
}

/** Swap with the previous / next sibling. Writes the whole sibling order so sparse orders heal. */
export function moveWithinSiblings<T extends TreeItem>(items: T[], item: T, direction: "up" | "down"): MenuWrite[] {
    const sibs = siblingsOf(items, item);
    const idx = sibs.findIndex((s) => s.id === item.id);
    const to = direction === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || to < 0 || to >= sibs.length) return [];
    const next = [...sibs];
    [next[idx], next[to]] = [next[to], next[idx]];
    return next.map((s, i) => ({ id: s.id, order: i }));
}

/** Make the item a child of its previous sibling (last among that sibling's children). */
export function indent<T extends TreeItem>(items: T[], item: T): MenuWrite[] {
    const sibs = siblingsOf(items, item);
    const idx = sibs.findIndex((s) => s.id === item.id);
    if (idx <= 0) return [];
    const newParent = sibs[idx - 1];
    const ids = new Set(items.map((i) => i.id));
    const kids = items.filter((i) => parentOf(i, ids) === newParent.id);
    return [{ id: item.id, parent: newParent.id, order: kids.length }];
}

/** Move the item up one level, right after its current parent. */
export function outdent<T extends TreeItem>(items: T[], item: T): MenuWrite[] {
    const ids = new Set(items.map((i) => i.id));
    const p = parentOf(item, ids);
    if (!p) return [];
    const parent = items.find((i) => i.id === p)!;
    const grand = parentOf(parent, ids);
    const level = items.filter((i) => parentOf(i, ids) === grand && i.id !== item.id).sort((a, b) => a.order - b.order || a.id - b.id);
    const at = level.findIndex((i) => i.id === parent.id) + 1;
    const next = [...level.slice(0, at), item, ...level.slice(at)];
    return next.map((s, i) => (s.id === item.id ? { id: s.id, parent: grand, order: i } : { id: s.id, order: i }));
}

/** Items that may become `item`'s parent: any item but itself and its descendants. */
export function parentCandidates<T extends TreeItem>(items: T[], item: T): T[] {
    const ids = new Set(items.map((i) => i.id));
    const banned = new Set<number>([item.id]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const i of items) {
            const p = parentOf(i, ids);
            if (p && banned.has(p) && !banned.has(i.id)) { banned.add(i.id); grew = true; }
        }
    }
    return items.filter((i) => !banned.has(i.id));
}
