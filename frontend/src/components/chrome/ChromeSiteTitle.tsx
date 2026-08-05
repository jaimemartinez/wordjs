// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client". Props arrive RESOLVED by ChromeRenderer (blogname / blogdescription from settings).
// Colors inherit via currentColor fallbacks so the block reads correctly on both the light header
// and the dark footer without hardcoding anything new.
import Link from "next/link";

export interface ChromeSiteTitleViewProps {
    showTagline?: boolean;
    // Chrome slot this block renders into, forwarded by ChromeRenderer — see the hook below.
    location?: "header" | "footer";
    // Resolved bindings
    siteTitle?: string;
    tagline?: string;
}

export default function ChromeSiteTitle({ showTagline = false, location = "header", siteTitle, tagline }: ChromeSiteTitleViewProps) {
    if (!siteTitle && !(showTagline && tagline)) return null;
    // .wjs-header-logo (the themes' brand hook) goes on the TITLE LINK, not the wrapper: Header.tsx
    // emits it on an <a> whose only child is the title span, and themes write `.wjs-header-logo span`.
    // On the wrapper that descendant rule would style the TAGLINE instead. Header slot only — those
    // rules are masthead-specific. See ChromeLogo for the same contract.
    // In a footer the brand still needs A hook, or it falls through to the bare `a` rule and renders
    // as an underlined link in the link colour on the footer band. wjs-footer-logo is the footer's
    // own, coloured from the footer tokens — never the masthead ones.
    const hook = location === "header" ? "wjs-header-logo " : "wjs-footer-logo ";
    return (
        <div className="wjs-chrome-site-title flex flex-col">
            {siteTitle ? (
                <Link href="/" className={`${hook}text-2xl font-bold text-[var(--wjs-color-heading,currentColor)]`}>
                    {siteTitle}
                </Link>
            ) : null}
            {showTagline && tagline ? (
                <span className="text-sm text-[var(--wjs-color-text-muted,currentColor)] opacity-80">{tagline}</span>
            ) : null}
        </div>
    );
}
