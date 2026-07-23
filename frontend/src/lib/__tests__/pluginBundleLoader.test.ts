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
const REGISTRY_URL = '/api/v1/plugins/registry';

// Import fresh per test: activePromise/hooksRegistered are module-level session caches, and the caching
// behaviour is exactly what is under test.
async function freshLoader() {
    vi.resetModules();
    return import("../pluginBundleLoader");
}

function jsonResponse(body: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** A registry entry as GET /plugins/registry emits it: the plugin's manifest, spread. */
function registryEntry(id: string, frontend: unknown): unknown {
    return { id, name: id, version: '1.0.0', active: true, path: `/plugins/${id}`, frontend };
}

/**
 * The REAL body of GET /plugins/registry. backend/src/routes/plugins.ts ends with
 * `res.json({ plugins: registry })` — an OBJECT wrapping the array, which is exactly how
 * frontend/src/lib/plugins-registry.ts has always read it (`data.plugins || []`).
 *
 * This helper exists because the earlier version of this suite mocked a BARE ARRAY here. That mock did
 * not match the producer, so the suite passed while the loader's `Array.isArray(body)` guard rejected
 * every real response and classification never ran in production — a test that lies is worse than no
 * test. Route the mocks through this helper so the shape can only be changed in one place, deliberately.
 */
function registryResponse(entries: unknown[], status = 200): Response {
    return jsonResponse({ plugins: entries }, status);
}

let fetchMock: ReturnType<typeof vi.fn>;
// The loader only needs `window` to EXIST. Install a stub when the environment has none, and REMOVE it
// afterwards — leaving a fake `window` on globalThis leaks into any other suite in the same process
// (sanitize.ts, for one, branches on `typeof window` to pick its SSR vs browser sanitizer).
let installedWindowStub = false;

beforeEach(() => {
    if (!(globalThis as any).window) {
        (globalThis as any).window = {};
        installedWindowStub = true;
    }
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
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

    it("resolves [] WITHOUT fetching on the SERVER (the URL is relative — Node's fetch cannot parse it)", async () => {
        const saved = (globalThis as any).window;
        delete (globalThis as any).window;
        try {
            const { fetchActivePluginIds } = await freshLoader();
            await expect(fetchActivePluginIds()).resolves.toEqual([]);
            expect(fetchMock).not.toHaveBeenCalled();
        } finally {
            (globalThis as any).window = saved;
        }
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

    it("REJECTS when an active plugin's hooks bundle 5xxs, and stays silent about the hook-less one", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(['no-hooks-plugin', 'broken-plugin']);
            if (url === REGISTRY_URL) return registryResponse([
                registryEntry('no-hooks-plugin', { adminPage: { entry: 'client/admin/page.tsx' } }),
                registryEntry('broken-plugin', { hooks: 'client/Ext.tsx' }),
            ]);
            if (url.includes('no-hooks-plugin')) return jsonResponse({}, 404);  // declares no hooks — normal
            return jsonResponse({}, 503);                                       // transient — must surface
        });
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).rejects.toThrow(/1 plugin hooks bundle\(s\) failed/);
        expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('no-hooks-plugin'));
    });

    it("RESOLVES when every active plugin simply ships no hooks bundle (404)", async () => {
        fetchMock.mockImplementation(async (url: string) =>
            url === ACTIVE_URL ? jsonResponse(['a-plugin']) : jsonResponse({}, 404));
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
    });
});

/**
 * A 404 on ?type=hooks has two very different causes, and the loader must not cry wolf about the boring
 * one: exactly ONE of the 31 catalog plugins declares `frontend.hooks`, so warning on every 404 filled a
 * healthy install's console with ~N "the install is broken" lines — ~97% false positives, which is how a
 * breadcrumb becomes noise admins scroll past. GET /plugins/registry already carries each ACTIVE plugin's
 * manifest, so the cause is decidable client-side, lazily, without touching the backend.
 */
