/**
 * Verso — modelo puro del SaveStateChip (F3): el estado del pill de guardado del header, byte a
 * byte los mismos textos/orden de evaluación que el SaveStateChip del PuckEditor actual (tabla d
 * del wrapper-blueprint). El componente (SaveStateChip.tsx) solo pinta este modelo; los textos
 * salen en ES fuente y el componente los pasa por trStr — así la tripleta es/en/pt existente
 * sigue aplicando sin tocar el diccionario.
 */

export interface SaveChipInputs {
    saving: boolean;
    hasChanges: boolean;
    /** Estado editorial del registro (draft/publish/pending). */
    status: string;
    /** Timestamp (ms) del último guardado exitoso, o null si no hubo ninguno en esta sesión. */
    savedAtMs: number | null;
    /** true si ese último guardado fue un autosave. */
    wasAuto: boolean;
    /** Reloj inyectable (tests). */
    nowMs: number;
}

export interface SaveChipModel {
    /** Glifo Material Symbols (subset) o null si el chip no muestra nada aún. */
    icon: "sync" | "cloud_upload" | "cloud_done" | null;
    /** true → el icono gira (guardando). */
    spin: boolean;
    /** true → glifo relleno (guardado). */
    fill: boolean;
    /**
     * Texto ES FUENTE con el placeholder {m} SIN interpolar: el componente traduce PRIMERO
     * (trStr matchea el literal ES entero, "Guardado hace {m}m" incluido — igual que hoy) y
     * sustituye {m} DESPUÉS con `minutes`.
     */
    text: string;
    /** Minutos a interpolar en {m}, o null cuando el texto no lo lleva. */
    minutes: number | null;
    /** Clase de color del contenedor — mismos literales que el chip actual. */
    cls: string;
}

/** Orden de evaluación EXACTO del chip actual: saving → hasChanges → savedAt → vacío. */
export function saveChipModel(i: SaveChipInputs): SaveChipModel {
    if (i.saving) {
        return { icon: "sync", spin: true, fill: false, text: "Guardando…", minutes: null, cls: "text-[var(--ed-outline)]" };
    }
    if (i.hasChanges) {
        return {
            icon: "cloud_upload",
            spin: false,
            fill: false,
            text: i.status === "draft" ? "Sin guardar" : "Cambios sin publicar",
            minutes: null,
            cls: "text-amber-700",
        };
    }
    if (i.savedAtMs !== null) {
        const mins = Math.max(0, Math.round((i.nowMs - i.savedAtMs) / 60000));
        const text =
            mins < 1
                ? (i.wasAuto ? "Autoguardado" : "Guardado")
                : (i.wasAuto ? "Autoguardado hace {m}m" : "Guardado hace {m}m");
        return {
            icon: "cloud_done",
            spin: false,
            fill: true,
            text,
            minutes: mins < 1 ? null : mins,
            cls: "text-[var(--ed-outline)]",
        };
    }
    return { icon: null, spin: false, fill: false, text: "", minutes: null, cls: "text-[var(--ed-outline)]" };
}
