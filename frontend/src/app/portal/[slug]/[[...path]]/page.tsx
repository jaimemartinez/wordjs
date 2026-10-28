import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { getPortalPage, type PortalPageInfo, type PortalSubPageInfo } from "@/lib/server-api";
import PluginPortal from "./PluginPortal";

/**
 * /portal/<slug>[/…] — the standalone public page a plugin declares in its manifest:
 *
 *   "frontend": { "portalPage": { "entry": "client/portal/page.tsx", "slug": "<slug>",
 *                                 "title"?, "themeColor"?, "viewportFit"? } }
 *
 * (backend core/portal-pages.ts). The backend decides whether the portal exists: GET
 * /plugins/<slug>/portal answers only for an active plugin granted browser:script — the same gate as the
 * portal's bundle — so a deactivated plugin's portal is a real 404 even in a production build that
 * compiled its page in. The page itself is client-only (PluginPortal): the visitor's query string and
 * hash reach it untouched, and so does any deeper path — /portal/<slug>/a/b renders the same portal with
 * path ["a", "b"], so a plugin can keep sub-pages (a personal confirmation link, say) under its slug.
 *
 * A sub-page the manifest describes (frontend.portalPage.pages.<page>) gets its own <head>: its title, a
 * personal page's privacy (never indexed, never stored by a browser, no Referer) and, for an installable
 * page, its web app manifest (app.webmanifest/route.ts beside this folder). The core's own paths under a
 * portal — file, sw.js, app.webmanifest — are sibling routes and win over this one.
 *
 * A static folder beside this one (app/portal/<name>) is a route of its own and wins over it.
 */

// Rendered on every request and never stored by a browser: whether the portal is served is per-install state
// (activation, grants), and a phone must not keep an old copy of a page (and its old scripts) after an update.
export const dynamic = "force-dynamic";

// The shape the backend accepts (core/portal-pages.ts PORTAL_SLUG_RE): one lowercase URL segment.
const PORTAL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

type Props = { params: Promise<{ slug: string; path?: string[] }> };

// Portals are opened from a link or a QR code someone was given, not found through a search engine.
const ROBOTS = { index: false, follow: false } as const;

// A personal sub-page: also never stored by a cache.
const PRIVATE_ROBOTS = { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } as const;

async function servedInfo(slug: string) {
    if (!PORTAL_SLUG_RE.test(slug)) return null;
    const portal = await getPortalPage(slug);
    return portal.status === "served" ? portal.info : null;
}

/** The manifest's details of the sub-page /portal/<slug>/<path[0]>, if it describes that page. */
function subPageOf(info: PortalPageInfo | null, path: string[] | undefined): PortalSubPageInfo | null {
    const page = path && path.length ? path[0] : null;
    if (!info?.pages || !page || !Object.prototype.hasOwnProperty.call(info.pages, page)) return null;
    return info.pages[page];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { slug, path } = await params;
    const info = await servedInfo(slug);
    const sub = subPageOf(info, path);
    const title = sub?.title || info?.title;
    const meta: Metadata = { robots: sub?.private ? PRIVATE_ROBOTS : ROBOTS };
    if (title) meta.title = title;
    if (sub?.private) meta.referrer = "no-referrer";
    if (sub?.app && path) {
        meta.manifest = `/portal/${slug}/app.webmanifest?page=${encodeURIComponent(path[0])}`;
        meta.appleWebApp = { capable: true, title: sub.app.shortName || sub.app.name, statusBarStyle: "default" };
        // <link rel="apple-touch-icon">: an iPhone ignores the web app manifest's icons.
        if (sub.app.icon) meta.icons = { apple: sub.app.icon };
    }
    return meta;
}

export async function generateViewport({ params }: Props): Promise<Viewport> {
    const info = await servedInfo((await params).slug);
    return {
        width: "device-width",
        initialScale: 1,
        // Opt-in (manifest viewportFit): "cover" is for a page that pads itself with env(safe-area-inset-*).
        ...(info?.viewportFit ? { viewportFit: info.viewportFit } : {}),
        ...(info?.themeColor ? { themeColor: info.themeColor } : {}),
    };
}

export default async function PortalPage({ params }: Props) {
    const { slug, path = [] } = await params;
    if (!PORTAL_SLUG_RE.test(slug)) notFound();
    // 'unavailable' (no usable answer from the backend) still renders: the client reports it, rather than
    // this page claiming that a portal which may well exist does not.
    if ((await getPortalPage(slug)).status === "missing") notFound();
    return <PluginPortal slug={slug} path={path} />;
}
