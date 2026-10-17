/**
 * WordJS — Server-side data layer for the public site (SSR).
 *
 * The public pages are React Server Components: they fetch content HERE, on the server, so the
 * initial HTML sent to crawlers and the first paint already contain the real title/body (real SSR),
 * instead of the old client-only `useEffect` fetch that shipped empty skeletons to bots.
 *
 * This module must only be imported from Server Components / generateMetadata — never from a
 * "use client" file (it reaches the backend over the loopback/internal origin and may read cookies).
 *
 * Fetches are wrapped in React `cache()` so generateMetadata() and the page body share a single
 * request-scoped backend call instead of fetching the same post twice.
 */
import { cache } from 'react';
import type { Metadata } from 'next';
import type { Post } from './api';
import { THEME_CONTRACT } from '@/generated/visual-contract.generated';
import { HERMETIC_BACKEND_BASE, isHermeticBuild } from '../../hermetic-build.js';

const THEME_ASSET_NAME = new RegExp(THEME_CONTRACT.assetNamePattern);

// ---------------------------------------------------------------------------
// The backend base URL — the one value that chooses WHERE every SSR request goes
// ---------------------------------------------------------------------------
//
// It is read from wordjs-config.json (and from the environment), i.e. it is FILE DATA that selects
// STRUCTURE, not a value that merely rides along inside a request. That is exactly the class this
// codebase has been bitten by before: a base of `http://someone@169.254.169.254/api/v1` would send
// every server-side read — and the session cookie getPostBySlugPreview forwards — to a host of
// somebody else's choosing, and nothing in the old code looked at the string at all. So the base is
// never used as it was read:
//
//   1. SHAPE ALLOWLIST — it must parse as a URL, its scheme must be one of two compiled-in literals,
//      it may not carry credentials, a query or a fragment, and its host and path must match a
//      positive character allowlist (never "does it contain something bad?", which is the inference
//      from ABSENCE this project has ruled out).
//   2. CANONICALISATION — the base that gets used is REBUILT from the validated pieces (and the
//      scheme is the literal from the allowlist, not the parsed string), so no unnormalised spelling
//      survives into the request.
//   3. CONTAINMENT — every request URL is re-parsed after the endpoint is appended and refused
//      unless it is still on the base's origin AND under the base's path. Same "resolve, then prove
//      it is inside" shape the filesystem rules use; an endpoint can no longer walk out of the API
//      root with `..`, and it can never move the host.
//
// A candidate that fails is not repaired — it is dropped, and resolution falls through to the next
// candidate (ending at the compiled-in localhost default). A malformed base is a misconfiguration,
// never a destination.
const BACKEND_PROTOCOLS = ['http:', 'https:'];
const DEFAULT_BACKEND_BASE = 'http://localhost:4000/api/v1';
const MONO_BACKEND_BASE = 'http://127.0.0.1:4000/api/v1';
// A host name or IPv4 literal: labels joined by dots, optional FQDN root dot. Underscores are
// allowed on purpose — they are illegal in DNS but ordinary in a Docker/compose service name, which
// is exactly what `internalApiUrl` points at in a container deployment, and an underscore cannot
// change a URL's structure. What the allowlist keeps OUT is what can: `@ : / \ ? # [ ]` and space.
const BACKEND_HOST_RE = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*\.?$/;
/** A bracketed IPv6 literal, as URL.hostname reports it. */
const BACKEND_IPV6_RE = /^\[[0-9a-f:]+\]$/;
/** An optional path prefix: `/segment` repeated, each segment from a positive character allowlist. */
const BACKEND_PATH_RE = /^(?:\/[a-z0-9._~-]+)*$/i;

/**
 * Validate + canonicalise one backend-base candidate. Returns null (never a "cleaned up" variant)
 * when the candidate is not exactly the shape above.
 */
function sanitizeBackendBase(candidate: string): string | null {
    let u: URL;
    try {
        u = new URL(String(candidate));
    } catch {
        return null; // not a URL at all
    }
    // Scheme: pick the matching LITERAL out of the allowlist, so what ends up in the request string
    // is this file's constant rather than the configured text.
    const protocol = BACKEND_PROTOCOLS.find((p) => p === u.protocol);
    if (!protocol) return null;
    // Credentials in a URL are the classic "the host is not what you think it is" trick, and a
    // backend base has no business carrying a query or a fragment.
    if (u.username || u.password || u.search || u.hash) return null;

    const host = u.hostname.toLowerCase();
    if (!BACKEND_HOST_RE.test(host) && !BACKEND_IPV6_RE.test(host)) return null;

    // URL.port is '' or digits only; still bound it to the real port range.
    const port = u.port;
    if (port) {
        if (!/^[0-9]{1,5}$/.test(port)) return null;
        const n = Number(port);
        if (n < 1 || n > 65535) return null;
    }

    const path = u.pathname.replace(/\/+$/, '');
    if (!BACKEND_PATH_RE.test(path)) return null;

    return `${protocol}//${host}${port ? `:${port}` : ''}${path}`;
}

/**
 * The backend-base candidates, most specific first. Split out from resolveServerBase so the
 * resolution ORDER (which mirrors the SSR branch of lib/api.ts' getBaseUrl, keeping split and
 * monolith identical) stays readable next to the validation that every candidate must pass:
 *  - monolith: the in-process backend's plain-HTTP loopback listener (self-signed TLS never blocks SSR)
 *  - split:    the backend's own HTTP port (default 4000), read from wordjs-config.json
 *  - override: INTERNAL_API_URL (full `.../api/v1`) wins when set
 *  - release build: WORDJS_HERMETIC_BUILD=1 overrides ALL of the above with a base fetch() refuses,
 *    so a release packaged on a machine with a running dev backend cannot prerender its content
 *    (see hermetic-build.js for why the fetch still happens instead of being skipped)
 */
