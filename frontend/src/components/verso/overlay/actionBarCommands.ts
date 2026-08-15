/**
 * Verso — lógica PURA del ActionBar (sin React, sin DOM): qué acciones están
 * disponibles para el bloque seleccionado y qué comandos emiten. La UI
 * (ActionBar.tsx) solo pinta y delega aquí — invariante del diseño Verso: la
 * capa de chrome JAMÁS muta el documento, solo emite comandos vía transact.
 *
 * Semántica de moveNode (commands.ts): el índice de destino es POST-remoción
 * (extraer primero, insertar después). Dentro del mismo slot: subir = index-1,
 * bajar = index+1; fuera de rango = no-op aquí (el botón va deshabilitado por
 * el modelo, y ni siquiera se abre transacción).
 */
import { ROOT_ID, type VersoDoc, type VersoNode } from "@/lib/verso/types";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry } from "@/lib/verso/registry";

export interface ActionBarModel {
    nodeId: string;
    type: string;
    /** Etiqueta legible (label del registry o el type). */
    label: string;
    canMoveUp: boolean;
    canMoveDown: boolean;
    /** true si el registry declara edición inline para este type. */
    canEditInline: boolean;
}

/** Hermanos del nodo en su slot actual (rootChildren para los de primer nivel). */
export function siblingIdsOf(doc: VersoDoc, node: VersoNode): string[] {
    if (node.parentId === ROOT_ID) return doc.rootChildren;
    return doc.nodes[node.parentId]?.slots[node.slotKey] ?? [];
}

/** Modelo del ActionBar para un nodo, o null si el nodo no existe. */
export function actionBarModel(
    doc: VersoDoc,
    registry: BlockRegistry,
    nodeId: string,
): ActionBarModel | null {
    const node = doc.nodes[nodeId];
    if (!node) return null;
    const siblings = siblingIdsOf(doc, node);
    const index = siblings.indexOf(nodeId);
    const def = registry.get(node.type);
    return {
        nodeId,
        type: node.type,
        label: def?.label ?? node.type,
        canMoveUp: index > 0,
        canMoveDown: index !== -1 && index < siblings.length - 1,
        canEditInline: !!def?.inline,
    };
}

/**
 * Mueve el bloque un puesto dentro de su slot (dir: -1 subir, +1 bajar).
 * Clamp: fuera de rango → false sin abrir transacción.
 */
export function moveSelected(handle: EditorHandle, nodeId: string, dir: -1 | 1): boolean {
    const doc = handle.getDoc();
    const node = doc.nodes[nodeId];
    if (!node) return false;
    const siblings = siblingIdsOf(doc, node);
    const index = siblings.indexOf(nodeId);
    if (index === -1) return false;
    const toIndex = index + dir;
    if (toIndex < 0 || toIndex > siblings.length - 1) return false;
    return handle.transact((tx) => tx.moveNode(nodeId, node.parentId, node.slotKey, toIndex), {
        label: dir === -1 ? "Subir bloque" : "Bajar bloque",
    });
}

/** Duplica el subárbol del bloque (se inserta justo después del original). */
export function duplicateSelected(handle: EditorHandle, nodeId: string): boolean {
    if (!handle.getDoc().nodes[nodeId]) return false;
    return handle.transact((tx) => tx.duplicateSubtree(nodeId), { label: "Duplicar bloque" });
}

/** Elimina el bloque (la selección colgante la limpia el propio store). */
export function removeSelected(handle: EditorHandle, nodeId: string): boolean {
    if (!handle.getDoc().nodes[nodeId]) return false;
    return handle.transact((tx) => tx.removeNode(nodeId), { label: "Eliminar bloque" });
}

/**
 * Abre la edición inline si el registry la declara para el type del nodo
 * (BlockDefinition.inline). false = sin declaración o nodo inexistente.
 */
export function editSelectedInline(
    handle: EditorHandle,
    registry: BlockRegistry,
    nodeId: string,
): boolean {
    const node = handle.getDoc().nodes[nodeId];
    if (!node) return false;
    if (!registry.get(node.type)?.inline) return false;
    handle.setInlineEditing(nodeId);
    return true;
}
