/**
 * ARBITRARY CSS THROUGH THE OBJECT STYLE CHANNEL (props.css / props.look / blockVars).
 *
 * The payload is not markup, so no HTML sanitizer ever saw it: it is a JSON object that React turns
 * into a `style` attribute, and React does NOT escape `;` inside a style VALUE. One saved colour field
 *
 *     css.color = "red;position:fixed;inset:0;z-index:2147483647;background:#fff url(https://…)"
 *
 * therefore reached the public page verbatim — a full-screen, attacker-controlled overlay served from
 * the site's own origin, with an IP/User-Agent beacon in the background url() and, behind an invisible
 * fixed link, the whole viewport clickable to the attacker's destination. Any account with
 * `publish_posts` could do it. It is NOT XSS: no script runs and no cookie leaves.
 *
 * WHAT IS PINNED HERE, and why through the REAL producers:
 *  1. WRITE BOUNDARY — `sanitizeMetaValue('_puck_data', …)` from backend/src/core/sanitize-meta.ts,
 *     the actual function every write path calls, over a real Puck-shaped tree.
 *  2. EMISSION — `renderToStaticMarkup` of the real `SharedBlockShell` (the public site's wrapper) and
 *     of real block components, so the assertion is about the `style` ATTRIBUTE the browser receives,
 *     not about an intermediate object. Hand-building the style object would prove nothing: the whole
 *     defect lived in the step between the props and the attribute.
 *  3. THE MIRROR — the frontend criterion (components/blocks/safeStyle.ts) and the backend copy inside
 *     sanitize-meta.ts are driven over ONE corpus. They are two implementations of one rule and the
 *     only thing that can keep them honest is a test that runs both.
 *  4. NO REGRESSION — the legitimate looks still emit exactly what they emitted before.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import SharedBlockShell from '@/components/content/SharedBlockShell';
import { ButtonBlock, HeroBlock, PricingTableBlock, SectionBlock, TextBlock } from '@/components/content/blocks';
import { appearanceToStyle, type Appearance } from '@/components/blocks/blockShell';
import { blockVars } from '@/components/blocks/blockVars';
import {
    AUTHOR_CSS_PROPS,
    AUTHOR_CSS_VARS,
    NARROWED_VAR_VALUE,
    REVIEWED_VAR_DECLARATIONS,
    UNSAFE_STYLE_VALUE,
    URL_BEARING_PROP,
    safeCssUrl as feSafeCssUrl,
    safeClassToken,
    safeCssValue as feSafeCssValue,
    safeCustomPropValue as feSafeCustomPropValue,
    safeExtraClassList,
    safeStyleObject as feSafeStyleObject,
} from '@/components/blocks/safeStyle';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// The backend module is CommonJS with no `export` statement, so tsc classifies it as a script rather
// than a module (backend/tsconfig.json sets `moduleDetection: force`; the frontend's does not).
// Resolution and execution are fine — this suppression is purely about that classification, and it is
// the price of driving the REAL write-boundary function instead of a copy of it.
// @ts-expect-error -- CommonJS module, no ESM export statement
import backendMeta from '../../../../../backend/src/core/sanitize-meta';

const be = backendMeta as unknown as {
    sanitizeMetaValue: (key: string, value: unknown) => any;
    sanitizeStyleObject: (style: any) => any;
    sanitizeLookSpec: (look: any) => any;
    safeCssUrl: (raw: unknown) => string | null;
    safeCssValue: (prop: string, raw: unknown) => string | number | null;
    safeCustomPropValue: (name: string, raw: unknown) => string | number | null;
    AUTHOR_CSS_PROPS: Set<string>;
    AUTHOR_CSS_VARS: Set<string>;
    NARROWED_VAR_VALUE: Map<string, (raw: string) => string | null>;
    UNSAFE_STYLE_VALUE: RegExp;
    URL_BEARING_PROP: RegExp;
};

/** The overlay payload from the audit, verbatim. */
const OVERLAY = 'red;position:fixed;inset:0;z-index:2147483647;background:#fff url(https://attacker.example/x.png) center/contain no-repeat';

const styleAttr = (html: string): string[] =>
    [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);

describe('#24 write boundary — the stored _puck_data is already clean', () => {
    const tree = {
        root: { props: {} },
        content: [
            {
                type: 'Text',
                props: {
                    id: 'Text-1',
                    content: '<p>hello</p>',
                    css: { color: OVERLAY, position: 'fixed', inset: '0', zIndex: '2147483647' },
                    look: { bg: 'color', bgColor: OVERLAY, bgImage: 'https://attacker.example/x.png', color: '#111' },
                },
            },
        ],
    };

    it('drops every declaration the author was not allowed to make', () => {
        const clean = be.sanitizeMetaValue('_puck_data', tree);
        const props = clean.content[0].props;
        // `color` is an allowed PROPERTY, but that value carries three more declarations → dropped.
        expect(props.css).toEqual({});
        // `look` keeps its shape (isSet() reads '' as "not set") but the hostile strings are gone.
        expect(props.look.bgColor).toBe('');
        expect(props.look.color).toBe('#111');
        expect(JSON.stringify(clean)).not.toContain('position:fixed');
    });

    it('a _puck_data sent as a JSON STRING goes through the same guard', () => {
        const clean = JSON.parse(be.sanitizeMetaValue('_puck_data', JSON.stringify(tree)));
        expect(clean.content[0].props.css).toEqual({});
    });

    it('keeps what an author legitimately chose', () => {
        const ok = be.sanitizeMetaValue('_puck_data', {
            content: [{ props: { css: { color: '#112233', padding: '12px 24px', fontFamily: 'Inter, sans-serif' } } }],
        });
        expect(ok.content[0].props.css).toEqual({
            color: '#112233', padding: '12px 24px', fontFamily: 'Inter, sans-serif',
        });
    });

    it('an ORIGIN is required where a URL is the point, and it is quoted', () => {
        const out = be.sanitizeLookSpec({ bgImage: '/uploads/a.png' });
        expect(out.bgImage).toBe('/uploads/a.png');
        // Protocol-relative and its backslash twin are REMOTE, not "ours".
        expect(be.sanitizeLookSpec({ bgImage: '//evil.example/x.png' }).bgImage).toBe('');
        expect(be.sanitizeLookSpec({ bgImage: '/\\evil.example/x.png' }).bgImage).toBe('');
        expect(be.sanitizeLookSpec({ bgImage: 'data:image/svg+xml,<svg/>' }).bgImage).toBe('');
    });
});

describe('#24 emission — the style ATTRIBUTE the browser receives', () => {
    it('a hostile `look` produces no wrapper at all', () => {
        const html = renderToStaticMarkup(
            <SharedBlockShell look={{ bg: 'color', bgColor: OVERLAY } as Appearance}>
                <p>X</p>
            </SharedBlockShell>,
        );
        // Every declaration was rejected → hasBox is false → the block renders untouched.
        expect(html).toBe('<p>X</p>');
    });

    it('a hostile `look.color` cannot append declarations', () => {
        const html = renderToStaticMarkup(
            <SharedBlockShell look={{ color: 'red;position:fixed;inset:0', padY: 8 } as Appearance}>
                <p>X</p>
            </SharedBlockShell>,
        );
        expect(styleAttr(html)).toEqual(['padding:8px 0px']);
        expect(html).not.toContain('position:fixed');
    });

    it('a hostile `look.bgImage` cannot escape the url() token', () => {
        const escape = 'x.png) ;position:fixed;inset:0;background:url(https://attacker.example/y';
        const s = appearanceToStyle({ bg: 'image', bgImage: escape } as Appearance).style as Record<string, string>;
        expect(s.backgroundImage).toBeUndefined();
        const html = renderToStaticMarkup(
            <SharedBlockShell look={{ bg: 'image', bgImage: escape } as Appearance}>
                <p>X</p>
            </SharedBlockShell>,
        );
        expect(html).not.toContain('position:fixed');
        expect(html).not.toContain('attacker.example');
    });

    it('the overlay colour is a value, not a place to hang a rule', () => {
        const { overlay } = appearanceToStyle({ overlay: 0.5, overlayColor: '#000;position:static' } as Appearance);
        expect(overlay).not.toBeNull();
        expect((overlay as Record<string, unknown>).background).toBeUndefined();
    });

    it('blockVars refuses the same payload — a free-text prop is the widest surface of all', () => {
        expect(blockVars('text', { color: OVERLAY })).toEqual({});
        const html = renderToStaticMarkup(<TextBlock content="hi" color={OVERLAY} />);
        expect(html).not.toContain('position:fixed');
        expect(html).not.toContain('attacker.example');
    });

    it('a block that builds its own url() var is validated and quoted too', () => {
        const bad = renderToStaticMarkup(
            <HeroBlock title="T" bgImage="x.png) ;position:fixed;background:url(y" />,
        );
        expect(bad).not.toContain('position:fixed');
        const good = renderToStaticMarkup(<HeroBlock title="T" bgImage="/uploads/hero.png" />);
        expect(good).toContain('--wjs-hero-bg-image:url(&quot;/uploads/hero.png&quot;)');
    });
});

