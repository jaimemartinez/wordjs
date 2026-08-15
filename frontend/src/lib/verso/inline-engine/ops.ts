/**
 * Verso — motor de texto inline (F3.5): OPERACIONES puras sobre el modelo.
 *
 * Cada operación toma (doc, selection) y devuelve {doc, selection} NUEVOS (el
 * doc de entrada no se muta). Semántica normativa en la spec §3/§6/§8:
 * - toggleMark UNIFICA (§8.1): si toda la selección lleva la marca → se quita;
 *   si no → se aplica a todo el rango. Caret colapsado = sin cambio de HTML
 *   (la marca pendiente es estado de la superficie, no del modelo).
 * - applyLink extiende el rango a los límites de los enlaces tocados (§8.3,
 *   paridad extendMarkRange) y REEMPLAZA; href vacío ⇒ unlink; removeLink
 *   quita el enlace COMPLETO aunque el caret esté dentro.
 * - setList/unlist (§8.4): párrafos → items de UNA lista; items → cambia el
 *   tipo de TODA la lista tocada; unlist saca solo los items seleccionados
 *   partiendo la lista. Un solo nivel (D6).
 * - insertParagraphBreak = Enter (§3.1): divide párrafo/item; en item VACÍO
 *   saca el item de la lista; shift ⇒ <br>.
 * - insertText hereda marcas *inclusive* (strong/em) y NO hereda el enlace
 *   (§8.6, paridad ProseMirror).
 * - pasteRich (§6.2): sanitizeHTML → proyección al subset → inserción con
 *   fusión del primer/último bloque pegado. Sin autolink/linkOnPaste (D8).
 *
 * La reconstrucción estructural usa una vista PLANA de párrafos (flatten/
 * rebuild): dividir/levantar/fusionar son splices; la agrupación de listas
 * sale sola de la contigüidad (misma lista = mismas entradas consecutivas).
 */

import type {
    Atom,
    Block,
    DocPoint,
    DocSelection,
    LinkAttrs,
    Marks,
    Para,
    RichDoc,
} from "./model";
import {
    NO_MARKS,
    atomsToPara,
    cloneDoc,
    cloneMarks,
    collapsedAt,
    emptyPara,
    isCollapsed,
    normalizeDoc,
    paraIndexOf,
    paraToAtoms,
    sameLink,
} from "./model";
import { projectPastedHtml } from "./parse";

export type MarkName = "bold" | "italic";

export interface OpResult {
    doc: RichDoc;
    selection: DocSelection;
}

/* ------------------------------------------------------------------ */
/* Vista plana                                                          */
/* ------------------------------------------------------------------ */

interface FlatPara {
    para: Para;
    kind: "p" | "list";
    ordered: boolean;
    /** Identidad de lista: entradas CONSECUTIVAS con la misma clave = una lista. */
    listKey: number;
}

function flattenDoc(doc: RichDoc): FlatPara[] {
    const flat: FlatPara[] = [];
    doc.blocks.forEach((b, bi) => {
        if (b.kind === "p") {
            flat.push({ para: b.para, kind: "p", ordered: false, listKey: -1 });
        } else {
            for (const p of b.items) {
                flat.push({ para: p, kind: "list", ordered: b.ordered, listKey: bi });
            }
        }
    });
    return flat;
}

interface RebuiltDoc {
    doc: RichDoc;
    /** Dirección del párrafo i-ésimo de la vista plana reconstruida. */
    addrOf: (flatIdx: number) => { block: number; item: number | null };
}

/**
 * Reagrupa la vista plana en bloques. Entradas de lista consecutivas con la
 * misma clave forman una lista; listas ADYACENTES del mismo tipo se funden
 * (paridad con wrapInList de PM al envolver párrafos pegados a una lista).
 */
