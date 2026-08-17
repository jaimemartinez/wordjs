import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ParticleFieldBlock, HeadingBlock } from "../blocks";
import { prefersReducedMotion } from "../ParticleField";

/**
 * ParticleField — the SSR contract of the animated-background block.
 *
 * The whole point of shipping this as a BLOCK (client island) rather than an interaction preset or a
 * theme is that the effect needs a <canvas> and JS, which neither of those layers can provide. What
 * this test pins is the flip side of that: the SERVER output must be an inert, out-of-flow mount
 * point — zero pixels, zero layout, zero CLS — so nothing is seen or shifts until the island hydrates.
 */

const DEFAULTS = {
    count: 70,
    color: "",
    speed: "medium",
    linkLines: "true",
    linkDistance: 130,
    pointer: "false",
    css: {},
};

describe("ParticleFieldBlock — SSR is only the mount point (zero CLS)", () => {
    const html = renderToStaticMarkup(<ParticleFieldBlock {...DEFAULTS} />);

    it("emits the block identity via bc(): own class first, historical alias second", () => {
        expect(html).toContain("wjs-block-particle-field wp-block-particle-field");
    });

    it("ships an EMPTY <canvas> and nothing else drawable — no particles, no script", () => {
        const canvases = [...html.matchAll(/<canvas\b/g)];
        expect(canvases).toHaveLength(1);
        // The canvas is a bare, childless element: a particle is a pixel drawn by the client rAF, so
        // the server can carry none. Prove there is no drawn content and no inline script.
        expect(html).toMatch(/<canvas\b[^>]*><\/canvas>/);
        expect(html).not.toContain("<script");
        expect(html).not.toContain("rgba(");
    });

    it("the layer is OUT OF FLOW and BEHIND the content (position/z-index/pointer-events)", () => {
        expect(html).toContain("position:absolute");
        expect(html).toContain("inset:0");
        expect(html).toContain("z-index:0");
        expect(html).toContain("pointer-events:none");
    });

    it("is decorative: aria-hidden on both the layer and the canvas", () => {
        // Two aria-hidden="true" — the wrapper and the canvas.
        expect([...html.matchAll(/aria-hidden="true"/g)]).toHaveLength(2);
    });

    it("omits --wjs-particle-color when the author leaves colour empty (theme token wins)", () => {
        expect(html).not.toContain("--wjs-particle-color:");
    });

    it("emits --wjs-particle-color only when the author sets a colour (validated CSS value)", () => {
        const withColor = renderToStaticMarkup(
            <ParticleFieldBlock {...DEFAULTS} color="#22d3ee" />,
        );
        expect(withColor).toContain("--wjs-particle-color:#22d3ee");
    });
});

describe("ParticleField — prefers-reduced-motion gate (drives whether the island animates)", () => {
    const mm = (reduce: boolean) =>
        ((q: string) => ({ matches: /prefers-reduced-motion/.test(q) ? reduce : false })) as Window["matchMedia"];

    it("reports reduced motion when the OS asks for it → the field will not animate", () => {
        expect(prefersReducedMotion({ matchMedia: mm(true) })).toBe(true);
    });

    it("reports motion allowed by default → the field animates", () => {
        expect(prefersReducedMotion({ matchMedia: mm(false) })).toBe(false);
    });

    it("treats a window without matchMedia as motion-allowed (never throws)", () => {
        expect(prefersReducedMotion({} as Pick<Window, "matchMedia">)).toBe(false);
    });
});

describe("ParticleField does not perturb other blocks", () => {
    it("a block without a particle field carries none of its markup", () => {
        const heading = renderToStaticMarkup(<HeadingBlock title="Hello" level="h2" />);
        expect(heading).toContain("wjs-block-heading wp-block-heading");
        expect(heading).not.toContain("particle-field");
        expect(heading).not.toContain("<canvas");
    });
});
