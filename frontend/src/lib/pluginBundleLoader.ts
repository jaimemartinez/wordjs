/**
 * WordJS Plugin Bundle Loader
 * 
 * Loads pre-compiled plugin bundles dynamically at runtime.
 * CRITICAL: Injects React singleton to prevent "Invalid Hook Call" errors.
 * 
 * The bundles are compiled with externals (react, react-dom) which
 * reference global WordJS.* objects that we inject here.
 */

import React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';
import dynamic from 'next/dynamic';
import { ComponentType } from 'react';
// Host modules exposed to plugin bundles. Plugins import these (as `@/…` or via a relative path into
// frontend/src); build-plugin.js rewrites those specifiers to `window.WordJS.host['<key>']` so the
// plugin uses the host's OWN module instance — shared session for api(), the host's providers for
// useI18n()/useModal()/useToast(), one React tree. KEEP THIS SET IN SYNC with HOST_MODULES in
// backend/scripts/build-plugin.js (a plugin importing a module not injected here fails the bundle build).
import * as h_api from '@/lib/api';
import * as h_i18n from '@/lib/i18n';
import * as h_pluginHooks from '@/lib/plugin-hooks';
import * as h_modalContext from '@/contexts/ModalContext';
import * as h_i18nContext from '@/contexts/I18nContext';
import * as h_toastContext from '@/contexts/ToastContext';
import * as h_authContext from '@/contexts/AuthContext';
import * as h_mediaPickerModal from '@/components/MediaPickerModal';
import * as h_statCard from '@/components/ui/StatCard';
import * as h_pageHeader from '@/components/ui/PageHeader';
import * as h_card from '@/components/ui/Card';
import * as h_actionCard from '@/components/ui/ActionCard';

const HOST_MODULES: Record<string, unknown> = {
    'lib/api': h_api,
    'lib/i18n': h_i18n,
    'lib/plugin-hooks': h_pluginHooks,
    'contexts/ModalContext': h_modalContext,
    'contexts/I18nContext': h_i18nContext,
    'contexts/ToastContext': h_toastContext,
    'contexts/AuthContext': h_authContext,
    'components/MediaPickerModal': h_mediaPickerModal,
    'components/ui/StatCard': h_statCard,
    'components/ui/PageHeader': h_pageHeader,
    'components/ui/Card': h_card,
    'components/ui/ActionCard': h_actionCard,
};

// ============================================
// React Singleton Injection
// ============================================

/**
 * Expose React to the global scope for plugin bundles.
 * This MUST match the externals configuration in build-plugin.js
 */
if (typeof window !== 'undefined') {
    // Create WordJS namespace for plugin runtime
    (window as any).WordJS = {
        React: React,
        ReactDOM: ReactDOM,
        ReactDOMClient: ReactDOMClient,
        JSXRuntime: JSXRuntime,
        host: HOST_MODULES,
    };

    // Also expose directly for UMD-style bundles
    (window as any).React = React;
    (window as any).ReactDOM = ReactDOM;
}

// ============================================
// Bundle Cache
// ============================================

const bundleCache: Map<string, React.ComponentType<any>> = new Map();
const loadingPromises: Map<string, Promise<React.ComponentType<any>>> = new Map();

// ============================================
// Bundle Loader
// ============================================

/**
 * Load a pre-compiled plugin bundle from the API
 * 
 * @param slug - Plugin slug
 * @param bundleType - Type of bundle (admin, component, hooks)
 * @returns Promise resolving to a React component
 */
export async function loadPluginBundle(
    slug: string,
    bundleType: 'admin' | 'component' | 'hooks' = 'admin'
): Promise<React.ComponentType<any>> {
    const cacheKey = `${slug}:${bundleType}`;

    // Return cached component
    if (bundleCache.has(cacheKey)) {
        return bundleCache.get(cacheKey)!;
    }

    // Return in-flight promise if already loading
    if (loadingPromises.has(cacheKey)) {
        return loadingPromises.get(cacheKey)!;
    }

    // Start loading
    const loadPromise = (async () => {
        try {
            // Fetch the bundle
            const response = await fetch(`/api/v1/plugins/${slug}/bundle?type=${bundleType}`);

            if (!response.ok) {
                console.warn(`[PluginLoader] Bundle not found for ${slug}/${bundleType}`);
                return () => null; // Return empty component
            }

            const bundleCode = await response.text();

            // Create a blob URL for the module
            const blob = new Blob([bundleCode], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);

            try {
                // Dynamic import the blob URL
                const module = await import(/* webpackIgnore: true */ blobUrl);

                // Clean up blob URL
                URL.revokeObjectURL(blobUrl);

                // Get the default export (the React component)
                const Component = module.default || module;

                // Cache and return
                bundleCache.set(cacheKey, Component);
                return Component;

            } catch (evalError) {
                console.error(`[PluginLoader] Failed to evaluate bundle for ${slug}:`, evalError);
                URL.revokeObjectURL(blobUrl);
                return () => null;
            }

        } catch (fetchError) {
            console.error(`[PluginLoader] Failed to fetch bundle for ${slug}:`, fetchError);
            return () => null;
        } finally {
            // Clean up loading promise
            loadingPromises.delete(cacheKey);
        }
    })();

    loadingPromises.set(cacheKey, loadPromise);
    return loadPromise;
}

