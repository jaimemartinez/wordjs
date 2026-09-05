/**
 * srcset construction (perf F5).
 *
 * The upload pipeline now stores a modern width ladder (640/960/1280/1920) next to the classic
 * WordPress trio, so a hero on a wide screen can download a 1920px file instead of the multi-MB
 * ORIGINAL. That is only worth anything if buildSrcSet actually turns those variants into
 * candidates — and if it keeps excluding the CROPPED thumbnail, whose different aspect ratio would
 * render the image differently framed at some viewports.
 *
 * The metadata shape below is what the media route really writes (verified against a live upload:
 * width-only filenames for ladder entries, `<w>x<h>` for the trio).
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildSrcSet, sizesForWidth, srcSetBelongsTo, srcSetMaxWidth } from "../imageSrcset";
import { ImageBlock } from "@/components/content/blocks";

const META = {
    width: 3000,
    height: 1688,
    sizes: {
        thumbnail: { file: "big-150x150.jpg", width: 150, height: 150 },
        medium: { file: "big-300x300.jpg", width: 300, height: 169 },
        w640: { file: "big-640w.jpg", width: 640, height: 360 },
        w960: { file: "big-960w.jpg", width: 960, height: 540 },
        large: { file: "big-1024x1024.jpg", width: 1024, height: 576 },
        w1280: { file: "big-1280w.jpg", width: 1280, height: 720 },
        w1920: { file: "big-1920w.jpg", width: 1920, height: 1080 },
    },
};

/**
 * The SAME metadata once the upload pipeline has also written modern formats: a `sources` map keyed
 * by MIME type beside each size, and one at the root for the full-size original. Both formats reach
 * the ORIGINAL's width here — that is what makes them offerable at all (see META_CAPPED).
 */
const META_MODERN = {
    ...META,
    sources: {
        "image/webp": { file: "big.webp", width: 3000, height: 1688, mimeType: "image/webp" },
        "image/avif": { file: "big.avif", width: 3000, height: 1688, mimeType: "image/avif" },
    },
    sizes: {
        ...META.sizes,
        thumbnail: {
            ...META.sizes.thumbnail,
            sources: { "image/webp": { file: "big-150x150.webp", width: 150, height: 150 } },
        },
        w640: {
            ...META.sizes.w640,
            sources: {
                "image/webp": { file: "big-640w.webp", width: 640, height: 360 },
                "image/avif": { file: "big-640w.avif", width: 640, height: 360 },
            },
        },
        w1280: {
            ...META.sizes.w1280,
            sources: {
                "image/webp": { file: "big-1280w.webp", width: 1280, height: 720 },
                "image/avif": { file: "big-1280w.avif", width: 1280, height: 720 },
            },
        },
    },
};

/**
 * A SYNTHETIC partial map — a shape the backend can no longer produce, kept because the RENDERER's
 * drop rule still has to hold for it.
 *
 * `routes/media.ts` used to decline only the FULL-SIZE modern encode above MODERN_MAX_DECODED_BYTES
 * (~8 MP) and write the ladder regardless; it now gives up the whole format, because the full-size
 * encode gates its own ladder. So nothing writes this today — but stored `_puck_data` from before
 * that change still carries it, and the props are persisted, so the rule is what stands between a
 * saved page and a silent resolution downgrade: AVIF stopping at 1280 while the original-format
 * srcset runs to 3000. `<picture>` never reconsiders the `<img>` once it has taken a `<source>`, so
 * offering that map caps every AVIF-capable browser at 1280.
 */
const META_CAPPED = {
    ...META_MODERN,
    sources: { "image/webp": { file: "big.webp", width: 3000, height: 1688, mimeType: "image/webp" } },
};

/**
 * WHAT THE BACKEND REALLY PRODUCES FOR A BIG PHOTO NOW: the complete original-format ladder and no
 * modern derivatives anywhere. Over MODERN_MAX_DECODED_BYTES no full-size encode is attempted, and
 * since that encode gates its own format, no per-size derivative is written either.
 *
 * The `sources` key is simply ABSENT in that case — media.ts never records an empty one — which is
 * already the `META` fixture above. It is spelled `{}` here on purpose: "no derivatives" has two
 * possible spellings on the wire once other producers (an import, a plugin, hand-written metadata)
 * are in play, and the renderer must read the same answer out of both.
 */
