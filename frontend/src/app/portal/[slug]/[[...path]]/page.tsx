import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { getPortalPage } from "@/lib/server-api";
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
 * A static folder beside this one (app/portal/conference, …) is a route of its own and wins over it.
 */

// The shape the backend accepts (core/portal-pages.ts PORTAL_SLUG_RE): one lowercase URL segment.
const PORTAL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

type Props = { params: Promise<{ slug: string; path?: string[] }> };

// Portals are opened from a link or a QR code someone was given, not found through a search engine.
const ROBOTS = { index: false, follow: false } as const;

async function servedInfo(slug: string) {
    if (!PORTAL_SLUG_RE.test(slug)) return null;
    const portal = await getPortalPage(slug);
    return portal.status === "served" ? portal.info : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const info = await servedInfo((await params).slug);
    return info?.title ? { title: info.title, robots: ROBOTS } : { robots: ROBOTS };
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
