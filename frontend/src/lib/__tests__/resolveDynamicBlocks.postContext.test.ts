import { describe, it, expect, vi } from "vitest";

// resolveDynamicBlocks pulls in the server-api module at import time; stub it so the module loads in a
// plain node test. applyPostContext itself is pure (no network, no React request cache), so nothing here
// calls the stubs — they only keep the import graph resolvable.
vi.mock("@/lib/server-api", () => ({
    getPosts: vi.fn(async () => []),
    getPostById: vi.fn(async () => null),
    getMenuByRef: vi.fn(async () => ({ items: [] })),
    getSettings: vi.fn(async () => ({})),
}));

import { applyPostContext, type PostContext } from "@/lib/resolveDynamicBlocks";

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
