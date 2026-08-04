import type { Metadata } from "next";
import { Suspense } from "react";
import { Inter } from "next/font/google";
import "./globals.css";
import { SystemFontsLoader } from "@/components/SystemFontsLoader";
import { ModalProvider } from "@/contexts/ModalContext";
import { AnalyticsTracker } from '@/components/AnalyticsTracker';
import { getSettings, getFonts } from "@/lib/server-api";
import { buildFontFaceCss } from "@/lib/fontFaceCss";

// `variable` exposes the real (hashed) family through --font-inter. next/font registers the face
// as "__Inter_<hash>", never the literal "Inter" — so any stylesheet that says font-family: "Inter"
// (the Puck editor chrome via --puck-font-family) silently fell back to system-ui. Referencing
// var(--font-inter) resolves to the loaded webfont.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

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

    // metadataBase absolutizes the relative canonical/OpenGraph URLs (e.g. "/my-post") in the
    // rendered <head>, which crawlers and social unfurlers require. The request Host /
    // X-Forwarded-Host header is fully client-controllable, so trusting it raw lets an attacker
    // rewrite every canonical/og:url to their own domain (SEO/phishing poisoning). Anchor the base
    // to the CONFIGURED site URL, and only honor the request host when its hostname matches that
    // configured origin (an allowlist), so legit multi-host/proxy setups still get correct URLs.
    const configuredUrl = settings?.siteurl || settings?.home || settings?.site_url;
    let configuredBase: URL | undefined;
    if (configuredUrl && /^https?:\/\//i.test(configuredUrl)) {
        try { configuredBase = new URL(configuredUrl); } catch { /* ignore malformed URL */ }
    }

    // The CONFIGURED siteurl is the canonical authority, full stop. No request-header fallback:
    // headers() during the runtime render of a prerendered route is a Next 16 hard error (500 —
    // caught by the lab split gate on /about), and an unconfigured site is mid-install, where
    // canonical/og URLs don't matter yet. Relative metadata resolves against the request origin
    // anyway when metadataBase is absent.
    if (configuredBase) meta.metadataBase = configuredBase;
    return meta;
}

export default async function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    // Emit the installed fonts' @font-face rules into the INITIAL SSR <head>, so a page whose blocks
    // reference a custom font (via block css.fontFamily or a Tiptap inline `font-family` span) paints
    // in that font on first render instead of the theme fallback. Without this the faces were injected
    // only by SystemFontsLoader's client useEffect (below) — a flash of fallback, and a permanent
    // fallback whenever client JS was slow/blocked. getFonts is request-deduped + ISR-cached (300s).
    const fontFaceCss = buildFontFaceCss(await getFonts());

    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <link
                    rel="stylesheet"
                    href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"
                />
                {fontFaceCss && (
                    <style id="wjs-server-fonts" dangerouslySetInnerHTML={{ __html: fontFaceCss }} />
                )}
            </head>
            <body className={`${inter.className} ${inter.variable}`} suppressHydrationWarning>
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
