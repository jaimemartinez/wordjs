import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
// Next's OWN route sorter — the thing that decides which of two matching routes answers a URL.
import { getSortedRoutes } from "next/dist/shared/lib/router/utils/sorted-routes";

/**
 * THE ARCHIVE ROUTES — `/category`, `/tag`, `/author`, `/archive/{yyyy}[/{mm}]`, `/taxonomy`.
 *
 * `GET /posts` filters for real on `?categories=`, `?tags=` and `?author=`, so these routes ASK the
 * backend for the archive's posts instead of reading the site and narrowing in memory. That moves the
 * thing that can go wrong: the route can send the wrong selector, send none at all, or read the wrong
 * shape out of the answer, and every one of those still renders a confident listing. So the fake
 * backend below APPLIES the filters — a request that forgets `?categories=` gets every post on the
 * site, and the assertions on the selected posts are what catch it.
 *
 * The routes are invoked directly and the element tree they return is walked (no DOM, no renderer),
 * the same technique homePageResolvedBlocks.test.tsx uses.
 */

const CATEGORIES = [
    { id: 1, name: "News", slug: "news", taxonomy: "category", description: "Everything new", count: 3 },
    { id: 2, name: "Ideas", slug: "ideas", taxonomy: "category", description: "", count: 1 },
];

const TAGS = [{ id: 9, name: "Tips", slug: "tips", taxonomy: "post_tag", description: "", count: 1 }];

const NEWS = [{ id: 1, name: "News", slug: "news" }];
const IDEAS = [{ id: 2, name: "Ideas", slug: "ideas" }];

/**
 * `author` is the OBJECT `Post.toJSON()` really sends — `{ id, displayName, slug }` — which is what
 * makes `/author/jane-roe` addressable and the archive title a NAME. Post 105 keeps the bare number
 * the API used to send, so the back-compat branch of postAuthorId/postAuthorName stays pinned by a
 * real route rather than by a unit call.
 */
const JANE = { id: 3, displayName: "Jane Roe", slug: "jane-roe" };
const RAY = { id: 4, displayName: "Ray Ito", slug: "ray-ito" };

const POSTS = [
    { id: 101, title: "News four",  slug: "news-4", status: "publish", type: "post", content: "", excerpt: "d", date: "2026-03-04 09:00:00", author: JANE, categories: NEWS,  tags: [] },
    { id: 102, title: "News three", slug: "news-3", status: "publish", type: "post", content: "", excerpt: "c", date: "2026-03-03 09:00:00", author: JANE, categories: NEWS,  tags: TAGS },
    { id: 103, title: "News two",   slug: "news-2", status: "publish", type: "post", content: "", excerpt: "b", date: "2026-02-02 09:00:00", author: RAY,  categories: NEWS,  tags: [] },
    { id: 104, title: "Idea one",   slug: "idea-1", status: "publish", type: "post", content: "", excerpt: "a", date: "2026-02-01 09:00:00", author: RAY,  categories: IDEAS, tags: [] },
    { id: 105, title: "Untagged",   slug: "plain",  status: "publish", type: "post", content: "", excerpt: "z", date: "2025-12-31 23:30:00", author: 4,    categories: [],    tags: [] },
];

const TAXONOMIES: Record<string, unknown> = {
    category: { name: "category", label: "Categories", public: true, hierarchical: true, rewrite: { slug: "category" } },
    genre: { name: "genre", label: "Genres", public: true, hierarchical: false, rewrite: { slug: "genre" } },
};

/** Every `/posts?` query the fake backend was asked, in order — the routes' half of the contract. */
const postQueries: URLSearchParams[] = [];

/** An id-or-slug selector, matched the way the backend's identity grammar matches one. */
const denotes = (selector: string, id: number, slug: string): boolean =>
    /^[0-9]+$/.test(selector) ? Number(selector) === id : selector === slug;

/**
 * The backend's OWN narrowing, reproduced: a filter the route did not send narrows nothing, which is
 * exactly how a route that forgot one would behave in production.
 */
