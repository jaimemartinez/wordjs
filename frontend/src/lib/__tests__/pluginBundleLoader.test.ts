import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// next/dynamic renders nothing outside a browser, and createRemotePluginComponent — the call the generated
// /admin/plugin/<slug> page makes — hands its loader straight to it. Return that LOADER as the "component",
// so a test can await exactly what next/dynamic would and render the module it resolves to. Nothing else in
// the loader imports next/dynamic.
vi.mock("next/dynamic", () => ({ default: (loader: unknown) => loader }));

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
const MENUS_URL = '/api/v1/plugins/menus';

// Import fresh per test: activePromise/hooksRegistration/blockConfigCache are module-level session
// caches, and the caching behaviour is exactly what is under test.
async function freshLoader() {
    vi.resetModules();
    return import("../pluginBundleLoader");
}

function jsonResponse(body: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** A 200 serving bundle SOURCE — what GET /plugins/:id/bundle?type=hooks answers with. */
function textResponse(code: string): Response {
    return { ok: true, status: 200, text: async () => code } as Response;
}

/**
 * A registry entry as GET /plugins/registry emits it: id, path, the browser:script grant and the
 * `frontend` signal — never the manifest (that endpoint is anonymous; see routes/plugins.ts). The
 * fixtures below still pass the historical string form of `hooks` in places: an older backend sent the
 * manifest's entry path, and the loader accepts both.
 */
function registryEntry(id: string, frontend: unknown, browser = true): unknown {
    return { id, path: `/plugins/${id}`, browser, frontend };
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

// ---------------------------------------------------------------------------
// Reaching the SUCCESS path (a hooks bundle that actually registers something)
// ---------------------------------------------------------------------------
// The happy path ends in `import()` of a `blob:` URL, which the runner's node environment cannot perform.
// Substitute ONLY that step — `URL.createObjectURL` hands back an equivalent `data:` URL — using real
// subclasses, so nothing else about either global changes (`new URL(...)` / `new Blob(...)` keep working
// for the rest of the module graph). vi.stubGlobal + the shared afterEach's unstubAllGlobals put both back.
// Everything else stays the loader's own code: fetch, status handling, module evaluation,
// invokeHookRegistrars and the memo bookkeeping under test. A genuine browser `blob:` import remains out
// of reach in this runner; it is covered only by the LXC end-to-end pass.
function installImportableBundleShim(): void {
    const RealBlob = globalThis.Blob;
    class ShimBlob extends RealBlob {
        readonly source: string;
        constructor(parts: BlobPart[], options?: BlobPropertyBag) {
            super(parts, options);
            this.source = parts.join('');
        }
    }
    class ShimURL extends globalThis.URL { }
    (ShimURL as unknown as { createObjectURL(b: ShimBlob): string }).createObjectURL = (b) =>
        'data:text/javascript;base64,' + Buffer.from(b.source, 'utf8').toString('base64');
    (ShimURL as unknown as { revokeObjectURL(u: string): void }).revokeObjectURL = () => { };
    vi.stubGlobal('Blob', ShimBlob);
    vi.stubGlobal('URL', ShimURL);
}

// A hooks bundle in the shape build-plugin.js emits: an ESM module whose `register*` export installs the
// plugin's UI extension. It runs as its own module, so a global is its only way back to the test.
// `marker` also keeps each test's data: URL unique — identical ones are cached by the module loader, and
// a shared URL would let one test's evaluation stand in for another's.
function hooksBundle(marker: string): string {
    const key = JSON.stringify(marker);
    return `export const registerUserFormExtension = () => {\n` +
        `  const log = globalThis.__wjsHookRegistrations;\n` +
        `  log[${key}] = (log[${key}] || 0) + 1;\n` +
        `};\n`;
}
const registrations = (marker: string): number =>
    ((globalThis as any).__wjsHookRegistrations as Record<string, number>)[marker] ?? 0;
const hooksFetches = (): number =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes('type=hooks')).length;
const activeFetches = (): number =>
    fetchMock.mock.calls.filter(([u]) => u === ACTIVE_URL).length;

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
    // Where an evaluated hooks bundle records that its register* export ran (see hooksBundle).
    (globalThis as any).__wjsHookRegistrations = {};
});

