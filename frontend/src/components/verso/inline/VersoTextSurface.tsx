"use client";
/**
 * Verso — VersoTextSurface: superficie contenteditable NO controlada del motor
 * de texto inline PROPIO (F3.5). Cero dependencias de Tiptap. Spec:
 * documentation/verso/inline-engine-spec.md.
 *
 * MONTAJE IN-PLACE (fix W34-tipografía): VersoBlock sigue renderizando el
 * COMPONENTE real del bloque, con la prop inline sustituida por el centinela
 * INLINE_HOST_SENTINEL. Esta superficie localiza el elemento MÁS PROFUNDO que
 * contiene el centinela dentro del subtree del bloque y lo toma como HOST:
 * el texto se edita dentro del elemento real (h2/.wp-block-text/…), heredando
 * su tipografía — nada de reemplazar el render con un editor desnudo. Si el
 * bloque no pinta la prop (centinela ausente), fail-soft: la superficie monta
 * su propio div editable en el hueco del marcador.
 *
 * SINCRONIZACIÓN (el bug histórico de caret): el contenteditable es DUEÑO del
 * DOM entre sincronizaciones — React jamás re-pinta el contenido en sesión
 * (el Component se re-renderiza con el centinela CONSTANTE, así que no toca el
 * host). Tecleo normal = mutación del navegador → `input` → parse DOM→modelo →
 * onContent(serialización canónica). Operaciones (Enter, marcas, pegar, undo)
 * = modelo→DOM reescribiendo SOLO el host y restaurando el caret del bookmark.
 * PROHIBIDO document.execCommand — no se usa en ningún camino.
 *
 * IME (§7): entre compositionstart/compositionend no se emite NADA ni se muta
 * el DOM; ningún keydown con isComposing (o keyCode 229) se intercepta — el
 * Enter que confirma el candidato pasa incluso en schema plain (D12).
 *
 * UNDO (§8.7, D4): pila LOCAL de la sesión (modelo+selección, coalescencia de
 * tecleo consecutivo); Mod+Z/Y se interceptan con preventDefault+stopPropagation
 * y jamás llegan al undo global del store.
 */
import React from "react";
import { sanitizeHTML } from "@/lib/sanitize";
import {
    type Block,
    type DocPoint,
    type DocSelection,
    type InlineUnit,
    type Marks,
    type Para,
    type RichDoc,
    FILLER_BR_ATTR,
    NO_MARKS,
    activeStates,
    applyLink,
    caretMarks,
    clearFormat,
    cloneMarks,
    docGuardText,
    inlineGuardLosesText,
    insertParagraphBreak,
    insertText,
    isCollapsed,
    normalizeDoc,
    normalizePara,
    parseRichHtml,
    pasteRich,
    plainPasteText,
    plainReplaceRange,
    removeLink,
    serializeDoc,
    serializeDocForEditor,
    setList,
    toggleMark,
    unlist,
} from "@/lib/verso/inline-engine";
import VersoBubbleMenu, {
    type BubbleSelectionState,
    type VersoBubbleMenuHandle,
} from "./VersoBubbleMenu";
import { mapOffset, reconcileSelection } from "./remoteReconcile";

/**
 * Centinela que VersoBlock inyecta como valor de la prop inline: invisible
 * (word-joiners) y unívoco; sobrevive a sanitizeHTML (es texto plano) tanto en
 * dangerouslySetInnerHTML (Heading/Text) como en interpolación (Card/Button…).
 */
export const INLINE_HOST_SENTINEL = "⁠wjs-inline-host⁠";

/**
 * Aplica en la superficie un valor que NO ha escrito quien la tiene delante (F8.4): el texto del
 * campo ya fusionado por el CRDT con la edición de otra persona. Devuelve `true` si lo aplicó.
 *
 * No emite `onContent`: el documento ya lo tiene: lo que falta es que el editable lo REFLEJE, y
 * devolverlo sería un eco.
 */
export type ApplyExternalValue = (value: string) => boolean;

export interface VersoTextSurfaceProps {
    nodeId: string;
    schema: "rich" | "plain";
    initialValue: string;
    /** Serialización canónica (rich) o texto plano (plain) tras CADA mutación. */
    onContent(raw: string): void;
    /** Escape / click fuera → la sesión hace flush + setInlineEditing(null). */
    onRequestEnd(): void;
    /**
     * Buzón por el que el cableado de colaboración empuja el texto ajeno ya fusionado. La
     * superficie escribe aquí su `applyExternal` mientras tiene el host tomado, y `null` al
     * soltarlo — quien lo llame fuera de sesión no rompe nada.
     */
    applyRef?: React.MutableRefObject<ApplyExternalValue | null>;
}

/* ------------------------------------------------------------------ */
/* DOM → modelo (walker con localizaciones por unidad)                  */
/* ------------------------------------------------------------------ */

interface RunLoc {
    br: boolean;
    node: Node;
    start: number;
    length: number;
}

interface ParaEntry {
    el: Element;
    runs: RunLoc[];
    units: InlineUnit[];
}

interface SurfaceModel {
    doc: RichDoc;
    paras: ParaEntry[];
    addrs: Array<{ block: number; item: number | null }>;
}

const CONTAINERISH = new Set([
    "div", "section", "article", "header", "footer", "nav", "aside", "main",
    "figure", "figcaption", "blockquote", "pre", "address", "span",
]);

/**
 * `node instanceof Element` MIENTE entre realms: el canvas vive en un IFRAME y
 * sus nodos son instancias del Element DEL IFRAME, no del de esta ventana — el
 * walker DOM→modelo quedaba CIEGO a todos los elementos y el commit truncaba
 * el contenido al primer texto suelto (bug Text-m2, página 172). `nodeType` es
 * un número, idéntico en todos los realms: es la única comprobación válida aquí.
 */
function isElementNode(node: Node): node is Element {
    return node.nodeType === Node.ELEMENT_NODE;
}

