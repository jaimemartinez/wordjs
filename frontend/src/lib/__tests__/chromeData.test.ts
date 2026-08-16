import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
    parseChromeData,
    resolveEffectiveChrome,
    parseChromeSocials,
    buildChromeBindings,
    buildMenuTree,
    isSafeChromeHref,
    safeChromeHref,
    STARTER_TEMPLATES,
    CHROME_MAX_BLOCKS,
    CHROME_DOCUMENT_SCOPED_BLOCKS,
} from '../chromeData';
import type { ChromeMenuItem } from '../chromeData';

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
        // Misma forma authority-relative, escondida tras los caracteres que el parser de URL del
        // navegador borra antes de parsear: las tres resuelven a https://evil.test/.
        for (const raw of ['/\t/evil.test', '/\n/evil.test', '/\r\\evil.test']) {
            expect(parseChromeData(withHref(raw)).ok, JSON.stringify(raw)).toBe(false);
        }
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

// THE POSITION GATE — mirrors backend/src/core/chrome-validate.ts (the authority).
//
// chrome/header.json and chrome/footer.json are resolved ONCE per document by the layout. A NAMED
// TEMPLATE PART is not: a page template may place it N times, inside the page body. A block written
// for the first world — one that owns a document-level global — therefore has no single-instance
// guarantee in the second, and is refused there.
describe('parseChromeData — the template-part position', () => {
    const nav = { type: 'ChromeNav', props: { location: 'header', orientation: 'horizontal' } };
    const wrap = (content: unknown[]) => ({ root: { props: {} }, content });

    it('refuses ChromeNav in a part and accepts the identical tree as site chrome', () => {
        // VALID nests its ChromeNav two Rows deep — the gate has to hold at every depth, not just
        // at the top level, or a ChromeRow is a laundering route.
        expect(parseChromeData(VALID, { position: 'part' }).ok).toBe(false);
        expect(parseChromeData(VALID, { position: 'chrome' }).ok).toBe(true);
        expect(parseChromeData(VALID).ok).toBe(true); // default is the site chrome
    });

    it('names the block and the reason, so the fallback-to-nothing is explainable', () => {
        const r = parseChromeData(wrap([nav]), { position: 'part', source: 'template part "promo"' });
        expect(r.ok).toBe(false);
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0]).toContain('template part "promo"');
        expect(r.errors[0]).toContain('ChromeNav');
        expect(r.errors[0]).toContain('document-level state');
    });

    it('bars a ChromeNav of ANY shape — the rule is the block, not the prop pair', () => {
        for (const location of ['header', 'footer']) {
            for (const orientation of ['horizontal', 'vertical']) {
                const r = parseChromeData(wrap([{ type: 'ChromeNav', props: { location, orientation } }]), { position: 'part' });
                expect(r.ok, `${location}/${orientation}`).toBe(false);
            }
        }
    });

    it('leaves every other block legal in a part — this narrows the allowlist, it does not gut it', () => {
        const legal = [
            { type: 'ChromeLogo', props: { size: 'md' } },
            { type: 'ChromeSiteTitle', props: { showTagline: true } },
            { type: 'ChromeSearch', props: { placeholder: 'Search' } },
            { type: 'ChromeSocials', props: { source: 'settings' } },
            { type: 'ChromeText', props: { text: 'hi' } },
            { type: 'ChromeButton', props: { label: 'Go', href: '/x', variant: 'primary' } },
            { type: 'ChromeSpacer', props: { size: 'sm' } },
            { type: 'ChromeRow', props: { align: 'center', gap: 'md', items: [] } },
        ];
        expect(parseChromeData(wrap(legal), { position: 'part' }).ok).toBe(true);
        expect(CHROME_DOCUMENT_SCOPED_BLOCKS).toEqual(['ChromeNav']);
    });

    // ANTI-DRIFT. The barred list is the output of an audit of the chrome components, and an audit
    // rots: someone adds a `useEffect` that touches `document` to a block nobody re-checked, and the
    // validator stays green while a second instance starts fighting over a global. So derive the
    // audit from the SOURCE and pin the two together. `useId` is exempt — React makes it unique per
    // instance, which is the opposite of a shared global.
    it('the barred list still matches what the components actually do', () => {
        const dir = join(__dirname, '..', '..', 'components', 'chrome');
        const DOC_STATE = /\bdocument\b|\bwindow\b|createPortal/;
        const offenders = new Set<string>();
        const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'));
        // Every module that touches document-level APIs, plus every block that IMPORTS one — the
        // state is ChromeNavMobile's, but ChromeNav is what a composition can name.
        const dirty = new Set(files.filter((f) => DOC_STATE.test(readFileSync(join(dir, f), 'utf8'))).map((f) => f.replace(/\.tsx$/, '')));
        for (const f of files) {
            const name = f.replace(/\.tsx$/, '');
            if (name === 'ChromeRenderer') continue; // the renderer, not a nameable block
            const src = readFileSync(join(dir, f), 'utf8');
            const importsDirty = [...dirty].some((d) => d !== name && new RegExp(`["'./]${d}["']`).test(src));
            if (dirty.has(name) || importsDirty) offenders.add(name);
        }
        // ChromeNavMobile is not itself a block type — it is reachable only through ChromeNav.
        offenders.delete('ChromeNavMobile');
        expect([...offenders].sort()).toEqual([...CHROME_DOCUMENT_SCOPED_BLOCKS].sort());
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

// THE ANNOUNCEMENT / TOP BAR position (OLA 4 B) — mirrors chrome-validate's 'announcement' position.
// A resolved site slot (not a template part) that STILL bars the document-scoped ChromeNav, because
// the header already mounts the one mobile drawer. Renders when a composition survives, nothing when
// none does — proven here at the resolve level; the layout wires the surviving data into a band.
describe('parseChromeData / resolveEffectiveChrome — the announcement position', () => {
    const wrap = (content: unknown[]) => ({ root: { props: {} }, content });
    const presentational = wrap([
        { type: 'ChromeText', props: { text: 'Free shipping' } },
        { type: 'ChromeButton', props: { label: 'Shop', href: '/shop', variant: 'primary' } },
    ]);
    const withNav = wrap([{ type: 'ChromeNav', props: { location: 'header', orientation: 'horizontal' } }]);

    it('accepts a presentational announcement composition', () => {
        expect(parseChromeData(presentational, { position: 'announcement' }).ok).toBe(true);
    });

    it('refuses ChromeNav in the announcement bar, naming the bar and the reason', () => {
        const r = parseChromeData(withNav, { position: 'announcement', source: 'site' });
        expect(r.ok).toBe(false);
        expect(r.errors.some((e) => /announcement bar/.test(e) && /ChromeNav/.test(e))).toBe(true);
    });

    it('RENDERS when a level survives and NOTHING (source null) when a ChromeNav sinks every level', () => {
        // present → data resolved (the layout emits a band)
        const present = resolveEffectiveChrome({ siteRaw: JSON.stringify(presentational), position: 'announcement' });
        expect(present.source).toBe('site');
        expect(present.data).toBeTruthy();
        // a ChromeNav is refused at BOTH the site and theme level → nothing renders
        const absent = resolveEffectiveChrome({ siteRaw: withNav, themeRaw: withNav, position: 'announcement' });
        expect(absent.source).toBe(null);
        expect(absent.data).toBeUndefined();
    });
});

describe('buildMenuTree', () => {
    it('nests children under their parent and leaves a flat menu as sorted roots', () => {
        const flat: ChromeMenuItem[] = [
            { id: 2, title: 'About', url: '/about', order: 1 },
            { id: 1, title: 'Home', url: '/', order: 0 },
        ];
        const tree = buildMenuTree(flat);
        expect(tree.map((n) => n.title)).toEqual(['Home', 'About']); // sorted by order
        expect(tree.every((n) => (n.children?.length ?? 0) === 0)).toBe(true);
    });

    it('attaches children (with parent id) to the parent, sorted by order', () => {
        const items: ChromeMenuItem[] = [
            { id: 1, title: 'Products', url: '/p', order: 0 },
            { id: 11, title: 'Beta', url: '/p/b', order: 1, parent: 1 },
            { id: 10, title: 'Alpha', url: '/p/a', order: 0, parent: 1 },
            { id: 2, title: 'Contact', url: '/c', order: 1 },
        ];
        const tree = buildMenuTree(items);
        expect(tree.map((n) => n.title)).toEqual(['Products', 'Contact']);
        const products = tree[0];
        expect(products.children?.map((c) => c.title)).toEqual(['Alpha', 'Beta']);
        // a grandchild works too
        const deep = buildMenuTree([...items, { id: 100, title: 'A1', url: '/p/a/1', parent: 10 }]);
        expect(deep[0].children?.[0].children?.map((c) => c.title)).toEqual(['A1']);
    });

    it('parent 0 / null / undefined all mean root', () => {
        const items: ChromeMenuItem[] = [
            { id: 1, title: 'Zero', url: '/', parent: 0 },
            { id: 2, title: 'Null', url: '/n', parent: null as unknown as number },
            { id: 3, title: 'Undef', url: '/u' },
        ];
        expect(buildMenuTree(items).map((n) => n.title).sort()).toEqual(['Null', 'Undef', 'Zero']);
    });

    it('is defensive: a dangling parent becomes a root, a self/2-cycle cannot loop forever', () => {
        // parent id names no item → treated as a root, not dropped into the void
        expect(buildMenuTree([{ id: 1, title: 'Orphan', url: '/o', parent: 999 }]).map((n) => n.title)).toEqual(['Orphan']);
        // self-parent → root (never its own child)
        expect(buildMenuTree([{ id: 1, title: 'Self', url: '/s', parent: 1 }]).map((n) => n.title)).toEqual(['Self']);
        // 2-cycle A↔B: neither is a root; the function must simply terminate with no infinite branch
        const cycle = buildMenuTree([
            { id: 1, title: 'A', url: '/a', parent: 2 },
            { id: 2, title: 'B', url: '/b', parent: 1 },
        ]);
        expect(Array.isArray(cycle)).toBe(true); // returns, does not hang
    });

    it('normalizes non-array input to an empty tree', () => {
        expect(buildMenuTree(null)).toEqual([]);
        expect(buildMenuTree(undefined)).toEqual([]);
        expect(buildMenuTree('nope' as unknown as ChromeMenuItem[])).toEqual([]);
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

    it('the announcement starter passes the parser at its own position (no ChromeNav)', () => {
        const ann = parseChromeData(STARTER_TEMPLATES.announcement, { source: 'starter-announcement', position: 'announcement' });
        expect(ann.errors).toEqual([]);
        expect(ann.ok).toBe(true);
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

    // El navegador BORRA tabulador, salto de linea y retorno de carro antes de parsear la URL, asi
    // que decidir sobre la cadena cruda es decidir sobre algo que el navegador nunca ve: las tres
    // grafias de abajo empiezan por '/' con un control en segunda posicion (ni '/' ni '\'), pasaban
    // el chequeo y acababan navegando a https://evil.test/.
    it('safeChromeHref rejects authority-relative smuggled behind stripped control characters', () => {
        for (const raw of ['/\t/evil.test', '/\n/evil.test', '/\r\\evil.test', '/\t\\evil.test', '/\r\n/evil.test']) {
            expect(safeChromeHref(raw), JSON.stringify(raw)).toBeUndefined();
            expect(isSafeChromeHref(raw), JSON.stringify(raw)).toBe(false);
        }
        // Verificado contra el parser WHATWG real: lo que el resolver rechaza es exactamente lo que
        // el navegador habria resuelto fuera del sitio.
        for (const raw of ['/\t/evil.test', '/\n/evil.test', '/\r\\evil.test']) {
            expect(new URL(raw, 'https://site.test/').origin, JSON.stringify(raw)).toBe('https://evil.test');
        }
    });

    // Un RESOLVER, no un predicado: devuelve la cadena LIMPIA, que es la que debe llegar al atributo.
    // Validar una cadena y pintar otra es justamente el hueco que se cierra aqui.
    it('safeChromeHref returns the cleaned value the browser will actually parse', () => {
        expect(safeChromeHref('/x')).toBe('/x');
        expect(safeChromeHref('https://a.b/p')).toBe('https://a.b/p');
        // Los controles se borran tambien en las que SI son seguras — se devuelve lo ya limpio.
        expect(safeChromeHref('/con\ttacto')).toBe('/contacto');
        expect(safeChromeHref('https://a.b/\nx')).toBe('https://a.b/x');
        // Una cadena que era toda controles queda vacia: un href vacio no es navegable.
        expect(safeChromeHref('\t\n\r')).toBeUndefined();
        expect(safeChromeHref('')).toBeUndefined();
        expect(safeChromeHref(42)).toBeUndefined();
        expect(safeChromeHref(null)).toBeUndefined();
        // La limpieza NO puede abrir la puerta a un esquema: sigue sin casar la allowlist.
        expect(safeChromeHref('java\tscript:alert(1)')).toBeUndefined();
        expect(safeChromeHref('\tjavascript:alert(1)')).toBeUndefined();
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
