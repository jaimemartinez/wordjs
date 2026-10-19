/**
 * Multisite: send another site of the network to the `wjs-site/[siteHost]` route tree.
 *
 * The public listener's edge (the gateway, or the monolith's dispatcher — gateway/src/host-edge.js)
 * judges every request's address and, when it belongs to a site other than the main one, names that
 * site's main hostname in `x-wordjs-site-host`. It removes any value a client sent first, so the header
 * is the edge's verdict and nothing else.
 *
 * This function only DECIDES. For a public page of such a site it sets the internal request header
 * `x-wordjs-site-route` to the validated host, and the `beforeFiles` rewrite in next.config.ts does the
 * rewrite to `/wjs-site/<host>/<path>`. A rewrite declared in the config is always internal. One returned
 * from here is internal only when its URL has the same origin as the one Next built for the request, and
 * behind the gateway's mTLS hop Next builds those two from different inputs (the TLS socket and
 * X-Forwarded-Proto), so a rewrite from here went back out through the gateway as a fetch, without the
 * site header, and answered 404.
 *
 * The main site, and every single-site install, never carries the header and is served exactly as before.
 * A client's own `x-wordjs-site-route` is always removed. The main site's own requests for `/wjs-site/...`
 * are answered 404: that tree is only ever reached through the rewrite. Admin, sign-in, install and portal
 * pages are never rewritten (they speak to the backend from the browser, on the site's own address, so
 * they are already that site's), and neither are Next's assets or files with an extension other than the
 * feed, sitemap and robots documents the public tree serves.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const SITE_TREE = "/wjs-site";
const SITE_HOST_HEADER = "x-wordjs-site-host";
/** The internal header next.config.ts's multisite rewrite matches on. Set only here. */
const SITE_ROUTE_HEADER = "x-wordjs-site-route";
const SITE_HOST = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;
const NOT_PUBLIC_PAGES = /^\/(?:api|_next|admin|login|register|reset-password|verify-email|install|migration|portal|health|public|uploads|themes|plugins|fonts)(?:\/|$)/;
const PUBLIC_DOCUMENTS = /(?:^|\/)(?:feed\.xml|feed\.atom|feed\.json|robots\.txt|sitemap\.xml)$|^\/sitemap\/[^/]+$/;

function isPublicPage(pathname: string): boolean {
    if (NOT_PUBLIC_PAGES.test(pathname)) return false;
    const last = pathname.slice(pathname.lastIndexOf("/") + 1);
    return !last.includes(".") || PUBLIC_DOCUMENTS.test(pathname);
}

export function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl;
    const headers = new Headers(request.headers);
    headers.delete(SITE_ROUTE_HEADER);
    const pass = () => NextResponse.next({ request: { headers } });

    const raw = request.headers.get(SITE_HOST_HEADER);
    if (raw === null) {
        if (pathname === SITE_TREE || pathname.startsWith(SITE_TREE + "/")) {
            return new NextResponse("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
        }
        return pass();
    }
    const host = raw.trim().toLowerCase();
    if (host.length > 253 || !SITE_HOST.test(host)) {
        return new NextResponse("Bad Request", { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    if (isPublicPage(pathname)) headers.set(SITE_ROUTE_HEADER, host);
    return pass();
}

export const config = {
    // Everything but Next's own assets; the function above decides what it touches.
    matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
