import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TableOfContentsBlock } from "../blocks";

/**
 * TableOfContents — built from `resolvedHeadings` (each { id, level, title }) that resolveDynamicBlocks
 * collected from the page's Heading blocks (only those with a real anchor). Pins: the anchor links are
 * server-rendered, filtered to the level range, unsafe fragment ids are dropped, and the empty case
 * renders nothing on the public page.
 */
const headings = [
    { id: "intro", level: "h2", title: "Introducción" },
    { id: "detalle", level: "h3", title: "Detalle" },
    { id: "muy-hondo", level: "h4", title: "Muy hondo" }, // out of H2–H3 range
    { id: "1-bad-id", level: "h2", title: "Ancla inválida" }, // fails the safe-fragment regex
];

describe("TableOfContentsBlock — SSR contract", () => {
    it("renders #anchor links for eligible headings, filtered to the level range", () => {
        const html = renderToStaticMarkup(<TableOfContentsBlock resolvedHeadings={headings} minLevel="H2" maxLevel="H3" scrollSpy={false} />);
        expect(html).toContain('href="#intro"');
        expect(html).toContain(">Introducción<");
        expect(html).toContain('href="#detalle"');
        // H4 is outside the range; the invalid id is dropped.
        expect(html).not.toContain("#muy-hondo");
        expect(html).not.toContain("#1-bad-id");
        expect(html).toContain("wjs-block-toc wp-block-toc");
    });

    it("ordered → <ol>; scroll-spy wraps in the island, off → bare nav", () => {
        expect(renderToStaticMarkup(<TableOfContentsBlock resolvedHeadings={headings} ordered scrollSpy={false} />)).toContain("<ol");
        expect(renderToStaticMarkup(<TableOfContentsBlock resolvedHeadings={headings} scrollSpy />)).toContain("wjs-toc-wrap");
        expect(renderToStaticMarkup(<TableOfContentsBlock resolvedHeadings={headings} scrollSpy={false} />)).not.toContain("wjs-toc-wrap");
    });

    it("renders nothing on public with no eligible headings, a notice while editing", () => {
        expect(renderToStaticMarkup(<TableOfContentsBlock resolvedHeadings={[]} scrollSpy={false} />)).toBe("");
        expect(renderToStaticMarkup(<TableOfContentsBlock resolvedHeadings={[]} isEditing />)).toContain("wjs-toc");
    });
});
