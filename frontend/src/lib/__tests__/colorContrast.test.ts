import { describe, expect, it } from "vitest";
import { contrastRatio, onColor, readableColor } from "../colorContrast";
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
        const fixed = { ...seeds, text: readableColor(seeds.text, seeds.bg) };
        expect(contrastPairs(fixed).every((p) => p.ratio >= p.min)).toBe(true);
        expect(onColor("#ffffff")).toBe("#111111");
    });
});
