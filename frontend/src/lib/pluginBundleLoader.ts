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

// Cached for the whole session: the block loader, the hooks loader and every editor mount ask for the
// same list, and it only changes when an admin activates/deactivates a plugin (which reloads the page).
// ONLY a SUCCESSFUL response is memoized — a failed attempt clears this back to null (see below).
let activePromise: Promise<string[]> | null = null;

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
 * and stays cached. A 200 whose body is not an array is NOT an answer (e.g. a proxy's HTML error page) —
 * caching it as "no plugins" would reproduce exactly the silent-death bug above, so it rejects too.
 *
 * Every caller must handle the rejection: loadRuntimePluginHooks() lets it propagate (initPlugins
 * un-latches and the next admin-layout mount retries); useRuntimePuckConfig() catches it, because block
 * loading is best-effort and must never break a page render.
 */
export function fetchActivePluginIds(): Promise<string[]> {
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
 * Empty object when the plugin ships no block bundle (404) or fails to evaluate — never throws.
 */
export async function loadPluginBlockConfigs(pluginId: string): Promise<Record<string, any>> {
    const cached = blockConfigCache.get(pluginId);
    if (cached) return cached;
    const p = (async () => {
        try {
            const response = await fetch(`/api/v1/plugins/${pluginId}/bundle?type=component`);
            if (!response.ok) return {};
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
                URL.revokeObjectURL(url);
                console.warn(`[PluginLoader] Failed to evaluate block bundle for ${pluginId}:`, e);
                return {};
            }
        } catch {
            return {};
        }
    })();
    blockConfigCache.set(pluginId, p);
    return p;
}

/** Load + merge the Puck block configs of every given plugin (typically the ACTIVE plugins). */
export async function loadActivePluginBlocks(pluginIds: string[]): Promise<Record<string, any>> {
    const maps = await Promise.all(pluginIds.map((id) => loadPluginBlockConfigs(id).catch(() => ({}))));
    return Object.assign({}, ...maps);
}

// ============================================
// Frontend hook loading (runtime, marketplace plugins)
// ============================================

// One registration per plugin per session. loadRuntimePluginHooks() is retried by initPlugins() when a
// bundle fails, and the admin layout remounts on every navigation — without this an already-registered
// plugin would be re-evaluated (a second module instance of its extension) on each pass.
const hooksRegistered = new Set<string>();

// One 404 warning per plugin per session. loadRuntimePluginHooks() is retried on later mounts (whenever
// ANY plugin failed), and a 404 plugin is never added to hooksRegistered, so without this every retry
// would re-log the same line for every hook-less plugin.
const hooksAbsentWarned = new Set<string>();

/**
 * Register ONE plugin's frontend hooks from its pre-compiled `hooks` bundle.
 *
 * Convention (identical to the build-time registry generated by generate-plugin-registry.js): every
 * exported function whose name starts with `register` is invoked once. A plugin's hooks entry therefore
 * exports e.g. `registerUserFormExtension()`, which calls pluginHooks.addAction/addFilter. The bundle
 * resolves `@/lib/plugin-hooks` to WordJS.host['lib/plugin-hooks'], so it registers into the HOST's
 * pluginHooks singleton — the same one <PluginHook> and applyFilters() read.
 *
 * Resolves false on 404 — usually "this plugin declares no `frontend.hooks`", but a BROKEN INSTALL 404s
 * identically (see the note in the body), which is why that path also warns. REJECTS if the bundle exists
 * but could not be fetched or evaluated, so the caller can retry; an individual register() that throws is
 * logged and does not fail the load.
 */
async function loadPluginHooksBundle(pluginId: string): Promise<boolean> {
    if (hooksRegistered.has(pluginId)) return true;
    const response = await fetch(`/api/v1/plugins/${pluginId}/bundle?type=hooks`);
    // 404 is the only status that can mean "no hooks bundle" — 400 is a bad slug/type and a restarting
    // gateway yields 502/503. Treating every non-ok status as "no bundle" made those transient failures
    // resolve `false`, so loadRuntimePluginHooks saw no rejection, initPlugins never un-latched its
    // run-once guard, and the plugin's hooks were silently dead for the rest of the session. Throw
    // instead — the plugin is not in hooksRegistered yet, so the next admin-layout mount retries it.
    //
    // But 404 is NOT proof the plugin merely ships no hooks: routes/plugin-bundles.ts resolves the slug to
    // a folder FIRST and returns 404 whenever that resolution fails — unknown slug, missing plugin
    // directory, or a manifest.json that is unreadable/invalid (its JSON.parse error is swallowed) — as
    // well as for a genuinely absent dist/hooks.bundle.js. A broken install is therefore indistinguishable
    // from the normal case and would stay silent forever. We only reach here for a plugin the backend
    // reports as ACTIVE, so warn once per session: that is the admin's only breadcrumb when a plugin's UI
    // extension never appears. (Fixing the ambiguity properly means new backend status codes — out of
    // scope here; the warning names both causes.)
    if (response.status === 404) {
        if (!hooksAbsentWarned.has(pluginId)) {
            hooksAbsentWarned.add(pluginId);
            console.warn(
                `[PluginLoader] No hooks bundle for ACTIVE plugin '${pluginId}' (HTTP 404). Expected if it ` +
                `declares no frontend.hooks. Otherwise the install is broken (plugin folder missing or ` +
                `manifest.json invalid) or it was never built: node scripts/build-plugin.js ${pluginId}`
            );
        }
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
        // Mark BEFORE invoking: a register() that throws must not be retried on the next mount (it would
        // throw again), and pluginHooks keys already make a partial registration idempotent.
        hooksRegistered.add(pluginId);
        for (const key of Object.keys(mod)) {
            const fn = mod[key];
            if (key.startsWith('register') && typeof fn === 'function') {
                try { fn(); } catch (e) { console.error(`[PluginLoader] Error in hook ${pluginId}:`, e); }
            }
        }
        return true;
    } finally {
        URL.revokeObjectURL(url);
    }
}

/**
 * Register the frontend hooks of every ACTIVE marketplace plugin, at runtime.
 *
 * Marketplace plugins are installed AFTER the frontend is built, so they can never appear in the
 * build-time registry (generate-plugin-registry.js reads backend/plugins at build time, and a release
 * ships zero plugins) — without this their hooks never register and their UI extensions are invisible,
 * e.g. mail-server's "Professional Mail Account" toggle in the user form.
 *
 * Rejects if the ACTIVE-PLUGIN LIST itself could not be fetched, or if any active plugin's hooks bundle
 * failed to LOAD (a plugin's own register() throwing is logged and swallowed) — so initPlugins can
 * un-latch its run-once guard and retry on the next mount. The list comes first, so it is the failure
 * that matters most: with it swallowed into `[]` there is nothing left to fail, and this resolved
 * "successfully" having registered nothing.
 */
export async function loadRuntimePluginHooks(): Promise<void> {
    if (typeof window === 'undefined') return;
    // In development the generated registry statically imports each active plugin's hooks SOURCE, which
    // keeps hot-reload working. Loading the pre-compiled bundle too would register a second module
    // instance from a possibly stale dist/, racing the live one — so the runtime path is production-only
    // (the same IS_DEV split pluginRegistry.ts uses for admin pages).
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
