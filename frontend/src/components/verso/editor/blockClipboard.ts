/**
 * Verso — clipboard de BLOQUES y de ESTILOS (F3, checklist W03 Ctrl+C/V + W26).
 *
 * INTEROP CROSS-EDITOR (contrato duro): mismas claves de localStorage y MISMA forma
 * que el editor legacy (PuckEditor.tsx L46-59):
 *  - `wjs_block_clipboard`  → UN item Puck crudo `{ type, props: { id, ... } }` con los hijos
 *    anidados como arrays DENTRO de props (slots) — exactamente lo que `subtreeToItem` serializa
 *    y lo que `selectedItem` del motor viejo escribe. Un bloque copiado en el editor legacy pega
 *    en Verso y viceversa: la clave compartida lo da gratis; este módulo solo garantiza la
 *    validación (`item.type && item.props`, la del legacy) y la REGENERACIÓN de ids al pegar.
 *  - `wjs_style_clipboard`  → `{ look, anim, hide }` (los 3 props compartidos de
 *    withSharedBlockFields/withSharedVersoFields), misma forma que la acción "Copiar estilos"
 *    del legacy (paletteActions copy-styles/paste-styles).
 *
 * Los ids del pegado se regeneran RECURSIVAMENTE (slots incluidos) con el MISMO `regenIds` del
 * legacy (lib/puckPatterns.ts — puro, sin dependencias): semántica idéntica byte-a-byte, ningún
 * id repetido aunque se pegue N veces el mismo clipboard.
 *
 * Toda mutación va vía `handle.transact` — UNA transacción = UNA entrada de undo. Este módulo
 * jamás toca el doc directamente (invariante Verso: el chrome solo emite comandos).
 */
import { regenIds } from "@/lib/puckPatterns";
import { subtreeToItem } from "@/lib/verso/commands";
import { ROOT_ID, ROOT_SLOT, type VersoItem } from "@/lib/verso/types";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry } from "@/lib/verso/registry";

/** Clave EXACTA del legacy (PuckEditor.tsx BLOCK_CLIPBOARD_KEY). */
export const BLOCK_CLIPBOARD_KEY = "wjs_block_clipboard";
/** Clave EXACTA del legacy (PuckEditor.tsx STYLE_CLIPBOARD_KEY). */
export const STYLE_CLIPBOARD_KEY = "wjs_style_clipboard";

/** Forma del clipboard de estilos — la misma tripleta que escribe el legacy. */
export interface StyleClipboardPayload {
    look: Record<string, unknown>;
    anim: Record<string, unknown>;
    hide: Record<string, unknown>;
}

export function writeBlockClipboard(item: VersoItem): boolean {
    try {
        localStorage.setItem(BLOCK_CLIPBOARD_KEY, JSON.stringify(item));
        return true;
    } catch {
        return false; // storage lleno/bloqueado — mismo fail-soft que el legacy
    }
}

/** Lee y valida con el MISMO criterio del legacy: `item && item.type && item.props`. */
export function readBlockClipboard(): VersoItem | null {
    try {
        const raw = localStorage.getItem(BLOCK_CLIPBOARD_KEY);
        const item = raw ? (JSON.parse(raw) as VersoItem) : null;
        return item && item.type && item.props ? item : null;
    } catch {
        return null;
    }
}

/**
 * Ctrl+C — serializa el SUBTREE del bloque seleccionado (hijos de slots anidados incluidos) como
 * item Puck crudo y lo escribe al clipboard compartido. No toca el documento ni la historia.
 */
export function copySelectedSubtree(handle: EditorHandle): boolean {
    const id = handle.getState().selection.nodeId;
    if (!id || !handle.getDoc().nodes[id]) return false;
    return writeBlockClipboard(subtreeToItem(handle.getDoc(), id));
}

/**
 * Ctrl+V — pega el clipboard con ids FRESCOS regenerados recursivamente: tras la selección (en su
 * mismo slot del padre) o al final de la raíz si no hay selección. UNA transacción = un undo.
 * Devuelve el id nuevo del bloque raíz pegado, o null si no había clipboard válido / el tipo no
 * está registrado en este editor / la transacción no se aplicó.
 */
export function pasteFromClipboard(handle: EditorHandle, registry: BlockRegistry): string | null {
    const clip = readBlockClipboard();
    if (!clip) return null;
    if (!registry.get(clip.type)) return null; // tipo no disponible en este config (paridad legacy)
    const item = regenIds(clip) as VersoItem;
    const doc = handle.getDoc();
    const selectedId = handle.getState().selection.nodeId;
    const node = selectedId ? doc.nodes[selectedId] : undefined;
    const parentId = node ? node.parentId : ROOT_ID;
    const slotKey = node ? node.slotKey : ROOT_SLOT;
    const index = node ? node.index + 1 : doc.rootChildren.length;
    const ok = handle.transact((tx) => tx.insertNode(item, parentId, slotKey, index), {
        label: `Pegar ${item.type}`,
    });
    return ok ? item.props.id : null;
}

/**
 * Acción de paleta "Copiar estilos del bloque": escribe `{look, anim, hide}` del bloque
 * seleccionado (defaults `{}` como el legacy) en `wjs_style_clipboard`.
 */
export function copyStylesFromSelected(handle: EditorHandle): boolean {
    const id = handle.getState().selection.nodeId;
    const node = id ? handle.getDoc().nodes[id] : undefined;
    if (!node) return false;
    const asRecord = (v: unknown): Record<string, unknown> =>
        typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    const payload: StyleClipboardPayload = {
        look: asRecord(node.props.look),
        anim: asRecord(node.props.anim),
        hide: asRecord(node.props.hide),
    };
    try {
        localStorage.setItem(STYLE_CLIPBOARD_KEY, JSON.stringify(payload));
        return true;
    } catch {
        return false;
    }
}

/**
 * Acción de paleta "Pegar estilos en el bloque": aplica la tripleta del clipboard vía setProps
 * (solo las claves look/anim/hide — nunca contenido). UNA transacción = un undo.
 */
export function pasteStylesToSelected(handle: EditorHandle): boolean {
    const id = handle.getState().selection.nodeId;
    if (!id || !handle.getDoc().nodes[id]) return false;
    let parsed: unknown;
    try {
        const raw = localStorage.getItem(STYLE_CLIPBOARD_KEY);
        if (!raw) return false;
        parsed = JSON.parse(raw);
    } catch {
        return false; // clipboard malformado — mismo fail-soft que el legacy
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const src = parsed as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of ["look", "anim", "hide"] as const) {
        if (k in src) patch[k] = src[k];
    }
    if (Object.keys(patch).length === 0) return false;
    return handle.transact((tx) => tx.setProps(id, patch), { label: "Pegar estilos" });
}
