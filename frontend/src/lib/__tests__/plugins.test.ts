import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
