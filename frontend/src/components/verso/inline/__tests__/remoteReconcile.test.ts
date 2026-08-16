/**
 * Reconciliación del caret cuando el texto cambia por debajo (F8.4).
 *
 * Converger no basta: si al fusionar la edición ajena el caret salta al principio, no se puede
 * escribir a la vez aunque el documento sea perfecto. Esto fija dónde tiene que quedarse.
 */

import { describe, expect, it } from "vitest";
import { parseRichHtml, type RichDoc } from "@/lib/verso/inline-engine";
import {
    commonPrefix,
    commonSuffix,
    flatText,
    mapOffset,
    offsetToPoint,
    pointToOffset,
    reconcileSelection,
} from "../remoteReconcile";

const doc = (html: string): RichDoc => parseRichHtml(html);

describe("prefijo y sufijo comunes", () => {
    it("cuentan lo que hay que contar", () => {
        expect(commonPrefix("hola", "holanda")).toBe(4);
        expect(commonSuffix("hola", "ohola", 0)).toBe(4);
    });
    it("el sufijo no se solapa con el prefijo ya contado", () => {
        // "aa" → "aaa": el prefijo se come 2; el sufijo no puede volver a contarlos.
        expect(commonSuffix("aa", "aaa", commonPrefix("aa", "aaa"))).toBe(0);
    });
});

describe("mapOffset", () => {
    it("texto idéntico: el caret no se mueve", () => {
        expect(mapOffset("uno", "uno", 2)).toBe(2);
    });
    it("te escriben DELANTE: tu caret se desplaza contigo", () => {
        expect(mapOffset("uno", "XXuno", 3)).toBe(5);
    });
    it("te escriben DETRÁS: tu caret no se entera", () => {
        expect(mapOffset("uno", "unoXX", 1)).toBe(1);
    });
    it("borran delante: el caret retrocede lo justo", () => {
        expect(mapOffset("XXuno", "uno", 5)).toBe(3);
    });
    it("te reescriben JUSTO donde estabas: se queda dentro, no salta al final", () => {
        const out = mapOffset("abcdef", "aZf", 3);
        expect(out).toBeGreaterThanOrEqual(1);
        expect(out).toBeLessThanOrEqual(2);
    });
    it("nunca se sale del texto nuevo", () => {
        expect(mapOffset("abcdef", "", 4)).toBe(0);
        expect(mapOffset("", "abc", 0)).toBe(0);
        expect(mapOffset("abc", "abc", 99)).toBe(3);
        expect(mapOffset("abc", "abc", -5)).toBe(0);
    });
});

describe("offsets planos ↔ puntos del documento", () => {
    it("ida y vuelta en un párrafo simple", () => {
        const d = doc("<p>hola</p>");
        expect(flatText(d)).toBe("hola");
        expect(pointToOffset(d, offsetToPoint(d, 3))).toBe(3);
    });
    it("la frontera entre párrafos ocupa una posición", () => {
        const d = doc("<p>ab</p><p>cd</p>");
        expect(flatText(d)).toBe("ab\ncd");
        expect(pointToOffset(d, { block: 1, item: null, offset: 1 })).toBe(4);
        expect(offsetToPoint(d, 4)).toEqual({ block: 1, item: null, offset: 1 });
    });
    it("un offset fuera de rango se clampa a un punto VÁLIDO", () => {
        const d = doc("<p>ab</p>");
        expect(offsetToPoint(d, 99)).toEqual({ block: 0, item: null, offset: 2 });
        expect(offsetToPoint(d, -3)).toEqual({ block: 0, item: null, offset: 0 });
    });
    it("un documento vacío no rompe la conversión", () => {
        expect(offsetToPoint({ blocks: [] }, 5)).toEqual({ block: 0, item: null, offset: 0 });
    });
});

describe("reconcileSelection", () => {
    it("el caret sobrevive a que te escriban por delante", () => {
        const viejo = doc("<p>uno</p>");
        const nuevo = doc("<p>Buno</p>");
        const sel = reconcileSelection(viejo, nuevo, {
            anchor: { block: 0, item: null, offset: 3 },
            focus: { block: 0, item: null, offset: 3 },
        });
        expect(sel).toEqual({
            anchor: { block: 0, item: null, offset: 4 },
            focus: { block: 0, item: null, offset: 4 },
        });
    });

    it("una selección de rango se traslada entera", () => {
        const viejo = doc("<p>abcdef</p>");
        const nuevo = doc("<p>XXabcdef</p>");
        const sel = reconcileSelection(viejo, nuevo, {
            anchor: { block: 0, item: null, offset: 2 },
            focus: { block: 0, item: null, offset: 5 },
        });
        expect(sel?.anchor.offset).toBe(4);
        expect(sel?.focus.offset).toBe(7);
    });

    it("sin selección previa no se inventa ninguna", () => {
        expect(reconcileSelection(doc("<p>a</p>"), doc("<p>b</p>"), null)).toBeNull();
    });

    it("el punto devuelto SIEMPRE existe en el documento nuevo", () => {
        const viejo = doc("<p>uno</p><p>dos</p>");
        const nuevo = doc("<p>x</p>");
        const sel = reconcileSelection(viejo, nuevo, {
            anchor: { block: 1, item: null, offset: 3 },
            focus: { block: 1, item: null, offset: 3 },
        });
        expect(sel?.anchor.block).toBe(0);
        expect(sel?.anchor.offset).toBeLessThanOrEqual(1);
    });
});
