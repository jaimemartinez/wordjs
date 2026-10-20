/**
 * The core's own paths under a plugin portal (/portal/<slug>/…), beside the portal page itself
 * (app/portal/[slug]/[[...path]]): what a plugin's page cannot answer from a client bundle.
 *
 *   /portal/<slug>/file?d=<ticket>          the bytes of a file the plugin's file route describes (PDF, images)
 *   /portal/<slug>/sw.js                    the portal's service worker (frontend.portalPage.serviceWorker)
 *   /portal/<slug>/app.webmanifest?page=<p> the web app manifest of an installable sub-page (pages.<p>.app)
 *
 * Each asks the backend first (GET /plugins/<slug>/portal): a portal no active, granted plugin declares — or one
 * that declares none of these — is the same plain 404. Nothing here is cached by a shared cache.
 */
import { getPortalPage, type PortalPageInfo } from "@/lib/server-api";

// core/portal-pages.ts PORTAL_SLUG_RE: one lowercase URL segment.
export const PORTAL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** The served portal's details, or null (malformed slug, no such portal, backend unreachable). */
export async function servedPortal(slug: string): Promise<PortalPageInfo | null> {
    if (!PORTAL_SLUG_RE.test(slug)) return null;
    const portal = await getPortalPage(slug);
    return portal.status === "served" ? portal.info : null;
}

export function portalNotFound(): Response {
    return new Response("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
}
