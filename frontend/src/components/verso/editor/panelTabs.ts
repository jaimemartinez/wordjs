/**
 * Verso — partición de campos en las 3 pestañas del panel de propiedades (Contenido/Estilo/
 * Avanzado), F3.
 *
 * MECANISMO (equivalencia documentada con el editor legacy, ya retirado): PuckEditor renderizaba UNA lista plana
 * de campos y la parte con CSS `:has()` sobre las clases marcador que solo llevan los 3 controles
 * compartidos (`.wjs-f-look` → Estilo; `.wjs-f-anim`/`.wjs-f-hide` → Avanzado; el resto →
 * Contenido — ver editor-theme.css [data-ptab]). En Verso el panel renderiza los campos él mismo
 * (VersoFieldControl por entrada), así que el filtrado se hace EXPLÍCITO por clave de campo — el
 * resultado visual es idéntico por construcción: hoy esas clases marcador viven exclusivamente en
 * VisibilityControl (`hide`), AnimationControl (`anim`) y AppearanceControl (`look`), los tres
 * campos que withSharedVersoFields inyecta bajo exactamente esas claves (verificado por grep:
 * VisibilityField.tsx L35, AnimationField.tsx L73, AppearanceField.tsx L174 son los únicos
 * emisores). Si F4 trae bloques de plugin con marcadores en campos propios, este módulo es el
 * único punto a extender (p.ej. inspección del render), no el panel.
 */
import type { VersoField } from "@/lib/verso/registry";

export type PanelTab = "content" | "style" | "advanced";

/** Claves de campo que el panel muestra en la pestaña Estilo. */
export const STYLE_FIELD_KEYS: readonly string[] = ["look"];

/** Claves de campo que el panel muestra en la pestaña Avanzado. */
export const ADVANCED_FIELD_KEYS: readonly string[] = ["anim", "hide"];

/** Pestaña a la que pertenece una clave de campo (todo lo no compartido es Contenido). */
export function tabOfFieldKey(key: string): PanelTab {
    if (STYLE_FIELD_KEYS.includes(key)) return "style";
    if (ADVANCED_FIELD_KEYS.includes(key)) return "advanced";
    return "content";
}

export type FieldEntry = [string, VersoField];

/** Los campos de una definición repartidos por pestaña, preservando el orden de declaración. */
export function partitionFieldEntries(
    fields: Record<string, VersoField>,
): Record<PanelTab, FieldEntry[]> {
    const out: Record<PanelTab, FieldEntry[]> = { content: [], style: [], advanced: [] };
    for (const entry of Object.entries(fields)) out[tabOfFieldKey(entry[0])].push(entry);
    return out;
}

export interface TabAvailability {
    content: true;
    style: boolean;
    advanced: boolean;
}

/**
 * Disponibilidad de pestañas (las vacías se DESHABILITAN, nunca muestran un panel hueco — misma
 * regla que el probe DOM del PuckEditor legacy). Contenido siempre está disponible: es el
 * fallback al que vuelve la pestaña activa si la selección cambia a un bloque sin ese grupo.
 */
export function tabAvailability(fields: Record<string, VersoField>): TabAvailability {
    const parts = partitionFieldEntries(fields);
    return { content: true, style: parts.style.length > 0, advanced: parts.advanced.length > 0 };
}