function backendBaseCandidates(): string[] {
    if (isHermeticBuild()) return [HERMETIC_BACKEND_BASE];
    if (process.env.WORDJS_MODE === 'mono') {
        return [`${process.env.WORDJS_MONO_ORIGIN || 'http://127.0.0.1:4000'}/api/v1`, MONO_BACKEND_BASE];
    }
    if (process.env.INTERNAL_API_URL) {
        return [process.env.INTERNAL_API_URL.replace(/\/+$/, ''), DEFAULT_BACKEND_BASE];
    }
    const candidates: string[] = [];
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        // Priority: local (split distribution) -> ../backend (monolith / repo layout)
        let configPath = path.resolve(process.cwd(), 'wordjs-config.json');
        if (!fs.existsSync(configPath)) {
            configPath = path.resolve(process.cwd(), '../backend/wordjs-config.json');
        }
        if (fs.existsSync(configPath)) {
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            // Separate-machine frontend: internalApiUrl points SSR at the backend's reachable API base
            // (typically the gateway's public origin, whose cert is issued from the cluster CA the
            // frontend trusts via NODE_EXTRA_CA_CERTS). Same effect as the env, but config-file driven.
            if (cfg.internalApiUrl) candidates.push(String(cfg.internalApiUrl).replace(/\/+$/, ''));

            // LOCAL SPLIT: once the install has issued cluster certs, the backend serves HTTPS with
            // `rejectUnauthorized: true` (backend/src/index.ts), so it will not answer the plain-HTTP
            // fallback below and every SSR fetch silently returned null — the public site rendered
            // default settings and content pages 404'd, while client-side calls through the gateway
            // worked. Go through the gateway instead: it is the front door, it already terminates the
            // mTLS hop to the backend, and its cert chains to the cluster CA the frontend trusts.
            const backendCert = path.resolve(path.dirname(configPath), 'certs', 'backend.crt');
            if (fs.existsSync(backendCert)) {
                const front = String(cfg.gatewayUrl || cfg.siteUrl || '').replace(/\/+$/, '');
                if (front) candidates.push(`${front}/api/v1`);
            }

            if (cfg.port) candidates.push(`http://localhost:${String(cfg.port)}/api/v1`);
        }
    } catch {
        /* unreadable/!JSON config — fall back to the default port below */
    }
    candidates.push(DEFAULT_BACKEND_BASE);
    return candidates;
}

/**
 * The validated, canonical backend API base. Always a well-formed `scheme://host[:port][/path]`.
 *
 * EXPORTED for `app/(public)/_seo/upstream.ts`, the raw-body proxy behind the public feed and sitemap
 * URLs. `serverFetch` below ends in `res.json()` and a sitemap is not JSON, so that route cannot go
 * through it — but it must reach the same backend, chosen by the same rules. It used to carry a copy
 * of this resolver, which is a second place for the allowlists to be edited and only one of them to
 * be. Only the three functions that decide WHERE a request goes are shared; nothing about how the
 * request is made or cached is.
 */
export function resolveServerBase(): string {
    for (const candidate of backendBaseCandidates()) {
        const base = sanitizeBackendBase(candidate);
        if (base) return base;
    }
    return DEFAULT_BACKEND_BASE;
}

/**
 * The ORIGIN-level base: the backend serves themes/ (chrome, templates, theme.json) as static files
 * one level ABOVE the API prefix, so those loaders drop the `/api/v1` suffix off the same resolved
 * base. No request-header reads — config is the host authority and the public tree must stay
 * prerenderable.
 */
function resolveStaticBase(): string {
    return resolveServerBase().replace(/\/api\/v1$/, '');
}

/**
 * Join a validated base with a caller-supplied endpoint and PROVE the result is still inside it.
 * Concatenation alone is not enough: `${base}${endpoint}` with an endpoint containing `..` (or a
 * second scheme) can land on another path — or another host — entirely. So the joined string is
 * re-parsed and refused unless the origin still matches and the path is still under the base's path
 * (at a SEGMENT boundary, never a string prefix). Returns null when it is not; every caller already
 * degrades on a null/failed fetch, so this fails closed on the same path.
 *
 * Exported alongside resolveServerBase for the same reason — see its comment.
 */
export function backendUrl(base: string, endpoint: string): string | null {
    let joined: URL;
    let root: URL;
    try {
        root = new URL(base);
        joined = new URL(`${base}${endpoint}`);
    } catch {
        return null;
    }
    if (joined.origin !== root.origin) return null;
    const rootPath = root.pathname.replace(/\/+$/, '');
    if (rootPath && joined.pathname !== rootPath && !joined.pathname.startsWith(`${rootPath}/`)) return null;
    return joined.toString();
}

// Configured public origin (wordjs-config.json siteUrl), module-cached with a short TTL (a siteUrl
// migration must not require a frontend restart). Forwarding THIS host to the backend satisfies its
// host-based guards by construction — the configured siteUrl is exactly what they compare against —
// and keeps public renders free of request-header reads, which is the difference between a route
// Next can serve from the Full-Route Cache and one it must re-render per request.
// Exported alongside resolveServerBase for the same reason — see its comment.
let _pubHost: { value: { host: string; proto: string } | null; at: number } | null = null;
export function configuredPublicHost(): { host: string; proto: string } | null {
    // A release build has no site: the packaging machine's siteUrl is not the deployment's.
    if (isHermeticBuild()) return null;
    if (_pubHost && Date.now() - _pubHost.at < 10_000) return _pubHost.value;
    let value: { host: string; proto: string } | null = null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        let configPath = path.resolve(process.cwd(), 'wordjs-config.json');
        if (!fs.existsSync(configPath)) configPath = path.resolve(process.cwd(), '../backend/wordjs-config.json');
        if (fs.existsSync(configPath)) {
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            if (cfg.siteUrl && /^https?:\/\//i.test(cfg.siteUrl)) {
                const u = new URL(cfg.siteUrl);
                value = { host: u.host, proto: u.protocol.replace(':', '') };
            }
        }
    } catch { /* unreadable config — fall back to request headers below */ }
    _pubHost = { value, at: Date.now() };
    return value;
}

// ---------------------------------------------------------------------------
// Multisite: which site of the network this render is for
// ---------------------------------------------------------------------------
//
// The main site renders from the (public) route tree, exactly as a single site always has. Another site
// of the network is rewritten by src/proxy.ts to the internal tree `wjs-site/[siteHost]/…` (the edge —
// gateway or monolith — names the site in `x-wordjs-site-host`, from its own verdict, never a client's).
// Every page, layout and metadata function of that tree calls setRequestSite() with the route's
// `siteHost` before it reads anything, so every helper below asks the backend for THAT site's data and
// tags its cache entries under that site. Nothing here reads a request header: the route segment is the
// carrier, which keeps those pages cacheable (each site's page is its own path in the Full Route Cache).

/** A site's main hostname as the route carries it: lower-case DNS labels only. Null for anything else. */
export function normalizeSiteHost(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    let decoded: string;
    try { decoded = decodeURIComponent(raw); } catch { return null; }
    const value = decoded.toLowerCase();
    if (value.length < 1 || value.length > 253) return null;
    return /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/.test(value) ? value : null;
}

