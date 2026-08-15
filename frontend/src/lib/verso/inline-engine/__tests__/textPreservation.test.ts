/**
 * Motor de texto inline (F3.5) — PROPIEDAD anti-pérdida corpus-driven + guard.
 *
 * Origen: bug real cazado en navegador (bloque Text-m2, página 172): el commit
 * de la sesión inline truncó un párrafo entero a `<p>X</p>`. La causa raíz fue
 * la capa DOM (instanceof cross-realm en VersoTextSurface), pero el contrato
 * que estas propiedades clavan es del MOTOR PURO y de la política del
 * programa: lo que no se entiende se preserva, NUNCA se destruye.
 *
 * Propiedades, para CADA valor rich real (props.content de bloques Text del
 * corpus documentation/verso/corpus/corpus.json — skipIf sin corpus — y todos
 * los initialHtml rich del fixture):
 *   (a) parse→serialize es punto fijo canónico (idempotente).
 *   (b) parse→insertText(inicio, medio y fin)→serialize conserva TODO el
 *       texto original: quitar el carácter insertado devuelve EXACTAMENTE el
 *       texto de partida (más fuerte que la contención, que un insert en medio
 *       de una palabra rompería por partir el substring).
 *
 * Además: tests node de la función de decisión PURA del guard fail-closed de
 * VersoTextSurface (inlineGuardLosesText / normalizeGuardText / docGuardText).
 *
 * Todo corre en node — el motor es puro, sin DOM.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    type DocPoint,
    type RichDoc,
    collapsedAt,
    docGuardText,
    inlineGuardLosesText,
    insertText,
    listParas,
    normalizeGuardText,
    paraLength,
    parseRichHtml,
    serializeDoc,
} from "@/lib/verso/inline-engine";

/* ------------------------------------------------------------------ */
/* Fuentes: corpus real + fixture                                       */
/* ------------------------------------------------------------------ */

const CORPUS_URL = new URL(
    "../../../../../../documentation/verso/corpus/corpus.json",
    import.meta.url,
);
const corpusPath = fileURLToPath(CORPUS_URL);
const hasCorpus = existsSync(corpusPath);

/** Recolecta recursivamente los props.content (string) de bloques type "Text". */
function collectTextContents(value: unknown, out: string[]): void {
    if (Array.isArray(value)) {
        for (const v of value) collectTextContents(v, out);
        return;
    }
    if (value !== null && typeof value === "object") {
        const rec = value as Record<string, unknown>;
        const props = rec.props as Record<string, unknown> | undefined;
        if (
            rec.type === "Text" &&
            props &&
            typeof props.content === "string" &&
            props.content.length > 0
        ) {
            out.push(props.content);
        }
        for (const v of Object.values(rec)) collectTextContents(v, out);
    }
}

const corpusValues: string[] = [];
if (hasCorpus) {
    collectTextContents(JSON.parse(readFileSync(corpusPath, "utf8")), corpusValues);
}
const uniqueCorpusValues = [...new Set(corpusValues)];

const fixture = JSON.parse(
    readFileSync(new URL("../__fixtures__/text-cases.json", import.meta.url), "utf8"),
) as { cases: Array<{ name: string; schemaKind: string; initialHtml: string }> };

const fixtureValues = fixture.cases
    .filter((c) => c.schemaKind === "rich")
    .map((c) => ({
        name: c.name,
        html: c.initialHtml.replace("[[", "").replace("]]", ""),
    }));

/* ------------------------------------------------------------------ */
/* La propiedad                                                          */
/* ------------------------------------------------------------------ */

/** Carácter marcador ausente del corpus (se asserta) para poder restarlo. */
const PROBE = "Ξ";

/** Puntos de inserción: inicio del primer párrafo, medio del más largo, fin del último. */
function insertionPoints(doc: RichDoc): DocPoint[] {
    const paras = listParas(doc);
    const first = paras[0];
    const last = paras[paras.length - 1];
    let longest = paras[0];
    for (const p of paras) {
        if (paraLength(p.para) > paraLength(longest.para)) longest = p;
    }
    return [
        { block: first.addr.block, item: first.addr.item, offset: 0 },
        {
            block: longest.addr.block,
            item: longest.addr.item,
            offset: Math.floor(paraLength(longest.para) / 2),
        },
        { block: last.addr.block, item: last.addr.item, offset: paraLength(last.para) },
    ];
}

