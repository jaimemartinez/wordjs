import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SiteAddressState } from "@/lib/siteAddress";

/**
 * /admin/settings/site-address?suggest=<url> — the change dialog a link opens, and opens ONCE.
 *
 * After an SSL or port change made the gateway serve another address, the security screen sends the
 * administrator here with `?suggest=<that address>`, and — when the backend itself reports that address
 * as the gateway's (lib/siteAddress suggestedCanonical) — the screen opens the "change the main address"
 * dialog prefilled with it. The screen re-reads its state after every write, and the parameter is still
 * in the URL when it does; if the drift is still there (the administrator chose another address, or saved
 * something else), every re-read would put the dialog they just dealt with back in front of them. A ref
 * latch (suggestionOpened) keeps that from happening, and nothing pinned it: with the latch gone every
 * existing test stayed green. This pins it on the page itself.
 *
 * Same minimal HOOK HARNESS as app/admin/plugins/__tests__/permissionsDeepLink.test.tsx (this runner
 * has no DOM): while SiteAddressPage() runs, useState/useRef/useEffect/useMemo are served from slots this
 * file owns and effects run after each call once per dependency change, the previous cleanup first, as
 * React does; the returned tree is then rendered with the REAL React, so the dialogs inside it render
 * with their real hooks. A "click" is the tree's own handler, called as React would call it.
 */

const harness = vi.hoisted(() => ({
    active: false,
    slots: [] as unknown[],
    i: 0,
    pending: [] as Array<() => unknown>,
}));

vi.mock("react", async (importOriginal) => {
    const R = await importOriginal<typeof import("react")>();
    const depsChanged = (prev: unknown[] | undefined, next: unknown[] | undefined) =>
        !prev || !next || prev.length !== next.length || prev.some((d, k) => !Object.is(d, next[k]));
    const useState = ((init: unknown) => {
        if (!harness.active) return R.useState(init);
        const i = harness.i++;
        if (!(i in harness.slots)) harness.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
        const set = (v: unknown) => {
            harness.slots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(harness.slots[i]) : v;
        };
        return [harness.slots[i], set];
    }) as typeof R.useState;
    const useRef = ((init: unknown) => {
        if (!harness.active) return R.useRef(init);
        const i = harness.i++;
        if (!(i in harness.slots)) harness.slots[i] = { current: init };
        return harness.slots[i];
    }) as typeof R.useRef;
    const useMemo = ((fn: () => unknown, deps?: unknown[]) => {
        if (!harness.active) return R.useMemo(fn, deps as React.DependencyList);
        const i = harness.i++;
        const slot = harness.slots[i] as { deps?: unknown[]; value: unknown } | undefined;
        if (!slot || depsChanged(slot.deps, deps)) harness.slots[i] = { deps, value: fn() };
        return (harness.slots[i] as { value: unknown }).value;
    }) as typeof R.useMemo;
    const useEffect = ((fn: () => unknown, deps?: unknown[]) => {
        if (!harness.active) return R.useEffect(fn as React.EffectCallback, deps as React.DependencyList);
        const i = harness.i++;
        const slot = harness.slots[i] as { deps?: unknown[]; cleanup?: unknown } | undefined;
        if (!slot || depsChanged(slot.deps, deps)) {
            const entry: { deps?: unknown[]; cleanup?: unknown } = { deps };
            harness.slots[i] = entry;
            harness.pending.push(() => {
                if (typeof slot?.cleanup === "function") (slot.cleanup as () => void)();
                entry.cleanup = fn();
            });
        }
    }) as typeof R.useEffect;
    const overrides = { useState, useRef, useMemo, useEffect };
    return { ...R, ...overrides, default: { ...R, ...overrides } };
});