// Request-scoped (React cache is one value per server request, shared by the layout, the page and its
// components). Outside a render React does not cache, so a route handler reads null here: route handlers
// pass the site explicitly (ProxyOptions.siteHost in app/(public)/_seo/upstream.ts).
const requestSiteHolder = cache((): { host: string | null } => ({ host: null }));

/**
 * Declare the site this render is for, from the `siteHost` route param of the `wjs-site` tree. Returns
 * the normalized host, or null when the param is not a hostname (the caller answers notFound()).
 */
export function setRequestSite(raw: unknown): string | null {
    const host = normalizeSiteHost(raw);
    if (host) requestSiteHolder().host = host;
    return host;
}

/**
 * For a route that is DYNAMIC anyway (the admin): declare the site from the request itself — the
 * `x-wordjs-site-host` header the edge sets from its own verdict (src/proxy.ts explains it). Never call
 * this from a public page: reading the request makes a route dynamic. Null on the main site.
 */
export async function declareSiteFromRequest(): Promise<string | null> {
    try {
        const { headers } = await import('next/headers');
        const raw = (await headers()).get('x-wordjs-site-host');
        return raw ? setRequestSite(raw) : null;
    } catch {
        return null;
    }
}

/** The site this render is for, or null for the main site (and every single-site install). */
export function requestSiteHost(): string | null {
    try { return requestSiteHolder().host; } catch { return null; }
}

/**
 * React `cache()` with the site in the key. Every request-memoized read of this module goes through it:
 * the root layout reads the settings BEFORE a site page has declared its site (it takes no params), and
 * with a site-blind key the site's layout would be handed that main-site result for the rest of the
 * request. The holder only ever moves from null to a host within a request, so a read keyed by the
 * host is always that host's.
 */
export function siteCache<F extends (...args: any[]) => any>(fn: F): F {
    const keyed = cache((site: string | null, ...args: Parameters<F>): ReturnType<F> => fn(...args));
    return ((...args: Parameters<F>): ReturnType<F> => keyed(requestSiteHost(), ...args)) as F;
}

/**
 * The cache tags of a read for `siteHost`: the main site's tags are the bare names (as always); another
 * site's are `site:<host>:<tag>`, the very names the backend purges for it (core/frontend-purge
 * siteQualifiedPurge) — so a change on one site never invalidates, nor is answered by, another's.
 */
export function siteTags(tags: string[] | undefined, siteHost: string | null): string[] | undefined {
    if (!tags || !siteHost) return tags;
    return tags.map((t) => `site:${siteHost}:${t}`);
}

interface ServerFetchOptions {
    /**
     * Forward the inbound request cookies so the backend sees the logged-in user (authenticated SSR).
     * Default false: public content is fetched anonymously — exactly what a crawler sees — which also
     * keeps the response from becoming per-user. Opt in only for routes that must reflect the session.
     */
    forwardCookies?: boolean;
    /**
     * PERF: seconds to keep this PUBLIC read in Next's Data Cache (ISR). With it set, the same backend
     * call is reused across requests for `revalidate` seconds instead of hitting the backend + DB on
     * every render — the single biggest lever on public-page speed. Next 15 no longer caches `fetch`
     * by default, so caching is strictly opt-in. IGNORED when forwardCookies is true (per-user reads
     * must never be shared) — those stay `no-store`.
     */
    revalidate?: number;
    /** Cache tags for precise on-demand purging via `revalidateTag()` when content changes. */
    tags?: string[];
}

/**
 * Fetch JSON from the backend during SSR. Returns null on any non-2xx or network error so callers can
 * render a not-found / fallback state instead of throwing a 500 for the whole page.
 */
export async function serverFetch<T>(endpoint: string, options: ServerFetchOptions = {}): Promise<T | null> {
    const res = await serverResponse(endpoint, options);
    if (!res || !res.ok) return null;
    try {
        return (await res.json()) as T;
    } catch {
        return null;
    }
}

/**
 * The backend's Response to an SSR request — serverFetch without the "any failure is null" collapse, for
 * the few callers that must tell "the backend said no" (a status) from "no answer" (null: unreachable,
 * or an endpoint that escaped the API root). Same destination, headers and caching rules as serverFetch.
 */
export async function serverResponse(endpoint: string, options: ServerFetchOptions = {}): Promise<Response | null> {
    // Destination first, and only the destination: the URL is resolved and contained BEFORE any of
    // the request is assembled, so nothing below can influence where this goes.
    const url = backendUrl(resolveServerBase(), endpoint);
    if (!url) return null; // endpoint escaped the API root — same degrade path as an unreachable backend
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // Forward the real public host/proto to the backend. SSR fetches hit the loopback origin
    // (127.0.0.1:4000), so without this the backend's host-based logic — the Site-URL/migration
    // guard, CSRF origin check, canonical/sitemap URLs — would see "localhost:4000" instead of the
    // public host and (e.g.) reject every SSR request with a 409 migration_required. The public
    // listener (gateway/monolith) already pins x-forwarded-host to the browser's Host, so we just
    // relay it one more hop to the backend.
    // PUBLIC reads: forward the CONFIGURED public origin, or NOTHING. Never read the inbound
    // request here — headers() during the runtime render of a prerendered route is a Next 16
    // hard error ("Page changed from static to dynamic", seen as 500 /about on the lab split
    // gate), and catching the bailout is unsupported. Unconfigured (mid-install) sends no host:
    // the backend's guards don't require one until a siteUrl exists to compare against.
    // Per-user reads (forwardCookies) are the one legitimate consumer of the request — their
    // routes (/preview, admin SSR) are force-dynamic, where headers() is allowed.
    //
    // The address relayed is the one the public listener judged, an EMPTY one included: the gateway
    // pins `X-Forwarded-Host: ''` for a request that names no address, and the monolith leaves a direct
    // client's Host (or none) with no X-Forwarded-Host. `X-Forwarded-Host || Host` turned the empty
    // value into Next's own Host (the gateway's changeOrigin target, 127.0.0.1:3001), so the backend
    // judged loopback where the edge had judged no address (review R3S-6). So: a present header as it
    // is, else Host, else '' — and '' is sent, never dropped, for the backend to judge no address too.
    if (options.forwardCookies) {
        try {
            const { headers: nextHeaders } = await import('next/headers');
            const inbound = await nextHeaders();
            const relayed = inbound.get('x-forwarded-host');
            const host = relayed !== null ? relayed : (inbound.get('host') ?? '');
            headers['x-forwarded-host'] = host;
            if (host) headers['x-forwarded-proto'] = inbound.get('x-forwarded-proto') || 'https';
            const cookieHeader = inbound.get('cookie');
            if (cookieHeader) headers['cookie'] = cookieHeader;
        } catch {
            /* not in a request scope (e.g. build prerender) — proceed without forwarded headers */
        }
    } else {
        // Multisite: a page of another site of the network reads THAT site's data — its main
        // hostname, set by the page from the route the proxy rewrote it to (setRequestSite). Never the
        // inbound request, for the same reason as above.
        const pub = configuredPublicHost();
        const siteHost = requestSiteHost();
        if (siteHost) {
            headers['x-forwarded-host'] = siteHost;
            headers['x-forwarded-proto'] = pub ? pub.proto : 'https';
        } else if (pub) {
            headers['x-forwarded-host'] = pub.host;
            headers['x-forwarded-proto'] = pub.proto;
        }
    }

    // Per-user reads (cookie-forwarded) must NEVER be cached/shared → no-store. Public reads opt into
    // Next's Data Cache when the caller passed a `revalidate` window (ISR), else stay dynamic (no-store).
    const cacheInit: RequestInit = options.forwardCookies || options.revalidate == null
        ? { cache: 'no-store' }
        : ({ next: { revalidate: options.revalidate, tags: siteTags(options.tags, requestSiteHost()) } } as RequestInit);

    try {
        const res = await fetch(url, { headers, ...cacheInit });
        return fromRequestedSite(res, requestSiteHost());
    } catch {
        // Backend unreachable during SSR — caller decides how to degrade.
        return null;
    }
}

