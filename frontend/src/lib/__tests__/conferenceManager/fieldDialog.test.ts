/**
 * conference-manager 2.16.0: the small text of «Nuevo campo» and «Equipo y permisos» meets WCAG AA (4.5:1).
 *
 * Live finding (1280 px desktop, iPhone 13, iPhone SE): the «Campos básicos» block new in 2.16.0 — the hint
 * under its heading, each template's one-line description, the notes under the cards — was gray-400 on the
 * white dialog, 2.56–2.6:1. So were the form's own labels («ETIQUETA DEL CAMPO», «TIPO», …), its helper
 * lines and the «O UN CAMPO PROPIO» divider; the placeholders were gray-300 (~1.5:1). A template already in
 * the form was the whole card at opacity 50 %, its «Ya está en el formulario como «…»» line ~1.6:1. The
 * same gray-400 ran through «Equipo y permisos» (its field labels, the role editor's «Rápido:» and hint,
 * «No da acceso a ninguna sección», a member's «Añadido por …»), and its icon-only buttons (edit, delete,
 * close) were gray-400 too — under the 3:1 a control's icon needs.
 *
 * Pinned with Tailwind's own palette: every text colour of those screens on the surfaces it sits on; every
 * icon-only button at ≥ 3:1 (an icon-only, aria-hidden chip is decoration); the placeholders; and the
 * template cards (never faded, the description gray-600 on every card state).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AA, contrastOf } from '../helpers/tailwindContrast';
import { TEMPLATE_DESC_CLASS, TEMPLATE_DONE_CLASS, TEMPLATE_OPEN_CLASS } from '../../../../../marketplace/plugins/conference-manager/client/lib/fields';

const ADMIN = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin');
const PAGE = fs.readFileSync(path.join(ADMIN, 'page.tsx'), 'utf8');
const STAFF = fs.readFileSync(path.join(ADMIN, 'StaffPage.tsx'), 'utf8');

/** The «Nuevo / Editar campo» dialog's source: from its <Overlay> to its footer. */
function dialogSource(): string {
    const start = PAGE.search(/showModal && \(\s*<Overlay layer=\{1\} backdrop="rgba\(17,24,39,0\.6\)">/);
    expect(start, 'the field dialog').toBeGreaterThan(-1);
    const end = PAGE.indexOf('data-cm-sheet-foot', start);
    expect(end).toBeGreaterThan(start);
    return PAGE.slice(start, end);
}

/**
 * The plain `text-<colour>` classes of a source, split by what they colour: text, an icon-only BUTTON (a
 * control: 3:1), or an icon-only aria-hidden chip / bare <i> (decoration: not measured). `hover:`,
 * `placeholder:` … variants are not the resting colour and are skipped.
 */
function sweep(src: string): { text: string[]; control: string[] } {
    const text: string[] = [], control: string[] = [];
    // `(?:[^>]|=>)*?`: an attribute such as onClick={() => …} may come before className.
    for (const m of src.matchAll(/<(label|p|span|h3|h4|div|button)\b(?:[^>]|=>)*?className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const colours = [...(m[2] ?? m[3] ?? '').matchAll(/(?<![\w:/-])text-((?:gray|slate|blue|emerald|rose|amber|indigo)-\d{2,3})(?![\w/-])/g)].map((c) => `text-${c[1]}`);
        if (!colours.length) continue;
        let close = (m.index ?? 0) + m[0].length;
        while ((close = src.indexOf('>', close)) !== -1 && src[close - 1] === '=') close++;
        const content = src.slice(close + 1);
        const iconOnly = new RegExp(String.raw`^\s*<i\b[^>]*><\/i>\s*<\/${m[1]}>`).test(content);
        // A lone aria-hidden dash standing for «this section has no such level» is decoration, not text.
        if (/aria-hidden="true"$/.test(src.slice(0, close)) && /^\s*[—–-]\s*</.test(content)) continue;
        if (!iconOnly) text.push(...colours);
        else if (m[1] === 'button') control.push(...colours);
    }
    return { text, control };
}

/** The surfaces text sits on in these screens: white cards, their gray-50 tints. */
const SURFACES: string[][] = [['white'], ['white', 'bg-gray-50/30'], ['white', 'bg-gray-50/50'], ['white', 'bg-gray-50']];
const worst = (text: string) => Math.min(...SURFACES.map((bg) => contrastOf(text, ...bg)));
const below = (colours: string[], min: number) => [...new Set(colours)].filter((t) => worst(t) < min).map((t) => `${t} ${worst(t).toFixed(2)}`);

describe('«Nuevo campo»: the dialog\'s text meets AA', () => {
    const src = dialogSource();

    it('every text colour in the dialog is ≥ 4.5:1 on the surfaces it sits on; its icon-only close button ≥ 3:1', () => {
        const { text, control } = sweep(src);
        expect(text.length).toBeGreaterThan(20);
        expect(below(text, AA)).toEqual([]);
        expect(control.length).toBe(1);
        expect(below(control, 3)).toEqual([]);
        expect(src).not.toMatch(/<(?:label|p|span|h4)\b[^>]*className="[^"]*text-gray-(?:300|400)\b/);
    });

    it('the «Campos básicos» hint and notes, and the template descriptions (were gray-400, 2.6:1)', () => {
        expect(src).toMatch(/<p className="text-\[11px\] text-gray-500 mt-0\.5" data-field-templates-hint="">/);
        expect((src.match(/data-field-templates-note=""/g) || []).length).toBe(2);
        expect(src).toContain('<span className={`block text-[10px] leading-snug ${TEMPLATE_DESC_CLASS}`} data-template-desc="">');
        expect(worst(TEMPLATE_DESC_CLASS)).toBeGreaterThanOrEqual(AA);
        expect(contrastOf(TEMPLATE_DESC_CLASS, 'white', 'bg-blue-50/40')).toBeGreaterThanOrEqual(AA);
    });

    it('a template card is never faded: one already in the form is a grey card with a check mark', () => {
        for (const cls of [TEMPLATE_OPEN_CLASS, TEMPLATE_DONE_CLASS]) expect(cls).not.toMatch(/opacity/);
        expect(src).toContain("${existing ? TEMPLATE_DONE_CLASS : TEMPLATE_OPEN_CLASS}");
        expect(src).toContain("${existing ? 'fa-check' : template.icon}");
        expect(src).not.toMatch(/data-template=\{template\.key\}[\s\S]{0,400}disabled:opacity/);
    });

    it('placeholders are readable (were gray-300, ~1.5:1) and the close control has a name', () => {
        const placeholders = [...src.matchAll(/placeholder:text-(gray-\d{3})/g)].map((m) => m[1]);
        expect(placeholders.length).toBe(2);
        for (const p of placeholders) expect(contrastOf(`text-${p}`, 'white', 'bg-gray-50/30')).toBeGreaterThanOrEqual(AA);
        expect(src).toMatch(/<button onClick=\{\(\) => setShowModal\(false\)\} className="[^"]*" aria-label=\{tx\('close', 'Cerrar'\)\}>/);
    });
});

describe('«Equipo y permisos»: its text meets AA and its icon-only buttons 3:1', () => {
    it('every text colour of StaffPage (roles, the role editor, members, add-member) on its surfaces', () => {
        const { text, control } = sweep(STAFF);
        expect(text.length).toBeGreaterThan(20);
        expect(below(text, AA)).toEqual([]);
        expect(control.length).toBeGreaterThanOrEqual(4);   // edit role, delete role, close the editor, remove a member
        expect(below(control, 3)).toEqual([]);
    });
    it('the ✕ that dismisses a rose notice («no puedes publicar», a refused role deletion) is ≥ 3:1 on the rose-50 notice', () => {
        for (const [src, attr] of [[PAGE, 'data-publish-refused-close'], [STAFF, 'data-delete-error-close']] as const) {
            const m = new RegExp(`className="([^"]*)" ${attr}=""`).exec(src);
            expect(m, attr).toBeTruthy();
            const colour = m![1].split(/\s+/).find((k) => /^text-rose-\d{3}$/.test(k))!;
            expect(contrastOf(colour, 'white', 'bg-rose-50'), attr).toBeGreaterThanOrEqual(3);
        }
    });
    it('the field labels (labelCls) and the role editor\'s «Rápido:» and hint', () => {
        const label = /const labelCls = '([^']*)'/.exec(STAFF)![1];
        const colour = label.split(/\s+/).find((k) => /^text-gray-\d{3}$/.test(k))!;
        expect(worst(colour)).toBeGreaterThanOrEqual(AA);
        expect(STAFF).toMatch(/<span className="text-gray-500">\{tx\('staff\.role\.quick'/);
        expect(STAFF).toMatch(/<p className="text-\[11px\] text-gray-500">\{tx\('staff\.matrix\.hint'/);
    });
});
