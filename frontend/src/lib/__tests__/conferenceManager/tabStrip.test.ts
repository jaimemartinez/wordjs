/**
 * conference-manager: the conference tab strip says when it has more tabs (live review: «Campo» cut at
 * the right edge on an iPhone SE, «…es» on a 1280 px desktop, with nothing saying the strip scrolls).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TAB_STRIP_CSS, stripOverflow } from '../../../../../marketplace/plugins/conference-manager/client/lib/phoneLayout';
import { stripMoreAttrs } from '../../../../../marketplace/plugins/conference-manager/client/lib/useStripOverflow';

const CM = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client');
const PAGE = fs.readFileSync(path.join(CM, 'admin/page.tsx'), 'utf8');
const MEALS = fs.readFileSync(path.join(CM, 'admin/MealsPage.tsx'), 'utf8');
const HOOK = fs.readFileSync(path.join(CM, 'lib/useStripOverflow.ts'), 'utf8');

describe('stripOverflow', () => {
    it('no overflow: nothing hidden on either side', () => {
        expect(stripOverflow({ scrollLeft: 0, scrollWidth: 800, clientWidth: 800 })).toEqual({ left: false, right: false });
        expect(stripOverflow({ scrollLeft: 0, scrollWidth: 801, clientWidth: 800 })).toEqual({ left: false, right: false });
    });
    it('at the start, in the middle and at the end of a scrolling strip', () => {
        expect(stripOverflow({ scrollLeft: 0, scrollWidth: 1400, clientWidth: 343 })).toEqual({ left: false, right: true });
        expect(stripOverflow({ scrollLeft: 400, scrollWidth: 1400, clientWidth: 343 })).toEqual({ left: true, right: true });
        expect(stripOverflow({ scrollLeft: 1057, scrollWidth: 1400, clientWidth: 343 })).toEqual({ left: true, right: false });
    });
});

describe('the strip fades out on the side that has more tabs, at every width', () => {
    it('one mask rule per side and one for both, outside any media query', () => {
        expect(TAB_STRIP_CSS).not.toContain('@media');
        const SEL = ':is([data-cm-shell-tabs], [data-cm-scroll-strip])';
        const rule = (attrs: string) => /linear-gradient\(([^,]+),/.exec(TAB_STRIP_CSS.split(/\r?\n/).find((l) => l.startsWith(`${SEL}${attrs} {`)) || '')?.[1];
        expect(rule('[data-more-right]')).toBe('to right');
        expect(rule('[data-more-left]')).toBe('to left');
        expect(rule('[data-more-left][data-more-right]')).toBe('to right');
        expect(TAB_STRIP_CSS).toMatch(/\[data-more-left\]\[data-more-right\] \{[^}]*linear-gradient\(to right, transparent/);
        expect(TAB_STRIP_CSS).toMatch(/-webkit-mask-image/); // Safari
    });
    it('the conference strip and the «Alimentación» sub-tabs render the rules and carry the attributes', () => {
        expect(PAGE).toContain('<style>{TAB_STRIP_CSS}</style>');
        expect(PAGE).toMatch(/const stripMore = useStripOverflow\(tabStripRef, /);
        expect(PAGE).toMatch(/data-cm-shell-tabs=""\s*\{\.\.\.stripMoreAttrs\(stripMore\)\}>/);
        expect(MEALS).toContain('<style>{TAB_STRIP_CSS}</style>');
        expect(MEALS).toMatch(/const subTabsMore = useStripOverflow\(subTabsRef, \[!!data/);
        expect(MEALS).toContain('data-cm-scroll-strip="" {...stripMoreAttrs(subTabsMore)}>');
    });
    it('the hook measures with stripOverflow on scroll and resize, and the attributes are what the CSS keys on', () => {
        expect(HOOK).toMatch(/const next = stripOverflow\(strip\);/);
        expect(HOOK).toMatch(/strip\.addEventListener\("scroll", measure/);
        expect(HOOK).toMatch(/new ResizeObserver\(measure\)/);
        expect(stripMoreAttrs({ left: true, right: false })).toEqual({ 'data-more-left': '', 'data-more-right': undefined });
    });
});
