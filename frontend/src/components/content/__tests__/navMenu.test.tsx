import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
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

describe("NavMenuBlock — submenu disclosure lives in wordjs-ui.css (the MegaMenu pattern)", () => {
    // The reveal must NOT ride on Tailwind visible/invisible utilities: wordjs-ui.css ships an
    // UNLAYERED `.invisible { visibility: hidden !important }` that out-cascades any layered utility
    // toggle — the old group-hover/group-focus-within reveal could literally never open on the real
    // public page. The state now lives in the framework sheet on the block's own hooks.
    const css = fs.readFileSync(path.resolve(__dirname, "../../../../../backend/public/css/wordjs-ui.css"), "utf8");

    it("wordjs-ui.css ships the hidden/open rules on the block's hooks", () => {
        expect(css).toContain(".wjs-block-nav-menu .wjs-chrome-nav-horizontal .wjs-has-submenu > .wjs-chrome-submenu");
        expect(css).toContain('.wjs-block-nav-menu[data-trigger="hover"] .wjs-chrome-nav-horizontal .wjs-has-submenu:hover > .wjs-chrome-submenu');
        expect(css).toContain('.wjs-block-nav-menu[data-trigger="hover"] .wjs-chrome-nav-horizontal .wjs-has-submenu:focus-within > .wjs-chrome-submenu');
        // click mode: the island flips [data-open] and the sheet opens on it
        expect(css).toContain('.wjs-block-nav-menu .wjs-chrome-nav-horizontal .wjs-has-submenu[data-open="true"] > .wjs-chrome-submenu');
    });

    it("the markup carries no utility-based reveal that the sheet would defeat", () => {
        const html = renderToStaticMarkup(<NavMenuBlock menu={FLAT} mobileBehavior="none" />);
        expect(html).not.toContain("invisible");
        expect(html).not.toContain("group-hover");
        expect(html).not.toContain("group-focus-within");
        // …but the hooks the sheet keys on ARE there
        expect(html).toContain("wjs-chrome-nav-horizontal");
        expect(html).toContain("wjs-has-submenu");
        expect(html).toContain("wjs-chrome-submenu");
    });

    it("emits data-trigger on the wrapper (a RENDERED attr — the ui.css hover gate, like MegaMenu)", () => {
        expect(renderToStaticMarkup(<NavMenuBlock menu={FLAT} mobileBehavior="none" />)).toContain('data-trigger="hover"');
        expect(renderToStaticMarkup(<NavMenuBlock menu={FLAT} mobileBehavior="none" submenuTrigger="click" />)).toContain('data-trigger="click"');
        // a bogus value coerces to the hover default (author data never chooses structure)
        expect(renderToStaticMarkup(<NavMenuBlock menu={FLAT} mobileBehavior="none" submenuTrigger="onmouseover=x" />)).toContain('data-trigger="hover"');
    });

    it("the vertical submenu stays a static always-visible list (the hidden rule is horizontal-scoped)", () => {
        const html = renderToStaticMarkup(<NavMenuBlock menu={FLAT} orientation="vertical" />);
        expect(html).toContain("wjs-chrome-nav-vertical");
        expect(html).toContain("wjs-chrome-submenu");
        expect(html).not.toContain("wjs-chrome-nav-horizontal");
        // the hidden rule requires the horizontal hook in its compound selector, so it cannot match here
        expect(css).not.toMatch(/\.wjs-block-nav-menu\s+\.wjs-has-submenu\s*>\s*\.wjs-chrome-submenu/);
    });
});

describe("NavMenuBlock — submenuTrigger='click' renders a REAL toggle (the Safari/navigation fix)", () => {
    // A parent <a href> click NAVIGATES (and Safari never focuses links on click), so click mode can
    // never ride on :focus-within alone. The server renders the caret as a real <button> and the
    // NavClickSubmenus island (mounted only on the public surface) flips [data-open].
    it("click mode: the caret is a <button aria-expanded aria-haspopup> next to the still-navigable link", () => {
        const html = renderToStaticMarkup(<NavMenuBlock menu={FLAT} mobileBehavior="none" submenuTrigger="click" />);
        const btn = html.match(/<button\b[^>]*wjs-submenu-toggle[^>]*>/)?.[0] ?? "";
        expect(btn).not.toBe("");
        expect(btn).toContain('type="button"');
        expect(btn).toContain('aria-expanded="false"');
        expect(btn).toContain('aria-haspopup="true"');
        // the parent link keeps its real URL — the button, not the link, owns the disclosure
        expect(html).toContain('href="/about"');
    });

    it("hover mode (default): no button — the disclosure stays CSS-only, zero JS", () => {
        const html = renderToStaticMarkup(<NavMenuBlock menu={FLAT} mobileBehavior="none" />);
        expect(html).not.toContain("wjs-submenu-toggle");
        expect(html).not.toContain("aria-haspopup");
    });

    it("items without children never render a toggle, even in click mode", () => {
        const flatOnly = [{ id: 1, title: "Home", url: "/", parent: 0, order: 0 }];
        const html = renderToStaticMarkup(<NavMenuBlock menu={flatOnly} mobileBehavior="none" submenuTrigger="click" />);
        expect(html).not.toContain("wjs-submenu-toggle");
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
