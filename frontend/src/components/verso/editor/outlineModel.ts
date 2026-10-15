/**
 * Verso — modelo puro del outline ("Estructura", F3): aplana el documento normalizado a filas
 * {id, depth, label, ms} en orden de documento (pre-orden, slots en su orden de declaración).
 * La vista (OutlineTree en VersoEditor) solo pinta filas y delega la selección en handle.select —
 * selección sincronizada en ambos sentidos: click en fila → select; selección del canvas → fila
 * resaltada (la vista lee state.selection).
 */
import { ROOT_ID, type VersoDoc, type VersoNode } from "@/lib/verso/types";
import type { BlockRegistry } from "@/lib/verso/registry";
import { BLOCK_META } from "@/lib/blockCatalog";

export interface OutlineRow {
    id: string;
    /** Profundidad (0 = hijo directo de la raíz). */
    depth: number;
    /** Label legible: label del registry, si no el type. */
    label: string;
    /** Glifo Material Symbols del catálogo compartido (fallback "widgets", como el inserter). */
    ms: string;
    /** Clave del slot del padre en el que vive (para rotular grupos anidados si hiciera falta). */
    slotKey: string;
    /** Bloques hijos directos (todos sus slots): >0 = la fila se puede plegar. */
    childCount: number;
}

/** Filas del outline en orden de documento. Nodos con type desconocido se listan igual (fail-soft). */
export function outlineRows(doc: VersoDoc, registry: BlockRegistry): OutlineRow[] {
    const rows: OutlineRow[] = [];
    const visit = (id: string, depth: number): void => {
        const node = doc.nodes[id];
        if (!node) return;
        const def = registry.get(node.type);
        rows.push({
            id,
            depth,
            label: def?.label ?? node.type,
            ms: BLOCK_META[node.type]?.ms || "widgets",
            slotKey: node.slotKey,
            childCount: Object.values(node.slots).reduce((n, ids) => n + ids.length, 0),
        });
        for (const slotKey of Object.keys(node.slots)) {
            for (const childId of node.slots[slotKey]) visit(childId, depth + 1);
        }
    };
    for (const id of doc.rootChildren) visit(id, 0);
    // Sanidad: la raíz nunca se lista (ROOT_ID es un pseudo-nodo, no un bloque).
    return rows.filter((r) => r.id !== ROOT_ID);
}

/**
 * Filas visibles con algunos nodos PLEGADOS: se omiten los descendientes de cada id de `collapsed`
 * (las filas van en pre-orden, así que un descendiente es toda fila siguiente más profunda).
 */
export function visibleOutlineRows(rows: OutlineRow[], collapsed: ReadonlySet<string>): OutlineRow[] {
    if (collapsed.size === 0) return rows;
    const out: OutlineRow[] = [];
    let hideDeeperThan = Infinity;
    for (const row of rows) {
        if (row.depth > hideDeeperThan) continue;
        hideDeeperThan = Infinity;
        out.push(row);
        if (row.childCount > 0 && collapsed.has(row.id)) hideDeeperThan = row.depth;
    }
    return out;
}

export interface AncestorCrumb {
    id: string;
    label: string;
}

/**
 * Cadena de contenedores del nodo, de la raíz hacia él, INCLUIDO el propio nodo (la ruta de la
 * selección: «Sección › Columnas › Tarjeta»). Vacía si el nodo no existe. Corta ante un ciclo.
 */
export function ancestorChain(doc: VersoDoc, registry: BlockRegistry, nodeId: string): AncestorCrumb[] {
    const chain: AncestorCrumb[] = [];
    const seen = new Set<string>();
    let id: string | undefined = nodeId;
    while (id && id !== ROOT_ID && !seen.has(id)) {
        seen.add(id);
        const node: VersoNode | undefined = doc.nodes[id];
        if (!node) break;
        chain.unshift({ id, label: registry.get(node.type)?.label ?? node.type });
        id = node.parentId;
    }
    return chain;
}
