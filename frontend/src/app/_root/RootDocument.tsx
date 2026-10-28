/**
 * THE DOCUMENT every page is rendered into: `<html lang dir>`, the server-rendered @font-face rules, the
 * self-hosted icon font and the providers every tree shares — and the metadata that names the site.
 *
 * WHY IT IS NOT app/layout.tsx. A root layout takes no params, so one shared root layout could only ever
 * describe the MAIN site: another site of a multisite network (rewritten by src/proxy.ts to the internal
 * `wjs-site/[siteHost]` tree) got the main site's `lang`, its fonts and its name in the sign-in pages'
 * titles. So there is no app/layout.tsx any more: every top-level tree's own layout is a root layout
 * (Next allows several — any layout without one above it is a root layout) and renders this document.
 * `wjs-site/[siteHost]/layout.tsx` is that site's root layout: it declares the site from its route param
 * (setRequestSite) BEFORE calling this, so every read below is that site's, cached under its own tags.
 * The main site's trees declare nothing and read exactly what the single root layout read before: the
 * same request-deduped, ISR-cached getSettings/getFonts, no request header, no extra rewrite.
 *
 * Called as a function (`return RootDocument({ children })`), not mounted as <RootDocument>: the layouts
 * await it so the document is ready markup, and the render tests can render it without an async-aware
 * renderer. Navigating between two root layouts is a full page load (Next's rule), which is what moving
 * between the public site, the admin and the sign-in screens costs now; within a tree nothing changed.
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { inter } from "@/app/fonts";
import "@/app/globals.css";
import { SystemFontsLoader } from "@/components/SystemFontsLoader";
import UserContentAnchors from "@/components/UserContentAnchors";
import HostNotAllowedNotice from "@/components/HostNotAllowedNotice";
import { ModalProvider } from "@/contexts/ModalContext";
import { AnalyticsTracker } from '@/components/AnalyticsTracker';
import { getSettings, getFonts } from "@/lib/server-api";
import { buildFontFaceCss } from "@/lib/fontFaceCss";
import { resolveDocumentLanguage } from "@/lib/documentLanguage";
import { ASSET_VERSION } from "@/lib/assetVersion";

/** The document's metadata: the site's name (and the title template every page's title goes through), its description, icon and canonical base. */
export async function rootMetadata(): Promise<Metadata> {
    // Use the shared server data layer (mono/split-aware base URL + request-deduped) instead of a
    // hand-rolled fetch — the old hardcoded http://localhost:3000 hit the HTTPS gateway and silently
    // fell back to the "WordJS" default.
    const settings = await getSettings();
    const title = settings?.blogname || "WordJS";
    const description = settings?.blogdescription || "WordPress-like CMS";
    // The bundled mark when the site has no icon of its own: there is no /favicon.ico, so every page
    // logged a 404 for it.
    const icon = settings?.site_icon || "/favicon.svg";

    const meta: Metadata = {
        title: { default: title, template: `%s | ${title}` },
        description,
        icons: { icon, apple: icon },
    };
    // Settings → Reading «Discourage search engines from indexing this site» (blog_public = '0'): every
    // page says noindex (robots.txt says Disallow too, backend/src/routes/seo.ts). It was stored and never read.
    const blogPublic = (settings as Record<string, unknown> | null)?.blog_public;
    if (blogPublic === 0 || blogPublic === "0" || blogPublic === false) meta.robots = { index: false, follow: false };

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

export default async function RootDocument({
    children,
    uiLanguage,
}: {
    children: React.ReactNode;
    /**
     * The admin and sign-in screens render in the ADMIN's language (lib/adminLanguage.server.ts), which
     * can differ from the site's: `<html lang>` then follows the screen, not the site. Only an admin
     * language code (es/en/pt) is ever passed here.
     */
    uiLanguage?: "es" | "en" | "pt";
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
    // request-deduped + ISR-cached read rootMetadata above already performs, so this adds no
    // fetch. resolveDocumentLanguage is fail-closed: an unparseable locale or an out-of-enum
    // direction yields en/ltr rather than reaching the attribute.
    const settings = await getSettings();
    const resolved = resolveDocumentLanguage(settings);
    const lang = uiLanguage ?? resolved.lang;
    const dir = uiLanguage ? "ltr" : resolved.dir; // every admin language is left-to-right
    // The configured main address, for the refused-address notice's one link. The same chain
    // rootMetadata uses for metadataBase: never the request host, which is the thing in question.
    const canonical = settings?.siteurl || settings?.home || null;

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
                {/* Always present, even empty: it tells SystemFontsLoader the server already wrote the faces. */}
                <style id="wjs-server-fonts" dangerouslySetInnerHTML={{ __html: fontFaceCss || "" }} />
            </head>
            {/* No font class on <body>: the public tree's body font is owned by the wordjs-ui.css
                body rule (--wjs-font-family-base → var(--font-inter, …)); putting inter.className
                on <body> would win over it and lock every theme out of the base font. Non-(public)
                trees (admin, login, …) re-apply inter.className in their own layouts. */}
            <body suppressHydrationWarning>
                <ModalProvider>
                    <HostNotAllowedNotice canonical={canonical} documentLang={lang} />
                    <SystemFontsLoader />
                    <UserContentAnchors />
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
