// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client" — renders in RSC and inside the editor canvas alike. Props arrive RESOLVED by
// ChromeRenderer (site_logo / blogname from settings); the block never fetches.
import Link from "next/link";

// Static literal maps so Tailwind sees every class (no interpolation).
const IMG_SIZE: Record<"sm" | "md" | "lg", string> = {
    sm: "h-8",
    md: "h-10",
    lg: "h-12",
};
const TEXT_SIZE: Record<"sm" | "md" | "lg", string> = {
    sm: "text-xl",
    md: "text-2xl",
    lg: "text-3xl",
};

export interface ChromeLogoViewProps {
    size?: "sm" | "md" | "lg";
    // Chrome slot this block renders into, forwarded by ChromeRenderer — see the hook below.
    location?: "header" | "footer";
    // Resolved bindings
    logoUrl?: string | null;
    siteTitle?: string;
}

export default function ChromeLogo({ size = "md", location = "header", logoUrl, siteTitle }: ChromeLogoViewProps) {
    // Most catalog themes style the site logo through .wjs-header-logo, the hook Header.tsx emits on
    // this very shape (<a><img|span></a>), so the composed header logo emits it too. NEVER in a footer:
    // those rules carry masthead colors and `order`/`width` !important overrides.
    const hook = location === "header" ? " wjs-header-logo" : "";
    return (
        <Link href="/" className={`wjs-chrome-logo${hook} flex items-center gap-2`}>
            {logoUrl ? (
                <img src={logoUrl} alt={siteTitle || "Logo"} width={160} height={40} className={`${IMG_SIZE[size]} w-auto object-contain`} />
            ) : siteTitle ? (
                <span className={`${TEXT_SIZE[size]} font-bold text-[var(--wjs-color-text-main,gray)]`}>{siteTitle}</span>
            ) : null}
        </Link>
    );
}
