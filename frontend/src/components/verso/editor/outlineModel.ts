/**
 * Verso — modelo puro del outline ("Estructura", F3): aplana el documento normalizado a filas
 * {id, depth, label, ms} en orden de documento (pre-orden, slots en su orden de declaración).
 * La vista (OutlineTree en VersoEditor) solo pinta filas y delega la selección en handle.select —
 * selección sincronizada en ambos sentidos: click en fila → select; selección del canvas → fila
 * resaltada (la vista lee state.selection).
 */
import { ROOT_ID, type VersoDoc } from "@/lib/verso/types";
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
        });
        for (const slotKey of Object.keys(node.slots)) {
            for (const childId of node.slots[slotKey]) visit(childId, depth + 1);
        }
    };
    for (const id of doc.rootChildren) visit(id, 0);
    // Sanidad: la raíz nunca se lista (ROOT_ID es un pseudo-nodo, no un bloque).
    return rows.filter((r) => r.id !== ROOT_ID);
}