function rebuildDoc(flat: FlatPara[]): RebuiltDoc {
    const blocks: Block[] = [];
    const addrs: Array<{ block: number; item: number | null }> = [];
    for (const f of flat) {
        const last = blocks[blocks.length - 1];
        if (f.kind === "p") {
            blocks.push({ kind: "p", para: f.para });
            addrs.push({ block: blocks.length - 1, item: null });
        } else if (last && last.kind === "list" && last.ordered === f.ordered) {
            // Misma lista contigua O lista adyacente del mismo tipo: se funden.
            last.items.push(f.para);
            addrs.push({ block: blocks.length - 1, item: last.items.length - 1 });
        } else {
            blocks.push({ kind: "list", ordered: f.ordered, items: [f.para] });
            addrs.push({ block: blocks.length - 1, item: 0 });
        }
    }
    if (blocks.length === 0) blocks.push({ kind: "p", para: emptyPara() });
    return { doc: normalizeDoc({ blocks }), addrOf: (i) => addrs[i] ?? { block: 0, item: null } };
}

interface FlatPoint {
    idx: number;
    offset: number;
}

function flatLength(entry: FlatPara): number {
    let n = 0;
    for (const u of entry.para.units) n += u.kind === "br" ? 1 : u.text.length;
    return n;
}

function toFlatPoint(doc: RichDoc, flat: FlatPara[], p: DocPoint): FlatPoint {
    const idx = paraIndexOf(doc, p);
    if (idx < 0) {
        const last = flat.length - 1;
        return { idx: Math.max(0, last), offset: last >= 0 ? flatLength(flat[last]) : 0 };
    }
    return { idx, offset: Math.max(0, Math.min(p.offset, flatLength(flat[idx]))) };
}

function orderedFlatRange(
    doc: RichDoc,
    flat: FlatPara[],
    sel: DocSelection,
): { start: FlatPoint; end: FlatPoint } {
    const a = toFlatPoint(doc, flat, sel.anchor);
    const b = toFlatPoint(doc, flat, sel.focus);
    if (a.idx < b.idx || (a.idx === b.idx && a.offset <= b.offset)) return { start: a, end: b };
    return { start: b, end: a };
}

function pointOf(rebuilt: RebuiltDoc, fp: FlatPoint): DocPoint {
    const addr = rebuilt.addrOf(fp.idx);
    return { block: addr.block, item: addr.item, offset: fp.offset };
}

/** Itera los sub-rangos [from,to) de cada párrafo tocado por la selección. */
function forEachFlatRange(
    flat: FlatPara[],
    start: FlatPoint,
    end: FlatPoint,
    fn: (idx: number, from: number, to: number) => void,
): void {
    for (let i = start.idx; i <= end.idx; i++) {
        const len = flatLength(flat[i]);
        const from = i === start.idx ? start.offset : 0;
        const to = i === end.idx ? end.offset : len;
        fn(i, from, to);
    }
}

/* ------------------------------------------------------------------ */
/* Marcas                                                               */
/* ------------------------------------------------------------------ */

/**
 * Marcas heredadas por el texto tecleado en un caret (§8.6): strong/em son
 * inclusive (vienen del átomo ANTERIOR; al inicio del párrafo, del siguiente);
 * el enlace NO es inclusive: solo sobrevive estrictamente DENTRO del enlace
 * (mismo enlace a ambos lados del caret).
 */
export function caretMarks(doc: RichDoc, point: DocPoint): Marks {
    const flat = flattenDoc(doc);
    const fp = toFlatPoint(doc, flat, { ...point });
    const atoms = paraToAtoms(flat[fp.idx].para);
    const before = atoms[fp.offset - 1];
    const after = atoms[fp.offset];
    const base = cloneMarks(before ? before.marks : after ? after.marks : NO_MARKS);
    base.link =
        before && after && before.marks.link && after.marks.link &&
        sameLink(before.marks.link, after.marks.link)
            ? { ...before.marks.link }
            : null;
    return base;
}

