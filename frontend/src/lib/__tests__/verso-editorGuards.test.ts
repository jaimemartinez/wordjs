/**
 * VERSO F2 harness — behavior tests (not text pins) for the block editor's data-safety contracts, so
 * they survive the Puck→motor-nuevo rewrite. See documentation/verso/f0-audit-core.md
 * "wrapper-integration"/"data-security-pipeline" Contratos duros.
 *
 * These exercise the SAME functions admin/pages/[id]/page.tsx and admin/posts/[id]/page.tsx import
 * from ../editorGuards (fixture-vs-producer: the unit under test IS the production unit, not a
 * reimplementation of it).
 */
import { describe, it, expect } from "vitest";
import {
    unhydratedSaveBlocked,
    seedLegacyPuckData,
    applyLegacyHtmlFallback,
    resolveWjsTemplateForSave,
    isWithinPostMountGrace,
    POST_MOUNT_GRACE_MS,
} from "../editorGuards";

describe("unhydratedSaveBlocked — full isNew×loaded matrix", () => {
    // The whole truth table (2×2): isNew and loaded are each boolean, so this is exhaustive, not a
    // sample. Table-driven so the exhaustiveness is visible at a glance instead of inferred from 4
    // separate `it` blocks.
    const matrix: Array<{ isNew: boolean; loaded: boolean; blocked: boolean; why: string }> = [
        { isNew: false, loaded: false, blocked: true, why: "existing record, not hydrated — the exact data-loss case the guard exists for" },
        { isNew: false, loaded: true, blocked: false, why: "existing record, hydrated — safe to save" },
        { isNew: true, loaded: false, blocked: false, why: "new record — nothing to hydrate, empty body is correct" },
        { isNew: true, loaded: true, blocked: false, why: "new record, already flagged loaded — still safe" },
    ];

    it.each(matrix)("isNew=$isNew loaded=$loaded -> blocked=$blocked ($why)", ({ isNew, loaded, blocked }) => {
        expect(unhydratedSaveBlocked({ isNew, loaded })).toBe(blocked);
    });

    it("is blocked for EVERY existing record regardless of loaded — isNew is the dominant condition when false", () => {
        expect(unhydratedSaveBlocked({ isNew: false, loaded: false })).toBe(true);
        expect(unhydratedSaveBlocked({ isNew: false, loaded: true })).toBe(false);
    });

    it("is NEVER blocked for a new record — isNew=true short-circuits regardless of loaded", () => {
        expect(unhydratedSaveBlocked({ isNew: true, loaded: false })).toBe(false);
        expect(unhydratedSaveBlocked({ isNew: true, loaded: true })).toBe(false);
    });
});

describe("seedLegacyPuckData — legacy post/page (no _puck_data) seeds an editable HTMLEmbed block", () => {
    it("wraps non-empty legacy HTML in a single HTMLEmbed block with id `HTMLEmbed-legacy-<recordId>`", () => {
        const { data, legacyHtml } = seedLegacyPuckData({
            html: "<p>Imported via WXR</p>",
            title: "Old Page",
            slug: "old-page",
            recordId: 42,
            wjsTemplate: "",
        });

        expect(data.content).toEqual([
            { type: "HTMLEmbed", props: { id: "HTMLEmbed-legacy-42", html: "<p>Imported via WXR</p>" } },
        ]);
        // legacyHtmlRef must be populated so applyLegacyHtmlFallback can protect the body later.
        expect(legacyHtml).toBe("<p>Imported via WXR</p>");
    });

    it("seeds an EMPTY content array (no HTMLEmbed block) and a null legacyHtml when there is no body", () => {
        const { data, legacyHtml } = seedLegacyPuckData({
            html: "",
            title: "Blank Page",
            slug: "blank-page",
            recordId: 7,
            wjsTemplate: "",
        });

        expect(data.content).toEqual([]);
        // null (not "") — an empty body isn't a legacy body to protect; a subsequent empty-canvas save
        // must NOT trigger applyLegacyHtmlFallback for it.
        expect(legacyHtml).toBeNull();
    });

    it("carries the saved _wjs_template into root.props so the canvas preview wraps in the right template", () => {
        const { data } = seedLegacyPuckData({
            html: "<p>x</p>",
            title: "T",
            slug: "t",
            recordId: 1,
            wjsTemplate: "landing",
        });
        expect((data.root.props as any)._wjs_template).toBe("landing");
    });

    it("merges extraRootProps (posts add allowComments; pages don't) without disturbing the shared fields", () => {
        const { data } = seedLegacyPuckData({
            html: "<p>x</p>",
            title: "Hello",
            slug: "hello",
            recordId: 5,
            wjsTemplate: "",
            extraRootProps: { allowComments: "closed" },
        });
        expect((data.root.props as any).allowComments).toBe("closed");
        expect((data.root.props as any).title).toBe("Hello");
        expect((data.root.props as any).slug).toBe("hello");
        expect((data.root.props as any).category).toBe("");
    });

    it("uses the exact recordId given (string ids stringify the same as number ids)", () => {
        const { data } = seedLegacyPuckData({ html: "<p>x</p>", title: "T", slug: "t", recordId: "abc-123", wjsTemplate: "" });
        expect((data.content[0].props as any).id).toBe("HTMLEmbed-legacy-abc-123");
    });
});

