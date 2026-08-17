/* eslint-disable @next/next/no-html-link-for-pages -- the slot fixture stands in for arbitrary author
   blocks and asserts the plain <a> hrefs land in the SSR HTML; next/link is irrelevant to a
   renderToStaticMarkup node test. */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OffCanvasBlock } from "../blocks";

/**
 * OffCanvas — a trigger + slide-in drawer holding a SLOT of arbitrary blocks. The whole point is that
 * the panel AND its slotted children render on the SERVER (crawlable, in the SSR HTML) while only the
 * open/close toggle is a client island. What this pins: the trigger with its aria wiring, the panel
 * carrying the slotted links, the side/RTL classes, the bc() identity, and the empty-slot authoring
 * hint. Flipping aria-expanded on click is proven in the browser-verify step.
 *
 * `slot` is the render function BOTH surfaces hand over (editor DropZone / public wrapper div).
 */

const slotWith = (className?: string) => (
    <nav className={className} aria-label="Drawer nav">
        <a href="/">Home</a>
        <a href="/about">About</a>
    </nav>
);

describe("OffCanvasBlock — SSR shell carries the panel + slotted children", () => {
    it("emits the block identity via bc(): own class first, historical alias second", () => {
        const html = renderToStaticMarkup(<OffCanvasBlock slot={slotWith} />);
        expect(html).toContain("wjs-block-offcanvas wp-block-offcanvas");
    });

    it("renders the slotted children in the SSR HTML (crawlable, no-JS)", () => {
        const html = renderToStaticMarkup(<OffCanvasBlock slot={slotWith} />);
        expect(html).toContain('href="/"');
        expect(html).toContain("Home");
        expect(html).toContain('href="/about"');
        expect(html).toContain("About");
        // the slot wrapper carries the block content class
        expect(html).toContain("wjs-block-offcanvas__content wp-block-offcanvas__content");
    });

    it("reuses the header mobile panel + overlay hooks so themes style it", () => {
        const html = renderToStaticMarkup(<OffCanvasBlock slot={slotWith} />);
        expect(html).toContain("wjs-header-mobile-panel");
        expect(html).toContain("wjs-header-mobile-overlay");
        expect(html).toContain("wjs-offcanvas__panel");
    });
});

describe("OffCanvasBlock — trigger + aria wiring", () => {
    it("renders a trigger button that starts collapsed and controls the panel", () => {
        const html = renderToStaticMarkup(<OffCanvasBlock slot={slotWith} triggerLabel="Abrir" />);
        const trigger = html.match(/<button[^>]*wjs-offcanvas__trigger[^>]*>/)?.[0] ?? "";
        expect(trigger).toContain('aria-expanded="false"');
        expect(trigger).toContain('aria-haspopup="dialog"');
        expect(trigger).toContain("aria-controls=");
        expect(html).toContain("Abrir");
    });

    it("the panel is a dialog labelled by the trigger text", () => {
        const html = renderToStaticMarkup(<OffCanvasBlock slot={slotWith} triggerLabel="Abrir" />);
        const panel = html.match(/<div[^>]*wjs-offcanvas__panel[^>]*>/)?.[0] ?? "";
        expect(panel).toContain('role="dialog"');
        expect(panel).toContain('aria-modal="true"');
        expect(panel).toContain('aria-label="Abrir"');
    });

    it("a sanitized trigger icon is emitted, hostile values fall back", () => {
        expect(renderToStaticMarkup(<OffCanvasBlock slot={slotWith} triggerIcon="fa-list" />)).toContain("fa-solid fa-list");
        expect(renderToStaticMarkup(<OffCanvasBlock slot={slotWith} triggerIcon={'x" onload="1'} />)).toContain("fa-solid fa-bars");
    });
});

describe("OffCanvasBlock — side / RTL logical classes", () => {
    it("left (default) docks at the logical start and slides off to the start", () => {
        const html = renderToStaticMarkup(<OffCanvasBlock slot={slotWith} side="left" />);
        expect(html).toContain('data-side="left"');
        const panel = html.match(/<div[^>]*wjs-offcanvas__panel[^>]*>/)?.[0] ?? "";
        expect(panel).toContain("start-0");
        expect(panel).toMatch(/-translate-x-full/);
        expect(panel).toContain("rtl:translate-x-full");
    });

    it("right docks at the logical end and slides off to the end", () => {
        const html = renderToStaticMarkup(<OffCanvasBlock slot={slotWith} side="right" />);
        expect(html).toContain('data-side="right"');
        const panel = html.match(/<div[^>]*wjs-offcanvas__panel[^>]*>/)?.[0] ?? "";
        expect(panel).toContain("end-0");
        expect(panel).toContain("translate-x-full");
        expect(panel).toContain("rtl:-translate-x-full");
    });

    it("an invalid side coerces to left", () => {
        const html = renderToStaticMarkup(<OffCanvasBlock slot={slotWith} side="sideways" />);
        expect(html).toContain('data-side="left"');
    });
});

describe("OffCanvasBlock — breakpoint", () => {
    it("breakpoint md hides the trigger and inlines the panel from md up", () => {
        const html = renderToStaticMarkup(<OffCanvasBlock slot={slotWith} breakpoint="md" />);
        expect(html).toContain('data-breakpoint="md"');
        expect(html).toContain("md:hidden"); // trigger + overlay
        expect(html).toContain("md:static"); // panel inline at md+
    });

    it("an invalid breakpoint coerces to always (a drawer at every width)", () => {
        const html = renderToStaticMarkup(<OffCanvasBlock slot={slotWith} breakpoint="xxl" />);
        expect(html).toContain('data-breakpoint="always"');
    });
});

describe("OffCanvasBlock — empty slot", () => {
    it("shows an authoring hint while editing when nothing is dropped in", () => {
        const html = renderToStaticMarkup(<OffCanvasBlock slot={() => null} isEditing />);
        expect(html).toContain("wjs-block-offcanvas wp-block-offcanvas");
        expect(html).toContain("Arrastra bloques");
    });
});
