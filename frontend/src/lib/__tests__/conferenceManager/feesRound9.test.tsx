/**
 * conference-manager 2.18.0 — the fixes of the ninth round (the sixth review round: money / concurrency, the phone
 * UX / accessibility review, the live lab r5-1 and its skeptic), admin plugin side. Server-rendered or pure (node,
 * no DOM; effects do not run): each pinned so that undoing it fails here.
 *   - the person sheet's notice comes into sight above its pinned buttons (UX6-1); «Usar lo que falta» is revealed
 *     with «Monto total» when it appears while the amount is typed (UX6-2);
 *   - a «·» always starts the fact after it — the queue card, the person's payments, the phone «Pagos» rows, the
 *     payment's recorder and history lines, «Contabilidad» (UX6-3, UX6-4); «Portal de Bogotá» is one fact;
 *   - the receipt pickers keep the keyboard focus (UX6-5); «Manual» gives the typed split back (UX6-6); the admin
 *     person picker is capped by the room (UX6-7); sideways, a sheet pins only its title row (UX6-8); «Pagos» folds
 *     its filters into «Filtros (n)» on a phone (UX6-9);
 *   - a reused client_key with other data says which payment was recorded (R6-M2); Inscripciones alone sees each
 *     part of a person's payments without the payment behind it (R6-L1); «✓ Cuadra» only when the split can go and
 *     the history says when a repeated reference was confirmed (skeptic); the ledger's Excel days are local.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('react-dom', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-dom')>();
    return { ...actual, createPortal: (node: React.ReactNode) => node };
});

import { I18nProvider } from '@/contexts/I18nContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { ModalProvider } from '@/contexts/ModalContext';
import { ConferenceProvider } from '../../../../../marketplace/plugins/conference-manager/client/contexts/ConferenceContext';
import { FEE_ERROR_TEXT, RELOAD_CODES, feeErrorText, manualOnSwitch, peopleLabel, shortName } from '../../../../../marketplace/plugins/conference-manager/client/lib/feePayments';
import { SHORT_TOUCH_MEDIA, describedBox, isShortTouch, revealFocused, revealInOverlay } from '../../../../../marketplace/plugins/conference-manager/client/lib/overlay';
import { buildLedgerWorkbook, feeLineTitle, ledgerDay } from '../../../../../marketplace/plugins/conference-manager/client/lib/accounting';
import { buildFeePaymentsWorkbook } from '../../../../../marketplace/plugins/conference-manager/client/lib/exports';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';
import { TransferPanel, eventFacts } from '../../../../../marketplace/plugins/conference-manager/client/admin/TransferSheet';
import { PersonPayments, PersonSheet } from '../../../../../marketplace/plugins/conference-manager/client/admin/PersonSheet';
import { PersonPicker } from '../../../../../marketplace/plugins/conference-manager/client/admin/PersonPicker';
import { SumState, factsOf } from '../../../../../marketplace/plugins/conference-manager/client/admin/FeeBits';
import { proofFocusTarget } from '../../../../../marketplace/plugins/conference-manager/client/admin/ProofViewer';
import { LEDGER_CSS } from '../../../../../marketplace/plugins/conference-manager/client/admin/AccountingPage';
import FeePaymentsPage, { FEES_CSS, TRANSFER_FILTERS_PHONE_CSS, foldedTransferFilterCount } from '../../../../../marketplace/plugins/conference-manager/client/admin/FeePaymentsPage';

const ROOT = path.resolve(__dirname, '../../../../..');
const CM = path.join(ROOT, 'marketplace/plugins/conference-manager/client');
const read = (f: string) => fs.readFileSync(path.join(CM, f), 'utf8').replace(/\r\n/g, '\n');
const flat = (html: string) => html.replace(/<!-- -->/g, '');
const render = (node: React.ReactElement) => flat(renderToStaticMarkup(
    <I18nProvider><ToastProvider><ModalProvider><ConferenceProvider>{node}</ConferenceProvider></ModalProvider></ToastProvider></I18nProvider>));
const fill = (_k: string, f: string, v?: Record<string, unknown>) => String(f).replace(/\{(\w+)\}/g, (m, k) => (v && v[k] !== undefined ? String(v[k]) : m));
const NB = '\u00a0';
/** A «·» left at the END of a line: a text node or a fact that ends with it. */
const dotAtEnd = (html: string) => /·[\s\u00a0]*(?:<\/|$)/.test(html);
const inZone = <T,>(tz: string, fn: () => T): T => {
    const was = process.env.TZ;
    process.env.TZ = tz;
    try { return fn(); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
};
/** Render with a browser whose matchMedia answers `matches` for SHORT_TOUCH_MEDIA (a phone held sideways). */
const sideways = <T,>(fn: () => T): T => {
    const g = globalThis as any;
    const had = 'window' in g;
    const was = g.window;
    g.window = { matchMedia: (q: string) => ({ matches: q === SHORT_TOUCH_MEDIA, addEventListener() {}, removeEventListener() {} }) };
    try { return fn(); } finally { if (had) g.window = was; else delete g.window; }
};

const TR = (id: number, extra: any = {}) => ({
    id, conference_id: 1, location_id: 1, location: 'Norte', locations: [1], mixed: false, amount: 250, allocated: 250, method: 'Transferencia', reference: 'TRF-1001',
    paid_on: '2026-10-07', note: null, status: 'pending', review_note: null, alloc_gen: 1, recorded_via: 'portal', recorded_by: 'portal:1',
    created_at: '2026-10-07 09:00:00', submitted_at: '2026-10-07 09:00:00', updated_at: null, updated_by: null, reviewed_at: null, reviewed_by: null,
    has_proof: false, legacy: false, people: 1, duplicate_of: null, reused_by: [],
    allocations: [{ id: 1, inscription_id: 1, amount: 250, location_id: 1, cancelled: false, name: 'Ana Pérez', due: 500, total_due: 500, validated_other: 0, pending_other: 0, after: { paid: 250, owed: 250, credit: 0 } }],
    flags: { cancelled_people: [], duplicate_reference: false }, events: [], ...extra,
});
const W = (id: number, extra: any) => ({ id, location_id: 1, total_due: 250, due: 250, validated: 0, pending: 0, returned: 0, to_cover: 250, credit: 0, cancelled: false, payable: true, location: 'Norte', family_group: null, status: 'active', reg_code: null, ...extra });
const VIEW = (extra: any = {}) => ({
    conference_id: 1, features: { fee_payments: 1 }, methods: ['Efectivo', 'Transferencia'], max_people: 200, proof: { required_for: ['Transferencia'], max_chars: 1400000 },
    summary: { people: 3, cancelled: 0, due: 750, validated: 0, pending: 250, returned: 0, to_cover: 500, credit: 0 },
    by_location: [{ location_id: 1, location: 'Norte', people: 3, cancelled: 0, due: 750, validated: 0, pending: 250, returned: 0, to_cover: 500, credit: 0 }],
    counts: { pending: 1, validated: 0, returned: 0, rejected: 0, total: 1 },
    transfers: [TR(9, { amount: 250000, allocations: [1, 2, 3].map((i) => ({ id: i, inscription_id: i, amount: i === 1 ? 250000 : 0, location_id: 1, cancelled: false })), people: 3 })],
    people: [W(1, { name: 'Carlos Gómez' }), W(2, { name: 'Elena Gil' }), W(3, { name: 'Sol Pérez' })],
    ...extra,
});
const fees = (section: string, view: any = VIEW(), nav?: any) => {
    if (nav) {
        const g = globalThis as any;
        const store = new Map([[`cm:fees:1`, JSON.stringify(nav)]]);
        g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem() {}, removeItem() {} };
        try { return render(<FeePaymentsPage conferenceId={1} initial={{ view, fields: [], locations: [{ id: 1, name: 'Norte' }], section }} />); }
        finally { delete g.sessionStorage; }
    }
    return render(<FeePaymentsPage conferenceId={1} initial={{ view, fields: [], locations: [{ id: 1, name: 'Norte' }], section }} />);
};