afterEach(() => {
    if (installedWindowStub) {
        delete (globalThis as any).window;
        installedWindowStub = false;
    }
    delete (globalThis as any).__wjsHookRegistrations;
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

    it("WARNS from the boolean `hooks: true` the current backend sends", async () => {
        hooksBundle404([registryEntry('mail-server', { hooks: true })], ['mail-server']);
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining("plugin 'mail-server' declares frontend.hooks"));
    });

    // browser:script NOT granted: the host refuses to serve the plugin's browser code, so the 404 is the
    // gate working. It must not be reported as a broken build ("run build-plugin.js") — that would send
    // the admin to rebuild something that is fine — but it must point at the switch, once.
    it("says the capability is NOT GRANTED (not 'never built') when browser:script is off", async () => {
        hooksBundle404([registryEntry('mail-server', { hooks: true }, false)], ['mail-server']);
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"browser:script" permission is not granted'));
        expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('build-plugin.js'));
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

    // The registry used to be read only to classify a 404 ("no cost on the happy path"). It now decides
    // which plugins are asked for a hooks bundle at all (see the suite below), so it is read once per
    // pass — and only once, however many plugins are asked or fail.
    it("reads the registry ONCE per pass, however many plugins are asked", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(['a-plugin', 'b-plugin']);
            if (url === REGISTRY_URL) return registryResponse([
                registryEntry('a-plugin', { hooks: true }), registryEntry('b-plugin', { hooks: true }),
            ]);
            return jsonResponse({}, 503);
        });
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).rejects.toThrow(/2 plugin hooks bundle\(s\) failed/);
        expect(fetchMock.mock.calls.filter(([u]) => u === REGISTRY_URL)).toHaveLength(1);
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

    // The memoized promise must be the BOUNDED one. When the timeout was applied at the CALL SITE the
    // un-bounded fetch stayed in registryPromise: a hang never rejects, so the identity-guarded `.catch`
    // that un-memoizes a failure never fired, and every later mount replayed the same dead promise —
    // classification was permanently dead even after the gateway came back, with nothing logged.
    it("re-fetches a registry request that HUNG, and classifies for real on the next pass", async () => {
        vi.useFakeTimers();
        try {
            let registryHangs = true;
            fetchMock.mockImplementation(async (url: string) => {
                if (url === ACTIVE_URL) return jsonResponse(['mail-server']);
                if (url === REGISTRY_URL) {
                    return registryHangs
                        ? new Promise<Response>(() => { })   // connected, never answers
                        : registryResponse([registryEntry('mail-server', { hooks: 'client/Ext.tsx' })]);
                }
                return jsonResponse({}, 404);
            });
            const { loadRuntimePluginHooks } = await freshLoader();

            // Pass 1: the classification times out (2s bound) and stays silent, as it should.
            const first = loadRuntimePluginHooks();
            await vi.advanceTimersByTimeAsync(2500);
            await expect(first).resolves.toBeUndefined();
            expect(console.warn).not.toHaveBeenCalled();
            expect(fetchMock.mock.calls.filter(([u]) => u === REGISTRY_URL)).toHaveLength(1);

            // Backend recovers, admin layout remounts. The hung attempt must NOT still be memoized.
            // The second advance is what keeps the PRE-FIX failure loud rather than a runner timeout:
            // pre-fix, pass 2 replays the dead promise and needs the call-site bound to expire before it
            // resolves — it then fails on the re-fetch assertion below instead of hanging the suite.
            registryHangs = false;
            const second = loadRuntimePluginHooks();
            await vi.advanceTimersByTimeAsync(2500);
            await expect(second).resolves.toBeUndefined();
            expect(fetchMock.mock.calls.filter(([u]) => u === REGISTRY_URL)).toHaveLength(2);
            expect(console.warn).toHaveBeenCalledWith(
                expect.stringContaining("plugin 'mail-server' declares frontend.hooks"));
            // And the recovered pass must not leave the bound's timer armed either.
            expect(vi.getTimerCount()).toBe(0);
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
 * ASK ONLY THE PLUGINS THAT HAVE HOOKS. Every admin screen runs this pass, and it used to request
 * `?type=hooks` from EVERY active plugin — one of the 31 catalog plugins declares hooks, so a typical site
 * paid a silent 404 per plugin on every admin navigation. The registry (one entry per active plugin,
 * fetched once per pass) says which ones declare `frontend.hooks`; only those are asked — plus every
 * plugin it cannot vouch for, so a registry problem never costs a plugin its hooks.
 */
describe("hooks bundles are requested only for plugins whose registry entry declares hooks", () => {
    const hooksRequests = (): string[] =>
        fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('type=hooks')).sort();

    it("asks only the plugins that declare hooks, or that the registry cannot vouch for", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(['faq', 'backend-only', 'mail-server', 'ghost', 'newcomer']);
            if (url === REGISTRY_URL) return registryResponse([
                registryEntry('faq', {}),                     // a frontend, no hooks → not asked
                registryEntry('backend-only', undefined),     // no frontend section → not asked
                registryEntry('mail-server', { hooks: true }),
                registryEntry('ghost', null),                 // manifest unreadable: unknown → asked
                // 'newcomer' is not listed (a registry older than the active list) → asked
            ]);
            return jsonResponse({}, 404);
        });
        const { loadRuntimePluginHooks } = await freshLoader();

        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();

        expect(hooksRequests()).toEqual([
            '/api/v1/plugins/ghost/bundle?type=hooks',
            '/api/v1/plugins/mail-server/bundle?type=hooks',
            '/api/v1/plugins/newcomer/bundle?type=hooks',
        ]);
    });

    it("still asks a plugin that declares hooks without the browser:script grant (the 404 then explains it)", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(['mail-server']);
            if (url === REGISTRY_URL) return registryResponse([registryEntry('mail-server', { hooks: true }, false)]);
            return jsonResponse({}, 404);
        });
        const { loadRuntimePluginHooks } = await freshLoader();
        await loadRuntimePluginHooks();
        expect(hooksRequests()).toEqual(['/api/v1/plugins/mail-server/bundle?type=hooks']);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"browser:script" permission is not granted'));
    });

    it("asks every active plugin when the registry cannot be read", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(['faq', 'mail-server']);
            if (url === REGISTRY_URL) return jsonResponse({}, 502);
            return jsonResponse({}, 404);
        });
        const { loadRuntimePluginHooks } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(hooksRequests()).toEqual([
            '/api/v1/plugins/faq/bundle?type=hooks',
            '/api/v1/plugins/mail-server/bundle?type=hooks',
        ]);
    });

    it("re-reads the registry with the active list: a plugin updated to ship hooks is asked after the reload", async () => {
        let declaresHooks = false;
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(['faq']);
            if (url === REGISTRY_URL) return registryResponse([registryEntry('faq', declaresHooks ? { hooks: true } : {})]);
            return jsonResponse({}, 404);
        });
        const { loadRuntimePluginHooks, invalidateActivePluginIds } = await freshLoader();

        await loadRuntimePluginHooks();
        expect(hooksRequests()).toEqual([]);

        declaresHooks = true;               // the update landed; reloadActivePlugins() invalidates and re-runs
        invalidateActivePluginIds();
        await loadRuntimePluginHooks();
        expect(hooksRequests()).toEqual(['/api/v1/plugins/faq/bundle?type=hooks']);
        expect(fetchMock.mock.calls.filter(([u]) => u === REGISTRY_URL)).toHaveLength(2);
    });
});

