// Server Component: fetches the active theme's structure config (theme.json `layout`) + customizer
// token overrides via getSettings (server-only), then hands them to the synchronous PublicLayoutShell
// which renders the chrome. Keeping the data-fetch here (async server) and the rendering in the shell
// lets the Puck editor preview reuse the same shell without pulling an async component into its client
// tree (Next.js forbids async components inside a client tree). See PublicLayoutShell for the rationale.
import PublicLayoutShell from "@/components/public/PublicLayoutShell";
import { getSettings } from "@/lib/server-api";

export default async function PublicLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const settings = (await getSettings().catch(() => null)) as Record<string, string> | null;
    let layout: Record<string, unknown> = {};
    try { if (settings?.active_theme_layout) layout = JSON.parse(settings.active_theme_layout) || {}; } catch { /* ignore malformed */ }

    return (
        <PublicLayoutShell layout={layout} mods={settings?.active_theme_mods}>
            {children}
        </PublicLayoutShell>
    );
}