// ── UX6-1 / UX6-2: what a sheet writes comes into sight, clear of its pinned buttons ─────────────────────────
describe('UX6-1: the person sheet\'s notice comes into sight above its pinned buttons', () => {
    const box = (top: number, bottom: number, extra: any = {}) => ({ getBoundingClientRect: () => ({ top, bottom }), contains: () => false, ...extra });
    const win = { getComputedStyle: (el: any) => ({ position: el.pinned ? 'sticky' : 'static' }), visualViewport: null };
    it('revealInOverlay scrolls the overlay so the notice ends right above the pinned footer (the live iPhone 13: notice 1283–1416, footer from 715)', () => {
        const foot = box(715, 844, { pinned: true });
        const head = box(0, 121, { pinned: true });
        const outer: any = {
            scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 844 }),
            querySelector: (sel: string) => (sel === '[data-cm-sheet-foot]' ? foot : sel === '[data-cm-overlay-inner]' ? { firstElementChild: { firstElementChild: head } } : null),
        };
        const notice = box(1283, 1416, { closest: (sel: string) => (sel === '[data-cm-overlay]' ? outer : null) });
        expect(revealInOverlay(notice, win)).toBe(709);   // 1416 + 8 − 715
        expect(outer.scrollTop).toBe(709);
        // Already in sight: nothing moves. Outside an overlay: the browser's own scrollIntoView.
        expect(revealInOverlay(box(300, 400, { closest: () => outer }), win)).toBe(0);
        const into = vi.fn();
        expect(revealInOverlay(box(0, 10, { closest: () => null, scrollIntoView: into }), win)).toBe(0);
        expect(into).toHaveBeenCalledWith({ block: 'nearest' });
    });
    it('PersonSheet runs it on each new notice, on the notice wrapper', () => {
        const src = read('admin/PersonSheet.tsx');
        expect(src).toMatch(/const noticeKey = notice && notice\.text \? `\$\{notice\.type\}:\$\{notice\.text\}` : '';\s*useEffect\(\(\) => \{[\s\S]*?revealInOverlay\(noticeRef\.current as any, window as any\)[\s\S]*?\}, \[noticeKey\]\);/);
        expect(src).toContain('<div ref={noticeRef} className="px-5 sm:px-8 pt-4 border-t border-gray-100" data-person-notice={notice.type}>');
    });
});

