import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Plugin } from "@/lib/api";

/**
 * /admin/plugins?permissions=<slug> — THE LINK OUT OF A WITHHELD PLUGIN PAGE.
 *
 * When an active plugin's interface is not served because the administrator has not granted it
 * `browser:script`, /admin/plugin/<slug> renders components/PluginScriptNotGranted, whose button links to
 * /admin/plugins?permissions=<folder>. That link is only worth something if THIS screen, once its list has
 * loaded, opens that plugin's permissions dialog — the switch the notice names — instead of dropping the
 * administrator on the list to go looking for it. And it must open nothing for a slug the list does not
 * have, or for a broken entry (which has no grants to edit).
 *
 * It must also open it ONCE. The screen reloads its list after every change the administrator makes —
 * saving those very permissions, activating, deactivating — and the parameter is still in the address
 * bar when it does; and a reload of the page (or coming back to this history entry) mounts the screen
 * afresh. Neither may put the dialog the administrator just closed back in front of them.
 *
 * The page is a fetch-on-mount client component and this runner has no DOM (jsdom is not a dependency),
 * so the page is driven by a minimal HOOK HARNESS instead of a renderer: while PluginsPage() is being
 * called, the four React hooks it uses (useState, useEffect, useRef, useMemo) are served from slots this
 * file owns; effects run after each call, exactly once per dependency change, as React would. The tree
 * each call returns is then rendered with the REAL React (renderToStaticMarkup — the harness is off by
 * then), so what is asserted is the markup the administrator would see: the permissions dialog's own text
 * and the plugin's name, before and after GET /plugins resolves. A click is the tree's own onClick handler
 * of the button carrying that label, called as React would call it.
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
        const slot = harness.slots[i] as { deps?: unknown[] } | undefined;
        if (!slot || depsChanged(slot.deps, deps)) {
            harness.slots[i] = { deps };
            harness.pending.push(fn);
        }
    }) as typeof R.useEffect;
    const overrides = { useState, useRef, useMemo, useEffect };
    return { ...R, ...overrides, default: { ...R, ...overrides } };
});

/** GET /plugins and the two writes the tests click through. `list` counts its calls. */
const api = vi.hoisted(() => ({
    list: (() => Promise.resolve([])) as () => Promise<unknown>,
    listCalls: 0,
    setPermissions: [] as Array<{ slug: string; grants: string[] }>,
    deactivate: [] as string[],
}));
vi.mock("@/lib/api", () => ({
    pluginsApi: {
        list: () => { api.listCalls++; return api.list(); },
        setPermissions: (slug: string, grants: string[]) => {
            api.setPermissions.push({ slug, grants });
            return Promise.resolve({ message: "Permissions updated" });
        },
        deactivate: (slug: string) => { api.deactivate.push(slug); return Promise.resolve({}); },
    },
    themesApi: {},
}));
vi.mock("@/lib/plugins", () => ({ reloadActivePlugins: () => {} }));
vi.mock("@/contexts/MenuContext", () => ({ useMenu: () => ({ refreshMenus: () => {} }) }));
vi.mock("@/contexts/ToastContext", () => ({ useToast: () => ({ addToast: () => {} }) }));
vi.mock("@/contexts/I18nContext", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
vi.mock("../MarketplaceTab", () => ({ default: () => null }));

import PluginsPage from "../page";

/** The permissions dialog's own copy — present in the markup only while the dialog is open. */
const DIALOG_TEXT = "Grant only what this plugin needs";

const plugin = (over: Partial<Plugin> = {}): Plugin => ({
    name: "Mail Server",
    slug: "mail-server",
    description: "Mail",
    version: "2.1.0",
    active: true,
    permissions: [{ scope: "browser", access: "script", reason: "Admin pages" }],
    grantedPermissions: [],
    ...over,
} as Plugin);

/**
 * The browser the page sees: `location` and a `history` whose replaceState rewrites that location, the
 * way a browser's does. `refuseReplaceState` makes it throw instead (Safari answers a burst of history
 * calls with a SecurityError) — the case where the parameter STAYS in the URL for the rest of the visit.
 */
function stubBrowser(url: string, opts: { refuseReplaceState?: boolean } = {}) {
    const start = new URL(url, "https://site.test");
    const location = { pathname: start.pathname, search: start.search, hash: start.hash };
    const replaced: string[] = [];
    const history = {
        replaceState: (_data: unknown, _unused: string, next: string) => {
            if (opts.refuseReplaceState) throw new Error("SecurityError: history.replaceState() refused");
            const u = new URL(next, `https://site.test${location.pathname}`);
            location.pathname = u.pathname;
            location.search = u.search;
            location.hash = u.hash;
            replaced.push(next);
        },
        pushState: () => { throw new Error("the plugins screen must not push a history entry"); },
    };
    vi.stubGlobal("window", { location, history });
    return { replaced, address: () => `${location.pathname}${location.search}${location.hash}` };
}

let lastTree: React.ReactElement | null = null;

/** One render of the page: call it under the harness, run the effects it queued, render the tree for real. */
function renderOnce(): string {
    harness.active = true;
    harness.i = 0;
    harness.pending = [];
    let tree: React.ReactElement;
    try {
        tree = PluginsPage() as React.ReactElement;
    } finally {
        harness.active = false;
    }
    lastTree = tree;
    for (const effect of harness.pending.splice(0)) effect();
    return renderToStaticMarkup(tree);
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Mount the page afresh (a new visit or a reload: no hook state survives), let its first GET /plugins
 * answer `list`, and return the markup before and after. Later list loads answer `list` at once.
 */
async function mount(list: Plugin[]): Promise<{ before: string; after: string }> {
    harness.slots = [];
    let answer!: (v: Plugin[]) => void;
    api.list = () => new Promise((resolve) => { answer = resolve; });
    const before = renderOnce();          // mount: loadPlugins() is in flight
    api.list = () => Promise.resolve(list);
    answer(list);
    await flush();
    const after = renderOnce();           // the list has arrived
    return { before, after };
}

/** Mount the page at /admin/plugins<search>. */
async function visit(search: string, list: Plugin[]): Promise<{ before: string; after: string }> {
    stubBrowser(`/admin/plugins${search}`);
    return mount(list);
}

/** The text a React node would render (host elements and fragments only — enough for button labels). */
function textOf(node: unknown): string {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (React.isValidElement(node)) return textOf((node.props as { children?: unknown }).children);
    return "";
}

/** The props of the first <button> in `node` whose label contains `label` (document order). */
function findButton(node: unknown, label: string): { onClick?: () => unknown } | null {
    if (Array.isArray(node)) {
        for (const child of node) {
            const hit = findButton(child, label);
            if (hit) return hit;
        }
        return null;
    }
    if (!React.isValidElement(node)) return null;
    const props = node.props as { children?: unknown; onClick?: () => unknown };
    if (node.type === "button" && textOf(props.children).includes(label)) return props;
    return findButton(props.children, label);
}

/** Click the button labelled `label` in the last render, let what it started settle, render again. */
async function click(label: string): Promise<string> {
    const button = findButton(lastTree, label);
    expect(button, `a button labelled "${label}"`).not.toBeNull();
    await button!.onClick!();
    await flush();
    return renderOnce();
}

beforeEach(() => {
    harness.slots = [];
    harness.i = 0;
    harness.pending = [];
    lastTree = null;
    api.listCalls = 0;
    api.setPermissions = [];
    api.deactivate = [];
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe("/admin/plugins?permissions=<slug>", () => {
    it("opens THAT plugin's permissions dialog once the list has loaded (and not before)", async () => {
        const { before, after } = await visit("?permissions=mail-server", [
            plugin({ name: "FAQ", slug: "faq", permissions: [] }),
            plugin(),
        ]);
        expect(before).not.toContain(DIALOG_TEXT);
        expect(after).toContain(DIALOG_TEXT);
        // The dialog is mail-server's: its heading names it, and its declared browser:script switch is listed.
        expect(after).toMatch(/<h3[^>]*>Permissions<\/h3><p[^>]*>Mail Server<\/p>/);
        expect(after).not.toMatch(/<h3[^>]*>Permissions<\/h3><p[^>]*>FAQ<\/p>/);
    });

    it("without the parameter, the page opens no dialog and leaves the address alone", async () => {
        const browser = stubBrowser("/admin/plugins?tab=x#top");
        const { after } = await mount([plugin()]);
        expect(after).toContain("Mail Server");          // the list did render
        expect(after).not.toContain(DIALOG_TEXT);
        expect(browser.replaced).toEqual([]);
        expect(browser.address()).toBe("/admin/plugins?tab=x#top");
    });

    it("opens nothing for a slug the list does not have", async () => {
        const { after } = await visit("?permissions=never-installed", [plugin()]);
        expect(after).toContain("Mail Server");
        expect(after).not.toContain(DIALOG_TEXT);
    });

    it("opens nothing for a BROKEN entry of that slug (it has no grants to edit)", async () => {
        const { after } = await visit("?permissions=ghost", [
            plugin(),
            plugin({ name: "ghost", slug: "ghost", broken: true, brokenReason: "no-manifest", wasActive: true, removable: true, active: false }),
        ]);
        expect(after).toContain("ghost");
        expect(after).not.toContain(DIALOG_TEXT);
    });
});

describe("the link is consumed: it opens the dialog once", () => {
    // The browser refuses replaceState here, so ?permissions= is STILL in the address bar when the list
    // reloads: what keeps the dialog shut is the screen's once-per-visit latch, and nothing else.
    it("saving the permissions reloads the list without opening the dialog again", async () => {
        const browser = stubBrowser("/admin/plugins?permissions=mail-server", { refuseReplaceState: true });
        const { after } = await mount([plugin()]);
        expect(after).toContain(DIALOG_TEXT);

        const afterSave = await click("Save permissions");
        expect(api.setPermissions).toEqual([{ slug: "mail-server", grants: [] }]);
        expect(api.listCalls).toBe(2);                              // the list DID reload…
        expect(browser.address()).toBe("/admin/plugins?permissions=mail-server");   // …with the link still in the URL
        expect(afterSave).toContain("Mail Server");
        expect(afterSave).not.toContain(DIALOG_TEXT);              // …and the dialog stayed shut
    });

    it("a deactivation after closing the dialog reloads the list without opening it again", async () => {
        stubBrowser("/admin/plugins?permissions=mail-server", { refuseReplaceState: true });
        const { after } = await mount([plugin({ name: "FAQ", slug: "faq", permissions: [] }), plugin()]);
        expect(after).toContain(DIALOG_TEXT);

        const closed = await click("Cancel");
        expect(closed).not.toContain(DIALOG_TEXT);

        const afterDeactivate = await click("plugins.deactivate");  // the first card's (FAQ) power button
        expect(api.deactivate).toEqual(["faq"]);
        expect(api.listCalls).toBe(2);
        expect(afterDeactivate).not.toContain(DIALOG_TEXT);
    });

    it("takes ?permissions= out of the address bar, so a reload does not open the dialog again", async () => {
        const browser = stubBrowser("/admin/plugins?tab=x&permissions=mail-server&y=a%20b#top");
        const { after } = await mount([plugin()]);
        expect(after).toContain(DIALOG_TEXT);

        const reload = await mount([plugin()]);                     // same history entry, fresh page
        expect(reload.after).toContain("Mail Server");
        expect(reload.after).not.toContain(DIALOG_TEXT);
        // Replaced once (pushState would throw), every other parameter and the fragment kept as written.
        expect(browser.address()).toBe("/admin/plugins?tab=x&y=a%20b#top");
        expect(browser.replaced).toHaveLength(1);
    });

    it("drops the parameter even when it names nothing the list has", async () => {
        const browser = stubBrowser("/admin/plugins?permissions=never-installed");
        const { after } = await mount([plugin()]);
        expect(after).not.toContain(DIALOG_TEXT);
        expect(browser.address()).toBe("/admin/plugins");
    });
});