export function toggleMark(doc0: RichDoc, sel: DocSelection, mark: MarkName): OpResult {
    const doc = cloneDoc(doc0);
    if (isCollapsed(sel)) {
        // Marca pendiente: estado de la superficie; el HTML no cambia (§3.1).
        return { doc: normalizeDoc(doc), selection: sel };
    }
    const flat = flattenDoc(doc);
    const { start, end } = orderedFlatRange(doc, flat, sel);
    // ¿TODO el rango (texto) lleva ya la marca?
    let sawText = false;
    let allMarked = true;
    forEachFlatRange(flat, start, end, (i, from, to) => {
        const atoms = paraToAtoms(flat[i].para);
        for (let k = from; k < to; k++) {
            const a = atoms[k];
            if (!a || a.br) continue;
            sawText = true;
            if (!a.marks[mark]) allMarked = false;
        }
    });
    const value = !(sawText && allMarked);
    forEachFlatRange(flat, start, end, (i, from, to) => {
        const atoms = paraToAtoms(flat[i].para);
        for (let k = from; k < to; k++) {
            if (atoms[k]) atoms[k].marks[mark] = value;
        }
        flat[i].para = atomsToPara(atoms);
    });
    const rebuilt = rebuildDoc(flat);
    return {
        doc: rebuilt.doc,
        selection: { anchor: pointOf(rebuilt, start), focus: pointOf(rebuilt, end) },
    };
}

export function clearFormat(doc0: RichDoc, sel: DocSelection): OpResult {
    const doc = cloneDoc(doc0);
    if (isCollapsed(sel)) return { doc: normalizeDoc(doc), selection: sel };
    const flat = flattenDoc(doc);
    const { start, end } = orderedFlatRange(doc, flat, sel);
    forEachFlatRange(flat, start, end, (i, from, to) => {
        const atoms = paraToAtoms(flat[i].para);
        for (let k = from; k < to; k++) {
            if (atoms[k]) atoms[k].marks = cloneMarks(NO_MARKS);
        }
        flat[i].para = atomsToPara(atoms);
    });
    const rebuilt = rebuildDoc(flat);
    return {
        doc: rebuilt.doc,
        selection: { anchor: pointOf(rebuilt, start), focus: pointOf(rebuilt, end) },
    };
}

/* ------------------------------------------------------------------ */
/* Enlaces                                                              */
/* ------------------------------------------------------------------ */

/** Extiende un extremo hacia fuera hasta cubrir el enlace que toca (§8.3). */
function extendBoundaryLeft(atoms: Atom[], off: number, link: LinkAttrs): number {
    let o = off;
    while (o > 0 && atoms[o - 1].marks.link && sameLink(atoms[o - 1].marks.link, link)) o--;
    return o;
}

function extendBoundaryRight(atoms: Atom[], off: number, link: LinkAttrs): number {
    let o = off;
    while (o < atoms.length && atoms[o].marks.link && sameLink(atoms[o].marks.link, link)) o++;
    return o;
}

function extendRangeToLinks(flat: FlatPara[], start: FlatPoint, end: FlatPoint): void {
    const startAtoms = paraToAtoms(flat[start.idx].para);
    const sIn = startAtoms[start.offset];
    if (sIn && sIn.marks.link) {
        start.offset = extendBoundaryLeft(startAtoms, start.offset, sIn.marks.link);
    }
    const endAtoms = paraToAtoms(flat[end.idx].para);
    const eIn = endAtoms[end.offset - 1];
    if (eIn && eIn.marks.link) {
        end.offset = extendBoundaryRight(endAtoms, end.offset, eIn.marks.link);
    }
}

