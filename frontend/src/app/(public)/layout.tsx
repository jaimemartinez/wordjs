// Server Component: no client hooks of its own. It composes the client chrome (ThemeLoader, Header,
// Footer, ActivePluginsProvider) around the server-rendered page `children`, so public content
// streams as real HTML while the interactive shell hydrates on top.
import Header from "@/components/public/Header";
import Footer from "@/components/public/Footer";
import ThemeLoader from "@/components/public/ThemeLoader";
import ThemeTokenOverlay from "@/components/public/ThemeTokenOverlay";
import SidebarLayout from "@/components/public/SidebarLayout";
import { ActivePluginsProvider } from "@/lib/useActivePlugins";
import { getSettings } from "@/lib/server-api";

export default async function PublicLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    // Active theme structure config (theme.json `layout`) + customizer token overrides, both SSR'd.
    const settings = (await getSettings().catch(() => null)) as Record<string, string> | null;
    let layout: Record<string, unknown> = {};
    try { if (settings?.active_theme_layout) layout = JSON.parse(settings.active_theme_layout) || {}; } catch { /* ignore malformed */ }
    const containerWidth = typeof layout.containerWidth === "string" ? layout.containerWidth : null;
    const mainStyle = containerWidth ? { maxWidth: containerWidth } : undefined;
    const sidebar = layout.sidebar === true || layout.sidebar === "true";

    return (
        <ActivePluginsProvider>
            <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--wjs-bg-canvas, #f8fafc)' }}>
                <ThemeLoader />
                <ThemeTokenOverlay mods={settings?.active_theme_mods} />
                <Header />
                <main className="flex-1 pt-24 pb-10 container mx-auto px-4" style={mainStyle}>
                    <SidebarLayout enabled={sidebar}>{children}</SidebarLayout>
                </main>
                <Footer />
            </div>
        </ActivePluginsProvider>
    );
}
