/**
 * Verso — auditoría de accesibilidad del canvas (F3, checklist W20/W25).
 *
 * Las 7 reglas NO se duplican: viven en components/editor/A11yAudit.tsx (fuente única, puras
 * sobre el Document que reciben) y aquí solo se RE-APUNTAN los atributos del motor:
 *  - bloque raíz: `data-wjs-block-id` (lo estampa VersoBlock) en vez del `data-puck-component`
 *    del fork — cada issue mapea a su bloque Verso y el click lo selecciona con handle.select(id)
 *    directamente (el id del atributo ES la clave del nodo: sin zona compuesta ni store interno,
 *    a diferencia del selectBlockById del legacy).
 *  - scaffolding: en Verso el overlay/DnD vive en el documento PADRE (no dentro del iframe), así
 *    que dentro del canvas solo quedan los artefactos de guías (#wjs-guides /
 *    #wjs-spacing-overlay, mismos ids que el legacy — el EDITOR_OVERLAY_SELECTOR compartido ya
 *    los salta). `data-verso-scaffold` queda reservado por si algún elemento del motor entrara
 *    al iframe en el futuro; hoy ningún nodo lo lleva.
 */
import { runA11yAudit, type A11yIssue } from "@/components/editor/A11yAudit";

/** El atributo que VersoBlock estampa en la raíz de cada bloque dentro del iframe. */
export const VERSO_BLOCK_ATTR = "data-wjs-block-id";

/** Atributo reservado para scaffolding del motor dentro del canvas (hoy sin emisores). */
export const VERSO_SCAFFOLD_ATTR = "data-verso-scaffold";

/** Las 7 reglas del audit compartido, mapeando cada issue a su bloque Verso. */
export function runVersoA11yAudit(doc: Document): A11yIssue[] {
    return runA11yAudit(doc, { blockAttr: VERSO_BLOCK_ATTR, scaffoldAttr: VERSO_SCAFFOLD_ATTR });
}

export type { A11yIssue };
