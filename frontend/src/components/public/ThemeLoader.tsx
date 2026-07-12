"use client";

import { useEffect, useState } from "react";
import { themesApi } from "@/lib/api";
import { ASSET_VERSION } from "@/lib/assetVersion";

/**
 * Emits the WordJS UI framework stylesheet + the ACTIVE theme's style.css into <head>.
 *
 * The active-theme slug is resolved on the SERVER (app/(public)/layout.tsx → getSettings().theme)
 * and passed down as `initialSlug`, so the FIRST server-rendered paint already carries the correct
 * theme stylesheet — no flash of the wrong/default theme before a client fetch resolves (FOUC).
 * The client effect only re-checks on tab focus (to pick up a theme switch made in the admin in
 * another tab) and, when no slug was provided by the server (e.g. the Puck editor preview reuses
 * this shell), resolves it once. The framework loads first; the theme's :root tokens + rules
 * override it at equal specificity.
 */
export default function ThemeLoader({ initialSlug }: { initialSlug?: string | null }) {
    const [slug, setSlug] = useState<string>(initialSlug || "default");

    const refresh = async () => {
        try {
            const themes = await themesApi.list();
            const active = themes.find((t) => t.active) || themes.find((t) => t.slug === "default");
            if (active) setSlug((prev) => (prev !== active.slug ? active.slug : prev));
        } catch (error) {
            console.error("Failed to load active theme:", error);
        }
    };

    useEffect(() => {
        // The server already gave us the right slug — only resolve now if it didn't (editor preview).
        if (!initialSlug) refresh();
        const onFocus = () => refresh();
        window.addEventListener("focus", onFocus);
        return () => window.removeEventListener("focus", onFocus);
    }, [initialSlug]);

    // Stable, deterministic href (identical across SSR + hydration): keyed by slug, not Date.now().
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
            <link rel="stylesheet" href={`/public/css/wordjs-ui.css?v=${ASSET_VERSION}`} id="wjs-ui-framework" precedence="wjs-base" />
            <link rel="stylesheet" href={`/themes/${slug}/style.css?v=${slug}-${ASSET_VERSION}`} id="wjs-theme-stylesheet" precedence="wjs-theme" />
        </>
    );
}
