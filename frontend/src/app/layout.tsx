import type { Metadata } from "next";
import { Suspense } from "react";
import { inter } from "./fonts";
import "./globals.css";
import { SystemFontsLoader } from "@/components/SystemFontsLoader";
import { ModalProvider } from "@/contexts/ModalContext";
import { AnalyticsTracker } from '@/components/AnalyticsTracker';
import { getSettings, getFonts } from "@/lib/server-api";
import { buildFontFaceCss } from "@/lib/fontFaceCss";
import { resolveDocumentLanguage } from "@/lib/documentLanguage";
import { ASSET_VERSION } from "@/lib/assetVersion";

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

    // The document's language and writing direction, from the SITE's own options — not a constant.
    // `lang="en"` was hardcoded here and there was no `dir` at all, so every site claimed to be
    // English and laid out left-to-right whatever it published, and no theme could fix it (a theme
    // gets one stylesheet and no head input; `direction: rtl` in CSS does not change what the
    // browser's bidi/hyphenation/quote behaviour thinks the document is). getSettings() is the same
    // request-deduped + ISR-cached read generateMetadata above already performs, so this adds no
    // fetch. resolveDocumentLanguage is fail-closed: an unparseable locale or an out-of-enum
    // direction yields en/ltr rather than reaching the attribute.
    const { lang, dir } = resolveDocumentLanguage(await getSettings());

    return (
        // inter.variable must live on <html>, not <body>: --wjs-font-family-base is declared in
        // ui.css :root, and a custom property's var() references substitute AT THE DECLARING
        // element — with --font-inter defined only on <body>, the :root token silently used its
        // literal 'Inter' fallback, which next/font never registers (system-font regression).
        <html lang={lang} dir={dir} className={inter.variable} suppressHydrationWarning>
            <head>
                {/* SELF-HOSTED Font Awesome (scripts/vendor-fontawesome.mjs → backend/public/vendor).
                    It used to come from cdnjs: a render-blocking stylesheet behind a third-party
                    DNS+TLS handshake on the critical path, a single point of failure for every page,
                    and a request that told a CDN who visits this site. Served from our own origin it
                    is same-connection, cacheable by us, and works offline/air-gapped. Not subsetted
                    on purpose: block content takes free-text `fa-*` names from authors. */}
                <link
                    rel="stylesheet"
                    href={`/public/vendor/fontawesome/css/all.min.css?v=${ASSET_VERSION}`}
                />
                {fontFaceCss && (
                    <style id="wjs-server-fonts" dangerouslySetInnerHTML={{ __html: fontFaceCss }} />
                )}
            </head>
            {/* No font class on <body>: the public tree's body font is owned by the wordjs-ui.css
                body rule (--wjs-font-family-base → var(--font-inter, …)); putting inter.className
                on <body> would win over it and lock every theme out of the base font. Non-(public)
                trees (admin, login, …) re-apply inter.className in their own layouts. */}
            <body suppressHydrationWarning>
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
