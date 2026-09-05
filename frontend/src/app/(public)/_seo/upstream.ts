/**
 * THE PRETTY FEED / SITEMAP / ROBOTS URLS — one proxy behind ten route handlers.
 *
 * Everything a reader or a crawler asks for lives at the ROOT of the site: `/robots.txt`,
 * `/feed.xml`, `/sitemap.xml`, `/category/<slug>/feed.xml`. WordJS generates all of it in the
 * backend, under the `/api/v1/seo` mount — a prefix `robots.txt` itself tells crawlers to stay out of
 * (`Disallow: /api/`), and a path no feed reader would ever guess. So the public URLs are Next route
 * handlers that stream the backend's bytes back unchanged; the generator stays in one place and the
 * URL becomes the one the rest of the world expects — the same URL the documents now PRINT for
 * themselves (`publicSeoUrl`, backend/src/core/feeds.ts).
 *
 * WHERE THE REQUEST GOES IS server-api.ts's DECISION, NOT THIS FILE'S
 * -------------------------------------------------------------------
 * `serverFetch()` is the helper every public page uses, and it does exactly the right things — it
 * validates and canonicalises the backend base, proves the joined URL is still inside it, forwards
 * the CONFIGURED public host so the backend's Site-URL guard does not answer 409, and puts the read
 * in Next's Data Cache under a purge tag. It also ends in `res.json()`, and a sitemap is not JSON.
 * So this file reuses the three functions that choose the DESTINATION — `resolveServerBase`,
 * `backendUrl`, `configuredPublicHost` — and nothing else. It used to carry its own copy of them
 * (same allowlists, same canonicalisation, same containment check), which is a second place for a
 * security-relevant allowlist to be edited and only one of them to be.
 */
import { NextResponse } from 'next/server';
import { resolveServerBase, backendUrl, configuredPublicHost } from '@/lib/server-api';

/** Response headers worth carrying to the client: the type, and everything about freshness. */
const FORWARDED_HEADERS = ['content-type', 'cache-control', 'etag', 'last-modified'];

function plain(status: number, body: string): NextResponse {
    return new NextResponse(body, {
        status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
}

/**
 * A 404 the route itself decides — a chunk name the sitemap index could never have printed, a slug
 * longer than the backend would accept. Same shape as an upstream 404, so a client cannot tell which
 * side refused, and never cached.
 */
export function seoNotFound(): NextResponse {
    return plain(404, 'Not found');
}

export interface ProxyOptions {
    /**
     * Seconds this read stays in Next's Data Cache — the SAME window the upstream advertises
     * (`Cache-Control: public, max-age=…` in backend/src/routes/seo.ts), so the two never disagree
     * about how stale a feed may be.
     */
    revalidate: number;
    /** Purge tags. 'posts' is what a publish fires (backend/src/core/frontend-purge.ts). */
    tags?: string[];
}

/**
 * Stream one `/api/v1/seo/*` document back under its public URL.
 *
 * The body is passed through byte-for-byte: a feed is signed by nothing and read by machines, and
 * rewriting it here would fork the generator. Upstream 404 (an unknown term slug, a sitemap chunk
 * the index does not advertise) stays a 404; anything else — 5xx, an unreachable backend — is a 502,
 * never a cached empty document.
 */
export async function proxySeo(endpoint: string, options: ProxyOptions): Promise<NextResponse> {
    const url = backendUrl(resolveServerBase(), endpoint);
    if (!url) return plain(502, 'Bad gateway');

    const headers: Record<string, string> = {};
    const pub = configuredPublicHost();
    if (pub) {
        headers['x-forwarded-host'] = pub.host;
        headers['x-forwarded-proto'] = pub.proto;
    }

    let res: Response;
    try {
        res = await fetch(url, {
            headers,
            next: { revalidate: options.revalidate, tags: options.tags },
        } as RequestInit);
    } catch {
        return plain(502, 'Bad gateway');
    }

    if (res.status === 404) return plain(404, 'Not found');
    if (!res.ok) return plain(502, 'Bad gateway');

    const out = new Headers();
    for (const name of FORWARDED_HEADERS) {
        const value = res.headers.get(name);
        if (value) out.set(name, value);
    }
    return new NextResponse(res.body, { status: 200, headers: out });
}
