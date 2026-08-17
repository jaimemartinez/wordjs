import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { MegaMenuBlock, NavMenuBlock, MEGA_MENU_PANEL_SLOTS } from "../blocks";

/**
 * MegaMenu — the SSR + security contract of the HYBRID navigation block.
 *
 * The structure is BOUND to the nav_menu store exactly like NavMenu (`menu` arrives resolved as the
 * FLAT item array), while each top-level item's flyout panel is an inline SLOT. What this pins:
 *  - every top-level link lands in the SERVER HTML with the NavMenu security floor (href re-validated,
 *    target whitelisted, _blank forces rel, labels as text);
 *  - an item WITH panel content renders the .wjs-mega-menu__panel with its slotted children
 *    server-side (crawlable), CSS-only disclosure (no JS island at all);
 *  - an item WITHOUT panel renders byte-identical to a NavMenu top-level item (plain link, no flyout);
 *  - depth is FIXED: children in the bound menu are never rendered (no submenu recursion);
 *  - empty binding → nothing on public, authoring notice while editing.
 *
 * `panels` is the ordered panel0…panel5 array exactly as ContentRenderer hands it over: a render
 * function (the slot wrapper) for a panel with content, null for an empty/absent one.
 */

const FLAT = [
    { id: 1, title: "Home", url: "/", target: "_self", parent: 0, order: 0 },
    { id: 2, title: "Products", url: "/products", target: "_self", parent: 0, order: 1 },
    { id: 3, title: "Docs", url: "https://example.com/docs", target: "_blank", parent: 0, order: 2 },
    // child of Products — a MegaMenu has FIXED depth and must NOT render it
    { id: 4, title: "Widgets", url: "/products/widgets", target: "_self", parent: 2, order: 0 },
    // hostile: a javascript: url and a bogus target — neither may reach the DOM as authored
    { id: 5, title: "Evil", url: "javascript:alert(1)", target: "sneaky", parent: 0, order: 3 },
];

// Simulates ContentRenderer's slotOf: the slot renders as ONE wrapper div classed by the container.
// eslint-disable-next-line react/display-name -- a slot render fn, not a component (same as slotOf)
const panelWith = (children: React.ReactNode) => (className?: string) => (
    <div className={className}>{children}</div>
);

// panel0 → Home (first top-level item) carries content; every other panel is empty.
const PANELS = [panelWith(<span>Panel destacado</span>), null, null, null, null, null];

describe("MegaMenuBlock — SSR carries the top-level links (crawlable, no-JS)", () => {
    const html = renderToStaticMarkup(<MegaMenuBlock menu={FLAT} panels={PANELS} />);

    it("emits the block identity via bc(): own class first, historical alias second", () => {
        expect(html).toContain("wjs-block-mega-menu wp-block-mega-menu");
    });

    it("renders one <a> per TOP-LEVEL item with the real href and the label as text", () => {
        expect(html).toContain('href="/"');
        expect(html).toContain("Home");
        expect(html).toContain('href="/products"');
        expect(html).toContain("Products");
        expect(html).toContain('href="https://example.com/docs"');
        expect(html).toContain("Docs");
    });

    it("depth is FIXED: a child item in the bound menu is never rendered (no submenu recursion)", () => {
        expect(html).not.toContain('href="/products/widgets"');
        expect(html).not.toContain("Widgets");
        // 4 top-level items → exactly 4 anchors (the panel content here has none).
        expect([...html.matchAll(/<a\b[^>]*>/g)]).toHaveLength(4);
    });

    it("reuses the chrome vocabulary and adds the mega hooks", () => {
        expect(html).toContain("wjs-chrome-nav");
        expect(html).toContain("wjs-header-nav");
        expect(html).toContain("wjs-chrome-nav-item");
        expect(html).toContain("wjs-mega-menu");
    });
});

describe("MegaMenuBlock — target whitelist + rel + href re-validation (security)", () => {
    const html = renderToStaticMarkup(<MegaMenuBlock menu={FLAT} panels={PANELS} />);

    it('_blank forces rel="noopener noreferrer"', () => {
        const docs = html.match(/<a\b[^>]*href="https:\/\/example\.com\/docs"[^>]*>/)?.[0] ?? "";
        expect(docs).toContain('target="_blank"');
        expect(docs).toContain('rel="noopener noreferrer"');
    });

    it("any other target coerces to _self with no rel", () => {
        const evil = html.match(/<a\b[^>]*>Evil<\/a>/)?.[0] ?? "";
        expect(evil).toContain('target="_self"');
        expect(evil).not.toContain("rel=");
    });

    it("re-validates hrefs at render — a javascript: url collapses to '#'", () => {
        const evil = html.match(/<a\b[^>]*>Evil<\/a>/)?.[0] ?? "";
        expect(evil).toContain('href="#"');
        expect(html).not.toContain("javascript:alert");
    });

    it("never uses dangerouslySetInnerHTML for a label", () => {
        const withHtml = renderToStaticMarkup(
            <MegaMenuBlock
                menu={[{ id: 9, title: "<img src=x onerror=1>", url: "/", parent: 0 }]}
                panels={[null, null, null, null, null, null]}
            />,
        );
        expect(withHtml).not.toContain("<img src=x");
        expect(withHtml).toContain("&lt;img");
    });
});

