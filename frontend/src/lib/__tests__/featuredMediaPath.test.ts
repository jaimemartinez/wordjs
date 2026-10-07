/**
 * `featuredMedia.path` — the relative twin of the absolute `url` (SPEC §5, model A).
 *
 * `featuredMedia.url` stays absolute on the site's MAIN address because og:image and API consumers need
 * an absolute URL. But a page opened through another accepted address (an alias, the server's LAN IP
 * from a phone) would then load every thumbnail from the main address — a host the visitor may not
 * reach at all. So the in-browser renderers (the dynamic post blocks and the editor's featured-image
 * field) prefer the relative `path` when the API sends one, and only a same-origin path is taken.
 */
import { describe, it, expect } from "vitest";
import { featuredImageUrl } from "../resolvedPost";
import { toFeaturedMediaRef } from "../editorRootFields";

const media = { id: 7, url: "https://example.com/uploads/2026/10/a.jpg", path: "/uploads/2026/10/a.jpg", title: "A" };

describe("dynamic post blocks (resolvedPost.featuredImageUrl)", () => {
    it("prefer the relative path over the absolute main-address url", () => {
        expect(featuredImageUrl({ featuredMedia: media })).toBe("/uploads/2026/10/a.jpg");
    });

    it("fall back to url when there is no path (older backends, other producers)", () => {
        expect(featuredImageUrl({ featuredMedia: { id: 7, url: media.url } })).toBe(media.url);
    });

    it("take only a same-origin path; anything else falls back to url", () => {
        for (const path of ["//evil.example/x.jpg", "/\\evil.example/x.jpg", "javascript:alert(1)", "uploads/a.jpg", "", 42]) {
            expect(featuredImageUrl({ featuredMedia: { ...media, path } }), String(path)).toBe(media.url);
        }
    });
});

describe("editor featured-image field (editorRootFields.toFeaturedMediaRef)", () => {
    it("keeps the relative path as the preview URL", () => {
        expect(toFeaturedMediaRef(media)).toEqual({ id: 7, url: "/uploads/2026/10/a.jpg", title: "A" });
    });

    it("still prefers the media picker's relative sourceUrl", () => {
        expect(toFeaturedMediaRef({ ...media, sourceUrl: "/uploads/picked.jpg" })?.url).toBe("/uploads/picked.jpg");
    });

    it("never takes a path that leaves the origin", () => {
        expect(toFeaturedMediaRef({ ...media, path: "//evil.example/x.jpg" })?.url).toBe(media.url);
        expect(toFeaturedMediaRef({ ...media, path: "/\\evil.example/x.jpg" })?.url).toBe(media.url);
        // The same rule now guards the other relative inputs: `/\host` is a different host to a browser.
        expect(toFeaturedMediaRef({ id: 7, sourceUrl: "/\\evil.example/x.jpg" })).toEqual({ id: 7 });
    });
});
