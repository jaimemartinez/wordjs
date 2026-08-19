import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { FormBlockRender, formBlockDefaults } from '@/components/blocks/FormBlock';
import { PostsGridBlock } from '../blocks';
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
