/**
 * Follow-up of the three-mode QA pass: the pure pieces behind bulk user actions, the account
 * self-service, the reading/permalink settings, menus and image editing.
 */
import { describe, it, expect } from "vitest";
import { runEach } from "@/lib/bulkRun";
import { isPostsPage, postsPageHref, postsPageId } from "@/lib/public/postsPage";
import { formatSiteDate, siteDateFormats } from "@/lib/public/siteDate";
import { flattenMenu, indent, moveWithinSiblings, outdent, parentCandidates } from "@/lib/menuTree";
import { commentThread } from "@/lib/commentThread";
import { mediaTypeIcon } from "@/lib/mediaUsage";
import { listAllEntries } from "@/lib/motionLibrary";
import { paletteRowOrder } from "@/components/verso/editor/paletteActions";
import { canEditImage, cropForAspect, dragCrop, editRequest, FULL_CROP, resultSize, turn } from "@/lib/imageEdit";

describe("bulk actions run one write per row and report what failed", () => {
    it("keeps going past a failure and names the first reason", async () => {
        const seen: number[] = [];
        const result = await runEach([1, 2, 3], async (id) => {
            seen.push(id);
            if (id === 2) throw new Error("You cannot delete yourself.");
        });
        expect(seen).toEqual([1, 2, 3]);
        expect(result.done).toEqual([1, 3]);
        expect(result.failed).toEqual([{ id: 2, reason: "You cannot delete yourself." }]);
    });

    it("an empty selection does nothing", async () => {
        expect(await runEach([], async () => { throw new Error("never"); })).toEqual({ done: [], failed: [] });
    });
});

describe("the posts page (Settings → Reading)", () => {
    it("applies only with a static front page, and never to the front page itself", () => {
        expect(postsPageId({ homepage_id: "5", page_for_posts: "9" })).toBe("9");
        expect(postsPageId({ homepage_id: "", page_for_posts: "9" })).toBe("");
        expect(postsPageId({ homepage_id: "9", page_for_posts: "9" })).toBe("");
        expect(postsPageId({ homepage_id: 5, page_for_posts: 9 })).toBe("9");
        expect(isPostsPage({ id: 9 }, { homepage_id: "5", page_for_posts: "9" })).toBe(true);
        expect(isPostsPage({ id: 8 }, { homepage_id: "5", page_for_posts: "9" })).toBe(false);
    });
    it("pages at /<slug>/page/<n>", () => {
        expect(postsPageHref("blog", 1)).toBe("/blog");
        expect(postsPageHref("blog", 3)).toBe("/blog/page/3");
    });
});

describe("date and time formats (Settings → General)", () => {
    it("an explicit format is rendered token by token, in the site language", () => {
        expect(formatSiteDate("2026-10-21 17:05:00", "en", { format: "Y-m-d" })).toBe("2026-10-21");
        expect(formatSiteDate("2026-10-21 17:05:00", "en", { format: "d/m/Y" })).toBe("21/10/2026");
        expect(formatSiteDate("2026-10-21 17:05:00", "en", { format: "M j, Y" })).toBe("Oct 21, 2026");
        expect(formatSiteDate("2026-10-21 17:05:00", "es", { format: "j F Y" })).toBe("21 octubre 2026");
    });
    it("no format keeps the language's own long date", () => {
        expect(formatSiteDate("2026-10-21 17:05:00", "en")).toBe("October 21, 2026");
    });
    it("a time format adds the time, in the site's zone when the UTC moment is known", () => {
        expect(formatSiteDate("2026-10-21 17:05:00", "en", { format: "Y-m-d", timeFormat: "H:i" })).toBe("2026-10-21 17:05");
        expect(formatSiteDate("2026-10-21 17:05:00", "en", { format: "Y-m-d", timeFormat: "g:i a" })).toBe("2026-10-21 5:05 pm");
        expect(formatSiteDate("2026-10-21 17:05:00", "en", { gmt: "2026-10-21 15:05:00", timeZone: "Europe/Madrid", format: "Y-m-d", timeFormat: "H:i" })).toBe("2026-10-21 17:05");
    });
    it("reads the choice from the settings", () => {
        expect(siteDateFormats({ date_format: "Y-m-d", time_format: "" })).toEqual({ format: "Y-m-d" });
        expect(siteDateFormats(null)).toEqual({});
    });
});

describe("menu tree (submenus in the menu editor)", () => {
    const items = [
        { id: 1, order: 0, parent: 0 },
        { id: 2, order: 1, parent: 0 },
        { id: 3, order: 0, parent: 2 },
        { id: 4, order: 2, parent: 0 },
    ];

    it("lists parents before children, with depth", () => {
        expect(flattenMenu(items).map(({ item, depth }) => `${item.id}@${depth}`)).toEqual(["1@0", "2@0", "3@1", "4@0"]);
    });

    it("moves among siblings only", () => {
        expect(moveWithinSiblings(items, items[3], "up")).toEqual([{ id: 1, order: 0 }, { id: 4, order: 1 }, { id: 2, order: 2 }]);
        expect(moveWithinSiblings(items, items[2], "up")).toEqual([], );
    });

    it("indents under the previous sibling and outdents right after the parent", () => {
        expect(indent(items, items[1])).toEqual([{ id: 2, parent: 1, order: 0 }]);
        expect(indent(items, items[0])).toEqual([]);
        expect(outdent(items, items[2])).toEqual([{ id: 1, order: 0 }, { id: 2, order: 1 }, { id: 3, parent: 0, order: 2 }, { id: 4, order: 3 }]);
        expect(outdent(items, items[0])).toEqual([]);
    });

    it("never offers an item or its descendants as its parent", () => {
        expect(parentCandidates(items, items[1]).map((i) => i.id)).toEqual([1, 4]);
    });
});