/**
 * THE BLANK ADMIN PAGE. With a plugin ACTIVE but `browser:script` NOT granted, the host refuses its
 * admin bundle (404), and /admin/plugin/<slug> rendered a completely empty page: loadPluginBundle
 * RESOLVED an empty `() => null` component on any non-OK response, so the fallback of
 * createRemotePluginComponent — and the generated page's "Plugin Not Found" passed into it — could never
 * render. Now the load REJECTS with the cause; a refusal by the browser:script gate renders a notice that
 * names the switch and links to that plugin's permissions, and every other failure renders the caller's
 * fallback. Never nothing.
 */
describe("a refused plugin admin page explains itself instead of rendering nothing", () => {
    const BUNDLE = (slug: string) => `/api/v1/plugins/${slug}/bundle?type=admin`;
    /** Visible text of rendered markup, entities decoded the two ways React emits them here. */
    const textOf = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
    const Fallback = () => React.createElement('h1', null, 'Plugin Not Found');

    it("REJECTS with reason 'not-granted' when the registry says browser:script is off (was: an empty component)", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === REGISTRY_URL) return registryResponse([registryEntry('conference-manager', {}, false)]);
            return jsonResponse({ error: 'Bundle not found' }, 404);
        });
        const { loadPluginBundle, PluginBundleError } = await freshLoader();

        const err = await loadPluginBundle('conference-manager').then(() => null, (e: unknown) => e);

        expect(err).toBeInstanceOf(PluginBundleError);
        expect(err).toMatchObject({ reason: 'not-granted', pluginId: 'conference-manager', status: 404 });
        expect(fetchMock.mock.calls.map(([u]) => u)).toContain(BUNDLE('conference-manager'));
    });

    it("resolves an ADMIN-PAGE slug to its plugin through the admin menu (the registry lists folders)", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === REGISTRY_URL) return registryResponse([registryEntry('mail-server', { hooks: true }, false)]);
            if (url === MENUS_URL) return jsonResponse([
                { href: '/admin', label: 'Dashboard', plugin: 'core' },
                { href: '/admin/plugin/emails', label: 'Emails', plugin: 'mail-server' },
            ]);
            return jsonResponse({ error: 'Bundle not found' }, 404);
        });
        const { loadPluginBundle } = await freshLoader();
        await expect(loadPluginBundle('emails')).rejects.toMatchObject({ reason: 'not-granted', pluginId: 'mail-server' });
    });

    it("does not guess when two plugins claim the same admin page (a menu href is plugin-controlled)", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === REGISTRY_URL) return registryResponse([registryEntry('mail-server', {}, false), registryEntry('impostor', {}, true)]);
            if (url === MENUS_URL) return jsonResponse([
                { href: '/admin/plugin/emails', plugin: 'mail-server' },
                { href: '/admin/plugin/emails?tab=x', plugin: 'impostor' },
            ]);
            return jsonResponse({}, 404);
        });
        const { loadPluginBundle } = await freshLoader();
        await expect(loadPluginBundle('emails')).rejects.toMatchObject({ reason: 'not-found', pluginId: null });
    });

    it("a 404 for a plugin that IS granted, or that no active plugin answers to, is 'not-found'", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === REGISTRY_URL) return registryResponse([registryEntry('faq', {}, true)]);
            if (url === MENUS_URL) return jsonResponse([]);
            return jsonResponse({}, 404);
        });
        const { loadPluginBundle } = await freshLoader();
        await expect(loadPluginBundle('faq')).rejects.toMatchObject({ reason: 'not-found' });
        await expect(loadPluginBundle('never-installed')).rejects.toMatchObject({ reason: 'not-found', pluginId: null });
    });

    it("a 5xx or a network failure is 'failed' — and is not cached, so the next mount asks again", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
        fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));
        const { loadPluginBundle } = await freshLoader();
        await expect(loadPluginBundle('faq')).rejects.toMatchObject({ reason: 'failed', status: 503 });
        await expect(loadPluginBundle('faq')).rejects.toMatchObject({ reason: 'failed', status: null });
        expect(fetchMock.mock.calls.filter(([u]) => u === BUNDLE('faq'))).toHaveLength(2);
        // A 5xx is not a refusal: nothing to classify.
        expect(fetchMock.mock.calls.some(([u]) => u === REGISTRY_URL)).toBe(false);
    });

    it("classifies from a FRESH registry: a grant revoked after the session's memo is still explained", async () => {
        let granted = true;
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(['conference-manager']);
            if (url === REGISTRY_URL) return registryResponse([registryEntry('conference-manager', {}, granted)]);
            return jsonResponse({}, 404);
        });
        const { loadRuntimePluginHooks, loadPluginBundle } = await freshLoader();
        await loadRuntimePluginHooks();     // the admin layout memoizes the registry (granted)
        granted = false;                    // the administrator revokes browser:script in another tab
        await expect(loadPluginBundle('conference-manager')).rejects.toMatchObject({ reason: 'not-granted' });
        expect(fetchMock.mock.calls.filter(([u]) => u === REGISTRY_URL)).toHaveLength(2);
    });

    it("renders the browser:script notice, with a link to that plugin's permissions", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === REGISTRY_URL) return registryResponse([registryEntry('mail-server', {}, false)]);
            if (url === MENUS_URL) return jsonResponse([{ href: '/admin/plugin/emails', plugin: 'mail-server' }]);
            return jsonResponse({}, 404);
        });
        const { loadRemotePluginModule } = await freshLoader();

        const mod = await loadRemotePluginModule('emails', 'admin', Fallback);
        const html = renderToStaticMarkup(React.createElement(mod.default));

        expect(textOf(html)).toContain(
            "This plugin's interface is not served until you grant 'Run code in your browser' (browser:script) in Admin → Plugins → Permissions");
        expect(html).toContain('href="/admin/plugins?permissions=mail-server"');
        expect(textOf(html)).not.toContain('Plugin Not Found');
    });

    it("renders the caller's fallback for every other failure — never an empty page", async () => {
        const { loadRemotePluginModule } = await freshLoader();
        for (const answer of [jsonResponse({}, 404), jsonResponse({}, 502)]) {
            fetchMock.mockImplementation(async (url: string) => {
                if (url === REGISTRY_URL) return registryResponse([]);
                if (url === MENUS_URL) return jsonResponse([]);
                return answer;
            });
            const mod = await loadRemotePluginModule('acme', 'admin', Fallback);
            expect(renderToStaticMarkup(React.createElement(mod.default))).toBe('<h1>Plugin Not Found</h1>');
        }
    });

    it("loads the page on the next mount once the grant is given (the refusal was not cached)", async () => {
        installImportableBundleShim();
        let granted = false;
        fetchMock.mockImplementation(async (url: string) => {
            if (url === REGISTRY_URL) return registryResponse([registryEntry('conference-manager', {}, granted)]);
            if (url === BUNDLE('conference-manager')) {
                return granted
                    ? textResponse('export default function ConferencePage() { return "conference admin"; }\n')
                    : jsonResponse({}, 404);
            }
            return jsonResponse({}, 404);
        });
        const { loadRemotePluginModule } = await freshLoader();

        const refused = await loadRemotePluginModule('conference-manager', 'admin', Fallback);
        expect(textOf(renderToStaticMarkup(React.createElement(refused.default)))).toContain('browser:script');

        granted = true;
        const page = await loadRemotePluginModule('conference-manager', 'admin', Fallback);
        expect(renderToStaticMarkup(React.createElement(page.default))).toBe('conference admin');
    });
});