function filterPosts(params: URLSearchParams): unknown[] {
    const categories = params.get("categories");
    const tags = params.get("tags");
    const author = params.get("author");
    return POSTS.filter((post) => {
        if (post.status !== "publish") return false;
        if (categories && !post.categories.some((t) => denotes(categories, t.id, t.slug))) return false;
        if (tags && !post.tags.some((t) => denotes(tags, t.id, t.slug))) return false;
        if (author) {
            const ref = post.author;
            const id = typeof ref === "number" ? ref : ref.id;
            const slug = typeof ref === "number" ? "" : ref.slug;
            if (!denotes(author, id, slug)) return false;
        }
        return true;
    });
}

/** Which backend endpoint a `serverFetch` call is asking for, page number included. */
function answer(endpoint: string): unknown {
    const query = new URLSearchParams(endpoint.slice(endpoint.indexOf("?") + 1));
    const page = Number(query.get("page") ?? "1");
    if (endpoint.startsWith("/posts?")) {
        postQueries.push(query);
        return page === 1 ? filterPosts(query) : [];
    }
    if (endpoint.startsWith("/categories?")) return page === 1 ? CATEGORIES : [];
    if (endpoint.startsWith("/tags?")) return page === 1 ? TAGS : [];
    if (endpoint.startsWith("/taxonomies/")) return TAXONOMIES[endpoint.slice("/taxonomies/".length)] ?? null;
    return null;
}

vi.mock("@/lib/server-api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/server-api")>();
    return {
        ...actual,
        // posts_per_page = 2 so the three News posts are two pages: pagination is observable.
        getSettings: vi.fn(async () => ({ blogname: "Acme", posts_per_page: "2" })),
        // No theme template → ThemeTemplate falls through to its children, which is the normal case.
        getThemeTemplate: vi.fn(async () => null),
        getThemeManifest: vi.fn(async () => null),
        getThemeChrome: vi.fn(async () => null),
        serverFetch: vi.fn(async (endpoint: string) => answer(endpoint)),
    };
});

/** `notFound()` throws in Next; give it a shape this file can assert on. */
const NOT_FOUND = "ARCHIVE_TEST_NOT_FOUND";
vi.mock("next/navigation", () => ({
    notFound: () => {
        throw new Error(NOT_FOUND);
    },
    // The public layout imports it (fresh install → /install). Settings are mocked, so it never fires.
    redirect: (to: string) => {
        throw new Error(`ARCHIVE_TEST_REDIRECT:${to}`);
    },
}));

/**
 * The public LAYOUT is imported for exactly one thing below: the feed `<link rel="alternate">`s it
 * advertises. Its chrome pulls a whole client tree behind it and none of it is under test, so the
 * three chrome modules are stubbed away. Nothing here is ever rendered — the layout's element tree is
 * walked, the same way the archive routes' is.
 */
vi.mock("@/components/public/PublicLayoutShell", () => ({ default: () => null }));
vi.mock("@/components/chrome/ChromeRenderer", () => ({ default: () => null }));
vi.mock("@/components/public/ViewTransitions", () => ({ default: () => null }));

import CategoryArchive, { generateMetadata as categoryMetadata } from "@/app/(public)/category/[slug]/[[...paged]]/page";
import TagArchive from "@/app/(public)/tag/[slug]/[[...paged]]/page";
import AuthorArchive, { generateMetadata as authorMetadata } from "@/app/(public)/author/[slug]/[[...paged]]/page";
import DateArchive from "@/app/(public)/archive/[...segments]/page";
import TaxonomyArchive, { generateMetadata as taxonomyMetadata } from "@/app/(public)/taxonomy/[taxonomy]/[term]/[[...paged]]/page";
import ArchivePage from "@/lib/public/archiveRoute";
import ArchiveContent from "@/components/public/ArchiveContent";
import ThemeTemplate from "@/components/content/ThemeTemplate";
import {
    parsePagedSegments,
    paginate,
    filterPostsByDate,
    postAuthorId,
    postAuthorName,
    postAuthorSlug,
    postDateLabel,
    taxonomyFeedPath,
} from "@/lib/public/archives";
// The public feed/sitemap URLs and the layout that advertises them (see the last describe block).
import PublicLayout from "@/app/(public)/layout";
import { GET as sitemapRoute } from "@/app/(public)/sitemap.xml/route";
import { GET as sitemapChunkRoute } from "@/app/(public)/sitemap/[chunk]/route";
import { GET as categoryFeedRoute } from "@/app/(public)/category/[slug]/feed.xml/route";
import { GET as robotsRoute } from "@/app/(public)/robots.txt/route";