describe("hooks-bundle 404 — warn only when the bundle SHOULD have been there", () => {
    const hooksBundle404 = (registry: unknown[], active: string[]) =>
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(active);
            if (url === REGISTRY_URL) return registryResponse(registry);
            return jsonResponse({}, 404);
        });

    it("is SILENT for a plugin that declares no frontend.hooks (the normal case)", async () => {
        hooksBundle404([registryEntry('faq', { puckComponents: { entry: 'client/puck/Faq.tsx' } })], ['faq']);
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("is SILENT for a plugin whose manifest has no `frontend` section at all", async () => {
        hooksBundle404([registryEntry('backend-only', undefined)], ['backend-only']);
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("WARNS when the plugin declares frontend.hooks — it was never built / its dist was lost", async () => {
        hooksBundle404([registryEntry('mail-server', { hooks: 'client/UserFormExtension.tsx' })], ['mail-server']);
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining("plugin 'mail-server' declares frontend.hooks"));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('build-plugin.js mail-server'));
    });

    // routes/plugins.ts emits `frontend: null` EXPLICITLY when it cannot read the plugin's manifest.json
    // (folder missing, or invalid JSON) — a broken install, and the other cause worth reporting.
    it("WARNS when the backend could not read the plugin's manifest (frontend: null)", async () => {
        hooksBundle404([registryEntry('ghost-plugin', null)], ['ghost-plugin']);
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no readable manifest.json'));
    });

    it("warns at most ONCE per plugin, and fetches the registry ONCE for many 404s", async () => {
        hooksBundle404(
            [registryEntry('a', {}), registryEntry('b', {}), registryEntry('c', { hooks: 'client/C.tsx' })],
            ['a', 'b', 'c']);
        const { loadRuntimePluginHooks } = await freshLoader();
        await loadRuntimePluginHooks();
        await loadRuntimePluginHooks();   // a later admin-layout mount retries the 404 plugins
        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls.filter(([u]) => u === REGISTRY_URL)).toHaveLength(1);
    });

    it("does NOT fetch the registry when nothing 404s (no cost on the happy path)", async () => {
        fetchMock.mockImplementation(async (url: string) =>
            url === ACTIVE_URL ? jsonResponse(['a-plugin']) : jsonResponse({}, 503));
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).rejects.toThrow(/failed to load/);
        expect(fetchMock.mock.calls.some(([u]) => u === REGISTRY_URL)).toBe(false);
    });

    it("stays silent (and does not cache) when the registry itself is unreachable", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(['a-plugin']);
            if (url === REGISTRY_URL) return jsonResponse({}, 502);
            return jsonResponse({}, 404);
        });
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(console.warn).not.toHaveBeenCalled();
        // The failed registry fetch must not be memoized: the next pass tries again and can classify.
        await loadRuntimePluginHooks();
        expect(fetchMock.mock.calls.filter(([u]) => u === REGISTRY_URL)).toHaveLength(2);
    });
});

/**
 * The shape of GET /plugins/registry, pinned against its PRODUCER.
 *
 * This is the regression that a lying mock hid: backend/src/routes/plugins.ts answers
 * `res.json({ plugins: [...] })`, but the loader guarded the raw body with `Array.isArray(body)` and
 * threw on every well-formed response. Classification was therefore dead code in production — every
 * hooks-bundle 404 silently skipped the warning — while a suite that mocked a bare array stayed green.
 * The object form is the contract; the bare array is accepted only as proxy tolerance. Both get a test,
 * so neither can be dropped by accident.
 */
describe("GET /plugins/registry response shape", () => {
    const withRegistryBody = (body: unknown) =>
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(['mail-server']);
            if (url === REGISTRY_URL) return jsonResponse(body);
            return jsonResponse({}, 404);
        });

    // THE REAL CONTRACT. Pre-fix, the loader's Array.isArray guard rejected exactly this body, so the
    // warning below never appeared on a real install no matter how broken the plugin was.
    it("classifies from the OBJECT body the backend actually sends: { plugins: [...] }", async () => {
        withRegistryBody({ plugins: [registryEntry('mail-server', { hooks: 'client/Ext.tsx' })] });
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining("plugin 'mail-server' declares frontend.hooks"));
    });

    it("also accepts a BARE ARRAY body (tolerance for a proxy that unwraps the envelope)", async () => {
        withRegistryBody([registryEntry('mail-server', { hooks: 'client/Ext.tsx' })]);
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining("plugin 'mail-server' declares frontend.hooks"));
    });

    it("stays silent on a body that is neither shape (a proxy error page), and does not cache it", async () => {
        withRegistryBody({ error: 'gateway exploded' });
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(console.warn).not.toHaveBeenCalled();
        await loadRuntimePluginHooks();
        expect(fetchMock.mock.calls.filter(([u]) => u === REGISTRY_URL)).toHaveLength(2);
    });

    // `{ plugins: [] }` is a real answer (no active plugin has a readable manifest), not a malformed
    // body: it must be cached like any success, and it classifies as 'none' → silent.
    it("treats { plugins: [] } as a valid, cacheable answer", async () => {
        withRegistryBody({ plugins: [] });
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        await loadRuntimePluginHooks();
        expect(console.warn).not.toHaveBeenCalled();
        expect(fetchMock.mock.calls.filter(([u]) => u === REGISTRY_URL)).toHaveLength(1);
    });
});

