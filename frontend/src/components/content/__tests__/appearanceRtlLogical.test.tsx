import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { appearanceToStyle, logicalAlign } from '@/components/blocks/blockShell';
import { HeroBlock } from '../blocks';

/**
 * FRENTE E-1 — the appearance system must emit FLOW-RELATIVE (logical) directional CSS, not
 * physical left/right, or a block cannot mirror under dir="rtl".
 *
 * The mutation each test guards: reverting a conversion back to the physical keyword
 * (text-align:left, margin-left/right:auto, justify-content:left) makes the assertion fail.
 *
 * "LTR unchanged" is proven structurally: `start`≡`left` and `end`≡`right` under dir="ltr" by the
 * CSS spec, so asserting the emitted value is exactly the logical keyword that resolves to the old
 * physical one is the same computed box in LTR — only RTL now differs.
 */

/** Parse a renderToStaticMarkup style="" attribute into a flat {prop: value} map. */
function styleAttr(html: string): Record<string, string> {
    const m = html.match(/style="([^"]*)"/);
    const out: Record<string, string> = {};
    if (!m) return out;
    for (const decl of m[1].split(';')) {
        const i = decl.indexOf(':');
        if (i <= 0) continue;
        out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
    return out;
}

describe('appearanceToStyle — directional text-align is flow-relative', () => {
    it('left → start, right → end, center/justify unchanged', () => {
        expect(appearanceToStyle({ align: 'left' }).style.textAlign).toBe('start');
        expect(appearanceToStyle({ align: 'right' }).style.textAlign).toBe('end');
        expect(appearanceToStyle({ align: 'center' }).style.textAlign).toBe('center');
        expect(appearanceToStyle({ align: 'justify' }).style.textAlign).toBe('justify');
    });

    it('never emits a physical text-align keyword', () => {
        for (const a of ['left', 'right', 'center', 'justify']) {
            const ta = appearanceToStyle({ align: a }).style.textAlign;
            expect(ta).not.toBe('left');
            expect(ta).not.toBe('right');
        }
    });

    it('logicalAlign helper maps only the two directional keywords', () => {
        expect(logicalAlign('left')).toBe('start');
        expect(logicalAlign('right')).toBe('end');
        expect(logicalAlign('center')).toBe('center');
        expect(logicalAlign('start')).toBe('start');
        expect(logicalAlign('end')).toBe('end');
    });
});

describe('appearanceToStyle — responsive align var chain is logical', () => {
    it('the --wjs-r-align chain carries start/end, never left/right', () => {
        const s = appearanceToStyle({ align: 'left', tb: { align: 'right' }, mo: { align: 'left' } }).style as any;
        // base (desktop) = left → start; tablet override = right → end; mobile = left → start
        expect(s['--wjs-r-align']).toBe('start');
        expect(s['--wjs-r-align-tb']).toBe('end');
        expect(s['--wjs-r-align-mb']).toBe('start');
        for (const k of ['--wjs-r-align', '--wjs-r-align-tb', '--wjs-r-align-mb']) {
            expect(s[k]).not.toBe('left');
            expect(s[k]).not.toBe('right');
        }
        // textAlign itself points at the var, not a literal
        expect(s.textAlign).toBe('var(--wjs-r-align)');
    });

    it('desktop with no align but a tablet override falls to the neutral "start"', () => {
        const s = appearanceToStyle({ tb: { align: 'right' } }).style as any;
        expect(s['--wjs-r-align']).toBe('start'); // dtResp neutral
        expect(s['--wjs-r-align-tb']).toBe('end');
    });
});

describe('appearanceToStyle — max-width centring uses margin-inline', () => {
    it('emits margin-inline:auto, never margin-left/right', () => {
        for (const look of [{ maxWidth: 800 }, { maxWidth: 640, tb: { maxWidth: 400 } }]) {
            const s = appearanceToStyle(look as any).style as any;
            expect(s.marginInline).toBe('auto');
            expect(s.marginLeft).toBeUndefined();
            expect(s.marginRight).toBeUndefined();
        }
    });
});

describe('HeroBlock — directional appearance is flow-relative', () => {
    const varsOf = (align?: string) =>
        styleAttr(renderToStaticMarkup(React.createElement(HeroBlock, { title: 'T', align })));

    it('align="left" → text-align:start + justify-content:flex-start (no physical left)', () => {
        const v = varsOf('left');
        expect(v['--wjs-hero-text-align']).toBe('start');
        expect(v['--wjs-hero-justify']).toBe('flex-start');
        expect(v['--wjs-hero-text-align']).not.toBe('left');
        expect(v['--wjs-hero-justify']).not.toBe('left');
    });

    it('align="right" → justify-content:flex-end (hero text-align only branches on center, so it stays start)', () => {
        const v = varsOf('right');
        // Original hero: text-align was "left" for BOTH left and right; only justify-content moved
        // the block. Preserved: non-center → start (= left under LTR), block pushed to flow-end.
        expect(v['--wjs-hero-text-align']).toBe('start');
        expect(v['--wjs-hero-justify']).toBe('flex-end');
        expect(v['--wjs-hero-justify']).not.toBe('right');
    });

    it('align="center" stays center on both axes', () => {
        const v = varsOf('center');
        expect(v['--wjs-hero-text-align']).toBe('center');
        expect(v['--wjs-hero-justify']).toBe('center');
    });

    it('no align → no --wjs-hero-justify emitted (ui.css "center" fallback preserved for legacy pages)', () => {
        const v = varsOf(undefined);
        expect('--wjs-hero-justify' in v).toBe(false);
        // text-align still defaults to the flow-relative start (matching the old "left" under LTR)
        expect(v['--wjs-hero-text-align']).toBe('start');
    });
});
