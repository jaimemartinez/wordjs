// Server Component: fetches the active theme's structure config (theme.json `layout`) + customizer
// token overrides via getSettings (server-only), then hands them to the synchronous PublicLayoutShell
// which renders the chrome. Keeping the data-fetch here (async server) and the rendering in the shell
// lets the Puck editor preview reuse the same shell without pulling an async component into its client
// tree (Next.js forbids async components inside a client tree). See PublicLayoutShell for the rationale.
import { redirect } from "next/navigation";
import PublicLayoutShell from "@/components/public/PublicLayoutShell";
import ViewTransitions from "@/components/public/ViewTransitions";
import ChromeRenderer from "@/components/chrome/ChromeRenderer";
import { buildChromeBindings, resolveEffectiveChrome } from "@/lib/chromeData";
import { parseThemeLayout } from "@/lib/themeLayout";
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
    // Derived server-side (memoized theme scan, no extra SQL/fs per request) — see the settings route's
    // DERIVED_PUBLIC_SETTINGS. Rides the same ISR window + 'settings' purge tag as the rest of this data.
    const themeVersion = settings?.active_theme_version || "";

    // Composable chrome (contract v1), per part: site option → theme chrome file → the shell's
    // layout-v2 variant/default. The theme files ride the same ISR window + 'settings' tag as the
    // rest of the chrome data (switchTheme and the site_chrome_* writers purge that tag), and
    // resolveEffectiveChrome is fail-closed — any invalid/unreadable level falls through, so the
    // shell keeps rendering today's Header/Footer whenever no composition survives.
    const [themeHeaderRaw, themeFooterRaw, themeAnnouncementRaw] = await Promise.all([
        getThemeChrome(themeSlug, "header"),
        getThemeChrome(themeSlug, "footer"),
        getThemeChrome(themeSlug, "announcement"),
    ]);
    const headerChrome = resolveEffectiveChrome({ siteRaw: settings?.site_chrome_header, themeRaw: themeHeaderRaw });
    const footerChrome = resolveEffectiveChrome({ siteRaw: settings?.site_chrome_footer, themeRaw: themeFooterRaw });
    // The optional announcement/top bar. Same site-option → theme-file precedence as header/footer, but
    // validated at position "announcement" so the document-scoped ChromeNav is refused here (the header
    // already mounts the one mobile drawer). Absent at every level ⇒ no band emitted at all.
    const announcementChrome = resolveEffectiveChrome({
        siteRaw: settings?.site_chrome_announcement,
        themeRaw: themeAnnouncementRaw,
        position: "announcement",
    });
    const bindings = buildChromeBindings(settings, headerMenu?.items, footerMenu?.items);

    // Composed chrome renders ON THE SERVER inside the same semantic landmarks + container hooks the
    // default chrome uses, so theme CSS keeps applying. It carries .wjs-header too — the selector the
    // theme contract maps `styles.header` to — so a declared header style applies to BOTH chromes.
    //
    // Positioning: `sticky:true` becomes CSS position:sticky, not the client Header's fixed. Sticky
    // needs no scroll listener (it is the whole point of the property) AND stays in flow, so the
    // shell's --wjs-header-offset:0 for a composed header remains correct — a fixed header would
    // have overlapped the first section. The surface stays solid at all times: `transparent:true`
    // is deliberately NOT honored here, because transparent-over-content only stays readable via the
    // client isScrolled swap this server composition has no way to run. data-scrolled="false" stays
    // as the stable theme hook. The ONLY client island underneath is ChromeNavMobile.
    // `layout` is the RAW option here — the Shell is what normalizes it. Run the same normalizer
    // rather than re-deriving the default (`sticky !== false`), so the two can't drift apart.
    const headerPos = parseThemeLayout(layout).header.sticky ? "sticky top-0" : "relative";
    const headerSlot = headerChrome.data ? (
        <header data-scrolled="false" className={`wjs-header wjs-chrome-header ${headerPos} z-50 transition-all duration-300 bg-[var(--wjs-bg-surface-glass,white)] backdrop-blur-md shadow-sm py-4`}>
            <div className="wjs-header-container container mx-auto px-4">
                <ChromeRenderer data={headerChrome.data} bindings={bindings} />
            </div>
        </header>
    ) : undefined;
    // Full-bleed band ABOVE the header: rendered outside any container so a theme can paint edge-to-edge
    // (the hardcoded container wrapper on header/footer is exactly what made that impossible before). Its
    // blocks are the presentational ones (ChromeText/ChromeButton/ChromeRow/…); ChromeNav is barred by
    // the validator. Nothing renders when no composition survives resolution.
    const announcementSlot = announcementChrome.data ? (
        <aside className="wjs-chrome-announcement w-full bg-[var(--wjs-bg-announcement,var(--wjs-color-primary,#1f2937))] text-[var(--wjs-color-on-primary,#ffffff)] text-sm">
            <div className="wjs-announcement-container container mx-auto px-4 py-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-center">
                <ChromeRenderer data={announcementChrome.data} bindings={bindings} location="header" />
            </div>
        </aside>
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
            themeVersion={themeVersion}
            announcementSlot={announcementSlot}
            headerSlot={headerSlot}
            footerSlot={footerSlot}
            settings={settings || undefined}
            headerMenu={headerMenu?.items}
            footerMenu={footerMenu?.items}
            footerSocials={footerSocials}
        >
            {/* RSS auto-discovery — React hoists this to <head> on every public page */}
            <link rel="alternate" type="application/rss+xml" title={settings?.blogname || "RSS"} href="/feed" />
            {/* Transiciones entre páginas (C1): dos reglas de CSS, cero JS. Van en el LAYOUT porque
                la variante entre documentos necesita la regla en el documento que sale y en el que
                entra; aquí, toda página pública la lleva. Apagado por defecto. */}
            <ViewTransitions setting={settings?.wjs_view_transitions} />
            {/* Plugin-enqueued styles + head scripts (validated + served from /plugins/<slug>/; the plugin
                never controls markup — only these attributes). React hoists <link>/<script src> to <head>. */}
            {assets.styles.map((s) => <link key={s.handle} rel="stylesheet" href={s.src} media={s.media || undefined} />)}
            {assets.scripts.filter((s) => !s.inFooter).map((s) => <script key={s.handle} src={s.src} async={s.strategy === "async"} defer={s.strategy === "defer"} />)}
            {children}
            {assets.scripts.filter((s) => s.inFooter).map((s) => <script key={s.handle} src={s.src} async={s.strategy === "async"} defer={s.strategy === "defer"} />)}
        </PublicLayoutShell>
    );
}