describe('#24 no regression — legitimate looks emit what they always emitted', () => {
    const CASES: Array<[Appearance, Record<string, unknown>]> = [
        [{ bg: 'color', bgColor: '#fff' }, { background: '#fff' }],
        [
            { bg: 'gradient', gradFrom: '#a', gradVia: '#b', gradTo: '#c', gradAngle: 45 },
            { backgroundImage: 'linear-gradient(45deg, #a, #b, #c)' },
        ],
        [{ shadow: 'md' }, { boxShadow: 'var(--wjs-shadow-md, 0 4px 6px -1px rgb(0 0 0 / .10), 0 2px 4px -2px rgb(0 0 0 / .10))' }],
        [{ padY: 10, padX: 20, mt: 4, mb: 6, maxWidth: 800, minHeight: 200 },
            { padding: '10px 20px', marginTop: '4px', marginBottom: '6px', maxWidth: '800px', marginInline: 'auto', minHeight: '200px' }],
        [{ color: '#111', fontSize: 18, fontWeight: '700', fontFamily: 'X', lineHeight: 1.5, letterSpacing: 2, align: 'left', transform: 'uppercase' },
            { color: '#111', fontSize: '18px', fontWeight: '700', fontFamily: 'X', lineHeight: 1.5, letterSpacing: '2px', textAlign: 'start', textTransform: 'uppercase' }],
        [{ padY: 10, tb: { padY: 5 } },
            { padding: 'var(--wjs-r-padY) var(--wjs-r-padX)', '--wjs-r-padY': '10px', '--wjs-r-padY-tb': '5px', '--wjs-r-padY-mb': '5px', '--wjs-r-padX': '0px', '--wjs-r-padX-tb': '0px', '--wjs-r-padX-mb': '0px' }],
        [{ hover: 'lift', hoverAmount: 9, hoverSpeed: 200, hoverColor: '#f00' },
            { '--wjs-hover-amt': '9', '--wjs-hover-speed': '200ms', '--wjs-hover-color': '#f00' }],
    ];
    it.each(CASES)('%o', (look, expected) => {
        expect(appearanceToStyle(look).style).toEqual(expected);
    });

    it('blockVars still emits every value a block legitimately sets', () => {
        expect(blockVars('text', { color: '#111', size: '18px', leading: 1.6, measure: 'clamp(20ch, 60%, 70ch)' })).toEqual({
            '--wjs-text-color': '#111',
            '--wjs-text-size': '18px',
            '--wjs-text-leading': '1.6',
            '--wjs-text-measure': 'clamp(20ch, 60%, 70ch)',
        });
    });
});

/**
 * ONE corpus, BOTH implementations. The backend copy inside sanitize-meta.ts and the frontend
 * safeStyle.ts are the same rule written twice (different packages, no shared module). A divergence
 * means either the stored tree keeps something the renderer would emit, or the renderer drops
 * something the write path preserved — both are silent.
 *
 * THE CORPUS IS DERIVED, NOT TYPED OUT, and that is the whole repair of this block. The previous
 * version promised this invariant and then hand-picked a corpus that missed both divergences that
 * actually existed: not one value ended in `;` (the write boundary was eating them) and not one
 * property was a `--wjs-*` outside AUTHOR_CSS_VARS (the write boundary was storing them). A corpus
 * written by hand can only contain the cases somebody thought of, which are the cases the code
 * already handles. Here the property list is BUILT from the constants of both copies plus their
 * complements, and every value is also fed in its `value;` spelling, so a name added to either side
 * enters the corpus by itself.
 */
describe('#24 the write-boundary copy and the emission copy are the same criterion', () => {
    const BASE_VALUES = [
        OVERLAY, 'red;position:fixed', '#112233', 'rgb(0 0 0 / .5)', 'clamp(1rem, 2vw, 3rem)',
        'var(--wjs-color-primary, #2563eb)', 'uppercase', '700', 'Inter, sans-serif', '0px',
        'expression(alert(1))', 'javascript:alert(1)', '@import url(//evil.example)',
        'url(https://cdn.example/a.png)', 'url(/uploads/a.png)', 'url("/uploads/a.png")',
        'url(javascript:alert(1))', 'url(//evil.example/a.png)', 'url(/\\evil.example/a.png)',
        'url(data:image/svg+xml,<svg/>)', 'url(a.png) ;position:fixed;background:url(b',
        '<script>', 'a{b}', 'a\\0000',
        // The narrowed grammar's own corpus: magnitude, token escape, legitimate spellings.
        'scale(200)', 'scale(1.03)', '2) rotate(45deg', 'translateY(-6px)', 'translateY(9999px)',
        'none', 'matrix(2,0,0,2,0,0)', '200', '1.08', '-3', 'calc(1 + 1)',
    ];
    /** every value, plus the habitual trailing `;` spelling of it — where a whole divergence hid. */
    const VALUES = [...BASE_VALUES, ...BASE_VALUES.map((v) => `${v};`), ...BASE_VALUES.map((v) => `${v} ; `)];
    /**
     * Every property NAME either copy has an opinion about, plus the complements that prove the
     * opinion is closed: an author property, a shell-only property, a listed variable, a variable
     * that is narrowed, a `--wjs-*` that is neither, and a custom property that is not ours at all.
     */
    const PROPS = [
        ...AUTHOR_CSS_PROPS,
        ...AUTHOR_CSS_VARS,
        ...NARROWED_VAR_VALUE.keys(),
        'position', 'inset', 'zIndex', 'content', 'background',
        '--wjs-hero-bg-image', '--wjs-posts-thumb-image', '--wjs-anything-at-all', '--evil',
    ];

    it('the two copies agree on the LISTS themselves, not just on the corpus', () => {
        expect([...be.AUTHOR_CSS_PROPS].sort()).toEqual([...AUTHOR_CSS_PROPS].sort());
        expect([...be.AUTHOR_CSS_VARS].sort()).toEqual([...AUTHOR_CSS_VARS].sort());
        expect([...be.NARROWED_VAR_VALUE.keys()].sort()).toEqual([...NARROWED_VAR_VALUE.keys()].sort());
        expect(be.UNSAFE_STYLE_VALUE.source).toBe(UNSAFE_STYLE_VALUE.source);
        expect(be.URL_BEARING_PROP.source).toBe(URL_BEARING_PROP.source);
    });

    it.each(PROPS)('safeCssValue agrees on every corpus value for %s', (prop) => {
        for (const v of VALUES) {
            expect([prop, v, be.safeCssValue(prop, v)]).toEqual([prop, v, feSafeCssValue(prop, v)]);
        }
    });

    it.each(PROPS.filter((p) => p.startsWith('--')))('safeCustomPropValue agrees for %s', (prop) => {
        for (const v of VALUES) {
            expect([prop, v, be.safeCustomPropValue(prop, v)]).toEqual([prop, v, feSafeCustomPropValue(prop, v)]);
        }
    });

    it('safeCssUrl agrees on every corpus value', () => {
        for (const v of [...VALUES, '/uploads/a.png', '//evil.example', 'a.png', 'https://cdn.example/a.png?x=1&y=2']) {
            expect([v, be.safeCssUrl(v)]).toEqual([v, feSafeCssUrl(v)]);
        }
    });

    it('the style-object filter agrees over an object built from the whole property corpus', () => {
        // One object carrying EVERY name above with a hostile value, and a second with a plausible
        // one: whatever either copy keeps, the other must keep identically.
        for (const value of ['scale(200)', OVERLAY, '#112233', '1.08', 'url(/uploads/a.png)', '12px;']) {
            const obj = Object.fromEntries(PROPS.map((p) => [p, value]));
            expect([value, be.sanitizeStyleObject(obj)]).toEqual([value, feSafeStyleObject(obj)]);
        }
    });

    it('the style-object filter agrees, property allowlist included', () => {
        const hostile = {
            color: OVERLAY, position: 'fixed', inset: '0', zIndex: '2147483647',
            padding: '12px', backgroundImage: 'url(/uploads/a.png)', '--wjs-text-color': '#111',
            '--evil': 'x', content: '"x"',
            // The name the write boundary used to STORE while the renderer refused to paint it.
            '--wjs-button-hover-transform': 'scale(200)',
        };
        expect(be.sanitizeStyleObject(hostile)).toEqual(feSafeStyleObject(hostile));
        expect(feSafeStyleObject(hostile)).toEqual({
            padding: '12px',
            backgroundImage: 'url("/uploads/a.png")',
            '--wjs-text-color': '#111',
        });
    });
});

/* ══ THE CLASS, NOT THE CASE ══════════════════════════════════════════════════════════════════════
 * A block prop that lands in a `--wjs-*` variable is free text inside whatever declaration the
 * STYLESHEET expands that variable into. Closing `--wjs-button-hover-transform` by name closed one
 * member; its sibling `--wjs-pricing-highlight-scale` — same `transform:`, same damage, fed by a
 * free-text field of the Pricing block — stayed open, because the fix was written against the
 * example. So the gate below is not a list of payloads: it ENUMERATES, from the real call sites and
 * every stylesheet shipped in this repo, the declaration each author-emittable variable actually
 * reaches, and fails when one reaches a declaration that is neither reviewed nor narrowed. A new
 * block, a new variable name, or a new rule in a theme's stylesheet is covered the day it lands.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** How many `blockVars(` calls the scan below actually parsed, vs how many exist. */
