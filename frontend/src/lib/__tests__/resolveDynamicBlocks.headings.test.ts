import { describe, it, expect, vi } from "vitest";

/**
 * ToC heading collection — the three rules the adversarial report demanded:
 *
 *  1. DEDUPE: duplicate elementIds keep the FIRST occurrence only. Duplicating a Heading block in the
 *     editor copies its elementId; two entries meant duplicate React keys, and TocScrollSpy's
 *     last-wins link map vs getElementById's first-wins target bound the active state to the WRONG
 *     ToC entry.
 *  2. PLAIN TEXT: HeadingBlock renders its title as sanitized HTML, but the ToC renders it
 *     React-escaped — a rich title ('Planes <em>Pro</em> &amp; Equipos') displayed its literal
 *     source in the index. The collector strips tags and decodes the basic entities.
 *  3. DRAWER EXCLUSION: a heading inside an OffCanvas slot renders inside a closed drawer — the
 *     browser cannot scroll to it, so its ToC link was permanently dead. OffCanvas interiors are
 *     skipped (only for headings — a NavMenu inside the drawer still resolves, tested below).
 *
 * Same stubbing pattern as resolveDynamicBlocks.megaMenu.test.ts.
 */

const getMenuByRef = vi.fn(async () => ({ items: [{ id: 1, title: "Home", url: "/", parent: 0, order: 0 }] }));

vi.mock("@/lib/server-api", () => ({
    getPosts: vi.fn(async () => []),
    getPostById: vi.fn(async () => null),
    getMenuByRef: (...args: unknown[]) => getMenuByRef(...(args as [])),
    getSettings: vi.fn(async () => ({})),
}));

import { resolveDynamicBlocks } from "@/lib/resolveDynamicBlocks";

type Node = { type: string; props: Record<string, unknown> };
const headingsOf = (out: unknown): Array<{ id: string; level: string; title: string }> => {
    const toc = (out as { content: Node[] }).content.find((n) => n.type === "TableOfContents")!;
    return toc.props.resolvedHeadings as Array<{ id: string; level: string; title: string }>;
};

describe("resolveDynamicBlocks — heading collection for TableOfContents", () => {
    it("dedupes duplicate elementIds: first occurrence wins, later duplicates are dropped", async () => {
        const out = await resolveDynamicBlocks({
            content: [
                { type: "TableOfContents", props: {} },
                { type: "Heading", props: { elementId: "intro", level: "h2", title: "Primera intro" } },
                { type: "Heading", props: { elementId: "detalles", level: "h2", title: "Detalles" } },
                // the editor's block duplication copies elementId — the copy must NOT produce a second entry
                { type: "Heading", props: { elementId: "intro", level: "h3", title: "Copia duplicada" } },
            ],
        });
        const headings = headingsOf(out);
        expect(headings.map((h) => h.id)).toEqual(["intro", "detalles"]);
        expect(headings[0].title).toBe("Primera intro");
        expect(headings[0].level).toBe("h2");
    });

    it("reduces a rich HTML title to the plain text the rendered heading displays", async () => {
        const out = await resolveDynamicBlocks({
            content: [
                { type: "TableOfContents", props: {} },
                { type: "Heading", props: { elementId: "planes", level: "h2", title: "Planes <em>Pro</em> &amp; Equipos" } },
                { type: "Heading", props: { elementId: "num", level: "h2", title: "A&#243;n &#x41; &nbsp;B" } },
            ],
        });
        const headings = headingsOf(out);
        expect(headings[0].title).toBe("Planes Pro & Equipos");
        // numeric (decimal + hex) entities and nbsp decode; whitespace collapses
        expect(headings[1].title).toBe("Aón A B");
    });

    it("skips headings inside an OffCanvas drawer (dead links) but keeps collecting everything else there", async () => {
        const out = await resolveDynamicBlocks({
            content: [
                { type: "TableOfContents", props: {} },
                {
                    type: "OffCanvas",
                    props: {
                        content: [
                            { type: "Heading", props: { elementId: "drawer-only", level: "h2", title: "Invisible" } },
                            // the drawer's typical content — its menu must STILL resolve
                            { type: "NavMenu", props: { source: "location", location: "header" } },
                            {
                                type: "Section",
                                props: { content: [{ type: "Heading", props: { elementId: "drawer-nested", level: "h2", title: "También" } }] },
                            },
                        ],
                    },
                },
                { type: "Heading", props: { elementId: "visible", level: "h2", title: "Visible" } },
            ],
        });
        const headings = headingsOf(out);
        expect(headings.map((h) => h.id)).toEqual(["visible"]);
        // heading exclusion must not disable the drawer's OTHER collectors
        expect(getMenuByRef).toHaveBeenCalledWith({ source: "location", location: "header" });
    });
});
