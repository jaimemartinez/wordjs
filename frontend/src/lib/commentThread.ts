/**
 * Public comments as a thread (QA S1-23): every reply after the comment it answers, with its depth. A
 * reply whose parent is not in the list (held, or deleted) is shown at the top level instead of
 * disappearing. Oldest first within a level, the order the list arrives in otherwise.
 */
export interface ThreadComment { id: number; parent?: number | null; date?: string }

export function commentThread<T extends ThreadComment>(comments: T[]): Array<{ comment: T; depth: number }> {
    const ids = new Set(comments.map((c) => c.id));
    const kids = new Map<number, T[]>();
    for (const c of comments) {
        const p = c.parent && ids.has(c.parent) && c.parent !== c.id ? c.parent : 0;
        kids.set(p, [...(kids.get(p) || []), c]);
    }
    const out: Array<{ comment: T; depth: number }> = [];
    const seen = new Set<number>();
    const walk = (parent: number, depth: number) => {
        for (const c of kids.get(parent) || []) {
            if (seen.has(c.id)) continue;
            seen.add(c.id);
            out.push({ comment: c, depth });
            walk(c.id, depth + 1);
        }
    };
    walk(0, 0);
    for (const c of comments) if (!seen.has(c.id)) { seen.add(c.id); out.push({ comment: c, depth: 0 }); }
    return out;
}