function assertPreservation(html: string, label: string): void {
    // (a) punto fijo canónico del parse→serialize.
    const once = serializeDoc(parseRichHtml(html));
    const twice = serializeDoc(parseRichHtml(once));
    expect(twice, `parse→serialize no es punto fijo en ${label}`).toBe(once);

    // (b) insertText en inicio/medio/fin conserva TODO el texto original.
    const doc = parseRichHtml(html);
    const before = docGuardText(doc);
    expect(before.includes(PROBE), `el valor ${label} ya contiene el marcador`).toBe(false);
    for (const point of insertionPoints(doc)) {
        const out = insertText(doc, collapsedAt(point), PROBE);
        // Round-trip completo: lo que el commit emitiría, re-parseado.
        const emitted = serializeDoc(out.doc);
        const after = docGuardText(parseRichHtml(emitted));
        const restored = after.replace(PROBE, "");
        expect(
            restored,
            `insertText en ${JSON.stringify(point)} pierde texto en ${label}`,
        ).toBe(before);
        // Y la relación del guard: el resultado jamás "pierde" el original
        // según la decisión fail-closed (con el probe quitado).
        expect(inlineGuardLosesText(before, restored)).toBe(false);
    }
}

describe("inline-engine — propiedad anti-pérdida sobre los initialHtml del fixture", () => {
    for (const { name, html } of fixtureValues) {
        it(`conserva todo el texto de ${name}`, () => {
            assertPreservation(html, name);
        });
    }
});

describe.skipIf(!hasCorpus)(
    "inline-engine — propiedad anti-pérdida sobre el corpus real (props.content de Text)",
    () => {
        it("el corpus aporta valores de Text", () => {
            expect(uniqueCorpusValues.length).toBeGreaterThan(0);
        });

        for (let i = 0; i < uniqueCorpusValues.length; i++) {
            const value = uniqueCorpusValues[i];
            it(`corpus Text #${i} (${value.slice(0, 40).replace(/\s+/g, " ")}…)`, () => {
                assertPreservation(value, `corpus#${i}`);
            });
        }
    },
);

/* ------------------------------------------------------------------ */
/* Guard fail-closed: la decisión pura                                   */
/* ------------------------------------------------------------------ */

describe("inline-engine — decisión pura del guard anti-pérdida", () => {
    const LONG =
        "Explore the core atomic components of WordJS. Every block is engineered for " +
        "precision, high-focus creativity, and extreme adaptability across dark-first " +
        "digital experiences.";

    it("dispara ante la truncación del repro (párrafo entero → 'X')", () => {
        expect(inlineGuardLosesText(LONG, "X")).toBe(true);
        expect(inlineGuardLosesText(LONG, "XExplore the core")).toBe(true);
    });

    it("no dispara cuando el texto se conserva (idéntico o superset)", () => {
        expect(inlineGuardLosesText(LONG, LONG)).toBe(false);
        expect(inlineGuardLosesText(LONG, `prefijo ${LONG} sufijo`)).toBe(false);
    });

    it("es insensible a whitespace y a los joins entre bloques", () => {
        // textContent del DOM une <li> sin separador; el modelo con espacio.
        expect(inlineGuardLosesText("unodos", "uno dos")).toBe(false);
        expect(inlineGuardLosesText("uno dos", "unodos")).toBe(false);
        expect(inlineGuardLosesText("a\n\tb", " a b ")).toBe(false);
    });

    it("con 'before' vacío nunca hay pérdida (doc vacío legítimo)", () => {
        expect(inlineGuardLosesText("", "")).toBe(false);
        expect(inlineGuardLosesText("   ", "cualquier cosa")).toBe(false);
    });

    it("un solo carácter caído en medio dispara (contención estricta)", () => {
        expect(inlineGuardLosesText("abcdef", "abcef")).toBe(true);
    });

    it("normalizeGuardText quita whitespace, NBSP y los invisibles del centinela", () => {
        expect(normalizeGuardText("a\u2060b\u200bc d e\n")).toBe("abcde");
    });

    it("docGuardText da el texto plano del modelo (todos los párrafos)", () => {
        const doc = parseRichHtml("<p>uno</p><ul><li><p>dos</p></li></ul>");
        expect(normalizeGuardText(docGuardText(doc))).toBe("unodos");
    });
});
