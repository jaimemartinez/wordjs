/**
 * The media library's folders as the screens use them: a tree from the flat list GET /media/folders
 * answers, the options of a «Move to…» picker, the path to a folder, and the drag-and-drop payload that
 * carries media ids onto a folder. Kept apart from the components so it can be tested.
 */
import type { MediaFolder } from "@/lib/api";

export interface FolderNode extends MediaFolder { depth: number; children: FolderNode[] }

/** The folders as a tree, siblings by name. A folder whose parent is missing goes to the top level. */
export function folderTree(folders: MediaFolder[]): FolderNode[] {
    const byId = new Map<number, FolderNode>();
    for (const f of folders) byId.set(f.id, { ...f, depth: 0, children: [] });
    const roots: FolderNode[] = [];
    for (const node of byId.values()) {
        const parent = node.parent ? byId.get(node.parent) : undefined;
        if (parent && parent !== node) parent.children.push(node);
        else roots.push(node);
    }
    const sortAndDepth = (nodes: FolderNode[], depth: number, seen: Set<number>) => {
        nodes.sort((a, b) => a.name.localeCompare(b.name));
        for (const n of nodes) {
            if (seen.has(n.id)) { n.children = []; continue; }
            seen.add(n.id);
            n.depth = depth;
            sortAndDepth(n.children, depth + 1, seen);
        }
    };
    sortAndDepth(roots, 0, new Set());
    return roots;
}

/** Every folder in tree order, each with its depth (for an indented picker). */
export function flattenFolders(folders: MediaFolder[]): FolderNode[] {
    const out: FolderNode[] = [];
    const walk = (nodes: FolderNode[]) => { for (const n of nodes) { out.push(n); walk(n.children); } };
    walk(folderTree(folders));
    return out;
}

/** The folder and every folder below it — where a folder may not be moved, and where a deleted one's contents may not go. */
export function folderSubtree(folders: MediaFolder[], id: number): Set<number> {
    const out = new Set<number>([id]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const f of folders) if (!out.has(f.id) && out.has(f.parent)) { out.add(f.id); grew = true; }
    }
    return out;
}

/** The folders from the top level down to `id` (empty for «no folder» or an unknown id). */
export function folderPath(folders: MediaFolder[], id: number): MediaFolder[] {
    const byId = new Map(folders.map((f) => [f.id, f]));
    const path: MediaFolder[] = [];
    const seen = new Set<number>();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); path.unshift(cur); cur = cur.parent ? byId.get(cur.parent) : undefined; }
    return path;
}

/** The label of a folder in an indented picker («— — Events»). */
export function indentedLabel(node: FolderNode): string {
    return `${"— ".repeat(node.depth)}${node.name}`;
}

/** The drag-and-drop type that carries media ids from a card onto a folder (never a file upload). */
export const MEDIA_DRAG_TYPE = "application/x-wordjs-media-ids";

export function encodeDraggedIds(ids: number[]): string {
    return JSON.stringify(ids.filter((n) => Number.isInteger(n) && n > 0));
}

export function decodeDraggedIds(raw: string): number[] {
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n > 0) : [];
    } catch {
        return [];
    }
}

/** «All files» (no filter), «no folder» (0) or a folder id — as the list query takes it. */
export type FolderSelection = "all" | number;

export function folderQuery(selection: FolderSelection): number | undefined {
    return selection === "all" ? undefined : selection;
}

/** Read the `?folder=` of the page URL: `all` when absent or malformed. */
export function parseFolderParam(raw: string | null): FolderSelection {
    if (raw === null || raw === "" || raw === "all") return "all";
    return /^(0|[1-9][0-9]{0,9})$/.test(raw) ? Number(raw) : "all";
}
