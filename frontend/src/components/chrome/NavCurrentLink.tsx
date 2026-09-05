"use client";

/**
 * The current-page marker for menu links rendered by a SERVER component.
 *
 * WHY A CLIENT ISLAND AT ALL. The public chrome is rendered by the (public) layout, and a layout is
 * (a) prerendered ONCE per route into the Full Route Cache — a server component there has no way to
 * read the pathname (`headers()` would answer it, at the price of turning the whole public tree
 * dynamic, which is the exact regression the performance program removed) — and (b) PRESERVED across
 * client-side navigations: React reuses the layout segment instead of re-rendering it, so even a
 * pathname the server somehow knew would go stale the moment the visitor clicked a link. `usePathname`
 * is the only source that is correct in both situations.
 *
 * NO FLASH, NO MISMATCH. These are client components, so they still SERVER-RENDER: the prerender of
 * /about carries aria-current="page" on the /about link in its HTML, and hydration recomputes the same
 * value from the same pathname. The attribute is in the first paint, not added a frame later, and
 * there is nothing for React to reconcile. On a client-side navigation the island re-renders (it
 * subscribes to the pathname) while the cached layout around it does not, which is the whole point.
 *
 * WHERE THESE ARE *NOT* NEEDED: a surface that is already a client component (Header, Footer, the
 * ChromeNavMobile drawer) calls `usePathname()` once at the top of its list and passes the result to
 * `menuAriaCurrent` per item — a hook must not be called inside a `.map()`.
 *
 * THEMING. The attribute is the hook, and it is the only thing added: no class, no colour, no
 * underline. A theme styles the active item with `.wjs-header-nav a[aria-current="page"]`, whose
 * specificity (0,2,1) already beats the framework sheet's `.wjs-header-nav a` (0,1,1) — so a theme
 * wins the cascade without `!important`, and wordjs-ui.css ships no [aria-current] rule to fight.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { menuAriaCurrent } from "@/lib/chromeData";

interface NavCurrentLinkProps {
    href: string;
    className?: string;
    target?: "_self" | "_blank";
    rel?: string;
    children: React.ReactNode;
}

// next/link flavour — for navs whose links are client-side transitions (the composed chrome nav).
export function NavCurrentLink({ href, className, target, rel, children }: NavCurrentLinkProps) {
    return (
        <Link href={href} className={className} target={target} rel={rel} aria-current={menuAriaCurrent(href, usePathname())}>
            {children}
        </Link>
    );
}

// Plain-anchor flavour — for the NavMenu / MegaMenu blocks, which deliberately emit a bare <a> (a
// crawlable, no-JS link) and must keep emitting exactly that, attribute for attribute.
export function NavCurrentAnchor({ href, className, target, rel, children }: NavCurrentLinkProps) {
    return (
        <a href={href} className={className} target={target} rel={rel} aria-current={menuAriaCurrent(href, usePathname())}>
            {children}
        </a>
    );
}