const META_NO_MODERN = {
    ...META,
    sources: {},
    sizes: Object.fromEntries(
        Object.entries(META.sizes).map(([name, size]) => [name, { ...size, sources: {} }])
    ),
};

describe("buildSrcSet", () => {
    it("offers the whole width ladder as candidates, in ascending order", () => {
        const { srcSet } = buildSrcSet("/uploads/2026/08/big.jpg", META as any);
        expect(srcSet).toBeTruthy();
        const widths = (srcSet as string).split(",").map((c) => Number(c.trim().split(" ")[1].replace("w", "")));
        expect(widths).toEqual([...widths].sort((a, b) => a - b));
        // Without the ladder the browser had nothing between 1024 and the original.
        expect(widths).toContain(1280);
        expect(widths).toContain(1920);
    });

    it("keeps every candidate in the image's own directory, and offers the original as the largest", () => {
        const { srcSet } = buildSrcSet("/uploads/2026/08/big.jpg", META as any);
        const candidates = (srcSet as string).split(",").map((c) => c.trim());
        for (const candidate of candidates) {
            expect(candidate).toMatch(/^\/uploads\/2026\/08\/big(-\d+)?/);
        }
        // The ORIGINAL is a legitimate candidate too — a 3000px-wide viewport should be able to ask
        // for it. The point of the ladder is that narrower screens no longer have to.
        expect(candidates[candidates.length - 1]).toBe("/uploads/2026/08/big.jpg 3000w");
    });

    it("EXCLUDES the cropped thumbnail — a different aspect ratio would reframe the image", () => {
        const { srcSet } = buildSrcSet("/uploads/2026/08/big.jpg", META as any);
        expect(srcSet).not.toContain("150");
    });

    it("returns nothing when there is no size metadata (legacy content renders as before)", () => {
        expect(buildSrcSet("/uploads/x.jpg", undefined)).toEqual({});
        expect(buildSrcSet("", META as any)).toEqual({});
    });

    it("sizesForWidth describes the block's rendered width to the browser", () => {
        // The block stores width as the author typed it (a string like "640" or "640px").
        expect(typeof sizesForWidth("640")).toBe("string");
        expect(sizesForWidth("640")).toMatch(/px|vw/);
    });
});

/**
 * MODERN FORMATS (WebP/AVIF).
 *
 * Every derivative used to keep the SOURCE format, so a JPEG upload could only ever be delivered as
 * JPEG by the markup. The upload pipeline now writes a WebP (and an AVIF where sharp can encode one)
 * beside each size, recorded in a `sources` map; these assert that the map becomes per-format
 * srcsets and that the public block turns them into `<source>` elements WITHOUT disturbing the
 * `<img>` that every other browser falls back to.
 */
