// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client". Links arrive RESOLVED by ChromeRenderer (settings.footer_socials via
// parseChromeSocials); markup and classes mirror today's Footer social icons — including the
// existing .wjs-footer-social hook so current theme CSS keeps applying.
import type { ChromeSocialLink } from "@/lib/chromeData";

export interface ChromeSocialsViewProps {
    // Resolved bindings
    links: ChromeSocialLink[];
}

export default function ChromeSocials({ links }: ChromeSocialsViewProps) {
    if (links.length === 0) return null;
    return (
        <div className="wjs-chrome-socials wjs-footer-social flex gap-4 flex-wrap">
            {links.map((link, idx) => (
                <a
                    key={idx}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-10 h-10 rounded-full bg-[var(--wjs-bg-surface-hover,rgb(31,41,55))] flex items-center justify-center hover:bg-[var(--wjs-color-primary,blue)] text-[var(--wjs-color-text-footer-main,white)] transition-colors tooltip-trigger"
                    title={link.platform}
                    aria-label={link.platform}
                >
                    <i className={link.icon} aria-hidden="true"></i>
                </a>
            ))}
        </div>
    );
}
