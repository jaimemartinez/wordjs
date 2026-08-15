/**
 * Verso — patrones (F3, checklist W19/W27): los 9 built-in compartidos + patrones de usuario.
 *
 * FUENTE ÚNICA con el legacy: `PATTERNS`, `regenIds`, `loadUserPatterns` y `deleteUserPattern`
 * se REUTILIZAN de lib/puckPatterns.ts (datos puros / localStorage genérico, sin dependencia del
 * motor viejo). Lo que este módulo aporta es la mitad acoplada al motor:
 *  - construir los items de un patrón contra el `BlockRegistry` de Verso (defaults reales del
 *    registro + overrides del patrón + id fresco, slots recursivos, tipos no registrados se
 *    saltan — misma semántica que buildPatternBlocks del legacy);
 *  - insertar vía `handle.transact` — UNA transacción por patrón = UNA entrada de undo (el
 *    equivalente del `recordHistory:true` del setData legacy);
 *  - capturar la página actual desde el HANDLE VIVO (`getData()`, sin mirrors) como patrón de
 *    usuario, con la MISMA clave (`wjs_user_patterns`), MISMA forma `{id,name,items,createdAt}`
 *    y MISMO cap de 30 que el legacy — los patrones guardados en un editor aparecen en el otro.
 */
import {
    PATTERNS,
    regenIds,
    loadUserPatterns,
    deleteUserPattern,
    type Pattern,
    type UserPattern,
} from "@/lib/puckPatterns";
import { ROOT_ID, ROOT_SLOT, type VersoItem } from "@/lib/verso/types";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry, VersoField } from "@/lib/verso/registry";

export { PATTERNS, loadUserPatterns, deleteUserPattern };
export type { Pattern, UserPattern };

/** Misma clave EXACTA que el legacy (lib/puckPatterns.ts USER_PATTERNS_KEY). */
export const USER_PATTERNS_KEY = "wjs_user_patterns";

/** Cap de patrones de usuario — el mismo `slice(0, 30)` del legacy. */
export const USER_PATTERNS_MAX = 30;

/* Los tipos de `Pattern.blocks` no están exportados por puckPatterns (PatternBlock es interno);
 * esta forma estructural es idéntica y solo se usa para recorrerlos. */
interface PatternBlockShape {
    type: string;
    props?: Record<string, unknown>;
    slots?: Record<string, PatternBlockShape[]>;
}

let fallbackCounter = 0;
function freshId(type: string): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === "function") return `${type}-${c.randomUUID()}`;
    fallbackCounter += 1;
    return `${type}-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

/**
 * Construye los items de un patrón contra el registry de Verso: defaults reales del bloque +
 * overrides del patrón + id fresco; los `slots` declarados en el patrón se construyen
 * recursivamente y los slots declarados por el registro que falten se materializan como `[]`
 * (mismo criterio que la inserción normal del VersoEditor: un contenedor recién insertado
 * siempre tiene zona de drop). Tipos no registrados se saltan (paridad con buildPatternBlocks).
 */
export function buildVersoPatternItems(pattern: Pattern, registry: BlockRegistry): VersoItem[] {
    const build = (b: PatternBlockShape): VersoItem | null => {
        const def = registry.get(b.type);
        if (!def) return null;
        let defaults: Record<string, unknown>;
        try {
            defaults = structuredClone(def.defaultProps);
        } catch {
            defaults = { ...def.defaultProps };
        }
        const props: VersoItem["props"] = { ...defaults, ...(b.props ?? {}), id: freshId(b.type) };
        for (const [slot, children] of Object.entries(b.slots ?? {})) {
            props[slot] = (children ?? []).map(build).filter((c): c is VersoItem => c !== null);
        }
        for (const [fieldKey, field] of Object.entries(def.fields) as [string, VersoField][]) {
            if (field.type === "slot" && !(fieldKey in props)) props[fieldKey] = [];
        }
        return { type: b.type, props };
    };
    return (pattern.blocks as PatternBlockShape[]).map(build).filter((i): i is VersoItem => i !== null);
}

/**
 * Añade items ya construidos al FINAL de la página: UNA transacción con N insertNode = UNA
 * entrada de historia (un solo Ctrl+Z revierte el patrón completo).
 */
export function insertItemsAtEnd(handle: EditorHandle, items: VersoItem[], label: string): boolean {
    if (items.length === 0) return false;
    const base = handle.getDoc().rootChildren.length;
    return handle.transact(
        (tx) => {
            items.forEach((item, i) => tx.insertNode(item, ROOT_ID, ROOT_SLOT, base + i));
        },
        { label },
    );
}

/** Inserta un patrón built-in al final de la página (ids frescos, un solo undo). */
export function insertVersoPattern(handle: EditorHandle, registry: BlockRegistry, pattern: Pattern): boolean {
    return insertItemsAtEnd(handle, buildVersoPatternItems(pattern, registry), `Insertar patrón ${pattern.id}`);
}

/**
 * Inserta un patrón de usuario: salta tipos no registrados y REGENERA todos los ids (recursivo,
 * slots incluidos — el mismo regenIds del legacy) para que repetir nunca colisione.
 */
export function insertVersoUserPattern(handle: EditorHandle, registry: BlockRegistry, p: UserPattern): boolean {
    const items = (p.items ?? [])
        .filter((i): i is VersoItem => !!i && typeof i === "object" && !!registry.get((i as VersoItem).type))
        .map((i) => regenIds(i) as VersoItem);
    return insertItemsAtEnd(handle, items, `Insertar plantilla ${p.name}`);
}

function persistUserPatterns(list: UserPattern[]): boolean {
    try {
        localStorage.setItem(USER_PATTERNS_KEY, JSON.stringify(list));
        return true;
    } catch {
        return false; // storage lleno/bloqueado
    }
}

/**
 * Captura la página ACTUAL (handle vivo, `getData()` — sin mirrors) como patrón de usuario:
 * misma forma `{id,name,items,createdAt}` y mismo cap 30 (más nuevo primero) que el legacy.
 * Devuelve null con lienzo vacío o storage bloqueado.
 */
export function saveDocAsPattern(handle: EditorHandle, name: string): UserPattern | null {
    const items = handle.getData().content.filter((i) => i && i.type && i.props);
    if (!items.length) return null;
    const pattern: UserPattern = {
        id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim() || "Mi plantilla",
        items,
        createdAt: new Date().toISOString(),
    };
    const list = loadUserPatterns();
    list.unshift(pattern);
    return persistUserPatterns(list.slice(0, USER_PATTERNS_MAX)) ? pattern : null;
}