describe('UX6-2: «Usar lo que falta», appearing while «Monto total» is typed, comes into sight with it', () => {
    it('the field is revealed with its describer: sideways the button sat under the footer (305–349 vs 313)', () => {
        const box = (top: number, bottom: number, extra: any = {}) => ({ getBoundingClientRect: () => ({ top, bottom }), contains: () => false, ...extra });
        const use = box(305, 349);
        const foot = box(313, 390, { pinned: true });
        const outer: any = {
            scrollTop: 50, getBoundingClientRect: () => ({ top: 0, bottom: 390 }),
            querySelector: (sel: string) => (sel === '[data-cm-sheet-foot]' ? foot : sel === '[id="fee-use-owed"]' ? use : null),
        };
        const amount = box(249, 301, { tagName: 'INPUT', type: '', id: 'fee-amount', getAttribute: (n: string) => (n === 'aria-describedby' ? 'fee-use-owed' : null), closest: () => outer });
        const win = { getComputedStyle: (el: any) => ({ position: el.pinned ? 'sticky' : 'static' }), visualViewport: null };
        expect(describedBox(outer, amount)).toEqual({ top: 249, bottom: 349 });
        expect(revealFocused({ activeElement: amount }, win, (el) => el.id === 'fee-amount')).toBe(44);   // 349 + 8 − 313
        expect(outer.scrollTop).toBe(94);
    });
    it('the register sheet re-runs the reveal for «Monto total» whenever «Usar lo que falta» comes or goes', () => {
        const src = read('admin/RegisterPaymentSheet.tsx');
        expect(src).toMatch(/const useOwedShown = owedC > 0 && totalC !== owedC;\s*useEffect\(\(\) => \{\s*if \(typeof document === 'undefined'\) return;\s*revealFocused\(document, [^\n]*\(el\) => el\.id === 'fee-amount'\);\s*\}, \[useOwedShown\]\);/);
        expect(src).toContain("aria-describedby={useOwedShown ? 'fee-use-owed' : undefined}");
        expect(src).toContain('{useOwedShown && <button type="button" id="fee-use-owed"');
    });
});

