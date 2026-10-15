import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { FormBlockRender, formBlockDefaults } from '@/components/blocks/FormBlock';
import { ColumnsBlock, PostsGridBlock } from '../blocks';
import { SHADOWS, appearanceToStyle } from '@/components/blocks/blockShell';

/**
 * WAVE 2 — the three inline-style locks, proven OPEN at the artifact level.
 *
 * Each test renders the SHIPPED component and reads the SHIPPED stylesheet
 * (backend/public/css/wordjs-ui.css), then resolves the cascade the way a browser would:
 * inline declaration wins if present, otherwise the stylesheet's var() chain with the probe
 * theme's tokens substituted. Re-locking any of the inline styles (put the literal
 * display/gap/background-image/box-shadow back) makes the corresponding assertion fail —
 * that is the mutation these tests exist to catch.
 */

const UI_CSS = path.resolve(__dirname, '../../../../../backend/public/css/wordjs-ui.css');
const css = fs.readFileSync(UI_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');

/** Top-level rule lookup: returns the declaration block of the rule whose prelude is exactly `selector`. */
function findRule(selector: string): string {
    let depth = 0;
    let prelude = '';
    let body = '';
    let inBody = false;
    let found: string | null = null;
    for (let i = 0; i < css.length; i++) {
        const ch = css[i];
        if (ch === '{') {
            depth++;
            if (depth === 1) { inBody = true; body = ''; continue; }
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                inBody = false;
                const sels = prelude.trim().split(',').map((s) => s.replace(/\s+/g, ' ').trim());
                if (sels.includes(selector)) found = (found || '') + body; // last rule wins, but keep all
                prelude = '';
                continue;
            }
        }
        if (inBody) body += ch;
        else if (depth === 0) prelude += ch;
    }
    expect(found, `ui.css must have a top-level rule for ${selector}`).toBeTruthy();
    return found!;
}

/** Last declaration of `prop` (exact property, so 'background' never matches 'background-image'). */
function lastDecl(block: string, prop: string): string | null {
    let out: string | null = null;
    // split on ';' is safe for the properties under test (no data URIs in these rules)
    for (const d of block.split(';')) {
        const colon = d.indexOf(':');
        if (colon <= 0) continue;
        if (d.slice(0, colon).trim() === prop) out = d.slice(colon + 1).replace(/\s+/g, ' ').trim();
    }
    return out;
}

/** Browser-faithful var() substitution: theme value, else the (recursively resolved) fallback. */
function resolveVars(value: string, theme: Record<string, string>): string {
    const idx = value.indexOf('var(');
    if (idx === -1) return value;
    if (idx > 0 && /[A-Za-z0-9_-]/.test(value[idx - 1])) {
        return value.slice(0, idx + 4) + resolveVars(value.slice(idx + 4), theme);
    }
    let depth = 1;
    let comma = -1;
    let j = idx + 4;
    for (; j < value.length && depth > 0; j++) {
        const c = value[j];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 1 && comma === -1) comma = j;
    }
    const name = value.slice(idx + 4, comma === -1 ? j - 1 : comma).trim();
    const fallback = comma === -1 ? null : value.slice(comma + 1, j - 1).trim();
    const resolved = theme[name] ?? (fallback !== null ? resolveVars(fallback, theme) : `var(${name})`);
    return value.slice(0, idx) + resolved + resolveVars(value.slice(j), theme);
}

/** Inline style of a rendered open tag, as a prop→value map ({} when there is no style attribute). */
function inlineStyle(tag: string): Record<string, string> {
    const m = tag.match(/style="([^"]*)"/);
    const out: Record<string, string> = {};
    if (!m) return out;
    for (const d of m[1].split(';')) {
        const colon = d.indexOf(':');
        if (colon > 0) out[d.slice(0, colon).trim()] = d.slice(colon + 1).trim();
    }
    return out;
}