export function applyLink(
    doc0: RichDoc,
    sel: DocSelection,
    attrs: { href: string; newTab?: boolean },
): OpResult {
    const href = attrs.href.trim();
    if (!href) return removeLink(doc0, sel); // href vacío ⇒ unlink (§2.2)
    const doc = cloneDoc(doc0);
    const flat = flattenDoc(doc);
    const { start, end } = orderedFlatRange(doc, flat, sel);
    if (start.idx === end.idx && start.offset === end.offset) {
        // Caret colapsado: solo re-apunta si está DENTRO de un enlace (§8.3).
        const atoms = paraToAtoms(flat[start.idx].para);
        const before = atoms[start.offset - 1];
        const after = atoms[start.offset];
        const link =
            before?.marks.link && after?.marks.link && sameLink(before.marks.link, after.marks.link)
                ? before.marks.link
                : null;
        if (!link) return { doc: normalizeDoc(doc), selection: sel };
        start.offset = extendBoundaryLeft(atoms, start.offset, link);
        end.offset = extendBoundaryRight(atoms, end.offset, link);
    } else {
        extendRangeToLinks(flat, start, end);
    }
    const link: LinkAttrs = { href, newTab: attrs.newTab === true };
    forEachFlatRange(flat, start, end, (i, from, to) => {
        const atoms = paraToAtoms(flat[i].para);
        for (let k = from; k < to; k++) {
            if (atoms[k]) atoms[k].marks.link = { ...link };
        }
        flat[i].para = atomsToPara(atoms);
    });
    const rebuilt = rebuildDoc(flat);
    return {
        doc: rebuilt.doc,
        selection: { anchor: pointOf(rebuilt, start), focus: pointOf(rebuilt, end) },
    };
}

export function removeLink(doc0: RichDoc, sel: DocSelection): OpResult {
    const doc = cloneDoc(doc0);
    const flat = flattenDoc(doc);
    const { start, end } = orderedFlatRange(doc, flat, sel);
    if (start.idx === end.idx && start.offset === end.offset) {
        const atoms = paraToAtoms(flat[start.idx].para);
        const link = atoms[start.offset - 1]?.marks.link ?? atoms[start.offset]?.marks.link ?? null;
        if (!link) return { doc: normalizeDoc(doc), selection: sel };
        start.offset = extendBoundaryLeft(atoms, start.offset, link);
        end.offset = extendBoundaryRight(atoms, end.offset, link);
    } else {
        extendRangeToLinks(flat, start, end);
    }
    forEachFlatRange(flat, start, end, (i, from, to) => {
        const atoms = paraToAtoms(flat[i].para);
        for (let k = from; k < to; k++) {
            if (atoms[k]) atoms[k].marks.link = null;
        }
        flat[i].para = atomsToPara(atoms);
    });
    const rebuilt = rebuildDoc(flat);
    return {
        doc: rebuilt.doc,
        selection: { anchor: pointOf(rebuilt, start), focus: pointOf(rebuilt, end) },
    };
}

/* ------------------------------------------------------------------ */
/* Listas                                                               */
/* ------------------------------------------------------------------ */

let nextListKey = 1_000_000; // claves frescas, fuera del rango de índices de bloque

export function setList(doc0: RichDoc, sel: DocSelection, ordered: boolean): OpResult {
    const doc = cloneDoc(doc0);
    const flat = flattenDoc(doc);
    const { start, end } = orderedFlatRange(doc, flat, sel);
    // Selección → entradas; un item toca su lista ENTERA (§8.4).
    const selected = new Set<number>();
    const touchedListKeys = new Set<number>();
    for (let i = start.idx; i <= end.idx; i++) {
        selected.add(i);
        if (flat[i].kind === "list") touchedListKeys.add(flat[i].listKey);
    }
    flat.forEach((f, i) => {
        if (f.kind === "list" && touchedListKeys.has(f.listKey)) selected.add(i);
    });
    // Runs contiguos de seleccionadas = UNA lista nueva.
    let runKey: number | null = null;
    for (let i = 0; i < flat.length; i++) {
        if (!selected.has(i)) {
            runKey = null;
            continue;
        }
        if (runKey === null) runKey = nextListKey++;
        flat[i] = { para: flat[i].para, kind: "list", ordered, listKey: runKey };
    }
    const rebuilt = rebuildDoc(flat);
    return {
        doc: rebuilt.doc,
        selection: { anchor: pointOf(rebuilt, start), focus: pointOf(rebuilt, end) },
    };
}