/**
 * Multisite: the response, when it is the requested site's — else null. The backend names the site that
 * answered (`X-WordJS-Site-Host`, backend/src/core/site-resolver.ts). A page of another site whose read
 * came back from a different site (a deployment path that lost the site on the way to the backend) gets
 * "no answer", so it renders not-found rather than one site's content under another site's address.
 * The main site's reads are not checked (null siteHost), exactly as before.
 */
export function fromRequestedSite(res: Response, siteHost: string | null): Response | null {
    if (!siteHost) return res;
    const answeredBy = String(res.headers.get('x-wordjs-site-host') || '').toLowerCase();
    return answeredBy === siteHost ? res : null;
}

/** What a plugin portal page (/portal/<slug>, manifest frontend.portalPage) puts in its <head>. */
export interface PortalPageInfo {
    slug: string;
    title?: string;
    themeColor?: string;
    viewportFit?: 'auto' | 'cover' | 'contain';
}

/**
 * Does an active plugin serve the portal `/portal/<slug>`? Asks GET /plugins/<slug>/portal (the backend
 * applies the same active + browser:script gate as the portal's bundle). 'missing' is the backend's 404 —
 * the page answers a real 404; 'unavailable' is no usable answer (backend down, 5xx), where the page
 * still renders and lets the client report it, instead of claiming the portal does not exist.
 */
export const getPortalPage = siteCache(async (slug: string): Promise<
    { status: 'served'; info: PortalPageInfo } | { status: 'missing' } | { status: 'unavailable' }
> => {
    const res = await serverResponse(`/plugins/${encodeURIComponent(slug)}/portal`);
    if (!res) return { status: 'unavailable' };
    if (res.status === 404) return { status: 'missing' };
    if (!res.ok) return { status: 'unavailable' };
    try {
        const body = await res.json();
        if (!body || typeof body !== 'object' || body.slug !== slug) return { status: 'unavailable' };
        return { status: 'served', info: body as PortalPageInfo };
    } catch {
        return { status: 'unavailable' };
    }
});

/**
 * True when the backend is up but NOT yet installed (it answers every API call with
 * 503 {error:'setup_required'}). The public layout uses this to send a fresh install to the
 * /install wizard instead of rendering an empty broken page. Any other state (installed,
 * backend down, network error) returns false so pages degrade exactly as before.
 */
// Module-level latch: once we have seen ANY non-503 answer the site is installed, and a live site
// does not hot-uninstall — so stop paying a no-store settings fetch (≈20+ backend SELECTs) on every
// page view forever after. While the answer is still "setup required" (or the backend is down) we
// keep probing, so the install flow itself is unchanged.
let _setupSettled = false;
export const checkSetupRequired = siteCache(async (): Promise<boolean> => {
    if (_setupSettled) return false;
    const url = backendUrl(resolveServerBase(), '/settings');
    if (!url) return false;
    try {
        // revalidate:1, NOT no-store: a no-store fetch during the runtime render of a prerendered
        // route is the same Next 16 static-to-dynamic hard error the lab gate caught. 1s of
        // staleness on "is this installed yet?" is nothing; a 500 on a cached page is not.
        const res = await fetch(url, { next: { revalidate: 1 } });
        if (res.status !== 503) { _setupSettled = true; return false; }
        const body = await res.json().catch(() => null);
        return !!body && body.error === 'setup_required';
    } catch {
        return false;
    }
});

// ---------------------------------------------------------------------------
// Request-deduped content loaders (one backend call per (args) per request)
// ---------------------------------------------------------------------------

// Site settings change rarely and are read on EVERY page (title, theme, menus, SEO, chrome) — the single
// hottest read. Cache 60s + tag so the ~N-per-render backend calls collapse to one until it changes.
export const getSettings = siteCache((): Promise<Record<string, string> | null> =>
    serverFetch<Record<string, string>>('/settings', { revalidate: 60, tags: ['settings'] }).then((settings) => {
        publishMediaCdnOrigin(settings);
        return settings;
    })
);

/**
 * The media/CDN origin, published process-wide for the custom server's CSP amendment
 * (frontend/media-csp.js): the build-time header cannot know where this site's media lives.
 */
function publishMediaCdnOrigin(settings: unknown): void {
    if (!settings || typeof settings !== 'object') return;
    const origin = (settings as Record<string, unknown>).media_cdn_origin;
    (globalThis as Record<string, unknown>).__WORDJS_MEDIA_CDN_ORIGIN__ = typeof origin === 'string' ? origin : '';
}

