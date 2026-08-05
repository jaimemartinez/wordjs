// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client". Props arrive RESOLVED by ChromeRenderer (blogname / blogdescription from settings).
// Colors inherit via currentColor fallbacks so the block reads correctly on both the light header
// and the dark footer without hardcoding anything new.
import Link from "next/link";

export interface ChromeSiteTitleViewProps {
    showTagline?: boolean;
    // Resolved bindings
    siteTitle?: string;
    tagline?: string;
}

export default function ChromeSiteTitle({ showTagline = false, siteTitle, tagline }: ChromeSiteTitleViewProps) {
    if (!siteTitle && !(showTagline && tagline)) return null;
    return (
        <div className="wjs-chrome-site-title flex flex-col">
            {siteTitle ? (
                <Link href="/" className="text-2xl font-bold text-[var(--wjs-color-heading,currentColor)]">
                    {siteTitle}
                </Link>
            ) : null}
            {showTagline && tagline ? (
                <span className="text-sm text-[var(--wjs-color-text-muted,currentColor)] opacity-80">{tagline}</span>
            ) : null}
        </div>
    );
}