/**
 * The same refusal, reached the way the generated admin page reaches it: createRemotePluginComponent(slug,
 * 'admin', <Plugin Not Found>). The suite above drives loadRemotePluginModule directly, which proves the
 * choice but not that the page's entry point makes it — a createRemotePluginComponent whose loader called
 * loadPluginBundle and mapped every rejection to the fallback would leave the not-granted notice
 * unreachable from the page while those cases stayed green.
 */
describe("createRemotePluginComponent — what /admin/plugin/<slug> renders when its bundle is refused", () => {
    const textOf = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
    const Fallback = () => React.createElement('h1', null, 'Plugin Not Found');
    /** Await the loader next/dynamic would, then render the module's component as the page would. */
    async function renderPage(slug: string): Promise<string> {
        const { createRemotePluginComponent } = await freshLoader();
        const loader = createRemotePluginComponent(slug, 'admin', Fallback) as unknown as () => Promise<{ default: React.ComponentType }>;
        const mod = await loader();
        return renderToStaticMarkup(React.createElement(mod.default));
    }

    it("a not-granted 404 renders the browser:script notice linking to the plugin's permissions (by FOLDER id)", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === REGISTRY_URL) return registryResponse([registryEntry('mail-server', {}, false)]);
            if (url === MENUS_URL) return jsonResponse([{ href: '/admin/plugin/emails', plugin: 'mail-server' }]);
            return jsonResponse({ error: 'Bundle not found' }, 404);
        });
        const html = await renderPage('emails');
        expect(html).toContain('href="/admin/plugins?permissions=mail-server"');
        expect(textOf(html)).toContain("not served until you grant 'Run code in your browser' (browser:script)");
        expect(textOf(html)).not.toContain('Plugin Not Found');
        expect(fetchMock.mock.calls.map(([u]) => u)).toContain('/api/v1/plugins/emails/bundle?type=admin');
    });

    it("an unknown plugin (404 nobody answers for) renders the page's fallback, not the notice", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === REGISTRY_URL) return registryResponse([registryEntry('faq', {}, true)]);
            if (url === MENUS_URL) return jsonResponse([]);
            return jsonResponse({}, 404);
        });
        expect(await renderPage('never-installed')).toBe('<h1>Plugin Not Found</h1>');
    });

    it("a 502 renders the page's fallback, not the notice (and asks no registry: it is not a refusal)", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === REGISTRY_URL) return registryResponse([registryEntry('mail-server', {}, false)]);
            return jsonResponse({}, 502);
        });
        expect(await renderPage('mail-server')).toBe('<h1>Plugin Not Found</h1>');
        expect(fetchMock.mock.calls.some(([u]) => u === REGISTRY_URL)).toBe(false);
    });
});

