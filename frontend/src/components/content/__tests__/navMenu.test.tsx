import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NavMenuBlock } from "../blocks";

/**
 * NavMenu — the SSR + security contract of the block that BINDS to the site menu.
 *
 * The whole point of shipping navigation as a bound block (rather than storing items on the block) is
 * that the full <nav> and every <a> must be in the SERVER HTML — crawlers and no-JS visitors see the
 * real menu, and only the mobile toggle is a client island. What this pins is that promise plus the
 * security floor it inherits from HeadingBlock: author menu data may fill a slot, never choose
 * structure — target is whitelisted, _blank forces rel, labels are text, and every href is re-checked.
 *
 * `menu` is the FLAT item array exactly as resolveDynamicBlocks / useEditorMenu hand it over.
 */

const FLAT = [
    { id: 1, title: "Home", url: "/", target: "_self", parent: 0, order: 0 },
    { id: 2, title: "About", url: "/about", target: "_self", parent: 0, order: 1 },
    { id: 3, title: "Docs", url: "https://example.com/docs", target: "_blank", parent: 0, order: 2 },
    // child of About (id 2) → a submenu at depth 2
    { id: 4, title: "Team", url: "/about/team", target: "_self", parent: 2, order: 0 },
    // hostile: a javascript: url and a bogus target — neither may reach the DOM as authored
    { id: 5, title: "Evil", url: "javascript:alert(1)", target: "sneaky", parent: 0, order: 3 },
];

describe("NavMenuBlock — SSR carries every link (crawlable, no-JS)", () => {
    // mobileBehavior "none" keeps the desktop nav the only surface — cleanest for counting links.
    const html = renderToStaticMarkup(<NavMenuBlock menu={FLAT} mobileBehavior="none" />);
    const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);

    it("emits the block identity via bc(): own class first, historical alias second", () => {
        expect(html).toContain("wjs-block-nav-menu wp-block-nav-menu");
    });

    it("renders one <a> per menu item, with the real href and the label as text", () => {
        // 5 items (4 top-level + 1 nested) → 5 anchors, all present in the SSR HTML.
        expect(anchors).toHaveLength(5);
        expect(html).toContain('href="/"');
        expect(html).toContain("Home");
        expect(html).toContain('href="/about"');
        expect(html).toContain("About");
        expect(html).toContain('href="https://example.com/docs"');
        expect(html).toContain("Docs");
        // the nested child link is server-rendered too (inside the submenu, hidden by CSS not by JS)
        expect(html).toContain('href="/about/team"');
        expect(html).toContain("Team");
    });
});

describe("NavMenuBlock — target whitelist + rel + href re-validation (security)", () => {
    const html = renderToStaticMarkup(<NavMenuBlock menu={FLAT} mobileBehavior="none" />);

    it('_blank forces rel="noopener noreferrer"', () => {
        const docs = html.match(/<a\b[^>]*href="https:\/\/example\.com\/docs"[^>]*>/)?.[0] ?? "";
        expect(docs).toContain('target="_blank"');
        expect(docs).toContain('rel="noopener noreferrer"');
    });

    it("any other target coerces to _self with no rel", () => {
        const evil = html.match(/<a\b[^>]*>Evil<\/a>/)?.[0] ?? "";
        expect(evil).toContain('target="_self"');
        expect(evil).not.toContain("rel=");
        // the internal _self links carry no rel either
        const home = html.match(/<a\b[^>]*>Home<\/a>/)?.[0] ?? "";
        expect(home).toContain('target="_self"');
        expect(home).not.toContain("rel=");
    });

    it("re-validates hrefs at render — a javascript: url collapses to '#'", () => {
        const evil = html.match(/<a\b[^>]*>Evil<\/a>/)?.[0] ?? "";
        expect(evil).toContain('href="#"');
        expect(html).not.toContain("javascript:alert");
    });

    it("never uses dangerouslySetInnerHTML for a label", () => {
        // an HTML-ish label is escaped, not injected
        const withHtml = renderToStaticMarkup(
            <NavMenuBlock menu={[{ id: 9, title: "<img src=x onerror=1>", url: "/", parent: 0 }]} mobileBehavior="none" />,
        );
        expect(withHtml).not.toContain("<img src=x");
        expect(withHtml).toContain("&lt;img");
    });
});

describe("NavMenuBlock — submenu hooks + depth clamp", () => {
    it("a nested menu emits the .wjs-has-submenu / .wjs-chrome-submenu hooks", () => {
        const html = renderToStaticMarkup(<NavMenuBlock menu={FLAT} mobileBehavior="none" />);
        expect(html).toContain("wjs-has-submenu");
        expect(html).toContain("wjs-chrome-submenu");
    });

    it("depth=1 clamps the tree to the top level — the child link and submenu hooks are gone", () => {
        const html = renderToStaticMarkup(<NavMenuBlock menu={FLAT} depth={1} mobileBehavior="none" />);
        expect(html).not.toContain("wjs-has-submenu");
        expect(html).not.toContain("wjs-chrome-submenu");
        expect(html).not.toContain('href="/about/team"');
        // the four top-level links remain
        expect([...html.matchAll(/<a\b[^>]*>/g)]).toHaveLength(4);
    });
});

describe("NavMenuBlock — empty binding", () => {
    it("renders NOTHING on the public path (not editing)", () => {
        expect(renderToStaticMarkup(<NavMenuBlock menu={[]} />)).toBe("");
        expect(renderToStaticMarkup(<NavMenuBlock menu={undefined} />)).toBe("");
    });

    it("shows an authoring-only notice while editing", () => {
        const html = renderToStaticMarkup(<NavMenuBlock menu={[]} isEditing />);
        expect(html).toContain("wjs-block-nav-menu wp-block-nav-menu");
        expect(html).toContain("nav-menu--empty");
        expect(html).toContain("Vincula");
    });
});

describe("NavMenuBlock — mobile island wiring", () => {
    it('the default (drawer) mounts the hamburger island with aria-expanded, and keeps the SSR links', () => {
        const html = renderToStaticMarkup(<NavMenuBlock menu={FLAT} />);
        // hamburger toggle island (ChromeNavMobile) is present and starts collapsed
        expect(html).toContain("aria-expanded");
        // the desktop nav still carries the links in the SSR HTML
        expect(html).toContain('href="/"');
        expect(html).toContain('href="/about"');
    });
});