/**
 * Create a dynamic component that loads from a plugin bundle
 * Use this in place of static imports for plugin components
 */
export function createRemotePluginComponent(
    slug: string,
    bundleType: 'admin' | 'component' | 'hooks' = 'admin',
    fallback: ComponentType<any> = () => null
): ComponentType<any> {
    return dynamic(
        () => loadPluginBundle(slug, bundleType).catch((err) => {
            console.warn(`[PluginLoader] Error loading ${slug}:`, err);
            return { default: fallback };
        }),
        {
            loading: () => null,
            ssr: false, // Bundles are client-only
        }
    );
}

// ============================================
// Active-plugin list (shared by every runtime loader below)
// ============================================

// Memoized: the block loader, the hooks loader and every editor mount ask for the SAME list, so the hot
// path costs one request, not one per caller. The list is not immutable for the session, though — an
// admin activating or deactivating a plugin changes it, and does NOT reload the page while doing so
// (admin/plugins/page.tsx's togglePlugin / confirmActivate only re-fetch into React state). That is what
// invalidateActivePluginIds() below is for: the memo is dropped on that EVENT, never re-validated by
// polling.
// ONLY a SUCCESSFUL response is memoized — a failed attempt clears this back to null (see below).
let activePromise: Promise<string[]> | null = null;

/**
 * Forget the memoized active-plugin list, so the NEXT fetchActivePluginIds() asks the backend again.
 *
 * Called from lib/plugins.ts' reloadActivePlugins(), which the admin plugins page runs right after a
 * successful activate/deactivate (and which then re-runs the hook pass, so a newly activated plugin's UI
 * extensions appear without a manual reload).
 *
 * Without it the memo taken BEFORE the activation was replayed for the rest of the session: the new
 * plugin was missing from every later `ids` list, so neither its hooks nor its Puck blocks ever loaded —
 * precisely the invisible-marketplace-plugin bug this runtime loader exists to eliminate, just moved from
 * "the build never saw it" to "the cache never saw it".
 *
 * Cheap, and safe to call redundantly: it drops a cached VALUE, it does not cancel work. An attempt still
 * in flight keeps running for whoever already awaited it and merely loses its claim on the cache slot —
 * the identity guard in fetchActivePluginIds sees `activePromise !== attempt` and leaves the fresh state
 * alone.
 *
 * What it deliberately does NOT do: un-register anything. pluginHooks has no removal API, so a
 * DEACTIVATED plugin's already-registered UI extensions survive until the page is reloaded; invalidating
 * here is what stops the stale list from ALSO hiding the next activation.
 */
export function invalidateActivePluginIds(): void {
    activePromise = null;
}

/**
 * The slugs of the currently ACTIVE plugins.
 *
 * REJECTS when the list could not be obtained (network failure, non-2xx, unparseable or non-array body),
 * and does NOT memoize that failure so the next caller re-fetches.
 *
 * WHY, in detail: this is the FIRST network call loadRuntimePluginHooks() makes. Collapsing a failure to
 * `[]` — as this did — defeated the whole retry design downstream: a restarting gateway answering 502/503
 * produced an empty id list → nothing to load → allSettled([]) had no rejections → loadRuntimePluginHooks
 * RESOLVED → initPlugins() saw success and kept its run-once guard latched → every marketplace plugin's
 * frontend hooks stayed dead for the rest of the session, with nothing logged. Worse, the empty result was
 * cached module-wide and never invalidated, so even a retry triggered by some other failure re-read the
 * cached `[]` and registered nothing — permanently.
 *
 * An empty list from a HEALTHY backend (HTTP 200 `[]`) is a real answer, not a failure: it resolves `[]`
 * and stays cached until invalidateActivePluginIds() drops it (activating the FIRST plugin of a fresh
 * install is exactly that transition, so it must be an invalidation and not a special case). A 200 whose
 * body is not an array is NOT an answer (e.g. a proxy's HTML error page) — caching it as "no plugins"
 * would reproduce exactly the silent-death bug above, so it rejects too.
 *
 * Every caller must handle the rejection: loadRuntimePluginHooks() lets it propagate (initPlugins
 * un-latches and the next admin-layout mount retries); useRuntimePuckConfig() catches it, because block
 * loading is best-effort and must never break a page render.
 *
 * Resolves `[]` on the SERVER without fetching: the URL is relative, so Node's fetch cannot parse it and
 * would reject. Both current callers are client-only, but this is exported — an SSR caller must keep
 * getting the old "nothing to load" answer rather than a rejection that now propagates. Deliberately not
 * memoized, so it cannot poison the cache for anything running in the same process.
 */
