/**
 * Verso — motor de texto inline (F3.5): parser tolerante + PROYECCIÓN al subset.
 *
 * Dos fases, ambas puras (sin DOM — testeables en node):
 *
 * 1. `tokenizeHtml` — mini-parser HTML tolerante (árbol ligero). Acepta lo que
 *    emite sanitizeHTML (superset del subset del motor: span[style], divs,
 *    h1..h6, tablas…) y también HTML sucio del portapapeles: cierres huérfanos
 *    se ignoran, `<p>`/`<li>` abiertos se auto-cierran al reabrirse, void tags
 *    HTML5, entidades con y sin nombre. NO es un parser genérico: es la
 *    tolerancia mínima para contenido ya saneado + pegado real.
 *
 * 2. `projectNodes` — proyección al modelo (spec §6.2 y D1/D2/D5/D6/D11):
 *    b→strong, i→em, h1..h6→p, div/section/… desenvueltos a párrafos,
 *    ul/ol/li conservados (li normalizado a li>p, listas anidadas APLANADAS a
 *    hermanas), `a` conserva href verbatim (+target="_blank"→newTab; cualquier
 *    otro target se descarta; rel se RECALCULA al serializar — D11), todo lo
 *    demás (span[style], u, s, code, mark…) se desenvuelve a su texto, y los
 *    elementos sin contenido textual se descartan. `<p></p>` EXPLÍCITO se
 *    conserva (línea en blanco / li recién partido).
 *
 * `parseRichHtml` = tokenize + project + normalize. Es idempotente vía
 * serialize (gate de test): parse(serialize(parse(x))) === parse(x).
 */

import type { Block, InlineUnit, Marks, Para, RichDoc } from "./model";
import { NO_MARKS, cloneMarks, emptyPara, normalizeDoc, normalizePara, paraText } from "./model";
import { FILLER_BR_ATTR } from "./serialize";

/* ------------------------------------------------------------------ */
/* Árbol ligero                                                         */
/* ------------------------------------------------------------------ */

export interface ParseElement {
    kind: "el";
    tag: string;
    attrs: Record<string, string>;
    children: ParseNode[];
}

export interface ParseText {
    kind: "text";
    text: string;
}

export type ParseNode = ParseElement | ParseText;

const VOID_TAGS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
]);

/** Elementos cuyo CONTENIDO se descarta entero (texto incluido). */
const DROP_WITH_CONTENT = new Set([
    "script", "style", "textarea", "select", "option", "iframe", "object",
    "embed", "svg", "math", "head", "title", "noscript", "template",
]);

/** Tags que auto-cierran una instancia previa abierta del MISMO tag. */
const SELF_CLOSING_SIBLINGS = new Set(["p", "li", "tr", "td", "th"]);

const NAMED_ENTITIES: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    nbsp: " ", copy: "©", reg: "®", trade: "™",
    hellip: "…", mdash: "—", ndash: "–",
    lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

export function decodeEntities(s: string): string {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (all, body: string) => {
        if (body.startsWith("#x") || body.startsWith("#X")) {
            const cp = Number.parseInt(body.slice(2), 16);
            return Number.isFinite(cp) ? safeFromCodePoint(cp, all) : all;
        }
        if (body.startsWith("#")) {
            const cp = Number.parseInt(body.slice(1), 10);
            return Number.isFinite(cp) ? safeFromCodePoint(cp, all) : all;
        }
        return NAMED_ENTITIES[body] ?? all;
    });
}

function safeFromCodePoint(cp: number, fallback: string): string {
    try {
        return String.fromCodePoint(cp);
    } catch {
        return fallback;
    }
}

const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;

/**
 * Los ÚNICOS atributos que el motor lee (marksFor: href/target; isFillerBr: el marcador del <br>
 * de relleno). Todo lo demás se descartaba igualmente en la proyección — pero se GUARDABA antes,
 * y ahí estaba el agujero: `attrs[name] = …` con un `name` que sale del HTML pegado deja que quien
 * escribe el HTML elija la CLAVE, no solo el valor (remote property injection). Con `<b __proto__=…>`
 * la escritura no crea propiedad propia sino que toca el prototipo, y con `<b constructor=…>` /
 * `<b toString=…>` se sombrea lo que el objeto hereda: un lookup posterior deja de responder lo que
 * el llamador cree. La estructura la fija ahora esta allowlist —el HTML ya solo aporta VALORES—
 * reforzada por un objeto sin prototipo y por `Object.hasOwn` en cada lectura.
 */
