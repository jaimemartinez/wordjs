"use client";

/**
 * The public chrome around the Verso canvas — the SAME header, footer and announcement band the live
 * site renders, not an approximation.
 *
 * The canvas used to render PublicLayoutShell with no props, i.e. the built-in Header/Footer. A site
 * whose theme (or Header & footer screen) composes its chrome showed a different footer in the editor
 * than on the site — and the built-in one painted its title in the heading colour on the dark band,
 * invisible. Here the composition is resolved exactly as app/(public)/_chrome/PublicLayout resolves it
 * on the server (site option → theme chrome file, fail-closed) and rendered through the shared
 * components/public/ChromeSlots, so the two cannot drift. Until it resolves — or when nothing is
 * composed — the shell keeps today's built-in chrome.
 *
 * Display-only: none of this enters the document being edited.
 */
import { useEffect, useState } from "react";
import PublicLayoutShell from "@/components/public/PublicLayoutShell";
import { buildChromeSlots, type ChromeSlots } from "@/components/public/ChromeSlots";
import { buildChromeBindings, resolveEffectiveChrome } from "@/lib/chromeData";
import { menusApi, settingsApi, themesApi } from "@/lib/api";

type Part = "header" | "footer" | "announcement";

async function themeChromeFile(slug: string, part: Part): Promise<string | null> {
    try {
        const res = await fetch(`/themes/${encodeURIComponent(slug)}/chrome/${part}.json`);
        return res.ok ? await res.text() : null;
    } catch {
        return null;
    }
}

function parseLayout(raw: unknown): Record<string, unknown> {
    try {
        const parsed = typeof raw === "string" ? (raw.trim() ? JSON.parse(raw) : null) : raw;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export default function CanvasPublicShell({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<{ layout: Record<string, unknown>; slots: ChromeSlots } | null>(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            const [settings, themes, headerMenu, footerMenu] = await Promise.all([
                settingsApi.get().catch(() => null) as Promise<Record<string, any> | null>,
                themesApi.list().catch(() => [] as any[]),
                menusApi.getByLocation("header").catch(() => null),
                menusApi.getByLocation("footer").catch(() => null),
            ]);
            if (!settings) return;
            const slug = (settings.template as string) || "default";
            // Only the parts the theme ships: asking for the others is a 404 in the console every time
            // the editor opens.
            const shipped: string[] = (themes as any[]).find((t) => t.slug === slug)?.chrome ?? [];
            const raw = async (part: Part) => (shipped.includes(part) ? themeChromeFile(slug, part) : null);
            const [headerRaw, footerRaw, announcementRaw] = await Promise.all([raw("header"), raw("footer"), raw("announcement")]);
            const layout = parseLayout(settings.active_theme_layout);
            const slots = buildChromeSlots({
                header: resolveEffectiveChrome({ siteRaw: settings.site_chrome_header, themeRaw: headerRaw }).data,
                footer: resolveEffectiveChrome({ siteRaw: settings.site_chrome_footer, themeRaw: footerRaw }).data,
                announcement: resolveEffectiveChrome({ siteRaw: settings.site_chrome_announcement, themeRaw: announcementRaw, position: "announcement" }).data,
                bindings: buildChromeBindings(settings, (headerMenu as any)?.items, (footerMenu as any)?.items),
                layout,
            });
            if (alive) setState({ layout, slots });
        })().catch(() => { /* keep the built-in chrome */ });
        return () => { alive = false; };
    }, []);

    return (
        <PublicLayoutShell stylesheets={false} layout={state?.layout} {...(state?.slots ?? {})}>
            {children}
        </PublicLayoutShell>
    );
}