export function unlist(doc0: RichDoc, sel: DocSelection): OpResult {
    const doc = cloneDoc(doc0);
    const flat = flattenDoc(doc);
    const { start, end } = orderedFlatRange(doc, flat, sel);
    for (let i = start.idx; i <= end.idx; i++) {
        if (flat[i].kind === "list") {
            flat[i] = { para: flat[i].para, kind: "p", ordered: false, listKey: -1 };
        }
    }
    const rebuilt = rebuildDoc(flat);
    return {
        doc: rebuilt.doc,
        selection: { anchor: pointOf(rebuilt, start), focus: pointOf(rebuilt, end) },
    };
}

/* ------------------------------------------------------------------ */
/* Borrado / inserción de texto                                         */
/* ------------------------------------------------------------------ */

function deleteFlatRange(
    flat: FlatPara[],
    start: FlatPoint,
    end: FlatPoint,
): void {
    if (start.idx === end.idx) {
        const atoms = paraToAtoms(flat[start.idx].para);
        atoms.splice(start.offset, end.offset - start.offset);
        flat[start.idx].para = atomsToPara(atoms);
        return;
    }
    const startAtoms = paraToAtoms(flat[start.idx].para).slice(0, start.offset);
    const endAtoms = paraToAtoms(flat[end.idx].para).slice(end.offset);
    flat[start.idx].para = atomsToPara(startAtoms.concat(endAtoms));
    flat.splice(start.idx + 1, end.idx - start.idx);
}

export function deleteSelection(doc0: RichDoc, sel: DocSelection): OpResult {
    const doc = cloneDoc(doc0);
    const flat = flattenDoc(doc);
    const { start, end } = orderedFlatRange(doc, flat, sel);
    if (start.idx === end.idx && start.offset === end.offset) {
        const rebuiltSame = rebuildDoc(flat);
        return { doc: rebuiltSame.doc, selection: collapsedAt(pointOf(rebuiltSame, start)) };
    }
    deleteFlatRange(flat, start, end);
    const rebuilt = rebuildDoc(flat);
    return { doc: rebuilt.doc, selection: collapsedAt(pointOf(rebuilt, start)) };
}

export function insertText(
    doc0: RichDoc,
    sel: DocSelection,
    text: string,
    marksOverride?: Marks,
): OpResult {
    const doc = cloneDoc(doc0);
    const flat = flattenDoc(doc);
    const { start, end } = orderedFlatRange(doc, flat, sel);
    const collapsed = start.idx === end.idx && start.offset === end.offset;

    // Marcas del texto de reemplazo: las del PRIMER átomo seleccionado; el
    // enlace solo si la inserción cae estrictamente dentro de él (no inclusive).
    let marks: Marks;
    if (marksOverride) {
        marks = cloneMarks(marksOverride);
    } else if (collapsed) {
        const atoms = paraToAtoms(flat[start.idx].para);
        const before = atoms[start.offset - 1];
        const after = atoms[start.offset];
        marks = cloneMarks(before ? before.marks : after ? after.marks : NO_MARKS);
        marks.link =
            before && after && before.marks.link && after.marks.link &&
            sameLink(before.marks.link, after.marks.link)
                ? { ...before.marks.link }
                : null;
    } else {
        const atoms = paraToAtoms(flat[start.idx].para);
        const first = atoms[start.offset];
        const before = atoms[start.offset - 1];
        marks = cloneMarks(first ? first.marks : NO_MARKS);
        marks.link =
            first && before && first.marks.link && before.marks.link &&
            sameLink(first.marks.link, before.marks.link)
                ? { ...first.marks.link }
                : null;
    }

    if (!collapsed) deleteFlatRange(flat, start, end);
    if (text.length > 0) {
        const atoms = paraToAtoms(flat[start.idx].para);
        const inserted: Atom[] = text
            .split("")
            .map((ch) => ({ br: false, ch, marks: cloneMarks(marks) }));
        atoms.splice(start.offset, 0, ...inserted);
        flat[start.idx].para = atomsToPara(atoms);
    }
    const caret: FlatPoint = { idx: start.idx, offset: start.offset + text.length };
    const rebuilt = rebuildDoc(flat);
    return { doc: rebuilt.doc, selection: collapsedAt(pointOf(rebuilt, caret)) };
}

