import { describe, it, expect, vi } from "vitest";
import React from "react";

/**
 * '/' — the homepage route runs the SAME resolver pass as every other public route.
 *
 * The static-front-page branch used to hand the raw post straight to HomeContent: NavMenu / SiteLogo /
 * ToC / PostsGrid on the configured homepage rendered EMPTY at the site root while the identical page
 * rendered correctly at its own /<slug> URL (every other route calls withResolvedBlocks; this one
 * didn't even import it). This test invokes the async route component and walks the element tree it
 * returns — no DOM needed — asserting the post handed to HomeContent carries the resolver's
 * injections.
 */

const MENU_ITEMS = [
    { id: 1, title: "Home", url: "/", target: "_self", parent: 0, order: 0 },
    { id: 2, title: "Products", url: "/products", target: "_self", parent: 0, order: 1 },
];

const FRONT_PAGE = {
    id: 7,
    type: "page",
    title: "Portada",
    slug: "portada",
    status: "publish",
    content: "",
    meta: { _puck_data: { content: [{ type: "NavMenu", props: { source: "location", location: "header" } }] } },
};

vi.mock("@/lib/server-api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/server-api")>();
    return {
        ...actual,
        getSettings: vi.fn(async () => ({ homepage_id: "7", blogname: "Acme" })),
        getPostById: vi.fn(async (id: number) => (id === 7 ? FRONT_PAGE : null)),
        getMenuByRef: vi.fn(async () => ({ items: MENU_ITEMS })),
        getPosts: vi.fn(async () => []),
        resolveSiteBase: vi.fn(async () => "http://localhost:3000"),
    };
});

import HomePage from "@/app/(public)/page";
import HomeContent from "@/components/public/HomeContent";

// Depth-first search for the first element of `type` in a (non-rendered) React element tree.
function findByType(node: unknown, type: unknown): React.ReactElement | null {
    if (Array.isArray(node)) {
        for (const child of node) {
            const hit = findByType(child, type);
            if (hit) return hit;
        }
        return null;
    }
    if (!React.isValidElement(node)) return null;
    if (node.type === type) return node;
    return findByType((node.props as { children?: unknown }).children, type);
}

describe("HomePage ('/') — static front page goes through withResolvedBlocks", () => {
    it("hands HomeContent a post whose NavMenu carries the resolver-injected menu", async () => {
        const el = await HomePage();
        const homeContent = findByType(el, HomeContent);
        expect(homeContent).not.toBeNull();

        const post = (homeContent!.props as { post: typeof FRONT_PAGE }).post;
        const nav = (post.meta._puck_data as { content: Array<{ type: string; props: Record<string, unknown> }> }).content[0];
        expect(nav.type).toBe("NavMenu");
        expect(Array.isArray(nav.props.resolvedMenu)).toBe(true);
        expect((nav.props.resolvedMenu as unknown[]).length).toBe(2);

        // …and the shared cached post object itself was NOT mutated (withResolvedBlocks copies).
        expect(FRONT_PAGE.meta._puck_data.content[0].props).not.toHaveProperty("resolvedMenu");
        expect(post).not.toBe(FRONT_PAGE);
    });
});
