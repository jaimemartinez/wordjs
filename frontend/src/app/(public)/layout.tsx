// Server Component: fetches the active theme's structure config (theme.json `layout`) + customizer
// token overrides via getSettings (server-only), then hands them to the synchronous PublicLayoutShell
// which renders the chrome. Keeping the data-fetch here (async server) and the rendering in the shell
// lets the Puck editor preview reuse the same shell without pulling an async component into its client
// tree (Next.js forbids async components inside a client tree). See PublicLayoutShell for the rationale.
import { redirect } from "next/navigation";
import PublicLayoutShell from "@/components/public/PublicLayoutShell";
import { getSettings, getPublicAssets, checkSetupRequired } from "@/lib/server-api";

export default async function PublicLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    // Fresh install → send the visitor straight to the setup wizard instead of an empty broken
    // page ("Service Temporarily Unavailable"). /install lives outside this (public) group, so
    // this cannot loop. Backend-down and installed states return false and render as before.
    if (await checkSetupRequired()) redirect("/install");

    const settings = (await getSettings().catch(() => null)) as Record<string, string> | null;
    const assets = await getPublicAssets().catch(() => ({ scripts: [], styles: [] }));
    let layout: Record<string, unknown> = {};
    try { if (settings?.active_theme_layout) layout = JSON.parse(settings.active_theme_layout) || {}; } catch { /* ignore malformed */ }

    return (
        <PublicLayoutShell layout={layout} mods={settings?.active_theme_mods} themeSlug={settings?.template || "default"}>
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