describe("MegaMenuBlock — panels (the inline-slot half of the hybrid)", () => {
    it("an item WITH panel content renders .wjs-mega-menu__panel with the slotted child, server-side", () => {
        const html = renderToStaticMarkup(<MegaMenuBlock menu={FLAT} panels={PANELS} />);
        expect(html).toContain("wjs-mega-menu__panel");
        expect(html).toContain("Panel destacado");
        // The disclosure's selector contract: the panel is the CHILD of the li that carries the
        // reused .wjs-has-submenu hook (wordjs-ui.css opens `.wjs-has-submenu > .wjs-mega-menu__panel`
        // on :focus-within / [data-trigger="hover"] :hover — CSS-only, no JS island).
        expect(html).toMatch(/wjs-has-submenu[^>]*>(?:(?!<\/li>).)*wjs-mega-menu__panel/);
    });

    it("an item WITHOUT panel renders byte-identical to a NavMenu top-level item", () => {
        const one = [{ id: 2, title: "Products", url: "/products", target: "_self", parent: 0, order: 0 }];
        const mega = renderToStaticMarkup(
            <MegaMenuBlock menu={one} panels={[null, null, null, null, null, null]} />,
        );
        const nav = renderToStaticMarkup(<NavMenuBlock menu={one} mobileBehavior="none" />);
        const li = (html: string) => html.match(/<li\b[^>]*>.*?<\/li>/)?.[0] ?? "";
        expect(li(mega)).not.toBe("");
        expect(li(mega)).toBe(li(nav));
        // …and no flyout markup leaks in.
        expect(mega).not.toContain("wjs-mega-menu__panel");
        expect(mega).not.toContain("wjs-has-submenu");
    });

    it("panels map to the first 6 top-level items IN ORDER (panel index = item index)", () => {
        // Content on panel1 must attach to the SECOND item (Products), not the first.
        const panels = [null, panelWith(<span>Solo productos</span>), null, null, null, null];
        const html = renderToStaticMarkup(<MegaMenuBlock menu={FLAT} panels={panels} />);
        const items = [...html.matchAll(/<li\b[^>]*>.*?<\/li>/g)].map((m) => m[0]);
        expect(items.find((x) => x.includes("Products"))).toContain("Solo productos");
        expect(items.find((x) => x.includes(">Home<"))).not.toContain("Solo productos");
        // The exported slot-name list is the same fixed set the registries declare.
        expect(MEGA_MENU_PANEL_SLOTS).toEqual(["panel0", "panel1", "panel2", "panel3", "panel4", "panel5"]);
    });

    it("trigger drives data-trigger (hover reveal is opt-in; click stays focus-within only)", () => {
        // The wordjs-ui.css hover rule is gated on [data-trigger="hover"]; focus-within always opens.
        const hover = renderToStaticMarkup(<MegaMenuBlock menu={FLAT} panels={PANELS} trigger="hover" />);
        const click = renderToStaticMarkup(<MegaMenuBlock menu={FLAT} panels={PANELS} trigger="click" />);
        expect(hover).toContain('data-trigger="hover"');
        expect(click).toContain('data-trigger="click"');
        // A bogus value coerces to the hover default (author data never chooses structure).
        const bogus = renderToStaticMarkup(<MegaMenuBlock menu={FLAT} panels={PANELS} trigger="onmouseover=x" />);
        expect(bogus).toContain('data-trigger="hover"');
    });

    it("wordjs-ui.css ships the CSS-only disclosure on the block's hooks (no utility toggle, no JS)", () => {
        // The reveal must NOT ride on Tailwind visible/invisible utilities: this same sheet ships an
        // unlayered `.invisible { !important }` that out-cascades any layered utility toggle. Pin the
        // framework rules the markup contracts to.
        const css = fs.readFileSync(path.resolve(__dirname, "../../../../../backend/public/css/wordjs-ui.css"), "utf8");
        expect(css).toContain(".wjs-block-mega-menu .wjs-has-submenu > .wjs-mega-menu__panel");
        expect(css).toContain(".wjs-block-mega-menu .wjs-has-submenu:focus-within > .wjs-mega-menu__panel");
        expect(css).toContain('.wjs-block-mega-menu[data-trigger="hover"] .wjs-has-submenu:hover > .wjs-mega-menu__panel');
        // …and the markup itself carries no utility-based reveal that the sheet would defeat.
        const html = renderToStaticMarkup(<MegaMenuBlock menu={FLAT} panels={PANELS} />);
        expect(html).not.toContain("invisible");
        expect(html).not.toContain("group-hover");
        expect(html).not.toContain("group-focus-within");
    });

    it("fullWidth spans the nav (panel against the relative <nav>); anchored hangs from its item", () => {
        const full = renderToStaticMarkup(<MegaMenuBlock menu={FLAT} panels={PANELS} fullWidth={true} />);
        expect(full).toContain('data-full-width="true"');
        expect(full).toContain("inset-x-0");
        const anchored = renderToStaticMarkup(<MegaMenuBlock menu={FLAT} panels={PANELS} fullWidth={false} />);
        expect(anchored).toContain('data-full-width="false"');
        expect(anchored).not.toContain("inset-x-0");
        expect(anchored).toContain("min-w-[16rem]");
    });
});

describe("MegaMenuBlock — empty binding", () => {
    it("renders NOTHING on the public path (not editing)", () => {
        expect(renderToStaticMarkup(<MegaMenuBlock menu={[]} panels={PANELS} />)).toBe("");
        expect(renderToStaticMarkup(<MegaMenuBlock menu={undefined} panels={PANELS} />)).toBe("");
    });

    it("shows an authoring-only notice while editing", () => {
        const html = renderToStaticMarkup(<MegaMenuBlock menu={[]} panels={PANELS} isEditing />);
        expect(html).toContain("wjs-block-mega-menu wp-block-mega-menu");
        expect(html).toContain("mega-menu--empty");
        expect(html).toContain("Vincula");
    });
});
