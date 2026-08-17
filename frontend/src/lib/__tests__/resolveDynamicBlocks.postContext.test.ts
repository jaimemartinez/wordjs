import { describe, it, expect, vi } from "vitest";

// resolveDynamicBlocks pulls in the server-api module at import time; stub it so the module loads in a
// plain node test. applyPostContext itself is pure (no network, no React request cache), so nothing in
// the first suite calls the stubs — the isFront suite below drives getSettings explicitly.
const getSettings = vi.fn(async (): Promise<Record<string, unknown>> => ({}));
vi.mock("@/lib/server-api", () => ({
    getPosts: vi.fn(async () => []),
    getPostById: vi.fn(async () => null),
    getMenuByRef: vi.fn(async () => ({ items: [] })),
    getSettings: (...args: unknown[]) => getSettings(...(args as [])),
}));

import { applyPostContext, withResolvedBlocks, type PostContext } from "@/lib/resolveDynamicBlocks";
import type { Post } from "@/lib/api";

// A tree with a Breadcrumbs nested inside a Section slot — the walker must reach it.
const tree = () => ({
    content: [
        { type: "Section", props: { content: [{ type: "Breadcrumbs", props: {} }, { type: "LangSwitcher", props: {} }] } },
    ],
});

const ctxA: PostContext = { trail: [{ label: "A" }], isFront: false, translations: { language: "es", currentHref: "/a", items: [] } };
const ctxB: PostContext = { trail: [{ label: "B" }], isFront: true, translations: { language: "en", currentHref: "/b", items: [{ language: "es", href: "/b-es" }] } };

describe("applyPostContext — the cross-post cache guard", () => {
    it("injects DIFFERENT trails for DIFFERENT contexts into an identical tree, and never mutates the input", () => {
        // resolveDynamicBlocks is cache()d on `data`, so two pages with byte-identical _puck_data share
        // ONE resolved tree. If the per-post trail were injected into that shared tree, page B would show
        // page A's breadcrumb. This proves the per-post pass keeps them separate and leaves the shared
        // input untouched.
        const shared = tree();
        const outA = applyPostContext(shared as any, ctxA) as any;
        const outB = applyPostContext(shared as any, ctxB) as any;

        const bcA = outA.content[0].props.content[0].props;
        const bcB = outB.content[0].props.content[0].props;
        expect(bcA.resolvedTrail).toEqual([{ label: "A" }]);
        expect(bcB.resolvedTrail).toEqual([{ label: "B" }]);
        expect(bcA.resolvedTrail).not.toBe(bcB.resolvedTrail);

        // LangSwitcher gets its own per-post translations too.
        expect(outA.content[0].props.content[1].props.resolvedTranslations.currentHref).toBe("/a");
        expect(outB.content[0].props.content[1].props.resolvedTranslations.items).toHaveLength(1);

        // The shared input tree is pristine — no resolved* leaked onto it.
        expect((shared as any).content[0].props.content[0].props).not.toHaveProperty("resolvedTrail");
        expect(outA).not.toBe(shared);
        expect(outB).not.toBe(outA);
    });

    it("returns a plain (non-injected) copy shape when the tree has no per-post block", () => {
        const plain = { content: [{ type: "Heading", props: { title: "Hi" } }] };
        const out = applyPostContext(plain as any, ctxA) as any;
        expect(out.content[0].props).not.toHaveProperty("resolvedTrail");
    });
});

/**
 * isFront — the front-page flag Breadcrumbs' hideOnHome depends on.
 *
 * The anonymous /settings read identifies the static front page as `homepage_id`; the old
 * comparison read show_on_front/page_on_front, which are ADMIN-ONLY (GET /settings/all) and
 * vestigial — they never appear in the public payload, so resolvedIsFront was false on EVERY
 * request and hideOnHome was dead code on every install. Pinned through the real seam
 * (withResolvedBlocks → buildPostContext) with the settings shape the public endpoint serves.
 */
describe("withResolvedBlocks — resolvedIsFront comes from homepage_id", () => {
    const postWithBreadcrumbs = (id: number): Post => ({
        id,
        title: "Página",
        slug: `pagina-${id}`,
        meta: { _puck_data: { content: [{ type: "Breadcrumbs", props: {} }] } },
    } as unknown as Post);

    const isFrontOf = (out: Post): unknown =>
        (out.meta!._puck_data as { content: Array<{ props: Record<string, unknown> }> }).content[0].props.resolvedIsFront;

    it("true when the rendered post IS the configured front page (homepage_id, string-typed option)", async () => {
        getSettings.mockResolvedValueOnce({ homepage_id: "12" });
        expect(isFrontOf(await withResolvedBlocks(postWithBreadcrumbs(12)))).toBe(true);
    });

    it("false for any other post", async () => {
        getSettings.mockResolvedValueOnce({ homepage_id: "12" });
        expect(isFrontOf(await withResolvedBlocks(postWithBreadcrumbs(13)))).toBe(false);
    });

    it("false when no static front page is configured (absent / 0 — the NaN/0 guard)", async () => {
        getSettings.mockResolvedValueOnce({});
        expect(isFrontOf(await withResolvedBlocks(postWithBreadcrumbs(12)))).toBe(false);
        getSettings.mockResolvedValueOnce({ homepage_id: "0" });
        expect(isFrontOf(await withResolvedBlocks(postWithBreadcrumbs(0)))).toBe(false);
    });
});