// ── UX6-3 / UX6-4: a «·» always starts the fact after it ─────────────────────────────────────────────────────
describe('UX6-3: the admin twins of the payment facts line never leave a «·» at the end of a line', () => {
    it('factsOf: each fact carries its leading «·»; `long` facts may wrap inside, their «·» glued to the first word', () => {
        const short = flat(renderToStaticMarkup(<p>{factsOf(['$250,00', 'Efectivo'], 'Ref. X')}</p>));
        expect(short).toBe('<p><span style="white-space:nowrap" data-fact="">$250,00</span><span style="white-space:nowrap" data-fact="">· Efectivo</span><span data-ref="" style="display:inline-block;max-width:100%;overflow-wrap:anywhere">· Ref. X</span></p>');
        const long = flat(renderToStaticMarkup(<p>{factsOf(['Norte', 'registrado 07/10 09:00 por boss'], 'Ref. X', { long: true })}</p>));
        expect(long).toBe(`<p><span style="display:inline-block;max-width:100%;overflow-wrap:anywhere" data-fact="">Norte</span><span style="display:inline-block;max-width:100%;overflow-wrap:anywhere" data-fact="">·${NB}registrado 07/10 09:00 por boss</span><span data-ref="" style="display:inline-block;max-width:100%;overflow-wrap:anywhere">·${NB}Ref. X</span></p>`);
        expect(dotAtEnd(short) || dotAtEnd(long)).toBe(false);
    });
    it('the review queue card: «#9 · Transferencia · $250.000,00 · 3 personas» and «Norte · registrado … por Portal · Ref. TRF-1001»', () => {
        const html = fees('queue');
        const card = html.slice(html.indexOf('data-queue-item="9"'), html.indexOf('</button>', html.indexOf('data-queue-item="9"')));
        expect(card).toMatch(/data-queue-facts=""><span>#9<\/span><span>· Transferencia<\/span><span class="tabular-nums">· \$250\.000,00<\/span><span>· 3 personas<\/span><\/span>/);
        expect(card).toMatch(/data-queue-meta="">[\s\S]*?·\u00a0registrado 07\/10\u00a0\d\d:\d\d por Portal[\s\S]*?·\u00a0Ref\. TRF-1001/);
        expect(dotAtEnd(card)).toBe(false);
    });
    it('the phone «Pagos» row: «$250.000,00 · Transferencia» and «Carlos G., Elena G. +1 · Norte · 07/10/2026»', () => {
        const html = fees('transfers');
        const list = html.slice(html.indexOf('data-fees-tlist=""'), html.indexOf('data-fees-ttable=""'));
        expect(list).toMatch(/data-transfer-head=""><span style="white-space:nowrap" data-fact=""><span class="tabular-nums">\$250\.000,00<\/span><\/span><span style="white-space:nowrap" data-fact="">· Transferencia<\/span><\/span>/);
        expect(list).toContain(`>Carlos${NB}G., Elena${NB}G.${NB}+1</span>`);
        expect(list).toContain(`>·${NB}Norte</span>`);
        expect(list).toContain(`>·${NB}07/10/2026</span>`);
        expect(dotAtEnd(list)).toBe(false);
    });
    it('the person sheet\'s «Pago» rows: «$200,00 · de $550,00 · compartido con 2» / «11/10/2026 · Transferencia · TRF-1001»', () => {
        const parts = [{ id: 1, amount: 200, date: '2026-10-11', method: 'Transferencia', reference: 'TRF-1001', status: 'validated', transfer_id: 5, transfer: { people: 3, amount: 550 } }];
        const html = render(<PersonPayments tx={fill} onOpen={null} parts={parts} />);
        expect(html).toContain('<span style="white-space:nowrap" data-fact="">· <span class="font-bold text-gray-500">de $550,00</span></span><span style="white-space:nowrap" data-fact="">· <span class="font-bold text-gray-500">compartido con 2</span></span>');
        expect(html).toContain('<span style="white-space:nowrap" data-fact="">11/10/2026</span><span style="white-space:nowrap" data-fact="">· Transferencia</span><span data-ref="" style="display:inline-block;max-width:100%;overflow-wrap:anywhere">· TRF-1001</span>');
        expect(dotAtEnd(html)).toBe(false);
        // es / en / pt: the two facts are two strings now.
        for (const l of ['es', 'en', 'pt'] as const) {
            expect((translations[l] as any)['fees.person.of.total']).toContain('{total}');
            expect((translations[l] as any)['fees.person.shared.with']).toContain('{n}');
            expect((translations[l] as any)['fees.person.shared']).toBeUndefined();
        }
    });
    it('the payment\'s recorder line and its history lines are facts; a coordinator is «Portal de Norte», one fact', () => {
        const t = TR(3, { events: [{ id: 1, at: '2026-10-07 09:00:00', actor: 'portal:1', action: 'created', note: null }, { id: 2, at: '2026-10-07 10:00:00', actor: 'boss', action: 'returned', note: 'Foto borrosa' }] });
        const html = render(<TransferPanel id={3} initial={t} canManage />);
        const recorded = html.slice(html.indexOf('data-transfer-recorded=""'), html.indexOf('</p>', html.indexOf('data-transfer-recorded=""')));
        expect(recorded).toContain('Norte</span>');
        expect(recorded).toMatch(new RegExp(`>·${NB}Registrado por Portal de Norte el 07/10/2026 \\d\\d:\\d\\d</span>`));
        const hist = html.slice(html.indexOf('data-history=""'));
        expect(hist).toContain(`>·${NB}Portal de Norte</span>`);
        expect(hist).toContain(`>·${NB}boss</span>`);
        expect(hist).toContain('«Foto borrosa»');
        expect(dotAtEnd(recorded) || dotAtEnd(hist.slice(0, hist.indexOf('</ol>')))).toBe(false);
        expect([translations.es['fees.by.portal'], translations.en['fees.by.portal'], translations.pt['fees.by.portal']]).toEqual(['Portal de {location}', '{location} portal', 'Portal de {location}']);
        expect(buildFeePaymentsWorkbook({ transfers: [{ ...TR(3), people: 1, allocations: [{ inscription_id: 1, amount: 250, location_id: 1 }] }] as any, people: [], nameOf: () => 'Ana', locationName: () => 'Bogotá' })[0].rows[0][4]).toBe('Portal de Bogotá');
    });
});

describe("UX6-3 twins: the «Por localidad» count, the split title and a chosen person's line are facts too", () => {
    it('«3 personas · 1 cancelada», «Reparto · 1 persona», «debe $X · Norte»', () => {
        const v = VIEW({ summary: { ...VIEW().summary, cancelled: 1 } });
        const sum = fees('summary', v);
        const people = sum.slice(sum.indexOf('data-loc-people=""'), sum.indexOf('</span></span>', sum.indexOf('data-loc-people=""')) + 14);
        expect(people).toContain('<span style="white-space:nowrap" data-fact="">3 personas</span><span style="white-space:nowrap" data-fact="">· 1 cancelada</span>');
        const head = render(<TransferPanel id={5} initial={TR(5)} canManage />);
        expect(head).toContain('data-split-title=""><span style="white-space:nowrap" data-fact="">Reparto</span><span style="white-space:nowrap" data-fact="">· 1 persona</span></h4>');
        expect(read('admin/RegisterPaymentSheet.tsx')).toContain("locs.size > 1 ? (o.locationName || tx('no.location', 'Sin localidad')) : null], null, { long: true })}");
        expect(dotAtEnd(people)).toBe(false);
    });
});

describe('UX6-4: «Contabilidad» never leaves a «·» alone either; a name never splits from its initial', () => {
    it('the titles glue the «·» to the count (es / en / pt): «Pago de cuotas» / «· 3 personas»', () => {
        const line = (extra: any) => ({ source: 'inscription' as const, transfer_id: 5, people: 3, description: 'x', allocations: [], ...extra });
        expect(feeLineTitle(line({}))).toBe(`Pago de cuotas ·${NB}3${NB}personas`);
        expect(feeLineTitle(line({ people: 1 }))).toBe(`Pago de cuotas ·${NB}1${NB}persona`);
        expect(feeLineTitle(line({ people: 1, share_total: 3 }))).toBe(`Pago de cuotas ·${NB}1${NB}de 3${NB}personas`);
        for (const l of ['es', 'en', 'pt'] as const) {
            for (const k of ['accounting.fee.line', 'accounting.fee.line.one', 'accounting.fee.share']) expect((translations[l] as any)[k], `${l} ${k}`).toMatch(new RegExp(`·${NB}(\\{n\\}|1)${NB}`));
        }
    });
    it('the ledger line\'s origin / people / reference and its folded «Categoría · Forma de pago» are facts', () => {
        const acc = read('admin/AccountingPage.tsx');
        expect(acc).toContain("{factsOf([lineSource(e), shared ? peopleLabel(who.map((id) => ({ inscription_id: id })), (id) => names.get(id) || `#${id}`) : who.length === 1 ? (names.get(who[0]) || '#' + who[0]) : null], e.reference || null, { long: true })}");
        expect(acc).toContain('data-ledger-inline-meta="">{factsOf([e.category || null, e.method || null], null, { long: true })}</span>');
        expect(acc).not.toMatch(/\.join\(' · '\)/);
        expect(LEDGER_CSS).toContain('[data-ledger-inline-meta] { display: flex; flex-wrap: wrap; column-gap: 0.25rem; }');
        expect([shortName('Carlos Gómez'), peopleLabel([{ inscription_id: 1 }, { inscription_id: 2 }, { inscription_id: 3 }], (id) => ['', 'Carlos Gómez', 'Elena Gil', 'Sol Pérez'][id])])
            .toEqual([`Carlos${NB}G.`, `Carlos${NB}G., Elena${NB}G.${NB}+1`]);
    });
});

// ── UX6-5 / UX6-6 / UX6-7 ─────────────────────────────────────────────────────────────────────────────────────
describe('UX6-5: the receipt picker keeps the keyboard focus when what it shows changes under it', () => {
    it('proofFocusTarget: «Cambiar» when there is a receipt, else the empty picker\'s button', () => {
        const change = { id: 'change' }, empty = { id: 'empty' };
        const root = (has: string[]) => ({ querySelector: (sel: string) => (sel === '[data-proof-change]' && has.includes('change') ? change : sel === '[data-proof-empty]' && has.includes('empty') ? empty : null) });
        expect(proofFocusTarget(root(['change']))).toBe(change);
        expect(proofFocusTarget(root(['empty']))).toBe(empty);
        expect(proofFocusTarget(null)).toBe(null);
    });
    it('a pick and «Quitar» remember the focus was inside; once the picker settles it goes to proofFocusTarget', () => {
        const src = read('admin/ProofViewer.tsx');
        expect(src).toMatch(/const pick = async \(file: File \| undefined\) => \{\s*if \(!file\) return;\s*refocus\.current = refocus\.current \|\| focusWasIn\(\);/);
        expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(busy \|\| !refocus\.current\) return;\s*refocus\.current = false;\s*const el: any = proofFocusTarget\(rootRef\.current as any\);[\s\S]*?el\.focus\(\{ preventScroll: true \}\)[\s\S]*?\}, \[busy, value, err\]\);/);
        expect((src.match(/onClick=\{\(\) => remove\(/g) || []).length).toBe(2);
        expect(src).toContain('<div ref={rootRef} className="space-y-2" data-proof-picker="">');
    });
});

describe('UX6-6: «Manual» → «Iguales» → «Manual» gives the typed amounts back', () => {
    const cap = (id: number) => ({ 1: 25000, 2: 25000, 3: 10000, 4: 5000 } as Record<number, number>)[id] ?? null;
    it('manualOnSwitch: typed amounts come back (a person added meanwhile starts from what they may receive); without any, manualSeed', () => {
        const typed = { people: [1, 2, 3], manual: { 1: '250.000', 2: '250.000', 3: '100.000' }, manualTyped: true };
        expect(manualOnSwitch(typed, 60000, cap)).toEqual({ 1: '250.000', 2: '250.000', 3: '100.000' });
        expect(manualOnSwitch({ ...typed, people: [1, 2, 3, 4] }, 60000, cap)).toEqual({ 1: '250.000', 2: '250.000', 3: '100.000', 4: '50,00' });
        // Untyped: the seed — what each person owes when the total is that sum, else «Iguales».
        expect(manualOnSwitch({ ...typed, manualTyped: false }, 60000, cap)).toEqual({ 1: '250,00', 2: '250,00', 3: '100,00' });
        expect(manualOnSwitch({ people: [1, 2], manual: {}, manualTyped: false }, 30000, cap)).toEqual({ 1: '150,00', 2: '150,00' });
    });
    it('typing marks the amounts typed; the strip and an edited payment\'s own split go through it', () => {
        const src = read('admin/RegisterPaymentSheet.tsx');
        const typePart = src.slice(src.indexOf('const typePart = '), src.indexOf('const setMode = '));
        expect((typePart.match(/manualTyped: true/g) || []).length).toBe(2);
        expect(src).toContain("if (m === 'manual') return { ...d, mode: 'manual', manual: manualOnSwitch(d, parseMoneyInput(d.amount) ?? 0, capOf) };");
        expect(src).toContain('manualTyped: !isEqual,');
        // The «Cambia a Manual…» hint only promises a seed when switching gives one.
        expect(src).toContain("{draft.mode === 'equal' && check.overCap.length > 0 && !draft.manualTyped && <p");
    });
});

describe('UX6-7: the admin person picker is capped by the room the sheet has, and hands the scroll on', () => {
    it('max-height min(18rem, 40dvh) (max-h-72 where dvh is unknown), not overscroll-contained', () => {
        const html = render(<PersonPicker options={[{ id: 1, name: 'Ana Pérez', locationId: 1, locationName: 'Norte', family: 'Pérez', cancelled: false, dueC: 100, validatedC: 0, pendingC: 0, toCoverC: 100 }]} chosen={[]} locations={[{ id: 1, name: 'Norte' }]} onAdd={() => {}} onDone={() => {}} />);
        const list = /<ul[^>]*data-picker-list=""[^>]*>/.exec(html)![0];
        expect(list).toContain('style="max-height:min(18rem, 40dvh)"');
        expect(list).toContain('max-h-72');
        expect(list).not.toContain('overscroll-contain');
        // Its «Norte · Pérez» line is facts too.
        expect(html).toContain(`data-pick-facts=""><span style="display:inline-block;max-width:100%;overflow-wrap:anywhere" data-fact="">Norte</span><span style="display:inline-block;max-width:100%;overflow-wrap:anywhere" data-fact="">·${NB}Pérez</span>`);
    });
});

// ── UX6-8: sideways, a sheet pins only its title row ──────────────────────────────────────────────────────────
describe('UX6-8: on a phone held sideways the lines under a sheet\'s title scroll with the body', () => {
    it('isShortTouch follows SHORT_TOUCH_MEDIA; false outside a browser', () => {
        expect(isShortTouch({ matchMedia: (q: string) => ({ matches: q === SHORT_TOUCH_MEDIA }) })).toBe(true);
        expect(isShortTouch({ matchMedia: () => ({ matches: false }) })).toBe(false);
        expect(isShortTouch(null)).toBe(false);
    });
    it('the payment sheet: facts, recorder, reviewer and «Duplicar» source move to the top of the body; the notice stays pinned', () => {
        const t = TR(4, { status: 'rejected', reviewed_at: '2026-10-07 10:00:00', reviewed_by: 'boss', review_note: 'x', duplicate_of: 2 });
        const upright = render(<TransferPanel id={4} initial={t} canManage onClose={() => {}} />);
        const headOf = (html: string) => html.slice(html.indexOf('data-transfer-panel="4"'), html.indexOf('data-transfer-body=""'));
        expect((headOf(upright).match(/data-cm-head-extra=""/g) || []).length).toBe(4);
        const side = sideways(() => render(<TransferPanel id={4} initial={t} canManage onClose={() => {}} />));
        expect(headOf(side)).not.toContain('data-cm-head-extra');
        expect(headOf(side)).toContain('data-transfer-heading=""');
        const body = side.slice(side.indexOf('data-transfer-body=""'));
        expect(body).toMatch(/^data-transfer-body=""><div class="space-y-1\.5" data-head-extras-in-body="">[\s\S]*?data-transfer-facts=""[\s\S]*?data-transfer-recorded=""[\s\S]*?data-reviewed=""[\s\S]*?data-duplicate-of="2"/);
        // The desktop review queue (inline) keeps its header as it was.
        const inline = sideways(() => render(<TransferPanel id={4} initial={t} canManage inline />));
        expect((headOf(inline).match(/data-cm-head-extra=""/g) || []).length).toBe(4);
    });
    it('the person sheet: the chips go to the top of the body', () => {
        const P = { id: 1, first_name: 'Ana', last_name: 'Pérez', location_id: 1, status: 'cancelled', total_due: 500, amount_paid: 0, pending_amount: 0, payment_status: 'unpaid', reg_code: 'AB12', registration_date: '2026-09-01 10:00:00', notes: '' };
        const args = { person: P, fields: [], locations: [{ id: 1, name: 'Norte' }], nameOf: () => 'Ana Pérez', onClose: () => {} };
        const up = render(<PersonSheet {...args} />);
        const side = sideways(() => render(<PersonSheet {...args} />));
        const head = (html: string) => html.slice(html.indexOf('role="dialog"'), html.indexOf('data-person-section="pay"'));
        expect(head(up)).toContain('data-person-chips=""');
        expect(head(side)).not.toContain('data-person-chips=""');
        expect(side.slice(side.indexOf('data-person-section="pay"'))).toMatch(/^data-person-section="pay" style="border-top:none"><div class="flex flex-wrap gap-1\.5" data-cm-head-extra="" data-person-chips="">[\s\S]*?data-chip="cancelled"/);
    });
});

// ── UX6-9: «Pagos» folds its filters on a phone ───────────────────────────────────────────────────────────────
describe('UX6-9: on a phone «Pagos» keeps the status chips and the search, and folds the rest into «Filtros (n)»', () => {
    it('below 640 px (or short and touch) the five filters hide and «Filtros» shows; from 640 px the reverse', () => {
        expect(TRANSFER_FILTERS_PHONE_CSS).toBe('@media (max-width: 639.98px), (max-height: 500px) and (pointer: coarse) {\n  [data-fees-tfilters] > [data-tfilter-fold] { display: none; }\n  [data-fees-tfilters] > [data-fees-tfilters-btn] { display: inline-flex; }\n}');
        expect(FEES_CSS).toContain('[data-fees-tfilters-btn] { display: none; }');
        expect(FEES_CSS).toContain(TRANSFER_FILTERS_PHONE_CSS);
        const html = fees('transfers');
        const bar = html.slice(html.indexOf('data-fees-tfilters=""'), html.indexOf('data-fees-tcard=""'));
        expect((bar.match(/data-tfilter-fold=""/g) || []).length).toBe(5);
        expect(bar).toMatch(/<input type="search"[^>]*>/);
        expect(/<input type="search"[^>]*>/.exec(bar)![0]).not.toContain('data-tfilter-fold');
        expect(bar).toMatch(/<button type="button" aria-haspopup="dialog" class="[^"]*" data-fees-tfilters-btn=""><i class="fa-solid fa-sliders" aria-hidden="true"><\/i>Filtros<\/button>/);
    });
    it('«Filtros (n)» counts location, method, «Registrado por» and the two dates', () => {
        expect(foldedTransferFilterCount({ location: '', method: '', via: '', from: '', to: '' })).toBe(0);
        expect(foldedTransferFilterCount({ location: '1', method: 'Efectivo', via: 'portal', from: '2026-10-01', to: '' })).toBe(4);
        const src = read('admin/FeePaymentsPage.tsx');
        expect(src).toContain("{tfFolded ? tx('roster.filters.n', 'Filtros ({n})', { n: tfFolded }) : tx('roster.filters', 'Filtros')}");
        expect(src).toMatch(/\{tfSheet && \(\s*<Overlay layer=\{LAYER\.sheet\}[\s\S]*?data-fees-tfilters-sheet=""[\s\S]*?\{tfFields\.map\(\(f\) => <React\.Fragment key=\{f\.key\}>\{f\.el\}<\/React\.Fragment>\)\}[\s\S]*?setTf\(\{ location: '', method: '', via: '', from: '', to: '' \}\)[\s\S]*?'Ver resultados'/);
    });
});

// ── R6-M2 / R6-L1 / skeptic, client side ──────────────────────────────────────────────────────────────────────
describe('R6-M2: a reused client_key with other data says which payment was recorded, and reloads', () => {
    it('feeErrorText names the payment; the lists reload', () => {
        const e = Object.assign(new Error('x'), { code: 'client_key_changed', details: { id: 12 } });
        expect(feeErrorText(e, fill)).toBe('Este pago ya se había registrado antes con otros datos (pago #12): revísalo en «Pagos» en lugar de enviarlo de nuevo.');
        expect(FEE_ERROR_TEXT.client_key_changed).toBe(translations.es['fees.error.client_key_changed']);
        expect(RELOAD_CODES.has('client_key_changed')).toBe(true);
        for (const l of ['en', 'pt'] as const) expect((translations[l] as any)['fees.error.client_key_changed']).toContain('#{id}');
    });
});

describe('R6-L1: without Pagos › ver the person\'s payments show the part only', () => {
    it('PersonPayments without `full`: no share of a payment, no reference, nothing to open', () => {
        const parts = [{ id: 1, amount: 200, date: '2026-10-11', method: 'Transferencia', reference: 'TRF-1001', status: 'validated', transfer_id: 5, transfer: { people: 3, amount: 550 } }];
        const html = render(<PersonPayments tx={fill} onOpen={null} parts={parts} full={false} />);
        expect(html).toContain('$200,00');
        expect(html).not.toContain('compartido');
        expect(html).not.toContain('TRF-1001');
        expect(html).not.toContain('<button');
        expect(read('admin/PersonSheet.tsx')).toContain('<PersonPayments parts={parts} onOpen={canPayView ? onOpenTransfer : null} tx={tx} full={!!canPayView} />');
    });
});

describe('skeptic: «✓ Cuadra» only when the split can go; a confirmed repeated reference is in the history', () => {
    it('SumState: a sum that adds up beside a part over its «máximo» is amber and says so', () => {
        const over = render(<SumState assignedC={70000} totalC={70000} invalid="Una parte supera lo que falta" />);
        expect(over).toContain('data-split-state="invalid"');
        expect(over).toContain('bg-amber-50');
        expect(over).not.toContain('Cuadra');
        expect(render(<SumState assignedC={70000} totalC={70000} />)).toContain('data-split-state="ok"');
        expect(read('admin/RegisterPaymentSheet.tsx')).toContain("check.overCap.length ? tx('fees.split.over.cap', 'Una parte supera lo que falta') : ''");
    });
    it('«reference_confirmed» reads «Referencia repetida confirmada: también cuenta en el pago #37»', () => {
        const html = flat(renderToStaticMarkup(<span>{eventFacts(fill, { action: 'reference_confirmed', at: '2026-10-11 22:00:00', actor: 'boss', note: '37' }, 'boss')}</span>));
        expect(html).toContain('Referencia repetida confirmada: también cuenta en el pago #37');
        expect(html).toContain(`·${NB}boss`);
        const src = read('admin/TransferSheet.tsx');
        expect(src).toContain("{e.note && e.action !== 'reference_confirmed' && <span");
        for (const l of ['es', 'en', 'pt'] as const) expect((translations[l] as any)['fees.event.reference_confirmed']).toContain('#{id}');
    });
});

// ── the ledger's days are the browser's ───────────────────────────────────────────────────────────────────────
describe('the «Contabilidad» Excel and its date filter use the local day of a server stamp', () => {
    it('ledgerDay: a UTC stamp is the local day; a plain day — and a DATETIME at midnight — stays', () => {
        inZone('America/Bogota', () => {
            expect(ledgerDay('2026-10-12 02:52:42')).toBe('2026-10-11');
            expect(ledgerDay('2026-10-12T02:52:42.000Z')).toBe('2026-10-11');
            expect(ledgerDay('2026-10-11')).toBe('2026-10-11');
            expect(ledgerDay('2026-10-11 00:00:00')).toBe('2026-10-11');
        });
        const mov = inZone('America/Bogota', () => buildLedgerWorkbook([{ id: 'transport-1', kind: 'income', date: '2026-10-12 02:52:42', category: 'Transporte', description: 'Pasaje — Bus 1', amount: 20, method: 'Efectivo', reference: null, source: 'transport', readonly: true } as any], new Map())[1]);
        expect(mov.rows[0][0]).toBe('2026-10-11');
        expect(read('admin/AccountingPage.tsx')).toContain('const m = ledgerDay(s).match(');
    });
});
