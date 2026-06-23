"use client";

import { useEffect, useState } from "react";
import { themesApi, Theme } from "@/lib/api";

export default function ThemeLoader() {
    const [activeTheme, setActiveTheme] = useState<Theme | null>(null);

    const loadTheme = async () => {
        try {
            const themes = await themesApi.list();
            const active = themes.find(t => t.active);

            // If we found an active theme, set it
            if (active) {
                // Only update if changed to prevent flickering
                setActiveTheme(prev => (prev?.slug !== active.slug ? active : prev));
            } else {
                // Fallback to 'default' if no active theme found
                const defaultTheme = themes.find(t => t.slug === 'default');
                if (defaultTheme) setActiveTheme(defaultTheme);
            }
        } catch (error) {
            console.error("Failed to load active theme:", error);
        }
    };

    useEffect(() => {
        // Initial load
        loadTheme();

        // Check for theme changes when user comes back to the tab
        const onFocus = () => loadTheme();
        window.addEventListener('focus', onFocus);

        return () => window.removeEventListener('focus', onFocus);
    }, []);

    // The shared WordJS UI framework (token-driven base elements + components + utilities) loads
    // FIRST, so the theme's own style.css (its `:root` tokens + custom rules, loaded after) overrides
    // it at equal specificity. It's static, so it can always render — even while the active theme is
    // still resolving — which also prevents an unstyled flash of content.
    const framework = (
        <link rel="stylesheet" href="/public/css/wordjs-ui.css" id="wjs-ui-framework" />
    );

    if (!activeTheme) {
        // Safe fallback while loading (prevents FOUC if possible): framework + default theme.
        return (
            <>
                {framework}
                <link rel="stylesheet" href="/themes/default/style.css" />
            </>
        );
    }

    // Use relative path with a STABLE cache buster (theme version/slug). Date.now() here is
    // render-time non-determinism that would mismatch between server and client renders — keep it
    // deterministic so the stylesheet href is identical across SSR and hydration.
    const cssUrl = `/themes/${activeTheme.slug}/style.css?v=${activeTheme.version || activeTheme.slug}`;

    return (
        <>
            {framework}
            <link rel="stylesheet" href={cssUrl} id="wjs-theme-stylesheet" />
        </>
    );
}
