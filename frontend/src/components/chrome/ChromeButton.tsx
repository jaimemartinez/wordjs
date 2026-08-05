// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client". SECURITY: parseChromeData already rejects unsafe hrefs, but the block re-validates
// at render (defense in depth) — an invalid href degrades to an inert <span>, never a javascript:
// link. Relative paths use next/link; absolute http(s) URLs use a plain <a>.
import Link from "next/link";
import { isSafeChromeHref } from "@/lib/chromeData";

// Static literal map so Tailwind sees every class (no interpolation).
const VARIANT_CLASS: Record<"primary" | "ghost", string> = {
    primary: "bg-[var(--wjs-color-primary,#2F6D86)] text-[var(--wjs-color-on-primary,#ffffff)] hover:bg-[var(--wjs-color-primary-dark,#266073)]",
    ghost: "bg-transparent text-[var(--wjs-color-primary,#2F6D86)] border border-[var(--wjs-color-primary,#2F6D86)] hover:bg-[var(--wjs-color-primary,#2F6D86)] hover:text-[var(--wjs-color-on-primary,#ffffff)]",
};

export interface ChromeButtonViewProps {
    label: string;
    href: string;
    variant?: "primary" | "ghost";
}

export default function ChromeButton({ label, href, variant = "primary" }: ChromeButtonViewProps) {
    const className = `wjs-chrome-button inline-flex items-center justify-center px-5 py-2 rounded-full font-medium text-sm transition-colors ${VARIANT_CLASS[variant]}`;
    if (!isSafeChromeHref(href)) {
        return <span className={className}>{label}</span>;
    }
    if (href.startsWith("/")) {
        return (
            <Link href={href} className={className}>
                {label}
            </Link>
        );
    }
    return (
        <a href={href} className={className}>
            {label}
        </a>
    );
}
