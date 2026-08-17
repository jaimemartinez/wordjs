import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BackToTopBlock from "../BackToTop";

/**
 * BackToTop — a floating scroll-to-top control. The WHOLE block is a client island (no SSR content is
 * required for a control that is only useful after scrolling), but it is still emitted in the initial
 * HTML — hidden and non-interactive — so this pins what renders server-side: the accessible button,
 * its identity class, the sanitized icon token and the corner class. The scroll/reduced-motion
 * behaviour is exercised in the browser-verify step.
 */

describe("BackToTopBlock — server-rendered control", () => {
    it("emits the block identity via bc(): own class first, historical alias second", () => {
        const html = renderToStaticMarkup(<BackToTopBlock />);
        expect(html).toContain("wjs-block-back-to-top wp-block-back-to-top");
    });

    it("renders a real <button> with an accessible name (default label)", () => {
        const html = renderToStaticMarkup(<BackToTopBlock />);
        expect(html).toMatch(/<button[^>]*aria-label="Arriba"/);
        expect(html).toContain('type="button"');
    });

    it("a custom label becomes the aria-label", () => {
        const html = renderToStaticMarkup(<BackToTopBlock label="Volver arriba" />);
        expect(html).toContain('aria-label="Volver arriba"');
    });

    it("renders the Font Awesome icon token as an aria-hidden <i>", () => {
        const html = renderToStaticMarkup(<BackToTopBlock icon="fa-chevron-up" />);
        expect(html).toContain("fa-solid fa-chevron-up");
        expect(html).toMatch(/<i[^>]*aria-hidden="true"/);
    });

    it("a hostile icon value falls back to the default token (no class injection)", () => {
        const html = renderToStaticMarkup(<BackToTopBlock icon={'x" onload="alert(1)'} />);
        expect(html).not.toContain("onload");
        expect(html).toContain("fa-solid fa-arrow-up");
    });

    it("position selects the corner (logical start/end for RTL)", () => {
        expect(renderToStaticMarkup(<BackToTopBlock position="br" />)).toContain("end-6");
        expect(renderToStaticMarkup(<BackToTopBlock position="bl" />)).toContain("start-6");
    });

    it("starts hidden and non-interactive (revealed on scroll by the island)", () => {
        const html = renderToStaticMarkup(<BackToTopBlock />);
        expect(html).toContain("opacity-0");
        expect(html).toContain("pointer-events-none");
    });
});