/**
 * Re-read the media/CDN origin from the backend NOW. getSettings only republishes it when a public page
 * renders, and after a purge its first answer is still the stale cached one (revalidateTag 'max' is
 * stale-while-revalidate) — so a media storage change reached the admin's CSP up to a minute late and
 * the screen's "Test connection" failed in the meantime. /api/revalidate calls this when the backend
 * purges the `settings` tag. Best effort: on any failure the published value is left as it was.
 */
export async function refreshMediaCdnOrigin(): Promise<void> {
    const url = backendUrl(resolveServerBase(), '/settings');
    if (!url) return;
    try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return;
        publishMediaCdnOrigin(await res.json().catch(() => null));
    } catch {
        /* keep the published value */
    }
}

export interface PublicAssets {
    scripts: { handle: string; src: string; inFooter?: boolean; strategy?: string }[];
    styles: { handle: string; src: string; media?: string }[];
}

/** Plugin-enqueued frontend scripts/styles (active plugins only), rendered by the public layout. */
export const getPublicAssets = siteCache((): Promise<PublicAssets> =>
    serverFetch<PublicAssets>('/plugins/assets', { revalidate: 120, tags: ['plugin-assets'] }).then((a) => a || { scripts: [], styles: [] })
);

/**
 * Installed fonts, fetched on the SERVER so their @font-face rules can be emitted into the initial
 * SSR <head> (see app/layout.tsx). Previously fonts were injected only client-side (SystemFontsLoader
 * useEffect), so a public page's first paint had the inline `font-family` but no matching face and fell
 * back to the theme font until hydration — a font changed in the editor appeared unreflected on public.
 */
export const getFonts = siteCache((): Promise<import('./fontFaceCss').WjsFont[]> =>
    serverFetch<import('./fontFaceCss').WjsFont[]>('/fonts', { revalidate: 300, tags: ['fonts'] }).then((f) => f || [])
);

/**
 * A location menu (header/footer/…) for the public chrome, fetched on the SERVER so the Header/Footer
 * render their nav in the initial SSR HTML instead of each visitor re-fetching it client-side on
 * hydration. Cached + tagged like the other public reads.
 */
export const getMenuByLocation = siteCache((location: string): Promise<{ items: MenuItem[] } | null> =>
    serverFetch<{ items: MenuItem[] }>(`/menus/location/${encodeURIComponent(location)}`, { revalidate: 60, tags: ['menus', `menu:${location}`] })
);
// `parent` is the flat hierarchy the location endpoint returns (MenuItem.toJSON → post_parent /
// _menu_item_menu_item_parent). buildMenuTree nests it into ChromeNav submenus; 0 means a root item.
// `target` (default '_self' server-side) rides along so the NavMenu block can whitelist it at render.
export interface MenuItem { id: number | string; title: string; url: string; order?: number; parent?: number | string; target?: string; }

/**
 * A menu addressed BY ID (source='menu' on a NavMenu block). GET /menus/:id returns the menu with its
 * items already attached (routes/menus.ts). Cached + tagged like getMenuByLocation, keyed by id, so
 * several NavMenu blocks naming the same menu on one page share a single backend call.
 */
export const getMenuById = siteCache((id: number): Promise<{ items: MenuItem[] } | null> =>
    serverFetch<{ items: MenuItem[] }>(`/menus/${encodeURIComponent(String(id))}`, { revalidate: 60, tags: ['menus', `menu:${id}`] })
);

/**
 * The menu a NavMenu block binds to — addressed either BY LOCATION (source='location', the site's
 * header/footer slot) or BY ID (source='menu', one specific menu). The block stores ONLY this
 * reference; the nav_menu store stays the single source of truth, so there is zero data to migrate.
 * Location reuses getMenuByLocation verbatim; both reads are React-cached + tagged exactly like it.
 * A malformed/missing ref resolves to null → the resolver hands the block an empty list.
 */
export const getMenuByRef = siteCache((ref: { source?: string; location?: string; menuId?: number | string }): Promise<{ items: MenuItem[] } | null> => {
    if (ref?.source === 'menu') {
        const id = Number(ref?.menuId);
        return Number.isFinite(id) && id > 0 ? getMenuById(id) : Promise.resolve(null);
    }
    return getMenuByLocation(String(ref?.location || 'header'));
});

/**
 * Active theme's chrome composition file (composable-chrome contract v1, precedence level 2º).
 * Served STATICALLY by the backend at /themes/<slug>/chrome/<part>.json — an origin-level path,
 * not under /api/v1, so this strips the API suffix off the same resolved base serverFetch uses
 * (config is the host authority; no request-header reads — the public tree must stay prerenderable).
 * Returns the RAW text: budget/JSON/schema validation is parseChromeData's job (fail-closed in the
 * caller), never this loader's. 404 = the theme ships no composition — normal, silently null.
 * Cached under the 'settings' tag: switchTheme and the site_chrome_* writers already purge it.
 */
/**
 * Active theme's declarative PAGE TEMPLATE (template contract v1).
 *
 * Same shape and the same reasoning as getThemeChrome below: served statically by the backend at
 * /themes/<slug>/templates/<name>.json, raw text returned, validation left to parseTemplate (which
 * fail-closes in the caller), 404 = the theme ships no template for this route, which is the normal
 * case and silently null. Cached under the 'settings' tag so a theme switch purges it.
 *
 * `name` is caller-supplied and lands in a URL, so it is restricted to the shape a template file may
 * have — no dots, no slashes. A traversal here would be a path-injection into the static tree.
 */
export const getThemeTemplate = siteCache(async (slug: string, name: string): Promise<string | null> => {
    if (!THEME_ASSET_NAME.test(name)) return null;
    const url = backendUrl(resolveStaticBase(), `/themes/${encodeURIComponent(slug)}/templates/${name}.json`);
    if (!url) return null;
    try {
        const res = await fetch(url, {
            next: { revalidate: 60, tags: ['settings'] },
        } as RequestInit);
        if (!res.ok) return null;
        return await res.text();
    } catch {
        // Backend unreachable (e.g. build prerender) — the page keeps its default arrangement.
        return null;
    }
});

/**
 * Active theme's `theme.json`, raw. Served statically from the same tree as chrome/ and templates/.
 *
 * The renderer needs exactly one thing out of it: the `templateParts` declaration, which is what makes
 * a chrome/<name>.json reachable from a page template at all. Parsing (and fail-closing) is
 * parseTemplateParts's job in templateData.ts, never this loader's — same division as the two below.
 * Cached under the 'settings' tag so activating a theme purges it.
 */
