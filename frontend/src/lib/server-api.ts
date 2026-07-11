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

/**
 * Resolve the backend base URL for server-side fetches. Mirrors the SSR branch of lib/api.ts'
 * getBaseUrl() so split and monolith modes behave identically:
 *  - monolith: the in-process backend's plain-HTTP loopback listener (self-signed TLS never blocks SSR)
 *  - split:    the backend's own HTTP port (default 4000), read from wordjs-config.json
 *  - override: INTERNAL_API_URL (full `.../api/v1`) wins when set
 */
function resolveServerBase(): string {
    if (process.env.WORDJS_MODE === 'mono') {
        return `${process.env.WORDJS_MONO_ORIGIN || 'http://127.0.0.1:4000'}/api/v1`;
    }
    if (process.env.INTERNAL_API_URL) {
        return process.env.INTERNAL_API_URL.replace(/\/+$/, '');
    }
    let backendPort = 4000;
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
            if (cfg.port) backendPort = cfg.port;
        }
    } catch {
        /* fall back to default port 4000 */
    }
    return `http://localhost:${backendPort}/api/v1`;
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
    const base = resolveServerBase();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // Forward the real public host/proto to the backend. SSR fetches hit the loopback origin
    // (127.0.0.1:4000), so without this the backend's host-based logic — the Site-URL/migration
    // guard, CSRF origin check, canonical/sitemap URLs — would see "localhost:4000" instead of the
    // public host and (e.g.) reject every SSR request with a 409 migration_required. The public
    // listener (gateway/monolith) already pins x-forwarded-host to the browser's Host, so we just
    // relay it one more hop to the backend.
    try {
        const { headers: nextHeaders } = await import('next/headers');
        const inbound = await nextHeaders();
        const host = inbound.get('x-forwarded-host') || inbound.get('host');
        if (host) {
            headers['x-forwarded-host'] = host;
            headers['x-forwarded-proto'] = inbound.get('x-forwarded-proto') || 'https';
        }
        if (options.forwardCookies) {
            const cookieHeader = inbound.get('cookie');
            if (cookieHeader) headers['cookie'] = cookieHeader;
        }
    } catch {
        /* not in a request scope (e.g. build prerender) — proceed without forwarded headers */
    }

    // Per-user reads (cookie-forwarded) must NEVER be cached/shared → no-store. Public reads opt into
    // Next's Data Cache when the caller passed a `revalidate` window (ISR), else stay dynamic (no-store).
    const cacheInit: RequestInit = options.forwardCookies || options.revalidate == null
        ? { cache: 'no-store' }
        : ({ next: { revalidate: options.revalidate, tags: options.tags } } as RequestInit);

    try {
        const res = await fetch(`${base}${endpoint}`, { headers, ...cacheInit });
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
export const checkSetupRequired = cache(async (): Promise<boolean> => {
    const base = resolveServerBase();
    try {
        const res = await fetch(`${base}/settings`, { cache: 'no-store' });
        if (res.status !== 503) return false;
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

    return { title, description, alternates: { canonical }, openGraph, twitter };
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
    let base = configured;
    try {
        const { headers } = await import('next/headers');
        const h = await headers();
        const host = h.get('x-forwarded-host') || h.get('host');
        const proto = h.get('x-forwarded-proto') || 'https';
        if (host) {
            const reqHostname = host.split(':')[0].toLowerCase();
            const allowed = configured?.hostname.toLowerCase();
            if (!allowed || reqHostname === allowed) {
                try { base = new URL(`${proto}://${host}`); } catch { /* keep configured */ }
            }
        }
    } catch { /* not in a request scope */ }
    return (base ? base.origin : 'http://localhost:3000');
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
