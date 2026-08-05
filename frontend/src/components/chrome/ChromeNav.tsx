// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client" — the mobile hamburger lives in the ChromeNavMobile client island it mounts next to
// the desktop nav. Items arrive RESOLVED by ChromeRenderer (menu by location); the block never
// fetches. Link colors keep today's header/footer token fallbacks per location.
import Link from "next/link";
import type { ChromeMenuItem } from "@/lib/chromeData";
import ChromeNavMobile from "./ChromeNavMobile";

// Static literal maps so Tailwind sees every class (no interpolation).
const LINK_CLASS: Record<"header" | "footer", string> = {
    header: "text-[var(--wjs-color-text-main,gray)] hover:text-[var(--wjs-color-primary,blue)] font-medium transition-colors",
    footer: "text-[var(--wjs-color-text-footer-dim,gray)] hover:text-[var(--wjs-color-primary,white)] transition-colors",
};

export interface ChromeNavViewProps {
    location: "header" | "footer";
    orientation: "horizontal" | "vertical";
    // Resolved bindings
    items: ChromeMenuItem[];
}

export default function ChromeNav({ location, orientation, items }: ChromeNavViewProps) {
    const sorted = [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const label = location === "header" ? "Primary" : "Footer";
    // Most catalog themes style the header nav through .wjs-header-nav — the hook Header.tsx emits —
    // so a composed header nav emits it TOO, or activating a composition un-styles those themes. A
    // footer nav must not pick it up: those rules (order/width/justify !important) target the masthead.
    const hook = location === "header" ? " wjs-header-nav" : "";
    const links = sorted.map((item) => (
        <Link key={item.id} href={item.url || "#"} className={LINK_CLASS[location]}>
            {item.title}
        </Link>
    ));

    if (orientation === "vertical") {
        return (
            <nav aria-label={label} className={`wjs-chrome-nav wjs-chrome-nav-vertical${hook} flex flex-col gap-2`}>
                {links}
            </nav>
        );
    }

    // Horizontal in the FOOTER: no hamburger — the drawer is a header affordance (Footer.tsx has none,
    // and a portaled full-height drawer opening from the page bottom is not what a footer nav means).
    // The row therefore has to stay visible at every width, so it wraps instead of hiding below md.
    if (location === "footer") {
        return (
            <nav aria-label={label} className="wjs-chrome-nav wjs-chrome-nav-horizontal flex flex-wrap items-center gap-8">
                {links}
            </nav>
        );
    }

    // Horizontal in the HEADER: desktop row + mobile hamburger island (hidden ≥ md by the island itself).
    return (
        <>
            <nav aria-label={label} className={`wjs-chrome-nav wjs-chrome-nav-horizontal${hook} hidden md:flex items-center gap-8`}>
                {links}
            </nav>
            <ChromeNavMobile items={sorted} />
        </>
    );
}
