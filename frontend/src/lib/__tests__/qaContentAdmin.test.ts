/**
 * Content and admin behaviour found by the three-mode QA pass — the pure pieces the screens are built on.
 *
 *   • commentModeration: the API's `pending/approved/spam/trash` (and the stored 0/1) map to actions, so
 *     Approve / Unapprove appear and the Spam tab has "Not spam" + "Delete permanently".
 *   • serverDate: zone-less API dates are read from their UTC twin (revision/comment times were off by
 *     the viewer's offset).
 *   • duplicateContent: the copy's editor document is retitled (opening the copy restored the original's
 *     title and slug), and categories, tags and SEO meta are carried over.
 *   • uploadQueue: every picked file is uploaded, failures are reported by name.
 *   • notificationStream: backoff that a refused stream cannot reset; refusal frames are not notifications.
 *   • optionFlags / errorText / signupRoles / symbols / editor identity seeding.
 */
import { describe, it, expect } from "vitest";
import { commentActions, commentState } from "@/lib/commentModeration";
import { parseServerDate, formatServerDateTime } from "@/lib/serverDate";
import { buildDuplicatePayload, retitleEditorDocument } from "@/lib/duplicateContent";
import { uploadSequentially } from "@/lib/uploadQueue";
import { reconnectDelay, parseNotificationFrame, openReconnectingStream, claimNotification } from "@/lib/notificationStream";
import { optionEnabled } from "@/lib/optionFlags";
import { withServerReason } from "@/lib/errorText";
import { isSignupSafeRole } from "@/lib/signupRoles";
import { symbolTypeState, symbolSlug, SYMBOL_TYPE_DEFINITION } from "@/lib/symbols";
import { seedRecordIdentity, slugFollowsTitle } from "@/lib/editorRootFields";
import { canDeleteRole } from "@/app/admin/users/roles/PluginRole";

describe("comment moderation actions", () => {
    it("REGRESSION: the API's status strings produce Approve / Unapprove", () => {
        expect(commentActions("pending")).toEqual(["approve", "spam", "trash"]);
        expect(commentActions("approved")).toEqual(["unapprove", "spam", "trash"]);
    });
    it("the stored values are understood too", () => {
        expect(commentState("0")).toBe("pending");
        expect(commentState("1")).toBe("approved");
        expect(commentState(undefined)).toBe("pending");
    });
    it("the Spam tab is no longer a dead end; the trash restores or deletes", () => {
        expect(commentActions("spam")).toEqual(["notSpam", "deletePermanently"]);
        expect(commentActions("trash")).toEqual(["restore", "deletePermanently"]);
    });
});

describe("server dates", () => {
    it("REGRESSION: a zone-less date is read from its UTC twin, not as browser-local time", () => {
        const d = parseServerDate("2026-10-21 11:45:03", "2026-10-21 06:45:03");
        expect(d?.toISOString()).toBe("2026-10-21T11:45:03.000Z");
    });
    it("an explicit zone is honoured; a missing twin falls back to the local value; junk is null", () => {
        expect(parseServerDate("2026-10-21T11:45:03+02:00")?.toISOString()).toBe("2026-10-21T09:45:03.000Z");
        expect(parseServerDate(null, "2026-10-21 11:45:03")).toBeInstanceOf(Date);
        expect(parseServerDate("0000-00-00 00:00:00", null)).toBeNull();
        expect(formatServerDateTime(null, null, "—")).toBe("—");
    });
});

describe("duplicate", () => {
    const original: any = {
        id: 13, title: "Ciclo", content: "<p>x</p>", excerpt: "e", type: "post",
        categories: [{ id: 4, name: "News", slug: "news" }], tags: [{ id: 9, name: "t", slug: "t" }],
        meta: {
            _puck_data: { content: [{ type: "Text" }], root: { title: "Ciclo", slug: "ciclo", props: { title: "Ciclo", slug: "ciclo", seo_title: "S" } } },
            seo_title: "SEO title", _thumbnail_id: "77", _wjs_template: "wide", _edit_lock: "1:2", _wjs_review_comments: "[]",
        },
    };
    it("REGRESSION: the copy's editor document names the copy and carries no slug", () => {
        const p = buildDuplicatePayload(original);
        expect(p.title).toBe("Ciclo (copy)");
        const doc: any = p.meta!._puck_data;
        expect(doc.root.title).toBe("Ciclo (copy)");
        expect(doc.root.props.title).toBe("Ciclo (copy)");
        expect(doc.root.slug).toBeUndefined();
        expect(doc.root.props.slug).toBeUndefined();
        expect(doc.root.props.seo_title).toBe("S");
    });
    it("REGRESSION: categories, tags and SEO/template/thumbnail meta come along; server bookkeeping does not", () => {
        const p = buildDuplicatePayload(original);
        expect(p.categories).toEqual([4]);
        expect(p.tags).toEqual([9]);
        expect(p.meta).toMatchObject({ seo_title: "SEO title", _thumbnail_id: "77", _wjs_template: "wide" });
        expect(p.meta).not.toHaveProperty("_edit_lock");
        expect(p.meta).not.toHaveProperty("_wjs_review_comments");
        expect(p.status).toBe("draft");
    });
    it("a stored JSON string document is retitled and stays a string", () => {
        const out = retitleEditorDocument(JSON.stringify({ root: { props: { title: "a" } } }), "b");
        expect(typeof out).toBe("string");
        expect(JSON.parse(out as string).root.props.title).toBe("b");
        expect(retitleEditorDocument("not json", "b")).toBe("not json");
    });
});

