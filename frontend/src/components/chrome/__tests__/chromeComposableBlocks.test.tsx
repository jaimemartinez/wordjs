import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ChromeRenderer from '../ChromeRenderer';
import { buildChromeBindings, chromeRootOptions, parseChromeData, type ChromeData } from '@/lib/chromeData';
import { applyChromeTokens } from '@/lib/chromeTokens';

/**
 * The header & footer editor's GA block set, through the REAL renderer (ChromeRenderer → each block),
 * from a composition that first passes the REAL parser — the same chain the public layout runs.
 *
 * Mutation proof: drop the visibility wrapper in renderBlock and the "per-breakpoint" test goes red;
 * render ChromeRichText's html without sanitizeHTML and the "<script>" test goes red; drop the
 * `title` guard in ChromeNav and the "no lone heading" test goes red; map `collapse` to the default
 * row and the hamburger-breakpoint test goes red.
 */

const menu = [
    { id: 1, title: 'Home', url: '/', order: 0 },
    { id: 2, title: 'Shop', url: '/shop', order: 1 },
];
const settings = {
    blogname: 'Roasters & Co',
    site_logo: '/uploads/logo.png',
    footer_socials: JSON.stringify([{ platform: 'instagram', url: 'https://instagram.com/x', icon: 'fa-brands fa-instagram' }]),
};

function render(data: ChromeData, opts: { headerMenu?: typeof menu; footerMenu?: typeof menu } = {}) {
    const parsed = parseChromeData(data, { source: 'test' });
    expect(parsed.errors).toEqual([]);
    const bindings = buildChromeBindings(settings, opts.headerMenu ?? menu, opts.footerMenu ?? menu);
    return renderToStaticMarkup(<ChromeRenderer data={parsed.data!} bindings={bindings} />);
}
const doc = (content: ChromeData['content'], root: Record<string, unknown> = {}): ChromeData => ({ root: { props: root }, content });

describe('per-breakpoint visibility', () => {
    it('wraps a block hidden on a breakpoint in a display:contents box hidden in that range only', () => {
        const html = render(doc([
            { type: 'ChromeText', props: { text: 'phones', hideMobile: true } },
            { type: 'ChromeText', props: { text: 'tablets', hideTablet: true } },
            { type: 'ChromeText', props: { text: 'desktops', hideDesktop: true } },
            { type: 'ChromeText', props: { text: 'always' } },
        ]));
        expect(html).toContain('<div class="wjs-chrome-visibility contents max-md:hidden"><span class="wjs-chrome-text break-words">phones</span></div>');
        expect(html).toContain('<div class="wjs-chrome-visibility contents md:max-lg:hidden"><span class="wjs-chrome-text break-words">tablets</span></div>');
        expect(html).toContain('<div class="wjs-chrome-visibility contents lg:hidden"><span class="wjs-chrome-text break-words">desktops</span></div>');
        // A block with no flag renders exactly as before — no wrapper at all.
        expect(html).toContain('</div><span class="wjs-chrome-text break-words">always</span>');
    });

    it('a flag set to false is the same as no flag', () => {
        expect(render(doc([{ type: 'ChromeText', props: { text: 'x', hideMobile: false } }]))).toBe('<span class="wjs-chrome-text break-words">x</span>');
    });
});

describe('multi-column footer and rows', () => {
    it('ChromeColumns is a grid that collapses to one column on phones; its cells render their blocks', () => {
        const html = render(doc([{ type: 'ChromeColumns', props: { columns: '4', gap: 'lg', items: [
            { type: 'ChromeRow', props: { direction: 'column', align: 'start', gap: 'md', items: [{ type: 'ChromeHeading', props: { text: 'About', level: 'h3' } }] } },
            { type: 'ChromeText', props: { text: 'cell 2' } },
        ] } }]));
        expect(html).toMatch(/class="wjs-chrome-columns grid w-full items-start grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8"/);
        expect(html).toContain('<h3 class="wjs-chrome-heading wjs-chrome-block-title font-bold m-0">About</h3>');
        expect(html).toContain('wjs-chrome-row--column flex flex-col items-start');
        expect(html).toContain('cell 2');
    });

    it('a row stacks below the chosen breakpoint and paints its tone band', () => {
        const html = render(doc([{ type: 'ChromeRow', props: { align: 'between', gap: 'md', stack: 'tablet', tone: 'primary', items: [] } }]));
        expect(html).toContain('max-lg:flex-col');
        expect(html).toContain('wjs-chrome-tone-primary');
    });

    it('a row with none of the new props keeps its exact pre-GA class list (existing themes unchanged)', () => {
        const html = render(doc([{ type: 'ChromeRow', props: { align: 'between', gap: 'md', wrap: true, items: [] } }]));
        expect(html).toBe('<div class="wjs-chrome-row flex items-center w-full justify-between gap-4 flex-wrap"></div>');
    });
});