function collectInlineInto(entry: ParaEntry, node: Node, marks: Marks): void {
    if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue ?? "";
        if (text.length === 0) return;
        entry.runs.push({ br: false, node, start: 0, length: text.length });
        entry.units.push({ kind: "text", text, marks: cloneMarks(marks) });
        return;
    }
    if (!isElementNode(node)) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "br") {
        if (node.hasAttribute(FILLER_BR_ATTR)) return;
        entry.runs.push({ br: true, node, start: 0, length: 1 });
        entry.units.push({ kind: "br", marks: cloneMarks(marks) });
        return;
    }
    if (tag === "script" || tag === "style" || tag === "img" || tag === "hr" || tag === "iframe") {
        return;
    }
    let m = marks;
    if (tag === "strong" || tag === "b") m = { ...cloneMarks(m), bold: true };
    else if (tag === "em" || tag === "i") m = { ...cloneMarks(m), italic: true };
    else if (tag === "a" && node.hasAttribute("href")) {
        m = {
            ...cloneMarks(m),
            link: {
                href: node.getAttribute("href") ?? "",
                newTab: node.getAttribute("target") === "_blank",
            },
        };
    }
    for (const child of Array.from(node.childNodes)) collectInlineInto(entry, child, m);
}

function paraEntryOf(el: Element, nodes: Node[]): ParaEntry {
    const entry: ParaEntry = { el, runs: [], units: [] };
    for (const n of nodes) collectInlineInto(entry, n, NO_MARKS);
    entry.units = normalizePara({ units: entry.units }).units;
    return entry;
}

function readRichModel(host: HTMLElement): SurfaceModel {
    const blocks: Block[] = [];
    const paras: ParaEntry[] = [];
    const addrs: Array<{ block: number; item: number | null }> = [];

    const pushP = (entry: ParaEntry): void => {
        blocks.push({ kind: "p", para: { units: entry.units } });
        paras.push(entry);
        addrs.push({ block: blocks.length - 1, item: null });
    };

    const collectListDom = (listEl: Element, items: Para[], entries: ParaEntry[]): void => {
        for (const child of Array.from(listEl.children)) {
            const tag = child.tagName.toLowerCase();
            if (tag === "ul" || tag === "ol") {
                collectListDom(child, items, entries);
                continue;
            }
            if (tag !== "li") continue;
            let loose: Node[] = [];
            const flushLoose = (): void => {
                const hasContent = loose.some((n) =>
                    n.nodeType === Node.TEXT_NODE ? (n.nodeValue ?? "").trim().length > 0 : true,
                );
                if (hasContent) {
                    const entry = paraEntryOf(child, loose);
                    items.push({ units: entry.units });
                    entries.push(entry);
                }
                loose = [];
            };
            for (const sub of Array.from(child.childNodes)) {
                if (isElementNode(sub)) {
                    const st = sub.tagName.toLowerCase();
                    if (st === "p" || /^h[1-6]$/.test(st)) {
                        flushLoose();
                        const entry = paraEntryOf(sub, Array.from(sub.childNodes));
                        items.push({ units: entry.units });
                        entries.push(entry);
                        continue;
                    }
                    if (st === "ul" || st === "ol") {
                        flushLoose();
                        collectListDom(sub, items, entries);
                        continue;
                    }
                }
                loose.push(sub);
            }
            flushLoose();
        }
    };

    const walkContainer = (el: Element): void => {
        let loose: Node[] = [];
        const flushLoose = (): void => {
            const hasContent = loose.some((n) =>
                n.nodeType === Node.TEXT_NODE ? (n.nodeValue ?? "").trim().length > 0 : true,
            );
            if (hasContent) pushP(paraEntryOf(el, loose));
            loose = [];
        };
        for (const child of Array.from(el.childNodes)) {
            if (!isElementNode(child)) {
                if (child.nodeType === Node.TEXT_NODE && (child.nodeValue ?? "").length > 0) {
                    loose.push(child);
                }
                continue;
            }
            const tag = child.tagName.toLowerCase();
            if (tag === "p" || /^h[1-6]$/.test(tag) || tag === "li") {
                flushLoose();
                pushP(paraEntryOf(child, Array.from(child.childNodes)));
            } else if (tag === "ul" || tag === "ol") {
                flushLoose();
                const items: Para[] = [];
                const entries: ParaEntry[] = [];
                collectListDom(child, items, entries);
                if (items.length > 0) {
                    blocks.push({ kind: "list", ordered: tag === "ol", items });
                    items.forEach((_, ii) => addrs.push({ block: blocks.length - 1, item: ii }));
                    paras.push(...entries);
                }
            } else if (CONTAINERISH.has(tag) && !isInlineish(child)) {
                flushLoose();
                walkContainer(child);
            } else {
                loose.push(child);
            }
        }
        flushLoose();
    };

    walkContainer(host);
    if (blocks.length === 0) {
        blocks.push({ kind: "p", para: { units: [] } });
        paras.push({ el: host, runs: [], units: [] });
        addrs.push({ block: 0, item: null });
    }
    return { doc: normalizeDoc({ blocks }), paras, addrs };
}

/** span/div usados como envoltorio inline por el navegador al teclear. */
function isInlineish(el: Element): boolean {
    if (el.tagName.toLowerCase() !== "span") return false;
    for (const child of Array.from(el.children)) {
        const tag = child.tagName.toLowerCase();
        if (tag === "p" || tag === "ul" || tag === "ol" || tag === "div" || /^h[1-6]$/.test(tag)) {
            return false;
        }
    }
    return true;
}

/** Modelo plano del schema plain: el host entero es un único párrafo. */
function readPlainEntry(host: HTMLElement): ParaEntry {
    const entry: ParaEntry = { el: host, runs: [], units: [] };
    const walk = (node: Node): void => {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.nodeValue ?? "";
            if (text.length > 0) {
                entry.runs.push({ br: false, node, start: 0, length: text.length });
                entry.units.push({ kind: "text", text, marks: cloneMarks(NO_MARKS) });
            }
            return;
        }
        if (!isElementNode(node)) return;
        if (node.tagName.toLowerCase() === "br") return;
        for (const child of Array.from(node.childNodes)) walk(child);
    };
    walk(host);
    return entry;
}

