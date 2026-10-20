/**
 * conference-manager 2.16.0 — the admin screens on a phone, and the conference list's contrast and card
 * footer (findings of a live review at iPhone 13 size and on a 1280 px desktop).
 *
 * Pinned here (node environment: server-rendered markup, the CSS strings the components carry, and the
 * sources' class lists, which ARE the layout for a Tailwind UI):
 *   - the conference shell (title, tab strip, white panel) is a fixed-height panel that scrolls inside
 *     the page on a desktop; on a phone (below 768 px wide or 600 px high) the rules it renders give it
 *     back its natural height — every property that made the panel a box is neutralised — so the screen
 *     scrolls with the page, and nothing applies outside that media query (the desktop is unchanged);
 *   - the tab strip brings the active tab into view (revealDelta), scrolling only the strip;
 *   - «Comenzar nuevo evento», «Estadísticas» and the list's descriptions meet WCAG AA (4.5:1), computed
 *     from Tailwind's own colour values; the card footer wraps instead of running the button into the label;
 *   - the «Campos» intro does not say where the preview is (beside on a desktop, below on a phone);
 *   - publishing an empty form is refused next to the button, not with a toast that stayed over the
 *     «Nuevo campo» dialog; opening that dialog dismisses the notice;
 *   - a field card wraps its actions under the label on a phone instead of stacking four buttons;
 *   - the role editor's sections × levels table fits a phone (no sideways scroll hiding «Ver» and
 *     «Gestionar»), each level captioned there.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('react-dom', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-dom')>();
    return { ...actual, createPortal: (node: React.ReactNode) => node };
});

import { I18nProvider } from '@/contexts/I18nContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { PERM_MATRIX_CSS, PERM_MATRIX_STICKY_TOP, PERM_MATRIX_TABLE_MIN_WIDTH, SHELL_CSS, SHELL_PANEL_MIN_HEIGHT, SHELL_PANEL_MIN_WIDTH, STRIP_FADE_PX, TAB_STRIP_CSS, revealDelta, stripFade } from '../../../../../marketplace/plugins/conference-manager/client/lib/phoneLayout';
import { publishRefusal } from '../../../../../marketplace/plugins/conference-manager/client/lib/fields';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';
import { RoleEditor } from '../../../../../marketplace/plugins/conference-manager/client/admin/StaffPage';

const PLUGIN = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager');
const read = (rel: string) => fs.readFileSync(path.join(PLUGIN, rel), 'utf8');
const PAGE = read('client/admin/page.tsx');
const STAFF = read('client/admin/StaffPage.tsx');
const MEALS = read('client/admin/MealsPage.tsx');
const STRIP_HOOK = read('client/lib/useStripOverflow.ts');

/** The source text of `function name(` up to the next top-level function. */
function fnSource(src: string, name: string): string {
    const start = src.search(new RegExp(`\\nfunction ${name}\\(`));
    expect(start, `function ${name} not found`).toBeGreaterThan(-1);
    const next = src.slice(start + 1).search(/\n(?:export default )?function \w+\(/);
    return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}
/** The class list of the JSX element carrying `attr` (its opening tag must be on one line). */
function classesOf(src: string, attr: string): string[] {
    const line = src.split('\n').find((l) => l.includes(attr) && /className=/.test(l));
    expect(line, `no element with ${attr}`).toBeTruthy();
    const m = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(line!);
    return (m?.[1] ?? m?.[2] ?? '').split(/\s+/).filter(Boolean);
}

type Rule = { media: string; selector: string; decl: Record<string, string> };
/** Flat rules of a CSS string, each with the @media it sits in ('' at top level). */
function rulesOf(css: string): Rule[] {
    const out: Rule[] = [];
    const walk = (text: string, media: string) => {
        let i = 0;
        while (i < text.length) {
            const open = text.indexOf('{', i);
            if (open === -1) break;
            const head = text.slice(i, open).trim();
            let depth = 1, j = open + 1;
            for (; j < text.length && depth; j++) depth += text[j] === '{' ? 1 : text[j] === '}' ? -1 : 0;
            const body = text.slice(open + 1, j - 1);
            if (head.startsWith('@media')) walk(body, head);
            else {
                const decl: Record<string, string> = {};
                for (const d of body.split(';')) {
                    const k = d.indexOf(':');
                    if (k > 0) decl[d.slice(0, k).trim()] = d.slice(k + 1).trim();
                }
                for (const sel of head.split(/,(?![^(]*\))/)) out.push({ media, selector: sel.trim(), decl });
            }
            i = j;
        }
    };
    walk(css, '');
    return out;
}

// ── WCAG contrast from Tailwind's own palette (oklch in tailwindcss/theme.css) ───────────────────────
const THEME = fs.readFileSync(path.resolve(__dirname, '../../../../node_modules/tailwindcss/theme.css'), 'utf8');
type Lab = [number, number, number];
function oklab(name: string): Lab {
    if (name === 'white') return [1, 0, 0];
    const m = new RegExp(String.raw`--color-${name}:\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)`).exec(THEME);
    expect(m, `colour ${name}`).toBeTruthy();
    const L = Number(m![1]) / 100, C = Number(m![2]), h = (Number(m![3]) * Math.PI) / 180;
    return [L, C * Math.cos(h), C * Math.sin(h)];
}
function luminance([L, a, b]: Lab): number {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const clamp = (x: number) => Math.min(1, Math.max(0, x));
    const r = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
    const g = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
    const bl = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}
const contrast = (fg: Lab, bg: Lab) => { const x = luminance(fg), y = luminance(bg); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mixLab = (a: Lab, b: Lab, t: number): Lab => [0, 1, 2].map((i) => a[i] * (1 - t) + b[i] * t) as Lab;
const textColour = (classes: string[]) => {
    const c = classes.filter((k) => /^text-(white|[a-z]+-\d{2,3})$/.test(k));
    expect(c, `one text colour in ${classes.join(' ')}`).toHaveLength(1);
    return c[0].slice('text-'.length);
};

describe('the conference shell on a phone (lib/phoneLayout.ts SHELL_CSS)', () => {
    const rules = rulesOf(SHELL_CSS);
    const phone = rules.filter((r) => r.media.includes(`max-width: ${SHELL_PANEL_MIN_WIDTH - 0.02}px`) && r.media.includes(`max-height: ${SHELL_PANEL_MIN_HEIGHT - 0.02}px`));
    // Which CSS property each fixed-panel utility sets.
    const PROPERTY: Record<string, string> = { 'h-full': 'height', 'overflow-hidden': 'overflow', 'overflow-auto': 'overflow', 'flex-1': 'flex' };

    it('below 768 px wide or 600 px high, every property that made the panel a fixed box is neutralised', () => {
        expect(SHELL_PANEL_MIN_WIDTH).toBe(768);   // where the admin swaps its sidebar for the phone header
        for (const attr of ['data-cm-shell=""', 'data-cm-shell-body=""', 'data-cm-shell-panel=""']) {
            const sel = `[${attr.split('=')[0]}]`;
            const decl = Object.assign({}, ...phone.filter((r) => r.selector === sel).map((r) => r.decl));
            const boxing = classesOf(fnSource(PAGE, 'ConferenceManagerContent'), attr).filter((c) => c in PROPERTY);
            expect(boxing.length, `${attr} carries the panel classes`).toBeGreaterThan(0);
            for (const c of boxing) {
                const prop = PROPERTY[c];
                expect(decl[prop], `${sel} overrides ${c} (${prop})`).toBeDefined();
                if (prop === 'height') expect(decl[prop]).toBe('auto');
                if (prop === 'overflow') expect(decl[prop]).toBe('visible');
                if (prop === 'flex') expect(decl[prop]).toBe('none');
            }
        }
    });
    it('nothing applies outside the phone media queries, and the rules are unlayered', () => {
        expect(rules.filter((r) => !r.media)).toEqual([]);
        expect(SHELL_CSS).not.toContain('@layer');
        // Compacted paddings only below 640 px.
        for (const r of rules.filter((x) => 'padding' in x.decl || 'padding-left' in x.decl)) expect(r.media).toContain('max-width: 639.98px');
    });
    it('the shell renders the rules and tags the elements they target', () => {
        const src = fnSource(PAGE, 'ConferenceManagerContent');
        expect(src).toMatch(/data-cm-shell="">\s*<style>\{SHELL_CSS\}<\/style>/);
        for (const a of ['data-cm-shell-head=""', 'data-cm-shell-tabs=""', 'data-cm-shell-body=""', 'data-cm-shell-panel=""']) expect(src).toContain(a);
    });
});

describe('the tab strip reveals the active tab (revealDelta)', () => {
    const strip = { left: 16, right: 368 };
    it('0 when the tab is fully visible', () => {
        expect(revealDelta(strip, { left: 16, right: 120 })).toBe(0);
        expect(revealDelta(strip, { left: 200, right: 368 })).toBe(0);
    });
    it('centres a tab that is off to either side or cut at an edge', () => {
        expect(revealDelta(strip, { left: 700, right: 806 })).toBe(561);   // (753) − (192)
        expect(revealDelta(strip, { left: -300, right: -194 })).toBe(-439);
        expect(revealDelta(strip, { left: 330, right: 436 })).toBe(191);
    });
    // Round 2, iPhone SE: «Campos» tapped at the strip's right edge was "in view" — but under the 48 px
    // fade, its label and underline faded out (gapRight 0, data-more-right).
    it('a tab under an edge fade is not "in view": it is centred', () => {
        const fade = stripFade({ left: false, right: true });
        expect(fade).toEqual({ left: 0, right: STRIP_FADE_PX });
        const underFade = { left: 262, right: 368 };   // flush with the right edge, under the fade
        expect(revealDelta(strip, underFade)).toBe(0);  // without the fade: "in view"
        expect(revealDelta(strip, underFade, fade)).toBe(123);   // (315) − (192)
        expect(revealDelta(strip, { left: 20, right: 120 }, stripFade({ left: true, right: true }))).toBeLessThan(0);
        // Clear of the fade: left alone.
        expect(revealDelta(strip, { left: 120, right: 260 }, stripFade({ left: true, right: true }))).toBe(0);
        // No fade on a side with no more tabs: the first and last tabs are not pushed.
        expect(revealDelta(strip, { left: 16, right: 120 }, stripFade({ left: false, right: true }))).toBe(0);
        expect(revealDelta(strip, { left: 262, right: 368 }, stripFade({ left: true, right: false }))).toBe(0);
        // The fade the CSS draws is that width.
        expect(TAB_STRIP_CSS).toContain(`#000 calc(100% - ${STRIP_FADE_PX}px)`);
    });
    it('the strip is the one scrolled, by the active tab (aria-current), clear of its fade', () => {
        const src = fnSource(PAGE, 'ConferenceManagerContent');
        expect(src).toContain('ref={tabStripRef}');
        expect(src).toContain("aria-current={isActive ? 'page' : undefined}");
        expect(src).toContain(`useRevealActive(tabStripRef, '[aria-current="page"]', [shown, !!currentConference]);`);
        expect(src).not.toMatch(/scrollIntoView/);   // would scroll the page as well
        const hook = STRIP_HOOK.slice(STRIP_HOOK.indexOf('export function useRevealActive'));
        expect(hook).toContain('revealDelta(strip.getBoundingClientRect(), active.getBoundingClientRect(), stripFade(stripOverflow(strip)))');
        expect(hook).toMatch(/strip\.scrollLeft \+= delta/);
        expect(hook).not.toMatch(/scrollIntoView/);
    });
    it('the «Alimentación» sub-tabs (same fade) reveal their active tab too', () => {
        expect(MEALS).toContain(`useRevealActive(subTabsRef, '[aria-selected="true"]', [!!data, allowedTabs.length, shownTab]);`);
        expect(MEALS).toContain('aria-selected={shownTab === k}');
    });
});

describe('conference list: contrast (WCAG AA 4.5:1) and the card footer', () => {
    const src = fnSource(PAGE, 'ConferenceList');
    it('«Comenzar nuevo evento» is readable on the whole blue → indigo gradient', () => {
        const card = src.split('\n').find((l) => l.includes('bg-gradient-to-br') && l.includes('rounded-[40px]'))!;
        const from = /\bfrom-([a-z]+-\d{3})\b/.exec(card)![1], to = /\bto-([a-z]+-\d{3})\b/.exec(card)![1];
        const fg = oklab(textColour(classesOf(src, 'data-create-subtitle')));
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
            expect(contrast(fg, mixLab(oklab(from), oklab(to), t)), `at ${t}`).toBeGreaterThanOrEqual(4.5);
        }
        // It changes on hover to nothing lighter (a hover colour must be as readable).
        expect(classesOf(src, 'data-create-subtitle').filter((c) => c.startsWith('group-hover:text-'))).toEqual([]);
    });
    it('«Estadísticas», the subtitle and the descriptions on white', () => {
        const white = oklab('white');
        expect(contrast(oklab(textColour(classesOf(src, 'data-card-stats-label'))), white)).toBeGreaterThanOrEqual(4.5);
        const sub = src.split('\n').find((l) => l.includes("t('conference.manager.description')"))!;
        expect(contrast(oklab(/\btext-(gray-\d{3})\b/.exec(sub)![1]), white)).toBeGreaterThanOrEqual(4.5);
        const desc = src.split('\n').find((l) => l.includes('{conf.description}</p>'))!;
        expect(contrast(oklab(/\btext-(gray-\d{3})\b/.exec(desc)![1]), white)).toBeGreaterThanOrEqual(4.5);
    });
    it('the footer wraps: «Gestionar» goes under the stats instead of into them', () => {
        const footer = classesOf(src, 'data-card-footer');
        expect(footer).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'gap-x-4']));
        const button = src.slice(src.indexOf('data-card-footer')).split('\n').find((l) => l.includes('className=') && l.includes('px-6 py-3 bg-gray-900'))!;
        expect(button).toMatch(/\bml-auto\b/);
        expect(button).toMatch(/\bshrink-0\b/);
        expect(classesOf(src, 'data-card-stats-label')).toContain('whitespace-nowrap');
    });
    it('the subtitle is translated', () => {
        expect(src).toContain("tx('conference.create.start'");
        expect(src).not.toContain('>Comenzar nuevo evento<');
        for (const l of ['es', 'en', 'pt'] as const) expect(translations[l]['conference.create.start']).toBeTruthy();
    });
});