describe("buildSrcSet — modern formats", () => {
    it("builds one srcset per format, from the metadata only — never by rewriting an extension", () => {
        const { modern } = buildSrcSet("/uploads/2026/08/big.jpg", META_MODERN as any);
        expect(modern).toBeTruthy();
        // Each format covers the widths whose metadata declared one, plus the full-size original —
        // and nothing it did not declare: a candidate is never derived by swapping an extension.
        expect(modern!["image/webp"]).toBe(
            "/uploads/2026/08/big-640w.webp 640w, /uploads/2026/08/big-1280w.webp 1280w, /uploads/2026/08/big.webp 3000w"
        );
        expect(modern!["image/avif"]).toBe(
            "/uploads/2026/08/big-640w.avif 640w, /uploads/2026/08/big-1280w.avif 1280w, /uploads/2026/08/big.avif 3000w"
        );
    });

    it("DROPS a format whose widest derivative falls short of the original — it would cap, not fall back", () => {
        const { srcSet, modern } = buildSrcSet("/uploads/2026/08/big.jpg", META_CAPPED as any);
        // The original-format ladder still reaches the full 3000w original.
        expect(srcSetMaxWidth(srcSet)).toBe(3000);
        // WebP reaches it too, so it is still offered…
        expect(srcSetMaxWidth(modern!["image/webp"])).toBe(3000);
        // …and AVIF, which stops at 1280, is not offered AT ALL. Emitting it would mean every
        // AVIF-capable browser silently downloads a 1280px file where it used to get the original:
        // `<picture>` chooses within the first supported <source> and never looks at the <img> again.
        expect(modern!["image/avif"]).toBeUndefined();
    });

    it("offers NO format for the over-budget photo — the shape the pipeline writes today", () => {
        const { srcSet, modern, sizes } = buildSrcSet("/uploads/2026/08/big.jpg", META_NO_MODERN as any);
        // Not an empty map, not a map of empty strings: absent, so the renderer's branch never opens.
        expect(modern).toBeUndefined();
        // And the photo loses only `<picture>`, never its srcset: the original-format ladder is
        // byte-identical to the one built from metadata that has no `sources` key at all.
        expect(srcSet).toBe(buildSrcSet("/uploads/2026/08/big.jpg", META as any).srcSet);
        expect(sizes).toBe(buildSrcSet("/uploads/2026/08/big.jpg", META as any).sizes);
    });

    it("srcSetMaxWidth reads the ceiling a <source> really offers", () => {
        expect(srcSetMaxWidth("/a-640w.webp 640w, /a-1280w.webp 1280w")).toBe(1280);
        expect(srcSetMaxWidth("/a.webp 3000w")).toBe(3000);
        expect(srcSetMaxWidth(undefined)).toBe(0);
        expect(srcSetMaxWidth("/a.webp")).toBe(0); // no descriptor to compare — never a false ceiling
    });

    it("EXCLUDES the cropped thumbnail's derivative, exactly as it excludes the thumbnail itself", () => {
        const { modern } = buildSrcSet("/uploads/2026/08/big.jpg", META_MODERN as any);
        expect(modern!["image/webp"]).not.toContain("150x150");
    });

    it("leaves the original-format srcSet untouched, so nothing regresses for old browsers", () => {
        const plain = buildSrcSet("/uploads/2026/08/big.jpg", META as any);
        const withModern = buildSrcSet("/uploads/2026/08/big.jpg", META_MODERN as any);
        expect(withModern.srcSet).toBe(plain.srcSet);
        expect(plain.modern).toBeUndefined();
    });

    it("srcSetBelongsTo accepts the full-size derivative, whose name shares the stem without a dash", () => {
        // `big.webp` is a sibling of `big.jpg`, not `big-<something>` — the pre-2026 check rejected it
        // and would have cleared a perfectly valid map on the next resolveData pass.
        expect(srcSetBelongsTo("/uploads/2026/08/big.jpg", "/uploads/2026/08/big.webp 3000w")).toBe(true);
        expect(srcSetBelongsTo("/uploads/2026/08/big.jpg", "/uploads/2026/08/other.webp 3000w")).toBe(false);
    });
});

/**
 * The `<img>` an attachment with no modern derivatives has always rendered, captured verbatim from
 * the renderer as it stood BEFORE `<picture>` existed. It is written out in full on purpose: the
 * claim this batch makes about legacy content is byte-identity, and only a literal can pin that.
 */
const LEGACY_IMG_MARKUP =
    `<img src="/uploads/2026/08/big.jpg" srcSet="/uploads/2026/08/big-300x300.jpg 300w, ` +
    `/uploads/2026/08/big-640w.jpg 640w, /uploads/2026/08/big-960w.jpg 960w, ` +
    `/uploads/2026/08/big-1024x1024.jpg 1024w, /uploads/2026/08/big-1280w.jpg 1280w, ` +
    `/uploads/2026/08/big-1920w.jpg 1920w, /uploads/2026/08/big.jpg 3000w" ` +
    `sizes="(max-width: 640px) 100vw, 640px" loading="lazy" decoding="async" alt="A photo" ` +
    `style="--wjs-image-width:640px" class="wjs-block-image wp-block-image"/>`;

