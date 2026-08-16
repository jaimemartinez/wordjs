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
 */
function backendBaseCandidates(): string[] {
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

/** The validated, canonical backend API base. Always a well-formed `scheme://host[:port][/path]`. */
function resolveServerBase(): string {
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
 */
function backendUrl(base: string, endpoint: string): string | null {
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
let _pubHost: { value: { host: string; proto: string } | null; at: number } | null = null;
function configuredPublicHost(): { host: string; proto: string } | null {
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
    if (options.forwardCookies) {
        try {
            const { headers: nextHeaders } = await import('next/headers');
            const inbound = await nextHeaders();
            const host = inbound.get('x-forwarded-host') || inbound.get('host');
            if (host) {
                headers['x-forwarded-host'] = host;
                headers['x-forwarded-proto'] = inbound.get('x-forwarded-proto') || 'https';
            }
            const cookieHeader = inbound.get('cookie');
            if (cookieHeader) headers['cookie'] = cookieHeader;
        } catch {
            /* not in a request scope (e.g. build prerender) — proceed without forwarded headers */
        }
    } else {
        const pub = configuredPublicHost();
        if (pub) {
            headers['x-forwarded-host'] = pub.host;
            headers['x-forwarded-proto'] = pub.proto;
        }
    }

    // Per-user reads (cookie-forwarded) must NEVER be cached/shared → no-store. Public reads opt into
    // Next's Data Cache when the caller passed a `revalidate` window (ISR), else stay dynamic (no-store).
    const cacheInit: RequestInit = options.forwardCookies || options.revalidate == null
        ? { cache: 'no-store' }
        : ({ next: { revalidate: options.revalidate, tags: options.tags } } as RequestInit);

    try {
        const res = await fetch(url, { headers, ...cacheInit });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        // Backend unreachable during SSR — caller decides how to degrade.
        return null;
    }
}

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
export const checkSetupRequired = cache(async (): Promise<boolean> => {
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
export const getSettings = cache((): Promise<Record<string, string> | null> =>
    serverFetch<Record<string, string>>('/settings', { revalidate: 60, tags: ['settings'] })
);

export interface PublicAssets {
    scripts: { handle: string; src: string; inFooter?: boolean; strategy?: string }[];
    styles: { handle: string; src: string; media?: string }[];
}

/** Plugin-enqueued frontend scripts/styles (active plugins only), rendered by the public layout. */
export const getPublicAssets = cache((): Promise<PublicAssets> =>
    serverFetch<PublicAssets>('/plugins/assets', { revalidate: 120, tags: ['plugin-assets'] }).then((a) => a || { scripts: [], styles: [] })
);

/**
 * Installed fonts, fetched on the SERVER so their @font-face rules can be emitted into the initial
 * SSR <head> (see app/layout.tsx). Previously fonts were injected only client-side (SystemFontsLoader
 * useEffect), so a public page's first paint had the inline `font-family` but no matching face and fell
 * back to the theme font until hydration — a font changed in the editor appeared unreflected on public.
 */
export const getFonts = cache((): Promise<import('./fontFaceCss').WjsFont[]> =>
    serverFetch<import('./fontFaceCss').WjsFont[]>('/fonts', { revalidate: 300, tags: ['fonts'] }).then((f) => f || [])
);

/**
 * A location menu (header/footer/…) for the public chrome, fetched on the SERVER so the Header/Footer
 * render their nav in the initial SSR HTML instead of each visitor re-fetching it client-side on
 * hydration. Cached + tagged like the other public reads.
 */
export const getMenuByLocation = cache((location: string): Promise<{ items: MenuItem[] } | null> =>
    serverFetch<{ items: MenuItem[] }>(`/menus/location/${encodeURIComponent(location)}`, { revalidate: 60, tags: ['menus', `menu:${location}`] })
);
// `parent` is the flat hierarchy the location endpoint returns (MenuItem.toJSON → post_parent /
// _menu_item_menu_item_parent). buildMenuTree nests it into ChromeNav submenus; 0 means a root item.
export interface MenuItem { id: number | string; title: string; url: string; order?: number; parent?: number | string; }

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
export const getThemeTemplate = cache(async (slug: string, name: string): Promise<string | null> => {
    if (!/^[a-z0-9-]{1,40}$/.test(name)) return null;
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
export const getThemeManifest = cache(async (slug: string): Promise<string | null> => {
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
export const getThemeChrome = cache(async (slug: string, part: string): Promise<string | null> => {
    if (!/^[a-z0-9-]{1,40}$/.test(part)) return null;
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
 * Draft-preview loader: forwards the admin's session cookie, so the backend's
 * GET /posts/slug/:slug (optionalAuth) returns non-published posts to their author /
 * editors. A separate cache() entry from getPostBySlug keeps the keying correct.
 */
export const getPostBySlugPreview = cache((slug: string): Promise<Post | null> =>
    serverFetch<Post>(`/posts/slug/${encodeURIComponent(slug)}`, { forwardCookies: true })
);

export const getPostBySlug = cache((slug: string): Promise<Post | null> =>
    serverFetch<Post>(`/posts/slug/${encodeURIComponent(slug)}`, { revalidate: 30, tags: ['posts', `post:${slug}`] })
);

export const getPostById = cache((id: number): Promise<Post | null> =>
    serverFetch<Post>(`/posts/${id}`, { revalidate: 30, tags: ['posts', `post:${id}`] })
);

export const getPosts = cache((type = 'post', status = 'publish'): Promise<Post[] | null> =>
    serverFetch<Post[]>(`/posts?type=${encodeURIComponent(type)}&status=${encodeURIComponent(status)}`, { revalidate: 30, tags: ['posts', `posts:${type}`] })
);

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
    const m = (post.meta || {}) as Record<string, unknown>;
    const candidate = m.featured_image || m._thumbnail_url || m.thumbnail || m.og_image || m.image;
    if (typeof candidate === 'string' && /^(https?:\/\/|\/)/i.test(candidate)) return [candidate];
    return undefined;
}

/** Build full SEO metadata (title, description, OpenGraph, Twitter, canonical) for a post/page. */
export function buildPostMetadata(
    post: Post,
    opts: { siteName?: string; canonicalPath?: string } = {}
): Metadata {
    const title = post.title || 'Untitled';
    const description = htmlToText(post.excerpt || post.content || '', 160) || undefined;
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
export const resolveSiteBase = cache(async (): Promise<string> => {
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