const KEPT_ATTRS: ReadonlySet<string> = new Set([FILLER_BR_ATTR, "href", "target"]);

function parseAttrs(raw: string): Record<string, string> {
    const attrs = Object.create(null) as Record<string, string>;
    ATTR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATTR_RE.exec(raw)) !== null) {
        const name = m[1].toLowerCase();
        if (!KEPT_ATTRS.has(name)) continue; // incluye el "/" del cierre autocontenido
        const value = m[3] ?? m[4] ?? (m[2] !== undefined ? m[2] : "");
        attrs[name] = decodeEntities(value);
    }
    return attrs;
}

/** Lectura de un atributo: propiedad PROPIA o nada (nunca algo heredado del prototipo). */
function attr(el: ParseElement, name: string): string | undefined {
    return Object.hasOwn(el.attrs, name) ? el.attrs[name] : undefined;
}

/** Parser HTML tolerante → fragmento de árbol ligero. */
export function tokenizeHtml(html: string): ParseNode[] {
    const roots: ParseNode[] = [];
    const stack: ParseElement[] = [];
    const pushNode = (n: ParseNode): void => {
        (stack.length ? stack[stack.length - 1].children : roots).push(n);
    };
    let i = 0;
    while (i < html.length) {
        const lt = html.indexOf("<", i);
        if (lt < 0) {
            pushNode({ kind: "text", text: decodeEntities(html.slice(i)) });
            break;
        }
        if (lt > i) pushNode({ kind: "text", text: decodeEntities(html.slice(i, lt)) });
        // Comentarios y doctype.
        if (html.startsWith("<!--", lt)) {
            const end = html.indexOf("-->", lt + 4);
            i = end < 0 ? html.length : end + 3;
            continue;
        }
        if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
            const end = html.indexOf(">", lt + 2);
            i = end < 0 ? html.length : end + 1;
            continue;
        }
        // Fin de tag respetando comillas dentro de atributos.
        let j = lt + 1;
        let quote: string | null = null;
        while (j < html.length) {
            const c = html[j];
            if (quote) {
                if (c === quote) quote = null;
            } else if (c === '"' || c === "'") {
                quote = c;
            } else if (c === ">") {
                break;
            }
            j++;
        }
        if (j >= html.length) {
            // "<" suelto sin cierre: texto literal.
            pushNode({ kind: "text", text: html.slice(lt) });
            break;
        }
        const rawTag = html.slice(lt + 1, j);
        i = j + 1;
        const closing = rawTag.startsWith("/");
        const nameMatch = /^\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(rawTag);
        if (!nameMatch) continue; // "<>": basura, se ignora
        const tag = nameMatch[1].toLowerCase();
        if (closing) {
            // Cierra hasta el tag correspondiente; huérfano → se ignora.
            let k = stack.length - 1;
            while (k >= 0 && stack[k].tag !== tag) k--;
            if (k >= 0) stack.length = k;
            continue;
        }
        if (DROP_WITH_CONTENT.has(tag)) {
            // Salta el contenido entero hasta su cierre (o el final).
            const closeAt = html.toLowerCase().indexOf(`</${tag}`, i);
            if (closeAt < 0) break;
            const gt = html.indexOf(">", closeAt);
            i = gt < 0 ? html.length : gt + 1;
            continue;
        }
        if (SELF_CLOSING_SIBLINGS.has(tag)) {
            const top = stack[stack.length - 1];
            if (top && top.tag === tag) stack.pop();
        }
        const el: ParseElement = {
            kind: "el",
            tag,
            attrs: parseAttrs(rawTag.slice(nameMatch[0].length)),
            children: [],
        };
        pushNode(el);
        const selfClosed = rawTag.endsWith("/");
        if (!VOID_TAGS.has(tag) && !selfClosed) stack.push(el);
    }
    return roots;
}

/* ------------------------------------------------------------------ */
/* Proyección al subset                                                 */
/* ------------------------------------------------------------------ */

/** Elementos que crean UN párrafo con su contenido inline. */
const PARAGRAPH_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);

