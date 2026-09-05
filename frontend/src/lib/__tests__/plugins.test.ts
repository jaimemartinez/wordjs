import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { ReviewPill } from "@/app/admin/plugins/MarketplaceTab";

/**
 * The wiring the admin plugins page depends on: activating a plugin must make the runtime loader look at
 * the world again, in the SAME page load.
 *
 * Why this needs a test at all — the loader memoizes GET /plugins/active for the session, and that memo
 * was justified by the claim that the list "only changes when an admin activates/deactivates a plugin
 * (which reloads the page)". It does not reload the page: admin/plugins/page.tsx's togglePlugin and
 * confirmActivate await pluginsApi.deactivate/activate and then only call loadPlugins() + refreshMenus(),
 * both of which re-fetch into React state; there is no location.reload / router.refresh in that flow, in
 * MenuContext, or in lib/api. In production nothing regenerates the build-time registry either
 * (regenerateRegistry() in backend/src/routes/plugins.ts returns early when NODE_ENV=production), so the
 * runtime pass is the only way a just-activated plugin's hooks can register — and it was reading a list
 * captured before the activation. mail-server could be activated and its UI extensions would not appear
 * until the admin reloaded the tab by hand.
 *
 * reloadActivePlugins() is what the page calls; this drives that REAL function against the REAL loader.
 *
 * Node environment (jsdom is not a dependency): both modules only need `window` to EXIST on these paths.
 * The generated build-time registry is stubbed — it statically imports the hook SOURCES of whichever
 * plugins were on disk when it was last generated, which is neither reproducible nor under test here.
 */
vi.mock("../pluginRegistry", () => ({
    loadPluginHooks: vi.fn(() => Promise.resolve()),
}));

const ACTIVE_URL = '/api/v1/plugins/active';

let fetchMock: ReturnType<typeof vi.fn>;
let installedWindowStub = false;

function jsonResponse(body: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const activeFetches = (): number =>
    fetchMock.mock.calls.filter(([u]) => u === ACTIVE_URL).length;
const hooksFetchesFor = (slug: string): number =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes(`/${slug}/bundle`) && String(u).includes('type=hooks')).length;

// Fresh module instances per test: the active-list memo and the per-plugin registration memo are
// module-level session state, and this suite is about when that state is dropped. Both modules are
// imported from the SAME registry generation, so lib/plugins really does drive the loader instance the
// assertions read.
async function freshModules() {
    vi.resetModules();
    const loader = await import("../pluginBundleLoader");
    const plugins = await import("../plugins");
    return { loader, plugins };
}

beforeEach(() => {
    if (!(globalThis as any).window) {
        (globalThis as any).window = {};
        installedWindowStub = true;
    }
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => { });
    vi.spyOn(console, 'warn').mockImplementation(() => { });
    vi.spyOn(console, 'error').mockImplementation(() => { });
});