type AnyProps = Record<string, unknown>;

/** Depth-first search for the first element of `type` in a (non-rendered) React element tree. */
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

/** Run a route, then run the shared renderer it returned, and hand back both sets of props. */
async function render<P>(route: (a: { params: Promise<P> }) => Promise<unknown>, params: P) {
    const routeEl = await route({ params: Promise.resolve(params) });
    const spec = findByType(routeEl, ArchivePage);
    expect(spec, "route did not return an <ArchivePage>").not.toBeNull();
    const tree = await ArchivePage(spec!.props as Parameters<typeof ArchivePage>[0]);
    const template = findByType(tree, ThemeTemplate);
    const content = findByType(tree, ArchiveContent);
    return {
        spec: spec!.props as AnyProps,
        template: (template?.props ?? {}) as AnyProps,
        content: (content?.props ?? {}) as AnyProps,
    };
}

const titlesOf = (content: AnyProps) =>
    ((content.page as { items: Array<{ title: string }> }).items).map((p) => p.title);

describe("/category/[slug] — only that category's posts", () => {
    it("lists the category's posts and nothing else", async () => {
        const { spec, content } = await render(CategoryArchive, { slug: "news" });
        // Three News posts exist; `posts_per_page` is 2, so page 1 holds the two newest of THEM.
        expect((spec.posts as unknown[]).map((p) => (p as { id: number }).id)).toEqual([101, 102, 103]);
        expect(titlesOf(content)).toEqual(["News four", "News three"]);
        // The Ideas post and the untagged one must never appear on a News archive.
        expect(titlesOf(content)).not.toContain("Idea one");
        expect(titlesOf(content)).not.toContain("Untagged");
    });

    it("titles the archive with the term's name and description", async () => {
        const { content } = await render(CategoryArchive, { slug: "news" });
        expect(content.title).toBe("News");
        expect(content.description).toBe("Everything new");
        expect(content.kindLabel).toBe("Category");
    });

    it("asks the theme for the category template chain and hands it the term's posts", async () => {
        const { template } = await render(CategoryArchive, { slug: "news" });
        expect(template.kind).toBe("category");
        expect(template.slug).toBe("news");
        const ctx = template.context as { posts: unknown[]; categorySlug?: string };
        // The WHOLE narrowed list, not page 1's slice: a PostsGrid on archive.json carries its own count.
        expect(ctx.posts).toHaveLength(3);
        expect(ctx.categorySlug).toBe("news");
    });

    it("404s an unknown category slug", async () => {
        await expect(CategoryArchive({ params: Promise.resolve({ slug: "does-not-exist" }) })).rejects.toThrow(NOT_FOUND);
    });

    it("matches the term slug case-insensitively but paginates from the canonical slug", async () => {
        const { content } = await render(CategoryArchive, { slug: "NEWS" });
        expect(content.basePath).toBe("/category/news");
    });
});

describe("/category/[slug]/page/[n] — pagination", () => {
    it("slices page 2 and reports the page count", async () => {
        const { content } = await render(CategoryArchive, { slug: "news", paged: ["page", "2"] });
        const page = content.page as { items: unknown[]; page: number; total: number; totalPages: number; perPage: number };
        expect(page.page).toBe(2);
        expect(page.perPage).toBe(2);
        expect(page.total).toBe(3);
        expect(page.totalPages).toBe(2);
        expect(titlesOf(content)).toEqual(["News two"]);
    });

    it("404s a page past the end, page/1, and a malformed tail", async () => {
        for (const paged of [["page", "3"], ["page", "1"], ["page", "0"], ["page", "02"], ["page"], ["foo", "2"], ["page", "2", "3"]]) {
            await expect(
                CategoryArchive({ params: Promise.resolve({ slug: "news", paged }) }).then((el) =>
                    // `/page/3` is only refused once the slice is known, i.e. inside the shared renderer.
                    ArchivePage((findByType(el, ArchivePage)!.props) as Parameters<typeof ArchivePage>[0]),
                ),
                `paged=${JSON.stringify(paged)} should not render`,
            ).rejects.toThrow(NOT_FOUND);
        }
    });

    it("parsePagedSegments accepts only nothing or page/N with N>=2", () => {
        expect(parsePagedSegments(undefined)).toBe(1);
        expect(parsePagedSegments([])).toBe(1);
        expect(parsePagedSegments(["page", "2"])).toBe(2);
        expect(parsePagedSegments(["page", "17"])).toBe(17);
        for (const bad of [["page", "1"], ["page", "0"], ["page", "01"], ["page", "-2"], ["page", " 2"], ["page"], ["2"], ["pages", "2"]]) {
            expect(parsePagedSegments(bad), JSON.stringify(bad)).toBeNull();
        }
    });

    it("paginate() reports an empty archive as page 1 of 1, not 1 of 0", () => {
        expect(paginate([], 1, 10)).toMatchObject({ total: 0, totalPages: 1, page: 1, items: [] });
    });
});

