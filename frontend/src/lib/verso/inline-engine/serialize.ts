/**
 * Verso — motor de texto inline (F3.5): serialización CANÓNICA a HTML (spec §1).
 *
 * Todo `onContent(raw)` en schema rich emite EXACTAMENTE esta forma:
 * - Subset p/br/strong/em/a[href,target,rel]/ul/ol/li (li>p, D5).
 * - Orden canónico de anidamiento strong > em > a (§1.2.2) con fusión voraz
 *   (§1.2.3): la agrupación se hace nivel a nivel — runs adyacentes que
 *   comparten la marca del nivel se envuelven en UNA sola etiqueta y se
 *   recurre hacia dentro.
 * - Doc vacío → "" (§1.2.1); `<p></p>` intermedio sí se emite.
 * - Texto byte a byte, escapado &/</> (comillas solo en atributos).
 * - `target="_blank"` solo con newTab, y entonces SIEMPRE
 *   rel="noopener noreferrer" — punto fijo de sanitizeHTML (§1.2.7, D11).
 * - `<br>` sin auto-cierre.
 *
 * `serializeDocForEditor` es la VARIANTE para pintar el contenteditable (capa
 * DOM): igual que la canónica pero con `<br data-wjs-filler>` de relleno en
 * párrafos vacíos o acabados en `<br>` (sin él, el caret no puede entrar en la
 * línea vacía). El parser DOM→modelo descarta ese filler por su atributo.
 */

import type { InlineUnit, LinkAttrs, Para, RichDoc } from "./model";
import { docIsEmpty, sameLink } from "./model";

/** Atributo del `<br>` de relleno del editor (jamás llega a la emisión canónica). */
export const FILLER_BR_ATTR = "data-wjs-filler";

export function escapeText(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Nivel de marca en el orden canónico: 0 strong, 1 em, 2 a. 3 = hoja (texto/br). */
type MarkLevel = 0 | 1 | 2 | 3;

/** Clave de agrupación del run en un nivel (null = sin la marca en ese nivel). */
function levelKey(u: InlineUnit, level: MarkLevel): string | null {
    if (level === 0) return u.marks.bold ? "b" : null;
    if (level === 1) return u.marks.italic ? "i" : null;
    if (level === 2 && u.marks.link) {
        return `${u.marks.link.newTab ? "1" : "0"}|${u.marks.link.href}`;
    }
    return null;
}

function sameKeyedLink(a: InlineUnit, b: InlineUnit): boolean {
    return sameLink(a.marks.link, b.marks.link);
}

function openTag(level: MarkLevel, unit: InlineUnit): string {
    if (level === 0) return "<strong>";
    if (level === 1) return "<em>";
    const link = unit.marks.link as LinkAttrs;
    const target = link.newTab ? ` target="_blank" rel="noopener noreferrer"` : "";
    return `<a href="${escapeAttr(link.href)}"${target}>`;
}

function closeTag(level: MarkLevel): string {
    if (level === 0) return "</strong>";
    if (level === 1) return "</em>";
    return "</a>";
}

function serializeLevel(units: InlineUnit[], level: MarkLevel): string {
    if (level === 3) {
        let out = "";
        for (const u of units) out += u.kind === "br" ? "<br>" : escapeText(u.text);
        return out;
    }
    let out = "";
    let i = 0;
    while (i < units.length) {
        const key = levelKey(units[i], level);
        let j = i + 1;
        while (j < units.length) {
            const k = levelKey(units[j], level);
            if (k === null || key === null) {
                if (k !== key) break;
            } else if (level === 2) {
                if (!sameKeyedLink(units[i], units[j])) break;
            } else if (k !== key) {
                break;
            }
            j++;
        }
        const inner = serializeLevel(units.slice(i, j), (level + 1) as MarkLevel);
        out += key === null ? inner : openTag(level, units[i]) + inner + closeTag(level);
        i = j;
    }
    return out;
}

export function serializePara(para: Para): string {
    return serializeLevel(para.units, 0);
}

function serializeParaTag(para: Para, editor: boolean): string {
    let inner = serializeLevel(para.units, 0);
    if (editor) {
        const last = para.units[para.units.length - 1];
        // Párrafo vacío o acabado en <br>: relleno para que el caret entre.
        if (!last || last.kind === "br") inner += `<br ${FILLER_BR_ATTR}="">`;
    }
    return `<p>${inner}</p>`;
}

function serializeBlocks(doc: RichDoc, editor: boolean): string {
    let out = "";
    for (const b of doc.blocks) {
        if (b.kind === "p") {
            out += serializeParaTag(b.para, editor);
        } else {
            const tag = b.ordered ? "ol" : "ul";
            out += `<${tag}>`;
            for (const item of b.items) out += `<li>${serializeParaTag(item, editor)}</li>`;
            out += `</${tag}>`;
        }
    }
    return out;
}

/** Emisión canónica (§1). Doc vacío → "". */
export function serializeDoc(doc: RichDoc): string {
    if (docIsEmpty(doc)) return "";
    return serializeBlocks(doc, false);
}

/** Variante para el contenteditable: siempre pinta al menos un párrafo. */
export function serializeDocForEditor(doc: RichDoc): string {
    return serializeBlocks(doc, true);
}