/**
 * GET /plugins/registry reports a plugin's browser:script grant (`browser`) only to a signed-in caller with
 * admin-panel access; everyone else gets the entries without it (backend/src/routes/plugins.ts). So the
 * loader must ask WITH the session — the admin shell's notice and warning are built from that flag — and
 * must never read a missing flag as "not granted" (or, for hooks, as "never built").
 */
describe("the registry's browser:script grant: asked with the session, never assumed when absent", () => {
    const Fallback = () => React.createElement('h1', null, 'Plugin Not Found');
    /** An entry as the registry answers a caller without admin-panel access: no `browser`. */
    const withoutGrant = (id: string, frontend: unknown) => ({ id, path: `/plugins/${id}`, frontend });

    it("asks the registry with the session — on a refused admin page and in the hooks pass", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(['conference-manager']);
            if (url === REGISTRY_URL) return registryResponse([registryEntry('conference-manager', { hooks: true }, false)]);
            return jsonResponse({}, 404);
        });
        const { loadRuntimePluginHooks, loadPluginBundle } = await freshLoader();
        await loadRuntimePluginHooks();
        await expect(loadPluginBundle('conference-manager')).rejects.toMatchObject({ reason: 'not-granted' });
        const registryCalls = fetchMock.mock.calls.filter(([u]) => u === REGISTRY_URL);
        expect(registryCalls).toHaveLength(2);
        for (const [, init] of registryCalls) expect(init).toMatchObject({ credentials: 'same-origin' });
    });

    it("an entry that does not report the grant is never 'not granted': the page renders its fallback", async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === REGISTRY_URL) return registryResponse([withoutGrant('conference-manager', {})]);
            if (url === MENUS_URL) return jsonResponse([]);
            return jsonResponse({}, 404);
        });
        const { loadPluginBundle, loadRemotePluginModule } = await freshLoader();
        await expect(loadPluginBundle('conference-manager')).rejects.toMatchObject({ reason: 'not-found', pluginId: 'conference-manager' });
        const mod = await loadRemotePluginModule('conference-manager', 'admin', Fallback);
        expect(renderToStaticMarkup(React.createElement(mod.default))).toBe('<h1>Plugin Not Found</h1>');
    });

    it("a hooks 404 the registry cannot explain without the grant is not called 'never built' — a later pass explains it", async () => {
        let entry: unknown = withoutGrant('mail-server', { hooks: true });
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(['mail-server']);
            if (url === REGISTRY_URL) return registryResponse([entry]);
            return jsonResponse({}, 404);
        });
        const { loadRuntimePluginHooks, invalidateActivePluginIds } = await freshLoader();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(console.warn).not.toHaveBeenCalled();

        // The next pass asks with a session that gets the grant: the same 404 is explained for real.
        entry = registryEntry('mail-server', { hooks: true }, false);
        invalidateActivePluginIds();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"browser:script" permission is not granted'));
    });
});

/**
 * The piece of the SUCCESS path that needs no substitution at all.
 *
 * The happy path ends in `import()` of a `blob:` URL, which the runner's node environment cannot perform.
 * The concurrency suite further down reaches the 200 path anyway, by swapping that ONE step for an
 * equivalent node can run; this describe needs no such swap, because the convention that makes a hooks
 * bundle do anything — invoke every export named `register*` — was factored out for exactly that reason.
 * It is exercised against a plain module object below, the same shape `Object.keys` sees on a real module
 * namespace.
 */