function plainValueOf(entry: ParaEntry): string {
    let s = "";
    for (const u of entry.units) if (u.kind === "text") s += u.text;
    return s;
}

/* ------------------------------------------------------------------ */
/* Selección DOM ↔ modelo                                               */
/* ------------------------------------------------------------------ */

/** -1 si (nA,oA) precede a (nB,oB); 0 igual; 1 después. */
function cmpDomPoints(doc: Document, nA: Node, oA: number, nB: Node, oB: number): number {
    const r = doc.createRange();
    try {
        r.setStart(nB, oB);
        r.collapse(true);
        return r.comparePoint(nA, oA);
    } catch {
        return 0;
    }
}

function paraOffsetOfDomPoint(
    doc: Document,
    entry: ParaEntry,
    node: Node,
    offset: number,
): number {
    let acc = 0;
    for (const run of entry.runs) {
        if (!run.br && run.node === node) {
            if (offset <= run.start) return acc;
            if (offset < run.start + run.length) return acc + (offset - run.start);
            acc += run.length;
            continue;
        }
        const parent = run.br ? run.node.parentNode : null;
        const runStartNode = run.br ? (parent ?? run.node) : run.node;
        const runStartOffset = run.br
            ? parent
                ? Array.prototype.indexOf.call(parent.childNodes, run.node)
                : 0
            : run.start;
        const cmp = cmpDomPoints(doc, node, offset, runStartNode, runStartOffset);
        if (cmp <= 0) return acc;
        acc += run.length;
    }
    return acc;
}

function domPointToModel(
    doc: Document,
    model: SurfaceModel,
    node: Node,
    offset: number,
): DocPoint | null {
    for (let i = 0; i < model.paras.length; i++) {
        const entry = model.paras[i];
        if (entry.el === node || entry.el.contains(node)) {
            const addr = model.addrs[i];
            return {
                block: addr.block,
                item: addr.item,
                offset: paraOffsetOfDomPoint(doc, entry, node, offset),
            };
        }
    }
    // Frontera entre bloques: primer párrafo que empieza en/tras el punto.
    for (let i = 0; i < model.paras.length; i++) {
        const entry = model.paras[i];
        const cmp = cmpDomPoints(doc, entry.el, 0, node, offset);
        if (cmp >= 0) {
            const addr = model.addrs[i];
            return { block: addr.block, item: addr.item, offset: 0 };
        }
    }
    const lastIdx = model.paras.length - 1;
    if (lastIdx < 0) return null;
    const addr = model.addrs[lastIdx];
    let len = 0;
    for (const run of model.paras[lastIdx].runs) len += run.length;
    return { block: addr.block, item: addr.item, offset: len };
}

function modelPointToDom(model: SurfaceModel, point: DocPoint): { node: Node; offset: number } {
    let idx = model.addrs.findIndex((a) => a.block === point.block && a.item === point.item);
    if (idx < 0) idx = Math.max(0, model.addrs.length - 1);
    const entry = model.paras[idx];
    if (!entry || entry.runs.length === 0) {
        return { node: entry ? entry.el : model.paras[0].el, offset: 0 };
    }
    let acc = 0;
    for (const run of entry.runs) {
        if (point.offset < acc + run.length) {
            const delta = point.offset - acc;
            if (run.br) {
                const parent = run.node.parentNode;
                const at = parent ? Array.prototype.indexOf.call(parent.childNodes, run.node) : 0;
                return { node: parent ?? run.node, offset: at + (delta >= 1 ? 1 : 0) };
            }
            return { node: run.node, offset: run.start + delta };
        }
        acc += run.length;
    }
    const last = entry.runs[entry.runs.length - 1];
    if (last.br) {
        const parent = last.node.parentNode;
        const at = parent ? Array.prototype.indexOf.call(parent.childNodes, last.node) : 0;
        return { node: parent ?? last.node, offset: at + 1 };
    }
    return { node: last.node, offset: last.start + last.length };
}

/* ------------------------------------------------------------------ */
/* Localización del host (centinela)                                    */
/* ------------------------------------------------------------------ */

/** Elemento MÁS PROFUNDO cuyo texto contiene el centinela. */
export function findSentinelHost(root: Element): HTMLElement | null {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let textNode: Node | null = walker.nextNode();
    while (textNode) {
        if ((textNode.nodeValue ?? "").includes(INLINE_HOST_SENTINEL)) {
            const parent = textNode.parentElement;
            if (parent && !parent.closest("[data-wjs-inline-marker]")) return parent;
        }
        textNode = walker.nextNode();
    }
    return null;
}

/* ------------------------------------------------------------------ */
/* Snapshot de undo local de la sesión (§8.7 / D4)                      */
/* ------------------------------------------------------------------ */

interface RichSnapshot {
    kind: "rich";
    doc: RichDoc;
    sel: DocSelection | null;
}

interface PlainSnapshot {
    kind: "plain";
    value: string;
    caret: number;
}

type Snapshot = RichSnapshot | PlainSnapshot;

const UNDO_LIMIT = 200;

/* ------------------------------------------------------------------ */
/* Componente                                                           */
/* ------------------------------------------------------------------ */

interface SessionState {
    host: HTMLElement;
    frameDoc: Document;
    restore: {
        contentEditable: string | null;
        style: string | null;
        innerHTML: string;
        spellcheck: string | null;
    };
    composing: boolean;
    mouseSelecting: boolean;
    /**
     * GUARD anti-pérdida (F3.5): true ⇒ el pipeline no puede representar el
     * contenido inicial sin perder texto — la sesión es SOLO LECTURA y jamás
     * emite commits (política del programa: preservar > editar).
     */
    readOnly: boolean;
    /** Última selección de modelo conocida (para snapshots de tecleo). */
    lastSel: DocSelection | null;
    lastDoc: RichDoc | null;
    lastPlain: string;
    lastEmitted: string | null;
    pendingMarks: Marks | null;
    pendingCaret: DocPoint | null;
    /** Selección capturada al abrir el popover de enlace. */
    linkSel: DocSelection | null;
    undoStack: Snapshot[];
    redoStack: Snapshot[];
    lastOpWasTyping: boolean;
    popoverOpen: boolean;
}

