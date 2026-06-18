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

    if (!activeTheme) {
        // Safe fallback URL while loading (prevents FOUC if possible)
        return <link rel="stylesheet" href="/themes/default/style.css" />;
    }

    // Use relative path with a STABLE cache buster (theme version/slug). Date.now() here is
    // render-time non-determinism that would mismatch between server and client renders — keep it
    // deterministic so the stylesheet href is identical across SSR and hydration.
    const cssUrl = `/themes/${activeTheme.slug}/style.css?v=${activeTheme.version || activeTheme.slug}`;

    return (
        <link rel="stylesheet" href={cssUrl} id="wjs-theme-stylesheet" />
    );
}
