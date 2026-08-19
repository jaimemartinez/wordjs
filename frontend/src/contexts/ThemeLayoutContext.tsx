"use client";

import React from "react";
import { themesApi, settingsApi } from "@/lib/api";
import { subscribeToThemeActivation } from "@/lib/themeActivationEvents";

export type ThemeComponentRecipe = Record<string, unknown>;

export interface ThemeLayout {
    componentRecipes?: Record<string, ThemeComponentRecipe>;
    [key: string]: unknown;
}

export interface ActiveThemeState {
    slug: string;
    layout: ThemeLayout;
    mods: ThemeMods;
}

export type ThemeMods = string | Record<string, unknown> | null;

interface ThemeCandidate {
    slug?: unknown;
    active?: unknown;
    layout?: unknown;
    mods?: unknown;
}

const EMPTY_LAYOUT: ThemeLayout = Object.freeze({});
const EMPTY_RECIPE: ThemeComponentRecipe = Object.freeze({});
const DEFAULT_THEME_STATE: ActiveThemeState = Object.freeze({
    slug: "default",
    layout: EMPTY_LAYOUT,
    mods: null,
});

const ThemeLayoutContext = React.createContext<ActiveThemeState>(DEFAULT_THEME_STATE);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);

const normalizeSlug = (slug: unknown): string =>
    typeof slug === "string" && slug.trim() ? slug : "default";

const normalizeMods = (mods: unknown): ThemeMods => {
    if (typeof mods === "string") return mods.trim() ? mods : null;
    return isRecord(mods) ? mods : null;
};

/**
 * Build one immutable-by-convention snapshot so a theme slug can never be
 * committed independently from the component recipes that belong to it.
 */
/**
 * Settings values arrive as strings over the wire, but a separately deployed backend may already send
 * the parsed object. Both shapes, and neither may throw — a malformed value must degrade to null, not
 * take the provider down. (Parsing an already-parsed object was a real bug on this path once.)
 */
function safeJson(value: unknown): unknown {
    if (value == null) return null;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return null; }
}

export function createActiveThemeState(slug: unknown, layout: unknown, mods: unknown = null): ActiveThemeState {
    return {
        slug: normalizeSlug(slug),
        layout: isRecord(layout) ? layout as ThemeLayout : EMPTY_LAYOUT,
        mods: normalizeMods(mods),
    };
}

/** Resolve the backend theme list to one complete active-theme snapshot. */
export function resolveActiveThemeState(themes: readonly ThemeCandidate[]): ActiveThemeState | null {
    const active = themes.find((theme) => theme.active === true)
        || themes.find((theme) => theme.slug === "default");
    return active ? createActiveThemeState(active.slug, active.layout, active.mods) : null;
}

/**
 * Makes the complete active theme snapshot available to all public chrome and
 * client-rendered Puck blocks.
 *
 * The public route supplies `{ slug, layout }` from SSR for the first paint.
 * Mount/focus reconciliation replaces that pair in one state update. In
 * particular, switching to a legacy theme with no layout clears recipes from
 * the previous theme instead of retaining them beside the new stylesheet.
 */
export function ThemeLayoutProvider({
    children,
    initialTheme,
}: {
    children: React.ReactNode;
    initialTheme?: {
        slug?: string | null;
        layout?: Record<string, unknown> | null;
        mods?: ThemeMods;
    };
}) {
    const [theme, setTheme] = React.useState<ActiveThemeState>(() =>
        createActiveThemeState(initialTheme?.slug, initialTheme?.layout, initialTheme?.mods)
    );

    React.useEffect(() => {
        let mounted = true;
        let latestRequest = 0;

        const refresh = async () => {
            const request = ++latestRequest;
            try {
                let nextTheme: ActiveThemeState | null = null;
                try {
                    // SETTINGS, not a themes lookup. The active theme's slug, layout and mods are all
                    // in the settings payload already (the public layout reads the same three keys), so
                    // this is one small response instead of a scan of every installed theme.
                    //
                    // The previous version called `themesApi.active()`, and there is no such endpoint —
                    // the call threw on every refresh and the catch below did all the work. It looked
                    // like a fast path and was never once taken.
                    const settings = await settingsApi.get();
                    const layout = safeJson(settings?.active_theme_layout);
                    const mods = safeJson(settings?.active_theme_mods);
                    if (settings?.template) nextTheme = createActiveThemeState(settings.template, layout, mods);
                } catch {
                    // Leave nextTheme null and fall through to the theme list.
                }
                if (!nextTheme) {
                    const themes = await themesApi.list();
                    nextTheme = resolveActiveThemeState(themes as ThemeCandidate[]);
                }
                if (mounted && request === latestRequest && nextTheme) {
                    setTheme(nextTheme);
                }
            } catch {
                // Preserve the last complete snapshot when the backend is unavailable.
            }
        };

        void refresh();
        const onFocus = () => { void refresh(); };
        const onPageShow = () => { void refresh(); };
        const onVisibilityChange = () => {
            if (document.visibilityState === "visible") void refresh();
        };
        const unsubscribeActivation = subscribeToThemeActivation(() => { void refresh(); });
        window.addEventListener("focus", onFocus);
        window.addEventListener("pageshow", onPageShow);
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
            mounted = false;
            unsubscribeActivation();
            window.removeEventListener("focus", onFocus);
            window.removeEventListener("pageshow", onPageShow);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, []);

    return (
        <ThemeLayoutContext.Provider value={theme}>
            {children}
        </ThemeLayoutContext.Provider>
    );
}

export function useActiveTheme(): ActiveThemeState {
    return React.useContext(ThemeLayoutContext);
}

export function useThemeLayout(): ThemeLayout {
    return useActiveTheme().layout;
}

/** Resolve recipe keys case-insensitively so older PascalCase manifests remain usable. */
export function useThemeComponentRecipe<T extends object = ThemeComponentRecipe>(name: string): Partial<T> {
    const layout = useThemeLayout();
    const recipes = isRecord(layout.componentRecipes) ? layout.componentRecipes : null;
    if (!recipes) return EMPTY_RECIPE as Partial<T>;

    const normalizedName = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const match = Object.entries(recipes).find(([key]) =>
        key.replace(/[^a-z0-9]/gi, "").toLowerCase() === normalizedName
    )?.[1];

    return (isRecord(match) ? match : EMPTY_RECIPE) as Partial<T>;
}
