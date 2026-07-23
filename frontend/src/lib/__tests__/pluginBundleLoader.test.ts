import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression cover for the runtime plugin loader's FAILURE semantics.
 *
 * The bug this locks down: fetchActivePluginIds() used to swallow every failure into `[]` AND memoize it.
 * Since it is the first call loadRuntimePluginHooks() makes, a 502 from a restarting gateway meant "no
 * active plugins" → nothing to load → loadRuntimePluginHooks RESOLVED → initPlugins kept its run-once
 * guard latched → marketplace plugins' frontend hooks were dead for the whole session, silently, with the
 * poisoned `[]` cached so no retry could recover.
 *
 * Node environment (jsdom is not a dependency): the loader only needs `window` to EXIST, so a bare stub
 * installed before the dynamic import is enough — it never touches the DOM on these paths.
 */

const ACTIVE_URL = '/api/v1/plugins/active';

// Import fresh per test: activePromise/hooksRegistered are module-level session caches, and the caching
// behaviour is exactly what is under test.
async function freshLoader() {
    vi.resetModules();
    return import("../pluginBundleLoader");
}

function jsonResponse(body: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    (globalThis as any).window = (globalThis as any).window ?? {};
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => { });
    vi.spyOn(console, 'error').mockImplementation(() => { });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("fetchActivePluginIds — a failed fetch must not masquerade as 'no active plugins'", () => {
    it("REJECTS on a non-2xx status (restarting gateway) instead of resolving []", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ error: 'bad gateway' }, 502));
        const { fetchActivePluginIds } = await freshLoader();
        await expect(fetchActivePluginIds()).rejects.toThrow(/502/);
    });

    it("REJECTS on a network failure instead of resolving []", async () => {
        fetchMock.mockRejectedValue(new Error('Failed to fetch'));
        const { fetchActivePluginIds } = await freshLoader();
        await expect(fetchActivePluginIds()).rejects.toThrow(/Failed to fetch/);
    });

    it("does NOT cache a failure — a later call re-fetches and can succeed", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
        const { fetchActivePluginIds } = await freshLoader();
        await expect(fetchActivePluginIds()).rejects.toThrow(/503/);

        // Backend is back up: the retry must hit the network again, not replay the cached failure.
        fetchMock.mockResolvedValueOnce(jsonResponse(['mail-server']));
        await expect(fetchActivePluginIds()).resolves.toEqual(['mail-server']);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("CACHES a genuinely empty active list (HTTP 200 []) — that is an answer, not an error", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));
        const { fetchActivePluginIds } = await freshLoader();
        await expect(fetchActivePluginIds()).resolves.toEqual([]);
        await expect(fetchActivePluginIds()).resolves.toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("CACHES a successful non-empty list (one fetch per session)", async () => {
        fetchMock.mockResolvedValue(jsonResponse(['mail-server', 'online-store']));
        const { fetchActivePluginIds } = await freshLoader();
        const [a, b] = await Promise.all([fetchActivePluginIds(), fetchActivePluginIds()]);
        expect(a).toEqual(['mail-server', 'online-store']);
        expect(b).toEqual(a);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("REJECTS a 200 whose body is not an array (proxy error page) rather than caching it as []", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }));
        const { fetchActivePluginIds } = await freshLoader();
        await expect(fetchActivePluginIds()).rejects.toThrow(/non-array/);
    });
});

describe("loadRuntimePluginHooks — must surface, not swallow, a broken active-list fetch", () => {
    it("REJECTS when /plugins/active fails, so initPlugins can un-latch and retry", async () => {
        fetchMock.mockResolvedValue(jsonResponse({}, 502));
        const { loadRuntimePluginHooks } = await freshLoader();
        // Pre-fix this RESOLVED (ids = [] → allSettled([]) → no failures) and the hooks stayed dead.
        await expect(loadRuntimePluginHooks()).rejects.toThrow(/502/);
    });

    it("RESOLVES when the backend reports zero active plugins (nothing to do is not a failure)", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
    });

    it("REJECTS when an active plugin's hooks bundle 5xxs, but only warns on a 404", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(['no-hooks-plugin', 'broken-plugin']);
            if (url.includes('no-hooks-plugin')) return jsonResponse({}, 404);  // declares no hooks — normal
            return jsonResponse({}, 503);                                       // transient — must surface
        });
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).rejects.toThrow(/1 plugin hooks bundle\(s\) failed/);
        // A 404 for a plugin the backend says is ACTIVE is ambiguous (no hooks vs broken install), so it
        // must at least be visible.
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no-hooks-plugin'));
    });

    it("RESOLVES when every active plugin simply ships no hooks bundle (404)", async () => {
        fetchMock.mockImplementation(async (url: string) =>
            url === ACTIVE_URL ? jsonResponse(['a-plugin']) : jsonResponse({}, 404));
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
    });
});
