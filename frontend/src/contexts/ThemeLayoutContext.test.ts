import { describe, expect, it } from "vitest";
import { createActiveThemeState, resolveActiveThemeState } from "./ThemeLayoutContext";

describe("active theme snapshots", () => {
    it("resolves slug and layout from the same active theme", () => {
        const apexLayout = { componentRecipes: { version: 1 }, marker: "apex" };
        const state = resolveActiveThemeState([
            { slug: "default", active: false, layout: { marker: "default" } },
            { slug: "apex-enterprise", active: true, layout: apexLayout },
        ]);

        expect(state).toEqual({ slug: "apex-enterprise", layout: apexLayout, mods: null });
        expect(state?.layout).toBe(apexLayout);
    });

    it("clears the previous recipes when the active theme has no layout", () => {
        expect(resolveActiveThemeState([
            { slug: "atelier-noir", active: true, layout: null },
        ])).toEqual({ slug: "atelier-noir", layout: {}, mods: null });
    });

    it("falls back to the default theme as one complete snapshot", () => {
        expect(resolveActiveThemeState([
            { slug: "other", active: false, layout: { marker: "other" } },
            { slug: "default", active: false, layout: { marker: "default" } },
        ])).toEqual({ slug: "default", layout: { marker: "default" }, mods: null });
    });

    it("normalizes malformed SSR values without mixing in stale layout", () => {
        expect(createActiveThemeState(null, ["invalid"])).toEqual({
            slug: "default",
            layout: {},
            mods: null,
        });
    });

    it("keeps customizer mods in the same snapshot as slug and layout", () => {
        const layout = { marker: "artisan" };
        const mods = { "--wjs-color-primary": "#b45309" };

        expect(resolveActiveThemeState([
            { slug: "botanica-organics", active: false, layout: { marker: "old" }, mods: { "--wjs-color-primary": "#166534" } },
            { slug: "artisan-craft", active: true, layout, mods },
        ])).toEqual({ slug: "artisan-craft", layout, mods });
    });
});