/** Contenedores que se desenvuelven a nivel de bloque. */
const CONTAINER_TAGS = new Set([
    "div", "section", "article", "header", "footer", "nav", "aside", "main",
    "figure", "figcaption", "blockquote", "pre", "address", "details", "summary",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
    "form", "fieldset", "dl", "dt", "dd", "hr",
]);

interface ProjectCtx {
    blocks: Block[];
    buf: InlineUnit[];
}

function flushBuf(ctx: ProjectCtx): void {
    if (ctx.buf.length === 0) return;
    const para = normalizePara({ units: ctx.buf });
    ctx.buf = [];
    if (para.units.length === 0) return;
    ctx.blocks.push({ kind: "p", para });
}

function isFillerBr(el: ParseElement): boolean {
    return el.tag === "br" && attr(el, FILLER_BR_ATTR) !== undefined;
}

function marksFor(el: ParseElement, m: Marks): Marks {
    if (el.tag === "strong" || el.tag === "b") return { ...cloneMarks(m), bold: true };
    if (el.tag === "em" || el.tag === "i") return { ...cloneMarks(m), italic: true };
    const href = el.tag === "a" ? attr(el, "href") : undefined;
    if (typeof href === "string") {
        return {
            ...cloneMarks(m),
            link: {
                href,
                // D11: solo target="_blank" sobrevive como newTab; rel se recalcula.
                newTab: attr(el, "target") === "_blank",
            },
        };
    }
    return m;
}

/** Contenido inline de un párrafo: texto verbatim, marcas del subset, resto desenvuelto. */
function collectInline(nodes: ParseNode[], m: Marks, buf: InlineUnit[]): void {
    for (const node of nodes) {
        if (node.kind === "text") {
            if (node.text.length > 0) buf.push({ kind: "text", text: node.text, marks: cloneMarks(m) });
            continue;
        }
        if (node.tag === "br") {
            if (!isFillerBr(node)) buf.push({ kind: "br", marks: cloneMarks(m) });
            continue;
        }
        if (node.tag === "img" || node.tag === "hr" || node.tag === "input") continue;
        // Marcas del subset heredan; CUALQUIER otro elemento se desenvuelve a su
        // contenido (D2/D11: span[style]/u/s/code/mark pierden su formato). Un
        // bloque anidado en contexto inline (raro) también se aplana aquí.
        collectInline(node.children, marksFor(node, m), buf);
    }
}

function collectParagraph(nodes: ParseNode[]): Para {
    const buf: InlineUnit[] = [];
    collectInline(nodes, NO_MARKS, buf);
    return normalizePara({ units: buf });
}

/**
 * Items de una lista, APLANANDO listas anidadas a hermanas (D6). Los items del
 * sub-nivel van DESPUÉS del contenido propio del li padre (fixture
 * paste-lista-anidada: uno, sub, dos).
 */
function collectListItems(nodes: ParseNode[], items: Para[]): void {
    // F6 (anti-pérdida, cazado por el fuzzer): un hijo directo de ul/ol que no es
    // li/ul/ol es HTML inválido, pero descartarlo ENTERO tiraba su texto (política
    // del programa: preservar > descartar). El contenido suelto se acumula y se
    // emite como item IMPLÍCITO; el whitespace de pretty-print entre <li> sigue fuera.
    let buf: InlineUnit[] = [];
    const flushLoose = (): void => {
        const para = normalizePara({ units: buf });
        buf = [];
        if (para.units.length > 0) items.push(para);
    };
    for (const node of nodes) {
        if (node.kind === "text") {
            if (buf.length === 0 && node.text.trim().length === 0) continue;
            buf.push({ kind: "text", text: node.text, marks: cloneMarks(NO_MARKS) });
            continue;
        }
        if (node.tag === "li") {
            flushLoose();
            collectLi(node, items);
        } else if (node.tag === "ul" || node.tag === "ol") {
            flushLoose();
            collectListItems(node.children, items);
        } else if (PARAGRAPH_TAGS.has(node.tag)) {
            flushLoose();
            items.push(collectParagraph(node.children));
        } else {
            // Elemento inválido dentro de la lista: su contenido inline se preserva
            // (desenvuelto, como cualquier elemento fuera del subset — D2).
            collectInline([node], NO_MARKS, buf);
        }
    }
    flushLoose();
}

