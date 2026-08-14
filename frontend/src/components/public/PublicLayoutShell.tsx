// Synchronous, presentation-only shell for the public site chrome. It composes the client chrome
// (ThemeLoader, ThemeTokenOverlay, Header, Footer, SidebarLayout, ActivePluginsProvider) around the
// page `children` and applies the active theme's structure config (layout v2: header/footer variants,
// sidebar, containerWidth) + customizer overlay, all passed in as plain props.
//
// WHY a separate shell: the real route layout (app/(public)/layout.tsx) is an ASYNC server component
// (it fetches settings via getSettings). The Puck editor preview (PuckEditor.tsx, a "use client"
// component) also needs to render the public chrome for WYSIWYG — but a client tree cannot render an
// async component. So data-fetching lives in the async server layout, and this sync shell does the
// rendering, usable from BOTH the server layout and the client editor (no "use client" here → it is a
// shared component that adapts to whichever tree imports it). With no props it renders today's default
// look, so the editor preview is unchanged.
import Header from "@/components/public/Header";
import Footer from "@/components/public/Footer";
import ThemeLoader from "@/components/public/ThemeLoader";
import ThemeTokenOverlay from "@/components/public/ThemeTokenOverlay";
import SidebarLayout from "@/components/public/SidebarLayout";
import { ActivePluginsProvider } from "@/lib/useActivePlugins";
import { parseThemeLayout } from "@/lib/themeLayout";

export default function PublicLayoutShell({
    children,
    layout = {},
    mods,
    themeSlug,
    themeVersion,
    settings,
    headerMenu,
    footerMenu,
    footerSocials,
    headerSlot,
    footerSlot,
}: {
    children: React.ReactNode;
    layout?: Record<string, unknown>;
    mods?: string | Record<string, unknown> | null;
    // Active-theme slug resolved by the async server layout, so the theme stylesheet is server-rendered
    // (no FOUC). Omitted by the editor preview, which resolves it client-side + injects its own iframe CSS.
    themeSlug?: string | null;
    // theme.json version of that theme (derived `active_theme_version` setting) — it versions the
    // stylesheet URL so an in-place theme edit busts the browser copy. Server-provided so SSR and
    // hydration agree on the href.
    themeVersion?: string | null;
    // SSR-resolved chrome data (live site) forwarded to Header/Footer so they render nav/logo in the
    // initial HTML and skip their per-visitor client fetch. All omitted by the editor preview → the
    // chrome falls back to fetching client-side (unchanged).
    settings?: Record<string, any>;
    headerMenu?: any[];
    footerMenu?: any[];
    footerSocials?: any[];
    // Composable chrome (contract v1): when the async layout resolved a composition (site option or
    // theme chrome file) it passes the ALREADY-RENDERED <header>/<footer> here and it replaces the
    // built-in Header/Footer for that part. Absent ⇒ today's layout-v2 chrome, byte-for-byte.
    headerSlot?: React.ReactNode;
    footerSlot?: React.ReactNode;
}) {
    // Normalized structure config (defaults ≡ today's chrome; invalid values fall back silently —
    // the theme doctor reports them in its own lane). All from props → deterministic for hydration.
    const { header, footer, sidebar, containerWidth } = parseThemeLayout(layout);
    // pt-24 stays on the class list for parity; this inline padding wins over it, so the
    // offset under the fixed header is themable via --wjs-header-offset (default = pt-24).
    const mainStyle = {
        paddingTop: "var(--wjs-header-offset, 6rem)",
        ...(containerWidth ? { maxWidth: containerWidth } : undefined),
    };
    // A fixed header needs the main content pushed down by its own height, and the variants are not
    // the same height: `centered` stacks the logo ABOVE the nav, so the 6rem sized for the classic
    // single row let it overlap the first section. Themes still override --wjs-header-offset.
    // Measured in the browser, not guessed: at the top state classic renders 79px and minimal 92px —
    // minimal is TALLER because its hamburger (44px) is always visible where classic shows a 40px
    // logo. The old 5rem/80px for minimal therefore ran 12px UNDER the header on every minimal theme.
    const STICKY_OFFSET: Record<string, string> = { classic: "6rem", centered: "9.5rem", minimal: "6rem" };
    const shellStyle = {
        backgroundColor: 'var(--wjs-bg-canvas, #f8fafc)',
        // sticky:false — or a composed headerSlot, which uses position:sticky and therefore keeps its
        // own space in flow — → the main no longer needs the fixed-header offset; declaring the var
        // here (ancestor) wins over any theme :root value for descendants.
        ...(header.sticky && !headerSlot
            ? { "--wjs-header-offset": STICKY_OFFSET[header.variant] || STICKY_OFFSET.classic }
            : { "--wjs-header-offset": "0rem" }),
    } as React.CSSProperties;

    return (
        <ActivePluginsProvider>
            <div className="min-h-screen flex flex-col" style={shellStyle}>
                <a
                    href="#main-content"
                    className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:start-4 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-[var(--wjs-color-primary,#2563eb)] focus:text-[var(--wjs-color-on-primary,#ffffff)] focus:shadow-lg"
                >
                    Skip to content
                </a>
                <ThemeLoader initialSlug={themeSlug} initialThemeVersion={themeVersion} />
                <ThemeTokenOverlay mods={mods} />
                {headerSlot ?? <Header initialMenu={headerMenu} initialSettings={settings} variant={header.variant} sticky={header.sticky} transparent={header.transparent} />}
                <main id="main-content" className="flex-1 pt-24 pb-10 container mx-auto px-4" style={mainStyle}>
                    <SidebarLayout enabled={sidebar.enabled} position={sidebar.position}>{children}</SidebarLayout>
                </main>
                {footerSlot ?? <Footer previewSettings={settings} previewMenu={footerMenu} previewSocials={footerSocials} variant={footer.variant} columns={footer.columns} />}
            </div>
        </ActivePluginsProvider>
    );
}
