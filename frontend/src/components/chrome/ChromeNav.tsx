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

    if (orientation === "vertical") {
        return (
            <nav aria-label={label} className="wjs-chrome-nav wjs-chrome-nav-vertical flex flex-col gap-2">
                {sorted.map((item) => (
                    <Link key={item.id} href={item.url || "#"} className={LINK_CLASS[location]}>
                        {item.title}
                    </Link>
                ))}
            </nav>
        );
    }

    // Horizontal: desktop row + mobile hamburger island (hidden ≥ md by the island itself).
    return (
        <>
            <nav aria-label={label} className="wjs-chrome-nav wjs-chrome-nav-horizontal hidden md:flex items-center gap-8">
                {sorted.map((item) => (
                    <Link key={item.id} href={item.url || "#"} className={LINK_CLASS[location]}>
                        {item.title}
                    </Link>
                ))}
            </nav>
            <ChromeNavMobile items={sorted} />
        </>
    );
}
