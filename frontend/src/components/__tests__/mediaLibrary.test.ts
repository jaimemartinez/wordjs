/**
 * Media library — paging, server-side search and the metadata diff.
 *
 * The regressions pinned here are all silent ones:
 *  - both media screens fetched `/media` with NO query string, got the endpoint's default first 20
 *    rows and filtered THAT array client-side, so a 500-file library showed 20 and the search box
 *    could never find anything past them;
 *  - a page number outlives its result set (delete the last row of the last page, or narrow the
 *    search) and the grid then renders empty against a perfectly correct server response;
 *  - `PUT /media/:id` keys off `!== undefined`, so posting back untouched fields is an overwrite of
 *    metadata this editor never looked at.
 *
 * Node environment (see vitest.config.mts) — the helpers are pure, and the one wire test swaps
 * `fetch` rather than rendering anything.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
    MAX_PER_PAGE,
    LIBRARY_PAGE_SIZE,
    SELECTOR_PAGE_SIZE,
    buildMediaQuery,
    clampPage,
    pageRange,
    mediaMetaOf,
    mediaMetaPayload,
    hasMediaMetaChanges,
    mediaThumbnailUrl,
    type EditableMediaItem,
} from "../MediaLibrarySelector";
import { mediaApi, type MediaItem } from "@/lib/api";

describe("buildMediaQuery", () => {
    it("always sends page and per_page — the endpoint pages whether or not you ask it to", () => {
        expect(buildMediaQuery({ page: 3, perPage: 24 })).toEqual({ page: 3, perPage: 24 });
    });

    it("omits a blank or whitespace-only search instead of sending an empty param", () => {
        expect(buildMediaQuery({ page: 1, perPage: 20, search: "" })).toEqual({ page: 1, perPage: 20 });
        expect(buildMediaQuery({ page: 1, perPage: 20, search: "   " })).toEqual({ page: 1, perPage: 20 });
    });

    it("trims the search term (the debounced input carries the user's trailing space)", () => {
        expect(buildMediaQuery({ page: 1, perPage: 20, search: "  logo " }).search).toBe("logo");
    });

    it("passes mimeType through when given", () => {
        expect(buildMediaQuery({ page: 1, perPage: 20, mimeType: "image/" }).mimeType).toBe("image/");
    });

    it("clamps per_page to the server's own cap, so the page maths agree with the server's totals", () => {
        expect(buildMediaQuery({ page: 1, perPage: 500 }).perPage).toBe(MAX_PER_PAGE);
    });

    it("never emits a zero, negative or NaN page/per_page", () => {
        expect(buildMediaQuery({ page: 0, perPage: 0 })).toEqual({ page: 1, perPage: 20 });
        expect(buildMediaQuery({ page: -4, perPage: -1 })).toEqual({ page: 1, perPage: 20 });
        expect(buildMediaQuery({ page: NaN, perPage: NaN })).toEqual({ page: 1, perPage: 20 });
        expect(buildMediaQuery({ page: 2.7, perPage: 24.9 })).toEqual({ page: 2, perPage: 24 });
    });

    it("keeps both screens' page sizes inside the cap", () => {
        expect(LIBRARY_PAGE_SIZE).toBeLessThanOrEqual(MAX_PER_PAGE);
        expect(SELECTOR_PAGE_SIZE).toBeLessThanOrEqual(MAX_PER_PAGE);
    });
});

describe("clampPage", () => {
    it("steps back when the page outlives the result set", () => {
        expect(clampPage(5, 2)).toBe(2);
        expect(clampPage(2, 1)).toBe(1);
    });

    it("leaves a valid page alone", () => {
        expect(clampPage(1, 1)).toBe(1);
        expect(clampPage(3, 7)).toBe(3);
    });

    it("floors at page 1 even when the library is empty (totalPages 0)", () => {
        expect(clampPage(1, 0)).toBe(1);
        expect(clampPage(0, 0)).toBe(1);
        expect(clampPage(-2, 3)).toBe(1);
    });
});

describe("pageRange", () => {
    it("describes the rows actually on screen", () => {
        expect(pageRange(1, 24, 137)).toEqual({ from: 1, to: 24, total: 137 });
        expect(pageRange(2, 24, 137)).toEqual({ from: 25, to: 48, total: 137 });
    });

    it("does not advertise more rows than exist on the last page", () => {
        expect(pageRange(6, 24, 137)).toEqual({ from: 121, to: 137, total: 137 });
    });

    it("reads 0 of 0 for an empty library (and for a search with no hits)", () => {
        expect(pageRange(1, 24, 0)).toEqual({ from: 0, to: 0, total: 0 });
    });

    it("does not run past the end when the page number is stale", () => {
        expect(pageRange(99, 24, 5)).toEqual({ from: 5, to: 5, total: 5 });
    });
});

const item = (over: Partial<EditableMediaItem> = {}): EditableMediaItem => ({
    id: 7,
    title: "Foto",
    guid: "https://192.168.1.11:3000/uploads/2026/08/foto.jpg",
    sourceUrl: "/uploads/2026/08/foto.jpg",
    mimeType: "image/jpeg",
    date: "2026-08-18T10:00:00.000Z",
    ...over,
});

describe("media metadata editing", () => {
    it("reads every editable field as a defined string, so the inputs stay controlled", () => {
        expect(mediaMetaOf(item())).toEqual({ title: "Foto", description: "", caption: "", alt: "" });
        expect(mediaMetaOf(item({ alt: "Un gato", caption: "pie", description: "larga" })))
            .toEqual({ title: "Foto", description: "larga", caption: "pie", alt: "Un gato" });
    });

    it("sends ONLY the fields the user changed", () => {
        const original = mediaMetaOf(item({ alt: "", caption: "pie" }));
        const draft = { ...original, alt: "Un gato dormido" };
        expect(mediaMetaPayload(original, draft)).toEqual({ alt: "Un gato dormido" });
    });

    it("sends an empty payload when nothing changed — no request should fire", () => {
        const original = mediaMetaOf(item({ alt: "Un gato" }));
        expect(mediaMetaPayload(original, { ...original })).toEqual({});
        expect(hasMediaMetaChanges(original, { ...original })).toBe(false);
    });

    it("treats CLEARING a field as a change (an alt text can legitimately be emptied)", () => {
        const original = mediaMetaOf(item({ alt: "Un gato" }));
        const draft = { ...original, alt: "" };
        expect(mediaMetaPayload(original, draft)).toEqual({ alt: "" });
        expect(hasMediaMetaChanges(original, draft)).toBe(true);
    });

    it("carries several edits at once", () => {
        const original = mediaMetaOf(item());
        const draft = { title: "Gato", description: "d", caption: "c", alt: "a" };
        expect(mediaMetaPayload(original, draft)).toEqual({ title: "Gato", description: "d", caption: "c", alt: "a" });
    });
});

describe("mediaThumbnailUrl", () => {
    it("uses the RELATIVE sourceUrl, never the guid (guid embeds the upload-time host/IP)", () => {
        expect(mediaThumbnailUrl(item())).toBe("/uploads/2026/08/foto.jpg");
    });

    it("swaps in the generated thumbnail file when the attachment has one", () => {
        const withThumb = item({
            mediaDetails: {
                width: 1200, height: 800, file: "2026/08/foto.jpg", filesize: 1,
                sizes: { thumbnail: { file: "foto-150x150.jpg", width: 150, height: 150, mimeType: "image/jpeg", filesize: 1 } },
            },
        });
        expect(mediaThumbnailUrl(withThumb)).toBe("/uploads/2026/08/foto-150x150.jpg");
    });

    it("falls back to guid when sourceUrl is missing rather than rendering a blank tile", () => {
        expect(mediaThumbnailUrl(item({ sourceUrl: "" }) as MediaItem)).toBe(item().guid);
    });
});

// The wire: what the screens' query state actually becomes on the URL the backend router reads.
describe("the request the screens send", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    it("asks for the requested page and search, and reads the server's totals", async () => {
        let seen = "";
        globalThis.fetch = (async (url: string) => {
            seen = String(url);
            return {
                ok: true,
                json: async () => [],
                headers: { get: (h: string) => (h === "X-WP-Total" ? "137" : h === "X-WP-TotalPages" ? "6" : null) },
            };
        }) as unknown as typeof fetch;

        const res = await mediaApi.listPaged(buildMediaQuery({ page: 2, perPage: LIBRARY_PAGE_SIZE, search: " logo " }));

        expect(seen).toContain("/media?");
        expect(seen).toContain("page=2");
        expect(seen).toContain(`per_page=${LIBRARY_PAGE_SIZE}`);
        expect(seen).toContain("search=logo");
        expect(res.total).toBe(137);
        expect(res.totalPages).toBe(6);
    });
});
