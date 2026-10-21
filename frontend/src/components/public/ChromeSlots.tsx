// The site chrome's composed slots (contract v1): the <header>, <footer> and announcement band that
// wrap a resolved composition, exactly as the public site renders them. Pure — no fetching, no
// "use client" — so the async public layout (server) and the Verso canvas (client) build the SAME
// markup from the same data. The canvas used to show the built-in Footer instead: a different
// footer from the real one, with its title painted in the heading colour on the dark band.
import ChromeRenderer from "@/components/chrome/ChromeRenderer";
import ChromeHeaderScroll from "@/components/chrome/ChromeHeaderScroll";
import { chromeRootOptions, type ChromeBindings, type ChromeData } from "@/lib/chromeData";
import { parseThemeLayout } from "@/lib/themeLayout";

export interface ChromeSlots {
    headerSlot?: React.ReactNode;
    footerSlot?: React.ReactNode;
    announcementSlot?: React.ReactNode;
}

/**
 * Composed chrome renders inside the same semantic landmarks + container hooks the default chrome
 * uses, so theme CSS keeps applying. It carries .wjs-header too — the selector the theme contract
 * maps `styles.header` to — so a declared header style applies to BOTH chromes.
 *
 * Positioning — the composition's root props decide, the theme's layout v2 only fills the gap:
 *  • sticky (root.sticky, else the theme's `header.sticky`) is CSS position:sticky, not the client
 *    Header's fixed: it needs no scroll listener and stays in flow, so the shell's
 *    --wjs-header-offset:0 for a composed header remains correct.
 *  • transparent (root.transparent) lays the header OVER the top of the page — absolute, or fixed
 *    when also sticky — with no surface while the page sits at the top, so a hero shows through it.
 *    The ChromeHeaderScroll island flips data-scrolled once the page moves, and wordjs-ui.css gives
 *    the header its solid surface back from then on (readable over whatever scrolls beneath). A
 *    page that does NOT open with a hero keeps the room the header needs (wordjs-ui.css, :has()).
 *  • width "full" drops the centred container: the rows span the viewport edge to edge.
 * `layout` is the RAW option — the Shell is what normalizes it. Run the same normalizer rather than
 * re-deriving the default (`sticky !== false`), so the two can't drift apart.
 */
export function buildChromeSlots({
    header,
    footer,
    announcement,
    bindings,
    layout,
}: {
    header: ChromeData | null | undefined;
    footer: ChromeData | null | undefined;
    announcement: ChromeData | null | undefined;
    bindings: ChromeBindings;
    layout: Record<string, unknown>;
}): ChromeSlots {
    const containerClass = (root: { width: "container" | "full" }) => (root.width === "full" ? "w-full px-4 md:px-8" : "container mx-auto px-4");

    const headerRoot = chromeRootOptions(header);
    const headerSticky = headerRoot.sticky ?? parseThemeLayout(layout).header.sticky;
    const headerPos = headerRoot.transparent
        ? (headerSticky ? "fixed top-0 inset-x-0" : "absolute top-0 inset-x-0")
        : (headerSticky ? "sticky top-0" : "relative");
    const headerSlot = header ? (
        <header
            data-scrolled="false"
            data-transparent={headerRoot.transparent ? "true" : undefined}
            data-overlay-text={headerRoot.transparent ? headerRoot.overlayText : undefined}
            data-sticky={headerSticky ? "true" : "false"}
            className={`wjs-header wjs-chrome-header ${headerPos} z-50 transition-all duration-300 bg-[var(--wjs-bg-surface-glass,white)] backdrop-blur-md shadow-sm py-4`}
        >
            <div className={`wjs-header-container ${containerClass(headerRoot)}`}>
                <ChromeRenderer data={header} bindings={bindings} />
            </div>
            {(headerRoot.transparent || headerSticky) && <ChromeHeaderScroll />}
        </header>
    ) : undefined;

    // Full-bleed band ABOVE the header: rendered outside any container so a theme can paint edge-to-edge
    // (the hardcoded container wrapper on header/footer is exactly what made that impossible before). Its
    // blocks are the presentational ones (ChromeText/ChromeButton/ChromeRow/…); ChromeNav is barred by
    // the validator. Nothing renders when no composition survives resolution.
    const announcementSlot = announcement ? (
        <aside className="wjs-chrome-announcement w-full bg-[var(--wjs-bg-announcement,var(--wjs-color-primary,#1f2937))] text-[var(--wjs-color-on-primary,#ffffff)] text-sm">
            <div className="wjs-announcement-container container mx-auto px-4 py-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-center">
                <ChromeRenderer data={announcement} bindings={bindings} location="header" />
            </div>
        </aside>
    ) : undefined;

    const footerRoot = chromeRootOptions(footer);
    const footerSlot = footer ? (
        <footer className="wjs-chrome-footer bg-[var(--wjs-bg-footer,rgb(17,24,39))] text-[var(--wjs-color-text-footer-main,white)] py-12 mt-auto border-t border-[var(--wjs-border-subtle,transparent)]">
            <div className={`wjs-footer-container ${containerClass(footerRoot)}`}>
                <ChromeRenderer data={footer} bindings={bindings} />
            </div>
        </footer>
    ) : undefined;

    return { headerSlot, footerSlot, announcementSlot };
}
