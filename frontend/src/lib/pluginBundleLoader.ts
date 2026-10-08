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
import PluginScriptNotGranted from '@/components/PluginScriptNotGranted';
// Host modules exposed to plugin bundles. Plugins import these (as `@/…` or via a relative path into
// frontend/src); build-plugin.js rewrites those specifiers to `window.WordJS.host['<key>']` so the
// plugin uses the host's OWN module instance — shared session for api(), the host's providers for
// useI18n()/useModal()/useToast(), one React tree. KEEP THIS SET IN SYNC with HOST_MODULES in
// backend/scripts/build-plugin.js (a plugin importing a module not injected here fails the bundle build).
import * as h_api from '@/lib/api';
import * as h_i18n from '@/lib/i18n';
import * as h_pluginHooks from '@/lib/plugin-hooks';
import * as h_sanitize from '@/lib/sanitize';
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
    // The isomorphic HTML sanitizer (DOMPurify on the client). Exposed so a plugin that must render
    // untrusted HTML — the mail-server's compose/reply innerHTML sink for hostile inbound email — uses
    // the ONE audited, mutation-XSS-safe sanitizer instead of vendoring its own. Client-safe: the
    // server-only sanitize-html require sits behind a `typeof window` guard the bundler drops.
    'lib/sanitize': h_sanitize,
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
 * Why loadPluginBundle could not hand back a plugin's UI.
 *  - 'not-granted' → the plugin is ACTIVE but the administrator has not granted it browser:script, so the
 *                    host deliberately does not serve its browser code (routes/plugin-bundles.ts). Not an
 *                    error: the gate working. The page says so and links to the switch.
 *  - 'not-found'   → a 404 that is not that: no active plugin answers to the slug, or it was never built.
 *  - 'failed'      → anything else: a non-404 status (a restarting gateway), a network failure, or bytes
 *                    that would not evaluate as a module.
 */
export type PluginBundleFailure = 'not-granted' | 'not-found' | 'failed';

export class PluginBundleError extends Error {
    readonly slug: string;
    readonly bundleType: string;
    readonly reason: PluginBundleFailure;
    /** The HTTP status of the bundle request, or null when no response arrived. */
    readonly status: number | null;
    /**
     * The plugin's FOLDER id when the refusal could be tied to an active plugin — the slug in the URL may
     * be its admin-page slug ("emails" for mail-server), and the permissions screen lists folders.
     */
    readonly pluginId: string | null;

    constructor(init: { slug: string; bundleType: string; reason: PluginBundleFailure; status: number | null; pluginId?: string | null; message: string; cause?: unknown }) {
        super(init.message);
        this.name = 'PluginBundleError';
        this.slug = init.slug;
        this.bundleType = init.bundleType;
        this.reason = init.reason;
        this.status = init.status;
        this.pluginId = init.pluginId ?? null;
        if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
    }
}