describe("invokeHookRegistrars — the register* convention a hooks bundle relies on", () => {
    it("invokes every export whose name starts with `register`, once each", async () => {
        const { invokeHookRegistrars } = await freshLoader();
        const registerUserForm = vi.fn();
        const registerDashboardCard = vi.fn();
        invokeHookRegistrars('mail-server', { registerUserForm, registerDashboardCard });
        expect(registerUserForm).toHaveBeenCalledTimes(1);
        expect(registerDashboardCard).toHaveBeenCalledTimes(1);
    });

    it("ignores exports that are not register* functions (default component, config objects, constants)", async () => {
        const { invokeHookRegistrars } = await freshLoader();
        const notARegistrar = vi.fn();
        const deregisterAll = vi.fn();
        // `registerPath` is a STRING: a name match must never be enough to call something.
        invokeHookRegistrars('mail-server', {
            default: notARegistrar, deregisterAll, registerPath: '/admin/mail', setup: notARegistrar,
        });
        expect(notARegistrar).not.toHaveBeenCalled();
        expect(deregisterAll).not.toHaveBeenCalled();
    });

    it("logs a THROWING registrar and still runs the rest (one broken extension must not blank the others)", async () => {
        const { invokeHookRegistrars } = await freshLoader();
        const registerBroken = vi.fn(() => { throw new Error('boom'); });
        const registerHealthy = vi.fn();
        expect(() => invokeHookRegistrars('mail-server', { registerBroken, registerHealthy })).not.toThrow();
        expect(registerHealthy).toHaveBeenCalledTimes(1);
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('Error in hook mail-server'), expect.any(Error));
    });
});

/**
 * ONE registration per plugin — including when two passes OVERLAP.
 *
 * Reachable, not theoretical: plugins.ts runs the build-time loader and this runtime loader under a
 * SINGLE run-once latch and un-latches it as soon as EITHER rejects — while the other may still be in
 * flight — so the next admin-layout mount starts a second runtime pass on top of the first. The guard
 * used to be a Set written only AFTER a bundle had been fetched and evaluated; two passes overlapping
 * anywhere in that window both read it empty, both fetched, and both invoked the plugin's `register*`
 * exports. The first test below MEASURES 2 against that shape — it is this fix's negative control.
 *
 * Not cosmetic: pluginHooks replaces a prior entry only when the plugin passes a `key`. mail-server does,
 * so its toggle merely overwrites itself; a third-party extension registered keyless stacks, and renders
 * twice — the duplicate-UI bug initPlugins' latch exists to prevent.
 *
 * These tests reach the 200 path via installImportableBundleShim (see above), which substitutes the one
 * step node cannot run — `blob:` → an equivalent `data:` URL — and nothing else.
 */
describe("hooks registration is deduped per plugin, across SEQUENTIAL and CONCURRENT passes", () => {
    it("registers ONCE when two passes run simultaneously (the Set-guard shape registered twice)", async () => {
        installImportableBundleShim();
        const code = hooksBundle('concurrent');
        fetchMock.mockImplementation(async (url: string) =>
            url === ACTIVE_URL ? jsonResponse(['mail-server']) : textResponse(code));
        const { loadRuntimePluginHooks } = await freshLoader();

        // Both passes are in flight together: the second starts while the first is still awaiting its
        // very first fetch, which is exactly the window a post-hoc "already done" Set cannot cover.
        await Promise.all([loadRuntimePluginHooks(), loadRuntimePluginHooks()]);

        expect(registrations('concurrent')).toBe(1);
        // The mechanism, not just the outcome: the second caller JOINED the first attempt.
        expect(hooksFetches()).toBe(1);
    });

    it("registers ONCE across two sequential passes (the session guarantee the Set did provide)", async () => {
        installImportableBundleShim();
        const code = hooksBundle('sequential');
        fetchMock.mockImplementation(async (url: string) =>
            url === ACTIVE_URL ? jsonResponse(['mail-server']) : textResponse(code));
        const { loadRuntimePluginHooks } = await freshLoader();

        await loadRuntimePluginHooks();
        await loadRuntimePluginHooks();   // the admin layout remounts on every navigation

        expect(registrations('sequential')).toBe(1);
        expect(hooksFetches()).toBe(1);
    });

    // Guards against "fixing" the race by memoizing every outcome forever. A 404 registered NOTHING, so
    // it must not latch: the admin may run build-plugin.js and remount, and that pass has to find it.
    it("does NOT memoize a 404 — a plugin built between two passes still registers", async () => {
        installImportableBundleShim();
        const code = hooksBundle('rebuilt');
        let built = false;
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(['mail-server']);
            if (url === REGISTRY_URL) return registryResponse([]);       // nothing to classify → silent
            return built ? textResponse(code) : jsonResponse({}, 404);
        });
        const { loadRuntimePluginHooks } = await freshLoader();

        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(registrations('rebuilt')).toBe(0);

        built = true;
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(registrations('rebuilt')).toBe(1);
    });

    it("does NOT memoize a FAILED attempt — the retry after a 5xx registers for real", async () => {
        installImportableBundleShim();
        const code = hooksBundle('retry');
        let failing = true;
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(['mail-server']);
            return failing ? jsonResponse({}, 503) : textResponse(code);
        });
        const { loadRuntimePluginHooks } = await freshLoader();

        await expect(loadRuntimePluginHooks()).rejects.toThrow(/failed to load/);
        expect(registrations('retry')).toBe(0);

        failing = false;   // gateway back up, initPlugins un-latched, next mount retries
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(registrations('retry')).toBe(1);
    });
});