describe('«Campos» on a phone', () => {
    const src = fnSource(PAGE, 'FieldsPage');
    it('the intro does not say where the preview is (beside on a desktop, below on a phone)', () => {
        expect(src).not.toMatch(/a la derecha|simulador a la/);
        expect(src).toContain("tx('fields.builder.intro'");
        for (const l of ['es', 'en', 'pt'] as const) {
            const text = translations[l]['fields.builder.intro'];
            expect(text, l).toBeTruthy();
            expect(text, l).not.toMatch(/derecha|izquierda|abajo|debajo|right|left|below|beside|direita|esquerda|abaixo/i);
            expect(translations[l]['fields.builder.live'], l).toBeTruthy();
        }
    });
    it('an empty form is refused next to «Publicar», not with a toast; «Nuevo campo» dismisses the notice', () => {
        expect(publishRefusal(0, false)).toBe('empty');
        expect(publishRefusal(NaN, false)).toBe('empty');
        expect(publishRefusal(1, false)).toBeNull();
        expect(publishRefusal(0, true)).toBeNull();   // unpublishing is never refused
        const handle = src.slice(src.indexOf('const handlePublish'), src.indexOf('const msg = currentlyPublished'));
        expect(handle).toContain('publishRefusal(fields.length, currentlyPublished)');
        expect(handle).toContain('setPublishRefused(true)');
        expect(handle).not.toContain('addToast');
        expect(src).not.toContain('No puedes publicar un formulario sin campos.", "error"');
        const open = /const openNewField = \(\) => \{([^\n]*)\};/.exec(src)![1];
        expect(open).toContain('setPublishRefused(false)');
        expect(src).toMatch(/useEffect\(\(\) => \{ if \(fields\.length > 0\) setPublishRefused\(false\); \}, \[fields\.length\]\);/);
        expect(src).toMatch(/role="alert" data-publish-refused=""/);
        for (const l of ['es', 'en', 'pt'] as const) expect(translations[l]['fields.publish.empty'], l).toBeTruthy();
    });
    it('a field card puts its actions in a row under the label instead of a column of four', () => {
        const card = src.split('\n').find((l) => l.includes('rounded-2xl p-4 flex items-center justify-between'))!;
        // Wraps at every width (a tablet's narrow column too), not only under `sm`.
        expect(card).toMatch(/(^|[\s`"])flex-wrap\b/);
        const actions = classesOf(src, 'data-field-actions=');
        expect(actions).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'max-sm:ml-auto']));
        expect(src).toMatch(/w-10 h-10 shrink-0 rounded-xl bg-gray-50 text-gray-300/);   // the grip keeps its size
    });
});

describe('«Equipo y permisos» › Miembros on a phone', () => {
    it('the notes under a member drop their 52 px indent and the status badges do not break across lines', () => {
        const noRole = STAFF.split('\n').find((l) => l.includes('ml-[3.25rem]') && l.includes('role="note"'))!;
        expect(noRole).toMatch(/\bml-\[3\.25rem\] max-sm:ml-0\b/);
        const inactive = STAFF.split('\n').find((l) => l.includes('pl-[3.25rem]'))!;
        expect(inactive).toMatch(/\bpl-\[3\.25rem\] max-sm:pl-0\b/);
        const badges = STAFF.split('\n').filter((l) => /\{(!active|noRole) && <span className="ml-2 /.test(l));
        expect(badges).toHaveLength(2);
        for (const b of badges) expect(b).toMatch(/\bmax-sm:inline-block\b/);
    });
});

describe('the role editor fits a phone (PERM_MATRIX_CSS)', () => {
    const rules = rulesOf(PERM_MATRIX_CSS);
    const phone = rules.filter((r) => r.media.includes(`max-width: ${PERM_MATRIX_TABLE_MIN_WIDTH - 0.02}px`));
    const decl = (sel: string) => Object.assign({}, ...phone.filter((r) => r.selector === sel).map((r) => r.decl));
    it('below the table width: no 560 px minimum, one grid row of three levels per section', () => {
        expect(classesOf(STAFF, 'data-perm-matrix').length).toBeGreaterThan(0);
        expect(STAFF).toMatch(/<table className="[^"]*min-w-\[560px\]/);   // the desktop table, unchanged
        expect(decl('[data-perm-matrix] table')).toMatchObject({ display: 'block', 'min-width': '0' });
        expect(decl('[data-perm-matrix] tr[data-perm-row]')).toMatchObject({ display: 'grid', 'grid-template-columns': 'repeat(3, minmax(0, 1fr))' });
        expect(decl('[data-perm-matrix] tr[data-perm-row] > th')).toMatchObject({ 'grid-column': '1 / -1' });
        expect(PERM_MATRIX_CSS).not.toContain('@layer');
    });
    it('the table layout starts where its 560 px fit inside the dialog (max-w-3xl, 1rem overlay padding, sm:p-8 body)', () => {
        const dialogInner = Math.min(768, PERM_MATRIX_TABLE_MIN_WIDTH - 2 * 16) - 2 - 2 * 32;
        expect(dialogInner).toBeGreaterThanOrEqual(560);
        expect(STAFF).toMatch(/max-w-3xl[^"]*" role="dialog"/);
        expect(STAFF).toContain('<div className="p-6 sm:p-8 space-y-5 overflow-y-auto">');
    });
    it('captions: every level on a phone; on the table only the kitchen\'s «Operar», as before', () => {
        const wide = rules.filter((r) => r.media.includes(`min-width: ${PERM_MATRIX_TABLE_MIN_WIDTH}px`));
        expect(wide.map((r) => [r.selector, r.decl.display])).toEqual([['[data-perm-matrix] [data-perm-caption=""]', 'none']]);
        const html = renderToStaticMarkup(
            <I18nProvider><ToastProvider>
                <RoleEditor role={null} existing={[]} onClose={() => { }} onSaved={() => { }}
                    sections={[{ key: 'inscriptions', levels: ['none', 'view', 'manage'] }, { key: 'meals_delivery', levels: ['none', 'manage'] }, { key: 'dashboard', levels: ['none', 'view'] }]} />
            </ToastProvider></I18nProvider>,
        );
        expect(html).toContain('[data-perm-matrix] tr[data-perm-row]');   // the <style> is rendered with the table
        const radios = html.match(/<input type="radio"/g) || [];
        const captions = [...html.matchAll(/<span[^>]*data-perm-caption="(always|)"/g)].map((m) => m[1]);
        expect(radios).toHaveLength(7);
        expect(captions).toHaveLength(7);   // one caption per radio
        expect(captions.filter((c) => c === 'always')).toHaveLength(1);
        expect(html).toMatch(/data-perm-caption="always"[^>]*>Operar</);
    });
});

/*
 * Live finding (1280 px desktop): in «Equipo y permisos» › Nuevo rol the header row (Sección, Sin acceso,
 * Ver, Gestionar) scrolled away with the eleven sections, leaving columns of radios with no label. A
 * sticky header sticks in its NEAREST scroll container, and the matrix's wrapper was one
 * (`overflow-x-auto` — which computes overflow-y to auto as well) that never scrolls vertically.
 */
describe('the role editor\'s header row stays in view (PERM_MATRIX_CSS)', () => {
    const rules = rulesOf(PERM_MATRIX_CSS);
    const all = (sel: string, media: (m: string) => boolean) => Object.assign({}, ...rules.filter((r) => r.selector === sel && media(r.media)).map((r) => r.decl));
    const top = (m: string) => m === '';
    const phone = (m: string) => m.includes(`max-width: ${PERM_MATRIX_TABLE_MIN_WIDTH - 0.02}px`);
    it('the matrix wrapper is not a scroll container: it only clips (overflow: clip, `visible` without it) and has no overflow-x-auto', () => {
        expect(all('[data-perm-matrix]', top)).toMatchObject({ overflow: 'clip' });
        expect(PERM_MATRIX_CSS).toMatch(/\[data-perm-matrix\] \{ overflow: visible; overflow: clip; \}/);
        const wrapper = classesOf(STAFF, 'data-perm-matrix');
        expect(wrapper.filter((k) => /^overflow-(?:x-|y-)?(?:auto|scroll|hidden)$/.test(k))).toEqual([]);
    });
    // A sticky element stops at its scroller's PADDING edge (live: 32 px under the top on the desktop, 24 px on
    // a phone, the sections showing through above it): `top` is minus the body's own top padding.
    const bodyPadding = () => {
        const m = /<div className="p-(\d+) sm:p-(\d+) space-y-5 overflow-y-auto">[\s\S]*data-perm-matrix=""/.exec(STAFF);
        expect(m, 'the role editor body is the scroller around the matrix').toBeTruthy();
        return { belowSm: `-${Number(m![1]) / 4}rem`, fromSm: `-${Number(m![2]) / 4}rem` };   // Tailwind: p-N = N × 0.25rem
    };
    it('on the table the header cells stick flush with the top of the dialog\'s scroller, opaque, above the rows', () => {
        expect(bodyPadding()).toEqual(PERM_MATRIX_STICKY_TOP);
        expect(PERM_MATRIX_TABLE_MIN_WIDTH).toBeGreaterThanOrEqual(640);   // the table only exists where the padding is the sm: one
        expect(all('[data-perm-matrix] thead th', top)).toMatchObject({ position: 'sticky', top: PERM_MATRIX_STICKY_TOP.fromSm, 'z-index': '2', 'background-color': '#f9fafb' });
    });
    it('on a phone the header row is shown (the three levels, over their columns) and sticks the same way', () => {
        expect(all('[data-perm-matrix] thead', phone)).toMatchObject({ display: 'block', position: 'sticky', top: PERM_MATRIX_STICKY_TOP.fromSm });
        expect(all('[data-perm-matrix] thead', (m) => m.includes('max-width: 639.98px'))).toMatchObject({ top: bodyPadding().belowSm });
        expect(all('[data-perm-matrix] thead tr', phone)).toMatchObject({ display: 'grid', 'grid-template-columns': 'repeat(3, minmax(0, 1fr))', 'background-color': '#f9fafb' });
        expect(all('[data-perm-matrix] thead th:first-child', phone)).toMatchObject({ display: 'none' });   // «Sección»: each row names itself
        expect(all('[data-perm-matrix] thead th', phone)).toMatchObject({ position: 'static', width: 'auto' });
        // Same columns as the rows' radios, so each name sits over its column.
        expect(all('[data-perm-matrix] tr[data-perm-row]', phone)['grid-template-columns']).toBe(all('[data-perm-matrix] thead tr', phone)['grid-template-columns']);
        expect(all('[data-perm-matrix] thead tr', phone).padding).toMatch(/^0 0\.25rem$/);
        expect(all('[data-perm-matrix] tr[data-perm-row]', phone).padding).toMatch(/ 0\.25rem /);
        expect(rules.some((r) => r.selector === '[data-perm-matrix] thead' && r.decl.display === 'none')).toBe(false);
    });
});
