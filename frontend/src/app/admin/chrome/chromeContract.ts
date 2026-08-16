"use client";

// Funciones puras del contrato del editor de chrome, MOVIDAS byte-idénticas desde page.tsx
// (unificación Verso, ver documentation/verso/chrome-oracle.md §6): ambos motores (legacy y Verso)
// comparten UNA implementación y los tests de wiring ejercitan el productor REAL, no una copia.
// `saveChromeComposition` es el seam espiable del PUT — misma llamada 1:1 que hacía page.tsx.

// La forma persistida `{ content, root }` — el mismo tipo que exponía el fork, ahora propio.
import type { VersoData as Data } from "@/lib/verso/types";
import { chromeApi, type ChromePart } from "@/lib/api";
import type { ChromeBlock, ChromeData } from "@/lib/chromeData";

// Puck keys every block instance by a stable string props.id; theme files / starter templates ship
// without ids, so stamp them once on load (the contract explicitly allows the editor's id prop).
export const genId = (type: string) =>
    `${type}-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10)}`;

export function withBlockIds(data: ChromeData): ChromeData {
    const stamp = (block: ChromeBlock): ChromeBlock => {
        const props: Record<string, unknown> = { ...(block.props || {}) };
        if (typeof props.id !== "string") props.id = genId(block.type);
        if (block.type === "ChromeRow" && Array.isArray(props.items)) {
            props.items = (props.items as ChromeBlock[]).map(stamp);
        }
        return { type: block.type, props };
    };
    return { root: { props: { ...(data.root?.props || {}) } }, content: (data.content || []).map(stamp) };
}

// The stored contract form is EXACTLY { root, content } — el documento del editor puede llevar
// extras (p.ej. una clave `zones` legacy); never persist anything beyond the contract shape.
export function toContractData(data: Data): ChromeData {
    const d = data as unknown as { root?: { props?: Record<string, unknown> }; content?: ChromeBlock[] };
    return { root: { props: d.root?.props ?? {} }, content: d.content ?? [] };
}

/**
 * El PUT del contrato — EXACTAMENTE el endpoint/forma del editor actual: chromeApi.save(part, data)
 * ⇒ PUT /api/v1/chrome/:part body { data }. El parámetro `save` existe solo para inyectar un spy en
 * tests; el default ES el cliente real.
 */
export function saveChromeComposition(
    part: ChromePart,
    contract: ChromeData,
    save: (part: ChromePart, data: unknown) => Promise<unknown> = chromeApi.save,
): Promise<unknown> {
    return save(part, contract);
}