describe("upload queue", () => {
    const file = (name: string) => ({ name } as File);
    it("REGRESSION: every file is uploaded, in order, and failures are reported by name", async () => {
        const seen: string[] = [];
        const progress: Array<[number, number]> = [];
        const res = await uploadSequentially([file("a.png"), file("b.png"), file("c.png")], async (f, onPercent) => {
            seen.push(f.name);
            onPercent(100);
            if (f.name === "b.png") throw new Error("File too large");
        }, (p) => progress.push([p.index, p.total]));
        expect(seen).toEqual(["a.png", "b.png", "c.png"]);
        expect(res.uploaded).toBe(2);
        expect(res.failed).toEqual([{ name: "b.png", message: "File too large" }]);
        expect(progress.some(([i, n]) => i === 3 && n === 3)).toBe(true);
    });
    it("nothing picked is nothing done", async () => {
        expect(await uploadSequentially(null, async () => {})).toEqual({ uploaded: 0, failed: [] });
    });
});

describe("notification stream", () => {
    it("backs off 1 s doubling to a 60 s ceiling", () => {
        expect([0, 1, 2, 5, 6, 20].map(reconnectDelay)).toEqual([1000, 2000, 4000, 32000, 60000, 60000]);
    });
    it("keepalives and refusal frames are not notifications", () => {
        expect(parseNotificationFrame(": keepalive")).toBeNull();
        expect(parseNotificationFrame('{"error":"too_many_streams"}')).toBeNull();
        expect(parseNotificationFrame("not json")).toBeNull();
        expect(parseNotificationFrame('{"uuid":"u1","title":"Hi"}')).toEqual({ uuid: "u1", title: "Hi" });
    });
    it("claims a notification once per tab", () => {
        expect(claimNotification("x-1")).toBe(true);
        expect(claimNotification("x-1")).toBe(false);
    });

    /** A fake EventSource the test drives by hand. */
    function harness() {
        const instances: any[] = [];
        class FakeES {
            onopen: any; onmessage: any; onerror: any; closed = false; listeners: Record<string, any[]> = {};
            constructor(public url: string) { instances.push(this); }
            addEventListener(type: string, fn: any) { (this.listeners[type] ||= []).push(fn); }
            close() { this.closed = true; }
        }
        let now = 0;
        const timers: Array<{ fn: () => void; ms: number }> = [];
        const got: any[] = [];
        const stop = openReconnectingStream({
            url: "/s", EventSourceImpl: FakeES as any, onNotification: (n) => got.push(n),
            now: () => now, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
        });
        return { instances, timers, got, stop, advance: (ms: number) => { now += ms; } };
    }

    it("REGRESSION: a stream that opens and is immediately refused keeps backing off (onopen no longer resets it)", () => {
        const h = harness();
        for (let i = 0; i < 4; i++) {
            const es = h.instances[h.instances.length - 1];
            es.onopen();
            for (const fn of es.listeners.error || []) fn({ data: '{"error":"too_many_streams"}' });
            es.onerror();
            h.timers[h.timers.length - 1].fn();
        }
        expect(h.timers.map((t) => t.ms)).toEqual([1000, 2000, 4000, 8000]);
    });
    it("a connection that stayed up starts over at 1 s; a delivered notification resets too", () => {
        const h = harness();
        let es = h.instances[0];
        es.onerror(); h.timers[0].fn(); // 1 s
        es = h.instances[1];
        es.onopen(); h.advance(31_000); es.onerror();
        expect(h.timers[1].ms).toBe(1000);
        h.timers[1].fn();
        es = h.instances[2];
        es.onmessage({ data: '{"uuid":"n"}' });
        expect(h.got).toEqual([{ uuid: "n" }]);
        h.stop();
        expect(es.closed).toBe(true);
    });
});

