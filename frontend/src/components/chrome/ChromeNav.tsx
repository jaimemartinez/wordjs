// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client" — the mobile hamburger lives in the ChromeNavMobile client island it mounts next to
// the desktop nav. Items arrive RESOLVED by ChromeRenderer (menu by location); the block never
// fetches. Link colors keep today's header/footer token fallbacks per location.
//
// SUBMENUS. The menu model stores a parent hierarchy (post_parent); buildMenuTree nests the flat
// location menu into `children`, and this renders that nesting as a submenu. The disclosure is
// CSS-ONLY (no theme JS, matching the "a theme never ships client JS" boundary): a submenu is hidden
// with `visibility:hidden` and revealed on `:hover` OR `:focus-within` of its parent <li> (Tailwind
// group-hover / group-focus-within). `visibility:hidden` also removes the collapsed links from the tab
// order, so keyboard focus flows: Tab to the parent link opens its submenu (focus-within), Tab through
// the children, Tab out closes it — the accessible, escapable CSS-only pattern. Positioning uses
// LOGICAL properties (start/ps/ms) so it is correct under RTL. A menu with NO children renders exactly
// as it did before submenus existed — the flat path below is byte-for-byte unchanged.
import Link from "next/link";
import type { ChromeMenuItem } from "@/lib/chromeData";
import { buildMenuTree } from "@/lib/chromeData";
import ChromeNavMobile from "./ChromeNavMobile";

// Static literal maps so Tailwind sees every class (no interpolation).
const LINK_CLASS: Record<"header" | "footer", string> = {
    header: "text-[var(--wjs-color-text-main,gray)] hover:text-[var(--wjs-color-primary,blue)] font-medium transition-colors",
    footer: "text-[var(--wjs-color-text-footer-dim,gray)] hover:text-[var(--wjs-color-primary,white)] transition-colors",
};

// The dropdown surface for a horizontal (header/footer) submenu. Hidden until its parent <li> (the
// `group`) is hovered or holds focus. Logical `start-0`/`start-full` keep it flush under/beside the
// parent in both LTR and RTL.
const SUBMENU_PANEL =
    "wjs-chrome-submenu absolute z-50 min-w-[12rem] flex flex-col gap-1 list-none m-0 p-2 rounded-lg shadow-lg "
    + "bg-[var(--wjs-bg-surface,white)] border border-[var(--wjs-border-subtle,#e5e7eb)] "
    + "invisible opacity-0 translate-y-1 transition-all duration-150 "
    + "group-hover:visible group-hover:opacity-100 group-hover:translate-y-0 "
    + "group-focus-within:visible group-focus-within:opacity-100 group-focus-within:translate-y-0";

// A single item and its subtree. `depth` 0 is a top-level entry; a horizontal level-1 submenu drops
// DOWN (top-full), deeper ones fly to the side (start-full).
function NavItem({
    item,
    location,
    orientation,
    depth,
}: {
    item: ChromeMenuItem;
    location: "header" | "footer";
    orientation: "horizontal" | "vertical";
    depth: number;
}) {
    const children = item.children ?? [];
    const link = (
        <Link href={item.url || "#"} className={LINK_CLASS[location]}>
            {item.title}
        </Link>
    );

    if (children.length === 0) {
        return <li className="wjs-chrome-nav-item">{link}</li>;
    }

    const sublist = children.map((child) => (
        <NavItem key={child.id} item={child} location={location} orientation={orientation} depth={depth + 1} />
    ));

    // Vertical (footer) submenus are a STATIC indented list — a footer shows all its links, there is
    // no hover affordance to reveal them behind.
    if (orientation === "vertical") {
        return (
            <li className="wjs-chrome-nav-item wjs-has-submenu">
                {link}
                <ul className="wjs-chrome-submenu flex flex-col gap-2 list-none m-0 mt-2 ps-4">{sublist}</ul>
            </li>
        );
    }

    // Horizontal: a CSS-only dropdown. The caret is decorative (aria-hidden); the parent <a> is a real
    // link AND the focus target that opens the panel.
    const panelPos = depth === 0 ? "top-full start-0 mt-1" : "top-0 start-full ms-1";
    return (
        <li className="wjs-chrome-nav-item wjs-has-submenu relative group">
            <span className="inline-flex items-center gap-1">
                {link}
                <svg
                    aria-hidden="true"
                    className="w-3 h-3 opacity-70"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2.5}
                    stroke="currentColor"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                </svg>
            </span>
            <ul className={`${SUBMENU_PANEL} ${panelPos}`}>{sublist}</ul>
        </li>
    );
}

