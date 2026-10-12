/**
 * A SLUG A POST AND A PAGE SHARE: the bare URL is the page's, the category URL and the post's preview are
 * the post's.
 *
 * The backend now resolves an untyped GET /posts/slug/:slug PAGE-first (a published post may no longer take
 * a page's /<slug>). Two frontend routes asked untyped and so changed what they render for such a pair:
 *   · /<category>/<post-slug> rendered the PAGE where it used to render the post;
 *   · /preview/<slug>, opened from a post's editor or the content list, previewed the published PAGE
 *     instead of the post's draft.
 * The category route now asks for the post first (getCategoryPostBySlug), and a preview link carries the
 * entry's type (previewHref), which the preview route forwards (getPostBySlugPreview). A type is only ever
 * sent spelled the way the backend accepts one, so a query-string value cannot turn a lookup into a 400.
 *
 * MUTATION PROOF: make getCategoryPostBySlug ask untyped first, or drop the type from postBySlugPath /
 * previewHref, and the matching expectations below fail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
    headers: async () => ({ get: () => null }),
}));

import { getCategoryPostBySlug, getPostBySlugPreview, postBySlugPath } from "@/lib/server-api";
import { previewHref } from "@/lib/previewHref";

/** A backend where `contact` is both a post (id 1) and a page (id 2), and `about` is only a page (id 3). */
function stubBackend() {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        const u = new URL(url);
        seen.push(`${u.pathname.replace(/^.*\/posts\/slug\//, "")}${u.search}`);
        const slug = decodeURIComponent(u.pathname.split("/").pop() || "");
        const type = u.searchParams.get("type");
        const rows: Record<string, Array<{ id: number; type: string }>> = {
            contact: [{ id: 2, type: "page" }, { id: 1, type: "post" }], // page-first, as the backend orders them
            about: [{ id: 3, type: "page" }],
        };
        const match = (rows[slug] || []).find((r) => !type || r.type === type);
        return match
            ? { ok: true, status: 200, json: async () => ({ ...match, slug }) }
            : { ok: false, status: 404, json: async () => ({ code: "rest_post_invalid_slug" }) };
    }));
    return seen;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("the category route resolves the POST of a shared slug", () => {
    it("/<category>/contact renders the post, not the page that owns /contact", async () => {
        const seen = stubBackend();
        const post = await getCategoryPostBySlug("contact");
        expect(post).toMatchObject({ id: 1, type: "post" });
        expect(seen[0]).toBe("contact?type=post");
    });

    it("a slug only a page holds still renders under a category URL (what the route did before)", async () => {
        stubBackend();
        expect(await getCategoryPostBySlug("about")).toMatchObject({ id: 3, type: "page" });
    });
});

describe("a draft preview names the entry's type", () => {
    it("the preview link of a post carries its type, and the preview route asks for that type", async () => {
        expect(previewHref("contact", "post")).toBe("/preview/contact?type=post");
        const seen = stubBackend();
        expect(await getPostBySlugPreview("contact", "post")).toMatchObject({ id: 1, type: "post" });
        expect(seen).toEqual(["contact?type=post"]);
    });

    it("without a type (or with one the backend would refuse) the lookup is the untyped one it always was", async () => {
        expect(previewHref("contact")).toBe("/preview/contact");
        expect(previewHref(42, "Post ")).toBe("/preview/42");
        expect(postBySlugPath("contact", "nav menu")).toBe("/posts/slug/contact");
        expect(postBySlugPath("contact", "../x")).toBe("/posts/slug/contact");
        const seen = stubBackend();
        expect(await getPostBySlugPreview("contact", "PAGE")).toMatchObject({ id: 2 });
        expect(seen).toEqual(["contact"]);
    });

    it("the slug itself is encoded, so it cannot add a query of its own", () => {
        expect(postBySlugPath("a?type=page", "post")).toBe("/posts/slug/a%3Ftype%3Dpage?type=post");
        expect(previewHref("a?b", "page")).toBe("/preview/a%3Fb?type=page");
    });
});