/**
 * THE HOOKED UI'S CLASSES. A hooks extension renders inside ANOTHER admin screen (mail-server's toggle in
 * the user form), where the plugin's admin.css is never linked — and a runtime-installed plugin gets no
 * Tailwind from the host build. build-plugin.js compiles the classes into dist/hooks.bundle.css; the
 * loader must link it once the bundle registers, or the extension renders unstyled on a live site.
 */
describe("hooks registration links the hooks bundle's stylesheet", () => {
    /** The slice of `document` the loader touches, recording what it appends to <head>. */
    function stubDocument(): Array<{ rel: string; href: string; attrs: Record<string, string> }> {
        const links: Array<{ rel: string; href: string; attrs: Record<string, string> }> = [];
        vi.stubGlobal('document', {
            head: { appendChild: (el: (typeof links)[number]) => { links.push(el); return el; } },
            createElement: () => {
                const attrs: Record<string, string> = {};
                return { rel: '', href: '', attrs, setAttribute: (k: string, v: string) => { attrs[k] = v; } };
            },
            querySelector: (sel: string) => {
                const m = /^link\[data-plugin-hooks-css="([^"]+)"\]$/.exec(sel);
                return (m && links.find((l) => l.attrs['data-plugin-hooks-css'] === m[1])) || null;
            },
        });
        return links;
    }

    it("links /bundle/css?type=hooks ONCE per plugin, after the bundle evaluates", async () => {
        installImportableBundleShim();
        const links = stubDocument();
        const code = hooksBundle('styled');
        fetchMock.mockImplementation(async (url: string) =>
            url === ACTIVE_URL ? jsonResponse(['mail-server']) : textResponse(code));
        const { loadRuntimePluginHooks, invalidateActivePluginIds } = await freshLoader();

        await loadRuntimePluginHooks();
        invalidateActivePluginIds();
        await loadRuntimePluginHooks();

        expect(registrations('styled')).toBe(1);
        expect(links).toHaveLength(1);
        expect(links[0].rel).toBe('stylesheet');
        expect(links[0].href).toBe('/api/v1/plugins/mail-server/bundle/css?type=hooks');
    });

    it("links nothing for a plugin that ships no hooks bundle (404)", async () => {
        const links = stubDocument();
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse(['faq']);
            if (url === REGISTRY_URL) return registryResponse([registryEntry('faq', null)]);
            return jsonResponse({}, 404);
        });
        const { loadRuntimePluginHooks } = await freshLoader();

        await loadRuntimePluginHooks();

        expect(links).toHaveLength(0);
    });
});

/**
 * ACTIVATING A PLUGIN MID-SESSION — the memo must be invalidated, because nothing else will.
 *
 * The active-plugin list was memoized for the whole session on the claim that it "only changes when an
 * admin activates/deactivates a plugin (which reloads the page)". The parenthetical is false:
 * admin/plugins/page.tsx's togglePlugin and confirmActivate `await pluginsApi.activate/deactivate(...)`
 * and then only call loadPlugins() + refreshMenus(), which re-fetch into React state — there is no
 * location.reload / router.refresh anywhere in that flow. In production nothing regenerates the
 * build-time registry either (regenerateRegistry() returns early when NODE_ENV=production), so the
 * runtime loader is the ONLY path to a just-activated plugin — and it was replaying a list captured
 * before the activation. Net effect: the admin activates mail-server, and its hooks and Puck blocks stay
 * dead until the tab is manually reloaded. That is the exact bug this loader exists to eliminate.
 *
 * The list is served here from a MUTABLE array, the way the backend behaves: /plugins/active answers
 * differently from the moment the activation succeeds.
 */