export function fetchActivePluginIds(): Promise<string[]> {
    if (typeof window === 'undefined') return Promise.resolve([]);
    if (activePromise) return activePromise;
    const attempt: Promise<string[]> = (async () => {
        const res = await fetch('/api/v1/plugins/active');
        if (!res.ok) throw new Error(`GET /api/v1/plugins/active failed: HTTP ${res.status}`);
        const body: unknown = await res.json();
        if (!Array.isArray(body)) throw new Error('GET /api/v1/plugins/active returned a non-array body');
        return body as string[];
    })();
    activePromise = attempt;
    // Un-memoize a FAILED attempt so the next mount re-fetches instead of replaying it forever. Attached
    // AFTER the assignment (rather than inside the async body, which TS rightly rejects as reading
    // `attempt` before it is assigned) and identity-guarded, so a newer in-flight attempt is never evicted
    // by an older failure. This handler is on a DERIVED promise: `attempt` itself still rejects for the
    // caller, and the derived one is handled here, so clearing the cache never causes an unhandled
    // rejection of its own.
    attempt.catch(() => { if (activePromise === attempt) activePromise = null; });
    return attempt;
}

// ============================================
// Puck block loading (runtime, marketplace plugins)
// ============================================

const blockConfigCache = new Map<string, Promise<Record<string, any>>>();
const blockCssInjected = new Set<string>();