/**
 * Load a pre-compiled plugin bundle from the API
 *
 * Resolves to the bundle's React component. REJECTS with a PluginBundleError when there is no component
 * to render — it used to resolve an empty `() => null` component instead, so every consumer's fallback
 * (createRemotePluginComponent's, and through it the generated /admin/plugin/<slug> page's
 * "Plugin Not Found") was dead code: an active plugin whose browser:script grant is off rendered a
 * completely blank admin page, with nothing to say why. A failure is not cached, so the next mount asks
 * again (a grant given meanwhile takes effect without a reload).
 *
 * @param slug - Plugin slug (its folder, or the admin-page slug an active plugin declares)
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
            const fail = (reason: PluginBundleFailure, status: number | null, message: string, extra: { pluginId?: string | null; cause?: unknown } = {}) =>
                new PluginBundleError({ slug, bundleType, reason, status, message, ...extra });

            let response: Response;
            try {
                response = await fetch(`/api/v1/plugins/${slug}/bundle?type=${bundleType}`);
            } catch (fetchError) {
                console.error(`[PluginLoader] Failed to fetch bundle for ${slug}:`, fetchError);
                throw fail('failed', null, `bundle fetch for '${slug}' failed`, { cause: fetchError });
            }

            if (!response.ok) {
                // A 404 is every refusal the bundle route makes (not installed, inactive, not granted — one
                // answer to every caller, deliberately). What an admin-panel user's browser can tell apart is
                // whether it is the browser:script gate: GET /plugins/registry, asked with that user's
                // session, says so per active plugin (it says it to no one else).
                const refusal = response.status === 404 ? await classifyRefusedBundle(slug) : null;
                const reason: PluginBundleFailure = refusal ? refusal.reason : 'failed';
                if (reason === 'not-granted') {
                    console.info(`[PluginLoader] '${slug}' is active, but its browser code is not served: browser:script is not granted.`);
                } else {
                    console.warn(`[PluginLoader] Bundle not available for ${slug}/${bundleType} (HTTP ${response.status})`);
                }
                throw fail(reason, response.status, `bundle for '${slug}' not served (HTTP ${response.status}, ${reason})`, { pluginId: refusal?.pluginId ?? null });
            }

            const bundleCode = await response.text();

            // Create a blob URL for the module
            const blob = new Blob([bundleCode], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);

            try {
                // Dynamic import the blob URL
                const module = await import(/* webpackIgnore: true */ blobUrl);

                // Get the default export (the React component)
                const Component = module.default || module;

                // Cache and return
                bundleCache.set(cacheKey, Component);
                return Component;

            } catch (evalError) {
                console.error(`[PluginLoader] Failed to evaluate bundle for ${slug}:`, evalError);
                throw fail('failed', response.status, `bundle for '${slug}' could not be evaluated`, { cause: evalError });
            } finally {
                // Clean up blob URL
                URL.revokeObjectURL(blobUrl);
            }
        } finally {
            // Clean up loading promise
            loadingPromises.delete(cacheKey);
        }
    })();

    loadingPromises.set(cacheKey, loadPromise);
    return loadPromise;
}

/**
 * What a remote plugin component renders in place of a UI that could not be loaded: the browser:script
 * notice when that grant is what withholds it, the caller's fallback for anything else. Exported so the
 * choice is testable without next/dynamic (which renders nothing outside a browser).
 */
export function remotePluginFailureComponent(err: unknown, fallback: ComponentType<any>): ComponentType<any> {
    if (err instanceof PluginBundleError && err.reason === 'not-granted') {
        const pluginId = err.pluginId || err.slug;
        const NotGranted = () => React.createElement(PluginScriptNotGranted, { pluginId });
        NotGranted.displayName = 'PluginScriptNotGranted';
        return NotGranted;
    }
    return fallback;
}

/**
 * The module createRemotePluginComponent hands to next/dynamic: the bundle's component, or — when it
 * could not be loaded — remotePluginFailureComponent's. Never rejects.
 */
