/**
 * Every UI string lives three times (es/en/pt). A key added to one language and forgotten in the
 * others does not fail typing, does not fail a build and does not throw at runtime — `t()` just
 * falls back, so the page renders in a different language than the one the user picked, and only a
 * speaker of that language would ever notice.
 *
 * This pins the three catalogues to the same key set. It has no opinion on the translations
 * themselves; it only asserts none is missing.
 */
import { describe, it, expect } from "vitest";
import { translations, type Language } from "../i18n";

const LANGS = Object.keys(translations) as Language[];
const REFERENCE: Language = "es";

describe("i18n catalogues", () => {
    it("ships the same keys in every language", () => {
        const reference = Object.keys(translations[REFERENCE]).sort();
        expect(reference.length).toBeGreaterThan(0);

        for (const lang of LANGS) {
            if (lang === REFERENCE) continue;
            const keys = new Set(Object.keys(translations[lang]));
            const missing = reference.filter((k) => !keys.has(k));
            const extra = [...keys].filter((k) => !reference.includes(k));
            expect(missing, `"${lang}" is missing ${missing.length} key(s) present in "${REFERENCE}": ${missing.slice(0, 10).join(", ")}`).toEqual([]);
            expect(extra, `"${lang}" has ${extra.length} key(s) "${REFERENCE}" does not: ${extra.slice(0, 10).join(", ")}`).toEqual([]);
        }
    });

    it("has no empty translations", () => {
        for (const lang of LANGS) {
            const blank = Object.entries(translations[lang]).filter(([, v]) => typeof v !== "string" || v.trim() === "").map(([k]) => k);
            expect(blank, `"${lang}" has blank values: ${blank.slice(0, 10).join(", ")}`).toEqual([]);
        }
    });
});