function toPascalCase(slug: string): string {
    return slug.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

// Load the CSS esbuild extracted next to a plugin's block bundle (dist/component.bundle.css). Served via
// the /plugins static route (which maps slug→folder), so the block's styles apply in editor + canvas.
function injectBlockCss(pluginId: string): void {
    if (typeof document === 'undefined' || blockCssInjected.has(pluginId)) return;
    blockCssInjected.add(pluginId);
    const href = `/plugins/${pluginId}/dist/component.bundle.css`;
    if (document.querySelector(`link[data-plugin-block-css="${pluginId}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-plugin-block-css', pluginId);
    // A plugin may ship no block CSS — a 404 <link> is harmless (no error surfaced to the user).
    document.head.appendChild(link);
}

/**
 * Load a single plugin's Puck block config(s) at runtime from its pre-compiled `component` bundle.
 * Returns a map keyed by BLOCK NAME (the `type` stored in Puck data), matching the build-time registry:
 *   - single block: `{ [PascalName(pluginId)]: { ...puckComponentDef, render: default } }`
 *   - multi block:  the plugin's own `puckComponents` map, spread as-is
 * Empty object — memoized for the session — when the plugin genuinely ships no block bundle (404) or
 * ships one that cannot be evaluated (a deterministic, no-point-retrying failure).
 *
 * REJECTS, and does NOT memoize, on any OTHER failure (network error, 5xx from a restarting gateway,
 * 400): those are transient and the previous "collapse everything to {} and cache it" behaviour was the
 * same silent-death bug fetchActivePluginIds had — one 502 during the first editor mount permanently
 * removed every marketplace plugin's Puck blocks for the rest of the session, because the poisoned {}
 * was replayed from blockConfigCache on every later render. Callers keep block loading BEST-EFFORT
 * (loadActivePluginBlocks catches per plugin), so a rejection never breaks a page render — it just lets
 * the next render try again.
 */
export async function loadPluginBlockConfigs(pluginId: string): Promise<Record<string, any>> {
    const cached = blockConfigCache.get(pluginId);
    if (cached) return cached;
    const p = (async () => {
        const response = await fetch(`/api/v1/plugins/${pluginId}/bundle?type=component`);
        // 404 is the only status that means "this plugin ships no Puck blocks" — a real answer, cacheable.
        if (response.status === 404) return {};
        if (!response.ok) {
            throw new Error(`block bundle fetch for '${pluginId}' failed: HTTP ${response.status}`);
        }
        const code = await response.text();
        const blob = new Blob([code], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        try {
            const mod: any = await import(/* webpackIgnore: true */ url);
            URL.revokeObjectURL(url);
            injectBlockCss(pluginId);
            if (mod.puckComponents && typeof mod.puckComponents === 'object') {
                return mod.puckComponents as Record<string, any>;
            }
            if (mod.puckComponentDef) {
                return { [toPascalCase(pluginId)]: { ...mod.puckComponentDef, render: mod.default } };
            }
            return {};
        } catch (e) {
            // The bytes arrived but are not loadable JS: retrying re-downloads the same broken bundle, so
            // this one IS cached. It is loud, because it always means the plugin needs a rebuild.
            URL.revokeObjectURL(url);
            console.warn(`[PluginLoader] Failed to evaluate block bundle for ${pluginId}:`, e);
            return {};
        }
    })();
    blockConfigCache.set(pluginId, p);
    // Un-memoize a FAILED attempt so a later render re-fetches (same identity guard as activePromise: a
    // newer in-flight attempt must never be evicted by an older failure). Attached to a DERIVED promise,
    // so `p` still rejects for the caller and this handler is not itself an unhandled rejection.
    p.catch(() => { if (blockConfigCache.get(pluginId) === p) blockConfigCache.delete(pluginId); });
    return p;
}

/**
 * Load + merge the Puck block configs of every given plugin (typically the ACTIVE plugins).
 * Best-effort by design: one plugin's failure is logged and skipped, never propagated — this runs on
 * PUBLIC page renders, where a plugin block going missing must not take the page down with it.
 */
export async function loadActivePluginBlocks(pluginIds: string[]): Promise<Record<string, any>> {
    const maps = await Promise.all(pluginIds.map((id) => loadPluginBlockConfigs(id).catch((e) => {
        console.warn(`[PluginLoader] Puck blocks unavailable for '${id}':`, e);
        return {};
    })));
    return Object.assign({}, ...maps);
}

// ============================================
// Frontend hook loading (runtime, marketplace plugins)
// ============================================

// One registration per plugin per session — including across passes that OVERLAP. This is the IN-FLIGHT
// promise of a plugin's registration, deliberately, not a post-hoc "already done" Set: a Set can only be
// written AFTER the bundle has been fetched and evaluated, so two passes overlapping anywhere in that
// window both read an empty Set, both fetched, and both invoked the plugin's register* exports.
//
// Overlapping passes are reachable, not theoretical: plugins.ts runs the build-time and the runtime hook
// loaders under ONE run-once latch and un-latches it on the FIRST of the two to reject — while the other
// is still in flight — so the next admin-layout mount starts a second runtime pass on top of the first.
// A measured probe (two simultaneous loadRuntimePluginHooks() calls) registered mail-server TWICE.
//
// Since reloadActivePlugins() there is now also allowed to start a pass on demand (every activate /
// deactivate the admin performs, in a session where the previous pass may still be running), this memo is
// what keeps a REPEATED pass free: the plugins registered by an earlier pass are joined, not re-fetched
// and not re-registered, so only the genuinely new plugin does any work.
//
// Registering twice is invisible only for a plugin that passes pluginHooks KEYS, which make a repeat
// registration replace rather than append. mail-server does; a third-party plugin registering keyless
// callbacks stacks duplicate UI — precisely the duplicate-toggle bug initPlugins' latch exists to
// prevent. So dedupe on the promise, the same shape loadingPromises and blockConfigCache already use:
// concurrent callers JOIN the one attempt instead of racing it. Only a registration that actually
// HAPPENED stays memoized — see loadPluginHooksBundle.
const hooksRegistration = new Map<string, Promise<boolean>>();

// One warning per BROKEN plugin per session. loadRuntimePluginHooks() is retried on later mounts
// (whenever ANY plugin failed), and a 404 is deliberately evicted from hooksRegistration rather than
// memoized, so without this every retry would re-log the same line. It also has to survive CONCURRENT
// 404s, hence the re-check after the await in warnIfHooksBundleShouldExist. Plugins that simply declare
// no hooks never land here — they are not warned about at all.
const hooksAbsentWarned = new Set<string>();

// The public plugin registry (GET /plugins/registry → each ACTIVE plugin's full manifest). Fetched
// LAZILY — only to classify a hooks-bundle 404 — so a healthy install pays nothing on the happy path.
// Same discipline as activePromise: only a SUCCESSFUL fetch is memoized, so a session makes at most ONE
// SUCCESSFUL registry request no matter how many 404s need classifying; a FAILED one — including one that
// never ANSWERS, see REGISTRY_CLASSIFY_TIMEOUT_MS — is deliberately not cached, so a later mount retries
// it (that retry is the only way a request count can exceed one).
let registryPromise: Promise<PluginRegistryEntry[]> | null = null;

// `frontend: null` is not "no frontend": routes/plugins.ts emits exactly that when it cannot READ the
// plugin's manifest.json (folder missing, or invalid JSON). A manifest without a `frontend` key leaves
// the property absent instead — which is how the two 404 causes are told apart below.
type PluginRegistryEntry = { id?: string; path?: string; frontend?: { hooks?: string } | null };

/**
 * The ACTUAL response shape of GET /plugins/registry is an OBJECT: backend/src/routes/plugins.ts ends
 * with `res.json({ plugins: registry })`, NOT a bare array — as frontend/src/lib/plugins-registry.ts has
 * always read it (`data.plugins || []`). Guarding with a plain `Array.isArray(body)` therefore rejected
 * EVERY well-formed response, so classification silently never ran in production and every hooks-bundle
 * 404 stayed unclassified. A bare array is still accepted, purely as tolerance for a hand-rolled proxy
 * that unwraps the envelope; the object form is the contract and the one the tests pin.
 */
function extractRegistryList(raw: unknown): PluginRegistryEntry[] {
    const list = Array.isArray(raw) ? raw : (raw as { plugins?: unknown } | null | undefined)?.plugins;
    if (!Array.isArray(list)) {
        throw new Error('GET /api/v1/plugins/registry returned no plugins array');
    }
    return list as PluginRegistryEntry[];
}

// Upper bound on how long CLASSIFYING a 404 may hold up the hook-loading pass. Diagnosing why a plugin
// shipped no hooks bundle is strictly a console-warning nicety; a registry request left hanging by a
// half-dead gateway (connected, never answering — no HTTP status, so no `!res.ok` rejection to lean on)
// must never be able to hold loadRuntimePluginHooks open indefinitely behind it.
const REGISTRY_CLASSIFY_TIMEOUT_MS = 2000;

/**
 * Reject after `ms` if `p` has not settled. The timer is ALWAYS cleared, including when `p` wins the
 * race: a `Promise.race` whose losing setTimeout is left armed keeps the event loop alive, which is
 * precisely the leak that made this repo's test runner flake under `--test-force-exit`.
 * `Promise.race` subscribes to `p`, so a late rejection from the loser is already handled and can never
 * surface as an unhandled rejection.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const expiry = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([p, expiry]).finally(() => clearTimeout(timer));
}

/**
 * The MEMOIZED promise is the BOUNDED one, deliberately. Bounding the request at the call site instead
 * (which is where the timeout used to live) left the un-bounded fetch memoized: a gateway that accepts
 * the connection and never answers produced a `registryPromise` that never settles, so the `.catch`
 * un-memo below never ran, every later mount replayed the same dead promise and waited out the 2s timeout
 * again, and classification stayed dead for the rest of the session — even after the backend recovered —
 * until the socket finally errored. Racing INSIDE the memo turns "never answered" into a real rejection,
 * which is the only thing that can evict it.
 */
function fetchPluginRegistry(): Promise<PluginRegistryEntry[]> {
    if (registryPromise) return registryPromise;
    const attempt: Promise<PluginRegistryEntry[]> = withTimeout((async () => {
        const res = await fetch('/api/v1/plugins/registry');
        if (!res.ok) throw new Error(`GET /api/v1/plugins/registry failed: HTTP ${res.status}`);
        return extractRegistryList(await res.json());
    })(), REGISTRY_CLASSIFY_TIMEOUT_MS, 'plugin registry classification');
    registryPromise = attempt;
    attempt.catch(() => { if (registryPromise === attempt) registryPromise = null; });
    return attempt;
}

/**
 * Why an ACTIVE plugin's `?type=hooks` request came back 404.
 *  - 'none'       → it declares no `frontend.hooks`. The overwhelmingly common case (1 of the 31
 *                   catalog plugins declares hooks); it is NORMAL and must stay silent.
 *  - 'not-built'  → it DOES declare `frontend.hooks`, so dist/hooks.bundle.js should exist: the install
 *                   was never built, or its dist/ was lost. Actionable.
 *  - 'unreadable' → the backend could not read its manifest.json at all. Broken install. Actionable.
 */
type HooksAbsence = 'none' | 'not-built' | 'unreadable';

async function classifyMissingHooksBundle(pluginId: string): Promise<HooksAbsence> {
    const registry = await fetchPluginRegistry();
    const entry = registry.find((e) => e && (e.id === pluginId || e.path === `/plugins/${pluginId}`));
    // Not in the registry at all: it is no longer active (deactivated between the two fetches). Nothing
    // to report — the hooks of an inactive plugin are supposed to be absent.
    if (!entry) return 'none';
    if (entry.frontend === null) return 'unreadable';
    return typeof entry.frontend?.hooks === 'string' && entry.frontend.hooks.length > 0
        ? 'not-built'
        : 'none';
}

/**
 * Warn — once per plugin per session — only when a hooks-bundle 404 is a REAL problem. Never throws:
 * a plugin without hooks is not an error, and neither is failing to classify one.
 */
async function warnIfHooksBundleShouldExist(pluginId: string): Promise<void> {
    if (hooksAbsentWarned.has(pluginId)) return;
    let cause: HooksAbsence;
    try {
        cause = await classifyMissingHooksBundle(pluginId);
    } catch {
        // The registry is unreachable, malformed, or too slow to wait for (fetchPluginRegistry bounds
        // itself at REGISTRY_CLASSIFY_TIMEOUT_MS) — all transient conditions that say nothing about this
        // plugin, and ones the caller is already dealing with elsewhere. Stay silent rather than emit an
        // alarming line per active plugin; fetchPluginRegistry memoized none of those failures, the
        // timeout included, so a later mount re-fetches and classifies for real.
        return;
    }
    if (cause === 'none') return;
    // Re-check after the await: concurrent 404s for the same plugin must still log only once.
    if (hooksAbsentWarned.has(pluginId)) return;
    hooksAbsentWarned.add(pluginId);
    console.warn(
        cause === 'not-built'
            ? `[PluginLoader] ACTIVE plugin '${pluginId}' declares frontend.hooks but its hooks bundle is ` +
              `missing (HTTP 404), so its UI extensions will not appear. It was never built, or its dist/ ` +
              `was lost: node scripts/build-plugin.js ${pluginId}`
            : `[PluginLoader] ACTIVE plugin '${pluginId}' has no readable manifest.json (its plugin folder ` +
              `is missing, or the manifest is invalid JSON), so no hooks bundle could be served. The ` +
              `install is broken — reinstall the plugin.`
    );
}

/**
 * Invoke every export of an evaluated hooks bundle whose name starts with `register`.
 *
 * Exported so it can be unit-tested against a PLAIN module object: the only other way in is
 * loadPluginHooksBundle's `import()` of a `blob:` URL, which the test runner's node environment cannot
 * perform — leaving this convention (the whole point of a hooks bundle) with no coverage at all.
 * Deliberately tolerant, because the input is third-party code: a non-function export named `registerX`
 * is skipped, and a register() that THROWS is logged and does not stop the remaining ones (a plugin's
 * second extension must still register when its first one is broken).
 */
export function invokeHookRegistrars(pluginId: string, mod: Record<string, unknown>): void {
    for (const key of Object.keys(mod)) {
        const fn = mod[key];
        if (key.startsWith('register') && typeof fn === 'function') {
            try { (fn as () => void)(); } catch (e) { console.error(`[PluginLoader] Error in hook ${pluginId}:`, e); }
        }
    }
}

/**
 * Register ONE plugin's frontend hooks from its pre-compiled `hooks` bundle, AT MOST ONCE per session.
 *
 * The memo entry is the IN-FLIGHT attempt, published in the same synchronous run that starts it (nothing
 * between the call and the `.set` can yield), so a second caller arriving anywhere in the fetch/evaluate
 * window joins it instead of starting its own — which a "have I finished?" Set structurally cannot do,
 * since it can only be written once that window has already closed. See hooksRegistration.
 *
 * Only a registration that actually HAPPENED stays memoized:
 *  - resolves true  → the bundle was evaluated and its registrars ran. Kept, so no later pass repeats it.
 *  - resolves false → 404: nothing was registered. Evicted, because the 404 may be an install that was
 *                     never built (see below) and a later mount must be free to find a repaired one.
 *  - rejects        → transient by construction (5xx / network / unloadable bytes). Evicted so the next
 *                     mount retries; loadRuntimePluginHooks propagates it and initPlugins un-latches.
 */
function loadPluginHooksBundle(pluginId: string): Promise<boolean> {
    const inFlight = hooksRegistration.get(pluginId);
    if (inFlight) return inFlight;
    const attempt = fetchAndRegisterPluginHooks(pluginId);
    hooksRegistration.set(pluginId, attempt);
    // Identity-guarded exactly like activePromise / blockConfigCache, so a newer attempt is never evicted
    // by an older one settling late. Attached to a DERIVED promise: `attempt` itself still settles for the
    // caller, and the rejection is handled here, so eviction can never raise an unhandled rejection.
    attempt.then(
        (registered) => {
            if (!registered && hooksRegistration.get(pluginId) === attempt) hooksRegistration.delete(pluginId);
        },
        () => { if (hooksRegistration.get(pluginId) === attempt) hooksRegistration.delete(pluginId); },
    );
    return attempt;
}

/**
 * Fetch + evaluate + register one plugin's hooks bundle. Call it through loadPluginHooksBundle, never
 * directly: on its own it has no dedupe at all.
 *
 * Convention (identical to the build-time registry generated by generate-plugin-registry.js): every
 * exported function whose name starts with `register` is invoked once. A plugin's hooks entry therefore
 * exports e.g. `registerUserFormExtension()`, which calls pluginHooks.addAction/addFilter. The bundle
 * resolves `@/lib/plugin-hooks` to WordJS.host['lib/plugin-hooks'], so it registers into the HOST's
 * pluginHooks singleton — the same one <PluginHook> and applyFilters() read.
 *
 * Resolves false on 404 — normally "this plugin declares no `frontend.hooks`", which is silent; a broken
 * or unbuilt install 404s identically, and is told apart from it (and warned about) via the plugin's
 * manifest. REJECTS if the bundle exists but could not be fetched or evaluated, so the caller can retry;
 * an individual register() that throws is logged and does not fail the load.
 */
async function fetchAndRegisterPluginHooks(pluginId: string): Promise<boolean> {
    const response = await fetch(`/api/v1/plugins/${pluginId}/bundle?type=hooks`);
    // 404 is the only status that can mean "no hooks bundle" — 400 is a bad slug/type and a restarting
    // gateway yields 502/503. Treating every non-ok status as "no bundle" made those transient failures
    // resolve `false`, so loadRuntimePluginHooks saw no rejection, initPlugins never un-latched its
    // run-once guard, and the plugin's hooks were silently dead for the rest of the session. Throw
    // instead — a rejected attempt is evicted from hooksRegistration, so the next mount retries it.
    //
    // But 404 is NOT proof the plugin merely ships no hooks: routes/plugin-bundles.ts resolves the slug to
    // a folder FIRST and returns 404 whenever that resolution fails — unknown slug, missing plugin
    // directory, or a manifest.json that is unreadable/invalid (its JSON.parse error is swallowed) — as
    // well as for a genuinely absent dist/hooks.bundle.js. Resolving that ambiguity needs no new backend
    // status codes: GET /plugins/registry already exposes every ACTIVE plugin's manifest, and its
    // `frontend.hooks` field says whether the plugin ever asked for a hooks bundle. So classify the 404
    // and warn ONLY when something is actually wrong. Warning on every 404 instead — as this did — put
    // one scary "the install is broken" line per hook-less plugin in the console of a perfectly healthy
    // site (30 of the 31 catalog plugins declare no hooks), which teaches admins to ignore the one
    // breadcrumb that matters.
    if (response.status === 404) {
        await warnIfHooksBundleShouldExist(pluginId);
        return false;
    }
    if (!response.ok) {
        throw new Error(`hooks bundle fetch for '${pluginId}' failed: HTTP ${response.status}`);
    }
    const code = await response.text();
    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
        const mod: any = await import(/* webpackIgnore: true */ url);
        // Once the module is EVALUATED the registration counts as done, even if an individual extension is
        // broken: invokeHookRegistrars contains each registrar's own throw, so this resolves `true` and the
        // memo is KEPT. Retrying a throwing register() on the next mount would only throw again, having
        // re-run the registrars that did work — so committing here, before the fan-out, is deliberate.
        invokeHookRegistrars(pluginId, mod);
        return true;
    } finally {
        URL.revokeObjectURL(url);
    }
}

/**
 * Register the frontend hooks of every ACTIVE marketplace plugin, at runtime.
 *
 * Marketplace plugins are installed AFTER the frontend is built, so they cannot be in the build-time
 * registry: generate-plugin-registry.js reads backend/plugins at build time, a release ships zero plugins,
 * and in production nothing regenerates that file afterwards. Without this pass their hooks never register
 * and their UI extensions are invisible, e.g. mail-server's "Professional Mail Account" toggle in the user
 * form. Re-runnable on purpose — reloadActivePlugins() calls it after an activate/deactivate — and cheap
 * when re-run, because every plugin already handled is memoized in hooksRegistration.
 *
 * Rejects if the ACTIVE-PLUGIN LIST itself could not be fetched, or if any active plugin's hooks bundle
 * failed to LOAD (a plugin's own register() throwing is logged and swallowed) — so initPlugins can
 * un-latch its run-once guard and retry on the next mount. The list comes first, so it is the failure
 * that matters most: with it swallowed into `[]` there is nothing left to fail, and this resolved
 * "successfully" having registered nothing.
 */
export async function loadRuntimePluginHooks(): Promise<void> {
    if (typeof window === 'undefined') return;
    // A DEV/PROD split — read it for exactly that, NOT as "only plugins the build never saw".
    //
    // The generated registry (pluginRegistry.ts) statically imports the hooks SOURCE of every plugin that
    // was active when it was last generated, and its loadPluginHooks() runs them in EVERY NODE_ENV. What
    // the environment decides is who keeps that file CURRENT: regenerateRegistry() in
    // backend/src/routes/plugins.ts re-runs the generators after each activate/deactivate but returns
    // early when NODE_ENV=production, so only a dev server ever rewrites it — and Next's HMR then picks
    // the change up. In dev the static import is therefore both live and authoritative, and loading the
    // pre-compiled bundle on top would register a SECOND module instance out of a possibly stale dist/,
    // racing it. Hence: no runtime path in dev, and (the flip side, which is this whole file's reason to
    // exist) no static path in production, where regenerateRegistry() is a no-op and a marketplace plugin
    // installed after the build can never reach the baked-in registry.
    //
    // KNOWN AND ACCEPTED, in the other direction: a SELF-BUILT production image bakes whatever plugins
    // were active at `next build` time into that registry, and this pass loads the same plugins again
    // from their bundles — so their register* exports run TWICE, once per module instance. A RELEASE
    // build cannot hit it (it ships zero plugins, so the generated registry is empty), and on a self-built
    // one it is harmless TODAY: both registrations are identical and pluginHooks KEYS make a repeat
    // registration REPLACE rather than append — mail-server, the single catalog plugin declaring hooks,
    // passes keys. It is not guarded because the guard needs the generated registry to publish which
    // plugins' HOOKS it statically imported, and it publishes no such list: getRegisteredPlugins() returns
    // PRODUCTION_PLUGINS, which is filtered on componentPath, i.e. the plugins with an ADMIN PAGE — an
    // overlapping but different set. So a third-party plugin registering KEYLESS callbacks WOULD stack
    // duplicate UI on a self-built image; closing that means teaching generate-plugin-registry.js to emit
    // the hooks list too, and is deliberately left as a follow-up rather than guessed at from the wrong
    // list here.
    if (process.env.NODE_ENV === 'development') return;

    const ids = await fetchActivePluginIds();
    const results = await Promise.allSettled(ids.map((id) => loadPluginHooksBundle(id)));
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    failed.forEach((f) => console.error('[PluginLoader] Plugin hooks bundle failed to load:', f.reason));
    if (failed.length) throw new Error(`${failed.length} plugin hooks bundle(s) failed to load`);
}

/**
 * Check if a plugin has a pre-compiled bundle available
 */
export async function hasPluginBundle(slug: string): Promise<boolean> {
    try {
        const response = await fetch(`/api/v1/plugins/${slug}/bundle/manifest`);
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Clear the bundle cache (call after plugin updates)
 */
export function clearBundleCache(slug?: string): void {
    if (slug) {
        // Clear specific plugin
        for (const key of bundleCache.keys()) {
            if (key.startsWith(`${slug}:`)) {
                bundleCache.delete(key);
            }
        }
    } else {
        // Clear all
        bundleCache.clear();
    }
}

/**
 * Preload plugin bundles for faster subsequent loads
 */
export async function preloadPluginBundles(slugs: string[]): Promise<void> {
    await Promise.all(
        slugs.map(slug => loadPluginBundle(slug).catch(() => null))
    );
}
