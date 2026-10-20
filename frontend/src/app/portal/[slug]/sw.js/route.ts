/**
 * /portal/<slug>/sw.js — a plugin portal's service worker (frontend.portalPage.serviceWorker), as the plugin
 * ships it. Served from under the portal, so a page of the portal can register it with the portal (or one of
 * its sub-pages) as its scope — e.g. to show Web Push notifications with the page closed.
 */
import { serverResponse } from "@/lib/server-api";
import { portalNotFound, servedPortal } from "@/lib/portalRoutes";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const { slug } = await params;
    const info = await servedPortal(slug);
    if (!info || !info.serviceWorker) return portalNotFound();
    const res = await serverResponse(`/plugins/${encodeURIComponent(slug)}/portal/sw`);
    if (!res || !res.ok) return portalNotFound();
    const body = await res.text();
    return new Response(body, {
        status: 200,
        headers: {
            "Content-Type": "text/javascript; charset=utf-8",
            // The browser re-checks it on every update check, byte for byte.
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    });
}
