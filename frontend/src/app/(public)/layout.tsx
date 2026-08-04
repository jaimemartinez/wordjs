// Server Component: fetches the active theme's structure config (theme.json `layout`) + customizer
// token overrides via getSettings (server-only), then hands them to the synchronous PublicLayoutShell
// which renders the chrome. Keeping the data-fetch here (async server) and the rendering in the shell
// lets the Puck editor preview reuse the same shell without pulling an async component into its client
// tree (Next.js forbids async components inside a client tree). See PublicLayoutShell for the rationale.
import { redirect } from "next/navigation";
import PublicLayoutShell from "@/components/public/PublicLayoutShell";
import { getSettings, getPublicAssets, getMenuByLocation, checkSetupRequired } from "@/lib/server-api";

export default async function PublicLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    // Fetch chrome data on the SERVER, in parallel, all cached (ISR) — so the Header/Footer render their
    // nav/logo in the initial HTML and each visitor's browser no longer re-fetches settings+menus on
    // hydration (a per-visit double-fetch that also delayed the chrome paint).
    const [settings, assets, headerMenu, footerMenu] = await Promise.all([
        getSettings().catch(() => null) as Promise<Record<string, string> | null>,
        getPublicAssets().catch(() => ({ scripts: [], styles: [] })),
        getMenuByLocation('header').catch(() => null),
        getMenuByLocation('footer').catch(() => null),
    ]);

    // Fresh install → send the visitor straight to the setup wizard instead of an empty broken
    // page. Probed ONLY when settings came back empty: settings present ⟺ installed (the same
    // endpoint answers 503 setup_required pre-install), and the probe's no-store fetch on every
    // render was what forced the ENTIRE public tree dynamic (no Full-Route Cache). Skipped during
    // the production build (no backend there): the static shell ISR-refreshes on first traffic.
    // /install lives outside this (public) group, so this cannot loop.
    if (!settings && process.env.NEXT_PHASE !== 'phase-production-build' && await checkSetupRequired()) redirect("/install");
    let layout: Record<string, unknown> = {};
    try { if (settings?.active_theme_layout) layout = JSON.parse(settings.active_theme_layout) || {}; } catch { /* ignore malformed */ }
    // Footer social links live in a JSON-encoded setting; parse here so the footer gets them via props.
    let footerSocials: any[] = [];
    try {
        const raw = (settings as Record<string, unknown> | null)?.footer_socials;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) footerSocials = parsed;
    } catch { /* malformed — render without socials */ }

    return (
        <PublicLayoutShell
            layout={layout}
            mods={settings?.active_theme_mods}
            themeSlug={settings?.template || "default"}
            settings={settings || undefined}
            headerMenu={headerMenu?.items}
            footerMenu={footerMenu?.items}
            footerSocials={footerSocials}
        >
            {/* RSS auto-discovery — React hoists this to <head> on every public page */}
            <link rel="alternate" type="application/rss+xml" title={settings?.blogname || "RSS"} href="/feed" />
            {/* Plugin-enqueued styles + head scripts (validated + served from /plugins/<slug>/; the plugin
                never controls markup — only these attributes). React hoists <link>/<script src> to <head>. */}
            {assets.styles.map((s) => <link key={s.handle} rel="stylesheet" href={s.src} media={s.media || undefined} />)}
            {assets.scripts.filter((s) => !s.inFooter).map((s) => <script key={s.handle} src={s.src} async={s.strategy === "async"} defer={s.strategy === "defer"} />)}
            {children}
            {assets.scripts.filter((s) => s.inFooter).map((s) => <script key={s.handle} src={s.src} async={s.strategy === "async"} defer={s.strategy === "defer"} />)}
        </PublicLayoutShell>
    );
}