describe("small helpers", () => {
    it("optionEnabled reads stored numbers and strings alike", () => {
        expect(optionEnabled(0, true)).toBe(false);
        expect(optionEnabled("0", true)).toBe(false);
        expect(optionEnabled(1, false)).toBe(true);
        expect(optionEnabled(undefined, true)).toBe(true);
        expect(optionEnabled("maybe", false)).toBe(false);
    });
    it("withServerReason shows the server's sentence, not transport noise", () => {
        expect(withServerReason("Failed to save", new Error("Password must be at least 8 characters."))).toBe("Failed to save\n\nPassword must be at least 8 characters.");
        expect(withServerReason("Failed to save", new Error("HTTP 500"))).toBe("Failed to save");
        expect(withServerReason("Failed to save", null)).toBe("Failed to save");
    });
    it("signup roles exclude anything that runs the site", () => {
        expect(isSignupSafeRole("administrator", { capabilities: [] })).toBe(false);
        expect(isSignupSafeRole("editor", { capabilities: ["edit_others_posts"] })).toBe(false);
        expect(isSignupSafeRole("custom", { capabilities: ["*"] })).toBe(false);
        expect(isSignupSafeRole("subscriber", { capabilities: ["read"] })).toBe(true);
        expect(isSignupSafeRole("author", { capabilities: ["read", "edit_posts", "publish_posts"] })).toBe(true);
    });
    it("REGRESSION: symbols register as a REST-exposed type, and an internal registration is detected", () => {
        expect(SYMBOL_TYPE_DEFINITION.showInRest).toBe(true);
        expect(SYMBOL_TYPE_DEFINITION.showInMenu).toBe(false);
        expect(symbolTypeState(null)).toBe("missing");
        expect(symbolTypeState({ showInRest: false })).toBe("internal");
        expect(symbolTypeState({ showInRest: true })).toBe("ready");
        expect(symbolSlug(0, 0)).toBe("wjs-symbol-000");
    });
    it("REGRESSION: the editor seeds the record's own title and slug; a published entry keeps its URL", () => {
        expect(seedRecordIdentity({ title: "Copy", slug: "copy" } as any)).toEqual({ title: "Copy", slug: "copy" });
        expect(slugFollowsTitle({ slug: "x", status: "publish" } as any)).toBe(false);
        expect(slugFollowsTitle({ slug: "x", status: "draft" } as any)).toBe(true);
        expect(slugFollowsTitle({ slug: "", status: "publish" } as any)).toBe(true);
    });
    it("core roles offer no delete button", () => {
        expect(canDeleteRole({ name: "Administrator", capabilities: ["*"] } as any, "administrator")).toBe(false);
        expect(canDeleteRole({ name: "Mine", capabilities: [] } as any, "mine")).toBe(true);
    });
});


describe("record seed over the collaboration room's document", () => {
    it("REGRESSION: keys the room lacks (slug, category) come back from the record; room values win", async () => {
        const { withRecordSeed } = await import("@/lib/verso/recordSeed");
        const room: any = { content: [{ type: "Text", props: { id: "t" } }], root: { title: "Copy", props: { title: "Copy", excerpt: "from room" } } };
        const seed: any = { title: "Ignored", slug: "copy", props: { title: "Ignored", slug: "copy", category: "4", excerpt: "from record" } };
        const out: any = withRecordSeed(room, seed);
        expect(out.root.props).toEqual({ title: "Copy", excerpt: "from room", slug: "copy", category: "4" });
        expect(out.root.title).toBe("Copy");
        expect(out.root.slug).toBe("copy");
        expect(out.content).toBe(room.content);
        expect(withRecordSeed(out, seed)).toBe(out);
        expect(withRecordSeed(room, undefined)).toBe(room);
    });
});

describe("SEO dates", () => {
    it("REGRESSION: OpenGraph/JSON-LD dates are ISO 8601 instants from the UTC twin", async () => {
        const { isoPostDate } = await import("@/lib/server-api");
        expect(isoPostDate("2026-10-21 11:45:00", "2026-10-21 06:45:00")).toBe("2026-10-21T11:45:00.000Z");
        expect(isoPostDate(undefined, "2026-10-21T06:45:00-05:00")).toBe("2026-10-21T11:45:00.000Z");
        expect(isoPostDate("0000-00-00 00:00:00", "")).toBeUndefined();
        expect(isoPostDate(null, null)).toBeUndefined();
    });
});