describe("activate mid-session — the memoized active list must be invalidated, not replayed", () => {
    it("keeps serving the memo until invalidateActivePluginIds(), then re-reads /plugins/active", async () => {
        const active: string[] = [];
        fetchMock.mockImplementation(async (url: string) =>
            url === ACTIVE_URL ? jsonResponse([...active]) : jsonResponse({}, 404));
        const { fetchActivePluginIds, invalidateActivePluginIds } = await freshLoader();

        await expect(fetchActivePluginIds()).resolves.toEqual([]);
        expect(activeFetches()).toBe(1);

        // The admin activates mail-server. Nothing has told the loader yet, so the memo still stands —
        // that part is deliberate: the hot path must not re-fetch per caller, and must not poll.
        active.push('mail-server');
        await expect(fetchActivePluginIds()).resolves.toEqual([]);
        expect(activeFetches()).toBe(1);

        invalidateActivePluginIds();
        await expect(fetchActivePluginIds()).resolves.toEqual(['mail-server']);
        expect(activeFetches()).toBe(2);
        // …and the fresh answer is memoized in turn: still one fetch per session, not one per caller.
        await expect(fetchActivePluginIds()).resolves.toEqual(['mail-server']);
        expect(activeFetches()).toBe(2);
    });

    it("registers the newly activated plugin's hooks on the next pass, with no page reload", async () => {
        installImportableBundleShim();
        const code = hooksBundle('activated-midsession');
        const active: string[] = [];
        fetchMock.mockImplementation(async (url: string) =>
            url === ACTIVE_URL ? jsonResponse([...active]) : textResponse(code));
        const { loadRuntimePluginHooks, invalidateActivePluginIds } = await freshLoader();

        // Admin layout mounts on a fresh install: nothing is active, so nothing registers.
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();
        expect(registrations('activated-midsession')).toBe(0);

        // POST /plugins/mail-server/activate returned 200 → what reloadActivePlugins() does next.
        active.push('mail-server');
        invalidateActivePluginIds();
        await expect(loadRuntimePluginHooks()).resolves.toBeUndefined();

        expect(registrations('activated-midsession')).toBe(1);
    });

    it("re-running the pass does NOT re-register a plugin an earlier pass already handled", async () => {
        installImportableBundleShim();
        const active = ['mail-server'];
        // A DISTINCT bundle per plugin: identical sources share one data: URL, which the module loader
        // caches — the two plugins would then evaluate the same module and the counters could not be
        // told apart.
        fetchMock.mockImplementation(async (url: string) => {
            if (url === ACTIVE_URL) return jsonResponse([...active]);
            return textResponse(hooksBundle(
                String(url).includes('online-store') ? 'activated-second' : 'already-registered'));
        });
        const { loadRuntimePluginHooks, invalidateActivePluginIds } = await freshLoader();

        await loadRuntimePluginHooks();
        expect(registrations('already-registered')).toBe(1);

        // The admin now activates a SECOND plugin; the pass re-runs over both. mail-server's registration
        // is memoized on its in-flight promise, so it is joined — not re-fetched, not re-invoked.
        active.push('online-store');
        invalidateActivePluginIds();
        await loadRuntimePluginHooks();

        expect(registrations('already-registered')).toBe(1);
        expect(registrations('activated-second')).toBe(1);
        expect(hooksFetches()).toBe(2);   // one per plugin, never twice for the same one
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
            expect.stringContaining("Blocks unavailable for 'broken'"), expect.anything());
    });
});

/**
 * The editor was renamed to Verso, but a plugin's block bundle is a COMPILED artifact published by a
 * third party: every catalog bundle on disk still exports the historical `puckComponents` /
 * `puckComponentDef`, and nothing in this repo rebuilds them. If the loader read only the new names it
 * would resolve `{}` for all of them — every marketplace block would disappear from the editor
 * silently, with no error to trace. So BOTH spellings are read, new first.
 */
describe("blocksFromModule — the block-export contract accepts the new AND the historical names", () => {
    const def = { label: 'FAQ', fields: {}, defaultProps: {} };
    const render = () => null;

    it("MULTI, new name: `versoComponents` is spread as-is", async () => {
        const { blocksFromModule } = await freshLoader();
        expect(blocksFromModule('faq', { versoComponents: { A: def, B: def } })).toEqual({ A: def, B: def });
    });

    it("MULTI, historical name: `puckComponents` still works (the 31 published bundles)", async () => {
        const { blocksFromModule } = await freshLoader();
        expect(blocksFromModule('faq', { puckComponents: { A: def } })).toEqual({ A: def });
    });

    it("SINGLE, new name: `versoComponentDef` + default is composed under the PascalCase slug", async () => {
        const { blocksFromModule } = await freshLoader();
        expect(blocksFromModule('online-store', { versoComponentDef: def, default: render }))
            .toEqual({ OnlineStore: { ...def, render } });
    });

    it("SINGLE, historical name: `puckComponentDef` + default is composed identically", async () => {
        const { blocksFromModule } = await freshLoader();
        expect(blocksFromModule('online-store', { puckComponentDef: def, default: render }))
            .toEqual({ OnlineStore: { ...def, render } });
    });

    it("the NEW name wins when a bundle somehow exports both", async () => {
        const { blocksFromModule } = await freshLoader();
        const fresh = { Fresh: def };
        expect(blocksFromModule('faq', { versoComponents: fresh, puckComponents: { Old: def } })).toEqual(fresh);
    });

    it("a bundle exporting neither yields {} (no block, not a crash)", async () => {
        const { blocksFromModule } = await freshLoader();
        expect(blocksFromModule('faq', { default: render })).toEqual({});
    });
});
