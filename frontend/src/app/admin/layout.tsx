import type { Metadata } from "next";
import DashboardLayoutClient from "./DashboardLayoutClient";
import { getSettings } from "@/lib/server-api";

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
    return <DashboardLayoutClient>{children}</DashboardLayoutClient>;
}