/**
 * Classification is a console-warning nicety. A gateway that accepts the connection and then never
 * answers gives no HTTP status to reject on, so without an explicit bound the `await` in the 404 branch
 * would hold loadRuntimePluginHooks open for as long as the socket stayed up — diagnostics blocking the
 * thing they are meant to diagnose.
 */
describe("registry classification is bounded — a hanging /plugins/registry cannot stall hook loading", () => {
    it("gives up on the classification and resolves instead of hanging forever", async () => {
        vi.useFakeTimers();
        try {
            fetchMock.mockImplementation(async (url: string) => {
                if (url === ACTIVE_URL) return jsonResponse(['mail-server']);
                if (url === REGISTRY_URL) return new Promise<Response>(() => { }); // never settles
                return jsonResponse({}, 404);
            });
            const { loadRuntimePluginHooks } = await freshLoader();
            const pending = loadRuntimePluginHooks();
            // Pre-bound this never settled; the assertion below would time out rather than fail loudly.
            await vi.advanceTimersByTimeAsync(5000);
            await expect(pending).resolves.toBeUndefined();
            expect(console.warn).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("clears the timer when the registry answers promptly (no leaked setTimeout)", async () => {
        vi.useFakeTimers();
        try {
            fetchMock.mockImplementation(async (url: string) => {
                if (url === ACTIVE_URL) return jsonResponse(['mail-server']);
                if (url === REGISTRY_URL) {
                    return registryResponse([registryEntry('mail-server', { hooks: 'client/Ext.tsx' })]);
                }
                return jsonResponse({}, 404);
            });
            const { loadRuntimePluginHooks } = await freshLoader();
            await loadRuntimePluginHooks();
            expect(console.warn).toHaveBeenCalledWith(
                expect.stringContaining("plugin 'mail-server' declares frontend.hooks"));
            // The race's losing timer must be cleared: a still-armed setTimeout holds the event loop
            // open, which is exactly how this repo's runner has flaked before.
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});

/**
 * Same defect class as fetchActivePluginIds, in the block loader: ANY non-ok response collapsed to `{}`
 * AND that `{}` was memoized in blockConfigCache for the whole session. One 502 from a restarting gateway
 * on the first editor mount therefore deleted every marketplace plugin's Puck blocks until the tab was
 * reloaded — no retry could recover, because the poisoned entry was replayed without fetching.
 */
describe("loadPluginBlockConfigs — only a 404 may be cached as 'ships no blocks'", () => {
    it("CACHES a 404 (the plugin genuinely ships no blocks): one fetch per session", async () => {
        fetchMock.mockResolvedValue(jsonResponse({}, 404));
        const { loadPluginBlockConfigs } = await freshLoader();
        await expect(loadPluginBlockConfigs('faq')).resolves.toEqual({});
        await expect(loadPluginBlockConfigs('faq')).resolves.toEqual({});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("REJECTS on a 5xx instead of resolving {}", async () => {
        fetchMock.mockResolvedValue(jsonResponse({}, 502));
        const { loadPluginBlockConfigs } = await freshLoader();
        await expect(loadPluginBlockConfigs('faq')).rejects.toThrow(/502/);
    });

    it("does NOT cache a 5xx — the next render re-fetches (was permanently empty)", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({}, 502));
        const { loadPluginBlockConfigs } = await freshLoader();
        await expect(loadPluginBlockConfigs('faq')).rejects.toThrow(/502/);

        fetchMock.mockResolvedValueOnce(jsonResponse({}, 404));   // backend recovered
        await expect(loadPluginBlockConfigs('faq')).resolves.toEqual({});
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does NOT cache a network failure either", async () => {
        fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));
        const { loadPluginBlockConfigs } = await freshLoader();
        await expect(loadPluginBlockConfigs('faq')).rejects.toThrow(/Failed to fetch/);

        fetchMock.mockResolvedValueOnce(jsonResponse({}, 404));
        await expect(loadPluginBlockConfigs('faq')).resolves.toEqual({});
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("loadActivePluginBlocks stays BEST-EFFORT: a failing plugin is skipped, never thrown", async () => {
        fetchMock.mockImplementation(async (url: string) =>
            url.includes('broken') ? jsonResponse({}, 503) : jsonResponse({}, 404));
        const { loadActivePluginBlocks } = await freshLoader();
        await expect(loadActivePluginBlocks(['broken', 'faq'])).resolves.toEqual({});
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining("Puck blocks unavailable for 'broken'"), expect.anything());
    });
});
