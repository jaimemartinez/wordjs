/**
 * Verso — flujo de guardado del wrapper (F3), extraído puro para poder verificar el CABLEADO de
 * los guards con un onSave espiado (checklist A: W10/W11/W50) sin montar el componente.
 *
 * El contrato es el del PuckEditor legacy (retirado), delegado en lib/autosavePolicy.ts:
 *  - onSave devuelve Promise<boolean|void>: `false` = bloqueado/fallido (unhydratedSaveBlocked,
 *    validación, error de red) → NO se estampa savedAt ni se muestra toast; true/void = éxito.
 *  - El autosave pasa EXACTAMENTE `{autosave:true}` (buildAutosaveSaveOptions) — el backend salta
 *    el snapshot de revisión con ese flag — y traga excepciones (el próximo guardado manual
 *    reporta el error real).
 */
import { buildAutosaveSaveOptions, didSaveSucceed } from "@/lib/autosavePolicy";

export type OnSave = (opts?: { autosave?: boolean }) => boolean | void | Promise<boolean | void>;

/**
 * Guardado MANUAL: true si el guardado aterrizó (el llamador estampa savedAt + toast).
 * Un onSave que lanza se propaga: el padre ya alertó/loggeó; el chrome no debe celebrar.
 */
export async function runManualSave(onSave: OnSave): Promise<boolean> {
    const ok = await onSave();
    return didSaveSucceed(ok);
}

/**
 * Guardado de FONDO (autosave): true si aterrizó. Nunca lanza — un fallo de red en background no
 * debe romper nada ni alertar (mismo try/catch silencioso que el efecto actual).
 */
export async function runBackgroundSave(onSave: OnSave): Promise<boolean> {
    try {
        const ok = await onSave(buildAutosaveSaveOptions());
        return didSaveSucceed(ok);
    } catch {
        return false;
    }
}