let callsSeen = 0;
let callsTotal = 0;
/**
 * …and how many were parsed but whose KEYS the scan could not read. `callsSeen === callsTotal` was
 * the whole self-check, and it counted CALLS: it noticed a non-literal PREFIX (the call never matched
 * at all, so `callsSeen` fell behind) and was blind to a non-literal KEY. `blockVars('x', {...vars})`
 * and `blockVars('x', { [k]: v })` matched the regex, incremented `callsSeen`, contributed ZERO names
 * to the surface, and left the gate green with a shrunken population — which is the natural spelling
 * for responsive variants or conditional options, not a hypothetical.
 */
let callsOpaque = 0;

/** Every `--wjs-*` name `blockVars()` can emit from PRODUCTION code (tests excluded). */
const emittableVarNames = (): Map<string, string[]> => {
    const found = new Map<string, string[]>();
    const walk = (dir: string): string[] => {
        const out: string[] = [];
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '__tests__') continue;
                out.push(...walk(p));
            } else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(p);
        }
        return out;
    };
    for (const file of walk(path.join(REPO, 'frontend/src'))) {
        const src = readFileSync(file, 'utf8');
        if (!file.endsWith(path.join('blocks', 'blockVars.ts'))) {
            // Every INVOCATION, however written — so a call whose prefix or map is not a literal is
            // counted here and not below, and the scan reports itself blind instead of passing.
            // Comments first: the codebase names `blockVars()` in prose more often than it calls it.
            const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
            callsTotal += (code.match(/blockVars\(/g) ?? []).length;
        }
        const call = /blockVars\(\s*['"]([a-z0-9-]+)['"]\s*,\s*\{/g;
        for (let m = call.exec(src); m !== null; m = call.exec(src)) {
            callsSeen++;
            // Take the literal object that follows, brace-matched — the keys are literals at every
            // call site, which is exactly why the NAME is knowable statically and the VALUE is not.
            let depth = 0;
            let end = -1;
            for (let i = call.lastIndex - 1; i < src.length; i++) {
                if (src[i] === '{') depth++;
                else if (src[i] === '}' && --depth === 0) { end = i; break; }
            }
            const body = src.slice(call.lastIndex, end);
            // A spread, or a computed key, means the KEYS are not knowable from this file. Count it
            // as opaque so the self-check below can refuse to run a scan that no longer covers the
            // real surface, instead of reporting a smaller one as if it were complete.
            const bodyCode = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
            if (/\.\.\./.test(bodyCode) || /(?:^|[{,\n])\s*\[/.test(bodyCode)) callsOpaque++;
            const keys = new Set<string>();
            const kv = /(?:^|[{,\n])\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g;
            for (let k = kv.exec(body); k !== null; k = kv.exec(body)) keys.add(k[1] || k[2] || k[3]);
            const shorthand = /(?:^|[{,\n])\s*([A-Za-z_$][\w$]*)\s*(?=[,}\n])/g;
            for (let k = shorthand.exec(body); k !== null; k = shorthand.exec(body)) keys.add(k[1]);
            for (const key of keys) {
                const name = `--wjs-${m[1]}-${key}`;
                found.set(name, [...(found.get(name) ?? []), path.relative(REPO, file)]);
            }
        }
    }
    return found;
};

/**
 * THE OTHER PRODUCER. `blockVars` is not the only code that writes a `--wjs-*` name: the SHELL
 * (`appearanceToStyle`, blockShell.ts) builds its own — `--wjs-hover-amt`, `--wjs-hover-speed`,
 * `--wjs-hover-color`, `--wjs-glass-blur`, and the responsive chain `--wjs-r-<prop>`/`-tb`/`-mb` —
 * from Appearance fields that are just as much author text (`--wjs-hover-amt` interpolates
 * `a.hoverAmount` with no grammar at all; sanitizeLookSpec lets `20000` through, it is not
 * punctuation). None of those names were in the population the gate iterated, so the decision
 * "reviewed or narrowed" was being made for ONE producer and skipped for the other.
 *
 * It is inert TODAY by accident and not by design: no stylesheet in the tree carries a `.wjs-fx` /
 * `.wjs-hover-*` rule, so nothing reads the variable. The day a theme writes
 * `.wjs-fx { transform: translateY(calc(var(--wjs-hover-amt) * -1px)) }` — which is the intended
 * design of the Movimiento feature — the name has to be in this list for anything to go red.
 */
const shellVarNames = (): Map<string, string[]> => {
    const file = path.join(REPO, 'frontend/src/components/blocks/blockShell.ts');
    const src = readFileSync(file, 'utf8');
    const rel = path.relative(REPO, file);
    const found = new Map<string, string[]>();
    const add = (name: string) => found.set(name, [...(found.get(name) ?? []), rel]);
    // Literal assignments: s["--wjs-hover-amt"] = …
    const literal = /\[\s*['"](--wjs-[A-Za-z0-9_-]+)['"]\s*\]/g;
    for (let m = literal.exec(src); m !== null; m = literal.exec(src)) add(m[1]);
    // The responsive family is a template over RESP_PROPS, which is a literal array right here.
    const respList = /export const RESP_PROPS[^=]*=\s*\[([^\]]*)\]/.exec(src);
    const props = [...(respList?.[1] ?? '').matchAll(/["']([A-Za-z0-9_-]+)["']/g)].map((m) => m[1]);
    const tmpl = new RegExp('\\[\\s*`(--wjs-[A-Za-z0-9_-]*)\\$\\{[^}]*\\}(-[A-Za-z0-9_-]*)?`\\s*\\]', 'g');
    for (let m = tmpl.exec(src); m !== null; m = tmpl.exec(src)) {
        for (const p of props) add(`${m[1]}${p}${m[2] ?? ''}`);
    }
    return found;
};

/** variable → the CSS properties whose declarations read it, over EVERY stylesheet in the repo. */
const varConsumers = (): Map<string, Map<string, string[]>> => {
    const sheets: string[] = [];
    const collect = (dir: string) => {
        // ROUND-4 FINDING (verify4 #29): this used to be `try { … } catch { return; }` around the ROOT
        // read as well, so renaming or moving one of the six directories below shrank the scanned surface
        // to nothing in silence — and the `sinks.length > 10` floor stayed satisfied by wordjs-ui.css
        // alone. A missing ROOT is now a failure; a directory that disappears under it (a race with a
        // build, a symlink) still just stops that branch, because the roots are what this file declares.
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules') continue;
                try { collect(p); } catch { /* vanished under us mid-walk */ }
            } else if (entry.name.endsWith('.css')) sheets.push(p);
        }
    };
    // Not only wordjs-ui.css: the public page also loads the ACTIVE THEME's stylesheet, and a theme
    // that expands one of these names inside a `transform:` would reopen the channel in a customer's
    // install with nothing failing in CI.
    //
    // Each root says whether it MUST contribute. The `try/catch { return }` this replaces hid a live
    // example of why that matters: `marketplace/themes` does not exist in this repository at all (it has
    // `dist/` and `plugins/`), so the row that reads "a theme could reopen the channel in a customer's
    // install" was scanning nothing — and no assertion could tell, because a root that yields zero sheets
    // and a root that is not there look identical to a floor of `> 10`.
    const SHEET_ROOTS: Array<{ dir: string; required: boolean; why?: string }> = [
        { dir: 'backend/public/css', required: true },
        { dir: 'backend/themes', required: true },
        { dir: 'backend/cli/templates', required: true },
        { dir: 'frontend/src', required: true },
        {
            dir: 'backend/plugins',
            required: false,
            why: 'present but contributes no stylesheet in this checkout — the bundled plugins ship compiled JS '
                + 'and no CSS. Kept because a plugin that ships one must be scanned the day it lands.',
        },
        {
            dir: 'marketplace/themes',
            required: false,
            why: 'absent in this repository — the marketplace ships plugins here and themes are published '
                + 'elsewhere. Kept so that the day the directory appears its sheets are scanned without an edit.',
        },
    ];
    for (const root of SHEET_ROOTS) {
        const abs = path.join(REPO, root.dir);
        const before = sheets.length;
        if (existsSync(abs)) collect(abs);
        if (!root.required) continue;
        if (!existsSync(abs) || sheets.length === before) {
            throw new Error(`the stylesheet scan declares ${root.dir} as a REQUIRED source of consumers and it `
                + `contributed ${sheets.length - before} stylesheets. A root that quietly stops contributing shrinks `
                + 'the population of every gate below it — restore it, or mark it `required: false` WITH a reason.');
        }
    }
    const byVar = new Map<string, Map<string, string[]>>();
    for (const sheet of sheets) {
        const css = readFileSync(sheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' '); // prose is not CSS
        const decl = /(?:^|[;{}])\s*([-a-zA-Z]+)\s*:\s*([^;{}]*var\([^;{}]*)/g;
        for (let m = decl.exec(css); m !== null; m = decl.exec(css)) {
            const uses = /var\(\s*(--wjs-[A-Za-z0-9_-]+)/g;
            for (let v = uses.exec(m[2]); v !== null; v = uses.exec(m[2])) {
                if (!byVar.has(v[1])) byVar.set(v[1], new Map());
                const props = byVar.get(v[1])!;
                props.set(m[1], [...(props.get(m[1]) ?? []), path.relative(REPO, sheet)]);
            }
        }
    }
    // A DECLARATION WHOSE PROPERTY IS ITSELF A CUSTOM PROPERTY IS NOT A SINK, IT IS A LINK.
    // `--wjs-r-radius: var(--wjs-r-radius-tb)` inside a media query means the value the author put in
    // `-tb` ends up wherever `--wjs-r-radius` ends up. Recorded raw, that read looked like "reaches
    // the declaration `--wjs-r-radius`", a property no list contains — so the responsive chain would
    // have had to be exempted name by name instead of judged on the declaration it actually lands in.
    // Resolve the chain to a fixpoint (guarding against a cycle) so each variable is judged on the
    // REAL properties it reaches.
    for (let pass = 0; pass < 8; pass++) {
        let changed = false;
        for (const [name, props] of byVar) {
            for (const [prop, sheets] of [...props]) {
                if (!prop.startsWith('--')) continue;
                props.delete(prop);
                changed = true;
                if (prop === name) continue; // self-reference: `--x: var(--x, …)` adds nothing
                for (const [real, from] of byVar.get(prop) ?? []) {
                    props.set(real, [...(props.get(real) ?? []), ...sheets, ...from]);
                }
            }
        }
        if (!changed) break;
    }
    for (const [name, props] of [...byVar]) if (props.size === 0) byVar.delete(name);
    return byVar;
};

describe('#24 CLASS — every author-controlled variable lands in a declaration that is reviewed or narrowed', () => {
    const emittable = emittableVarNames();
    const shellVars = shellVarNames();
    const consumers = varConsumers();
    const authorProperties = new Set(
        [...AUTHOR_CSS_PROPS].map((p) => p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)),
    );

    it('the scan itself found the real surface — a broken scan would pass everything', () => {
        expect(emittable.size).toBeGreaterThan(100);
        // Every call site was parsed. A `blockVars(prefix, map)` built from variables would emit names
        // this file cannot know, so it must fail HERE rather than silently shrink the surface scanned.
        expect(callsSeen, 'a blockVars() call site is not a literal prefix + literal object').toBe(callsTotal);
        expect(
            callsOpaque,
            'a blockVars() call whose keys are not literals (a spread, or a computed key): the scanned ' +
            'surface is no longer the real surface, so this gate would pass a name it never saw. Give ' +
            'the call literal keys, or teach emittableVarNames how to read that shape.',
        ).toBe(0);
        expect(emittable.has('--wjs-pricing-highlight-scale')).toBe(true);
        expect(consumers.get('--wjs-pricing-highlight-scale')?.has('transform')).toBe(true);
        expect(authorProperties.has('transform')).toBe(false);
        // …and the SECOND producer was found too. Both extractors, or the population is one-sided.
        expect(shellVars.has('--wjs-hover-amt'), 'the blockShell producer scan found nothing').toBe(true);
        expect(shellVars.has('--wjs-r-padY'), 'the RESP_PROPS expansion produced no names').toBe(true);
    });

    /**
     * THE CLAIM safeStyle.ts MAKES ABOUT NARROWED_VAR_VALUE, TURNED INTO A GATE.
     *
     * Its header says the table is written against the STYLESHEET rather than the call sites, "so a
     * block that starts feeding one tomorrow is already narrowed rather than newly exposed". That was
     * prose, and prose drifts: the table was two names short of the sheets. This derives the sink set
     * mechanically and requires the table to cover it — PRODUCER OR NO PRODUCER, which is the whole
     * point of the claim. A new `transform:` rule in any theme's stylesheet turns this red.
     */
    it('every --wjs-* name any stylesheet expands inside a transform: declaration is narrowed', () => {
        const sinks = [...consumers.entries()]
            .filter(([, props]) => props.has('transform'))
            .map(([name]) => name)
            .sort();
        expect(sinks.length, 'the stylesheet scan found no transform sink at all — it is broken').toBeGreaterThan(10);
        expect(
            sinks.filter((name) => !NARROWED_VAR_VALUE.has(name)),
            'a stylesheet expands these inside `transform:` and they have no bounded grammar. Add them ' +
            'to NARROWED_VAR_VALUE in components/blocks/safeStyle.ts (and its mirror in ' +
            'backend/src/core/sanitize-meta.ts) — having no producer today is not a reason to wait.',
        ).toEqual([]);
    });

    /**
     * A DECLARATION IS THE SAME DECLARATION IN EVERY WRITING MODE.
     *
     * `padding-inline-start` is `padding-left` with the writing direction taken into account, and
     * `border-start-start-radius` is a corner of `border-radius`. The tables in safeStyle.ts are spelled
     * in PHYSICAL properties because that is what the editor's CSS control emits, while the stylesheets
     * are written in LOGICAL ones — so twenty declarations that the author is already allowed to write
     * looked unjudged. This maps a directional/logical property back to the family it belongs to; the
     * family must ITSELF be author-controlled or reviewed, so the rule can never grant anything the
     * tables do not already grant. Positional properties (`top`, `bottom`, `inset-*`) have no family
     * here on purpose: they move the element out of its own box, which is the whole risk being bounded.
     */
    const familyOf = (prop: string): string | null => {
        const parts = prop.split('-');
        const DIRECTIONS = new Set(['top', 'right', 'bottom', 'left', 'inline', 'block', 'start', 'end']);
        const head = parts[0];
        if (head !== 'padding' && head !== 'margin' && head !== 'border') return null;
        const rest = parts.slice(1);
        const kept = rest.filter((p) => !DIRECTIONS.has(p));
        if (rest.length === kept.length && rest.length > 0) return null;   // nothing directional was removed
        return [head, ...kept].join('-');
    };

    /**
     * ROUND-4 FINDING (verify4 #22 and #29): the "producer or no producer" reasoning was applied to
     * `transform:` ALONE.
     *
     * There were two arms and a hole between them. The arm above asks the question of every name any
     * sheet expands inside `transform:`; the per-name arm below asks it of every property, but only of
     * names that HAVE a producer (`emittable ∪ shellVars ∪ AUTHOR_CSS_VARS`). A `--wjs-*` that no block
     * emits today, expanded by some sheet into `top:`, `order:` or `animation:`, was judged by NEITHER —
     * and the widest channel in the system needs no producer at all: ThemeTokenOverlay accepts ANY name
     * matching `/^--wjs-[a-z0-9-]+$/` from a theme mod and emits it on `:root`, where it applies to every
     * block on every page. Round 4 named one live member (`--wjs-section-stage-top`, expanded into `top:`
     * on a `position: sticky` element); asking the question over the whole consumer set finds eighteen
     * DECLARATIONS with no verdict at all.
     *
     * They are listed by PROPERTY rather than by variable name, because the property is what carries the
     * risk: if `order:` has no verdict then every name that reaches it is equally unjudged, and giving
     * `order:` a verdict settles all of them at once. Each row must still match a real sink, so a
     * property that gets classified in safeStyle.ts forces its row out instead of leaving an exemption
     * that silently covers the next arrival — and a property that appears in a NEW sheet rule fails here
     * on the day it lands, which is the whole point.
     *
     * NOT THIS FILE'S TO FIX: REVIEWED_VAR_DECLARATIONS / NARROWED_VAR_VALUE live in
     * frontend/src/components/blocks/safeStyle.ts and backend/src/core/sanitize-meta.ts.
     */
    const UNCLASSIFIED_SINK_PROPERTIES: Array<{ prop: string; why: string }> = [
        { prop: 'top', why: 'position: sticky/absolute offset — CAN move the element out of its own box (the round-4 member)' },
        { prop: 'bottom', why: 'same family as `top`' },
        { prop: 'inset-inline-end', why: 'same family as `top`, in logical spelling' },
        { prop: 'outline', why: 'paints outside the border box; a huge width is a full-page overlay' },
        { prop: 'outline-offset', why: 'pushes that outline arbitrarily far from the element' },
        { prop: 'order', why: 'reorders flex children — visual position without moving the box' },
        { prop: 'flex', why: 'grow/shrink/basis: resizes the element beyond its own content' },
        { prop: 'min-width', why: 'can force an element wider than its container (max-width IS reviewed)' },
        { prop: 'column-gap', why: 'spacing between columns; bounded like `gap`, which the author may write' },
        { prop: 'transition', why: 'a timing declaration; the risk is duration/property choice, not geometry' },
        { prop: 'animation', why: 'names a keyframe set — the strongest of these: it can drive anything the keyframes touch' },
        { prop: 'animation-duration', why: 'timing only' },
        { prop: 'animation-delay', why: 'timing only' },
        { prop: 'accent-color', why: 'a colour, like the reviewed `background`' },
        { prop: 'color-scheme', why: 'light/dark keyword' },
        { prop: 'backdrop-filter', why: 'a filter chain applied to what is BEHIND the element' },
        { prop: '-webkit-backdrop-filter', why: 'the prefixed twin of the above' },
        { prop: 'border-image', why: 'a paint source; unlike `background` it is not in the reviewed table' },
    ];

    it('a --wjs-* with NO producer is judged too — the theme-mod channel needs none', () => {
        const unclassified = new Map(UNCLASSIFIED_SINK_PROPERTIES.map((r) => [r.prop, r.why]));
        const settled = (prop: string) => {
            if (authorProperties.has(prop) || REVIEWED_VAR_DECLARATIONS.has(prop)) return true;
            const family = familyOf(prop);
            return !!family && (authorProperties.has(family) || REVIEWED_VAR_DECLARATIONS.has(family));
        };
        const offenders: string[] = [];
        const matched = new Set<string>();
        for (const [name, props] of consumers) {
            if (NARROWED_VAR_VALUE.has(name)) continue;
            for (const [prop, sheets] of props) {
                if (settled(prop)) continue;
                if (unclassified.has(prop)) { matched.add(prop); continue; }
                offenders.push(`${prop} ← ${name} (in ${[...new Set(sheets)].join(', ')})`);
            }
        }
        expect(consumers.size, 'the stylesheet scan found no consumers at all — it is broken').toBeGreaterThan(50);
        expect(
            [...new Set(offenders)].sort(),
            'a stylesheet expands a --wjs-* name into this declaration and NOTHING judges it: the property is ' +
            'not author-controlled, not in REVIEWED_VAR_DECLARATIONS, not a directional spelling of either, ' +
            'and the name has no bounded grammar. Having no producer is not protection — a theme mod may set ' +
            'ANY --wjs-* name. Decide the property once (REVIEWED_VAR_DECLARATIONS) or bound the value ' +
            '(NARROWED_VAR_VALUE), in safeStyle.ts AND sanitize-meta.ts.',
        ).toEqual([]);
        // Self-invalidating in both directions: a row that no longer matches a real sink is a stale claim.
        expect(
            [...unclassified.keys()].filter((p) => !matched.has(p)).sort(),
            'UNCLASSIFIED_SINK_PROPERTIES names a declaration that is no longer an unjudged sink — it was ' +
            'reviewed, or every name reaching it was narrowed, or the rule left the stylesheets. DELETE the ' +
            'row so this gate starts holding the property.',
        ).toEqual([]);
    });

    it('the directional-family rule cannot grant more than the tables already grant', () => {
        // The rule exists to stop `padding-inline-start` from looking like a new property. It must map ONLY
        // to a family that is itself allowed, and it must refuse to fold a positional property into one.
        expect(familyOf('padding-inline-start')).toBe('padding');
        expect(familyOf('margin-inline')).toBe('margin');
        expect(familyOf('border-inline-end')).toBe('border');
        expect(familyOf('border-start-start-radius')).toBe('border-radius');
        expect(familyOf('border-top-color')).toBe('border-color');
        expect(familyOf('inset-inline-end')).toBeNull();
        expect(familyOf('top')).toBeNull();
        expect(familyOf('border-image')).toBeNull();   // `image` is not a direction
        expect(familyOf('position')).toBeNull();
        for (const family of ['padding', 'margin', 'border', 'border-radius', 'border-color']) {
            expect(
                authorProperties.has(family) || REVIEWED_VAR_DECLARATIONS.has(family),
                `${family} is the family this rule folds directional spellings into, and it is no longer ` +
                'author-controlled or reviewed — the rule would now grant more than the tables do',
            ).toBe(true);
        }
    });

    // Author-controlled = the names blockVars emits (value is author text), the names the SHELL emits
    // from Appearance fields, PLUS the names props.css may itself choose. Every channel, one rule.
    const names = [...new Set([...emittable.keys(), ...shellVars.keys(), ...AUTHOR_CSS_VARS])].sort();
    it.each(names)('%s', (name) => {
        const reached = consumers.get(name);
        if (!reached) return; // no stylesheet reads it: nothing to reach
        const unhandled = [...reached.keys()].filter(
            (prop) => !authorProperties.has(prop) && !REVIEWED_VAR_DECLARATIONS.has(prop),
        );
        expect(
            unhandled.length === 0 || NARROWED_VAR_VALUE.has(name),
            `${name} reaches ${unhandled.join(', ')} (in ${[...reached.values()].flat().join(', ')}). ` +
            'Either give it a grammar in NARROWED_VAR_VALUE (safeStyle.ts AND sanitize-meta.ts), or, ' +
            'if that declaration cannot move/resize anything beyond the block box, add the PROPERTY to ' +
            'REVIEWED_VAR_DECLARATIONS — deciding once, here, instead of adding a guard at the call site.',
        ).toBe(true);
    });

    it('the AUTHOR_CSS_VARS invariant holds across every stylesheet, not just wordjs-ui.css', () => {
        for (const name of AUTHOR_CSS_VARS) {
            const reached = consumers.get(name);
            expect(reached, `${name} is read by no stylesheet — remove it from AUTHOR_CSS_VARS`).toBeDefined();
            expect([...reached!.keys()].filter((p) => !authorProperties.has(p))).toEqual([]);
        }
    });
});

/**
 * THE OTHER HALF OF THE CLASS: a value that reaches a style OBJECT without passing a builder.
 * `blockVars` and `safeCss` are the guarded routes, and everything above pins them — but a block can
 * always write `style={{ maxHeight: maxHeight }}` by hand, and then no criterion runs at all (that is
 * literally how SiteLogo's `maxHeight` got its own `safeCssValue` call). So the sites that build a
 * style object out of anything other than literals are ENUMERATED here: six today, each with the
 * reason it is safe. A new one fails this test rather than the next audit.
 */
const REVIEWED_INLINE_STYLE_SITES: Array<[string, RegExp, string]> = [
    ['content/AnimatedShell.tsx', /--wjs-anim-dur/, 'both values are Math.min/Math.max clamped numbers'],
    ['content/AudioTransport.tsx', /--wjs-audio-progress-pct/, 'a percentage computed from currentTime/duration'],
    ['content/blocks.tsx', /maxHeight: maxH/, 'maxH is the result of safeCssValue("maxHeight", …)'],
    ['content/blocks.tsx', /marginInlineStart/, 'computed from a heading level, never author text'],
    ['blocks/IxWords.tsx', /IX_WORD_INDEX_VAR/, 'a loop index and an array length'],
    ['blocks/VisibilityField.tsx', /animActive \|\| scrollActive/, 'clamped numbers — see its own comment'],
];

describe('#24 CLASS — no block builds a style object outside the guarded builders', () => {
    /** Style expressions that are neither built by a builder nor made of literals only. */
    const unguardedStyleSites = (): Array<{ file: string; line: number; expr: string }> => {
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, entry.name);
                if (entry.isDirectory()) { if (entry.name === '__tests__' || entry.name === 'node_modules') continue; walk(p); }
                else if (/\.tsx?$/.test(entry.name)) files.push(p);
            }
        };
        walk(path.join(REPO, 'frontend/src/components/content'));
        walk(path.join(REPO, 'frontend/src/components/blocks'));
        const builders = /blockVars\(|safeCss\(|safeStyleObject\(|safeCssValue\(|appearanceToStyle\(|\.style\b|\bvars\b/;
        const out: Array<{ file: string; line: number; expr: string }> = [];
        for (const file of files) {
            const src = readFileSync(file, 'utf8');
            const at = /style=\{/g;
            for (let m = at.exec(src); m !== null; m = at.exec(src)) {
                let depth = 0;
                let end = -1;
                for (let i = m.index + 'style='.length; i < src.length; i++) {
                    if (src[i] === '{') depth++;
                    else if (src[i] === '}' && --depth === 0) { end = i; break; }
                }
                const expr = src.slice(m.index + 'style='.length, end + 1);
                if (builders.test(expr)) continue;
                const interpolated = /\$\{/.test(expr)
                    || /:\s*(?:[A-Za-z_$][\w$]*(?:\s*[?.[]|\s*[,}]))/.test(expr);
                if (interpolated) {
                    out.push({ file: path.relative(REPO, file).replace(/\\/g, '/'), line: src.slice(0, m.index).split('\n').length, expr });
                }
            }
        }
        return out;
    };

    const sites = unguardedStyleSites();

    it('every hand-built style object is one of the reviewed sites', () => {
        const unknown = sites.filter(
            (s) => !REVIEWED_INLINE_STYLE_SITES.some(([file, marker]) => s.file.endsWith(file) && marker.test(s.expr)),
        );
        expect(
            unknown.map((s) => `${s.file}:${s.line} ${s.expr.replace(/\s+/g, ' ').slice(0, 120)}`),
            'A style object built from something other than literals: route it through blockVars/safeCss, ' +
            'or add it to REVIEWED_INLINE_STYLE_SITES with the reason its values cannot be author text.',
        ).toEqual([]);
    });

    it('and every reviewed site still exists — a stale exemption is an exemption for nothing', () => {
        for (const [file, marker] of REVIEWED_INLINE_STYLE_SITES) {
            expect(sites.some((s) => s.file.endsWith(file) && marker.test(s.expr)), `${file} ${marker}`).toBe(true);
        }
    });
});

/* ══ THE SECOND SINK ══════════════════════════════════════════════════════════════════════════════
 * THE `class` ATTRIBUTE, which was never part of the class and lands on the same element.
 *
 * Everything above bounds `style`. `globals.css` (imported by app/layout.tsx, so EVERY public route)
 * compiles a Tailwind utility bundle containing `.fixed`, `.inset-0`, `.z-50`, `.w-full`, `.h-full`,
 * `.bg-white` — which makes a class name a way to WRITE a declaration, exactly like a custom property
 * is. `className={`button-variant-${variant}`}` with `variant = "x fixed inset-0 z-50 w-full h-full
 * bg-white"` therefore emitted six extra classes onto an `<a href>` the same author controls: the
 * audit's overlay again, with no CSS, no props.css and no variable involved. A second one was found
 * while closing it — the container `className` prop, whose only bound was "at most 3 well-formed
 * tokens", and `fixed inset-0 z-50` is three well-formed tokens.
 *
 * WHY A SCAN AND NOT A LIST OF BLOCKS. The report brought ONE call site. Nine more had the same
 * shape, in four files, and the two producers in blockShell.ts have no JSX at all. So the gate is
 * stated the same way the style gate is: DERIVE every expression that reaches a `class` attribute in
 * the public render tree, REDUCE it by removing everything that cannot carry author text (string
 * literals, the guarded builders `bc`/`safeClassToken`/`animClasses`/`hideClasses`, ternary and `&&`
 * CONDITIONS — which decide, they do not become the string), and require whatever residue is left to
 * be an ENUMERATED site with the reason its value cannot be author text. A new block that interpolates
 * anything into a className fails HERE.
 *
 * WHAT THIS SCAN DOES NOT DERIVE, said plainly rather than implied: it does not know which residues
 * are dangerous, only that they exist. Each entry below is a human judgement recorded next to the
 * evidence, and two of them are recorded as STILL OPEN rather than as safe.
 */
const REVIEWED_INLINE_CLASS_SITES: Array<[string, RegExp, string]> = [
    // ── Locals built from literal ternaries / literal lookup maps in the same file ──────────────
    ['content/blocks.tsx', /\$\{panel\} \$\{panelPos\}/, 'panel/panelPos are locals assigned from literal ternaries on depth/orientation'],
    ['content/blocks.tsx', /orientClass, hook/, 'both locals are literal ternaries on `orient`'],
    ['content/blocks.tsx', /^listClass$/, 'a local built by cx() from literals plus alignClass, itself a literal ternary'],
    ['content/BackToTop.tsx', /posClass/, 'POSITION_CLASS is a literal map keyed by a two-value ternary'],
    ['content/OffCanvasClient.tsx', /HIDE_ABOVE_BP\[bp\]/, 'HIDE_ABOVE_BP/PANEL_BP/SIDE are literal maps; a miss yields undefined, which cx drops'],
    ['content/OffCanvasClient.tsx', /PANEL_BP\[bp\]/, 'idem — literal maps, no author string can become a class'],
    ['blocks/IxWords.tsx', /IX_WORD_CLASS/, 'a module constant ("wjs-ixw") in lib/verso/interactions/words.ts'],

    // ── Output of a guarded builder, forwarded ──────────────────────────────────────────────────
    ['content/AnimatedShell.tsx', /hideCls, animClasses\(anim\)/, 'hideClasses() emits three literals; animClasses() goes through safeClassToken'],
    ['blocks/VisibilityField.tsx', /hideCls, wrapActive/, 'same two builders, editor side'],
    ['content/SharedBlockShell.tsx', /^hideCls$/, 'hideClasses() output: three literal class names, nothing interpolated'],
    ['content/SharedBlockShell.tsx', /look\.className/, 'appearanceToStyle() output — every modifier in it is built by safeClassToken'],
    ['blocks/VisibilityField.tsx', /look\.className/, 'idem, editor side'],
    ['content/SharedBlockShell.tsx', /ixl\.className/, 'ixLayer() output: a `wjs-ix-<hash>` name the compiler mints, never author text'],
    // Not a claim: the pushes into that array are reduced by their own it() at the end of this file.
    ['blocks/blockShell.ts', /cls\.join\(" "\)/, 'derived — see "the shell builds its class list out of literals and bounded tokens only"'],

    // ── Container class: bounded at the sink, and the bound is asserted below ───────────────────
    ['content/blocks.tsx', /extraClass\(className\)/, 'extraClass delegates to safeExtraClassList (shape + no out-of-flow position keyword)'],

    // ── A class this component RECEIVES from its own caller ─────────────────────────────────────
    ['content/ContentRenderer.tsx', /^className$/, 'the slot wrapper class: the container block passes its OWN cx()/bc() output in'],
    ['content/PluginBlockHeavy.tsx', /^className$/, 'renderDropZone forwards the class the block asked for, same as Puck does'],
    ['content/TemplateRenderer.tsx', /^className$/, 'the slot fn hands each container block the class that block itself computed'],
    ['content/TemplateRenderer.tsx', /^p\.className$/, 'forwarded into Section/Grid/FlexRow/Columns, which pass it through extraClass'],

    // ── STILL OPEN, recorded as such: bounded in SHAPE only, no contract prefix ─────────────────
    // These belong to another surface (site chrome, editor field controls) and are listed so the
    // scan stays complete, NOT because they are closed. `ICON_TOKEN` in BackToTop admits TWO
    // space-separated tokens and neither file requires the `fa-` prefix, so `icon="fixed inset-0"`
    // still reaches the class attribute of an <i>. The damage is small (an inline glyph, no href of
    // its own) but the criterion is weaker than safeClassToken's, and saying so here is the point.
    ['content/BackToTop.tsx', /fa-solid \$\{iconClass\}/, 'OPEN: ICON_TOKEN bounds the shape (and allows 2 tokens) but demands no `fa-` prefix'],
    ['content/OffCanvasClient.tsx', /fa-solid \$\{iconClass\}/, 'OPEN: single token, [a-z0-9-] only, but no `fa-` prefix demanded'],
    ['content/TemplateRenderer.tsx', /wjs-template-part--\$\{area\}/, 'OPEN: `area` is String(p.area) from template data, admin-written, with no token grammar'],
    ['blocks/AppearanceField.tsx', /fa-solid \$\{o\.icon\}/, 'editor panel only: `o` iterates a literal options array in this same file'],
];

describe('#24 CLASS — no author text reaches a class attribute except through a bounded builder', () => {
    const TICK = String.fromCharCode(96);

    const balanced = (src: string, openIdx: number, open: string, close: string): number => {
        let d = 0;
        for (let i = openIdx; i < src.length; i++) {
            if (src[i] === open) d++;
            else if (src[i] === close && --d === 0) return i;
        }
        return -1;
    };

    /** Blank comments out, keeping length so line numbers stay true. */
    const maskComments = (src: string): string => src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + m.slice(p1.length).replace(/./g, ' '));

    /** Remove a whole call — name AND arguments — for the builders that bound their own output. */
    const dropCalls = (s: string, names: string[]): string => {
        for (;;) {
            const m = new RegExp(`\\b(?:${names.join('|')})\\s*\\(`).exec(s);
            if (!m) return s;
            const open = s.indexOf('(', m.index);
            const end = balanced(s, open, '(', ')');
            if (end < 0) return s;
            s = `${s.slice(0, m.index)} ${s.slice(end + 1)}`;
        }
    };

    /** A template literal contributes only its `${…}` holes; the literal chunks are our own source. */
    const flattenTemplates = (s: string): string => {
        for (;;) {
            const i = s.indexOf(TICK);
            if (i < 0) return s;
            let end = -1;
            for (let j = i + 1; j < s.length; j++) {
                if (s[j] === '\\') { j++; continue; }
                if (s[j] === TICK) { end = j; break; }
                if (s[j] === '$' && s[j + 1] === '{') { const e = balanced(s, j + 1, '{', '}'); if (e < 0) break; j = e; }
            }
            if (end < 0) return s.split(TICK).join(' ');
            const body = s.slice(i + 1, end);
            let inner = '';
            for (let j = 0; j < body.length; j++) {
                if (body[j] === '$' && body[j + 1] === '{') {
                    const e = balanced(body, j + 1, '{', '}');
                    inner += ` (${body.slice(j + 2, e)}) `;
                    j = e;
                }
            }
            s = s.slice(0, i) + inner + s.slice(end + 1);
        }
    };

    /**
     * Delete every CONDITION: the operand of a `?` or a `&&` decides WHETHER a class is emitted, it
     * never becomes the class. Cut back to the nearest separator at the same nesting depth, so a
     * ternary inside a call argument is handled like one at the top.
     */
    const dropConditions = (s: string): string => {
        for (;;) {
            let depth = 0, cut = -1, cutLen = 0;
            const lastSep: number[] = [0];
            for (let i = 0; i < s.length; i++) {
                const c = s[i];
                if (c === '(' || c === '[' || c === '{') { depth++; lastSep[depth] = i + 1; }
                else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
                else if (c === ',' || c === ':') lastSep[depth] = i + 1;
                else if (c === '?' && s[i + 1] !== '.' && s[i + 1] !== '?') { cut = i; cutLen = 1; break; }
                else if (c === '&' && s[i + 1] === '&') { cut = i; cutLen = 2; break; }
            }
            if (cut < 0) return s;
            s = `${s.slice(0, lastSep[depth] ?? 0)} ${s.slice(cut + cutLen)}`;
        }
    };

    const residue = (expr: string): string => {
        let s = expr;
        for (let k = 0; k < 16; k++) {
            const before = s;
            s = flattenTemplates(s);
            s = dropCalls(s, ['bc', 'safeClassToken', 'animClasses', 'hideClasses']);
            // `cx`/`clsx` only JOIN: unwrap them, because their ARGUMENTS still have to answer for
            // themselves. Dropping the call whole is how a scan reports a surface it never looked at.
            s = s.replace(/\b(?:cx|clsx)\s*\(/g, '(');
            s = s.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, ' ');
            s = dropConditions(s);
            s = s.replace(/\b(?:undefined|null|true|false|string|number|boolean|as|const)\b/g, ' ');
            s = s.replace(/[(){}[\],:?!;]|\|\||\.\.\.|\s+/g, ' ');
            s = s.trim();
            if (s === before.trim()) break;
        }
        return s.trim();
    };

    /** Every expression that reaches a `class` attribute, with what the reduction could not explain. */
    const classSites = (): Array<{ file: string; line: number; expr: string; residue: string }> => {
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, entry.name);
                if (entry.isDirectory()) { if (entry.name === '__tests__' || entry.name === 'node_modules') continue; walk(p); }
                else if (/\.tsx?$/.test(entry.name)) files.push(p);
            }
        };
        walk(path.join(REPO, 'frontend/src/components/content'));
        walk(path.join(REPO, 'frontend/src/components/blocks'));
        const out: Array<{ file: string; line: number; expr: string; residue: string }> = [];
        for (const file of files) {
            const src = maskComments(readFileSync(file, 'utf8'));
            const at = /\bclassName\s*[=:]\s*/g;
            for (let m = at.exec(src); m !== null; m = at.exec(src)) {
                const start = m.index + m[0].length;
                const c = src[start];
                if (c === '"' || c === "'") continue; // a literal attribute value: our own source
                let expr: string;
                if (c === '{') {
                    const end = balanced(src, start, '{', '}');
                    if (end < 0) continue;
                    expr = src.slice(start + 1, end);
                } else {
                    // `className: <expr>` in an object literal (blockShell returns one) or a type.
                    let depth = 0, end = -1;
                    for (let i = start; i < src.length; i++) {
                        const ch = src[i];
                        if (ch === '(' || ch === '[' || ch === '{') depth++;
                        else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) { end = i; break; } depth--; }
                        else if (depth === 0 && (ch === ',' || ch === ';' || ch === '\n')) { end = i; break; }
                    }
                    expr = src.slice(start, end < 0 ? src.length : end);
                }
                const r = residue(expr);
                if (r) {
                    out.push({
                        file: path.relative(REPO, file).replace(/\\/g, '/'),
                        line: src.slice(0, m.index).split('\n').length,
                        expr: expr.replace(/\s+/g, ' '),
                        residue: r,
                    });
                }
            }
        }
        return out;
    };

    const sites = classSites();

    it('the scan itself found the real surface — a broken reducer would pass everything', () => {
        // The reducer must still SEE an unguarded interpolation. This is the exact shape the report
        // brought, spelled here so a change that silently stops recognising it fails immediately.
        expect(residue(`${TICK}button-variant-\${variant}${TICK}`)).toBe('variant');
        // …and must not invent one out of a guarded site.
        expect(residue(`cx(bc('button__link'), safeClassToken('button-variant-', variant))`)).toBe('');
        expect(residue(`cx(bc('table'), striped === "true" && bc('table--striped'))`)).toBe('');
        expect(sites.length, 'no className site at all: the walk found no files').toBeGreaterThan(0);
    });

    it('every class expression carrying something other than literals is a reviewed site', () => {
        const unknown = sites.filter(
            (s) => !REVIEWED_INLINE_CLASS_SITES.some(([file, marker]) => s.file.endsWith(file) && marker.test(s.expr)),
        );
        expect(
            unknown.map((s) => `${s.file}:${s.line} [${s.residue}] ${s.expr.slice(0, 120)}`),
            'A class attribute built from something the scan cannot prove is our own text. Route the ' +
            'author part through safeClassToken (components/blocks/safeStyle.ts), or add the site to ' +
            'REVIEWED_INLINE_CLASS_SITES with the reason its value cannot be author text.',
        ).toEqual([]);
    });

    it('and every reviewed site still exists — a stale exemption is an exemption for nothing', () => {
        for (const [file, marker] of REVIEWED_INLINE_CLASS_SITES) {
            expect(sites.some((s) => s.file.endsWith(file) && marker.test(s.expr)), `${file} ${marker}`).toBe(true);
        }
    });

    /**
     * THE WEAKEST EXEMPTION ABOVE, TURNED INTO A DERIVATION. `blockShell.ts` returns
     * `className: cls.join(" ")`, and the reduction cannot see through an array — the reason written
     * next to that entry ("only literals and safeClassToken results are pushed") would otherwise be a
     * claim about code the gate never reads, which is exactly the shape this wave exists to remove.
     * So the ARGUMENTS of every `cls.push(...)` in that file go through the same reducer: a new
     * `cls.push(`wjs-x-${authorField}`)` fails here even though it is nowhere near a `className=`.
     */
    it('the shell builds its class list out of literals and bounded tokens only', () => {
        const file = path.join(REPO, 'frontend/src/components/blocks/blockShell.ts');
        const src = maskComments(readFileSync(file, 'utf8'));
        const at = /\bcls\s*\.\s*push\s*\(/g;
        const bad: string[] = [];
        let seen = 0;
        for (let m = at.exec(src); m !== null; m = at.exec(src)) {
            const open = src.indexOf('(', m.index);
            const end = balanced(src, open, '(', ')');
            if (end < 0) continue;
            seen++;
            const args = src.slice(open + 1, end);
            // `modifier(...)` is the shell's own safeClassToken wrapper; drop it like a builder.
            const r = residue(dropCalls(args, ['modifier']));
            if (r) bad.push(`${src.slice(0, m.index).split('\n').length}: ${args.replace(/\s+/g, ' ')} → [${r}]`);
        }
        expect(seen, 'no cls.push() found — the scan is looking at the wrong file').toBeGreaterThan(3);
        expect(
            bad,
            'blockShell pushes a class built from something other than a literal or a safeClassToken ' +
            'result. Wrap the author part in modifier() — a class name is a declaration the utility ' +
            'sheet writes, exactly like a custom property is one the theme sheet writes.',
        ).toEqual([]);
    });
});

describe('#24 CLASS — safeClassToken bounds the token, and the prefix is what makes it safe', () => {
    /** The utilities the compiled Tailwind bundle defines and an overlay is built out of. */
    const UTILITIES = ['fixed', 'absolute', 'sticky', 'inset-0', 'z-50', 'w-full', 'h-full', 'bg-white'];

    it.each(UTILITIES)('a whole-token channel cannot smuggle the utility %s', (util) => {
        // The `fa-solid ${icon}` shape: the author owns the WHOLE token. A tidy `[a-z0-9-]+` check
        // passes every one of these — the prefix is the half that does the work.
        const token = safeClassToken('fa-', util);
        expect(token === null || token.startsWith('fa-')).toBe(true);
        expect(UTILITIES).not.toContain(token);
    });

    it.each(UTILITIES.map((u) => `x ${u}`))('a modifier channel cannot append the second class %s', (payload) => {
        expect(safeClassToken('button-variant-', payload)).toBeNull();
    });

    it('the legitimate values still pass, and an already-prefixed one is not doubled', () => {
        expect(safeClassToken('button-variant-', 'primary')).toBe('button-variant-primary');
        expect(safeClassToken('card-theme-', 'dark')).toBe('card-theme-dark');
        expect(safeClassToken('fa-', 'fa-check')).toBe('fa-check');
        expect(safeClassToken('fa-', 'twitter')).toBe('fa-twitter');
        expect(safeClassToken('wjs-hover-', 'lift')).toBe('wjs-hover-lift');
    });

    it('a prefix that is not ours fails closed rather than trusting the caller', () => {
        expect(safeClassToken('', 'fixed')).toBeNull();
        expect(safeClassToken('no-trailing-hyphen', 'x')).toBeNull();
        expect(safeClassToken('fa-', { toString: () => 'fixed' })).toBeNull();
        expect(safeClassToken('fa-', 'a'.repeat(200))).toBeNull();
    });

    it('the container className channel refuses a class that leaves normal flow', () => {
        // Three well-formed tokens, and the whole viewport. Rendered through the real block below.
        expect(safeExtraClassList('fixed inset-0 z-50')).toBeUndefined();
        expect(safeExtraClassList('absolute inset-0 z-50')).toBeUndefined();
        expect(safeExtraClassList('sticky top-0')).toBeUndefined();
        // …and every class the shipped themes actually use still works.
        for (const t of ['hero-scanline', 'franja-estado', 'celda-ancha', 'glow-panel', 'hero-manchette', 'caja-articulo', 'claro', 'invitacion']) {
            expect(safeExtraClassList(t), t).toBe(t);
        }
        expect(safeExtraClassList('a b c d')).toBeUndefined();
        expect(safeExtraClassList('Hero')).toBeUndefined();
    });

    it('END TO END — the Button block cannot become a full-screen overlay', () => {
        const payload = 'x fixed inset-0 z-50 w-full h-full bg-white';
        const html = renderToStaticMarkup(
            <ButtonBlock label="Click" href="https://attacker.example/" variant={payload} />,
        );
        const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(' '));
        expect(classes.filter((c) => UTILITIES.includes(c))).toEqual([]);
        // The block still renders and the link still works: a rejected modifier drops, it does not blank.
        expect(html).toContain('wjs-block-button__link');
        expect(html).toContain('href="https://attacker.example/"');
    });

    it('END TO END — a container className cannot become one either', () => {
        const html = renderToStaticMarkup(
            <SectionBlock className="fixed inset-0 z-50" slot={() => <a href="https://attacker.example/">x</a>} />,
        );
        const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(' '));
        expect(classes.filter((c) => UTILITIES.includes(c))).toEqual([]);
        expect(html).toContain('wjs-block-section');
    });
});

describe('#24 CLASS — the narrowed grammar bounds every member, not just the reported one', () => {
    /** Hostile spellings that must never survive with their magnitude intact, for EVERY narrowed name. */
    const HOSTILE = [
        'scale(200)', 'scale(-50)', 'scaleX(9999)', 'translateY(-4000px)', 'translateX(500%)',
        '2) rotate(45deg', 'scale(1.02)) translateY(-2000px', 'matrix(200,0,0,200,0,0)',
        'perspective(1px) scale(300)', 'var(--wjs-anything)', '200', '-999', 'calc(100 * 100)',
        'scale(200);', 'url(https://evil.example/x.png)', 'scale(2) scale(2) scale(2) scale(2) scale(2)',
    ];
    /** What a narrowed value may look like AFTER normalisation: bounded magnitudes only. */
    const bounded = (out: string | number | null): boolean => {
        if (out === null) return true;
        const v = String(out);
        if (/^-?\d*\.?\d+$/.test(v)) return Math.abs(Number(v)) <= 200;
        if (v === 'none') return true;
        return v.split(' ').every((fn) => {
            const m = /^(scale|scaleX|scaleY)\((-?\d*\.?\d+)\)$/.exec(fn);
            if (m) return Number(m[2]) >= 0.5 && Number(m[2]) <= 1.5;
            const t = /^(translateX|translateY)\((-?\d*\.?\d+)(px|rem|em|%)\)$/.exec(fn);
            if (t) return Math.abs(Number(t[2])) <= (t[3] === 'rem' || t[3] === 'em' ? 8 : 100);
            return /^rotate\(-?\d*\.?\d+deg\)$/.test(fn);
        });
    };

    const cases = [...NARROWED_VAR_VALUE.keys()].flatMap((name) => HOSTILE.map((v) => [name, v] as const));
    it.each(cases)('%s = %s is dropped or clamped, on both boundaries', (name, value) => {
        const fe = feSafeCustomPropValue(name, value);
        expect(bounded(fe), `frontend kept ${JSON.stringify(fe)}`).toBe(true);
        expect(be.safeCustomPropValue(name, value)).toEqual(fe);
        // And it must be reachable the same way through the producer every block uses. A name that
        // does not decompose into `<prefix>-<key>` (`--wjs-xl` is a framework-scale token, not a
        // per-block one) has no blockVars spelling at all — which is a fact about the name, not a
        // reason to skip the two boundary assertions above.
        const parts = /^--wjs-([a-z0-9]+)-(.+)$/.exec(name);
        if (!parts) return;
        const emitted = (blockVars(parts[1], { [parts[2]]: value }) as Record<string, string>)[name] ?? null;
        expect(bounded(emitted), `blockVars kept ${String(emitted)}`).toBe(true);
    });

    it('a legitimate value still gets through — the clamp is a bound, not a ban', () => {
        expect(blockVars('pricing', { 'highlight-scale': '1.08' })).toEqual({ '--wjs-pricing-highlight-scale': '1.08' });
        expect(feSafeCustomPropValue('--wjs-card-hover-transform', 'translateY(-6px)')).toBe('translateY(-6px)');
        expect(feSafeCustomPropValue('--wjs-card-hover-transform', 'scale(1.03) rotate(2deg)')).toBe('scale(1.03) rotate(2deg)');
        expect(feSafeCustomPropValue('--wjs-card-hover-transform', 'none')).toBe('none');
        // A variable with no grammar keeps the ordinary criterion.
        expect(blockVars('text', { color: '#111' })).toEqual({ '--wjs-text-color': '#111' });
    });
});

describe('#24 CLASS — end to end through the Pricing block, the member the report found open', () => {
    const plans = [{ name: 'Pro', price: '9', period: '/mo', features: 'a\nb', buttonText: 'Buy', buttonLink: 'https://attacker.example/', highlighted: 'true' }];

    it.each(['200', '2) rotate(45deg', 'scale(200)', '1e3'])('highlightScale=%s cannot blow the plan over the page', (payload) => {
        const html = renderToStaticMarkup(<PricingTableBlock plans={plans} highlightScale={payload} />);
        const scale = /--wjs-pricing-highlight-scale:([^;"]*)/.exec(styleAttr(html).join(';'));
        // Either the value was dropped (the stylesheet's 1.02 wins) or it is a bounded number.
        expect(scale === null || Number(scale[1]) <= 1.5, `emitted ${scale?.[1]}`).toBe(true);
        expect(html).not.toContain('rotate(45deg');
        // The block still renders: a rejected value is dropped, the stylesheet's 1.02 wins.
        expect(html).toContain('href="https://attacker.example/"');
    });

    it('and the write boundary stores the same verdict the renderer would paint', () => {
        const stored = be.sanitizeMetaValue('_puck_data', {
            content: [{ type: 'PricingTable', props: { css: { '--wjs-pricing-highlight-scale': '200' } } }],
        });
        expect(stored.content[0].props.css).toEqual({});
    });

    it('a plausible scale survives end to end', () => {
        const html = renderToStaticMarkup(<PricingTableBlock plans={plans} highlightScale="1.08" />);
        expect(html).toContain('--wjs-pricing-highlight-scale:1.08');
    });
});

/**
 * THE REGRESSION THE WRITE BOUNDARY WAS CAUSING. `boxShadow: '0 2px 8px rgb(0 0 0 / .2);'` is what
 * an author types; the renderer normalised the habitual trailing `;` and the write boundary did not,
 * so the canvas showed the shadow while typing and the reload after saving showed the theme's value.
 * The journey is driven where it broke: through the function that STORES, and then out to the style
 * attribute the browser receives.
 */
describe('#24-C the habitual trailing `;` survives the WRITE boundary, not only the renderer', () => {
    it('props.css keeps a hand-typed declaration that ends in `;`', () => {
        const stored = be.sanitizeMetaValue('_puck_data', {
            content: [{ type: 'Text', props: { css: { boxShadow: '0 2px 8px rgb(0 0 0 / .2);', color: '#112233 ; ' } } }],
        });
        expect(stored.content[0].props.css).toEqual({ boxShadow: '0 2px 8px rgb(0 0 0 / .2)', color: '#112233' });
        // …and what was stored is exactly what the emission side emits.
        expect(feSafeStyleObject(stored.content[0].props.css)).toEqual(stored.content[0].props.css);
    });

    it('props.look keeps one too — it is blanked, which the render side reads as "not set"', () => {
        const look = be.sanitizeLookSpec({ shadow: '0 1px 2px #0003;', bgColor: '#ffffff;', color: 'red;position:fixed' });
        expect(look).toEqual({ shadow: '0 1px 2px #0003', bgColor: '#ffffff', color: '' });
    });

    it('an INTERIOR `;` is still a second declaration and still refused on both sides', () => {
        expect(be.safeCssValue('color', 'red;position:fixed;')).toBeNull();
        expect(feSafeCssValue('color', 'red;position:fixed;')).toBeNull();
        expect(be.safeCssValue('color', ';')).toBeNull();
    });

    it('the shadow an author saved reaches the style attribute', () => {
        const stored = be.sanitizeMetaValue('_puck_data', {
            content: [{ type: 'Text', props: { css: { boxShadow: '0 2px 8px rgb(0 0 0 / .2);' } } }],
        });
        const html = renderToStaticMarkup(<TextBlock content="hi" css={stored.content[0].props.css} />);
        expect(html).toContain('box-shadow:0 2px 8px rgb(0 0 0 / .2)');
    });
});