describe('copyright, rich text and tokens', () => {
    it('ChromeCopyright fills {year} and {site}; the default line is "© {year} {site}"', () => {
        const year = String(new Date().getFullYear());
        expect(render(doc([{ type: 'ChromeCopyright', props: { text: 'Copyright {year}, {site}' } }]))).toContain(`Copyright ${year}, Roasters &amp; Co`);
        expect(render(doc([{ type: 'ChromeCopyright', props: {} }]))).toContain(`© ${year} Roasters &amp; Co`);
    });

    it('ChromeRichText keeps links and formatting but never a script, a handler or a javascript: link', () => {
        const html = render(doc([{ type: 'ChromeRichText', props: {
            html: '<strong>Bold</strong> <a href="/legal">Legal</a><script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">x</a> {year}',
        } }]));
        expect(html).toContain('<strong>Bold</strong>');
        expect(html).toContain('<a href="/legal">Legal</a>');
        expect(html).not.toMatch(/<script|onerror|javascript:/i);
        expect(html).toContain(String(new Date().getFullYear()));
    });

    it('the {site} token cannot inject markup through the site title', () => {
        expect(applyChromeTokens('{site} © {year}', { site: 'A', year: 2030 })).toBe('A © 2030');
        const bindings = buildChromeBindings({ blogname: '<img src=x onerror=alert(1)>' }, [], []);
        const parsed = parseChromeData(doc([{ type: 'ChromeRichText', props: { html: '<p>{site}</p>' } }]));
        const html = renderToStaticMarkup(<ChromeRenderer data={parsed.data!} bindings={bindings} />);
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).not.toContain('<img');
    });
});

describe('navigation, logo and socials', () => {
    it('collapse decides from which width the hamburger replaces the row', () => {
        const nav = (collapse?: string) => render(doc([{ type: 'ChromeNav', props: { location: 'header', orientation: 'horizontal', ...(collapse ? { collapse } : {}) } }]));
        expect(nav()).toContain('hidden md:flex items-center gap-8');
        expect(nav()).toContain('wjs-chrome-nav-mobile wjs-header-actions flex items-center gap-4 md:hidden');
        expect(nav('tablet')).toContain('hidden lg:flex');
        expect(nav('tablet')).toContain('gap-4 lg:hidden');
        expect(nav('always')).toMatch(/wjs-header-nav hidden items-center/);
        expect(nav('always')).toContain('wjs-chrome-nav-mobile wjs-header-actions flex items-center gap-4"');
        // never: the row at every width and no drawer island at all.
        expect(nav('never')).toContain('flex flex-wrap items-center gap-8');
        expect(nav('never')).not.toContain('wjs-chrome-nav-mobile');
    });

    it('a titled nav/socials shows its heading — and renders nothing at all when it has nothing to list', () => {
        const withItems = render(doc([{ type: 'ChromeNav', props: { location: 'footer', orientation: 'vertical', title: 'Quick Links' } }]));
        expect(withItems).toContain('<h4 class="wjs-chrome-block-title font-bold mb-4">Quick Links</h4>');
        expect(withItems).toContain('aria-label="Quick Links"');
        const empty = render(doc([{ type: 'ChromeNav', props: { location: 'footer', orientation: 'vertical', title: 'Quick Links' } }]), { footerMenu: [] });
        expect(empty).toBe('');
        expect(render(doc([{ type: 'ChromeSocials', props: { source: 'settings', title: 'Connect' } }]))).toContain('>Connect</h4>');
        // A heading with no level is an h3 — a level the themes' footer heading rules colour.
        expect(render(doc([{ type: 'ChromeHeading', props: { text: 'Links' } }]))).toMatch(/^<h3 [^>]*>Links<\/h3>$/);
    });

    it('ChromeLogo with showTitle prints the name next to the logo, and the image goes decorative', () => {
        const html = render(doc([{ type: 'ChromeLogo', props: { size: 'sm', showTitle: true } }]));
        expect(html).toContain('alt=""');
        expect(html).toContain('>Roasters &amp; Co</span>');
        expect(render(doc([{ type: 'ChromeLogo', props: { size: 'sm' } }]))).toContain('alt="Roasters &amp; Co"');
    });

    it('the language switcher renders nothing on the server (monolingual until the page says otherwise)', () => {
        expect(render(doc([{ type: 'ChromeLanguageSwitcher', props: { style: 'inline' } }]))).toBe('');
    });
});

describe('root options', () => {
    it('normalizes root props; an unstated sticky stays undefined so the theme layout decides', () => {
        expect(chromeRootOptions(doc([], {}))).toEqual({ sticky: undefined, transparent: false, overlayText: undefined, width: 'container' });
        expect(chromeRootOptions(doc([], { sticky: false, transparent: true, overlayText: 'light', width: 'full' }))).toEqual({ sticky: false, transparent: true, overlayText: 'light', width: 'full' });
        expect(chromeRootOptions(null)).toEqual({ sticky: undefined, transparent: false, overlayText: undefined, width: 'container' });
    });

    it('the parser type-checks known root props and ignores unknown ones (stored compositions keep working)', () => {
        expect(parseChromeData(doc([], { sticky: 'yes' })).ok).toBe(false);
        expect(parseChromeData(doc([], { width: 'huge' })).ok).toBe(false);
        expect(parseChromeData(doc([], { overlayText: 'white' })).ok).toBe(false);
        expect(parseChromeData(doc([], { title: 'from an older editor' })).ok).toBe(true);
    });
});
