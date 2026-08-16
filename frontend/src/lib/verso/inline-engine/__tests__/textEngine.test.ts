/**
 * Motor de texto inline PROPIO (F3.5) — suite table-driven sobre el fixture
 * ejecutable (spec §10): los 54 casos de __fixtures__/text-cases.json corren
 * contra el motor PURO (node, sin DOM). Los marcadores [[ ]] embebidos en el
 * texto del initialHtml se resuelven contra el MODELO (no contra el DOM).
 *
 * Gates adicionales de la spec:
 * - Punto fijo de sanitizeHTML sobre cada expectedHtml rich (§1.2.7). En node
 *   corre la rama SSR (sanitize-html), que re-serializa <br> como <br /> — el
 *   punto fijo se verifica módulo esa única diferencia, tal y como la propia
 *   spec lo acota.
 * - Normalización idempotente: parse→serialize→parse→serialize estable.
 * - Round-trip byte a byte sobre HTML canónico representativo.
 * - Pegado hostil (script/style/onclick/iframe fuera).
 * - Bookmark de caret en el modelo: offsets estables y válidos tras cada op.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeHTML } from "@/lib/sanitize";
import {
    type DocPoint,
    type DocSelection,
    type RichDoc,
    activeStates,
    applyLink,
    caretMarks,
    clearFormat,
    docIsEmpty,
    getPara,
    insertParagraphBreak,
    insertText,
    isCollapsed,
    listParas,
    paraLength,
    paraToAtoms,
    atomsToPara,
    parseRichHtml,
    pasteRich,
    plainPasteText,
    plainReplaceRange,
    removeLink,
    serializeDoc,
    setList,
    tokenizeHtml,
    toggleMark,
    unlist,
} from "@/lib/verso/inline-engine";

/* ------------------------------------------------------------------ */
/* Fixture                                                              */
/* ------------------------------------------------------------------ */

interface FixtureOp {
    kind: string;
    args?: {
        href?: string;
        newTab?: boolean;
        ordered?: boolean;
        text?: string;
        shift?: boolean;
        html?: string;
    };
}

interface FixtureCase {
    name: string;
    schemaKind: "rich" | "plain";
    initialHtml: string;
    op: FixtureOp;
    expectedHtml: string;
}

const fixture = JSON.parse(
    readFileSync(new URL("../__fixtures__/text-cases.json", import.meta.url), "utf8"),
) as { cases: FixtureCase[] };

/* ------------------------------------------------------------------ */
/* Resolución de marcadores contra el modelo                            */
/* ------------------------------------------------------------------ */

/**
 * Busca `marker` en el texto plano de los párrafos (br = separador imposible),
 * lo BORRA del modelo y devuelve el punto donde estaba.
 */
function extractMarker(doc: RichDoc, marker: string): DocPoint {
    for (const { addr, para } of listParas(doc)) {
        let flat = "";
        for (const u of para.units) flat += u.kind === "br" ? "￼" : u.text;
        const at = flat.indexOf(marker);
        if (at < 0) continue;
        const atoms = paraToAtoms(para);
        atoms.splice(at, marker.length);
        const cleaned = atomsToPara(atoms);
        para.units = cleaned.units;
        return { block: addr.block, item: addr.item, offset: at };
    }
    throw new Error(`marcador ${marker} no encontrado en el fixture`);
}

function loadRichCase(initialHtml: string): { doc: RichDoc; sel: DocSelection } {
    const doc = parseRichHtml(initialHtml);
    const anchor = extractMarker(doc, "[[");
    const focus = extractMarker(doc, "]]");
    return { doc, sel: { anchor, focus } };
}

function runRichOp(doc: RichDoc, sel: DocSelection, op: FixtureOp): { doc: RichDoc; selection: DocSelection } {
    const a = op.args ?? {};
    switch (op.kind) {
        case "bold":
            return toggleMark(doc, sel, "bold");
        case "italic":
            return toggleMark(doc, sel, "italic");
        case "link":
            return applyLink(doc, sel, { href: a.href ?? "", newTab: a.newTab });
        case "unlink":
            return removeLink(doc, sel);
        case "list":
            return setList(doc, sel, a.ordered === true);
        case "unlist":
            return unlist(doc, sel);
        case "clearFormat":
            return clearFormat(doc, sel);
        case "typeText":
            return insertText(doc, sel, a.text ?? "");
        case "enter":
            return insertParagraphBreak(doc, sel, a.shift === true);
        case "paste":
            return pasteRich(doc, sel, { html: a.html, text: a.text }, sanitizeHTML);
        default:
            throw new Error(`op desconocida: ${op.kind}`);
    }
}

