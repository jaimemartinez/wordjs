import type { Metadata } from "next";
import DashboardLayoutClient from "./DashboardLayoutClient";

import { headers } from 'next/headers';

export async function generateMetadata(): Promise<Metadata> {
    try {
        // Zero-config default: Connect directly to the backend on port 3000 for SSR
        const apiUrl = process.env.INTERNAL_API_URL || "http://localhost:3000/api/v1";

        const res = await fetch(`${apiUrl}/settings`, {
            cache: 'no-store'
        });
        const settings = await res.json();
        const baseTitle = settings.blogname || "WordJS";
        const icon = settings.site_icon ? `${settings.site_icon}?t=${Date.now()}` : "/favicon.ico";

        return {
            title: `${baseTitle} | Admin`,
            icons: {
                icon: icon,
                apple: icon,
            }
        };
    } catch (e) {
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