describe("public comments as threads", () => {
    it("puts each reply under the comment it answers, with its depth", () => {
        const rows = commentThread([
            { id: 1 }, { id: 2 }, { id: 3, parent: 1 }, { id: 4, parent: 3 }, { id: 5, parent: 2 },
        ]);
        expect(rows.map((r) => [r.comment.id, r.depth])).toEqual([[1, 0], [3, 1], [4, 2], [2, 0], [5, 1]]);
    });
    it("shows a reply whose parent is not listed at the top level instead of dropping it", () => {
        const rows = commentThread([{ id: 7, parent: 99 }, { id: 8, parent: 8 }]);
        expect(rows.map((r) => [r.comment.id, r.depth])).toEqual([[7, 0], [8, 0]]);
    });
});

describe("media library icons for files that are not images", () => {
    it("picks the icon by type", () => {
        expect(mediaTypeIcon("video/mp4")).toBe("fa-file-video");
        expect(mediaTypeIcon("audio/mpeg")).toBe("fa-file-audio");
        expect(mediaTypeIcon("application/pdf")).toBe("fa-file-pdf");
        expect(mediaTypeIcon("application/zip")).toBe("fa-file-zipper");
        expect(mediaTypeIcon(null)).toBe("fa-file");
    });
});

describe("the motion usage scan reads every page", () => {
    it("keeps asking until the last page", async () => {
        const asked: number[] = [];
        const all = await listAllEntries(async (page) => { asked.push(page); return { data: [page * 10, page * 10 + 1], totalPages: 3 }; });
        expect(asked).toEqual([1, 2, 3]);
        expect(all).toHaveLength(6);
    });
    it("stops at the page cap", async () => {
        const all = await listAllEntries(async (page) => ({ data: [page], totalPages: 50 }), 4);
        expect(all).toEqual([1, 2, 3, 4]);
    });
});

describe("Ctrl+K: Enter runs a block once the author types", () => {
    it("lists actions first only while nothing is typed", () => {
        expect(paletteRowOrder("", 3, 5)).toEqual({ actionsFirst: true, actionOffset: 0, blockOffset: 3 });
        expect(paletteRowOrder("p", 1, 5)).toEqual({ actionsFirst: false, actionOffset: 5, blockOffset: 0 });
    });
});

describe("image editor arithmetic (media library)", () => {
    const base = { rotate: 0 as const, flipH: false, flipV: false, crop: FULL_CROP, width: null };
    it("only JPEG, PNG and WebP on this server can be edited", () => {
        expect(canEditImage("image/jpeg")).toBe(true);
        expect(canEditImage("image/gif")).toBe(false);
        expect(canEditImage("image/svg+xml")).toBe(false);
        expect(canEditImage("image/png", "s3")).toBe(false);
    });
    it("turns wrap around", () => {
        expect(turn(0, -90)).toBe(270);
        expect(turn(270, 90)).toBe(0);
    });
    it("a ratio crop is the largest centred box", () => {
        const c = cropForAspect(1, 400, 200);
        expect(c.width).toBeCloseTo(0.5);
        expect(c.x).toBeCloseTo(0.25);
        expect(c.height).toBe(1);
        expect(cropForAspect(null, 400, 200)).toEqual(FULL_CROP);
    });
    it("the result size follows the turn, the crop and the scale", () => {
        expect(resultSize(400, 200, { ...base, rotate: 90 })).toEqual({ width: 200, height: 400 });
        expect(resultSize(400, 200, { ...base, rotate: 90, crop: { x: 0, y: 0, width: 1, height: 0.5 }, width: 100 })).toEqual({ width: 100, height: 100 });
        expect(resultSize(400, 200, { ...base, width: 1000 })).toEqual({ width: 400, height: 200 }); // never enlarges
    });
    it("asks the server only for what changed", () => {
        expect(editRequest(400, 200, base)).toBeNull();
        expect(editRequest(400, 200, { ...base, width: 1000 })).toBeNull();
        expect(editRequest(400, 200, { ...base, rotate: 90, flipH: true, width: 120 })).toEqual({ rotate: 90, flipH: true, width: 120 });
        expect(editRequest(400, 200, { ...base, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } })?.crop).toEqual({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 });
    });
    it("dragging keeps the box inside the image, and a ratio box keeps its ratio", () => {
        const moved = dragCrop({ x: 0.5, y: 0.5, width: 0.4, height: 0.4 }, "move", 0.5, 0.5, null, 100, 100);
        expect(moved.x).toBeCloseTo(0.6);
        expect(moved.y).toBeCloseTo(0.6);
        const square = dragCrop({ x: 0.25, y: 0, width: 0.5, height: 1 }, "se", -0.2, 0, 1, 400, 200);
        expect(square.width * 400).toBeCloseTo(square.height * 200);
    });
});
