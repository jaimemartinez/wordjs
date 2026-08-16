/**
 * Verso — auditoría de accesibilidad del canvas (F3, checklist W20/W25).
 *
 * Las 7 reglas NO se duplican: viven en components/editor/A11yAudit.tsx (fuente única, puras sobre
 * el Document que reciben). Hasta la retirada del fork ese módulo aceptaba los nombres de atributo
 * como PARÁMETRO (su default eran los del motor viejo y aquí se sobreescribían); borrado el motor
 * viejo no hay segundo llamador, así que los atributos de Verso son ya los suyos por defecto y este
 * módulo queda como el punto de entrada del editor:
 *  - bloque raíz: `data-wjs-block-id` (lo estampa VersoBlock) — cada issue mapea a su bloque y el
 *    click lo selecciona con handle.select(id) directamente (el id del atributo ES la clave del
 *    nodo: sin zona compuesta ni store interno).
 *  - scaffolding: el overlay/DnD vive en el documento PADRE (no dentro del iframe), así que dentro
 *    del canvas solo quedan los artefactos de guías (#wjs-guides / #wjs-spacing-overlay), que el
 *    EDITOR_OVERLAY_SELECTOR compartido ya salta. `data-verso-scaffold` queda reservado por si
 *    algún elemento del motor entrara al iframe en el futuro; hoy ningún nodo lo lleva.
 */
import { runA11yAudit, type A11yIssue } from "@/components/editor/A11yAudit";
import { BLOCK_ATTR, SCAFFOLD_ATTR } from "@/components/editor/canvasGuides";

/** El atributo que VersoBlock estampa en la raíz de cada bloque dentro del iframe. */
export const VERSO_BLOCK_ATTR = BLOCK_ATTR;

/** Atributo reservado para scaffolding del motor dentro del canvas (hoy sin emisores). */
export const VERSO_SCAFFOLD_ATTR = SCAFFOLD_ATTR;

/** Las 7 reglas del audit compartido, mapeando cada issue a su bloque. */
export function runVersoA11yAudit(doc: Document): A11yIssue[] {
    return runA11yAudit(doc);
}

export type { A11yIssue };