/* ------------------------------------------------------------------ */
/* Enter                                                                */
/* ------------------------------------------------------------------ */

export function insertParagraphBreak(
    doc0: RichDoc,
    sel: DocSelection,
    shift = false,
): OpResult {
    const doc = cloneDoc(doc0);
    const flat = flattenDoc(doc);
    const { start, end } = orderedFlatRange(doc, flat, sel);
    if (!(start.idx === end.idx && start.offset === end.offset)) {
        deleteFlatRange(flat, start, end);
    }
    const caret = start;
    const entry = flat[caret.idx];
    if (shift) {
        // Shift+Enter: <br> literal, hereda las marcas del caret (D13).
        const atoms = paraToAtoms(entry.para);
        const before = atoms[caret.offset - 1];
        const after = atoms[caret.offset];
        const marks = cloneMarks(before ? before.marks : after ? after.marks : NO_MARKS);
        marks.link =
            before && after && before.marks.link && after.marks.link &&
            sameLink(before.marks.link, after.marks.link)
                ? { ...before.marks.link }
                : null;
        atoms.splice(caret.offset, 0, { br: true, ch: "", marks });
        entry.para = atomsToPara(atoms);
        const rebuilt = rebuildDoc(flat);
        return {
            doc: rebuilt.doc,
            selection: collapsedAt(pointOf(rebuilt, { idx: caret.idx, offset: caret.offset + 1 })),
        };
    }
    const atoms = paraToAtoms(entry.para);
    if (entry.kind === "list" && atoms.length === 0) {
        // Enter en item VACÍO: saca el item de la lista (liftEmptyBlock);
        // la contigüidad parte la lista sola y una lista vacía desaparece.
        flat[caret.idx] = { para: entry.para, kind: "p", ordered: false, listKey: -1 };
        const rebuilt = rebuildDoc(flat);
        return {
            doc: rebuilt.doc,
            selection: collapsedAt(pointOf(rebuilt, { idx: caret.idx, offset: 0 })),
        };
    }
    // Divide párrafo/item en el caret (splitBlock/splitListItem).
    const left = atoms.slice(0, caret.offset);
    const right = atoms.slice(caret.offset);
    entry.para = atomsToPara(left);
    flat.splice(caret.idx + 1, 0, {
        para: atomsToPara(right),
        kind: entry.kind,
        ordered: entry.ordered,
        listKey: entry.listKey,
    });
    const rebuilt = rebuildDoc(flat);
    return {
        doc: rebuilt.doc,
        selection: collapsedAt(pointOf(rebuilt, { idx: caret.idx + 1, offset: 0 })),
    };
}

/* ------------------------------------------------------------------ */
/* Pegado                                                               */
/* ------------------------------------------------------------------ */

export interface PasteData {
    html?: string;
    text?: string;
}

/** Bloque pegado + si nació de un párrafo (fusionable con el partido). */
interface PastedEntry {
    para: Para;
    fromParagraph: boolean;
    list: { ordered: boolean } | null;
}

function pastedEntriesOf(blocks: Block[]): PastedEntry[] {
    const out: PastedEntry[] = [];
    for (const b of blocks) {
        if (b.kind === "p") {
            out.push({ para: b.para, fromParagraph: true, list: null });
        } else {
            for (const item of b.items) {
                out.push({ para: item, fromParagraph: false, list: { ordered: b.ordered } });
            }
        }
    }
    return out;
}

