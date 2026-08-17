/**
 * Verso — partición de campos en las 3 pestañas del panel de propiedades (Contenido/Estilo/
 * Avanzado), F3.
 *
 * MECANISMO (equivalencia documentada con el editor legacy, ya retirado): PuckEditor renderizaba UNA lista plana
 * de campos y la parte con CSS `:has()` sobre las clases marcador que solo llevan los 3 controles
 * compartidos (`.wjs-f-look` → Estilo; `.wjs-f-anim`/`.wjs-f-hide` → Avanzado; el resto →
 * Contenido — ver editor-theme.css [data-ptab]). Desde el dock de movimiento, `anim` ya no es una
 * pestaña del inspector: vive abajo, junto a las interacciones (DOCK_FIELD_KEYS).
 * En Verso el panel renderiza los campos él mismo
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
export const ADVANCED_FIELD_KEYS: readonly string[] = ["hide"];

/**
 * Claves que viven en el DOCK inferior de movimiento (junto al panel de interacciones), NO en el
 * inspector derecho: el reparto las salta y `dockFieldEntries` las entrega al dock. La animación de
 * entrada y las interacciones son la misma preocupación de autor — el movimiento — y comparten
 * panel propio con el ancho que el timeline necesita.
 */
export const DOCK_FIELD_KEYS: readonly string[] = ["anim"];

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
    for (const entry of Object.entries(fields)) {
        // Los campos del dock no pertenecen a NINGUNA pestaña: renderizarlos también en el
        // inspector duplicaría el control y las dos copias pelearían por el mismo prop.
        if (DOCK_FIELD_KEYS.includes(entry[0])) continue;
        out[tabOfFieldKey(entry[0])].push(entry);
    }
    return out;
}

/** Los campos que el DOCK inferior renderiza, preservando el orden de declaración. */
export function dockFieldEntries(fields: Record<string, VersoField>): FieldEntry[] {
    return Object.entries(fields).filter(([key]) => DOCK_FIELD_KEYS.includes(key));
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
