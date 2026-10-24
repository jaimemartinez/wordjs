/**
 * conference-manager: the conference tab strip says when it has more tabs (live review: «Campo» cut at
 * the right edge on an iPhone SE, «…es» on a 1280 px desktop, with nothing saying the strip scrolls).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TAB_STRIP_CSS, stripOverflow } from '../../../../../marketplace/plugins/conference-manager/client/lib/phoneLayout';
import { stripMoreAttrs } from '../../../../../marketplace/plugins/conference-manager/client/lib/useStripOverflow';
import { sectionItems, SECTION_GROUPS } from '../../../../../marketplace/plugins/conference-manager/client/admin/SectionPicker';
import { pruneSelection } from '../../../../../marketplace/plugins/conference-manager/client/lib/feePayments';
import { pruneSelection as portalPrune } from '../../../../../marketplace/plugins/conference-manager/client/portal/participants';

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
    it('the «Alimentación» sub-tabs render the rules and carry the attributes (2.36.6: the sections are a menu, no strip)', () => {
        expect(PAGE).not.toContain('TAB_STRIP_CSS');
        expect(PAGE).not.toMatch(/useStripOverflow|useRevealActive|tabStripRef/);
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

describe('2.36.6 the sections are one menu («no es responsive, no es user friendly»)', () => {
    const tx = (_k: string, fallback: string) => fallback;
    const ALL = ['dashboard', 'inscriptions', 'fees', 'accounting', 'consent', 'lodging', 'transport', 'meals', 'badges', 'locations', 'assignment', 'fields', 'pricing', 'reports', 'staff']
        .map(view => ({ view, name: view, icon: 'fa-x' }));
    it('every section once, grouped Personas · Dinero · Logística · Configuración, in that order', () => {
        const items = sectionItems(ALL, tx);
        expect(items.map(i => i.value).sort()).toEqual(ALL.map(t => t.view).sort());
        expect([...new Set(items.map(i => i.group))]).toEqual(['Personas', 'Dinero', 'Logística', 'Configuración']);
        expect(items.slice(0, 2).map(i => i.value)).toEqual(['dashboard', 'inscriptions']);
        expect(SECTION_GROUPS.flatMap(g => g[2]).length).toBe(15);
    });
    it('only what the role may open; a section the groups do not name still shows (under Configuración)', () => {
        const items = sectionItems(ALL.filter(t => ['meals', 'inscriptions'].includes(t.view)).concat({ view: 'future', name: 'Nueva', icon: 'fa-x' }), tx);
        expect(items.map(i => [i.value, i.group])).toEqual([['inscriptions', 'Personas'], ['meals', 'Logística'], ['future', 'Configuración']]);
    });
    it('the page draws the picker — a button that names the section and opens the searchable list — not the row of tabs', () => {
        expect(PAGE).toContain('<SectionPicker tabs={tabs} current={shown} onPick={(v) => setView(v as View)} tx={tx} lang={language} />');
        const picker = fs.readFileSync(path.join(CM, 'admin/SectionPicker.tsx'), 'utf8');
        expect(picker).toContain('aria-haspopup="listbox" aria-expanded={open}');
        expect(picker).toContain('<SelectPanel anchor={button} items={items} value={current} searchable');
        expect(picker).toContain("w-full sm:w-auto sm:min-w-[20rem]");
    });
});

describe('2.36.6 «Pagos de cuotas» no longer loops while it loads (Maximum update depth exceeded)', () => {
    it('pruneSelection returns the same array when nothing goes (a state set to it does not re-render)', () => {
        const sel = [1, 2, 3];
        expect(pruneSelection(sel, new Set([1, 2, 3, 4]))).toBe(sel);
        expect(pruneSelection(sel, new Set([1, 3]))).toEqual([1, 3]);
        expect(portalPrune(sel, [1, 2, 3])).toBe(sel);
        expect(portalPrune(sel, [2])).toEqual([2]);
    });
    it('one empty list while the view loads (not a new [] every render)', () => {
        const src = fs.readFileSync(path.join(CM, 'admin/FeePaymentsPage.tsx'), 'utf8');
        expect(src).toContain('const NO_ROWS: any[] = [];');
        expect(src).toContain('const people = view?.people || NO_ROWS;');
        expect(src).toContain('const transfers = view?.transfers || NO_ROWS;');
        expect(src).not.toMatch(/const (people|transfers) = view\?\.\w+ \|\| \[\];/);
    });
});