function loadPlainCase(initial: string): { value: string; from: number; to: number } {
    const i = initial.indexOf("[[");
    let value = initial.slice(0, i) + initial.slice(i + 2);
    const j = value.indexOf("]]");
    value = value.slice(0, j) + value.slice(j + 2);
    return { value, from: i, to: j };
}

function runPlainOp(value: string, from: number, to: number, op: FixtureOp): string {
    const a = op.args ?? {};
    switch (op.kind) {
        case "typeText":
            return plainReplaceRange(value, from, to, a.text ?? "").value;
        case "enter":
        case "bold":
        case "italic":
        case "link":
        case "unlink":
        case "list":
        case "unlist":
        case "clearFormat":
            return value; // no-op en plain (§3.2, D2)
        case "paste": {
            const text = plainPasteText({ html: a.html, text: a.text }, sanitizeHTML);
            return plainReplaceRange(value, from, to, text).value;
        }
        default:
            throw new Error(`op desconocida: ${op.kind}`);
    }
}

/* ------------------------------------------------------------------ */
/* Los 54 casos del fixture, byte a byte                                */
/* ------------------------------------------------------------------ */

describe("inline-engine — fixture ejecutable (spec §10)", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(40);

    for (const c of fixture.cases) {
        it(c.name, () => {
            if (c.schemaKind === "plain") {
                const { value, from, to } = loadPlainCase(c.initialHtml);
                expect(runPlainOp(value, from, to, c.op)).toBe(c.expectedHtml);
                return;
            }
            const { doc, sel } = loadRichCase(c.initialHtml);
            const out = runRichOp(doc, sel, c.op);
            expect(serializeDoc(out.doc)).toBe(c.expectedHtml);
        });
    }
});

/* ------------------------------------------------------------------ */
/* Gate: punto fijo de sanitizeHTML sobre los expected rich (§1.2.7)    */
/* ------------------------------------------------------------------ */

describe("inline-engine — punto fijo de sanitizeHTML", () => {
    const richExpected = fixture.cases
        .filter((c) => c.schemaKind === "rich" && c.expectedHtml.length > 0)
        .map((c) => ({ name: c.name, html: c.expectedHtml }));

    for (const { name, html } of richExpected) {
        it(`sanitizeHTML es no-op sobre expected de ${name}`, () => {
            // Rama SSR (sanitize-html): re-serializa <br> con auto-cierre; la
            // spec define el punto fijo módulo esa diferencia (§1.2.7).
            const out = sanitizeHTML(html).replaceAll("<br />", "<br>");
            expect(out).toBe(html);
        });
    }
});

/* ------------------------------------------------------------------ */
/* Gate: normalización idempotente + round-trip                         */
/* ------------------------------------------------------------------ */

describe("inline-engine — normalización idempotente y round-trip", () => {
    it("parse→serialize es idempotente sobre TODOS los expected rich", () => {
        for (const c of fixture.cases) {
            if (c.schemaKind !== "rich") continue;
            const once = serializeDoc(parseRichHtml(c.expectedHtml));
            const twice = serializeDoc(parseRichHtml(once));
            expect(once).toBe(c.expectedHtml);
            expect(twice).toBe(once);
        }
    });

    it("round-trip byte a byte sobre HTML canónico representativo", () => {
        const corpus = [
            "<p>hola mundo</p>",
            "<p><strong>a<em>b</em>c</strong></p>",
            '<p>ver <a href="/pagina">aqui</a> y <a href="https://x.test" target="_blank" rel="noopener noreferrer">fuera</a></p>',
            "<ul><li><p>uno</p></li><li><p><strong>dos</strong> tres</p></li></ul>",
            "<ol><li><p>a</p></li></ol><p></p><p>fin</p>",
            "<p>linea<br>rota</p>",
            "<p>&lt;b&gt;literal&lt;/b&gt; &amp; fin</p>",
        ];
        for (const html of corpus) {
            expect(serializeDoc(parseRichHtml(html))).toBe(html);
        }
    });

    it("normaliza contenido Tiptap legado al subset (b/i→strong/em, li suelto, rel recalculado — D1/D5/D11)", () => {
        expect(serializeDoc(parseRichHtml("<p><b>x</b> <i>y</i></p>"))).toBe(
            "<p><strong>x</strong> <em>y</em></p>",
        );
        expect(serializeDoc(parseRichHtml("<ul><li>uno</li></ul>"))).toBe(
            "<ul><li><p>uno</p></li></ul>",
        );
        // D11: rel se recalcula (nofollow del default Tiptap v3 se descarta).
        expect(
            serializeDoc(
                parseRichHtml(
                    '<p><a href="/x" target="_blank" rel="noopener noreferrer nofollow">l</a></p>',
                ),
            ),
        ).toBe('<p><a href="/x" target="_blank" rel="noopener noreferrer">l</a></p>');
        // target que no es _blank se descarta y el rel no se emite.
        expect(serializeDoc(parseRichHtml('<p><a href="/x" target="_self">l</a></p>'))).toBe(
            '<p><a href="/x">l</a></p>',
        );
        // D2: formato fuera de contrato se desenvuelve a texto.
        expect(
            serializeDoc(parseRichHtml('<p><u>a</u><s>b</s><code>c</code><span style="color:red">d</span></p>')),
        ).toBe("<p>abcd</p>");
    });

    it("doc vacío ↔ cadena vacía (§1.2.1)", () => {
        expect(serializeDoc(parseRichHtml(""))).toBe("");
        expect(serializeDoc(parseRichHtml("<p></p>"))).toBe("");
        expect(docIsEmpty(parseRichHtml(""))).toBe(true);
    });
});

