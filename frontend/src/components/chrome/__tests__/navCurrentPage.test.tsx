import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ChromeNav from "../ChromeNav";
import { NavMenuBlock, MegaMenuBlock } from "@/components/content/blocks";
import type { ChromeMenuItem } from "@/lib/chromeData";

/**
 * CURRENT-PAGE MARKING across every surface that paints a menu link.
 *
 * The gap this closes: the nav emitted plain links with nothing saying which one is the page being
 * viewed — no aria-current for a screen reader, and no hook for a theme that wants to underline the
 * active section. The attribute is computed from usePathname (see NavCurrentLink for why it cannot be
 * a server computation: the public layout is prerendered per route AND preserved across client-side
 * navigations), so these tests stub that hook and assert the RENDERED html.
 *
 * The invariant every case checks is the same: EXACTLY ONE link carries aria-current="page", it is
 * the right one, and when nothing matches there is NONE. "Exactly one" is the half that catches a
 * prefix-matching regression, where "/" would light up on every page of the site.
 *
 * Mutation proof: make the matcher use startsWith and "home is not current on a subpage" goes red;
 * drop the attribute from either link branch of ChromeNav (flat vs nested) and one case each goes red.
 */
const nav = vi.hoisted(() => ({ pathname: null as string | null }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

beforeEach(() => { nav.pathname = null; });

const countCurrent = (html: string) => html.match(/aria-current="page"/g)?.length ?? 0;
// The <a …> tag that carries the marker, so a case can assert WHICH link it landed on.
const currentAnchor = (html: string) => html.match(/<a\b[^>]*aria-current="page"[^>]*>/)?.[0] ?? "";

const FLAT: ChromeMenuItem[] = [
    { id: 1, title: "Home", url: "/", order: 0 },
    { id: 2, title: "About", url: "/about", order: 1 },
    { id: 3, title: "Contact", url: "/contact", order: 2 },
    { id: 4, title: "Docs", url: "https://example.com/about", order: 3 },
];

const NESTED: ChromeMenuItem[] = [
    { id: 1, title: "Products", url: "/products", order: 0 },
    { id: 10, title: "Widgets", url: "/products/widgets", order: 0, parent: 1 },
    { id: 11, title: "Gadgets", url: "/products/gadgets", order: 1, parent: 1 },
    { id: 2, title: "About", url: "/about", order: 1 },
];

describe("ChromeNav — the composed chrome nav marks the current page", () => {
    it("marks exactly one link, the one whose href is the current path", () => {
        nav.pathname = "/contact";
        const html = renderToStaticMarkup(<ChromeNav location="header" orientation="horizontal" items={FLAT} />);
        expect(countCurrent(html)).toBe(1);
        expect(currentAnchor(html)).toContain('href="/contact"');
    });

    it("marks NOTHING when the visitor is on a page no menu item points at", () => {
        nav.pathname = "/blog/some-post";
        const html = renderToStaticMarkup(<ChromeNav location="header" orientation="horizontal" items={FLAT} />);
        expect(countCurrent(html)).toBe(0);
        expect(html).not.toContain("aria-current");
    });

    it('marks the home link on "/" only — never on a subpage', () => {
        nav.pathname = "/";
        const home = renderToStaticMarkup(<ChromeNav location="header" orientation="horizontal" items={FLAT} />);
        expect(countCurrent(home)).toBe(1);
        expect(currentAnchor(home)).toContain('href="/"');

        nav.pathname = "/about";
        const about = renderToStaticMarkup(<ChromeNav location="header" orientation="horizontal" items={FLAT} />);
        expect(countCurrent(about)).toBe(1);
        expect(currentAnchor(about)).toContain('href="/about"');
    });

    it("marks only the page link in a ONE-PAGE menu, never its section anchors", () => {
        // The live case this rule came from: a menu of "/", "/#venues", "/#prices". Stripping the hash
        // would mark all three on the home page and announce three current links in one nav.
        nav.pathname = "/";
        const onePage: ChromeMenuItem[] = [
            { id: 1, title: "Home", url: "/", order: 0 },
            { id: 2, title: "Venues", url: "/#venues", order: 1 },
            { id: 3, title: "Prices", url: "/#prices", order: 2 },
        ];
        const html = renderToStaticMarkup(<ChromeNav location="header" orientation="horizontal" items={onePage} />);
        expect(countCurrent(html)).toBe(1);
        expect(currentAnchor(html)).toContain('href="/"');
    });

    it("ignores a trailing slash on the current path", () => {
        nav.pathname = "/about/";
        const html = renderToStaticMarkup(<ChromeNav location="header" orientation="horizontal" items={FLAT} />);
        expect(countCurrent(html)).toBe(1);
        expect(currentAnchor(html)).toContain('href="/about"');
    });

    it("never marks an absolute url, even when its path is the current one", () => {
        // FLAT's "Docs" is https://example.com/about — the same PATH as the /about item.
        nav.pathname = "/about";
        const html = renderToStaticMarkup(<ChromeNav location="header" orientation="horizontal" items={FLAT} />);
        expect(countCurrent(html)).toBe(1);
        expect(currentAnchor(html)).not.toContain("example.com");
    });

    it("marks a nested submenu child without also marking its parent (exact match, no ancestors)", () => {
        nav.pathname = "/products/widgets";
        const html = renderToStaticMarkup(<ChromeNav location="header" orientation="horizontal" items={NESTED} />);
        expect(countCurrent(html)).toBe(1);
        expect(currentAnchor(html)).toContain('href="/products/widgets"');
    });

    it("marks the footer nav too — the cue is not a header-only privilege", () => {
        nav.pathname = "/about";
        const html = renderToStaticMarkup(<ChromeNav location="footer" orientation="vertical" items={FLAT} />);
        expect(countCurrent(html)).toBe(1);
        expect(currentAnchor(html)).toContain('href="/about"');
    });

    it("stays silent with no router context at all (usePathname null): no attribute, no throw", () => {
        nav.pathname = null;
        const html = renderToStaticMarkup(<ChromeNav location="header" orientation="horizontal" items={FLAT} />);
        expect(html).not.toContain("aria-current");
        // …and the links themselves are untouched.
        expect(html).toContain('href="/contact"');
    });
});

describe("NavMenu / MegaMenu blocks — the in-content twins mark it the same way", () => {
    const BOUND = [
        { id: 1, title: "Home", url: "/", target: "_self", parent: 0, order: 0 },
        { id: 2, title: "About", url: "/about", target: "_self", parent: 0, order: 1 },
        { id: 3, title: "Docs", url: "https://example.com/about", target: "_blank", parent: 0, order: 2 },
        { id: 4, title: "Team", url: "/about/team", target: "_self", parent: 2, order: 0 },
    ];

    it("NavMenu marks exactly one link — including a link inside a submenu", () => {
        nav.pathname = "/about/team";
        const html = renderToStaticMarkup(<NavMenuBlock menu={BOUND} mobileBehavior="none" />);
        expect(countCurrent(html)).toBe(1);
        expect(currentAnchor(html)).toContain('href="/about/team"');
        // The submenu PARENT (/about) is not the current page and must not be marked.
        expect(html).toMatch(/<a\b[^>]*href="\/about"(?![^>]*aria-current)/);
    });

    it("NavMenu marks nothing on an unrelated page, and keeps the security floor intact", () => {
        nav.pathname = "/blog";
        const html = renderToStaticMarkup(<NavMenuBlock menu={BOUND} mobileBehavior="none" />);
        expect(countCurrent(html)).toBe(0);
        // The added attribute did not disturb the target/rel contract of the _blank item.
        expect(html).toContain('rel="noopener noreferrer"');
    });

    it("MegaMenu top-level items mark the current page (byte-identical link, plus the attribute)", () => {
        nav.pathname = "/about";
        const html = renderToStaticMarkup(<MegaMenuBlock menu={BOUND} />);
        expect(countCurrent(html)).toBe(1);
        expect(currentAnchor(html)).toContain('href="/about"');
    });
});
