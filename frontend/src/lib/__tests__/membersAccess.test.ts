/**
 * Members-only content, the frontend half (backend core/content-access):
 *  · the editor's «Acceso» field — composed only when a provider offers levels (or the entry already
 *    has one), and saved only when the author changed it;
 *  · the HTML fallback carries the access break as `<hr class="wjs-access-break" />`, so feeds and
 *    search cut the HTML body where the Verso tree is cut;
 *  · `?redirect=` on the sign-in / sign-up pages accepts same-origin paths only (no open redirect).
 */
import { describe, it, expect } from "vitest";
import type { Post } from "@/lib/api";
import {
    ACCESS_META_KEY,
    accessField,
    accessMetaForSave,
    seedAccessRootProps,
    withRecordRootFields,
    pluginFieldKey,
    seedPluginFieldProps,
    pluginMetaForSave,
} from "@/lib/editorRootFields";
import { serializeContentFallback } from "@/lib/verso/contentFallback";
import { safeReturnPath } from "@/lib/safeReturnPath";

const LEVELS = [
    { value: "members", label: "Members" },
    { value: "paid", label: "Paid members" },
];

describe("the «Acceso» root field", () => {
    it("is composed only when a provider offers levels or the entry already requires one", () => {
        expect(ACCESS_META_KEY in withRecordRootFields({ title: { type: "text" } as any }, {})).toBe(false);
        expect(ACCESS_META_KEY in withRecordRootFields({ title: { type: "text" } as any }, { accessLevels: LEVELS })).toBe(true);
        expect(ACCESS_META_KEY in withRecordRootFields({ title: { type: "text" } as any }, { currentAccess: "tier:gold" })).toBe(true);
    });

    it("offers public first, then the levels, and keeps a stored level no provider offers", () => {
        const field: any = accessField(LEVELS, "tier:gone");
        expect(field.options.map((o: any) => o.value)).toEqual(["", "members", "paid", "tier:gone"]);
        expect(field.options[3].label).toContain("no disponible");
    });

    it("seeds from the meta (the record wins over a stale tree) and saves only a change", () => {
        expect(seedAccessRootProps({ meta: { _wjs_access: " paid " } } as unknown as Post)).toEqual({ _wjs_access: "paid" });
        expect(seedAccessRootProps({ meta: {} } as unknown as Post)).toEqual({ _wjs_access: "" });
        expect(accessMetaForSave({ _wjs_access: "paid" }, "paid")).toEqual({});
        expect(accessMetaForSave({ _wjs_access: "members" }, "paid")).toEqual({ _wjs_access: "members" });
        expect(accessMetaForSave({ _wjs_access: "" }, "paid")).toEqual({ _wjs_access: "" }); // clearing is a change
        expect(accessMetaForSave({}, "paid")).toEqual({}); // no field (no provider): the key is never sent
    });
});

describe("the HTML fallback marks the access break", () => {
    it("emits the <hr> for a block declaring contentAccessBreak, between the blocks around it", () => {
        const html = serializeContentFallback([
            { type: "Text", props: { content: "<p>free</p>" } },
            { type: "MembershipsPaywall", props: { contentAccessBreak: true } },
            { type: "Text", props: { content: "<p>members</p>" } },
        ]);
        const cut = html.indexOf('<hr class="wjs-access-break" />');
        expect(cut).toBeGreaterThan(html.indexOf("free"));
        expect(cut).toBeLessThan(html.indexOf("members"));
    });

    it("emits nothing for a plugin block that is not a break", () => {
        expect(serializeContentFallback([{ type: "SomePluginBlock", props: {} }])).toBe("");
    });
});

describe("safeReturnPath", () => {
    it("accepts same-origin paths with their query and hash", () => {
        expect(safeReturnPath("/my-post")).toBe("/my-post");
        expect(safeReturnPath("/a/b?x=1#c")).toBe("/a/b?x=1#c");
    });

    it("refuses anything a browser would read as another origin, a scheme or a control character", () => {
        for (const bad of ["//evil.example/x", "/\\evil.example", "https://evil.example/", "javascript:alert(1)", "evil", "/x\nSet-Cookie", "", undefined, 42, "/a\\b"]) {
            expect(safeReturnPath(bad as any), String(bad)).toBeNull();
        }
    });
});

describe("plugin editor fields (backend core/editor-fields)", () => {
    const FIELDS = [{ metaKey: "newsletter_audience", label: "Send", type: "select" as const, options: [{ value: "", label: "No" }, { value: "all", label: "All" }] }];

    it("are composed as root fields under their own prefix", () => {
        const out: any = withRecordRootFields({ title: { type: "text" } as any }, { pluginFields: FIELDS });
        expect(out[pluginFieldKey("newsletter_audience")]).toMatchObject({ type: "select", label: "Send" });
        expect(out.newsletter_audience).toBeUndefined();
    });

    it("seed from the entry's meta and save only what the author changed", () => {
        const seeded = seedPluginFieldProps({ meta: { newsletter_audience: "all" } } as unknown as Post, FIELDS);
        expect(seeded).toEqual({ wjs_meta__newsletter_audience: "all" });
        expect(pluginMetaForSave({ wjs_meta__newsletter_audience: "all" }, FIELDS, seeded)).toEqual({});
        expect(pluginMetaForSave({ wjs_meta__newsletter_audience: "" }, FIELDS, seeded)).toEqual({ newsletter_audience: "" });
        expect(pluginMetaForSave({}, FIELDS, seeded)).toEqual({});
    });
});