describe("canonical + feed autodiscovery", () => {
    it("emits a self-referential canonical and the per-taxonomy RSS link", async () => {
        const meta = await categoryMetadata({ params: Promise.resolve({ slug: "news" }) });
        expect(meta.alternates?.canonical).toBe("/category/news");
        const rss = (meta.alternates?.types as Record<string, Array<{ url: string }>>)["application/rss+xml"];
        // The PUBLIC feed URL — the one the scoped channel prints as its own `self` link, and the one
        // `category/[slug]/feed.xml/route.ts` serves. NOT `/api/v1/seo/…`: that prefix answers, but
        // this site's own robots.txt disallows it, so autodiscovery pointed crawlers at a URL they
        // are told to skip.
        expect(rss[0].url).toBe("/category/news/feed.xml");
    });

    it("canonicalises page 2 to page 2, not to page 1", async () => {
        const meta = await categoryMetadata({ params: Promise.resolve({ slug: "news", paged: ["page", "2"] }) });
        expect(meta.alternates?.canonical).toBe("/category/news/page/2");
        expect(meta.title).toBe("News — Page 2");
    });

    it("marks an unknown term noindex instead of inventing a canonical", async () => {
        const meta = await categoryMetadata({ params: Promise.resolve({ slug: "nope" }) });
        expect(meta.robots).toMatchObject({ index: false });
        expect(meta.alternates?.canonical).toBeUndefined();
    });
});

describe("the archive asks the BACKEND for its posts", () => {
    /** The `/posts?` queries one render produced. */
    async function queriesFor(run: () => Promise<unknown>): Promise<URLSearchParams[]> {
        postQueries.length = 0;
        await run();
        return [...postQueries];
    }

    it("sends the term filter, the published status and a full page — not a walk over the site", async () => {
        const queries = await queriesFor(() => render(CategoryArchive, { slug: "news" }));
        expect(queries.length).toBeGreaterThan(0);
        const first = queries[0];
        // The term's ID: an id denotes one row, where a slug can be widened by a comma or shadowed by
        // a case-insensitive collation.
        expect(first.get("categories")).toBe("1");
        expect(first.get("status")).toBe("publish");
        expect(first.get("type")).toBe("post");
        expect(first.get("per_page")).toBe("100");
        expect(first.get("page")).toBe("1");
        // One page covered every match, so the walk stopped: an archive is not a scan of the site.
        expect(queries).toHaveLength(1);
    });

    it("sends ?tags= for a tag archive and ?author= for an author archive", async () => {
        expect((await queriesFor(() => render(TagArchive, { slug: "tips" })))[0].get("tags")).toBe("9");
        expect((await queriesFor(() => render(AuthorArchive, { slug: "4" })))[0].get("author")).toBe("4");
    });

    it("the /taxonomy alias resolves to the SAME filtered listing as the dedicated address", async () => {
        const alias = await queriesFor(() => render(TaxonomyArchive, { taxonomy: "category", term: "news" }));
        const dedicated = await queriesFor(() => render(CategoryArchive, { slug: "news" }));
        expect(alias[0].get("categories")).toBe(dedicated[0].get("categories"));
    });

    it("the DATE archive is the exception, and reads the set because the API has no date filter", async () => {
        const queries = await queriesFor(() => render(DateArchive, { segments: ["2026", "02"] }));
        expect(queries[0].get("categories")).toBeNull();
        expect(queries[0].get("author")).toBeNull();
        expect(queries[0].get("status")).toBe("publish");
    });
});

