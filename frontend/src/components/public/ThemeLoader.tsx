"use client";

import { useEffect, useState } from "react";
import { settingsApi } from "@/lib/api";
import { themeStylesheetHref, uiFrameworkHref } from "@/lib/assetVersion";

/**
 * Emits the WordJS UI framework stylesheet + the ACTIVE theme's style.css into <head>.
 *
 * The active-theme slug AND its version are resolved on the SERVER (app/(public)/layout.tsx →
 * getSettings() → `template` + the derived `active_theme_version`) and passed down as props, so the
 * FIRST server-rendered paint already carries the correct theme stylesheet — no flash of the
 * wrong/default theme before a client fetch resolves (FOUC).
 */
export default function ThemeLoader({
    initialSlug,
    initialThemeVersion,
}: {
    initialSlug?: string | null;
    initialThemeVersion?: string | null;
}) {
    const [theme, setTheme] = useState<{ slug: string; version: string }>({
        slug: initialSlug || "default",
        version: initialThemeVersion || "",
    });

    // NO PER-VISITOR POLLING. This used to re-fetch GET /api/v1/themes on every tab focus of every
    // visitor — an unauthenticated request that ran a synchronous themes-dir scan on the server — just
    // to notice a theme switch made in another tab. The server is the authority now: switching or
    // editing a theme purges the 'settings' tag (core/frontend-purge.ts), so the next navigation serves
    // HTML with the new slug/version, and the versioned href below busts the browser's cached CSS. An
    // ALREADY-OPEN public tab keeps the theme it was rendered with until it navigates — deliberate, and
    // far cheaper than a request per visitor per focus.
    //
    // The one client resolve left is for the Puck editor preview, which reuses this shell WITHOUT
    // server props (PuckEditor renders <PublicLayoutShell/> bare). It reads the settings endpoint —
    // cheap, cached, no fs — once, not on a timer.
    useEffect(() => {
        if (initialSlug) return;
        let cancelled = false;
        settingsApi.get()
            .then((settings) => {
                if (cancelled) return;
                const slug = settings?.template || "default";
                const version = settings?.active_theme_version || "";
                setTheme((prev) => (prev.slug === slug && prev.version === version ? prev : { slug, version }));
            })
            .catch((error) => console.error("Failed to resolve active theme:", error));
        return () => { cancelled = true; };
    }, [initialSlug]);

    // Stable, deterministic href (identical across SSR + hydration): built from server-provided values,
    // never from Date.now() or anything recomputed on the client.
    const href = themeStylesheetHref(theme.slug, theme.version);

    // Evict the PREVIOUS theme's stylesheet when the href changes at runtime. React treats `precedence`
    // stylesheets as add-only: rendering the new href inserts a new <link> but the old one is never
    // removed, so BOTH sheets stayed applied and whichever loaded last won the cascade (wrong
    // colors/typography until a full reload). Matched on the exact href, not just the slug, so a
    // VERSION-only change (theme edited in place) evicts the stale sheet too.
    // React no longer renders the stale href after this re-render, so removing the orphaned node is
    // safe — nothing re-inserts it.
    useEffect(() => {
        document.querySelectorAll('link[rel="stylesheet"][href*="/themes/"]').forEach((l) => {
            if (l.getAttribute("href") !== href) l.remove();
        });
    }, [href]);

    // express.static serves theme CSS with ETag/Last-Modified, so content updates revalidate fresh.
    //
    // `precedence` is required: without it React 19 leaves these <link>s where the component renders
    // (in the body) as NON-render-blocking resources, so the page painted with fallback token values
    // and only restyled once the CSS finished loading — a flash of unstyled/unthemed content. With a
    // precedence React hoists them into <head> and treats them as render-blocking, so the theme is
    // applied on first paint. The framework precedence group is declared first so the theme's :root
    // (which must win) cascades after it.
    return (
        <>
            <link rel="stylesheet" href={uiFrameworkHref()} id="wjs-ui-framework" precedence="wjs-base" />
            <link rel="stylesheet" href={href} id="wjs-theme-stylesheet" precedence="wjs-theme" />
        </>
    );
}
