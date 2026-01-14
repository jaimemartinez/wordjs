"use client";

import { useEffect, useState } from "react";
import { themesApi, Theme } from "@/lib/api";

export default function ThemeLoader() {
    const [activeTheme, setActiveTheme] = useState<Theme | null>(null);

    useEffect(() => {
        const loadTheme = async () => {
            try {
                const themes = await themesApi.list();
                const active = themes.find(t => t.active);
                if (active) {
                    setActiveTheme(active);
                }
            } catch (error) {
                console.error("Failed to load active theme:", error);
            }
        };

        loadTheme();
    }, []);

    if (!activeTheme || activeTheme.slug === 'default') {
        return null;
    }

    // Use relative path - robust for both main window and iframe (via <base> tag)
    const cssUrl = `/themes/${activeTheme.slug}/style.css`;

    return (
        <link rel="stylesheet" href={cssUrl} />
    );
}
