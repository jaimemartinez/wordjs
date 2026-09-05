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

/**
 * The blog-roll branch's posts. `author` is an OBJECT — the shape the generated ContentRecord has
 * always declared and the shape Post.toJSON() now really sends; it used to be the bare author id, so
 * `post.author?.displayName` was `undefined` and every byline on the front page read "Admin".
 */
const ROLL_POSTS = [
    {
        id: 11, type: "post", status: "publish", slug: "first", title: "First post",
        content: "<p>one</p>", excerpt: "one", date: "2026-01-02T00:00:00.000Z",
        author: { id: 4, displayName: "Ada Lovelace", slug: "ada" },
    },
    {
        id: 12, type: "post", status: "publish", slug: "second", title: "Second post",
        content: "<p>two</p>", excerpt: "two", date: "2026-01-01T00:00:00.000Z",
        author: { id: 5, displayName: "Grace Hopper", slug: "grace" },
    },
];

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

import * as serverApi from "@/lib/server-api";
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

/** Every string that appears anywhere in a (non-rendered) React element tree. */
function textIn(node: unknown, out: string[] = []): string[] {
    if (typeof node === "string" || typeof node === "number") {
        out.push(String(node));
        return out;
    }
    if (Array.isArray(node)) {
        for (const child of node) textIn(child, out);
        return out;
    }
    if (!React.isValidElement(node)) return out;
    return textIn((node.props as { children?: unknown }).children, out);
}

describe("HomePage ('/') — the blog roll renders the author the API really sends", () => {
    it("shows each post's author.displayName instead of the 'Admin' fallback", async () => {
        // No homepage_id → the OTHER branch of the route: the blog roll.
        vi.mocked(serverApi.getSettings).mockResolvedValueOnce({ blogname: "Acme", posts_per_page: "10" });
        vi.mocked(serverApi.getPosts).mockResolvedValueOnce(
            ROLL_POSTS as unknown as Awaited<ReturnType<typeof serverApi.getPosts>>,
        );

        const text = textIn(await HomePage());

        expect(text).toContain("First post");
        expect(text).toContain("Second post");
        // THE ASSERTION: a bare `author: 4` reads `undefined` here and the byline falls back to
        // "Admin" — which is what the front page showed for every post of every author.
        expect(text).toContain("Ada Lovelace");
        expect(text).toContain("Grace Hopper");
        expect(text).not.toContain("Admin");
    });
});

describe("getPosts() sends per_page from the posts_per_page option", () => {
    /**
     * Drives the REAL loader (the mock above is what the route sees; this is the module itself) with a
     * stubbed backend that applies the PRODUCTION offset formula — `offset = (page - 1) * per_page`,
     * read off each request's OWN `per_page` exactly as backend/src/routes/posts.ts computes it. That
     * is what makes the returned ids meaningful: a walk whose page size varies between requests moves
     * the window backwards, and only the ROWS show it. Asserting the URLs alone cannot: the previous
     * version of this test did that, and it stayed green while the loader returned fifty duplicates.
     */
    async function walk(settings: Record<string, unknown>, rows: number) {
        const actual = await vi.importActual<typeof import("@/lib/server-api")>("@/lib/server-api");
        const urls: string[] = [];
        const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            urls.push(String(url));
            if (String(url).includes("/settings")) return answer(settings);
            const params = new URL(String(url)).searchParams;
            const page = Number(params.get("page") || "1");
            const size = Number(params.get("per_page") || "0");
            const start = (page - 1) * size;
            const slice = Array.from({ length: Math.max(0, Math.min(size, rows - start)) }, (_, i) => ({
                id: start + i + 1, status: "publish", type: "post",
            }));
            return answer(slice);
        }));
        let posts: Awaited<ReturnType<typeof actual.getPosts>> = null;
        try {
            posts = await actual.getPosts("post", "publish");
        } finally {
            vi.unstubAllGlobals();
        }
        return { urls: urls.filter((u) => u.includes("/posts?")), ids: (posts || []).map((p) => p.id) };
    }

    it("asks for the configured page size, not the backend's default of 10", async () => {
        const { urls, ids } = await walk({ posts_per_page: "25" }, 25);
        expect(urls).toHaveLength(1);
        expect(urls[0]).toContain("per_page=25");
        expect(urls[0]).toContain("page=1");
        expect(ids).toHaveLength(25);
    });

    it("falls back to 10 when the option is missing or unusable", async () => {
        expect((await walk({}, 10)).urls[0]).toContain("per_page=10");
        expect((await walk({ posts_per_page: "nonsense" }, 10)).urls[0]).toContain("per_page=10");
    });

    it("walks pages when posts_per_page exceeds the API's 100-row maximum", async () => {
        const { urls, ids } = await walk({ posts_per_page: 150 }, 150);
        // THE ASSERTION IS THE ROWS. 150 posts exist and 150 DISTINCT posts must come back, in order,
        // with none of them fetched twice. A shrinking page size answers 1..100 then 51..100 here.
        expect(ids).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
        expect(new Set(ids).size).toBe(150);
        // Two whole pages of 100, so the walk overshoots and the result is trimmed back to 150.
        expect(urls).toHaveLength(2);
        expect(urls[0]).toContain("per_page=100");
        expect(urls[1]).toContain("per_page=100");
        expect(urls[1]).toContain("page=2");
    });

    it("stops at the site's real end, and never returns more than posts_per_page", async () => {
        // 120 posts asked for, only 40 exist: one short page ends the walk.
        const short = await walk({ posts_per_page: 120 }, 40);
        expect(short.ids).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
        expect(short.urls).toHaveLength(1);

        // Exactly 100 wanted out of 250: one page, and no page 2 nobody asked for.
        const exact = await walk({ posts_per_page: 100 }, 250);
        expect(exact.ids).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
        expect(exact.urls).toHaveLength(1);
    });
});
