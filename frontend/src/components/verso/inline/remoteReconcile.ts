/**
 * Verso — RECONCILIACIÓN DEL CARET cuando el texto cambia por debajo (F8.4). Lógica PURA.
 *
 * Escenario: estás escribiendo dentro de un bloque y llega la edición de otra persona SOBRE EL
 * MISMO párrafo. La fusión la hace el CRDT; lo que queda por resolver es de cortesía pero
 * imprescindible: si al repintar el editable el caret vuelve al principio, no se puede escribir a
 * la vez aunque el texto converja perfectamente.
 *
 * QUÉ SE HACE, y por qué es correcto sin hablar con el CRDT: el texto ajeno no es un cambio
 * arbitrario, es una edición local en algún punto. Se calculan el PREFIJO y el SUFIJO comunes entre
 * el texto viejo y el nuevo (exactamente el mismo razonamiento que el diff del puente) y:
 *  · caret ANTES de la zona tocada  → no se mueve (escribían más abajo);
 *  · caret DESPUÉS de la zona tocada → se desplaza por la diferencia de longitud (escribían más
 *    arriba: tu palabra sigue siendo tu palabra, solo que N caracteres más allá);
 *  · caret DENTRO de la zona tocada  → se clampa al borde de la zona. Es el único caso ambiguo (te
 *    han reescrito justo donde estabas) y se prefiere quedarse dentro a saltar al final.
 *
 * Las posiciones son OFFSETS PLANOS del documento (unidades: un carácter cuenta 1, un `br` cuenta 1
 * y el salto entre párrafos cuenta 1) — el mismo espacio en el que se mueve `DocPoint`, así que la
 * conversión de ida y vuelta es exacta.
 */

import { listParas, paraLength, type DocPoint, type DocSelection, type RichDoc } from "@/lib/verso/inline-engine";

/**
 * Texto plano del documento en el espacio de offsets de `DocPoint`: un `br` ocupa una posición y
 * la frontera entre párrafos, otra. No es para enseñárselo a nadie — es para diffear con la
 * garantía de que un índice aquí es un índice allí.
 */
export function flatText(doc: RichDoc): string {
    return listParas(doc)
        .map(({ para }) => para.units.map((u) => (u.kind === "br" ? "\n" : u.text)).join(""))
        .join("\n");
}

/** Offset plano de un punto del documento. Fuera de rango se clampa (jamás lanza). */
export function pointToOffset(doc: RichDoc, point: DocPoint): number {
    const paras = listParas(doc);
    let acc = 0;
    for (let i = 0; i < paras.length; i++) {
        const p = paras[i];
        const len = paraLength(p.para);
        if (p.addr.block === point.block && p.addr.item === point.item) {
            return acc + Math.max(0, Math.min(point.offset, len));
        }
        acc += len + 1; // +1 = la frontera entre párrafos
    }
    return Math.max(0, Math.min(point.offset, acc));
}

/** Punto del documento en un offset plano. Siempre devuelve un punto VÁLIDO del `doc` dado. */
export function offsetToPoint(doc: RichDoc, offset: number): DocPoint {
    const paras = listParas(doc);
    if (paras.length === 0) return { block: 0, item: null, offset: 0 };
    let left = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));
    for (let i = 0; i < paras.length; i++) {
        const len = paraLength(paras[i].para);
        if (left <= len || i === paras.length - 1) {
            return { ...paras[i].addr, offset: Math.min(left, len) };
        }
        left -= len + 1;
    }
    const last = paras[paras.length - 1];
    return { ...last.addr, offset: paraLength(last.para) };
}

/** Longitud del prefijo común de dos cadenas. */
export function commonPrefix(a: string, b: string): number {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i]) i++;
    return i;
}

/** Longitud del sufijo común, sin solaparse con el prefijo ya contado. */
export function commonSuffix(a: string, b: string, prefix: number): number {
    const max = Math.min(a.length, b.length) - prefix;
    let i = 0;
    while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
}

/** Traslada un offset del texto viejo al nuevo (ver la cabecera para el criterio). */
export function mapOffset(oldText: string, newText: string, offset: number): number {
    const caret = Math.max(0, Math.min(offset, oldText.length));
    if (oldText === newText) return caret;
    const pre = commonPrefix(oldText, newText);
    const suf = commonSuffix(oldText, newText, pre);
    if (caret <= pre) return caret;
    if (caret >= oldText.length - suf) return caret + (newText.length - oldText.length);
    return Math.max(pre, Math.min(caret, newText.length - suf));
}

/**
 * Traslada una selección de modelo del documento viejo al nuevo. `null` ⇒ no había selección que
 * conservar y el llamador decide (la superficie pone el caret al final).
 */
export function reconcileSelection(
    oldDoc: RichDoc,
    newDoc: RichDoc,
    sel: DocSelection | null,
): DocSelection | null {
    if (!sel) return null;
    const oldFlat = flatText(oldDoc);
    const newFlat = flatText(newDoc);
    const anchor = mapOffset(oldFlat, newFlat, pointToOffset(oldDoc, sel.anchor));
    const focus = mapOffset(oldFlat, newFlat, pointToOffset(oldDoc, sel.focus));
    return { anchor: offsetToPoint(newDoc, anchor), focus: offsetToPoint(newDoc, focus) };
}
