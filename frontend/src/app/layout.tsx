import type { Metadata } from "next";
import { Suspense } from "react";
import { Inter } from "next/font/google";
import "./globals.css";
import { SystemFontsLoader } from "@/components/SystemFontsLoader";
import { ModalProvider } from "@/contexts/ModalContext";
import { AnalyticsTracker } from '@/components/AnalyticsTracker';
import { getSettings } from "@/lib/server-api";

const inter = Inter({ subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
    // Use the shared server data layer (mono/split-aware base URL + request-deduped) instead of a
    // hand-rolled fetch — the old hardcoded http://localhost:3000 hit the HTTPS gateway and silently
    // fell back to the "WordJS" default.
    const settings = await getSettings();
    const title = settings?.blogname || "WordJS";
    const description = settings?.blogdescription || "WordPress-like CMS";
    const icon = settings?.site_icon || "/favicon.ico";

    const meta: Metadata = {
        title: { default: title, template: `%s | ${title}` },
        description,
        icons: { icon, apple: icon },
    };

    // metadataBase makes the relative canonical/OpenGraph URLs (e.g. "/my-post") resolve to absolute
    // URLs in the rendered <head>, which crawlers and social unfurlers require. Prefer the real
    // request host (the domain the visitor/crawler actually used), then a configured site URL; only
    // then fall back to Next's localhost default.
    let base: URL | undefined;
    try {
        const { headers } = await import("next/headers");
        const h = await headers();
        const host = h.get("x-forwarded-host") || h.get("host");
        const proto = h.get("x-forwarded-proto") || "https";
        if (host) base = new URL(`${proto}://${host}`);
    } catch { /* not in a request scope */ }
    if (!base) {
        const siteUrl = settings?.siteurl || settings?.home || settings?.site_url;
        if (siteUrl && /^https?:\/\//i.test(siteUrl)) {
            try { base = new URL(siteUrl); } catch { /* ignore malformed URL */ }
        }
    }
    if (base) meta.metadataBase = base;
    return meta;
}

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <link
                    rel="stylesheet"
                    href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"
                />
            </head>
            <body className={inter.className} suppressHydrationWarning>
                <ModalProvider>
                    <SystemFontsLoader />
                    {/* AnalyticsTracker uses useSearchParams → must be Suspense-wrapped to not
                        bail out static prerendering of every page. */}
                    <Suspense fallback={null}>
                        <AnalyticsTracker />
                    </Suspense>
                    {children}
                </ModalProvider>
            </body>
        </html>
    );
}
