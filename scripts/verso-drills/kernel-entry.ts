/**
 * VERSO F7 — punto de entrada del bundle que usan los drills.
 *
 * Re-exporta el código REAL del editor (nada se reimplementa aquí): el kernel del
 * documento (normalize/commands), el motor de texto inline y el saneador compartido.
 * `_common.cjs#loadKernel()` lo compila con esbuild a un CJS para node.
 *
 * Lo ÚNICO propio de este fichero es `htmlToText`, el sustituto en node de
 * `div.innerHTML = html; div.textContent` que hace el guard fail-closed de
 * VersoTextSurface (línea ~565). Se implementa con htmlparser2 — el MISMO parser que
 * usa sanitize-html por debajo — porque en node no hay DOM.
 */

import { Parser } from "htmlparser2";

export * from "../../frontend/src/lib/verso/normalize";
export * from "../../frontend/src/lib/verso/commands";
export { CONTENT_META_KEY, ROOT_ID, ROOT_SLOT } from "../../frontend/src/lib/verso/types";
export type {
    SlotResolver,
    VersoCommand,
    VersoData,
    VersoDoc,
    VersoItem,
    VersoNode,
} from "../../frontend/src/lib/verso/types";
export * from "../../frontend/src/lib/verso/inline-engine";
export { sanitizeHTML } from "../../frontend/src/lib/sanitize";

/**
 * Texto plano de un fragmento HTML, equivalente al `textContent` del DOM: concatena
 * TODOS los nodos de texto en orden, sin separadores añadidos y con entidades ya
 * decodificadas (htmlparser2 decodifica por defecto). `<script>`/`<style>` ya no
 * existen en la entrada del guard (pasa por sanitizeHTML antes), así que no se
 * excluyen aquí — igual que hace textContent, que sí los incluiría.
 */
export function htmlToText(html: string): string {
    let out = "";
    const parser = new Parser(
        { ontext(t: string) { out += t; } },
        { decodeEntities: true },
    );
    parser.write(html);
    parser.end();
    return out;
}