/* ------------------------------------------------------------------ */
/* Gate: pegado hostil                                                  */
/* ------------------------------------------------------------------ */

describe("inline-engine — pegado hostil", () => {
    function pasteInto(html: string): string {
        const doc = parseRichHtml("<p></p>");
        const sel: DocSelection = {
            anchor: { block: 0, item: null, offset: 0 },
            focus: { block: 0, item: null, offset: 0 },
        };
        return serializeDoc(pasteRich(doc, sel, { html }, sanitizeHTML).doc);
    }

    it("script con payload no aporta NI texto", () => {
        expect(pasteInto("<p>ok</p><script>document.location='https://evil.test'</script>")).toBe(
            "<p>ok</p>",
        );
    });

    it("style no cuela reglas ni texto", () => {
        expect(pasteInto("<style>p{background:url('https://evil.test')}</style><p>ok</p>")).toBe(
            "<p>ok</p>",
        );
    });

    it("on* y javascript: no sobreviven en ningún átomo", () => {
        const out = pasteInto(
            '<p onclick="x()">a<img src=x onerror=alert(1)><a href="/ok" onmouseover="y()">b</a></p>',
        );
        expect(out).toBe('<p>a<a href="/ok">b</a></p>');
    });

    it("iframe/object/embed desaparecen enteros", () => {
        expect(pasteInto('<iframe src="https://evil.test"></iframe><p>ok</p><object data="x"></object>')).toBe(
            "<p>ok</p>",
        );
    });

    it("el output de un pegado hostil sigue siendo punto fijo de sanitizeHTML", () => {
        const out = pasteInto('<div><h1 style="color:red">T</h1><p><b onclick="x()">n</b></p></div>');
        expect(out).toBe("<p>T</p><p><strong>n</strong></p>");
        expect(sanitizeHTML(out).replaceAll("<br />", "<br>")).toBe(out);
    });

    /**
     * El NOMBRE de un atributo del HTML pegado elegía la clave de `attrs` (remote property
     * injection). Con una allowlist —los tres atributos que el motor lee— el HTML solo aporta
     * VALORES, y el objeto sin prototipo hace que un nombre que nadie escribió no resuelva a nada.
     */
    it("el nombre de un atributo no elige la clave del objeto (allowlist + sin prototipo)", () => {
        const el = tokenizeHtml('<b onclick="x()" style="color:red" data-x="1" __proto__="p">t</b>')[0];
        if (el.kind !== "el") throw new Error("se esperaba un elemento");
        expect(Object.keys(el.attrs)).toEqual([]);
        expect(Object.getPrototypeOf(el.attrs)).toBeNull();

        // Un atributo que el HTML NUNCA escribió no puede resolver por el prototipo: con `{}`,
        // `attrs.constructor` devolvía Function y `attrs.toString` una función.
        const plain = tokenizeHtml("<span>t</span>")[0];
        if (plain.kind !== "el") throw new Error("se esperaba un elemento");
        for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
            expect((plain.attrs as Record<string, unknown>)[name], name).toBeUndefined();
        }

        // Ni el prototipo global queda tocado, ni se pierde lo que el motor SÍ lee.
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        const link = tokenizeHtml('<a href="/ok" target="_blank" rel="nofollow">t</a>')[0];
        if (link.kind !== "el") throw new Error("se esperaba un elemento");
        expect(link.attrs).toEqual({ href: "/ok", target: "_blank" });
        expect(pasteInto('<p><a href="/ok" target="_blank" __proto__="p">b</a></p>')).toBe(
            '<p><a href="/ok" target="_blank" rel="noopener noreferrer">b</a></p>',
        );
    });
});

