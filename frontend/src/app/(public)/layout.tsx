// Server Component: fetches the active theme's structure config (theme.json `layout`) + customizer
// token overrides via getSettings (server-only), then hands them to the synchronous PublicLayoutShell
// which renders the chrome. Keeping the data-fetch here (async server) and the rendering in the shell
// lets the Puck editor preview reuse the same shell without pulling an async component into its client
// tree (Next.js forbids async components inside a client tree). See PublicLayoutShell for the rationale.
import { redirect } from "next/navigation";
import PublicLayoutShell from "@/components/public/PublicLayoutShell";
import ChromeRenderer from "@/components/chrome/ChromeRenderer";
import { buildChromeBindings, resolveEffectiveChrome } from "@/lib/chromeData";
import { getSettings, getPublicAssets, getMenuByLocation, getThemeChrome, checkSetupRequired } from "@/lib/server-api";

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
    try {
        // The settings endpoint JSON-parses option values, so this arrives as an OBJECT (a string
        // only from raw/legacy sources) — JSON.parse(object) would throw and silently disable the
        // theme's layout config. Same both-shapes handling as footer_socials below.
        const rawLayout = settings?.active_theme_layout as unknown;
        const parsed = typeof rawLayout === 'string' ? (rawLayout.trim() ? JSON.parse(rawLayout) : null) : rawLayout;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) layout = parsed as Record<string, unknown>;
    } catch { /* ignore malformed */ }
    // Footer social links live in a JSON-encoded setting; parse here so the footer gets them via props.
    let footerSocials: any[] = [];
    try {
        const raw = (settings as Record<string, unknown> | null)?.footer_socials;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) footerSocials = parsed;
    } catch { /* malformed — render without socials */ }

    const themeSlug = settings?.template || "default";

    // Composable chrome (contract v1), per part: site option → theme chrome file → the shell's
    // layout-v2 variant/default. The theme files ride the same ISR window + 'settings' tag as the
    // rest of the chrome data (switchTheme and the site_chrome_* writers purge that tag), and
    // resolveEffectiveChrome is fail-closed — any invalid/unreadable level falls through, so the
    // shell keeps rendering today's Header/Footer whenever no composition survives.
    const [themeHeaderRaw, themeFooterRaw] = await Promise.all([
        getThemeChrome(themeSlug, "header"),
        getThemeChrome(themeSlug, "footer"),
    ]);
    const headerChrome = resolveEffectiveChrome({ siteRaw: settings?.site_chrome_header, themeRaw: themeHeaderRaw });
    const footerChrome = resolveEffectiveChrome({ siteRaw: settings?.site_chrome_footer, themeRaw: themeFooterRaw });
    const bindings = buildChromeBindings(settings, headerMenu?.items, footerMenu?.items);

    // Composed chrome renders ON THE SERVER inside the same semantic landmarks + container hooks the
    // default chrome uses, so theme CSS keeps applying. Wrapper decision: the header sits in NORMAL
    // FLOW with the solid surface (the classes Header.tsx uses for its non-sticky/scrolled state) —
    // a server-rendered composition has no scroll listener, and fixed+transparent NEEDS the client
    // isScrolled swap to stay readable over content. data-scrolled="false" stays as the stable theme
    // hook; the shell zeroes --wjs-header-offset when a headerSlot is present (same mechanism as
    // layout v2 sticky:false). The ONLY client island underneath is ChromeNavMobile.
    const headerSlot = headerChrome.data ? (
        <header data-scrolled="false" className="wjs-chrome-header relative z-50 transition-all duration-300 bg-[var(--wjs-bg-surface-glass,white)] backdrop-blur-md shadow-sm py-4">
            <div className="wjs-header-container container mx-auto px-4">
                <ChromeRenderer data={headerChrome.data} bindings={bindings} />
            </div>
        </header>
    ) : undefined;
    const footerSlot = footerChrome.data ? (
        <footer className="wjs-chrome-footer bg-[var(--wjs-bg-footer,rgb(17,24,39))] text-[var(--wjs-color-text-footer-main,white)] py-12 mt-auto border-t border-[var(--wjs-border-subtle,transparent)]">
            <div className="wjs-footer-container container mx-auto px-4">
                <ChromeRenderer data={footerChrome.data} bindings={bindings} />
            </div>
        </footer>
    ) : undefined;

    return (
        <PublicLayoutShell
            layout={layout}
            mods={settings?.active_theme_mods}
            themeSlug={themeSlug}
            headerSlot={headerSlot}
            footerSlot={footerSlot}
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