export interface ChromeNavViewProps {
    location: "header" | "footer";
    orientation: "horizontal" | "vertical";
    // Resolved bindings (flat; each item may carry a `parent` id — nesting is derived here).
    items: ChromeMenuItem[];
}

export default function ChromeNav({ location, orientation, items }: ChromeNavViewProps) {
    // Nest the flat menu. For a menu with no parent links this is just the sorted top-level list, so
    // the flat render paths below are unaffected.
    const tree = buildMenuTree(items);
    const hasSubmenus = tree.some((item) => (item.children?.length ?? 0) > 0);
    const label = location === "header" ? "Primary" : "Footer";
    // Most catalog themes style the header nav through .wjs-header-nav — the hook Header.tsx emits —
    // so a composed header nav emits it TOO, or activating a composition un-styles those themes. A
    // footer nav must not pick it up: those rules (order/width/justify !important) target the masthead.
    // …and a footer nav gets its OWN hook rather than none: wordjs-ui.css colours chrome navigation
    // by hook, so a hookless footer nav fell through to the bare `a` rule and came out link-coloured
    // and underlined on the footer band, while `.wjs-chrome-nav a` (which both locations share) would
    // have painted it the HEADER's nav colour. Two locations, two hooks, two sets of tokens.
    const hook = location === "header" ? " wjs-header-nav" : " wjs-footer-nav";
    // Flat links — the exact markup this block shipped before submenus. Used whenever no item nests.
    const flatLinks = tree.map((item) => (
        <Link key={item.id} href={item.url || "#"} className={LINK_CLASS[location]}>
            {item.title}
        </Link>
    ));
    const treeList = tree.map((item) => (
        <NavItem key={item.id} item={item} location={location} orientation={orientation} depth={0} />
    ));

    if (orientation === "vertical") {
        return (
            <nav aria-label={label} className={`wjs-chrome-nav wjs-chrome-nav-vertical${hook} flex flex-col gap-2`}>
                {hasSubmenus ? <ul className="flex flex-col gap-2 list-none m-0 p-0">{treeList}</ul> : flatLinks}
            </nav>
        );
    }

    // Horizontal in the FOOTER: no hamburger — the drawer is a header affordance (Footer.tsx has none,
    // and a portaled full-height drawer opening from the page bottom is not what a footer nav means).
    // The row therefore has to stay visible at every width, so it wraps instead of hiding below md.
    if (location === "footer") {
        return (
            <nav aria-label={label} className={`wjs-chrome-nav wjs-chrome-nav-horizontal${hook} flex flex-wrap items-center gap-8`}>
                {hasSubmenus ? <ul className="flex flex-wrap items-center gap-8 list-none m-0 p-0">{treeList}</ul> : flatLinks}
            </nav>
        );
    }

    // Horizontal in the HEADER: desktop row + mobile hamburger island (hidden ≥ md by the island itself).
    return (
        <>
            <nav aria-label={label} className={`wjs-chrome-nav wjs-chrome-nav-horizontal${hook} hidden md:flex items-center gap-8`}>
                {hasSubmenus ? <ul className="flex items-center gap-8 list-none m-0 p-0">{treeList}</ul> : flatLinks}
            </nav>
            <ChromeNavMobile items={tree} />
        </>
    );
}
