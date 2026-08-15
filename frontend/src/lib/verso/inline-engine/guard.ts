/**
 * Verso — motor de texto inline (F3.5): GUARD anti-pérdida de la sesión.
 *
 * Política del programa: lo que no se entiende se PRESERVA, nunca se destruye.
 * Al montar una sesión rich, la superficie compara el texto plano del HTML
 * inicial con el texto plano de lo que el pipeline entiende (parse→serialize
 * del motor puro Y la relectura DOM→modelo del walker de la superficie). Si el
 * pipeline PIERDE contenido, la sesión entra en modo SOLO LECTURA y jamás
 * emite commits — mejor un bloque no editable que un bloque destruido (el bug
 * real que motivó este guard: `instanceof Element` cross-realm en el iframe
 * del canvas dejaba el walker ciego a TODOS los elementos y el commit truncaba
 * el párrafo entero).
 *
 * Todo aquí es PURO (sin DOM): la decisión se testea en node.
 */

import type { RichDoc } from "./model";
import { listParas, paraText } from "./model";

/**
 * Normaliza texto para la comparación anti-pérdida: quita TODO el whitespace
 * (incluidos NBSP y los invisibles zero-width/word-joiner del centinela). La
 * comparación es de CONTENIDO, no de forma: el `textContent` del DOM une
 * bloques sin separador (`<li><p>a</p></li><li><p>b</p></li>` → "ab") mientras
 * el modelo los une con espacio — un guard que disparase por un espacio de
 * join sería un falso cierre de sesión.
 */
export function normalizeGuardText(s: string): string {
    // \s ya cubre NBSP/BOM/separadores de línea; U+200B (zero-width space) y
    // U+2060 (word joiner, el del centinela) NO son whitespace y van aparte.
    return s.replace(/[\s\u200b\u2060]+/gu, "");
}

/**
 * Decisión del guard: true ⇒ `after` ha PERDIDO contenido textual respecto a
 * `before` (el texto original ya no está contenido en el resultado). Con
 * `before` vacío nunca hay pérdida. Fail-closed: cualquier carácter caído en
 * cualquier posición rompe la contención y dispara el modo solo-lectura.
 */
export function inlineGuardLosesText(before: string, after: string): boolean {
    const a = normalizeGuardText(before);
    if (a.length === 0) return false;
    return !normalizeGuardText(after).includes(a);
}

/** Texto plano de un doc del motor para el guard (todos los párrafos). */
export function docGuardText(doc: RichDoc): string {
    return listParas(doc)
        .map(({ para }) => paraText(para))
        .join(" ");
}