export function pasteRich(
    doc0: RichDoc,
    sel: DocSelection,
    data: PasteData,
    sanitize: (html: string) => string,
): OpResult {
    let blocks: Block[] = [];
    if (typeof data.html === "string" && data.html.length > 0) {
        blocks = projectPastedHtml(sanitize(data.html));
    }
    if (blocks.length === 0 && typeof data.text === "string" && data.text.length > 0) {
        blocks = data.text.split(/\r\n|\r|\n/).map((line): Block => ({
            kind: "p",
            para: line.length
                ? { units: [{ kind: "text", text: line, marks: cloneMarks(NO_MARKS) }] }
                : emptyPara(),
        }));
    }
    if (blocks.length === 0) {
        const doc = normalizeDoc(cloneDoc(doc0));
        return { doc, selection: sel };
    }

    const doc = cloneDoc(doc0);
    const flat = flattenDoc(doc);
    const { start, end } = orderedFlatRange(doc, flat, sel);
    if (!(start.idx === end.idx && start.offset === end.offset)) {
        deleteFlatRange(flat, start, end);
    }
    const caret = start;
    const entry = flat[caret.idx];

    // Un único párrafo pegado: inserción INLINE (sin partir el bloque).
    if (blocks.length === 1 && blocks[0].kind === "p") {
        const insertAtoms = paraToAtoms(blocks[0].para);
        const atoms = paraToAtoms(entry.para);
        atoms.splice(caret.offset, 0, ...insertAtoms);
        entry.para = atomsToPara(atoms);
        const rebuilt = rebuildDoc(flat);
        return {
            doc: rebuilt.doc,
            selection: collapsedAt(
                pointOf(rebuilt, { idx: caret.idx, offset: caret.offset + insertAtoms.length }),
            ),
        };
    }

    const atoms = paraToAtoms(entry.para);
    const leftAtoms = atoms.slice(0, caret.offset);
    const rightAtoms = atoms.slice(caret.offset);
    const pasted = pastedEntriesOf(blocks);

    // El contexto del caret decide el contenedor de los párrafos pegados: en un
    // li, los bloques pegados se convierten en items de ESA lista (D6).
    const inList = entry.kind === "list";
    const toFlat = (pe: PastedEntry): FlatPara => {
        if (pe.list) {
            return { para: pe.para, kind: "list", ordered: pe.list.ordered, listKey: nextListKey++ };
        }
        if (inList) {
            return { para: pe.para, kind: "list", ordered: entry.ordered, listKey: entry.listKey };
        }
        return { para: pe.para, kind: "p", ordered: false, listKey: -1 };
    };

    const replacement: FlatPara[] = [];
    const first = pasted[0];
    const last = pasted[pasted.length - 1];
    const firstMerges = first.fromParagraph;
    const lastMerges = last.fromParagraph && pasted.length > 1;

    if (firstMerges) {
        const fp = toFlat(first);
        fp.para = atomsToPara(leftAtoms.concat(paraToAtoms(first.para)));
        replacement.push(fp);
    } else if (leftAtoms.length > 0) {
        replacement.push({ ...entry, para: atomsToPara(leftAtoms) });
        replacement.push(toFlat(first));
    } else {
        replacement.push(toFlat(first));
    }
    for (let i = 1; i < pasted.length - 1; i++) replacement.push(toFlat(pasted[i]));

    let caretFlat: FlatPoint;
    if (pasted.length > 1) {
        const lastLen = flatLength({ para: last.para, kind: "p", ordered: false, listKey: -1 });
        if (lastMerges) {
            const lp = toFlat(last);
            lp.para = atomsToPara(paraToAtoms(last.para).concat(rightAtoms));
            replacement.push(lp);
            caretFlat = { idx: caret.idx + replacement.length - 1, offset: lastLen };
        } else {
            replacement.push(toFlat(last));
            caretFlat = { idx: caret.idx + replacement.length - 1, offset: lastLen };
            if (rightAtoms.length > 0) {
                replacement.push({ ...entry, para: atomsToPara(rightAtoms) });
            }
        }
    } else {
        // Un solo bloque pegado NO fusionable (una lista).
        const lastIdx = caret.idx + replacement.length - 1;
        caretFlat = { idx: lastIdx, offset: flatLength(replacement[replacement.length - 1]) };
        if (rightAtoms.length > 0) {
            replacement.push({ ...entry, para: atomsToPara(rightAtoms) });
        }
    }

    flat.splice(caret.idx, 1, ...replacement);
    const rebuilt = rebuildDoc(flat);
    return { doc: rebuilt.doc, selection: collapsedAt(pointOf(rebuilt, caretFlat)) };
}

