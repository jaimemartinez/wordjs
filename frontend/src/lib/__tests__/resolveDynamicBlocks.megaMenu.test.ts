import { describe, it, expect, vi } from "vitest";

// Same stubbing pattern as resolveDynamicBlocks.postContext.test.ts: the resolver imports the
// server-api module at import time. Here getMenuByRef IS exercised — it returns the canonical
// nav_menu items for whatever ref the resolver collected.
const getMenuByRef = vi.fn(async () => ({
    items: [
        { id: 1, title: "Home", url: "/", target: "_self", parent: 0, order: 0 },
        { id: 2, title: "Products", url: "/products", target: "_self", parent: 0, order: 1 },
    ],
}));

vi.mock("@/lib/server-api", () => ({
    getPosts: vi.fn(async () => []),
    getPostById: vi.fn(async () => null),
    getMenuByRef: (...args: unknown[]) => getMenuByRef(...(args as [])),
    getSettings: vi.fn(async () => ({})),
}));

import { resolveDynamicBlocks } from "@/lib/resolveDynamicBlocks";

/**
 * MegaMenu — the resolver half of the hybrid contract.
 *
 * A MegaMenu node BINDS like NavMenu (same navRefOf key, same menu map, one fetch per distinct ref)
 * and must receive `resolvedMenu`; its panel slots are ordinary VersoItem arrays, so the resolver's
 * generic slot recursion must decorate anything nested inside them — including a NavMenu sharing the
 * same reference, which must NOT trigger a second fetch.
 */

const tree = () => ({
    content: [
        {
            type: "MegaMenu",
            props: {
                source: "menu",
                menuId: 9,
                // panel0 holds arbitrary blocks — one of them a NavMenu bound to the SAME menu.
                panel0: [
                    { type: "Heading", props: { title: "Destacado", level: "h3" } },
                    { type: "NavMenu", props: { source: "menu", menuId: 9 } },
                ],
                panel1: [],
            },
        },
    ],
});

describe("resolveDynamicBlocks — MegaMenu shares NavMenu's binding seam", () => {
    it("injects resolvedMenu into the MegaMenu AND into a NavMenu nested in a panel slot (one fetch)", async () => {
        const input = tree();
        const out = (await resolveDynamicBlocks(input)) as {
            content: Array<{ props: Record<string, unknown> & { panel0: Array<{ type: string; props: Record<string, unknown> }> } }>;
        };

        const mega = out.content[0].props;
        expect(Array.isArray(mega.resolvedMenu)).toBe(true);
        expect((mega.resolvedMenu as unknown[]).length).toBe(2);
        expect((mega.resolvedMenu as Array<{ title: string }>)[0].title).toBe("Home");

        // The resolver recursed into the panel slot: the nested NavMenu got the same resolved list.
        const nested = mega.panel0.find((n) => n.type === "NavMenu")!;
        expect(Array.isArray(nested.props.resolvedMenu)).toBe(true);
        expect((nested.props.resolvedMenu as unknown[]).length).toBe(2);

        // Equal refs collapse to ONE canonical-store read (menu:9 collected once).
        expect(getMenuByRef).toHaveBeenCalledTimes(1);
        expect(getMenuByRef).toHaveBeenCalledWith({ source: "menu", menuId: 9 });

        // The input tree is never mutated (it is the shared, cached API response).
        expect(input.content[0].props).not.toHaveProperty("resolvedMenu");
        expect(input.content[0].props.panel0[1].props).not.toHaveProperty("resolvedMenu");
    });
});
