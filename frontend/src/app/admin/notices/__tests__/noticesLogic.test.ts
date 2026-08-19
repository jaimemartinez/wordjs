/**
 * /admin/notices presentation rules (audit 2026-08-18 #30).
 *
 * The screen exists because `admin_notices` had no reader at all. Its riskiest property is that the
 * only in-tree writer, the plugin CrashGuard, stores HTML in `message` — and one of the interpolated
 * values is a plugin DIRECTORY NAME off disk. The tests below pin the rule that keeps that from
 * becoming a stored-XSS sink in the most privileged screen in the product: notices render as text.
 */

import { describe, it, expect } from "vitest";
import { formatNoticeDate, noticeText, noticeTone, normalizeNotices } from "../noticesLogic";

// Verbatim from backend/src/core/plugins.ts (CrashGuard), with the slug it interpolates.
const crashMessage = (slug: string, strikes: number) =>
    `🚨 <b>Critical Error:</b> The plugin <strong>${slug}</strong> caused ${strikes} consecutive crashes during startup and has been automatically disabled for your safety. Please check the logs or contact the plugin author.`;

describe("noticeText", () => {
    it("keeps the explanation the administrator was missing, and drops the markup around it", () => {
        const out = noticeText(crashMessage("acme", 3));
        expect(out).toContain("acme");
        expect(out).toContain("Critical Error:");
        expect(out).toContain("automatically disabled");
        expect(out).not.toContain("<");
        expect(out).not.toContain(">");
    });

    it("a plugin directory named like a payload renders as words, never as markup", () => {
        // The slug is a directory name: an attacker who can drop a folder controls it verbatim.
        // A tag-shaped slug is removed with the rest of the tags — nothing executable survives, and
        // the surrounding explanation still reads.
        const out = noticeText(crashMessage('<img src=x onerror="alert(1)">', 3));
        expect(out).not.toContain("<");
        expect(out).not.toContain("onerror");
        expect(out).toContain("automatically disabled");

        // A slug that is not tag-shaped keeps its characters, as text — the words survive, the
        // angle brackets it never had cannot appear, and an entity stays inert.
        const escaped = noticeText(crashMessage("&lt;script&gt;alert(1)&lt;/script&gt;", 3));
        expect(escaped).toContain("alert(1)");
        expect(escaped).toContain("<script>"); // a TEXT node's content, decoded once and never parsed
    });

    it("does not fuse sentences when the markup was the only separator", () => {
        expect(noticeText("<p>First.</p><p>Second.</p>")).toBe("First. Second.");
        expect(noticeText("One<br>Two")).toBe("One Two");
    });

    it("decodes only the handful of entities a message may legitimately carry", () => {
        expect(noticeText("a &amp; b")).toBe("a & b");
        expect(noticeText("&lt;script&gt;")).toBe("<script>");
        // …and the decoded result is still a plain string handed to a text node, never markup.
        expect(noticeText("&#39;quoted&#39;")).toBe("'quoted'");
    });

    it("survives a message that is not a string at all", () => {
        expect(noticeText(undefined)).toBe("");
        expect(noticeText(null)).toBe("");
        expect(noticeText({ evil: true })).toBe("");
    });
});

describe("noticeTone", () => {
    it("maps the types CrashGuard writes", () => {
        expect(noticeTone("error")).toBe("danger");
        expect(noticeTone("warning")).toBe("warn");
        expect(noticeTone("info")).toBe("info");
    });

    it("an unknown or non-string type can never choose classes", () => {
        expect(noticeTone("chartreuse")).toBe("neutral");
        expect(noticeTone(undefined)).toBe("neutral");
        expect(noticeTone({})).toBe("neutral");
        expect(noticeTone("ERROR")).toBe("danger"); // case-insensitive, still from the closed map
    });
});

describe("normalizeNotices", () => {
    it("keeps CrashGuard's rows and orders them newest first", () => {
        const list = normalizeNotices([
            { id: "crash-a-1000", type: "error", message: crashMessage("a", 3), dismissible: true, timestamp: 1000 },
            { id: "crash-b-3000", type: "error", message: crashMessage("b", 3), dismissible: true, timestamp: 3000 },
        ]);
        expect(list.map((n) => n.id)).toEqual(["crash-b-3000", "crash-a-1000"]);
        expect(list[0].message).toContain("b");
    });

    it("drops rows with no usable id — they could never be dismissed anyway", () => {
        const list = normalizeNotices([
            { type: "error", message: "no id" },
            { id: "", message: "empty id" },
            { id: "ok", message: "fine" },
        ]);
        expect(list.map((n) => n.id)).toEqual(["ok"]);
    });

    it("drops duplicate ids: two rows sharing a React key is a rendering bug waiting to happen", () => {
        const list = normalizeNotices([
            { id: "same", message: "first" },
            { id: "same", message: "second" },
        ]);
        expect(list).toHaveLength(1);
        expect(list[0].message).toBe("first");
    });

    it("a malformed option never throws and never yields a non-array", () => {
        expect(normalizeNotices(null)).toEqual([]);
        expect(normalizeNotices({ not: "an array" })).toEqual([]);
        expect(normalizeNotices("nope")).toEqual([]);
        expect(normalizeNotices([null, undefined, 42, "x"])).toEqual([]);
    });

    it("treats a missing `dismissible` as dismissible — the DELETE works on every row", () => {
        expect(normalizeNotices([{ id: "a", message: "m" }])[0].dismissible).toBe(true);
        expect(normalizeNotices([{ id: "a", message: "m", dismissible: false }])[0].dismissible).toBe(false);
    });

    it("rows without a timestamp keep their stored order, at the end", () => {
        const list = normalizeNotices([
            { id: "no-ts-1", message: "m" },
            { id: "ts", message: "m", timestamp: 500 },
            { id: "no-ts-2", message: "m" },
        ]);
        expect(list.map((n) => n.id)).toEqual(["ts", "no-ts-1", "no-ts-2"]);
    });
});

describe("formatNoticeDate", () => {
    it("renders nothing rather than a fake date when the notice carries none", () => {
        expect(formatNoticeDate(null)).toBe("");
        expect(formatNoticeDate(Number.NaN as unknown as number)).toBe("");
    });

    it("renders a real timestamp", () => {
        expect(formatNoticeDate(Date.UTC(2026, 7, 18, 12, 0, 0), "en-US")).toMatch(/2026/);
    });
});
