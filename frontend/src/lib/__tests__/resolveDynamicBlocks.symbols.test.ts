import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Symbol interiors — the resolver's SECOND collection pass.
 *
 * decorate() recurses into a wjs_symbol's fetched content, so the collection pass must too: before
 * this fix, scan() ran only over the page tree, so a NavMenu/SiteLogo/PostsGrid/anchored-Heading
 * living ONLY inside a symbol decorated against empty maps — a reusable header Symbol published an
 * empty <nav> and a blank brand on every page that used it (it "worked" only when a page-level block
 * with the same ref coincidentally scheduled the fetch). These tests pin the failure scenarios from
 * the adversarial report: symbol-nested NavMenu gets resolvedMenu, symbol-nested PostsGrid schedules
 * the posts fetch, and a symbol's anchored heading reaches a page-level ToC at the symbol's position.
 *
 * Same stubbing pattern as resolveDynamicBlocks.megaMenu.test.ts (the resolver imports server-api at
 * import time).
 */

const MENU_ITEMS = [
    { id: 1, title: "Home", url: "/", target: "_self", parent: 0, order: 0 },
    { id: 2, title: "Products", url: "/products", target: "_self", parent: 0, order: 1 },
];

const SYMBOL_CONTENT = [
    { type: "Heading", props: { elementId: "sym-anchor", level: "h2", title: "Desde el símbolo" } },
    { type: "NavMenu", props: { source: "location", location: "header" } },
    { type: "PostsGrid", props: { count: 3 } },
    // depth cap 1: a Symbol nested INSIDE a symbol never renders — it must not schedule a fetch.
    { type: "Symbol", props: { symbolId: 99 } },
];

const getMenuByRef = vi.fn(async () => ({ items: MENU_ITEMS }));
const getPostPool = vi.fn(async () => [
    { id: 41, title: "Real post", slug: "real-post", excerpt: "…", status: "publish", date: "2026-08-17" },
]);
const getPostById = vi.fn(async (id: number) =>
    id === 7
        ? { id: 7, type: "wjs_symbol", meta: { _puck_data: { content: SYMBOL_CONTENT } } }
        : null
);

vi.mock("@/lib/server-api", () => ({
    getPostPool: (...args: unknown[]) => getPostPool(...(args as [])),
    getPostById: (...args: unknown[]) => getPostById(...(args as [number])),
    getMenuByRef: (...args: unknown[]) => getMenuByRef(...(args as [])),
    getSettings: vi.fn(async () => ({})),
}));

import { resolveDynamicBlocks } from "@/lib/resolveDynamicBlocks";

// The page's ONLY dynamic content lives inside the symbol; the page itself carries just the Symbol,
// a ToC, and its own anchored heading AFTER the symbol (to pin document order).
const tree = () => ({
    content: [
        { type: "TableOfContents", props: {} },
        { type: "Symbol", props: { symbolId: 7 } },
        { type: "Heading", props: { elementId: "page-anchor", level: "h2", title: "De la página" } },
    ],
});

type Node = { type: string; props: Record<string, unknown> };

beforeEach(() => {
    getMenuByRef.mockClear();
    getPostPool.mockClear();
    getPostById.mockClear();
});

describe("resolveDynamicBlocks — symbol interiors are collected before the data fetches", () => {
    it("a NavMenu that exists ONLY inside a symbol gets its real resolvedMenu", async () => {
        const out = (await resolveDynamicBlocks(tree())) as { content: Node[] };
        const symbol = out.content.find((n) => n.type === "Symbol")!;
        const injected = symbol.props.resolvedSymbolItems as Node[];
        const nested = injected.find((n) => n.type === "NavMenu")!;
        expect(Array.isArray(nested.props.resolvedMenu)).toBe(true);
        expect((nested.props.resolvedMenu as unknown[]).length).toBe(2);
        expect(getMenuByRef).toHaveBeenCalledTimes(1);
        expect(getMenuByRef).toHaveBeenCalledWith({ source: "location", location: "header" });
    });

    it("a PostsGrid that exists ONLY inside a symbol schedules the posts fetch and gets real posts", async () => {
        const out = (await resolveDynamicBlocks(tree())) as { content: Node[] };
        expect(getPostPool).toHaveBeenCalledTimes(1);
        const symbol = out.content.find((n) => n.type === "Symbol")!;
        const injected = symbol.props.resolvedSymbolItems as Node[];
        const grid = injected.find((n) => n.type === "PostsGrid")!;
        const posts = grid.props.resolvedPosts as Array<{ id: number; title: string }>;
        expect(posts).toHaveLength(1);
        expect(posts[0].id).toBe(41);
        expect(posts[0].title).toBe("Real post");
    });

    it("a symbol's anchored heading reaches the page-level ToC, at the SYMBOL'S position", async () => {
        const out = (await resolveDynamicBlocks(tree())) as { content: Node[] };
        const toc = out.content.find((n) => n.type === "TableOfContents")!;
        const headings = toc.props.resolvedHeadings as Array<{ id: string; title: string }>;
        // Document order: the symbol sits BEFORE the page's own heading.
        expect(headings.map((h) => h.id)).toEqual(["sym-anchor", "page-anchor"]);
        expect(headings[0].title).toBe("Desde el símbolo");
    });

    it("depth cap 1: a Symbol nested inside a symbol schedules NO fetch (it never renders)", async () => {
        await resolveDynamicBlocks(tree());
        // One getPostById call — for symbol 7. The nested symbolId 99 must never be fetched.
        expect(getPostById).toHaveBeenCalledTimes(1);
        expect(getPostById).toHaveBeenCalledWith(7);
    });

    it("the input tree (shared cached API response) is never mutated", async () => {
        const input = tree();
        await resolveDynamicBlocks(input);
        expect(input.content[1].props).not.toHaveProperty("resolvedSymbolItems");
        expect(SYMBOL_CONTENT[1].props).not.toHaveProperty("resolvedMenu");
    });
});
