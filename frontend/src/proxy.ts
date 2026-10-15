/**
 * Multisite: render another site of the network from the `wjs-site/[siteHost]` route tree.
 *
 * The public listener's edge (the gateway, or the monolith's dispatcher — gateway/src/host-edge.js)
 * judges every request's address and, when it belongs to a site other than the main one, names that
 * site's main hostname in `x-wordjs-site-host`. It removes any value a client sent first, so the header
 * is the edge's verdict and nothing else. Here, a public page request carrying it is rewritten — inside
 * Next, invisible to the browser — to `/wjs-site/<host>/<path>`, whose pages read that site's data and
 * cache under that site's own path and tags.
 *
 * The main site, and every single-site install, never carries the header and is served exactly as
 * before. Its own requests for `/wjs-site/...` are answered 404: that tree is only ever reached through
 * this rewrite. Admin, sign-in, install and portal pages are never rewritten (they speak to the backend
 * from the browser, on the site's own address, so they are already that site's), and neither are
 * Next's assets or files with an extension other than the feed, sitemap and robots documents the
 * public tree serves.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const SITE_TREE = "/wjs-site";
const SITE_HOST_HEADER = "x-wordjs-site-host";
const SITE_HOST = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;
const NOT_PUBLIC_PAGES = /^\/(?:api|_next|admin|login|register|reset-password|verify-email|install|migration|portal|health|public|uploads|themes|plugins)(?:\/|$)/;
const PUBLIC_DOCUMENTS = /(?:^|\/)(?:feed\.xml|feed\.atom|feed\.json|robots\.txt|sitemap\.xml)$|^\/sitemap\/[^/]+$/;

function isPublicPage(pathname: string): boolean {
    if (NOT_PUBLIC_PAGES.test(pathname)) return false;
    const last = pathname.slice(pathname.lastIndexOf("/") + 1);
    return !last.includes(".") || PUBLIC_DOCUMENTS.test(pathname);
}

export function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl;
    const raw = request.headers.get(SITE_HOST_HEADER);
    if (raw === null) {
        if (pathname === SITE_TREE || pathname.startsWith(SITE_TREE + "/")) {
            return new NextResponse("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
        }
        return NextResponse.next();
    }
    const host = raw.trim().toLowerCase();
    if (host.length > 253 || !SITE_HOST.test(host)) {
        return new NextResponse("Bad Request", { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    if (!isPublicPage(pathname)) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = `${SITE_TREE}/${host}${pathname === "/" ? "" : pathname}`;
    return NextResponse.rewrite(url);
}

export const config = {
    // Everything but Next's own assets; the function above decides what it touches.
    matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