describe('FormBlock — --wjs-form-gap / --wjs-form-field-gap are live', () => {
    const props = {
        ...formBlockDefaults,
        fields: [
            ...formBlockDefaults.fields,
            { type: 'checkbox' as const, label: 'Acepto', required: false, options: '', placeholder: '' },
        ],
    };
    const html = renderToStaticMarkup(<FormBlockRender {...props} />);
    const formTag = html.match(/<form\b[^>]*>/)![0];
    const fieldTags = html.match(/<div[^>]*class="wjs-form-field[^"]*"[^>]*>/g)!;

    it('the form carries NO inline display/gap — the stylesheet owns structure', () => {
        expect(formTag).toContain('class="wjs-form"');
        // The whole point of the unlock: nothing inline may shadow ui.css on this element.
        expect(formTag).not.toMatch(/style=/);
    });

    it('every field (incl. the checkbox row) carries NO inline display/gap', () => {
        expect(fieldTags.length).toBe(props.fields.length);
        for (const tag of fieldTags) expect(tag).not.toMatch(/style=/);
        // …and the honeypot keeps its functional hiding (it is not a themable surface).
        expect(html.match(/<div[^>]*class="wjs-form-hp"[^>]*>/)![0]).toMatch(/style=/);
    });

    it('a probe theme declaring the tokens CHANGES the computed gaps', () => {
        const form = findRule('.wjs-form');
        expect(lastDecl(form, 'display')).toBe('grid'); // structure moved to CSS, not lost
        const gap = lastDecl(form, 'gap')!;
        expect(gap).toMatch(/var\(--wjs-form-gap/);

        // Cascade as the browser resolves it: inline wins when present, else stylesheet var().
        const effective = (theme: Record<string, string>) =>
            inlineStyle(formTag)['gap'] ?? resolveVars(gap, theme);
        expect(effective({})).toBe('14px'); // ui.css base
        expect(effective({ '--wjs-form-gap': '42px' })).toBe('42px'); // token is ALIVE

        const field = findRule('.wjs-form-field');
        expect(lastDecl(field, 'display')).toBe('grid');
        const fieldGap = lastDecl(field, 'gap')!;
        expect(fieldGap).toMatch(/var\(--wjs-form-field-gap/);
        const effField = (theme: Record<string, string>) =>
            inlineStyle(fieldTags[0])['gap'] ?? resolveVars(fieldGap, theme);
        expect(effField({})).toBe('6px');
        expect(effField({ '--wjs-form-field-gap': '9px' })).toBe('9px');

        // Checkbox rows read the SAME token through their flex rule.
        const cb = findRule('.wjs-form-field--checkbox');
        expect(lastDecl(cb, 'display')).toBe('flex');
        expect(lastDecl(cb, 'gap')).toMatch(/var\(--wjs-form-field-gap/);
    });
});

describe('PostsGrid thumbnail — image travels as --wjs-posts-thumb-image', () => {
    const posts = [
        { id: 1, title: 'A', href: '/a', image: 'https://cdn.example/a.jpg' },
        { id: 2, title: 'B', href: '/b' },
    ];
    const html = renderToStaticMarkup(<PostsGridBlock posts={posts} />);
    const thumbs = html.match(/<div[^>]*wp-block-posts-grid__thumb[^>]*>/g)!;

    it('emits the custom property, never a literal inline background-image', () => {
        expect(thumbs.length).toBe(2);
        // QUOTED on purpose: the URL now goes through blockVars/safeCssUrl instead of being
        // interpolated bare, so a stored value carrying `);…` cannot close the url() and append
        // declarations of its own. renderToStaticMarkup escapes the quotes into &quot;.
        expect(thumbs[0]).toMatch(/--wjs-posts-thumb-image:\s*url\(&quot;https:\/\/cdn\.example\/a\.jpg&quot;\)/);
        expect(thumbs[0]).not.toMatch(/background-image/); // the re-lock mutation
        expect(thumbs[1]).not.toMatch(/style=/); // no image → nothing inline at all
    });

    it("ui.css consumes it layered, pixel-identical to yesterday's render", () => {
        const rule = findRule('.wp-block-posts-grid__thumb');
        // The whole-surface hook survives as a shorthand…
        expect(lastDecl(rule, 'background')).toMatch(/var\(--wjs-posts-thumb-bg/);
        const bgi = lastDecl(rule, 'background-image')!;
        expect(bgi).toMatch(/var\(--wjs-posts-thumb-scrim,\s*none\)/);
        expect(bgi).toMatch(/var\(--wjs-posts-thumb-image/);

        // With a post image and NO theme: `none, url(...)` — paints exactly like the old inline url.
        const img = inlineStyle(thumbs[0])['--wjs-posts-thumb-image'];
        expect(resolveVars(bgi, { '--wjs-posts-thumb-image': img })).toBe(`none, ${img}`);

        // Without an image and NO theme: the same placeholder gradient as before the bridge.
        const noImage = resolveVars(bgi, {});
        expect(noImage).toContain('linear-gradient(135deg');
        expect(noImage.startsWith('none,')).toBe(true);
    });

    it("a theme's scrim composites ABOVE the content photo", () => {
        const bgi = lastDecl(findRule('.wp-block-posts-grid__thumb'), 'background-image')!;
        const scrim = 'linear-gradient(rgb(0 0 0 / .4), rgb(0 0 0 / .4))';
        const resolved = resolveVars(bgi, {
            '--wjs-posts-thumb-scrim': scrim,
            '--wjs-posts-thumb-image': 'url(a.jpg)',
        });
        // First background-image layer paints on top: scrim before photo, photo still present.
        expect(resolved.indexOf(scrim)).toBeGreaterThanOrEqual(0);
        expect(resolved.indexOf(scrim)).toBeLessThan(resolved.indexOf('url(a.jpg)'));
    });
});

describe('Appearance shadow presets — routed through the elevation tokens', () => {
    // The pre-WAVE literals, verbatim. They MUST survive as the var() fallback (contexts
    // without ui.css keep rendering byte-identically) — and re-locking the preset to the bare
    // literal fails the toBe below.
    const LEGACY: Record<string, string> = {
        sm: '0 1px 2px rgb(0 0 0 / .06), 0 1px 3px rgb(0 0 0 / .10)',
        md: '0 4px 6px -1px rgb(0 0 0 / .10), 0 2px 4px -2px rgb(0 0 0 / .10)',
        lg: '0 10px 15px -3px rgb(0 0 0 / .10), 0 4px 6px -4px rgb(0 0 0 / .10)',
    };

    it('sm/md/lg read --wjs-shadow-sm/md/lg with the legacy literal as fallback', () => {
        for (const k of ['sm', 'md', 'lg'] as const) {
            expect(SHADOWS[k]).toBe(`var(--wjs-shadow-${k}, ${LEGACY[k]})`);
            expect(appearanceToStyle({ shadow: k }).style.boxShadow).toBe(SHADOWS[k]);
            // The token the preset reads actually EXISTS in the framework's :root.
            expect(css).toMatch(new RegExp(`--wjs-shadow-${k}\\s*:`));
            // A theme's elevation token now changes the preset's computed shadow.
            expect(resolveVars(SHADOWS[k], { [`--wjs-shadow-${k}`]: '0 0 0 1px lime' })).toBe('0 0 0 1px lime');
            expect(resolveVars(SHADOWS[k], {})).toBe(LEGACY[k]);
        }
    });

    it('presets without a token family stay literal; custom stays the author value', () => {
        for (const k of ['xl', '2xl', 'soft', 'inner']) expect(SHADOWS[k]).not.toContain('var(');
        const custom = appearanceToStyle({
            shadow: 'custom', shadowX: 1, shadowY: 2, shadowBlur: 3, shadowSpread: 4, shadowColor: 'red',
        }).style.boxShadow;
        expect(custom).toBe('1px 2px 3px 4px red');
    });
});

describe('Columns — the track list leaves room for the gap', () => {
    // The shipped component's inline variables, cascaded through the shipped `.wjs-block-columns`
    // rule, then laid out the way a browser sizes a grid of definite width. The defect was
    // `54% 46%`: a percentage track takes its share of the WHOLE container, so the gap came on top
    // and the last column ended `gap` past the block's edge (measured on a 1440px page: a column
    // ending at x=1456). Put `${w}%` back in ColumnsBlock and the overflow assertions fail.
    const rule = findRule('.wjs-block-columns');
    const ROOT = { '--wjs-lg': /--wjs-lg:\s*([^;]+);/.exec(css)![1].trim() };
    const PAGE = 1440;

    const rootTag = (props: Record<string, unknown>) =>
        renderToStaticMarkup(<ColumnsBlock slots={[]} {...props} />).match(/^<div\b[^>]*>/)![0];

    /** The resolved `grid-template-columns` and `gap` (in px) of one rendered Columns block. */
    function resolved(props: Record<string, unknown>): { template: string; gap: number } {
        const vars = { ...ROOT, ...inlineStyle(rootTag(props)) };
        const gap = resolveVars(lastDecl(rule, 'gap')!, vars);
        expect(gap, 'the gap must resolve to a px length').toMatch(/^\d+(?:\.\d+)?px$/);
        return { template: resolveVars(lastDecl(rule, 'grid-template-columns')!, vars), gap: parseFloat(gap) };
    }

    /**
     * Column track sizing (CSS Grid "Find the Size of an fr") for a definite container and the two
     * track shapes this block has emitted: `<n>%` and `minmax(0, <n>fr)`. Gaps are fixed; a flex
     * factor sum below 1 is divided by 1, which is what leaves a row of widths short of 100 short.
     */
    function layOut(template: string, width: number, gap: number): number[] {
        const tracks = template.trim().split(/\s+(?![^(]*\))/);
        const pct = (t: string) => /^([\d.]+)%$/.exec(t);
        const fr = (t: string) => /^minmax\(0,\s*([\d.e-]+)fr\)$/.exec(t);
        for (const t of tracks) expect(pct(t) || fr(t), `unexpected track "${t}"`).toBeTruthy();
        const percentOf = (t: string) => (width * Number(pct(t)![1])) / 100;
        const fixed = tracks.reduce((s, t) => s + (pct(t) ? percentOf(t) : 0), 0);
        const flexSum = tracks.reduce((s, t) => s + (fr(t) ? Number(fr(t)![1]) : 0), 0);
        const frSize = Math.max(0, width - gap * (tracks.length - 1) - fixed) / Math.max(1, flexSum);
        return tracks.map((t) => (pct(t) ? percentOf(t) : frSize * Number(fr(t)![1])));
    }
    const rightEdge = (tracks: number[], gap: number) =>
        tracks.reduce((a, b) => a + b, 0) + gap * (tracks.length - 1);

    it('the model sees the defect: percentage tracks plus a gap overflow', () => {
        // Guards the sizer itself, so the assertions below cannot pass by measuring nothing.
        expect(rightEdge(layOut('42% 58%', PAGE, 64), 64)).toBeCloseTo(PAGE + 64, 6);
    });

    it('emits proportional flex tracks, not percentages', () => {
        const { template } = resolved({ distribution: { columnCount: 2, widths: [54, 46] } });
        expect(template).toBe('minmax(0, 0.54fr) minmax(0, 0.46fr)');
        expect(template).not.toContain('%');
    });

    it('the last column ends inside the block, in the proportions the author picked', () => {
        const cases: { distribution: { columnCount: number; widths: number[] }; gap?: number }[] = [
            { distribution: { columnCount: 2, widths: [42, 58] }, gap: 64 }, // the measured page
            { distribution: { columnCount: 2, widths: [50, 50] } }, // no gap set: --wjs-lg
            { distribution: { columnCount: 3, widths: [35, 30, 35] }, gap: 40 },
            { distribution: { columnCount: 3, widths: [100 / 3, 100 / 3, 100 / 3] }, gap: 24 }, // TemplateRenderer
            { distribution: { columnCount: 4, widths: [25, 25, 25, 25] }, gap: 32 },
        ];
        for (const props of cases) {
            const { template, gap } = resolved(props);
            expect(gap).toBeGreaterThan(0);
            const tracks = layOut(template, PAGE, gap);
            expect(tracks).toHaveLength(props.distribution.columnCount);
            expect(rightEdge(tracks, gap)).toBeLessThanOrEqual(PAGE + 1e-6);
            const { widths } = props.distribution;
            tracks.forEach((t, i) => expect(t / tracks[0]).toBeCloseTo(widths[i] / widths[0], 9));
        }
    });

    it('renders the same pixels as before wherever nothing overflowed', () => {
        // Gap 0 was the one setting that never overflowed. [40, 40] pins the `/ 100`: as `40fr`
        // the pair would stretch to fill the row instead of leaving a fifth of it empty.
        for (const widths of [[50, 50], [42, 58], [35, 30, 35], [40, 40]]) {
            const { template, gap } = resolved({ distribution: { columnCount: widths.length, widths }, gap: 0 });
            expect(gap).toBe(0);
            const before = layOut(widths.map((w) => `${w}%`).join(' '), PAGE, 0);
            layOut(template, PAGE, 0).forEach((t, i) => expect(t).toBeCloseTo(before[i], 9));
        }
    });

    it('still stacks to one column under 768px', () => {
        // The mobile rule overrides the DECLARATION, after the base rule, and the block only ever
        // sets the variable inline — so on small screens the stylesheet keeps the last word.
        const base = css.indexOf('.wjs-block-columns, .wp-block-columns {');
        const mobile = css.search(
            /@media \(max-width: 767\.98px\) \{\s*\.wjs-block-columns, \.wp-block-columns \{\s*grid-template-columns: 1fr;\s*\}\s*\}/,
        );
        expect(base).toBeGreaterThanOrEqual(0);
        expect(mobile).toBeGreaterThan(base);
        const inline = inlineStyle(rootTag({ distribution: { columnCount: 2, widths: [54, 46] }, gap: 64 }));
        expect(inline['--wjs-columns-template']).toBeDefined();
        expect(inline['grid-template-columns']).toBeUndefined();
    });
});