describe("/tag/[slug]", () => {
    it("lists only the tagged post and asks for the tag template chain", async () => {
        const { template, content } = await render(TagArchive, { slug: "tips" });
        expect(titlesOf(content)).toEqual(["News three"]);
        expect(content.basePath).toBe("/tag/tips");
        expect(template.kind).toBe("tag");
    });

    it("404s an unknown tag", async () => {
        await expect(TagArchive({ params: Promise.resolve({ slug: "nope" }) })).rejects.toThrow(NOT_FOUND);
    });
});

describe("/author/[slug|id]", () => {
    it("reads the author object the API really sends, and still reads a bare number", () => {
        expect(postAuthorId(POSTS[0] as never)).toBe(3);
        expect(postAuthorName(POSTS[0] as never)).toBe("Jane Roe");
        expect(postAuthorSlug(POSTS[0] as never)).toBe("jane-roe");
        // Post 105 is the legacy payload: an id, no name, no slug — the branch that keeps a cached or
        // imported response rendering instead of 404ing.
        expect(postAuthorId(POSTS[4] as never)).toBe(4);
        expect(postAuthorName(POSTS[4] as never)).toBe("");
        expect(postAuthorSlug(POSTS[4] as never)).toBe("");
    });

    it("lists that author's posts only, by id", async () => {
        const { spec, content } = await render(AuthorArchive, { slug: "4" });
        expect((spec.posts as Array<{ id: number }>).map((p) => p.id)).toEqual([103, 104, 105]);
        // The archive is titled with the NAME the API sends, not "Author 4".
        expect(content.title).toBe("Ray Ito");
    });

    it("serves the NICENAME too — the spelling every author feed prints as its own link", async () => {
        const { spec, content } = await render(AuthorArchive, { slug: "jane-roe" });
        expect((spec.posts as Array<{ id: number }>).map((p) => p.id)).toEqual([101, 102]);
        expect(content.title).toBe("Jane Roe");
        expect(content.basePath).toBe("/author/jane-roe");
        // …and it asked the backend for THAT author rather than fetching the site and sorting it out.
        expect(postQueries.some((q) => q.get("author") === "jane-roe")).toBe(true);
    });

    it("canonicalises the id spelling to the author's slug — one archive, one address", async () => {
        const { content } = await render(AuthorArchive, { slug: "4" });
        expect(content.basePath).toBe("/author/ray-ito");
        const meta = await authorMetadata({ params: Promise.resolve({ slug: "4" }) });
        expect(meta.alternates?.canonical).toBe("/author/ray-ito");
    });

    it("advertises the author feed the app serves — the route existed and nothing linked to it", async () => {
        const meta = await authorMetadata({ params: Promise.resolve({ slug: "jane-roe" }) });
        const rss = (meta.alternates?.types as Record<string, Array<{ url: string }>>)["application/rss+xml"];
        expect(rss[0].url).toBe("/author/jane-roe/feed.xml");
        // The URL must be one /author/[slug]/feed.xml can actually answer.
        expect(/^\/author\/([^/]+)\/feed\.xml$/.test(rss[0].url)).toBe(true);
    });

    it("404s an author with no posts and a segment that cannot denote one author", async () => {
        await expect(AuthorArchive({ params: Promise.resolve({ slug: "99" }) })).rejects.toThrow(NOT_FOUND);
        await expect(AuthorArchive({ params: Promise.resolve({ slug: "nobody" }) })).rejects.toThrow(NOT_FOUND);
        // A comma is an OR-list in the backend's identity grammar: one URL, several authors.
        await expect(AuthorArchive({ params: Promise.resolve({ slug: "jane-roe,ray-ito" }) })).rejects.toThrow(NOT_FOUND);
    });
});