afterEach(() => {
    if (installedWindowStub) {
        delete (globalThis as any).window;
        installedWindowStub = false;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("reloadActivePlugins — an activate/deactivate must invalidate the session's active-plugin memo", () => {
    // The backend's answer CHANGES at activation time; serving it from a mutable array is the only way a
    // memo that is never dropped can be told apart from one that is.
    const backendWithMutableActiveList = (active: string[]) =>
        fetchMock.mockImplementation(async (url: string) =>
            url === ACTIVE_URL ? jsonResponse([...active]) : jsonResponse({}, 404));

    it("re-reads /plugins/active and loads the newly activated plugin's hooks bundle", async () => {
        const active: string[] = [];
        backendWithMutableActiveList(active);
        const { plugins } = await freshModules();

        // Admin layout mounts on an install with nothing active: the empty list gets memoized.
        plugins.initPlugins();
        await vi.waitFor(() => expect(activeFetches()).toBe(1));
        expect(hooksFetchesFor('mail-server')).toBe(0);

        // The admin activates mail-server — POST returned 200, and the page did NOT reload.
        active.push('mail-server');
        await plugins.reloadActivePlugins();

        // Pre-fix: still 1 (the memo was replayed) and no hooks request was ever made for the plugin.
        expect(activeFetches()).toBe(2);
        expect(hooksFetchesFor('mail-server')).toBe(1);
    });

    it("also invalidates on DEACTIVATE, so the next activation is not hidden by a stale list", async () => {
        const active = ['mail-server'];
        backendWithMutableActiveList(active);
        const { plugins } = await freshModules();

        plugins.initPlugins();
        await vi.waitFor(() => expect(activeFetches()).toBe(1));

        // Deactivate mail-server, then activate online-store — the second one is what breaks if the
        // deactivate flow leaves the memo in place.
        active.pop();
        await plugins.reloadActivePlugins();
        active.push('online-store');
        await plugins.reloadActivePlugins();

        expect(activeFetches()).toBe(3);
        expect(hooksFetchesFor('online-store')).toBe(1);
    });

    it("does not re-request the list for every caller in between (the memo still holds)", async () => {
        const active = ['mail-server'];
        backendWithMutableActiveList(active);
        const { plugins, loader } = await freshModules();

        await plugins.reloadActivePlugins();
        // Everything downstream (the block loader, each editor mount) shares the one memoized answer.
        await Promise.all([loader.fetchActivePluginIds(), loader.fetchActivePluginIds()]);
        await loader.loadRuntimePluginHooks();

        expect(activeFetches()).toBe(1);
    });
});

/**
 * The marketplace card's REVIEW pill.
 *
 * Nothing in the frontend suite renders MarketplaceTab or the plugins admin page, and this file is the
 * closest existing plugins-admin test — it already pins wiring that page depends on — so the pill's
 * contract lands here rather than in a new file. The tab itself is a fetch-on-mount client tree, which
 * is why the pill is exported: it is a pure function of one catalog entry and can be driven directly.
 *
 * The load-bearing case is the ABSENT field. The catalog is fetched at runtime from a Release, so an
 * install can be reading an index built before reviews existed; if "no field" rendered as anything
 * softer than "Unreviewed", every old catalog would quietly launder unvetted plugins as vetted.
 */
// `official` defaults to TRUE here because these cases are about the status, and the official catalog is
// where a status means anything at all; the third-party cases pass it explicitly.
const renderPill = (review?: React.ComponentProps<typeof ReviewPill>["review"], official = true) =>
    renderToStaticMarkup(React.createElement(ReviewPill, { review, official }));
/** No `official` prop at all — the shape an older backend, or a caller that forgot it, would produce. */
const renderPillWithNoSourceFlag = (review?: React.ComponentProps<typeof ReviewPill>["review"]) =>
    renderToStaticMarkup(React.createElement(ReviewPill, { review }));
const pillText = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").trim();
const pillTitle = (html: string) => (html.match(/title="([^"]*)"/) || [])[1]?.replace(/&amp;/g, "&").replace(/&#x27;/g, "'");

const SANDBOX_NOTE = "Every plugin runs in the same sandbox with only the permissions you grant, badge or no badge.";
const UNREVIEWED_TITLE = `Not reviewed by the WordJS maintainers; the sandbox and your permission grants are the safeguards. ${SANDBOX_NOTE}`;

describe("MarketplaceTab ReviewPill — the maintainers' claim about a catalog entry", () => {
    it("reviewed → \"Reviewed\", with the reviewer and date in the tooltip", () => {
        const html = renderPill({ status: "reviewed", reviewer: "wordjs-maintainers", date: "2026-09-01" });

        // NOT "Sandboxed & reviewed". REVIEW.md §1 says the sandbox "applies to every plugin in the
        // catalog regardless of badge", so a label that pairs the two makes the differentiator read as
        // "the unreviewed ones are not sandboxed" — the precise misreading §1 was written to prevent,
        // on the one string an admin reads before clicking Install.
        expect(pillText(html)).toBe("Reviewed");
        expect(html).not.toContain("Sandboxed &");
        expect(pillTitle(html)).toContain("Reviewed by wordjs-maintainers · 2026-09-01");
        // The sandbox statement is not dropped, it is moved to where it can be true of everything.
        expect(pillTitle(html)).toContain(SANDBOX_NOTE);
        // And the tooltip still refuses to overclaim.
        expect(pillTitle(html)).toContain("not a security audit");
    });

    it("first-party → \"First-party\", in a neutral tone (never the reviewed one)", () => {
        const html = renderPill({ status: "first-party", notes: "Maintained in this repository by the WordJS project; not independently reviewed." });

        expect(pillText(html)).toBe("First-party");
        // The entry's own note is what the admin reads on hover — it says plainly that first-party is
        // not the same as reviewed.
        expect(pillTitle(html)).toBe("Maintained in this repository by the WordJS project; not independently reviewed.");
        // A first-party listing must not borrow the reviewed pill's affirmative colour.
        expect(html).not.toContain("emerald");
    });

    it("unreviewed → \"Unreviewed\", naming the sandbox and the grants as the only safeguards", () => {
        const html = renderPill({ status: "unreviewed" });

        expect(pillText(html)).toBe("Unreviewed");
        expect(pillTitle(html)).toBe(UNREVIEWED_TITLE);
    });

    it("an entry with NO review field (older catalog) reads exactly like an unreviewed one", () => {
        const absent = renderPill(undefined);

        expect(pillText(absent)).toBe("Unreviewed");
        expect(pillTitle(absent)).toBe(UNREVIEWED_TITLE);
        // Byte-identical to the explicit status: an old index cannot render as a softer claim.
        expect(absent).toBe(renderPill({ status: "unreviewed" }));
    });

    /**
     * THE MULTI-SOURCE CASE. `review` arrives INSIDE whichever catalog index answered, and an admin may
     * point WordJS at any number of them (routes/marketplace.ts resolveSources). The ledger, the gate
     * and REVIEW.md cover exactly one catalog — this project's — so a badge from any other source is a
     * claim nobody here ever made, rendered above an Install button on the highest-privilege screen in
     * the product. The backend rewrites those entries to `unreviewed`; this pill is the second lock, so
     * that BOTH would have to fail for an unvetted listing to render as vetted.
     */
    it("a \"reviewed\" entry from a NON-official catalog renders as Unreviewed, not as a badge", () => {
        const html = renderPill({ status: "reviewed", reviewer: "totally-legit", date: "2026-09-01", notes: "Audited, no findings" }, false);

        expect(pillText(html)).toBe("Unreviewed");
        expect(html).not.toContain("emerald");
        // The reviewer's self-declared name must not reach the screen at all.
        expect(html).not.toContain("totally-legit");
        expect(pillTitle(html)).toContain("catalog source other than the official WordJS one");
        expect(pillTitle(html)).toContain(SANDBOX_NOTE);
    });

    it("a \"first-party\" entry from a NON-official catalog cannot borrow the project's own name", () => {
        const html = renderPill({ status: "first-party", notes: "Maintained by the WordJS project." }, false);

        expect(pillText(html)).toBe("Unreviewed");
        expect(html).not.toContain("Maintained by the WordJS project.");
    });

    it("fails closed when the source is unknown: no `official` flag is not a badge", () => {
        const html = renderPillWithNoSourceFlag({ status: "reviewed", reviewer: "someone", date: "2026-09-01" });

        expect(pillText(html)).toBe("Unreviewed");
        expect(pillTitle(html)).toBe(UNREVIEWED_TITLE);
    });

    it("leads the badge row — the trust claim is read before the capability pills", () => {
        const src = fs.readFileSync(path.resolve(__dirname, "../../app/admin/plugins/MarketplaceTab.tsx"), "utf8");
        const row = src.slice(src.indexOf('<div className="flex items-center gap-2 flex-wrap mb-5">'));

        expect(row.indexOf("<ReviewPill")).toBeGreaterThan(-1);
        expect(row.indexOf("<ReviewPill")).toBeLessThan(row.indexOf("hasVersoBlock"));
        expect(row.indexOf("<ReviewPill")).toBeLessThan(row.indexOf("e.permissions"));
    });
});