export const getThemeManifest = siteCache(async (slug: string): Promise<string | null> => {
    const url = backendUrl(resolveStaticBase(), `/themes/${encodeURIComponent(slug)}/theme.json`);
    if (!url) return null;
    try {
        const res = await fetch(url, {
            next: { revalidate: 60, tags: ['settings'] },
        } as RequestInit);
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    }
});

/**
 * A chrome composition the theme ships. `part` is the site's own 'header'/'footer' for the public
 * layout, or a NAMED TEMPLATE PART a page template pulls in — which is why the name is shape-checked
 * here exactly like getThemeTemplate's is: it lands in a URL, so a name that is not [a-z0-9-] never
 * reaches the fetch. (Being declared in theme.json is a SEPARATE gate, enforced by the resolver.)
 */
export const getThemeChrome = siteCache(async (slug: string, part: string): Promise<string | null> => {
    if (!THEME_ASSET_NAME.test(part)) return null;
    const url = backendUrl(resolveStaticBase(), `/themes/${encodeURIComponent(slug)}/chrome/${part}.json`);
    if (!url) return null;
    try {
        const res = await fetch(url, {
            next: { revalidate: 60, tags: ['settings'] },
        } as RequestInit);
        if (!res.ok) return null;
        return await res.text();
    } catch {
        // Backend unreachable (e.g. build prerender) — fall through to the next precedence level.
        return null;
    }
});

/**
 * GET /posts/slug/:slug, optionally narrowed to ONE type.
 *
 * Without a type the backend resolves a slug that a post and a page share (pairs older than the shared
 * slug namespace, and the importers' per-type slugs) to the PAGE — the bare /<slug> URL is the page's.
 * A caller that knows it wants something else says so with `type`: the /<category>/<post-slug> route
 * wants the post, and a draft preview wants the entry its editor opened. A type is sent only when it is
 * spelled the way the backend accepts one (lowercase letters, digits, `_` and `-`; anything else answers
 * 400 there), so a value from a query string can never turn a lookup into an error.
 */
export const POST_TYPE_PARAM = /^[a-z0-9_-]{1,64}$/;
export function postBySlugPath(slug: string, type?: string | null): string {
    const base = `/posts/slug/${encodeURIComponent(slug)}`;
    return typeof type === 'string' && POST_TYPE_PARAM.test(type) ? `${base}?type=${encodeURIComponent(type)}` : base;
}

/**
 * Draft-preview loader: forwards the admin's session cookie, so the backend's
 * GET /posts/slug/:slug (optionalAuth) returns non-published posts to their author /
 * editors. A separate cache() entry from getPostBySlug keeps the keying correct.
 */
export const getPostBySlugPreview = siteCache((slug: string, type?: string | null): Promise<Post | null> =>
    serverFetch<Post>(postBySlugPath(slug, type), { forwardCookies: true })
);

export const getPostBySlug = siteCache((slug: string, type?: string | null): Promise<Post | null> =>
    serverFetch<Post>(postBySlugPath(slug, type), { revalidate: 30, tags: ['posts', `post:${slug}`] })
);

/**
 * The entry a /<category>/<post-slug> URL names: the POST of that slug first, then whatever the bare slug
 * resolves to (what this route served before the backend started preferring the page). Untyped, a post
 * and a page sharing a slug rendered the PAGE under the post's category URL.
 */
export const getCategoryPostBySlug = siteCache(async (slug: string): Promise<Post | null> =>
    (await getPostBySlug(slug, 'post')) ?? (await getPostBySlug(slug))
);

export const getPostById = siteCache((id: number): Promise<Post | null> =>
    serverFetch<Post>(`/posts/${id}`, { revalidate: 30, tags: ['posts', `post:${id}`] })
);

/** The backend clamps `per_page` at 100 (backend/src/routes/posts.ts). */
const API_MAX_PER_PAGE = 100;
/** WordPress's own default when the option is unset or unusable (backend/src/core/options.ts). */
const DEFAULT_POSTS_PER_PAGE = 10;
/** Hard ceiling on the paging walk, so a huge `posts_per_page` cannot turn one render into a fan-out. */
const MAX_POST_PAGES = 20;

/**
 * `posts_per_page` from the site options — the number the site OWNER chose for the blog roll.
 *
 * The settings endpoint JSON-parses option values, so this arrives as a NUMBER on a normal site and as
 * a string from raw/legacy sources; both shapes are read. Deliberately NOT clamped to the API's page
 * size: the walk below covers a value larger than one API page, which is the whole point of asking.
 */
async function resolvePostsPerPage(): Promise<number> {
    const settings = await getSettings();
    const raw = (settings as Record<string, unknown> | null)?.posts_per_page;
    const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_POSTS_PER_PAGE;
    return Math.floor(n);
}

/**
 * The newest `wanted` posts of one type, walked over as many API pages as it takes.
 *
 * THE PAGE SIZE IS CONSTANT FOR THE WHOLE WALK, AND THAT IS NOT A STYLE CHOICE. The backend computes
 * `offset = (page - 1) * limit` from THAT request's own `per_page` (backend/src/routes/posts.ts), so
 * shrinking the size on the last iteration moves the window BACKWARDS instead of forwards: with
 * `wanted=150`, `per_page=100&page=1` followed by `per_page=50&page=2` returns rows 1..100 and then
 * rows 51..100 — fifty duplicates (duplicate React keys) and posts 101..150 never fetched at all.
 * One size for every request, `page` incremented, and the overshoot trimmed at the end.
 *
 * `null` is preserved for "the backend could not be reached", which is what the homepage renders its
 * Service-Unavailable state from — distinct from an empty list, which means the site has no posts.
 */
async function walkPosts(type: string, status: string, wanted: number): Promise<Post[] | null> {
    const query = `type=${encodeURIComponent(type)}&status=${encodeURIComponent(status)}`;
    const size = Math.min(API_MAX_PER_PAGE, wanted);
    const out: Post[] = [];

    for (let page = 1; out.length < wanted && page <= MAX_POST_PAGES; page++) {
        const batch = await serverFetch<Post[]>(
            `/posts?${query}&per_page=${size}&page=${page}`,
            { revalidate: 30, tags: ['posts', `posts:${type}`] },
        );
        // A failed FIRST page is "no answer" (null); a failure part-way through a walk still has real
        // rows to show, so it degrades to what it has rather than discarding the page.
        if (!Array.isArray(batch)) return page === 1 ? null : out.slice(0, wanted);
        out.push(...batch);
        if (batch.length < size) break;
    }
    // The last request is a WHOLE page, so the walk can overshoot: hand back exactly what was asked for.
    return out.slice(0, wanted);
}

