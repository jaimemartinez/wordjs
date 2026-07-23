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
 * These are the only tests here that reach the 200 path, and they get there by substituting the single
 * step node cannot run: `URL.createObjectURL` hands back an equivalent `data:` URL instead of a `blob:`
 * one. Everything else is the loader's own code — fetch, status handling, module evaluation,
 * invokeHookRegistrars, and the memo bookkeeping actually under test — and the bundle source is the
 * `register*` convention the real esbuild output must satisfy. A genuine browser `blob:` import remains
 * out of reach in this runner; it is covered only by the LXC end-to-end pass.
 */
describe("hooks registration is deduped per plugin, across SEQUENTIAL and CONCURRENT passes", () => {
    // Swap ONLY blob:→data:, and do it with real subclasses so nothing else about either global changes
    // (`new URL(...)` and `new Blob(...)` keep working for everything else in the module graph).
    // vi.stubGlobal + the shared afterEach's unstubAllGlobals put both back.
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

    // A hooks bundle in the shape build-plugin.js emits: an ESM module whose `register*` export installs
    // the plugin's UI extension. It runs as its own module, so a global is its only way back to the test.
    // `marker` also keeps each test's data: URL unique — identical ones are cached by the module loader,
    // and a shared URL would let one test's evaluation stand in for another's.
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

    beforeEach(() => { (globalThis as any).__wjsHookRegistrations = {}; });
    afterEach(() => { delete (globalThis as any).__wjsHookRegistrations; });

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
