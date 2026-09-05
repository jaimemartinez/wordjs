/**
 * GATE — the Reading setting sizes the BLOG ROLL, and nothing else.
 *
 * `getPosts` learned to send `per_page=<posts_per_page>` so an owner who asks for 20 posts on the
 * front page gets 20. But it was also the pool every PostsGrid and CategoryPosts block was sliced
 * out of, so the same change made a Reading setting resize things it has no business resizing: a
 * front page shortened to three posts turned every `count: 6` grid on the site into three cards, and
 * left every CategoryPosts filtering inside the newest three — which almost never contains the
 * category it was pointed at, so the block silently fell back to "the newest posts" instead.
 *
 * Two loaders now: `getPosts` is the roll's (exactly `posts_per_page`) and `getPostPool` is the
 * blocks' (at least ten, at least `posts_per_page`, at least the biggest `count` on the page). This
 * pins both halves at once — the same stubbed backend, the same settings, one call each.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getPostPool, getPosts } from "@/lib/server-api";
import { resolveDynamicBlocks } from "@/lib/resolveDynamicBlocks";

type Category = { id: number; name: string; slug: string };
type Row = {
    id: number; slug: string; title: string; status: string; type: string;
    content: string; excerpt: string; date: string; categories?: Category[];
};

const NEWS: Category = { id: 3, name: "News", slug: "news" };

/**
 * Eight published posts, newest first — the order the list endpoint returns them in. Only the
 * SEVENTH is in "news", so a pool of three cannot contain it and a pool of ten can: that gap is the
 * whole CategoryPosts half of the defect.
 */
const ROWS: Row[] = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    slug: `post-${i + 1}`,
    title: `Post ${i + 1}`,
    status: "publish",
    type: "post",
    content: `<p>body ${i + 1}</p>`,
    excerpt: `excerpt ${i + 1}`,
    date: `2026-0${9 - Math.floor(i / 4)}-0${(8 - i % 8) || 1}T00:00:00.000Z`,
    ...(i === 6 ? { categories: [NEWS] } : {}),
}));

/** The production paging formula: `offset = (page - 1) * per_page`, read off each request's own size. */
function stubBackend(settings: Record<string, unknown>, rows: Row[] = ROWS): string[] {
    const urls: string[] = [];
    const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        const raw = String(url);
        urls.push(raw);
        if (raw.includes("/settings")) return answer(settings);
        const params = new URL(raw).searchParams;
        const page = Number(params.get("page") || "1");
        const size = Number(params.get("per_page") || "0");
        const start = (page - 1) * size;
        return answer(rows.slice(start, start + size));
    }));
    return urls;
}

const postsUrls = (urls: string[]) => urls.filter((u) => u.includes("/posts?"));

afterEach(() => vi.unstubAllGlobals());

describe("posts_per_page = 3 — a short front page must not shrink the page's blocks", () => {
    it("gives a PostsGrid asking for 6 the six cards it asked for", async () => {
        const urls = stubBackend({ posts_per_page: 3 });
        const data = { content: [{ type: "PostsGrid", props: { id: "grid-1", count: 6 } }], root: { props: {} } };

        const out = (await resolveDynamicBlocks(data)) as { content: Array<{ props: Record<string, unknown> }> };
        const grid = out.content[0].props;

        expect((grid.resolvedPosts as unknown[]).length).toBe(6);
        // The pool was fetched at the floor of ten, not at the Reading setting of three.
        expect(postsUrls(urls)[0]).toContain("per_page=10");
    });

    it("lets a CategoryPosts block find a post that is NOT among the newest three", async () => {
        stubBackend({ posts_per_page: 3 });
        const data = {
            content: [{ type: "CategoryPosts", props: { id: "cat-1", count: 5, categorySlug: "news" } }],
            root: { props: {} },
        };

        const out = (await resolveDynamicBlocks(data)) as { content: Array<{ props: Record<string, unknown> }> };
        const block = out.content[0].props;
        const ids = (block.resolvedPosts as Array<{ id: number }>).map((p) => p.id);

        // Post 7 is the only member of "news" and sits outside a three-post pool entirely.
        expect(ids).toEqual([7]);
        // `resolvedFiltered: false` is the block admitting it showed unrelated posts instead — silent
        // on the public page, because the notice only renders while editing.
        expect(block.resolvedFiltered).toBe(true);
    });

    it("raises the pool to the biggest count on the page, and still trims to what exists", async () => {
        const urls = stubBackend({ posts_per_page: 3 });
        const data = {
            content: [
                { type: "PostsGrid", props: { id: "grid-a", count: 4 } },
                { type: "PostsGrid", props: { id: "grid-b", count: 12 } },
            ],
            root: { props: {} },
        };

        const out = (await resolveDynamicBlocks(data)) as { content: Array<{ props: Record<string, unknown> }> };

        expect((out.content[0].props.resolvedPosts as unknown[]).length).toBe(4);
        expect((out.content[1].props.resolvedPosts as unknown[]).length).toBe(8); // only eight exist
        expect(postsUrls(urls)[0]).toContain("per_page=12");
    });

    it("still hands the BLOG ROLL exactly posts_per_page — the setting keeps doing its own job", async () => {
        const urls = stubBackend({ posts_per_page: 3 });

        const roll = await getPosts("post", "publish");

        expect((roll || []).map((p) => p.id)).toEqual([1, 2, 3]);
        expect(postsUrls(urls)[0]).toContain("per_page=3");
    });
});

describe("getPostPool — floors and ceiling", () => {
    it("never drops below the backend's own default of ten", async () => {
        stubBackend({ posts_per_page: 1 });
        expect(((await getPostPool("post", "publish", 1)) || []).length).toBe(8);
    });

    it("follows posts_per_page upwards when the owner asks for more than any block does", async () => {
        const urls = stubBackend({ posts_per_page: 40 });
        await getPostPool("post", "publish", 6);
        expect(postsUrls(urls)[0]).toContain("per_page=40");
    });

    it("clamps a hand-edited count to one API page instead of fanning out", async () => {
        const urls = stubBackend({ posts_per_page: 10 });
        await getPostPool("post", "publish", 9999);
        expect(postsUrls(urls)[0]).toContain("per_page=100");
        expect(postsUrls(urls)).toHaveLength(1);
    });
});