/**
 * THE BLOG ROLL's loader: exactly `posts_per_page` posts, the number the site OWNER chose for it.
 *
 * IT SENDS `per_page`. It used not to, so it took the backend's default of TEN rows and the site's
 * `posts_per_page` setting did nothing at all on the front page: an owner who asked for 20 posts got
 * 10, silently, with no page 2 to reach the rest.
 *
 * IT IS NOT A GENERAL "GIVE ME THE POSTS". A Reading setting is a statement about ONE listing — the
 * front page — and nothing else on the site may be resized by it. A PostsGrid asking for 6 cards
 * still wants 6 when the owner sets the roll to 3, and a CategoryPosts filtering client-side needs a
 * pool WIDER than what it will show or its category simply is not in it (the list endpoint takes no
 * category filter, so the match happens over whatever this returns). Every caller that is not the
 * roll therefore uses `getPostPool` below, which cannot shrink below the backend's own default.
 *
 * The two `generateStaticParams` callers ((public)/[slug] and (public)/pages/[slug]) still use this
 * one, and that is not an oversight: it only decides how many paths are PRE-rendered at build time.
 * A path left out is rendered on demand and cached like any other, so a low `posts_per_page` costs a
 * first-visit render there, never a missing or truncated page.
 */
export const getPosts = siteCache(async (type = 'post', status = 'publish'): Promise<Post[] | null> =>
    walkPosts(type, status, await resolvePostsPerPage()));

/**
 * THE DYNAMIC BLOCKS' loader: a pool to CHOOSE from, never a page of results to display.
 *
 * `minimum` is the largest `count` any listing block on the page asks for, so the pool is at least as
 * big as the biggest thing that will be sliced out of it. It is a floor, not the size: the pool never
 * drops below the backend's own default of ten rows nor below `posts_per_page`, which keeps a
 * category filter looking at more posts than a single block will show. And it is clamped to one API
 * page, because `count` is read from stored block props — the editor's field maxima (12 for
 * PostsGrid, 10 for CategoryPosts) are UI, not a guarantee about what a hand-edited or imported
 * `_puck_data` carries, and a page render must not be able to fan out into twenty backend requests
 * because one prop says 9999.
 */
export const getPostPool = siteCache(async (
    type = 'post',
    status = 'publish',
    minimum = 0,
): Promise<Post[] | null> => {
    const asked = Number.isFinite(minimum) ? Math.min(API_MAX_PER_PAGE, Math.floor(minimum)) : 0;
    const wanted = Math.max(DEFAULT_POSTS_PER_PAGE, await resolvePostsPerPage(), asked);
    return walkPosts(type, status, wanted);
});

/** Search published posts + pages server-side. Tolerates both `Post[]` and `{ posts: Post[] }` shapes. */
export async function searchPosts(query: string): Promise<Post[]> {
    const norm = (r: unknown): Post[] => {
        if (Array.isArray(r)) return r as Post[];
        if (r && typeof r === 'object' && Array.isArray((r as { posts?: Post[] }).posts)) {
            return (r as { posts: Post[] }).posts;
        }
        return [];
    };
    const [posts, pages] = await Promise.all([
        serverFetch<unknown>(`/posts?search=${encodeURIComponent(query)}&status=publish`),
        serverFetch<unknown>(`/posts?type=page&search=${encodeURIComponent(query)}&status=publish`),
    ]);
    return [...norm(posts), ...norm(pages)];
}

// ---------------------------------------------------------------------------
// SEO metadata helpers (server-safe — no DOM, no "use client" sanitizer)
// ---------------------------------------------------------------------------

/** Strip tags + decode the common entities to a single-line plain-text excerpt for <meta> values. */
export function htmlToText(html: string | undefined | null, max = 160): string {
    if (!html) return '';
    const text = html
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length <= max) return text;
    return text.slice(0, max - 1).replace(/\s+\S*$/, '').trimEnd() + '…';
}

/**
 * Featured/OG image for a post. Primary source is the REAL featured image the admin UI sets
 * (post.featuredMedia — Post.toJSON serializes it with an absolute URL); meta keys are a
 * fallback for imported/legacy content. '/'-relative values are accepted because the root
 * layout sets metadataBase, which absolutizes them in the rendered tags.
 */
function pickOgImage(post: Post): string[] | undefined {
    if (post.featuredMedia?.url && /^(https?:\/\/|\/)/i.test(post.featuredMedia.url)) {
        return [post.featuredMedia.url];
    }
    const m = postMetaRecord(post);
    const candidate = m.featured_image || m._thumbnail_url || m.thumbnail || m.og_image || m.image;
    if (typeof candidate === 'string' && /^(https?:\/\/|\/)/i.test(candidate)) return [candidate];
    return undefined;
}

/**
 * Post meta as a plain record, whatever shape it arrived in.
 *
 * The backend's Post.toJSON emits an OBJECT (models/Post.getAllMeta JSON.parses every row), but the
 * same rows reach us as a raw JSON STRING through paths that never went through toJSON (an imported
 * row, a plugin-supplied payload, a cached body written by an older version). Both are read here so
 * a per-post SEO override is not silently dropped for one of them.
 */
function postMetaRecord(post: Post): Record<string, unknown> {
    const raw: unknown = post.meta;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch { /* not JSON — no meta to read */ }
    }
    return {};
}

/**
 * A meta value the author typed, as a non-empty single-line string — or '' when there is nothing to
 * honour. Numbers are accepted because getAllMeta JSON.parses every stored value, so a title of
 * `2026` comes back as the NUMBER 2026; anything else (object, boolean, null) is not author text.
 */
function metaText(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
}

/**
 * The stored `noindex` flag as a boolean. The editor writes a real boolean (String()'d to `true` /
 * `false` on the way into post_meta and JSON.parsed back), but imports and legacy content use the
 * `1` / `'yes'` / `'on'` spellings — all of which mean the author asked to be hidden. Anything else,
 * including the absent key, means indexable: this is fail-OPEN by design, because guessing "hidden"
 * from junk would de-list a live page.
 */
function metaFlag(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
    return false;
}