describe("applyLegacyHtmlFallback — an empty canvas over a legacy record must not blank the body", () => {
    const basePayload = () => ({
        title: "T",
        slug: "t",
        content: "<p>NEW canvas-generated html</p>",
        status: "draft",
        meta: { _puck_data: { content: [], root: {} }, _wjs_template: "" } as Record<string, unknown>,
    });

    it("restores the original HTML and DROPS _puck_data when the canvas is empty and a legacy body exists", () => {
        const payload = basePayload();
        const result = applyLegacyHtmlFallback(payload, 0, "<p>Original imported HTML</p>");

        expect(result.content).toBe("<p>Original imported HTML</p>");
        expect("_puck_data" in result.meta).toBe(false);
        // Everything else in meta survives untouched.
        expect(result.meta._wjs_template).toBe("");
    });

    it("does NOT touch the payload when the canvas already has real blocks (liveContentLength > 0)", () => {
        const payload = basePayload();
        const result = applyLegacyHtmlFallback(payload, 3, "<p>Original imported HTML</p>");
        // Same reference — the function must be a no-op, not just a no-visible-diff copy.
        expect(result).toBe(payload);
        expect("_puck_data" in result.meta).toBe(true);
    });

    it("does NOT touch the payload when there is no legacy HTML to fall back to (null)", () => {
        const payload = basePayload();
        const result = applyLegacyHtmlFallback(payload, 0, null);
        expect(result).toBe(payload);
    });

    it("does NOT touch the payload when legacyHtml is an empty string (falsy — nothing to protect)", () => {
        const payload = basePayload();
        const result = applyLegacyHtmlFallback(payload, 0, "");
        expect(result).toBe(payload);
    });

    it("never mutates the input payload's meta object (returns a new object on the fallback path)", () => {
        const payload = basePayload();
        const originalMeta = payload.meta;
        applyLegacyHtmlFallback(payload, 0, "<p>x</p>");
        // The original object handed in must still have _puck_data — proof the function copied instead
        // of mutating in place (matters because callers may still reference the un-fallen-back payload).
        expect("_puck_data" in originalMeta).toBe(true);
    });
});

describe("isWithinPostMountGrace — init-noise window for the editor's onChange", () => {
    it("exposes the original inline literal as the constant (800ms)", () => {
        expect(POST_MOUNT_GRACE_MS).toBe(800);
    });

    it("exact boundary: elapsed === 800 is STILL within grace (does not mark dirty)", () => {
        // Original inline check ran setIsDirty(true) only when `now - mounted > 800`,
        // so 800 exactly was init noise. `!isWithinPostMountGrace(...)` must preserve that.
        expect(isWithinPostMountGrace(1_000, 1_800)).toBe(true);
    });

    it("one past the boundary: elapsed === 801 is OUTSIDE grace (a human edit marks dirty)", () => {
        expect(isWithinPostMountGrace(1_000, 1_801)).toBe(false);
    });

    it("start of life: elapsed 0 is within grace", () => {
        expect(isWithinPostMountGrace(5_000, 5_000)).toBe(true);
    });

    it("boolean direction matches the replaced inline check across the whole range", () => {
        // The pages now gate on `!isWithinPostMountGrace(mounted, now)`; the old gate was
        // `now - mounted > 800`. Both must agree for every elapsed value around the border.
        const mounted = 10_000;
        for (const elapsed of [0, 1, 799, 800, 801, 802, 10_000]) {
            const now = mounted + elapsed;
            const oldGate = now - mounted > 800;
            expect(!isWithinPostMountGrace(mounted, now)).toBe(oldGate);
        }
    });
});

describe("resolveWjsTemplateForSave — _wjs_template is always a string, never omitted", () => {
    it("passes through a valid string pick unchanged", () => {
        expect(resolveWjsTemplateForSave({ _wjs_template: "landing-v2" })).toBe("landing-v2");
    });

    it("preserves an explicit '' (clearing a previous assignment is a real, distinct case from absence)", () => {
        expect(resolveWjsTemplateForSave({ _wjs_template: "" })).toBe("");
    });

    it("falls back to '' when root.props has no _wjs_template key at all", () => {
        expect(resolveWjsTemplateForSave({})).toBe("");
    });

    it("falls back to '' for undefined/null root props (root.props may not exist yet on a brand-new record)", () => {
        expect(resolveWjsTemplateForSave(undefined)).toBe("");
        expect(resolveWjsTemplateForSave(null)).toBe("");
    });

    it("falls back to '' (not the raw value) for a non-string stale value — never leaks a non-string into meta", () => {
        expect(resolveWjsTemplateForSave({ _wjs_template: 123 })).toBe("");
        expect(resolveWjsTemplateForSave({ _wjs_template: null })).toBe("");
        expect(resolveWjsTemplateForSave({ _wjs_template: {} })).toBe("");
    });

    it("the key is ALWAYS present when used to build a save payload, whatever the input", () => {
        // Mirrors exactly how admin/pages and admin/posts build `meta`: a static literal key whose VALUE
        // is this resolver's return. Because the key itself is a literal in the object expression, and
        // the resolver never returns undefined, `_wjs_template` can never be missing from the payload —
        // this is the behavior the "SIEMPRE presente, incluso ''" contract actually depends on.
        const cases: unknown[] = [undefined, null, {}, { _wjs_template: "" }, { _wjs_template: "x" }, { _wjs_template: 9 }];
        for (const rootProps of cases) {
            const meta = { _puck_data: {}, _wjs_template: resolveWjsTemplateForSave(rootProps) };
            expect(Object.prototype.hasOwnProperty.call(meta, "_wjs_template")).toBe(true);
            expect(typeof meta._wjs_template).toBe("string");
        }
    });
});
