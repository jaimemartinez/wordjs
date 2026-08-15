/**
 * F3 — matriz completa de resolveEditorEngine (flag de motor del editor).
 * Contrato: query > localStorage > env > legacy; un valor inválido en un nivel
 * se trata como AUSENTE (cae al siguiente), jamás se coerciona.
 */
import { describe, expect, it } from "vitest";
import {
    EDITOR_ENGINE_QUERY_PARAM,
    EDITOR_ENGINE_STORAGE_KEY,
    resolveEditorEngine,
} from "../editorEngine";

describe("resolveEditorEngine", () => {
    it("default absoluto: sin ninguna fuente → legacy", () => {
        expect(resolveEditorEngine()).toBe("legacy");
        expect(resolveEditorEngine({})).toBe("legacy");
        expect(resolveEditorEngine({ query: null, stored: null, env: null })).toBe("legacy");
    });

    it("query gana a todo", () => {
        expect(resolveEditorEngine({ query: "verso", stored: "legacy", env: "legacy" })).toBe("verso");
        expect(resolveEditorEngine({ query: "legacy", stored: "verso", env: "verso" })).toBe("legacy");
    });

    it("localStorage gana a env", () => {
        expect(resolveEditorEngine({ stored: "verso", env: "legacy" })).toBe("verso");
        expect(resolveEditorEngine({ stored: "legacy", env: "verso" })).toBe("legacy");
    });

    it("env aplica cuando query/stored están ausentes", () => {
        expect(resolveEditorEngine({ env: "verso" })).toBe("verso");
        expect(resolveEditorEngine({ env: "legacy" })).toBe("legacy");
    });

    it("valores inválidos caen al siguiente nivel (nunca coercionan)", () => {
        expect(resolveEditorEngine({ query: "Verso" })).toBe("legacy"); // case-sensitive
        expect(resolveEditorEngine({ query: "puck", stored: "verso" })).toBe("verso");
        expect(resolveEditorEngine({ query: "", stored: "", env: "verso" })).toBe("verso");
        expect(resolveEditorEngine({ query: "1", stored: "true", env: "yes" })).toBe("legacy");
        expect(resolveEditorEngine({ query: undefined, stored: "verso " })).toBe("legacy"); // sin trim: exacto o nada
    });

    it("matriz exhaustiva de precedencia (3 niveles × {verso, legacy, inválido, ausente})", () => {
        const levels = ["verso", "legacy", "bogus", null] as const;
        const expected = (q: string | null, s: string | null, e: string | null): string => {
            for (const v of [q, s, e]) {
                if (v === "verso" || v === "legacy") return v;
            }
            return "legacy";
        };
        for (const q of levels) {
            for (const s of levels) {
                for (const e of levels) {
                    expect(resolveEditorEngine({ query: q, stored: s, env: e })).toBe(expected(q, s, e));
                }
            }
        }
    });

    it("las constantes del contrato no derivan", () => {
        expect(EDITOR_ENGINE_STORAGE_KEY).toBe("wjs_editor_engine");
        expect(EDITOR_ENGINE_QUERY_PARAM).toBe("engine");
    });
});
