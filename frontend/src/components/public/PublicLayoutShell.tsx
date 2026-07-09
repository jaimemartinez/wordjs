// Synchronous, presentation-only shell for the public site chrome. It composes the client chrome
// (ThemeLoader, ThemeTokenOverlay, Header, Footer, SidebarLayout, ActivePluginsProvider) around the
// page `children` and applies the active theme's structure config (containerWidth/sidebar) + customizer
// overlay, all passed in as plain props.
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

export default function PublicLayoutShell({
    children,
    layout = {},
    mods,
    themeSlug,
}: {
    children: React.ReactNode;
    layout?: Record<string, unknown>;
    mods?: string | Record<string, unknown> | null;
    // Active-theme slug resolved by the async server layout, so the theme stylesheet is server-rendered
    // (no FOUC). Omitted by the editor preview, which resolves it client-side + injects its own iframe CSS.
    themeSlug?: string | null;
}) {
    const containerWidth = typeof layout.containerWidth === "string" ? layout.containerWidth : null;
    const mainStyle = containerWidth ? { maxWidth: containerWidth } : undefined;
    const sidebar = layout.sidebar === true || layout.sidebar === "true";

    return (
        <ActivePluginsProvider>
            <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--wjs-bg-canvas, #f8fafc)' }}>
                <ThemeLoader initialSlug={themeSlug} />
                <ThemeTokenOverlay mods={mods} />
                <Header />
                <main className="flex-1 pt-24 pb-10 container mx-auto px-4" style={mainStyle}>
                    <SidebarLayout enabled={sidebar}>{children}</SidebarLayout>
                </main>
                <Footer />
            </div>
        </ActivePluginsProvider>
    );
}