/** The backend: what GET answers (`state`), how often it was asked, and the canonical writes. */
const backend = vi.hoisted(() => ({
    state: null as unknown,
    gets: 0,
    canonicalWrites: [] as Array<{ url: string; oldAddress: string }>,
}));
vi.mock("@/lib/siteAddress", async (importOriginal) => {
    const real = await importOriginal<typeof import("@/lib/siteAddress")>();
    return {
        ...real,
        siteAddressApi: {
            get: () => { backend.gets++; return Promise.resolve(backend.state); },
            putCanonical: (body: { url: string; oldAddress: string }) => {
                backend.canonicalWrites.push({ url: body.url, oldAddress: body.oldAddress });
                return Promise.resolve({ warnings: [] });
            },
            putAliases: () => Promise.reject(new Error("not under test")),
            putPolicy: () => Promise.reject(new Error("not under test")),
        },
    };
});
const SUGGESTED = "http://example.com:3000";
vi.mock("next/navigation", () => ({
    useSearchParams: () => ({ get: (k: string) => (k === "suggest" ? "http://example.com:3000" : null) }),
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { role: "administrator" }, isLoading: false }) }));
vi.mock("@/contexts/I18nContext", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
vi.mock("@/contexts/ModalContext", () => ({ useModal: () => ({ confirm: () => Promise.resolve(true) }) }));
vi.mock("@/contexts/ToastContext", () => ({ useToast: () => ({ addToast: () => {} }) }));

import { normalizeSiteAddressState } from "@/lib/siteAddress";
import SiteAddressPage from "../page";

/** The backend's state while the gateway serves SUGGESTED and the main address is `canonical`. */
const drifted = (canonical: string, rev: number): SiteAddressState => normalizeSiteAddressState({
    rev,
    canonical,
    gatewayDrift: { gateway: SUGGESTED, config: "https://example.com" },
});

/** Open while the "change the main address" dialog is — its title is the dialog's heading. */
const CHANGE_DIALOG = /<h2[^>]*>siteAddress\.change\.title<\/h2>/;
const SUDO_DIALOG = /<h2[^>]*>siteAddress\.sudo\.title<\/h2>/;

let lastTree: React.ReactElement | null = null;

function renderOnce(): string {
    harness.active = true;
    harness.i = 0;
    harness.pending = [];
    let tree: React.ReactElement;
    try {
        tree = SiteAddressPage() as React.ReactElement;
    } finally {
        harness.active = false;
    }
    lastTree = tree;
    for (const effect of harness.pending.splice(0)) effect();
    return renderToStaticMarkup(tree);
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Render, let the reads the effects started answer, render again. */
async function settle(): Promise<string> {
    renderOnce();
    await flush();
    return renderOnce();
}

/** The props of the first element in the last tree rendered by the component function named `name`. */
function propsOf<P>(name: string): P | null {
    return findProps<P>(name, lastTree);
}
function findProps<P>(name: string, node: unknown): P | null {
    if (Array.isArray(node)) {
        for (const child of node) {
            const hit = findProps<P>(name, child);
            if (hit) return hit;
        }
        return null;
    }
    if (!React.isValidElement(node)) return null;
    if (typeof node.type === "function" && node.type.name === name) return node.props as P;
    return findProps<P>(name, (node.props as { children?: unknown }).children);
}

beforeEach(() => {
    harness.slots = [];
    harness.i = 0;
    harness.pending = [];
    lastTree = null;
    backend.gets = 0;
    backend.canonicalWrites = [];
    vi.stubGlobal("window", { location: { hostname: "example.com", pathname: "/admin/settings/site-address", search: `?suggest=${SUGGESTED}`, hash: "" } });
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe("/admin/settings/site-address?suggest=<url>", () => {
    it("opens the change dialog once: the re-read after a save does not open it again", async () => {
        backend.state = drifted("https://example.com", 1);
        const opened = await settle();
        expect(backend.gets).toBe(1);
        expect(opened).toMatch(CHANGE_DIALOG);
        expect(opened).toContain(`value="${SUGGESTED}"`);                 // prefilled with the suggestion

        // The administrator picks ANOTHER address and confirms with their password.
        const change = propsOf<{ onSubmit: (url: string, old: "keep") => void }>("CanonicalDialog");
        expect(change).not.toBeNull();
        change!.onSubmit("https://other.example", "keep");
        const asking = renderOnce();
        expect(asking).not.toMatch(CHANGE_DIALOG);
        expect(asking).toMatch(SUDO_DIALOG);
        const sudo = propsOf<{ pending: { run: (pw: string, force: boolean) => Promise<unknown> }; onDone: (r: unknown) => void }>("SudoDialog");
        backend.state = drifted("https://other.example", 2);                // what the backend answers after the write
        sudo!.onDone(await sudo!.pending.run("correct horse", false));

        const reread = await settle();
        expect(backend.canonicalWrites).toEqual([{ url: "https://other.example", oldAddress: "keep" }]);
        expect(backend.gets).toBe(2);                                      // the screen DID read its state again…
        expect(reread).toContain("other.example");                         // …and shows the new address…
        expect(reread).not.toMatch(SUDO_DIALOG);
        expect(reread).not.toMatch(CHANGE_DIALOG);                         // …without reopening the dialog
    });

    it("opens nothing once the suggested address IS the main address", async () => {
        backend.state = drifted(SUGGESTED, 1);
        const page = await settle();
        expect(backend.gets).toBe(1);
        expect(page).not.toMatch(CHANGE_DIALOG);
    });
});