describe("/archive/[yyyy][/mm] — date archives", () => {
    it("lists a whole year and a single month", async () => {
        const year = await render(DateArchive, { segments: ["2026"] });
        expect((year.spec.posts as unknown[]).length).toBe(4);
        expect(year.content.title).toBe("2026");

        const month = await render(DateArchive, { segments: ["2026", "02"] });
        expect(titlesOf(month.content)).toEqual(["News two", "Idea one"]);
        expect(month.content.title).toBe("February 2026");
        expect(month.content.basePath).toBe("/archive/2026/02");
    });

    it("reads the month off the date STRING, so a server timezone cannot move a post", () => {
        // 2025-12-31 23:30 local would be 2026-01-01 in any zone east of UTC if parsed as a Date.
        expect(filterPostsByDate(POSTS as never, "2025", "12").map((p) => p.id)).toEqual([105]);
        expect(filterPostsByDate(POSTS as never, "2026", "01")).toEqual([]);
    });

    it("the CARD's date is read off the string too, so no server locale or zone is baked into the HTML", () => {
        // The listing is cached SSR markup: toLocaleDateString() would render the HOST's locale for
        // every visitor, and would move this 23:30 post to the next day for anyone east of UTC.
        expect(postDateLabel(POSTS[4] as never)).toBe("December 31, 2025");
        expect(postDateLabel(POSTS[0] as never)).toBe("March 4, 2026");
        expect(postDateLabel({ date: "not a date" } as never)).toBe("");
        // Same vocabulary as the archive title, which is the other date this page prints.
        expect(postDateLabel(POSTS[0] as never)).toContain("2026");
    });

    it("404s a bad year, a bad month, an empty month and the bare /archive", async () => {
        for (const segments of [[], ["20xx"], ["0999"], ["2026", "13"], ["2026", "00"], ["2026", "07"], ["2026", "02", "junk"]]) {
            await expect(
                DateArchive({ params: Promise.resolve({ segments }) }),
                JSON.stringify(segments),
            ).rejects.toThrow(NOT_FOUND);
        }
    });

    it("paginates a year, and 404s a page past the end of a month", async () => {
        // Four posts in 2026, page size 2 → page 2 holds the two oldest.
        const { content } = await render(DateArchive, { segments: ["2026", "page", "2"] });
        expect(titlesOf(content)).toEqual(["News two", "Idea one"]);
        expect(content.basePath).toBe("/archive/2026");

        // March 2026 has two posts, so it is one page: /page/2 under it is a URL that does not exist.
        await expect(
            DateArchive({ params: Promise.resolve({ segments: ["2026", "03", "page", "2"] }) }).then((el) =>
                ArchivePage(findByType(el, ArchivePage)!.props as Parameters<typeof ArchivePage>[0]),
            ),
        ).rejects.toThrow(NOT_FOUND);
    });
});

describe("/taxonomy/[taxonomy]/[term]", () => {
    it("serves the taxonomies the API exposes and canonicalises to their rewrite base", async () => {
        const { content } = await render(TaxonomyArchive, { taxonomy: "category", term: "news" });
        expect(titlesOf(content)).toEqual(["News four", "News three"]);
        expect(content.basePath).toBe("/taxonomy/category/news");

        const meta = await taxonomyMetadata({ params: Promise.resolve({ taxonomy: "category", term: "news" }) });
        // NOT itself: the dedicated /category/news is the one indexable address for this archive.
        expect(meta.alternates?.canonical).toBe("/category/news");
    });

    it("404s a registered taxonomy whose terms the API does not expose, and an unregistered one", async () => {
        await expect(TaxonomyArchive({ params: Promise.resolve({ taxonomy: "genre", term: "scifi" }) })).rejects.toThrow(NOT_FOUND);
        await expect(TaxonomyArchive({ params: Promise.resolve({ taxonomy: "nope", term: "x" }) })).rejects.toThrow(NOT_FOUND);
        await expect(TaxonomyArchive({ params: Promise.resolve({ taxonomy: "../posts", term: "x" }) })).rejects.toThrow(NOT_FOUND);
    });
});

/**
 * THE PUBLIC FEED + SITEMAP URLS — `/sitemap.xml`, `/sitemap/<kind>-<n>.xml`, `/feed.{xml,atom,json}`,
 * `/comments/feed.xml` and `/{category,tag,author}/<slug>/feed.xml`.
 *
 * The documents themselves are the backend's; these routes are the ADDRESSES, so what can break is
 * the plumbing rather than the XML: the wrong upstream path, a lost content type, a chunk name that
 * should never have been forwarded, an upstream 404 answered as a 200 — and the one failure nothing
 * would show, a feed URL that never reaches its handler because the archive's optional catch-all
 * matched first.
 */
