/**
 * /portal/<slug>/app.webmanifest?page=<page> — the web app manifest of an installable portal sub-page
 * (frontend.portalPage.pages.<page>.app): what a phone needs to add /portal/<slug>/<page> to its home screen
 * (on an iPhone, before it delivers that page's Web Push notifications). Built from the backend's validated
 * details only; scoped to that sub-page.
 */
import { portalNotFound, servedPortal, PORTAL_SLUG_RE } from "@/lib/portalRoutes";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
    const { slug } = await params;
    const page = new URL(request.url).searchParams.get("page") || "";
    if (!PORTAL_SLUG_RE.test(page)) return portalNotFound();
    const info = await servedPortal(slug);
    const sub = info?.pages && Object.prototype.hasOwnProperty.call(info.pages, page) ? info.pages[page] : null;
    if (!sub || !sub.app) return portalNotFound();
    const scope = `/portal/${slug}/${page}`;
    const manifest: Record<string, unknown> = {
        name: sub.app.name,
        short_name: sub.app.shortName || sub.app.name,
        scope,
        start_url: scope,
        display: "standalone",
    };
    if (sub.app.description) manifest.description = sub.app.description;
    if (sub.app.backgroundColor) manifest.background_color = sub.app.backgroundColor;
    const theme = sub.app.themeColor || info?.themeColor;
    if (theme) manifest.theme_color = theme;
    // One PNG (512x512 recommended) for both sizes a home screen asks for.
    const icon = sub.app.icon;
    if (icon) manifest.icons = ["192x192", "512x512"].map((sizes) => ({ src: icon, sizes, type: "image/png", purpose: "any maskable" }));
    return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: {
            "Content-Type": "application/manifest+json; charset=utf-8",
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    });
}
