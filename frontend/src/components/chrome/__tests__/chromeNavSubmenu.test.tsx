import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ChromeNav from '../ChromeNav';
import ChromeRenderer from '../ChromeRenderer';
import type { ChromeMenuItem } from '@/lib/chromeData';

/**
 * SUBMENUS in the composable chrome nav (OLA 4 A).
 *
 * The menu model always carried a parent hierarchy; ChromeNav rendered it flat. These prove the join:
 * a menu with a parent+children now renders a NESTED submenu structure (a <ul> inside the parent <li>,
 * the child links reachable), while a FLAT menu renders exactly as before — no <ul>, no submenu hooks.
 * That second half is the guarantee that this is additive, not a rewrite of every existing header.
 *
 * Mutation proof: make buildMenuTree return the flat list without attaching children (or make ChromeNav
 * ignore `children`) and the "renders a nested submenu" test goes red — the child link and the
 * wjs-chrome-submenu <ul> both vanish.
 */

const flat: ChromeMenuItem[] = [
    { id: 1, title: 'Home', url: '/', order: 0 },
    { id: 2, title: 'Contact', url: '/contact', order: 1 },
];

const nested: ChromeMenuItem[] = [
    { id: 1, title: 'Products', url: '/products', order: 0 },
    { id: 10, title: 'Widgets', url: '/products/widgets', order: 0, parent: 1 },
    { id: 11, title: 'Gadgets', url: '/products/gadgets', order: 1, parent: 1 },
    { id: 2, title: 'About', url: '/about', order: 1 },
];

describe('ChromeNav submenus', () => {
    it('renders a nested submenu structure when an item has children', () => {
        const html = renderToStaticMarkup(
            <ChromeNav location="header" orientation="horizontal" items={nested} />,
        );
        // The parent <li> carries the submenu hooks and a nested <ul> of the children.
        expect(html).toContain('wjs-has-submenu');
        expect(html).toContain('wjs-chrome-submenu');
        expect(html).toMatch(/<ul[^>]*wjs-chrome-submenu/);
        // CSS-only disclosure: the parent li is a hover/focus group.
        expect(html).toMatch(/<li[^>]*\bgroup\b/);
        // Both child links are present and reachable.
        expect(html).toContain('href="/products/widgets"');
        expect(html).toContain('href="/products/gadgets"');
        // A sibling with no children is still just a link, not a disclosure.
        expect(html).toContain('href="/about"');
    });

    it('leaves a FLAT menu unchanged — no <ul>, no submenu hooks, just the links', () => {
        const html = renderToStaticMarkup(
            <ChromeNav location="header" orientation="horizontal" items={flat} />,
        );
        expect(html).not.toContain('wjs-has-submenu');
        expect(html).not.toContain('wjs-chrome-submenu');
        expect(html).not.toContain('<ul');
        expect(html).toContain('href="/"');
        expect(html).toContain('href="/contact"');
    });

    it('a vertical (footer) nav nests children as a static indented sub-list', () => {
        const html = renderToStaticMarkup(
            <ChromeNav location="footer" orientation="vertical" items={nested} />,
        );
        expect(html).toContain('wjs-chrome-submenu');
        expect(html).toContain('href="/products/widgets"');
        // vertical submenus are not hover-disclosure groups
        expect(html).not.toContain('group-hover');
    });

    it('uses LOGICAL positioning so submenus are RTL-correct (start-*, not left-*)', () => {
        const html = renderToStaticMarkup(
            <ChromeNav location="header" orientation="horizontal" items={nested} />,
        );
        expect(html).toMatch(/start-0/);
        expect(html).not.toMatch(/\bleft-0\b/);
    });
});

/**
 * The announcement bar RENDERS its presentational composition, and emits nothing for an empty one.
 * (The refuse-ChromeNav and precedence behaviour is pinned at the parse/resolve level in
 * lib/__tests__/chromeData.test.ts; this is the rendering half.)
 */
describe('announcement bar rendering', () => {
    const bindings = { menus: { header: [], footer: [] }, settings: {} };
    it('renders the announcement composition content when present', () => {
        const data = {
            root: { props: {} },
            content: [
                { type: 'ChromeText', props: { text: 'Free shipping this week' } },
                { type: 'ChromeButton', props: { label: 'Shop', href: '/shop', variant: 'primary' } },
            ],
        } as never;
        const html = renderToStaticMarkup(<ChromeRenderer data={data} bindings={bindings} location="header" />);
        expect(html).toContain('Free shipping this week');
        expect(html).toContain('href="/shop"');
    });

    it('emits nothing for an empty composition', () => {
        const data = { root: { props: {} }, content: [] } as never;
        const html = renderToStaticMarkup(<ChromeRenderer data={data} bindings={bindings} location="header" />);
        expect(html).toBe('');
    });
});