export default function VersoTextSurface({
    nodeId,
    schema,
    initialValue,
    onContent,
    onRequestEnd,
    applyRef,
}: VersoTextSurfaceProps): React.ReactElement {
    const markerRef = React.useRef<HTMLSpanElement | null>(null);
    const fallbackRef = React.useRef<HTMLDivElement | null>(null);
    const [useFallback, setUseFallback] = React.useState(false);
    const [readOnlyNotice, setReadOnlyNotice] = React.useState(false);
    const [frameDoc, setFrameDoc] = React.useState<Document | null>(null);
    const [bubbleState, setBubbleState] = React.useState<BubbleSelectionState | null>(null);
    const bubbleRef = React.useRef<VersoBubbleMenuHandle | null>(null);
    const sessionRef = React.useRef<SessionState | null>(null);

    const onContentRef = React.useRef(onContent);
    onContentRef.current = onContent;
    const onRequestEndRef = React.useRef(onRequestEnd);
    onRequestEndRef.current = onRequestEnd;

    React.useLayoutEffect(() => {
        const marker = markerRef.current;
        if (!marker) return;
        const blockRoot =
            marker.closest("[data-wjs-block-id]") ?? marker.parentElement ?? marker;
        const host: HTMLElement | null = useFallback
            ? fallbackRef.current
            : findSentinelHost(blockRoot);
        if (!host) {
            if (!useFallback) setUseFallback(true);
            return;
        }
        const doc = host.ownerDocument;
        const parentDoc = document;

        const s: SessionState = {
            host,
            frameDoc: doc,
            restore: {
                contentEditable: host.getAttribute("contenteditable"),
                style: host.getAttribute("style"),
                innerHTML: host.innerHTML,
                spellcheck: host.getAttribute("spellcheck"),
            },
            composing: false,
            mouseSelecting: false,
            readOnly: false,
            lastSel: null,
            lastDoc: null,
            lastPlain: initialValue,
            lastEmitted: null,
            pendingMarks: null,
            pendingCaret: null,
            linkSel: null,
            undoStack: [],
            redoStack: [],
            lastOpWasTyping: false,
            popoverOpen: false,
        };
        sessionRef.current = s;
        setFrameDoc(doc);

        /* ------------------ toma de posesión del host ------------------ */
        host.setAttribute("data-wjs-inline", nodeId);
        host.setAttribute("data-wjs-inline-editor", schema);
        if (schema === "rich") {
            // GUARD FAIL-CLOSED (política F3.5: lo que no se entiende se
            // PRESERVA, nunca se destruye): antes de aceptar una sola
            // mutación, el pipeline entero demuestra que no pierde texto.
            // (a) motor puro: parse→serialize del HTML inicial; (b) capa DOM:
            // la relectura DOM→modelo del walker sobre lo recién pintado (la
            // capa que truncó Text-m2: instanceof cross-realm en el iframe).
            const refEl = doc.createElement("div");
            refEl.innerHTML = sanitizeHTML(initialValue);
            const refText = refEl.textContent ?? "";
            const model = parseRichHtml(initialValue);
            if (inlineGuardLosesText(refText, docGuardText(model))) {
                s.readOnly = true;
            } else {
                host.innerHTML = serializeDocForEditor(model);
                s.lastDoc = model;
                const readBack = readRichModel(host);
                if (inlineGuardLosesText(refText, docGuardText(readBack.doc))) {
                    s.readOnly = true;
                }
            }
            if (s.readOnly) {
                console.error(
                    `[verso-inline] guard anti-pérdida: el pipeline parse/serialize/DOM pierde texto del contenido inicial del nodo ${nodeId} — sesión en SOLO LECTURA, sin commits.`,
                );
                // Pinta el contenido REAL intacto (lo que el bloque renderiza
                // normalmente), sin contenteditable: nada que editar = nada
                // que perder. La sesión se cierra con Escape o click fuera.
                host.innerHTML = sanitizeHTML(initialValue);
                host.setAttribute("data-wjs-inline-readonly", "");
            }
        } else {
            host.textContent = initialValue;
            if (initialValue.length === 0) {
                const br = doc.createElement("br");
                br.setAttribute(FILLER_BR_ATTR, "");
                host.appendChild(br);
            }
        }
        setReadOnlyNotice(s.readOnly);
        if (!s.readOnly) {
            host.setAttribute("contenteditable", "true");
            host.setAttribute("spellcheck", "false");
            host.style.whiteSpace = "pre-wrap";
            host.style.outline = "none";
            // Autofocus al final (paridad con autofocus:"end" del legacy).
            host.focus();
            const endRange = doc.createRange();
            endRange.selectNodeContents(host);
            endRange.collapse(false);
            const sel0 = doc.getSelection();
            sel0?.removeAllRanges();
            sel0?.addRange(endRange);
        }

        /* --------------------------- helpers --------------------------- */
        const readRich = (): SurfaceModel => readRichModel(host as HTMLElement);

        const readModelSelection = (model: SurfaceModel): DocSelection | null => {
            const sel = doc.getSelection();
            if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return null;
            if (!host!.contains(sel.anchorNode) || !host!.contains(sel.focusNode)) return null;
            const anchor = domPointToModel(doc, model, sel.anchorNode, sel.anchorOffset);
            const focus = domPointToModel(doc, model, sel.focusNode, sel.focusOffset);
            if (!anchor || !focus) return null;
            return { anchor, focus };
        };

        const caretAtEnd = (model: SurfaceModel): DocSelection => {
            const lastIdx = model.addrs.length - 1;
            const addr = model.addrs[lastIdx] ?? { block: 0, item: null };
            let len = 0;
            const entry = model.paras[lastIdx];
            if (entry) for (const run of entry.runs) len += run.length;
            const p: DocPoint = { block: addr.block, item: addr.item, offset: len };
            return { anchor: { ...p }, focus: { ...p } };
        };

        const setDomSelection = (model: SurfaceModel, selM: DocSelection): void => {
            const a = modelPointToDom(model, selM.anchor);
            const f = modelPointToDom(model, selM.focus);
            const sel = doc.getSelection();
            if (!sel) return;
            const range = doc.createRange();
            try {
                range.setStart(a.node, a.offset);
                range.setEnd(f.node, f.offset);
            } catch {
                return;
            }
            sel.removeAllRanges();
            sel.addRange(range);
        };

        const emitRich = (model: RichDoc): void => {
            if (s.readOnly) return; // guard fail-closed: JAMÁS un commit
            const raw = serializeDoc(model);
            if (raw === s.lastEmitted) return;
            s.lastEmitted = raw;
            onContentRef.current(raw);
        };

        const emitPlain = (value: string): void => {
            if (s.readOnly) return; // guard fail-closed: JAMÁS un commit
            if (value === s.lastEmitted) return;
            s.lastEmitted = value;
            onContentRef.current(value);
        };

        const renderRich = (model: RichDoc, selM: DocSelection | null): SurfaceModel => {
            host!.innerHTML = serializeDocForEditor(model);
            const m2 = readRich();
            if (selM) setDomSelection(m2, selM);
            s.lastDoc = m2.doc;
            return m2;
        };

        const pushUndo = (snap: Snapshot, typing: boolean): void => {
            if (typing && s.lastOpWasTyping) {
                s.lastOpWasTyping = true;
                return; // coalescencia de tecleo consecutivo
            }
            s.undoStack.push(snap);
            if (s.undoStack.length > UNDO_LIMIT) s.undoStack.shift();
            s.redoStack = [];
            s.lastOpWasTyping = typing;
        };

        const currentSnapshot = (): Snapshot => {
            if (schema === "rich") {
                const model = readRich();
                return { kind: "rich", doc: model.doc, sel: readModelSelection(model) };
            }
            const entry = readPlainEntry(host as HTMLElement);
            const value = plainValueOf(entry);
            const selP = readPlainSelection(entry);
            return { kind: "plain", value, caret: selP ? selP.to : value.length };
        };

        const readPlainSelection = (entry: ParaEntry): { from: number; to: number } | null => {
            const sel = doc.getSelection();
            if (!sel || !sel.anchorNode || !sel.focusNode) return null;
            if (!host!.contains(sel.anchorNode) || !host!.contains(sel.focusNode)) return null;
            const a = paraOffsetOfDomPoint(doc, entry, sel.anchorNode, sel.anchorOffset);
            const f = paraOffsetOfDomPoint(doc, entry, sel.focusNode, sel.focusOffset);
            return { from: Math.min(a, f), to: Math.max(a, f) };
        };

        const writePlain = (value: string, caret: number): void => {
            host!.textContent = value;
            if (value.length === 0) {
                const br = doc.createElement("br");
                br.setAttribute(FILLER_BR_ATTR, "");
                host!.appendChild(br);
            }
            const sel = doc.getSelection();
            if (!sel) return;
            const range = doc.createRange();
            const textNode = host!.firstChild;
            if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                range.setStart(textNode, Math.max(0, Math.min(caret, value.length)));
            } else {
                range.setStart(host as HTMLElement, 0);
            }
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            s.lastPlain = value;
        };

        /** Aplica una operación del motor (rich): snapshot + reescritura + emisión. */
        const applyEngineOp = (
            fn: (docM: RichDoc, selM: DocSelection) => { doc: RichDoc; selection: DocSelection },
            selOverride?: DocSelection | null,
        ): void => {
            if (schema !== "rich" || s.composing || s.readOnly) return;
            const model = readRich();
            const selM = selOverride ?? readModelSelection(model) ?? caretAtEnd(model);
            pushUndo({ kind: "rich", doc: model.doc, sel: selM }, false);
            const res = fn(model.doc, selM);
            const m2 = renderRich(res.doc, res.selection);
            emitRich(m2.doc);
            updateBubble();
        };

        const undo = (): void => {
            const snap = s.undoStack.pop();
            if (!snap) return;
            const current = currentSnapshot();
            s.redoStack.push(current);
            restoreSnapshot(snap);
            s.lastOpWasTyping = false;
        };

        const redo = (): void => {
            const snap = s.redoStack.pop();
            if (!snap) return;
            s.undoStack.push(currentSnapshot());
            restoreSnapshot(snap);
            s.lastOpWasTyping = false;
        };

        const restoreSnapshot = (snap: Snapshot): void => {
            if (snap.kind === "rich") {
                const m2 = renderRich(snap.doc, snap.sel);
                emitRich(m2.doc);
            } else {
                writePlain(snap.value, snap.caret);
                emitPlain(snap.value);
            }
            updateBubble();
        };

        /** Tecleo/borrado nativo → re-parse del DOM y emisión (sin reescritura). */
        const syncFromDom = (): void => {
            if (s.composing || s.readOnly) return;
            if (schema === "rich") {
                const prev = s.lastDoc;
                const model = readRich();
                const raw = serializeDoc(model.doc);
                if (raw !== s.lastEmitted && prev) {
                    pushUndo({ kind: "rich", doc: prev, sel: s.lastSel }, true);
                }
                s.lastDoc = model.doc;
                emitRich(model.doc);
            } else {
                const entry = readPlainEntry(host as HTMLElement);
                const value = plainValueOf(entry);
                if (value !== s.lastEmitted) {
                    pushUndo({ kind: "plain", value: s.lastPlain, caret: s.lastPlain.length }, true);
                }
                s.lastPlain = value;
                emitPlain(value);
            }
        };

        /* ----------------------- bubble (solo rich) --------------------- */
        const updateBubble = (): void => {
            if (schema !== "rich" || s.readOnly) return;
            const sel = doc.getSelection();
            const inHost =
                !!sel && sel.rangeCount > 0 && !!sel.anchorNode && host!.contains(sel.anchorNode);
            if (!inHost || !sel || sel.isCollapsed || s.mouseSelecting || s.composing) {
                if (!s.popoverOpen) setBubbleState(null);
                return;
            }
            const model = readRich();
            const selM = readModelSelection(model);
            if (!selM || isCollapsed(selM)) {
                if (!s.popoverOpen) setBubbleState(null);
                return;
            }
            s.lastSel = selM;
            const rect = sel.getRangeAt(0).getBoundingClientRect();
            setBubbleState({
                rect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
                active: activeStates(model.doc, selM),
            });
        };

        /* ------------- texto AJENO ya fusionado (colaboración) ---------- */

        /**
         * Publica en el editable el valor que trae el documento tras fusionar la edición de otra
         * persona. Es lo que convierte "converge en el modelo" en "se puede escribir a la vez":
         * sin esto, el editable seguiría enseñando TU versión, y tu siguiente pulsación mandaría
         * un texto sin las letras del otro — que el diff del puente traduciría, con toda la razón
         * del mundo, como "bórralas".
         *
         * No emite: el documento ya tiene este valor. No apila undo: lo ajeno no es tuyo para
         * deshacerlo. Y no toca nada durante una composición IME (§7) ni en solo lectura.
         */
        const applyExternal = (value: string): boolean => {
            if (s.readOnly || s.composing) return false;
            if (schema === "plain") {
                const entry = readPlainEntry(host as HTMLElement);
                const current = plainValueOf(entry);
                if (current === value) return false;
                const selP = readPlainSelection(entry);
                const caret = selP ? selP.to : current.length;
                writePlain(value, mapOffset(current, value, caret));
                s.lastEmitted = value;
                return true;
            }
            const model = readRich();
            if (serializeDoc(model.doc) === value) return false;
            const nextDoc = normalizeDoc(parseRichHtml(value));
            // MISMO guard fail-closed que al abrir la sesión: si el valor ajeno no sobrevive al
            // pipeline, se deja el editable como está — preservar > pintar.
            if (inlineGuardLosesText(docGuardText(parseRichHtml(value)), docGuardText(nextDoc))) {
                return false;
            }
            const m2 = renderRich(nextDoc, reconcileSelection(model.doc, nextDoc, readModelSelection(model)));
            s.lastEmitted = serializeDoc(m2.doc);
            updateBubble();
            return true;
        };
        if (applyRef) applyRef.current = applyExternal;

        /* --------------------------- listeners -------------------------- */
        const onKeyDown = (e: KeyboardEvent): void => {
            // §7.2: NADA se intercepta durante una composición IME (D12).
            if (e.isComposing || e.keyCode === 229) return;
            const mod = e.ctrlKey || e.metaKey;
            const key = e.key.toLowerCase();

            if (e.key === "Enter") {
                e.preventDefault();
                if (schema === "plain") return; // bloqueado (§3.2)
                applyEngineOp((d, selM) => insertParagraphBreak(d, selM, e.shiftKey));
                return;
            }
            if (e.key === "Tab") {
                // D6: sin listas anidadas; el foco no sale del editable.
                e.preventDefault();
                return;
            }
            if (mod && !e.altKey && (key === "z" || key === "y")) {
                // §8.7: undo local de la sesión; JAMÁS llega al undo global.
                e.preventDefault();
                e.stopPropagation();
                if (key === "y" || (key === "z" && e.shiftKey)) redo();
                else undo();
                return;
            }
            if (mod && !e.altKey && (key === "b" || key === "i")) {
                e.preventDefault();
                e.stopPropagation();
                if (schema === "plain") return; // no-op (§3.2)
                const mark = key === "b" ? "bold" : "italic";
                const model = readRich();
                const selM = readModelSelection(model);
                if (!selM) return;
                if (isCollapsed(selM)) {
                    // Marca pendiente (§3.1): sin cambio de HTML; se aplica al
                    // siguiente texto y muere al mover el caret.
                    const base = s.pendingMarks ?? caretMarks(model.doc, selM.anchor);
                    const next = cloneMarks(base);
                    next[mark] = !base[mark];
                    s.pendingMarks = next;
                    s.pendingCaret = { ...selM.anchor };
                    return;
                }
                applyEngineOp((d, sm) => toggleMark(d, sm, mark), selM);
                return;
            }
            if (mod && !e.altKey && key === "k") {
                // D3: Mod+K abre el popover de enlace (solo rich, selección no vacía).
                e.preventDefault();
                e.stopPropagation();
                if (schema !== "rich") return;
                const model = readRich();
                const selM = readModelSelection(model);
                if (!selM || isCollapsed(selM)) return;
                s.linkSel = selM;
                updateBubble();
                bubbleRef.current?.openLinkPopover();
                return;
            }
            // D2: atajos de marcas fuera de contrato = no-op explícito.
            if (mod && !e.altKey && (key === "u" || key === "e")) {
                e.preventDefault();
                return;
            }
            if (mod && e.shiftKey && (key === "s" || key === "7" || key === "8")) {
                e.preventDefault();
                return;
            }
        };

        const onBeforeInput = (e: InputEvent): void => {
            if (e.isComposing) return;
            const t = e.inputType;
            if (t === "insertParagraph" || t === "insertLineBreak") {
                // Cinturón para teclados virtuales que no emiten keydown Enter.
                e.preventDefault();
                if (schema === "plain") return;
                applyEngineOp((d, selM) => insertParagraphBreak(d, selM, t === "insertLineBreak"));
                return;
            }
            if (t === "historyUndo") {
                e.preventDefault();
                undo();
                return;
            }
            if (t === "historyRedo") {
                e.preventDefault();
                redo();
                return;
            }
            if (t.startsWith("format")) {
                // Formateo nativo del navegador (p. ej. Cmd+B de Safari): fuera.
                e.preventDefault();
                return;
            }
            if (t === "insertText" && schema === "rich" && s.pendingMarks) {
                e.preventDefault();
                const marks = s.pendingMarks;
                s.pendingMarks = null;
                s.pendingCaret = null;
                applyEngineOp((d, selM) => insertText(d, selM, e.data ?? "", marks));
                s.lastOpWasTyping = true;
                return;
            }
        };

        const onInput = (): void => {
            syncFromDom();
        };

        const onPaste = (e: ClipboardEvent): void => {
            e.preventDefault();
            const html = e.clipboardData?.getData("text/html") ?? "";
            const text = e.clipboardData?.getData("text/plain") ?? "";
            if (schema === "plain") {
                const insertTextPlain = plainPasteText(
                    { html: html || undefined, text: text || undefined },
                    sanitizeHTML,
                );
                const entry = readPlainEntry(host as HTMLElement);
                const value = plainValueOf(entry);
                const selP = readPlainSelection(entry) ?? {
                    from: value.length,
                    to: value.length,
                };
                pushUndo({ kind: "plain", value, caret: selP.to }, false);
                const res = plainReplaceRange(value, selP.from, selP.to, insertTextPlain);
                writePlain(res.value, res.caret);
                emitPlain(res.value);
                return;
            }
            applyEngineOp((d, selM) =>
                pasteRich(d, selM, { html: html || undefined, text: text || undefined }, sanitizeHTML),
            );
        };

        const onCompositionStart = (): void => {
            s.composing = true;
        };
        const onCompositionEnd = (): void => {
            s.composing = false;
            // §7.1: una sola emisión con el estado POST-composición.
            syncFromDom();
            updateBubble();
        };

        const onDragStart = (e: Event): void => {
            // Cinturón (spec §5): un arrastre de selección no debe llegar al DnD.
            e.stopPropagation();
        };

        const onSelectionChange = (): void => {
            // La marca pendiente muere al mover el caret (§3.1).
            if (s.pendingMarks && schema === "rich" && !s.composing) {
                const model = readRich();
                const selM = readModelSelection(model);
                if (
                    !selM ||
                    !isCollapsed(selM) ||
                    !s.pendingCaret ||
                    selM.anchor.block !== s.pendingCaret.block ||
                    selM.anchor.item !== s.pendingCaret.item ||
                    selM.anchor.offset !== s.pendingCaret.offset
                ) {
                    s.pendingMarks = null;
                    s.pendingCaret = null;
                }
            }
            updateBubble();
        };

        const onFrameMouseDown = (e: Event): void => {
            s.mouseSelecting = true;
            handleOutsidePress(e);
        };
        const onFrameMouseUp = (): void => {
            s.mouseSelecting = false;
            // El bubble se muestra al TERMINAR la selección (spec §2.2).
            updateBubble();
        };

        const handleOutsidePress = (e: Event): void => {
            const t = e.target as Node | null;
            if (!t) return;
            const inEditor = host!.contains(t);
            const inBubble =
                isElementNode(t) && !!t.closest("[data-wjs-inline-bubble]");
            if (inEditor || inBubble) return;
            onRequestEndRef.current();
        };

        const onAnyKeyDownCapture = (e: Event): void => {
            const ke = e as KeyboardEvent;
            if (ke.key !== "Escape") return;
            // §7.2: Escape durante composición cancela el candidato, no la sesión.
            if (ke.isComposing || ke.keyCode === 229) return;
            ke.stopPropagation(); // que no lo consuman el DnD ni el modo mover
            // Primer Escape con el popover abierto: solo cierra el popover (§4.2).
            if (bubbleRef.current?.closeLinkPopover()) return;
            onRequestEndRef.current();
        };

        const onScrollCapture = (): void => {
            updateBubble();
        };

        // En SOLO LECTURA no se escucha NINGUNA mutación: solo Escape y el
        // click-fuera (abajo, sobre los documentos) para poder salir.
        if (!s.readOnly) {
            host.addEventListener("keydown", onKeyDown);
            host.addEventListener("beforeinput", onBeforeInput as EventListener);
            host.addEventListener("input", onInput);
            host.addEventListener("paste", onPaste as EventListener);
            host.addEventListener("compositionstart", onCompositionStart);
            host.addEventListener("compositionend", onCompositionEnd);
            host.addEventListener("dragstart", onDragStart);
            doc.addEventListener("selectionchange", onSelectionChange);
            doc.addEventListener("scroll", onScrollCapture, true);
        }
        const docs: Document[] = doc === parentDoc ? [doc] : [doc, parentDoc];
        for (const d of docs) {
            d.addEventListener("mousedown", onFrameMouseDown, true);
            d.addEventListener("mouseup", onFrameMouseUp, true);
            d.addEventListener("keydown", onAnyKeyDownCapture, true);
        }

        return () => {
            host!.removeEventListener("keydown", onKeyDown);
            host!.removeEventListener("beforeinput", onBeforeInput as EventListener);
            host!.removeEventListener("input", onInput);
            host!.removeEventListener("paste", onPaste as EventListener);
            host!.removeEventListener("compositionstart", onCompositionStart);
            host!.removeEventListener("compositionend", onCompositionEnd);
            host!.removeEventListener("dragstart", onDragStart);
            doc.removeEventListener("selectionchange", onSelectionChange);
            doc.removeEventListener("scroll", onScrollCapture, true);
            for (const d of docs) {
                d.removeEventListener("mousedown", onFrameMouseDown, true);
                d.removeEventListener("mouseup", onFrameMouseUp, true);
                d.removeEventListener("keydown", onAnyKeyDownCapture, true);
            }
            // Devuelve el host TAL CUAL estaba (React re-monta el bloque con el
            // valor committeado al salir; esto cubre StrictMode y fail-softs).
            const r = s.restore;
            if (r.contentEditable === null) host!.removeAttribute("contenteditable");
            else host!.setAttribute("contenteditable", r.contentEditable);
            if (r.spellcheck === null) host!.removeAttribute("spellcheck");
            else host!.setAttribute("spellcheck", r.spellcheck);
            if (r.style === null) host!.removeAttribute("style");
            else host!.setAttribute("style", r.style);
            host!.removeAttribute("data-wjs-inline");
            host!.removeAttribute("data-wjs-inline-editor");
            host!.removeAttribute("data-wjs-inline-readonly");
            host!.innerHTML = r.innerHTML;
            sessionRef.current = null;
            if (applyRef) applyRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [useFallback, nodeId, schema]);

    /* --------------------- callbacks del bubble ---------------------- */
    const withSession = React.useCallback(
        (fn: (s: SessionState) => void): void => {
            const s = sessionRef.current;
            if (s) fn(s);
        },
        [],
    );

    const applyFromBubble = React.useCallback(
        (
            op: (docM: RichDoc, selM: DocSelection) => { doc: RichDoc; selection: DocSelection },
            useLinkSel = false,
        ): void => {
            withSession((s) => {
                if (s.composing || s.readOnly) return;
                const model = readRichModel(s.host);
                const domSel = ((): DocSelection | null => {
                    const sel = s.frameDoc.getSelection();
                    if (!sel || !sel.anchorNode || !sel.focusNode) return null;
                    if (!s.host.contains(sel.anchorNode) || !s.host.contains(sel.focusNode)) {
                        return null;
                    }
                    const anchor = domPointToModel(s.frameDoc, model, sel.anchorNode, sel.anchorOffset);
                    const focus = domPointToModel(s.frameDoc, model, sel.focusNode, sel.focusOffset);
                    return anchor && focus ? { anchor, focus } : null;
                })();
                const selM = (useLinkSel ? s.linkSel : null) ?? domSel ?? s.lastSel;
                if (!selM) return;
                s.undoStack.push({ kind: "rich", doc: model.doc, sel: selM });
                if (s.undoStack.length > UNDO_LIMIT) s.undoStack.shift();
                s.redoStack = [];
                s.lastOpWasTyping = false;
                const res = op(model.doc, selM);
                s.host.innerHTML = serializeDocForEditor(res.doc);
                const m2 = readRichModel(s.host);
                const a = modelPointToDom(m2, res.selection.anchor);
                const f = modelPointToDom(m2, res.selection.focus);
                const domSel2 = s.frameDoc.getSelection();
                if (domSel2) {
                    const range = s.frameDoc.createRange();
                    try {
                        range.setStart(a.node, a.offset);
                        range.setEnd(f.node, f.offset);
                        domSel2.removeAllRanges();
                        domSel2.addRange(range);
                    } catch {
                        /* selección irrecuperable: el modelo ya está aplicado */
                    }
                }
                s.lastDoc = m2.doc;
                s.linkSel = null;
                const raw = serializeDoc(m2.doc);
                if (raw !== s.lastEmitted) {
                    s.lastEmitted = raw;
                    onContentRef.current(raw);
                }
                // Reposiciona/actualiza el bubble con la selección restaurada.
                const selNow = s.frameDoc.getSelection();
                if (selNow && selNow.rangeCount > 0 && !selNow.isCollapsed) {
                    const rect = selNow.getRangeAt(0).getBoundingClientRect();
                    const selM2 = { anchor: res.selection.anchor, focus: res.selection.focus };
                    setBubbleState({
                        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
                        active: activeStates(m2.doc, selM2),
                    });
                } else {
                    setBubbleState(null);
                }
            });
        },
        [withSession],
    );

    const onPopoverOpenChange = React.useCallback(
        (open: boolean): void => {
            withSession((s) => {
                s.popoverOpen = open;
                if (open) {
                    // Captura la selección (el input roba el foco del iframe).
                    const model = readRichModel(s.host);
                    const sel = s.frameDoc.getSelection();
                    if (sel && sel.anchorNode && sel.focusNode && s.host.contains(sel.anchorNode)) {
                        const anchor = domPointToModel(s.frameDoc, model, sel.anchorNode, sel.anchorOffset);
                        const focus = domPointToModel(s.frameDoc, model, sel.focusNode, sel.focusOffset);
                        if (anchor && focus) s.linkSel = { anchor, focus };
                    }
                    s.linkSel = s.linkSel ?? s.lastSel;
                }
            });
        },
        [withSession],
    );

    return (
        <>
            <span ref={markerRef} data-wjs-inline-marker="" style={{ display: "none" }} />
            {useFallback && (
                // Fail-soft: el bloque no pinta la prop → editable propio in situ.
                <div ref={fallbackRef} data-wjs-inline-fallback="" />
            )}
            {readOnlyNotice && (
                // Aviso visible del guard anti-pérdida (mismo patrón de nota
                // fail-soft que el placeholder data-verso-missing del blueprint).
                <div
                    data-wjs-inline-readonly-notice=""
                    role="note"
                    className="rounded border border-dashed border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-high)] px-3 py-2 text-xs text-[var(--ed-on-surface-variant)]"
                >
                    Edición inline desactivada: el motor no puede representar este
                    contenido sin pérdida, así que el bloque queda en solo lectura
                    para preservarlo. Cierra con Escape o haz click fuera.
                </div>
            )}
            {schema === "rich" && frameDoc && (
                <VersoBubbleMenu
                    ref={bubbleRef}
                    frameDoc={frameDoc}
                    state={bubbleState}
                    onToggleBold={() => applyFromBubble((d, sm) => toggleMark(d, sm, "bold"))}
                    onToggleItalic={() => applyFromBubble((d, sm) => toggleMark(d, sm, "italic"))}
                    onToggleList={(ordered) =>
                        applyFromBubble((d, sm) => {
                            const st = activeStates(d, sm);
                            const already = ordered ? st.orderedList : st.bulletList;
                            return already ? unlist(d, sm) : setList(d, sm, ordered);
                        })
                    }
                    onClearFormat={() => applyFromBubble((d, sm) => clearFormat(d, sm))}
                    onApplyLink={(href, newTab) =>
                        applyFromBubble((d, sm) => applyLink(d, sm, { href, newTab }), true)
                    }
                    onUnlink={() => applyFromBubble((d, sm) => removeLink(d, sm), true)}
                    onPopoverOpenChange={onPopoverOpenChange}
                />
            )}
        </>
    );
}
