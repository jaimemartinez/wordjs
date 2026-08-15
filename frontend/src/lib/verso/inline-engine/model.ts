/**
 * Verso — motor de texto inline PROPIO (F3.5): MODELO de documento.
 *
 * Contrato: documentation/verso/inline-engine-spec.md (§1 subset y normalización,
 * §3 semántica por schema). Lógica 100% pura — sin React, sin DOM: los tests de
 * node (vitest, environment node) ejercitan todo el motor sin navegador.
 *
 * El modelo es deliberadamente MÍNIMO (no es un motor genérico):
 * - Un documento rich = secuencia de bloques `p` | `list(ul/ol)`; cada `li`
 *   contiene exactamente UN párrafo (D5: `<li><p>…</p></li>`).
 * - Un párrafo = runs de texto con marcas {bold, italic, link{href,newTab}}
 *   más hard-breaks (`<br>`); un `<br>` LLEVA marcas (igual que el hardBreak
 *   de ProseMirror) para que la fusión voraz del serializador pueda agrupar
 *   `<strong>a<br>b</strong>` en una sola etiqueta.
 * - Offsets en unidades UTF-16 (1 char de texto = 1 unidad, 1 br = 1 unidad):
 *   coincide byte a byte con los offsets de los marcadores del fixture y con
 *   los offsets de nodos de texto del DOM.
 *
 * Las OPERACIONES (ops.ts) trabajan sobre "átomos" (1 unidad = 1 átomo) y
 * re-normalizan a runs al terminar — así toggleMark/split/fusión son splices
 * triviales y la forma canónica sale sola del serializador.
 */

export interface LinkAttrs {
    /** href verbatim (D8: sin autolink, sin normalización de URL). */
    href: string;
    /** true ⇒ target="_blank" + rel="noopener noreferrer" al serializar (D11). */
    newTab: boolean;
}

export interface Marks {
    bold: boolean;
    italic: boolean;
    link: LinkAttrs | null;
}

export const NO_MARKS: Marks = Object.freeze({ bold: false, italic: false, link: null });

export function cloneMarks(m: Marks): Marks {
    return { bold: m.bold, italic: m.italic, link: m.link ? { ...m.link } : null };
}

export function sameLink(a: LinkAttrs | null, b: LinkAttrs | null): boolean {
    if (a === null || b === null) return a === b;
    return a.href === b.href && a.newTab === b.newTab;
}

export function sameMarks(a: Marks, b: Marks): boolean {
    return a.bold === b.bold && a.italic === b.italic && sameLink(a.link, b.link);
}

/** Run de texto (text.length >= 1 tras normalizar) o hard-break. */
export type InlineUnit =
    | { kind: "text"; text: string; marks: Marks }
    | { kind: "br"; marks: Marks };

export interface Para {
    units: InlineUnit[];
}

export type Block =
    | { kind: "p"; para: Para }
    | { kind: "list"; ordered: boolean; items: Para[] };

export interface RichDoc {
    blocks: Block[];
}

/* ------------------------------------------------------------------ */
/* Direcciones y selección                                              */
/* ------------------------------------------------------------------ */

/** Dirección de un párrafo: bloque top-level + índice de item si es una lista. */
export interface ParaAddress {
    block: number;
    /** null ⇒ el bloque es un `p`; número ⇒ índice del `li` dentro de la lista. */
    item: number | null;
}

export interface DocPoint extends ParaAddress {
    /** Offset en unidades dentro del párrafo (0..paraLength). */
    offset: number;
}

/** ancla = donde empezó la selección, foco = donde acaba (puede ir hacia atrás). */
export interface DocSelection {
    anchor: DocPoint;
    focus: DocPoint;
}

export function collapsedAt(point: DocPoint): DocSelection {
    return { anchor: { ...point }, focus: { ...point } };
}

export function isCollapsed(sel: DocSelection): boolean {
    return (
        sel.anchor.block === sel.focus.block &&
        sel.anchor.item === sel.focus.item &&
        sel.anchor.offset === sel.focus.offset
    );
}

/* ------------------------------------------------------------------ */
/* Átomos (1 unidad = 1 átomo)                                          */
/* ------------------------------------------------------------------ */

/** br=true ⇒ hard-break (ch queda ""); si no, ch es exactamente 1 code unit. */
export interface Atom {
    br: boolean;
    ch: string;
    marks: Marks;
}

export function paraToAtoms(para: Para): Atom[] {
    const atoms: Atom[] = [];
    for (const u of para.units) {
        if (u.kind === "br") {
            atoms.push({ br: true, ch: "", marks: cloneMarks(u.marks) });
        } else {
            for (const ch of u.text.split("")) {
                atoms.push({ br: false, ch, marks: cloneMarks(u.marks) });
            }
        }
    }
    return atoms;
}

