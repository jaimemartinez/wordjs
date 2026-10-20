import { describe, expect, it } from "vitest";
import { contrastRatio, onColor, readableColor, surfaceOf } from "../colorContrast";
import { contrastPairs } from "../../app/admin/themes/CreateThemeDialog";

describe("colorContrast (the theme generator's live WCAG check)", () => {
    it("matches the WCAG reference ratios", () => {
        expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
        expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
        expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
    });

    it("readableColor reaches AA and leaves a passing colour alone", () => {
        expect(readableColor("#111827", "#ffffff")).toBe("#111827");
        for (const [fg, bg] of [["#d1d5db", "#ffffff"], ["#334155", "#0f172a"], ["#ffcc00", "#ffffff"]]) {
            expect(contrastRatio(readableColor(fg, bg), bg)).toBeGreaterThanOrEqual(4.5);
        }
    });

    it("the generator flags an unreadable pair and its fix makes every pair pass", () => {
        const seeds = { primary: "#2563eb", secondary: "#9333ea", bg: "#ffffff", text: "#d1d5db" };
        expect(contrastPairs(seeds).find((p) => p.id === "text")!.ratio).toBeLessThan(4.5);
        const fixed = { ...seeds, text: readableColor(readableColor(seeds.text, seeds.bg), surfaceOf(seeds.bg)) };
        expect(contrastPairs(fixed).every((p) => p.ratio >= p.min)).toBe(true);
        expect(onColor("#ffffff")).toBe("#111111");
    });
});

describe("the surface a generated theme paints (core/theme-derive --wjs-bg-surface)", () => {
    it("matches the backend derivation, and a text that passes on the page can still fail on it", () => {
        expect(surfaceOf("#ffffff")).toBe("#f7f7f7");
        expect(surfaceOf("#0b1020")).toBe("#1a1e2d");
        // 4.74:1 on white is 4.43:1 on its surface: the pair the theme doctor refused in the browser check.
        expect(contrastRatio("#737373", "#ffffff")).toBeGreaterThanOrEqual(4.5);
        expect(contrastPairs({ primary: "#2563eb", secondary: "#9333ea", bg: "#ffffff", text: "#737373" }).find((p) => p.id === "text")!.ratio).toBeLessThan(4.5);
    });
});
