// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client". Links arrive RESOLVED by ChromeRenderer (settings.footer_socials via
// parseChromeSocials); markup and classes mirror today's Footer social icons — including the
// existing .wjs-footer-social hook so current theme CSS keeps applying.
import { isSafeChromeHref, type ChromeSocialLink } from "@/lib/chromeData";

export interface ChromeSocialsViewProps {
    // Resolved bindings
    links: ChromeSocialLink[];
}

export default function ChromeSocials({ links }: ChromeSocialsViewProps) {
    // These URLs come from a site setting, not from the validated composition, so this block is the
    // one place a chrome link reaches the DOM unchecked — ChromeButton re-validates its own href.
    // Same allowlist, so a stored 'javascript:' entry can never become a live link here either.
    const safe = links.filter((link) => isSafeChromeHref(link.url));
    if (safe.length === 0) return null;
    return (
        <div className="wjs-chrome-socials wjs-footer-social flex gap-4 flex-wrap">
            {safe.map((link, idx) => (
                <a
                    key={idx}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-10 h-10 rounded-full bg-[var(--wjs-bg-surface-hover,rgb(31,41,55))] flex items-center justify-center hover:bg-[var(--wjs-color-primary,blue)] text-[var(--wjs-color-text-footer-main,white)] transition-colors tooltip-trigger"
                    title={link.platform || undefined}
                    // An entry saved without a platform label would otherwise be an icon-only link with
                    // no accessible name at all — a screen reader announces just "link".
                    aria-label={link.platform || "Perfil social"}
                >
                    <i className={link.icon} aria-hidden="true"></i>
                </a>
            ))}
        </div>
    );
}