/* ------------------------------------------------------------------ */
/* Gate: bookmark de caret (offsets estables tras cada op)              */
/* ------------------------------------------------------------------ */

describe("inline-engine — bookmark de caret en el modelo", () => {
    function assertValidSelection(doc: RichDoc, sel: DocSelection): void {
        for (const p of [sel.anchor, sel.focus]) {
            const para = getPara(doc, p);
            expect(para, `párrafo inexistente en ${JSON.stringify(p)}`).not.toBeNull();
            expect(p.offset).toBeGreaterThanOrEqual(0);
            expect(p.offset).toBeLessThanOrEqual(paraLength(para as NonNullable<typeof para>));
        }
    }

    it("toda op del fixture rich devuelve una selección válida dentro del doc resultante", () => {
        for (const c of fixture.cases) {
            if (c.schemaKind !== "rich") continue;
            const { doc, sel } = loadRichCase(c.initialHtml);
            const out = runRichOp(doc, sel, c.op);
            assertValidSelection(out.doc, out.selection);
        }
    });

    it("insertText deja el caret justo tras lo insertado", () => {
        const { doc, sel } = loadRichCase("<p>ho[[]]la</p>");
        const out = insertText(doc, sel, "XY");
        expect(isCollapsed(out.selection)).toBe(true);
        expect(out.selection.focus).toEqual({ block: 0, item: null, offset: 4 });
        // Y teclear en ese caret continúa donde tocaba.
        const out2 = insertText(out.doc, out.selection, "Z");
        expect(serializeDoc(out2.doc)).toBe("<p>hoXYZla</p>");
    });

    it("enter deja el caret al inicio del bloque nuevo", () => {
        const { doc, sel } = loadRichCase("<p>ho[[]]la</p>");
        const out = insertParagraphBreak(doc, sel);
        expect(out.selection.focus).toEqual({ block: 1, item: null, offset: 0 });
        const out2 = insertText(out.doc, out.selection, "X");
        expect(serializeDoc(out2.doc)).toBe("<p>ho</p><p>Xla</p>");
    });

    it("paste multibloque deja el caret al final de lo pegado", () => {
        const { doc, sel } = loadRichCase("<p>a[[]]b</p>");
        const out = pasteRich(doc, sel, { text: "uno\ndos" }, sanitizeHTML);
        expect(out.selection.focus).toEqual({ block: 1, item: null, offset: 3 });
        const out2 = insertText(out.doc, out.selection, "!");
        expect(serializeDoc(out2.doc)).toBe("<p>auno</p><p>dos!b</p>");
    });

    it("plainReplaceRange devuelve el caret tras el texto", () => {
        expect(plainReplaceRange("Titulo", 2, 4, "XX")).toEqual({ value: "TiXXlo", caret: 4 });
        expect(plainReplaceRange("Titulo", 6, 6, "!")).toEqual({ value: "Titulo!", caret: 7 });
    });
});

/* ------------------------------------------------------------------ */
/* Semántica auxiliar consumida por la superficie                       */
/* ------------------------------------------------------------------ */

describe("inline-engine — caretMarks y activeStates", () => {
    it("caretMarks: strong inclusive, enlace no inclusive (§8.6)", () => {
        const { doc, sel } = loadRichCase("<p><strong>hola</strong>[[]]</p>");
        expect(caretMarks(doc, sel.anchor).bold).toBe(true);
        const linkCase = loadRichCase('<p><a href="/x">liga</a>[[]]</p>');
        expect(caretMarks(linkCase.doc, linkCase.sel.anchor).link).toBeNull();
        const inside = loadRichCase('<p><a href="/x">li[[]]ga</a></p>');
        expect(caretMarks(inside.doc, inside.sel.anchor).link).toEqual({ href: "/x", newTab: false });
    });

    it("activeStates: activo = TODA la selección marcada (§2.2)", () => {
        const partial = loadRichCase("<p>[[ho<strong>la]]</strong></p>");
        expect(activeStates(partial.doc, partial.sel).bold).toBe(false);
        const full = loadRichCase("<p><strong>[[hola]]</strong></p>");
        expect(activeStates(full.doc, full.sel).bold).toBe(true);
        const list = loadRichCase("<ul><li><p>[[uno]]</p></li></ul>");
        const st = activeStates(list.doc, list.sel);
        expect(st.bulletList).toBe(true);
        expect(st.orderedList).toBe(false);
    });
});