/** Re-normaliza átomos a runs: adyacentes con marcas idénticas se funden. */
export function atomsToPara(atoms: Atom[]): Para {
    const units: InlineUnit[] = [];
    for (const a of atoms) {
        if (a.br) {
            units.push({ kind: "br", marks: cloneMarks(a.marks) });
            continue;
        }
        const last = units[units.length - 1];
        if (last && last.kind === "text" && sameMarks(last.marks, a.marks)) {
            last.text += a.ch;
        } else {
            units.push({ kind: "text", text: a.ch, marks: cloneMarks(a.marks) });
        }
    }
    return { units };
}

export function paraLength(para: Para): number {
    let n = 0;
    for (const u of para.units) n += u.kind === "br" ? 1 : u.text.length;
    return n;
}

export function paraText(para: Para): string {
    let s = "";
    for (const u of para.units) if (u.kind === "text") s += u.text;
    return s;
}

/* ------------------------------------------------------------------ */
/* Constructores y recorrido                                            */
/* ------------------------------------------------------------------ */

export function emptyPara(): Para {
    return { units: [] };
}

/** Documento mínimo: un párrafo vacío (serializa a "" — §1.2.1). */
export function emptyDoc(): RichDoc {
    return { blocks: [{ kind: "p", para: emptyPara() }] };
}

export function docIsEmpty(doc: RichDoc): boolean {
    return (
        doc.blocks.length === 1 &&
        doc.blocks[0].kind === "p" &&
        doc.blocks[0].para.units.length === 0
    );
}

export interface ParaRef {
    addr: ParaAddress;
    para: Para;
}

/** Todos los párrafos del documento en orden (p top-level y p de cada li). */
export function listParas(doc: RichDoc): ParaRef[] {
    const out: ParaRef[] = [];
    doc.blocks.forEach((b, bi) => {
        if (b.kind === "p") {
            out.push({ addr: { block: bi, item: null }, para: b.para });
        } else {
            b.items.forEach((p, ii) => {
                out.push({ addr: { block: bi, item: ii }, para: p });
            });
        }
    });
    return out;
}

export function sameAddress(a: ParaAddress, b: ParaAddress): boolean {
    return a.block === b.block && a.item === b.item;
}

export function getPara(doc: RichDoc, addr: ParaAddress): Para | null {
    const b = doc.blocks[addr.block];
    if (!b) return null;
    if (b.kind === "p") return addr.item === null ? b.para : null;
    return addr.item !== null ? (b.items[addr.item] ?? null) : null;
}

export function setPara(doc: RichDoc, addr: ParaAddress, para: Para): void {
    const b = doc.blocks[addr.block];
    if (!b) return;
    if (b.kind === "p" && addr.item === null) {
        b.para = para;
    } else if (b.kind === "list" && addr.item !== null && addr.item < b.items.length) {
        b.items[addr.item] = para;
    }
}

/** Índice del párrafo en el orden plano de listParas, o -1. */
export function paraIndexOf(doc: RichDoc, addr: ParaAddress): number {
    const paras = listParas(doc);
    for (let i = 0; i < paras.length; i++) {
        if (sameAddress(paras[i].addr, addr)) return i;
    }
    return -1;
}

/** < 0 si a precede a b en el documento; 0 si son el mismo punto. */
export function comparePoints(doc: RichDoc, a: DocPoint, b: DocPoint): number {
    const ia = paraIndexOf(doc, a);
    const ib = paraIndexOf(doc, b);
    if (ia !== ib) return ia - ib;
    return a.offset - b.offset;
}

export function cloneDoc(doc: RichDoc): RichDoc {
    return {
        blocks: doc.blocks.map((b): Block =>
            b.kind === "p"
                ? { kind: "p", para: clonePara(b.para) }
                : { kind: "list", ordered: b.ordered, items: b.items.map(clonePara) },
        ),
    };
}

export function clonePara(para: Para): Para {
    return {
        units: para.units.map((u): InlineUnit =>
            u.kind === "br"
                ? { kind: "br", marks: cloneMarks(u.marks) }
                : { kind: "text", text: u.text, marks: cloneMarks(u.marks) },
        ),
    };
}

/**
 * Normaliza IN PLACE: runs adyacentes con marcas idénticas se funden, runs de
 * texto vacíos caen, listas sin items caen y un doc sin bloques queda como
 * [p vacío]. Idempotente (gate de test).
 */
export function normalizeDoc(doc: RichDoc): RichDoc {
    const blocks: Block[] = [];
    for (const b of doc.blocks) {
        if (b.kind === "p") {
            blocks.push({ kind: "p", para: normalizePara(b.para) });
        } else {
            if (b.items.length === 0) continue;
            blocks.push({ kind: "list", ordered: b.ordered, items: b.items.map(normalizePara) });
        }
    }
    if (blocks.length === 0) blocks.push({ kind: "p", para: emptyPara() });
    doc.blocks = blocks;
    return doc;
}

export function normalizePara(para: Para): Para {
    const units: InlineUnit[] = [];
    for (const u of para.units) {
        if (u.kind === "text" && u.text.length === 0) continue;
        const last = units[units.length - 1];
        if (u.kind === "text" && last && last.kind === "text" && sameMarks(last.marks, u.marks)) {
            last.text += u.text;
        } else {
            units.push(u);
        }
    }
    return { units };
}