describe("the public feed + sitemap URLs", () => {
    afterEach(() => vi.unstubAllGlobals());

    type FetchInit = RequestInit & { next?: { revalidate?: number; tags?: string[] } };

    /** Stub THE one fetch a route makes, and keep what it was called with. */
    function upstream(body: string, init: ResponseInit = {}) {
        const calls: Array<[string, FetchInit]> = [];
        const fn = vi.fn(async (url: string, opts: FetchInit) => {
            calls.push([String(url), opts]);
            return new Response(body, init);
        });
        vi.stubGlobal("fetch", fn);
        return { fn, calls };
    }

    /** Every element of `type` in a (non-rendered) tree — findByType's plural. */
    function collectByType(node: unknown, type: unknown, out: React.ReactElement[] = []): React.ReactElement[] {
        if (Array.isArray(node)) {
            for (const child of node) collectByType(child, type, out);
            return out;
        }
        if (!React.isValidElement(node)) return out;
        if (node.type === type) out.push(node);
        return collectByType((node.props as { children?: unknown }).children, type, out);
    }

    const request = () => new Request("http://localhost/");

    it("/sitemap.xml streams the backend's document, with its type and its freshness headers", async () => {
        const XML = "<urlset><url><loc>https://example.test/</loc></url></urlset>";
        const { calls } = upstream(XML, {
            status: 200,
            headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600", ETag: 'W/"s1"' },
        });

        const res = await sitemapRoute();
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(XML);
        expect(res.headers.get("content-type")).toBe("application/xml");
        // Freshness is the upstream's to decide; the proxy must not invent its own.
        expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
        expect(res.headers.get("etag")).toBe('W/"s1"');

        expect(calls).toHaveLength(1);
        const [url, init] = calls[0];
        expect(url).toMatch(/^https?:\/\/[^/]+\/api\/v1\/seo\/sitemap\.xml$/);
        // Same window the upstream advertises, and on the tag a publish purges.
        expect(init.next?.revalidate).toBe(3600);
        expect(init.next?.tags).toContain("posts");
        // The forwarded public host and proto travel together or not at all (unconfigured = mid-install).
        const sent = (init.headers ?? {}) as Record<string, string>;
        expect("x-forwarded-proto" in sent).toBe("x-forwarded-host" in sent);
    });

    it("only forwards a sitemap chunk name the index could have printed", async () => {
        const { fn } = upstream("", { status: 200 });
        for (const chunk of ["evil.xml", "posts-1.txt", "posts-.xml", "authors-1.xml", "../settings", "sitemap-posts-1.xml"]) {
            const res = await sitemapChunkRoute(request(), { params: Promise.resolve({ chunk }) });
            expect(res.status, chunk).toBe(404);
            expect(res.headers.get("cache-control"), chunk).toBe("no-store");
        }
        expect(fn).not.toHaveBeenCalled();
    });

    it("asks for the chunk file the index really names", async () => {
        const { calls } = upstream("<urlset/>", { status: 200, headers: { "Content-Type": "application/xml" } });
        const res = await sitemapChunkRoute(request(), { params: Promise.resolve({ chunk: "posts-1.xml" }) });
        expect(res.status).toBe(200);
        expect(calls[0][0]).toMatch(/\/api\/v1\/seo\/sitemap-posts-1\.xml$/);
    });

    it("keeps an upstream 404 a 404, and answers 502 when the backend is unreachable", async () => {
        upstream("Feed not found", { status: 404, headers: { "Content-Type": "text/plain" } });
        const missing = await categoryFeedRoute(request(), { params: Promise.resolve({ slug: "nope" }) });
        expect(missing.status).toBe(404);
        expect(missing.headers.get("cache-control")).toBe("no-store");

        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
        const down = await categoryFeedRoute(request(), { params: Promise.resolve({ slug: "news" }) });
        expect(down.status).toBe(502);
        expect(down.headers.get("cache-control")).toBe("no-store");
    });

    it("sends the term's slug through, url-encoded, to the scoped channel", async () => {
        const { calls } = upstream("<rss/>", { status: 200, headers: { "Content-Type": "application/rss+xml" } });
        const res = await categoryFeedRoute(request(), { params: Promise.resolve({ slug: "news & views" }) });
        expect(res.status).toBe(200);
        expect(calls[0][0]).toMatch(/\/api\/v1\/seo\/category\/news%20%26%20views\/feed\.xml$/);
        expect(calls[0][1].next?.revalidate).toBe(900);
    });

    it("resolves /category/<slug>/feed.xml to the route handler, not to the archive's catch-all", () => {
        // Both routes match `/category/news/feed.xml` — the page as `paged = ['feed.xml']`, which it
        // 404s. Next's own sorter is what breaks the tie, and it puts the static segment first.
        expect(typeof categoryFeedRoute).toBe("function");
        expect(getSortedRoutes(["/category/[slug]/[[...paged]]", "/category/[slug]/feed.xml"])).toEqual([
            "/category/[slug]/feed.xml",
            "/category/[slug]/[[...paged]]",
        ]);
        // Same shape for the other two scoped channels.
        expect(getSortedRoutes(["/tag/[slug]/[[...paged]]", "/tag/[slug]/feed.xml"])[0]).toBe("/tag/[slug]/feed.xml");
        expect(getSortedRoutes(["/author/[slug]/[[...paged]]", "/author/[slug]/feed.xml"])[0]).toBe("/author/[slug]/feed.xml");
    });

    it("/robots.txt is served at the site root, on the upstream's own day-long window", async () => {
        const BODY = "User-agent: *\nAllow: /\n\nSitemap: https://example.test/sitemap.xml\n\nDisallow: /api/\n";
        const { calls } = upstream(BODY, {
            status: 200,
            headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" },
        });

        const res = await robotsRoute();
        expect(res.status).toBe(200);
        // Byte-for-byte: a crawler parses this file, and a rewritten Disallow is a rewritten policy.
        expect(await res.text()).toBe(BODY);
        expect(res.headers.get("content-type")).toBe("text/plain");
        expect(res.headers.get("cache-control")).toBe("public, max-age=86400");

        expect(calls).toHaveLength(1);
        const [url, init] = calls[0];
        expect(url).toMatch(/^https?:\/\/[^/]+\/api\/v1\/seo\/robots\.txt$/);
        expect(init.next?.revalidate).toBe(86400);
        // Built from the `siteurl` option, so a settings purge must refresh it.
        expect(init.next?.tags).toContain("settings");
    });

    it("/robots.txt answers 502 rather than an empty policy when the backend is down", async () => {
        // An empty or invented robots.txt is not a safe degrade: served as a 200 it would be cached
        // and would silently change what the whole site allows.
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
        const res = await robotsRoute();
        expect(res.status).toBe(502);
        expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("the archive advertises its feed at the URL this app actually serves", async () => {
        // The autodiscovery href and the route that answers it are written in two different files;
        // this is the assertion that keeps them the same URL.
        expect(taxonomyFeedPath("category", "news")).toBe("/category/news/feed.xml");
        expect(taxonomyFeedPath("tag", "tips")).toBe("/tag/tips/feed.xml");
        expect(taxonomyFeedPath("category", "news & views")).toBe("/category/news%20%26%20views/feed.xml");
        expect(taxonomyFeedPath("category", "news")).not.toContain("/api/");

        const { calls } = upstream("<rss/>", { status: 200, headers: { "Content-Type": "application/rss+xml" } });
        const advertised = taxonomyFeedPath("category", "news");
        const slug = /^\/category\/([^/]+)\/feed\.xml$/.exec(advertised)?.[1];
        expect(slug, `${advertised} is not a URL /category/[slug]/feed.xml can answer`).toBeTruthy();
        const res = await categoryFeedRoute(request(), { params: Promise.resolve({ slug: decodeURIComponent(slug!) }) });
        expect(res.status).toBe(200);
        expect(calls[0][0]).toMatch(/\/api\/v1\/seo\/category\/news\/feed\.xml$/);
    });

    it("the layout advertises the PUBLIC feed URLs, not the /api prefix robots.txt disallows", async () => {
        const tree = await PublicLayout({ children: null });
        const alternates = collectByType(tree, "link")
            .map((el) => el.props as { rel?: string; type?: string; href?: string })
            .filter((p) => p.rel === "alternate");

        expect(alternates.map((p) => p.href)).toEqual(["/feed.xml", "/feed.atom", "/feed.json"]);
        expect(alternates.map((p) => p.type)).toEqual([
            "application/rss+xml",
            "application/atom+xml",
            "application/feed+json",
        ]);
    });
});
