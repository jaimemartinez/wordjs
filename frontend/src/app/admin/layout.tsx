import type { Metadata } from "next";
import DashboardLayoutClient from "./DashboardLayoutClient";
import { getSettings } from "@/lib/server-api";
import { inter } from "../fonts";
import "./admin-globals.css";

// Admin is an authenticated, data-driven dashboard (Sidebar/pages use useSearchParams);
// render it dynamically instead of static-prerendering, which would bail out on those hooks.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    try {
        // Use the shared mono/split-aware server data layer (same as root layout) instead of a
        // manual fetch to hardcoded http://localhost:3000 — in monolith mode port 3000 serves
        // HTTPS, so the plain-HTTP fetch failed silently and caused route resolution issues in dev.
        const settings = await getSettings();
        const baseTitle = settings?.blogname || "WordJS";
        const icon = settings?.site_icon ? `${settings.site_icon}?t=${Date.now()}` : "/favicon.ico";

        return {
            title: `${baseTitle} | Admin`,
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

export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
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
    return (
        <div dir="ltr" className={inter.className}>
            <DashboardLayoutClient>{children}</DashboardLayoutClient>
        </div>
    );
}
