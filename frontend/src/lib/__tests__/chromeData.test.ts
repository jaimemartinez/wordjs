import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    parseChromeData,
    resolveEffectiveChrome,
    parseChromeSocials,
    buildChromeBindings,
    isSafeChromeHref,
    STARTER_TEMPLATES,
    CHROME_MAX_BLOCKS,
} from '../chromeData';

// A representative valid composition with a nested Row (depth 3 at the deepest leaf).
const VALID = {
    root: { props: {} },
    content: [
        {
            type: 'ChromeRow',
            props: {
                align: 'between',
                gap: 'md',
                items: [
                    { type: 'ChromeLogo', props: { size: 'md' } },
                    {
                        type: 'ChromeRow',
                        props: {
                            align: 'end',
                            gap: 'sm',
                            wrap: true,
                            items: [
                                { type: 'ChromeNav', props: { location: 'header', orientation: 'horizontal' } },
                                { type: 'ChromeButton', props: { label: 'Contact', href: '/contact', variant: 'primary' } },
                            ],
                        },
                    },
                ],
            },
        },
        { type: 'ChromeText', props: { text: 'plain text' } },
    ],
};

describe('parseChromeData', () => {
    it('accepts a valid composition with a nested Row (object and JSON-string forms)', () => {
        const asObject = parseChromeData(VALID);
        expect(asObject.ok).toBe(true);
        expect(asObject.errors).toEqual([]);
        expect(asObject.data).toEqual(VALID);

        const asString = parseChromeData(JSON.stringify(VALID));
        expect(asString.ok).toBe(true);
        expect(asString.data).toEqual(VALID);
    });

    it('allows the editor id prop on any block', () => {
        const result = parseChromeData({
            root: { props: {} },
            content: [{ type: 'ChromeText', props: { id: 'ChromeText-abc', text: 'x' } }],
        });
        expect(result.ok).toBe(true);
    });

    it('rejects a type outside the allowlist (whole composition, fail-closed)', () => {
        const result = parseChromeData({
            root: { props: {} },
            content: [
                { type: 'ChromeText', props: { text: 'fine' } },
                { type: 'ChromeIframe', props: { src: 'https://evil.example' } },
            ],
        });
        expect(result.ok).toBe(false);
        expect(result.data).toBeUndefined();
        expect(result.errors.some((e) => e.includes('unknown block type "ChromeIframe"'))).toBe(true);
    });

    it('rejects Object.prototype names as block types (allowlist must be hasOwnProperty, not `in`)', () => {
        for (const type of ['toString', 'constructor', 'hasOwnProperty']) {
            const result = parseChromeData({ root: { props: {} }, content: [{ type, props: {} }] });
            expect(result.ok).toBe(false);
            expect(result.errors.some((e) => e.includes(`unknown block type "${type}"`))).toBe(true);
        }
    });

    it('rejects nesting depth 4', () => {
        const depth4 = {
            root: { props: {} },
            content: [
                {
                    type: 'ChromeRow',
                    props: {
                        align: 'start', gap: 'sm',
                        items: [
                            {
                                type: 'ChromeRow',
                                props: {
                                    align: 'start', gap: 'sm',
                                    items: [
                                        {
                                            type: 'ChromeRow',
                                            props: {
                                                align: 'start', gap: 'sm',
                                                items: [{ type: 'ChromeText', props: { text: 'too deep' } }],
                                            },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                },
            ],
        };
        const result = parseChromeData(depth4);
        expect(result.ok).toBe(false);
        expect(result.errors.some((e) => e.includes('depth'))).toBe(true);
    });

    it(`rejects more than ${CHROME_MAX_BLOCKS} blocks (nested blocks count)`, () => {
        const flat = {
            root: { props: {} },
            content: Array.from({ length: CHROME_MAX_BLOCKS + 1 }, () => ({ type: 'ChromeText', props: { text: 'x' } })),
        };
        const result = parseChromeData(flat);
        expect(result.ok).toBe(false);
        expect(result.errors.some((e) => e.includes(`${CHROME_MAX_BLOCKS} blocks`))).toBe(true);

        // Exactly at the cap is fine.
        const atCap = {
            root: { props: {} },
            content: Array.from({ length: CHROME_MAX_BLOCKS }, () => ({ type: 'ChromeText', props: { text: 'x' } })),
        };
        expect(parseChromeData(atCap).ok).toBe(true);
    });

    it('rejects a composition over 64KB (string and object forms)', () => {
        const big = {
            root: { props: {} },
            content: [{ type: 'ChromeText', props: { text: 'a'.repeat(66 * 1024) } }],
        };
        expect(parseChromeData(JSON.stringify(big)).ok).toBe(false);
        const asObject = parseChromeData(big);
        expect(asObject.ok).toBe(false);
        expect(asObject.errors.some((e) => e.includes('bytes'))).toBe(true);
    });

    it('rejects unsafe ChromeButton hrefs and accepts safe ones', () => {
        const withHref = (href: string) => ({
            root: { props: {} },
            content: [{ type: 'ChromeButton', props: { label: 'Go', href, variant: 'ghost' } }],
        });
        expect(parseChromeData(withHref('javascript:alert(1)')).ok).toBe(false);
        expect(parseChromeData(withHref('data:text/html,x')).ok).toBe(false);
        // Protocol-relative smuggles an external host — not a relative path.
        expect(parseChromeData(withHref('//evil.example')).ok).toBe(false);
        expect(parseChromeData(withHref('/about')).ok).toBe(true);
        expect(parseChromeData(withHref('https://example.com/x')).ok).toBe(true);
        expect(parseChromeData(withHref('http://example.com')).ok).toBe(true);
    });

    it('rejects wrongly-typed or unknown props and missing required props', () => {
        const wrap = (block: any) => ({ root: { props: {} }, content: [block] });
        // enum out of range
        expect(parseChromeData(wrap({ type: 'ChromeSpacer', props: { size: 'xl' } })).ok).toBe(false);
        // wrong primitive type
        expect(parseChromeData(wrap({ type: 'ChromeSiteTitle', props: { showTagline: 'yes' } })).ok).toBe(false);
        expect(parseChromeData(wrap({ type: 'ChromeText', props: { text: 42 } })).ok).toBe(false);
        // missing required prop
        expect(parseChromeData(wrap({ type: 'ChromeNav', props: { orientation: 'horizontal' } })).ok).toBe(false);
        expect(parseChromeData(wrap({ type: 'ChromeSocials', props: {} })).ok).toBe(false);
        // Row slot must be an array
        expect(parseChromeData(wrap({ type: 'ChromeRow', props: { align: 'start', gap: 'sm', items: 'nope' } })).ok).toBe(false);
        // unknown prop key
        expect(parseChromeData(wrap({ type: 'ChromeText', props: { text: 'x', onClick: 'alert(1)' } })).ok).toBe(false);
        // Object.prototype names are still UNKNOWN props (hasOwnProperty, not `in`)
        expect(parseChromeData(wrap({ type: 'ChromeLogo', props: { toString: 'x' } })).ok).toBe(false);
        expect(parseChromeData(wrap({ type: 'ChromeText', props: { text: 'x', valueOf: 1 } })).ok).toBe(false);
    });

    it('rejects structural garbage (non-object, missing root/content, bad JSON, empty)', () => {
        expect(parseChromeData(undefined).ok).toBe(false);
        expect(parseChromeData(null).ok).toBe(false);
        expect(parseChromeData('').ok).toBe(false);
        expect(parseChromeData('{not json').ok).toBe(false);
        expect(parseChromeData([]).ok).toBe(false);
        expect(parseChromeData({ content: [] }).ok).toBe(false);
        expect(parseChromeData({ root: { props: {} } }).ok).toBe(false);
    });
});

describe('resolveEffectiveChrome', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        warnSpy.mockRestore();
    });

    const themeData = { root: { props: {} }, content: [{ type: 'ChromeText', props: { text: 'theme' } }] };
    const siteData = { root: { props: {} }, content: [{ type: 'ChromeText', props: { text: 'site' } }] };

    it('prefers a valid site composition over the theme one', () => {
        const result = resolveEffectiveChrome({ siteRaw: JSON.stringify(siteData), themeRaw: themeData });
        expect(result.source).toBe('site');
        expect(result.data).toEqual(siteData);
    });

    it('falls to the theme level when the site level is invalid', () => {
        const result = resolveEffectiveChrome({ siteRaw: '{broken json', themeRaw: themeData });
        expect(result.source).toBe('theme');
        expect(result.data).toEqual(themeData);
        // dev-only warn fired (NODE_ENV !== production under vitest)
        expect(warnSpy).toHaveBeenCalled();
    });

    it('returns source null when both levels are absent or invalid', () => {
        expect(resolveEffectiveChrome({})).toEqual({ source: null });
        expect(resolveEffectiveChrome({ siteRaw: null, themeRaw: undefined })).toEqual({ source: null });
        expect(resolveEffectiveChrome({ siteRaw: '', themeRaw: '' })).toEqual({ source: null });
        const bothBad = resolveEffectiveChrome({
            siteRaw: '{broken',
            themeRaw: { root: { props: {} }, content: [{ type: 'Nope', props: {} }] },
        });
        expect(bothBad.source).toBe(null);
        expect(bothBad.data).toBeUndefined();
    });
});

describe('STARTER_TEMPLATES', () => {
    it('header and footer starter compositions pass the parser', () => {
        const header = parseChromeData(STARTER_TEMPLATES.header, { source: 'starter-header' });
        expect(header.errors).toEqual([]);
        expect(header.ok).toBe(true);
        const footer = parseChromeData(STARTER_TEMPLATES.footer, { source: 'starter-footer' });
        expect(footer.errors).toEqual([]);
        expect(footer.ok).toBe(true);
    });
});

describe('helpers', () => {
    it('isSafeChromeHref covers the contract cases', () => {
        expect(isSafeChromeHref('/x')).toBe(true);
        expect(isSafeChromeHref('https://a.b')).toBe(true);
        expect(isSafeChromeHref('HTTP://a.b')).toBe(true);
        expect(isSafeChromeHref('javascript:x')).toBe(false);
        expect(isSafeChromeHref('//a.b')).toBe(false);
        expect(isSafeChromeHref('mailto:a@b.c')).toBe(false);
        expect(isSafeChromeHref('')).toBe(false);
        expect(isSafeChromeHref(42)).toBe(false);
    });

    it('parseChromeSocials handles string, array and garbage forms', () => {
        const links = [{ platform: 'X', url: 'https://x.com/a', icon: 'fa-brands fa-x-twitter' }];
        expect(parseChromeSocials({ footer_socials: JSON.stringify(links) })).toEqual(links);
        expect(parseChromeSocials({ footer_socials: links })).toEqual(links);
        expect(parseChromeSocials({ footer_socials: '{broken' })).toEqual([]);
        expect(parseChromeSocials({ footer_socials: '"not an array"' })).toEqual([]);
        expect(parseChromeSocials({})).toEqual([]);
        expect(parseChromeSocials(undefined)).toEqual([]);
    });

    // The public layout derives the renderer bindings through this helper — a missing menu or an
    // unfetchable settings read must yield EMPTY bindings (blocks degrade), never a throw mid-SSR.
    it('buildChromeBindings normalizes missing settings/menus to empty bindings', () => {
        expect(buildChromeBindings(null, undefined, null)).toEqual({
            menus: { header: [], footer: [] },
            settings: {},
        });
        // Non-array menus (bad upstream shape) normalize too.
        expect(buildChromeBindings({}, 'nope' as any, 7 as any).menus).toEqual({ header: [], footer: [] });
    });

    it('buildChromeBindings passes resolved menus and settings through untouched', () => {
        const settings = { blogname: 'Acme', site_logo: '/logo.png' };
        const header = [{ id: 1, title: 'Home', url: '/' }];
        const footer = [{ id: 2, title: 'About', url: '/about' }];
        const b = buildChromeBindings(settings, header, footer);
        expect(b.settings).toBe(settings);
        expect(b.menus.header).toBe(header);
        expect(b.menus.footer).toBe(footer);
    });
});
