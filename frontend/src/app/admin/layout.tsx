import type { Metadata, Viewport } from "next";
import DashboardLayoutClient from "./DashboardLayoutClient";
import { declareSiteFromRequest, getSettings } from "@/lib/server-api";
import { inter } from "../fonts";
import RootDocument, { rootMetadata } from "../_root/RootDocument";
import "./admin-globals.css";

// Admin is an authenticated, data-driven dashboard (Sidebar/pages use useSearchParams);
// render it dynamically instead of static-prerendering, which would bail out on those hooks.
export const dynamic = 'force-dynamic';

// viewport-fit=cover: without it every env(safe-area-inset-*) is 0 on iOS, so full-screen admin UI (a
// plugin's camera scanner, bottom sheets) could not keep its controls clear of the home indicator and
// the notch. Next merges this key into the default `width=device-width, initial-scale=1`. The shell
// (DashboardLayoutClient) and the fullscreen editor pad themselves by the insets, so ordinary screens
// sit where they did before.
export const viewport: Viewport = {
    viewportFit: "cover",
};

export async function generateMetadata(): Promise<Metadata> {
    try {
        // Use the shared mono/split-aware server data layer (same as the root document) instead of a
        // manual fetch to hardcoded http://localhost:3000 — in monolith mode port 3000 serves
        // HTTPS, so the plain-HTTP fetch failed silently and caused route resolution issues in dev.
        // This layout is a root layout (see _root/RootDocument.tsx), so it carries the document's
        // metadata too. Multisite: declared first, so another site's admin is that site's in all of it
        // — its name, its title template, its icon.
        await declareSiteFromRequest();
        const [root, settings] = await Promise.all([rootMetadata(), getSettings()]);
        const baseTitle = settings?.blogname || "WordJS";
        const icon = settings?.site_icon ? `${settings.site_icon}?t=${Date.now()}` : "/favicon.svg";

        return {
            ...root,
            // The dashboard's own name as the default; its screens' titles go through the site's template.
            title: { default: `${baseTitle} | Admin`, template: `%s | ${baseTitle}` },
            icons: {
                icon: icon,
                apple: icon,
            }
        };
    } catch (_e) {
        return {
            title: "WordJS | Admin"
        };
    }
}

export default async function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    // Multisite: the document of another site's admin is that site's (its lang, its fonts). The admin is
    // dynamic anyway, so reading the edge's header costs nothing here.
    await declareSiteFromRequest();
    // inter.className re-applies the Inter face to the whole admin tree (the root <body> now
    // carries only inter.variable so the public tree can resolve fonts through wordjs-ui.css).
    // The wrapper covers every DashboardLayoutClient return path, including the fullscreen
    // Puck editor routes that bypass the admin shell.
    //
    // dir="ltr" is deliberate and TEMPORARY. The root layout now drives <html dir> from the site
    // locale, which is right for the published site — but this dashboard is hand-built from
    // physical Tailwind utilities (`left-4`, `pl-12`, `translate-x-6`, `-translate-y-1/2`) that do
    // NOT follow the writing direction, so an RTL site would get an admin whose text flows one way
    // and whose icons, toggles and sidebars flow the other. Pinning the subtree to ltr keeps the
    // admin exactly as it is today instead of shipping a half-mirrored one; remove this the moment
    // the dashboard's utilities are audited. The public tree is unaffected.
    return RootDocument({
        children: (
            <div dir="ltr" className={inter.className}>
                <DashboardLayoutClient>{children}</DashboardLayoutClient>
            </div>
        ),
    });
}