export function loadRemotePluginModule(
    slug: string,
    bundleType: 'admin' | 'component' | 'hooks',
    fallback: ComponentType<any>,
): Promise<{ default: ComponentType<any> }> {
    return loadPluginBundle(slug, bundleType).then(
        (Component) => ({ default: Component }),
        (err) => {
            console.warn(`[PluginLoader] Error loading ${slug}:`, err);
            return { default: remotePluginFailureComponent(err, fallback) };
        },
    );
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
        () => loadRemotePluginModule(slug, bundleType, fallback),
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
 * plugin was missing from every later `ids` list, so neither its hooks nor its plugin blocks ever loaded —
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
 *
 * The plugin registry memo goes with it: GET /plugins/registry is one entry per ACTIVE plugin, i.e. a
 * projection of the same list, and loadRuntimePluginHooks reads it to decide which plugins have a hooks
 * bundle to ask for. Kept past an activation (or an update that adds hooks) it would describe the
 * previous set of plugins.
 */
export function invalidateActivePluginIds(): void {
    activePromise = null;
    registryPromise = null;
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
 * un-latches and the next admin-layout mount retries); loadVersoPluginBlocks() catches it, because block
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
// Plugin block loading (runtime, marketplace plugins)
// ============================================

const blockConfigCache = new Map<string, Promise<Record<string, any>>>();
const blockCssInjected = new Set<string>();

function toPascalCase(slug: string): string {
    return slug.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/**
 * Read an evaluated block bundle's exports into the `{ blockName: def }` map the registry expects.
 *
 * BOTH SPELLINGS ARE ACCEPTED, new first: `versoComponents` / `versoComponentDef` are the names the
 * host uses since the editor was renamed to Verso, but a plugin bundle is a COMPILED artifact
 * published by a third party — the catalog bundles on disk export the historical `puckComponents` /
 * `puckComponentDef`, and nothing in this repo rebuilds them. Reading only the new names would
 * silently return `{}` for every one of them, i.e. every marketplace block would vanish from the
 * editor with no error raised anywhere.
 *
 * Exported so this resolution is unit-testable against a PLAIN module object: the only other way in
 * is loadPluginBlockConfigs' `import()` of a `blob:` URL, which the test runner's node environment
 * cannot perform — the same reason invokeHookRegistrars is exported.
 */
export function blocksFromModule(pluginId: string, mod: Record<string, any>): Record<string, any> {
    const multi = mod.versoComponents ?? mod.puckComponents;
    if (multi && typeof multi === 'object') return multi as Record<string, any>;
    const single = mod.versoComponentDef ?? mod.puckComponentDef;
    if (single) return { [toPascalCase(pluginId)]: { ...single, render: mod.default } };
    return {};
}

/**
 * Inject one plugin's block CSS <link> into an ARBITRARY document. Additive seam for the Verso editor
 * (F4): its canvas is an <iframe> with its OWN document (/admin/canvas-frame), so the link injected into
 * the top-level document by injectBlockCss below never reaches the canvas — the Verso plugin-block path
 * calls this with the frame's document once it exists. Deduped per DOCUMENT via the data attribute (not
 * the module-level Set, which tracks only the top-level document): an iframe reload produces a fresh
 * document that legitimately needs the link again.
 */
export function injectBlockCssInto(doc: Document, pluginId: string): void {
    if (!doc.head) return;
    if (doc.querySelector(`link[data-plugin-block-css="${pluginId}"]`)) return;
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/plugins/${pluginId}/dist/component.bundle.css`;
    link.setAttribute('data-plugin-block-css', pluginId);
    // A plugin may ship no block CSS — a 404 <link> is harmless (no error surfaced to the user).
    doc.head.appendChild(link);
}

// Load the CSS esbuild extracted next to a plugin's block bundle (dist/component.bundle.css). Served by
// the /plugins static route under the plugin's FOLDER id (the id every caller here passes — the active
// list's ids) and behind the same gate as the bundle itself (active + browser:script), so the block's
// styles apply in editor + canvas exactly when its code does.
function injectBlockCss(pluginId: string): void {
    if (typeof document === 'undefined' || blockCssInjected.has(pluginId)) return;
    blockCssInjected.add(pluginId);
    injectBlockCssInto(document, pluginId);
}

/**
 * Link the stylesheet that goes with a plugin's HOOKS bundle: dist/hooks.bundle.css, which carries the
 * Tailwind classes the hooked UI uses (compiled by backend/scripts/build-plugin.js). A hooks extension
 * renders inside ANOTHER admin screen — mail-server's toggle lives in the user form — where the plugin's
 * own admin.css is never linked, and a runtime-installed plugin gets no classes from the host build. Served
 * by GET /plugins/:slug/bundle/css, which answers 200 with an empty body when the plugin ships none, so
 * linking it unconditionally costs one cached request and logs nothing. Once per document.
 */
function injectHooksCss(pluginId: string): void {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.querySelector(`link[data-plugin-hooks-css="${pluginId}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/api/v1/plugins/${pluginId}/bundle/css?type=hooks`;
    link.setAttribute('data-plugin-hooks-css', pluginId);
    document.head.appendChild(link);
}

/**
 * Load a single plugin's block config(s) at runtime from its pre-compiled `component` bundle.
 * Returns a map keyed by BLOCK NAME (the `type` stored in the saved document), matching the
 * build-time registry:
 *   - single block: `{ [PascalName(pluginId)]: { ...versoComponentDef, render: default } }`
 *   - multi block:  the plugin's own `versoComponents` map, spread as-is
 * Both the new and the historical export names are read — see blocksFromModule.
 *
 * Empty object — memoized for the session — when the plugin genuinely ships no block bundle (404) or
 * ships one that cannot be evaluated (a deterministic, no-point-retrying failure).
 *
 * REJECTS, and does NOT memoize, on any OTHER failure (network error, 5xx from a restarting gateway,
 * 400): those are transient and the previous "collapse everything to {} and cache it" behaviour was the
 * same silent-death bug fetchActivePluginIds had — one 502 during the first editor mount permanently
 * removed every marketplace plugin's blocks for the rest of the session, because the poisoned {}
 * was replayed from blockConfigCache on every later render. Callers keep block loading BEST-EFFORT
 * (loadActivePluginBlocks catches per plugin), so a rejection never breaks a page render — it just lets
 * the next render try again.
 */
export async function loadPluginBlockConfigs(pluginId: string): Promise<Record<string, any>> {
    const cached = blockConfigCache.get(pluginId);
    if (cached) return cached;
    const p = (async () => {
        const response = await fetch(`/api/v1/plugins/${pluginId}/bundle?type=component`);
        // 404 is the only status that means "this plugin ships no blocks" — a real answer, cacheable.
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
            return blocksFromModule(pluginId, mod);
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
 * Load + merge the block configs of every given plugin (typically the ACTIVE plugins).
 * Best-effort by design: one plugin's failure is logged and skipped, never propagated — this runs on
 * PUBLIC page renders, where a plugin block going missing must not take the page down with it.
 */
export async function loadActivePluginBlocks(pluginIds: string[]): Promise<Record<string, any>> {
    const maps = await Promise.all(pluginIds.map((id) => loadPluginBlockConfigs(id).catch((e) => {
        console.warn(`[PluginLoader] Blocks unavailable for '${id}':`, e);
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
// 404s (see warnIfHooksBundleShouldExist). Plugins that simply declare no hooks never land here — they
// are not warned about at all.
const hooksAbsentWarned = new Set<string>();

// The public plugin registry (GET /plugins/registry → one MINIMAL entry per ACTIVE plugin: id, path,
// whether it declares `frontend.hooks` and, for a signed-in caller with admin-panel access only, whether
// its browser:script capability is granted — never the manifest, which an anonymous caller has no
// business reading). Asked with the session (fetchPluginRegistry), so the admin shell gets the grant;
// anywhere it is absent, a refusal is classified as "not found", never "not granted". Fetched ONCE per hook pass, next to the
// active list: it is what tells loadRuntimePluginHooks which active plugins have a hooks bundle to ask
// for at all (one request for the registry instead of one 404 per hook-less plugin on every admin
// screen), and what classifies the 404s that remain.
// Same discipline as activePromise: only a SUCCESSFUL fetch is memoized, so a session makes ONE
// successful registry request until invalidateActivePluginIds() drops it with the active list; a FAILED
// one — including one that never ANSWERS, see REGISTRY_CLASSIFY_TIMEOUT_MS — is deliberately not cached,
// so a later mount retries it. classifyRefusedBundle (a refused admin page) asks for a FRESH copy.
let registryPromise: Promise<PluginRegistryEntry[]> | null = null;

// `frontend: null` is not "no frontend": routes/plugins.ts emits exactly that when it cannot READ the
// plugin's manifest.json (folder missing, or invalid JSON). A manifest without a `frontend` key leaves
// the property absent instead — which is how the two 404 causes are told apart below.
// `browser: false` means the administrator has not granted the plugin browser:script, so the host
// deliberately does not serve its bundles (routes/plugin-bundles.ts) — a 404 that is the gate working.
// `browser` ABSENT means the registry did not say (the caller is not signed in, or has no admin-panel
// access): only an explicit `false` is ever read as "not granted".
// `hooks` is `true` from the current backend; an older one sent the manifest's entry path (a string).
type PluginRegistryEntry = { id?: string; path?: string; browser?: boolean; frontend?: { hooks?: string | boolean } | null };

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
function fetchPluginRegistry(opts: { fresh?: boolean } = {}): Promise<PluginRegistryEntry[]> {
    if (registryPromise && !opts.fresh) return registryPromise;
    const attempt: Promise<PluginRegistryEntry[]> = withTimeout((async () => {
        // WITH the session: the browser:script grant is in the answer only for a signed-in caller with
        // admin-panel access, and the not-granted notice and warning are built from it.
        const res = await fetch('/api/v1/plugins/registry', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`GET /api/v1/plugins/registry failed: HTTP ${res.status}`);
        return extractRegistryList(await res.json());
    })(), REGISTRY_CLASSIFY_TIMEOUT_MS, 'plugin registry classification');
    // A fresh copy replaces the memo: it is the newer answer.
    registryPromise = attempt;
    attempt.catch(() => { if (registryPromise === attempt) registryPromise = null; });
    return attempt;
}

/** The registry entry of plugin FOLDER `pluginId`, or undefined when it is not (or no longer) active. */
function registryEntryFor(registry: PluginRegistryEntry[], pluginId: string): PluginRegistryEntry | undefined {
    return registry.find((e) => e && (e.id === pluginId || e.path === `/plugins/${pluginId}`));
}

/** Does this registry entry declare a hooks bundle? (`true` from the current backend, a path from an older one.) */
function entryDeclaresHooks(entry: PluginRegistryEntry): boolean {
    return entry.frontend?.hooks === true
        || (typeof entry.frontend?.hooks === 'string' && entry.frontend.hooks.length > 0);
}

/**
 * Should `pluginId`'s hooks bundle be requested? Not when the registry POSITIVELY says the plugin declares
 * no `frontend.hooks` — the overwhelmingly common case (1 of the 31 catalog plugins declares hooks), which
 * used to cost one silent 404 per plugin on every admin screen. Every case the
 * registry cannot vouch for is still asked: no registry at all (unreachable — a hiccup there must never
 * cost a plugin its hooks), a plugin it does not list (a memo older than the active list), and
 * `frontend: null` (the backend could not read the manifest, so what it declares is unknown).
 */
function mayShipHooksBundle(registry: PluginRegistryEntry[] | null, pluginId: string): boolean {
    if (!registry) return true;
    const entry = registryEntryFor(registry, pluginId);
    if (!entry || entry.frontend === null) return true;
    return entryDeclaresHooks(entry);
}

// The admin menu entries a signed-in user can see (GET /plugins/menus): { href, plugin } among others.
type AdminMenuEntry = { href?: unknown; plugin?: unknown };

/**
 * The plugin FOLDER behind an admin-page slug, read from the admin menu: the page /admin/plugin/<slug> is
 * reached through the menu item its plugin registered, and that item names the plugin. Needed because the
 * URL carries the manifest's adminPage.slug ("emails"), the registry lists folders ("mail-server"), and
 * a plugin installed at runtime is not in the page's build-time slug → folder map. null when no item, or
 * more than one plugin, claims the page (an href is plugin-controlled — never guess between two).
 */
async function pluginFolderForAdminSlug(slug: string): Promise<string | null> {
    const items = await withTimeout((async () => {
        const res = await fetch('/api/v1/plugins/menus', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`GET /api/v1/plugins/menus failed: HTTP ${res.status}`);
        return res.json() as Promise<unknown>;
    })(), REGISTRY_CLASSIFY_TIMEOUT_MS, 'admin menu lookup');
    if (!Array.isArray(items)) return null;
    const page = `/admin/plugin/${slug}`;
    const owners = new Set<string>();
    for (const item of items as AdminMenuEntry[]) {
        if (!item || typeof item.href !== 'string' || typeof item.plugin !== 'string' || item.plugin === 'core') continue;
        if (item.href.split(/[?#]/)[0].replace(/\/+$/, '') === page) owners.add(item.plugin);
    }
    return owners.size === 1 ? [...owners][0] : null;
}

/**
 * Why GET /plugins/<slug>/bundle answered 404 — told apart here because the route itself must not: it is
 * anonymous, and "not installed", "inactive" and "not granted" are one answer to keep the install private.
 * An admin-panel user's browser reads which ACTIVE plugins are not granted browser:script from the
 * registry (GET /plugins/registry, asked with the session; it tells no one else). 'not-granted' when the
 * plugin behind the slug (by folder, or by admin-page slug through the admin menu) is active and its
 * entry says `browser: false`; 'not-found' otherwise — including an entry that does not say (a caller
 * without admin-panel access) and a registry that cannot be read: the generic fallback is the safe answer
 * to an unknown cause.
 *
 * Asks for a FRESH registry: this runs when a page is refused, and the grant may have changed since the
 * session's memo was taken (the permissions screen does not invalidate it).
 */
async function classifyRefusedBundle(slug: string): Promise<{ reason: 'not-granted' | 'not-found'; pluginId: string | null }> {
    try {
        const registry = await fetchPluginRegistry({ fresh: true });
        let entry = registryEntryFor(registry, slug);
        let folder: string | null = entry ? slug : null;
        if (!entry) {
            folder = await pluginFolderForAdminSlug(slug).catch(() => null);
            entry = folder ? registryEntryFor(registry, folder) : undefined;
        }
        if (!entry) return { reason: 'not-found', pluginId: null };
        const pluginId = typeof entry.id === 'string' && entry.id ? entry.id : folder;
        return { reason: entry.browser === false ? 'not-granted' : 'not-found', pluginId };
    } catch {
        return { reason: 'not-found', pluginId: null };
    }
}

/**
 * Why an ACTIVE plugin's `?type=hooks` request came back 404.
 *  - 'none'       → it declares no `frontend.hooks`. NORMAL and silent — and since loadRuntimePluginHooks
 *                   no longer asks such a plugin, reached only when the registry could not say so first.
 *  - 'not-built'  → it DOES declare `frontend.hooks`, so dist/hooks.bundle.js should exist: the install
 *                   was never built, or its dist/ was lost. Actionable.
 *  - 'unreadable' → the backend could not read its manifest.json at all. Broken install. Actionable.
 *  - 'not-granted'→ it declares hooks, but its browser:script capability is not granted, so the host
 *                   refuses to serve its browser code. The gate working — said once, as a pointer to
 *                   the switch, not as an error.
 *  - 'unknown'    → it declares hooks, and the registry did not say whether browser:script is granted
 *                   (it says so only to a signed-in caller with admin-panel access — a session that lapsed
 *                   mid-visit gets the anonymous answer). 'not-built' and 'not-granted' both fit: silent,
 *                   and not remembered, so a later pass with the session classifies it for real.
 */
type HooksAbsence = 'none' | 'not-built' | 'unreadable' | 'not-granted' | 'unknown';

/**
 * Classified from the registry the hook pass already fetched — never a second request in the same pass.
 * Throws when that pass had none (unreachable, malformed, too slow): the caller stays silent.
 */
function classifyMissingHooksBundle(pluginId: string, registry: PluginRegistryEntry[] | null): HooksAbsence {
    if (!registry) throw new Error('no plugin registry to classify with');
    const entry = registryEntryFor(registry, pluginId);
    // Not in the registry at all: it is no longer active (deactivated between the two fetches). Nothing
    // to report — the hooks of an inactive plugin are supposed to be absent.
    if (!entry) return 'none';
    if (entry.frontend === null) return 'unreadable';
    if (!entryDeclaresHooks(entry)) return 'none';
    if (entry.browser === false) return 'not-granted';
    return entry.browser === true ? 'not-built' : 'unknown';
}

/**
 * Warn — once per plugin per session — only when a hooks-bundle 404 is a REAL problem. Never throws:
 * a plugin without hooks is not an error, and neither is failing to classify one.
 */
async function warnIfHooksBundleShouldExist(pluginId: string, registry: PluginRegistryEntry[] | null): Promise<void> {
    if (hooksAbsentWarned.has(pluginId)) return;
    let cause: HooksAbsence;
    try {
        cause = classifyMissingHooksBundle(pluginId, registry);
    } catch {
        // The registry is unreachable, malformed, or too slow to wait for (fetchPluginRegistry bounds
        // itself at REGISTRY_CLASSIFY_TIMEOUT_MS) — all transient conditions that say nothing about this
        // plugin, and ones the caller is already dealing with elsewhere. Stay silent rather than emit an
        // alarming line per active plugin; fetchPluginRegistry memoized none of those failures, the
        // timeout included, so a later mount re-fetches and classifies for real.
        return;
    }
    if (cause === 'none' || cause === 'unknown') return;
    // No await between the check at the top and this add (classification reads the pass's registry
    // synchronously), so concurrent 404s for the same plugin still log only once.
    hooksAbsentWarned.add(pluginId);
    if (cause === 'not-granted') {
        console.warn(
            `[PluginLoader] ACTIVE plugin '${pluginId}' ships admin UI extensions, but its "browser:script" ` +
            `permission is not granted, so the host does not serve that code and the extensions will not ` +
            `appear. Grant it in Plugins → Permissions only if you trust this plugin with your session.`
        );
        return;
    }
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
function loadPluginHooksBundle(pluginId: string, registry: PluginRegistryEntry[] | null): Promise<boolean> {
    const inFlight = hooksRegistration.get(pluginId);
    if (inFlight) return inFlight;
    const attempt = fetchAndRegisterPluginHooks(pluginId, registry);
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
 * Resolves false on 404 — a broken or unbuilt install, an ungranted browser:script, or (when the registry
 * could not say so up front) a plugin that declares no `frontend.hooks`; told apart, and warned about only
 * when actionable, from `registry` (the copy this pass fetched). REJECTS if the bundle exists but could
 * not be fetched or evaluated, so the caller can retry; an individual register() that throws is logged
 * and does not fail the load.
 */
async function fetchAndRegisterPluginHooks(pluginId: string, registry: PluginRegistryEntry[] | null): Promise<boolean> {
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
    // well as for a genuinely absent dist/hooks.bundle.js, and for a plugin whose browser:script
    // capability is not granted (the host serves no browser code for it). Resolving that ambiguity needs
    // no new backend status codes: GET /plugins/registry says, per ACTIVE plugin, whether it declares
    // `frontend.hooks` and — to a signed-in admin-panel user, which is who runs this pass — whether
    // browser:script is granted. So classify the 404
    // and warn ONLY when something is actually wrong. Warning on every 404 instead — as this did — put
    // one scary "the install is broken" line per hook-less plugin in the console of a perfectly healthy
    // site (30 of the 31 catalog plugins declare no hooks), which teaches admins to ignore the one
    // breadcrumb that matters.
    if (response.status === 404) {
        await warnIfHooksBundleShouldExist(pluginId, registry);
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
        injectHooksCss(pluginId);
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

    // The registry rides along with the active list (in parallel, bounded by REGISTRY_CLASSIFY_TIMEOUT_MS)
    // and decides which plugins are asked for a hooks bundle at all: only those that declare one, or that
    // it cannot vouch for (see mayShipHooksBundle). Every other active plugin used to cost a silent 404 on
    // every admin screen. Its failure is NOT this pass's failure — without it every plugin is asked, as
    // before — while a failed active list still rejects, so initPlugins un-latches and retries.
    const [ids, registry] = await Promise.all([
        fetchActivePluginIds(),
        fetchPluginRegistry().catch(() => null),
    ]);
    const wanted = ids.filter((id) => mayShipHooksBundle(registry, id));
    const results = await Promise.allSettled(wanted.map((id) => loadPluginHooksBundle(id, registry)));
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