function collectLi(li: ParseElement, items: Para[]): void {
    let buf: InlineUnit[] = [];
    const flushItem = (force: boolean): void => {
        const para = normalizePara({ units: buf });
        buf = [];
        if (para.units.length === 0 && !force) return;
        items.push(para);
    };
    for (const node of li.children) {
        if (node.kind === "el" && PARAGRAPH_TAGS.has(node.tag)) {
            flushItem(false);
            // <li><p>…</p></li> explícito: el item se conserva AUNQUE esté vacío
            // (round-trip del <li><p></p></li> que crea Enter).
            items.push(collectParagraph(node.children));
        } else if (node.kind === "el" && (node.tag === "ul" || node.tag === "ol")) {
            flushItem(false);
            collectListItems(node.children, items);
        } else if (node.kind === "text") {
            if (buf.length === 0 && node.text.trim().length === 0) continue;
            buf.push({ kind: "text", text: node.text, marks: cloneMarks(NO_MARKS) });
        } else {
            collectInline([node], NO_MARKS, buf);
        }
    }
    flushItem(false);
}

function walkBlock(nodes: ParseNode[], ctx: ProjectCtx): void {
    for (const node of nodes) {
        if (node.kind === "text") {
            // Whitespace de pretty-print entre bloques: fuera. Texto real suelto
            // en contexto de bloque forma un párrafo implícito (buffer).
            if (ctx.buf.length === 0 && node.text.trim().length === 0) continue;
            ctx.buf.push({ kind: "text", text: node.text, marks: cloneMarks(NO_MARKS) });
            continue;
        }
        const el = node;
        if (PARAGRAPH_TAGS.has(el.tag)) {
            flushBuf(ctx);
            // <p></p> explícito SE CONSERVA (§1.2.1: línea en blanco intermedia).
            ctx.blocks.push({ kind: "p", para: collectParagraph(el.children) });
        } else if (el.tag === "ul" || el.tag === "ol") {
            flushBuf(ctx);
            const items: Para[] = [];
            collectListItems(el.children, items);
            if (items.length > 0) {
                ctx.blocks.push({ kind: "list", ordered: el.tag === "ol", items });
            }
        } else if (el.tag === "li") {
            // li huérfano fuera de lista: trátalo como párrafo.
            flushBuf(ctx);
            ctx.blocks.push({ kind: "p", para: collectParagraph(el.children) });
        } else if (CONTAINER_TAGS.has(el.tag)) {
            flushBuf(ctx);
            walkBlock(el.children, ctx);
            flushBuf(ctx);
        } else {
            // Elemento inline (marca del subset o desconocido): acumula en el
            // párrafo implícito con las marcas que correspondan.
            collectInline([el], NO_MARKS, ctx.buf);
        }
    }
}

/**
 * HTML (ya saneado o del propio motor) → bloques del modelo. Sin bloque alguno
 * → [] (el llamador decide si eso es doc vacío o pegado nulo).
 */
export function projectHtmlToBlocks(html: string): Block[] {
    const ctx: ProjectCtx = { blocks: [], buf: [] };
    walkBlock(tokenizeHtml(html), ctx);
    flushBuf(ctx);
    return ctx.blocks;
}

/** Parse de un valor rich completo. "" o solo whitespace → doc vacío. */
export function parseRichHtml(html: string): RichDoc {
    const blocks = projectHtmlToBlocks(html);
    if (blocks.length === 0) return normalizeDoc({ blocks: [{ kind: "p", para: emptyPara() }] });
    return normalizeDoc({ blocks });
}

/**
 * Bloques PEGADOS (pipeline §6.2, tras sanitizeHTML): igual que la proyección
 * general pero descartando bloques sin contenido textual (un `<p></p>` pegado
 * no aporta nada; los explícitos del PROPIO doc sí se conservan en parse).
 */
export function projectPastedHtml(html: string): Block[] {
    return projectHtmlToBlocks(html).filter((b) => {
        if (b.kind === "p") return b.para.units.length > 0;
        b.items = b.items.filter((p) => p.units.length > 0 || paraText(p).length > 0);
        return b.items.length > 0;
    });
}
