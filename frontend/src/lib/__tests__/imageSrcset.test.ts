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
import { buildSrcSet, sizesForWidth } from "../imageSrcset";

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
