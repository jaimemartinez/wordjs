/**
 * Follow-up of the three-mode QA pass: the pure pieces behind bulk user actions, the account
 * self-service, the reading/permalink settings, menus and image editing.
 */
import { describe, it, expect } from "vitest";
import { runEach } from "@/lib/bulkRun";
import { isPostsPage, postsPageHref, postsPageId } from "@/lib/public/postsPage";
import { formatSiteDate, siteDateFormats } from "@/lib/public/siteDate";
import { flattenMenu, indent, moveWithinSiblings, outdent, parentCandidates } from "@/lib/menuTree";

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