/**
 * Build full SEO metadata (title, description, robots, OpenGraph, Twitter, canonical) for a post/page.
 *
 * PER-POST OVERRIDES. The editor persists `seo_title`, `seo_description`, `og_image` and `noindex`
 * into post meta; this is the only place the public routes turn them into rendered <head>. An empty
 * or absent override falls back EXACTLY to the previous derivation (post title / excerpt-or-body),
 * so a post that never opened the SEO panel renders byte-for-byte what it rendered before.
 *
 * The override replaces the title/description everywhere they appear — document, OpenGraph and
 * Twitter — because an og:title that disagrees with the <title> is what social validators flag.
 */
export function buildPostMetadata(
    post: Post,
    opts: { siteName?: string; canonicalPath?: string } = {}
): Metadata {
    const meta = postMetaRecord(post);
    const title = metaText(meta.seo_title) || post.title || 'Untitled';
    const description = metaText(meta.seo_description)
        || htmlToText(post.excerpt || post.content || '', 160)
        || undefined;
    const noindex = metaFlag(meta.noindex);
    const isArticle = post.type !== 'page';
    const images = pickOgImage(post);
    const canonical = opts.canonicalPath || `/${post.slug || post.id}`;

    // Branch on a *literal* `type` so TS narrows the OpenGraph discriminated union (article-only
    // fields like publishedTime are valid only on the article member).
    const openGraph: Metadata['openGraph'] = isArticle
        ? {
            title,
            description,
            type: 'article',
            url: canonical,
            ...(post.date ? { publishedTime: post.date } : {}),
            ...(post.author?.displayName ? { authors: [post.author.displayName] } : {}),
            ...(images ? { images } : {}),
            ...(opts.siteName ? { siteName: opts.siteName } : {}),
        }
        : {
            title,
            description,
            type: 'website',
            url: canonical,
            ...(images ? { images } : {}),
            ...(opts.siteName ? { siteName: opts.siteName } : {}),
        };

    const twitter = {
        card: images ? 'summary_large_image' : 'summary',
        title,
        description,
        ...(images ? { images } : {}),
    } as Metadata['twitter'];

    // MULTILINGUAL (opt-in): emit <link rel="alternate" hreflang> for a post that belongs to a
    // translation group. Google wants every page in the set to reference ALL versions INCLUDING
    // itself, so the current page's own language maps to its canonical, and each published sibling
    // maps to its own path. A post with no language or no siblings emits nothing (monolingual sites
    // and lone posts are byte-for-byte unchanged). Relative hrefs are absolutized by metadataBase.
    // Siblings are OTHER posts, so this function does not have their canonicalPath — it derives each
    // from the SAME default convention the self-canonical falls back to (`/${slug}`), the one every
    // caller here actually passes. A caller that supplies a custom prefixed canonicalPath for the
    // current post does NOT propagate that prefix to siblings (they'd need their own); documented
    // rather than silently half-applied.
    const postPath = (p: { slug?: string; id?: number | string }) => `/${p.slug || p.id}`;
    const languages: Record<string, string> = {};
    if (post.language && post.translations && post.translations.length > 0) {
        languages[post.language] = canonical;
        for (const t of post.translations) {
            if (t.language && (t.slug || t.id)) languages[t.language] = postPath(t);
        }
    }
    const hasAlternateLanguages = Object.keys(languages).length > 0;

    return {
        title,
        description,
        // `noindex` is the one override with no fallback shape: the key is emitted ONLY when the
        // author asked to be hidden, so an ordinary post still ships no `robots` meta at all.
        ...(noindex ? { robots: { index: false, follow: false } } : {}),
        alternates: { canonical, ...(hasAlternateLanguages ? { languages } : {}) },
        openGraph,
        twitter,
    };
}

// ---------------------------------------------------------------------------
// JSON-LD structured data (rich results). Hand-rendered <script> tags are NOT
// absolutized by metadataBase, so these builders take an explicit absolute base.
// ---------------------------------------------------------------------------

/**
 * Absolute public origin for hand-rendered URLs (JSON-LD). Same trust model as the root
 * layout's metadataBase: anchor to the CONFIGURED site URL; honor the request host only when
 * its hostname matches (the Host header is client-controllable — never trust it raw).
 */
export const resolveSiteBase = siteCache(async (): Promise<string> => {
    const settings = await getSettings();
    const configuredUrl = settings?.siteurl || settings?.home || settings?.site_url;
    let configured: URL | undefined;
    if (configuredUrl && /^https?:\/\//i.test(configuredUrl)) {
        try { configured = new URL(configuredUrl); } catch { /* malformed — ignore */ }
    }
    // The CONFIGURED siteurl is the canonical authority (the WordPress model), full stop. No
    // request-header fallback: headers() during the runtime render of a prerendered route is a
    // Next 16 hard error (500), and an unconfigured site is mid-install — its JSON-LD origin is
    // irrelevant for the minutes until the wizard writes siteurl.
    return (configured ? configured.origin : 'http://localhost:3000');
});

/** WebSite schema with a SearchAction pointing at the built-in /search route. */
export function buildWebSiteJsonLd(siteUrl: string, siteName: string, description?: string) {
    return {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: siteName,
        url: `${siteUrl}/`,
        ...(description ? { description } : {}),
        potentialAction: {
            '@type': 'SearchAction',
            target: { '@type': 'EntryPoint', urlTemplate: `${siteUrl}/search?q={search_term_string}` },
            'query-input': 'required name=search_term_string',
        },
    };
}

/** BlogPosting (posts) / WebPage (pages) schema for a single content item. */
export function buildPostJsonLd(post: Post, siteUrl: string, siteName?: string) {
    const url = `${siteUrl}/${post.slug || post.id}`;
    const images = pickOgImage(post)?.map((u) => (u.startsWith('/') ? `${siteUrl}${u}` : u));
    const description = htmlToText(post.excerpt || post.content || '', 160) || undefined;
    return {
        '@context': 'https://schema.org',
        '@type': post.type === 'page' ? 'WebPage' : 'BlogPosting',
        headline: post.title,
        url,
        mainEntityOfPage: url,
        ...(description ? { description } : {}),
        ...(post.date ? { datePublished: post.date } : {}),
        ...(post.author?.displayName ? { author: { '@type': 'Person', name: post.author.displayName } } : {}),
        ...(images?.length ? { image: images } : {}),
        ...(siteName ? { publisher: { '@type': 'Organization', name: siteName } } : {}),
    };
}

/** Serialize JSON-LD for a <script> tag, escaping `<` so `</script>` can't break out. */
export function jsonLdString(obj: unknown): string {
    return JSON.stringify(obj).replace(/</g, '\\u003c');
}