/* ------------------------------------------------------------------ */
/* Estado activo (bubble)                                               */
/* ------------------------------------------------------------------ */

export interface ActiveStates {
    bold: boolean;
    italic: boolean;
    /** Enlace en el arranque de la selección (prefill del popover), o null. */
    link: LinkAttrs | null;
    bulletList: boolean;
    orderedList: boolean;
}

/** Estado «activo» de los botones del bubble (§2.2): toda la selección marcada. */
export function activeStates(doc: RichDoc, sel: DocSelection): ActiveStates {
    const flat = flattenDoc(doc);
    const { start, end } = orderedFlatRange(doc, flat, sel);
    let sawText = false;
    let allBold = true;
    let allItalic = true;
    forEachFlatRange(flat, start, end, (i, from, to) => {
        const atoms = paraToAtoms(flat[i].para);
        for (let k = from; k < to; k++) {
            const a = atoms[k];
            if (!a || a.br) continue;
            sawText = true;
            if (!a.marks.bold) allBold = false;
            if (!a.marks.italic) allItalic = false;
        }
    });
    const startAtoms = paraToAtoms(flat[start.idx].para);
    const linkAtom = startAtoms[start.offset] ?? startAtoms[start.offset - 1];
    let allInBullet = true;
    let allInOrdered = true;
    for (let i = start.idx; i <= end.idx; i++) {
        if (flat[i].kind !== "list") {
            allInBullet = false;
            allInOrdered = false;
        } else if (flat[i].ordered) {
            allInBullet = false;
        } else {
            allInOrdered = false;
        }
    }
    return {
        bold: sawText && allBold,
        italic: sawText && allItalic,
        link: linkAtom?.marks.link ? { ...linkAtom.marks.link } : null,
        bulletList: allInBullet,
        orderedList: allInOrdered,
    };
}

/* ------------------------------------------------------------------ */
/* Schema plain (§3.2)                                                  */
/* ------------------------------------------------------------------ */

/** Aplana a UNA línea: \n, \r\n y tabs → un espacio (secuencias, a uno) — D7. */
export function flattenToSingleLine(s: string): string {
    return s.replace(/[\r\n\t]+/g, " ");
}

export function plainReplaceRange(
    value: string,
    from: number,
    to: number,
    text: string,
): { value: string; caret: number } {
    const lo = Math.max(0, Math.min(from, to));
    const hi = Math.min(value.length, Math.max(from, to));
    return { value: value.slice(0, lo) + text + value.slice(hi), caret: lo + text.length };
}

/**
 * Texto a insertar por un pegado en schema plain (§6.2): SIEMPRE texto
 * (text/plain; si solo hay HTML, su contenido textual), aplanado a una línea.
 */
export function plainPasteText(data: PasteData, sanitize: (html: string) => string): string {
    if (typeof data.text === "string" && data.text.length > 0) {
        return flattenToSingleLine(data.text);
    }
    if (typeof data.html === "string" && data.html.length > 0) {
        const blocks = projectPastedHtml(sanitize(data.html));
        const parts: string[] = [];
        for (const b of blocks) {
            if (b.kind === "p") parts.push(paraTextWithBreaks(b.para));
            else for (const item of b.items) parts.push(paraTextWithBreaks(item));
        }
        return flattenToSingleLine(parts.filter((p) => p.length > 0).join(" "));
    }
    return "";
}

function paraTextWithBreaks(para: Para): string {
    let s = "";
    for (const u of para.units) s += u.kind === "br" ? "\n" : u.text;
    return s;
}