describe("ImageBlock — <picture> output", () => {
    const render = (props: Record<string, unknown>) =>
        renderToStaticMarkup(React.createElement(ImageBlock, props));

    it("emits <source type=…> per format, AVIF first, with the fallback <img> LAST", () => {
        const { srcSet, modern } = buildSrcSet("/uploads/2026/08/big.jpg", META_MODERN as any);
        const html = render({
            src: "/uploads/2026/08/big.jpg", alt: "A photo", width: "640",
            srcSet, srcSetModern: modern, imgWidth: 3000, imgHeight: 1688,
        });

        expect(html).toContain("<picture");
        expect(html).toContain('type="image/avif"');
        expect(html).toContain('type="image/webp"');
        // <source> order IS the selection order: a browser that supports both must be offered AVIF.
        expect(html.indexOf('type="image/avif"')).toBeLessThan(html.indexOf('type="image/webp"'));
        // The <img> is the last child — what a browser lacking both formats renders.
        expect(html.indexOf("<img")).toBeGreaterThan(html.indexOf('type="image/webp"'));
        // Each source carries `sizes`; without it a w-descriptor srcset falls back to 100vw.
        expect(html).toMatch(/<source[^>]+type="image\/avif"[^>]+sizes="/);

        // The fallback <img> is UNCHANGED: same src, alt, loading, sizes, intrinsic dimensions.
        expect(html).toContain('src="/uploads/2026/08/big.jpg"');
        expect(html).toContain('alt="A photo"');
        expect(html).toContain('loading="lazy"');
        expect(html).toContain('width="3000"');
        expect(html).toContain('height="1688"');
        expect(html).toContain(`sizes="${sizesForWidth("640")}"`);
        expect(html).toContain("big-1920w.jpg 1920w"); // the original-format srcset survives
    });

    it("never offers a format that stops short of the <img>'s widest candidate", () => {
        // The map a page SAVED BEFORE the coverage rule still carries: AVIF only up to 1280 while the
        // original-format srcset runs to 3000. buildSrcSet no longer produces it; the renderer sees it
        // anyway, out of stored page data, and must not turn it into a 1280px ceiling.
        const { srcSet, modern } = buildSrcSet("/uploads/2026/08/big.jpg", META_MODERN as any);
        const html = render({
            src: "/uploads/2026/08/big.jpg", alt: "A photo", width: "640",
            srcSet, imgWidth: 3000, imgHeight: 1688,
            srcSetModern: {
                ...modern,
                "image/avif": "/uploads/2026/08/big-640w.avif 640w, /uploads/2026/08/big-1280w.avif 1280w",
            },
        });
        expect(html).not.toContain('type="image/avif"');
        // …and the format that DOES cover the full width is still offered.
        expect(html).toContain('type="image/webp"');
        expect(html).toContain("big.webp 3000w");
    });

    it("drops the whole <picture> when no format covers the full width", () => {
        const { srcSet } = buildSrcSet("/uploads/2026/08/big.jpg", META as any);
        const html = render({
            src: "/uploads/2026/08/big.jpg", alt: "A photo", width: "640", srcSet,
            imgWidth: 3000, imgHeight: 1688,
            srcSetModern: { "image/webp": "/uploads/2026/08/big-1280w.webp 1280w" },
        });
        expect(html).not.toContain("<picture");
        expect(html.startsWith("<img")).toBe(true);
    });

    it("renders the pre-<picture> <img>, byte for byte, for a photo over the encode budget", () => {
        // The end of the chain for the case the backend now really produces: complete ladder, empty
        // `sources`. The visitor must get exactly the markup this image rendered before <picture>
        // existed — no wrapper, no <source>, no attribute moved.
        const { srcSet, modern } = buildSrcSet("/uploads/2026/08/big.jpg", META_NO_MODERN as any);
        const html = render({
            src: "/uploads/2026/08/big.jpg", alt: "A photo", width: "640", srcSet, srcSetModern: modern,
        });
        expect(html).toBe(LEGACY_IMG_MARKUP);
        expect(html).not.toContain("<picture");
    });

    it("renders the bare <img>, byte-identical, when the attachment has no modern derivatives", () => {
        const legacy = { src: "/uploads/2026/08/big.jpg", alt: "A photo", width: "640", srcSet: buildSrcSet("/uploads/2026/08/big.jpg", META as any).srcSet };
        // Pinned against the markup captured from the PRE-<picture> renderer, not against another
        // render of the same props: `{...legacy, srcSetModern: undefined}` is the same props object,
        // so comparing the two compared a render with itself and could not fail.
        expect(render(legacy)).toBe(LEGACY_IMG_MARKUP);
        expect(LEGACY_IMG_MARKUP).not.toContain("<picture");
        expect(LEGACY_IMG_MARKUP.startsWith("<img")).toBe(true);

        // And the fallback INSIDE a <picture> is that same `<img>`, byte for byte: wrapping must add
        // <source> elements and change nothing else.
        const { srcSet, modern } = buildSrcSet("/uploads/2026/08/big.jpg", META_MODERN as any);
        expect(srcSet).toBe(legacy.srcSet);
        const wrapped = render({ ...legacy, srcSetModern: modern });
        expect(wrapped).toContain("<picture");
        expect(wrapped.slice(wrapped.indexOf("<img"))).toBe(`${LEGACY_IMG_MARKUP}</picture>`);
    });
});
