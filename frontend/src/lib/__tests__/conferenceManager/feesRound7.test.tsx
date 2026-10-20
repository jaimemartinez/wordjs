/**
 * conference-manager 2.18.0 — the fixes of the seventh round (the fourth review round: the live lab at 6 profiles,
 * the phone UX / accessibility review and the skeptic), admin plugin side. Server-rendered or pure (node, no DOM);
 * each pinned so that undoing it fails here:
 *   - a focused field of a sheet comes WHOLE into sight, clear of the pinned footer and above the keyboard (the
 *     browser only reveals the caret line), and a short screen compacts the dialogs;
 *   - what fits is decided by the room a block has, not by the window: the «Pagos de cuotas» tabs wrap inside
 *     their panel, «Por localidad» is a table only in a wide card, the «Pagos» filters and the «Contabilidad»
 *     totals follow their box; an e-mail column of «Inscripciones» holds a domain label whole;
 *   - after a decision the focus goes into the payment shown next; the reason form takes it and gives it back;
 *     a blocked «Validar» says why in words; a quick reason is added to the text; a tap beside the sheet keeps a
 *     typed reason; a voided payment another one records again says nothing of validating it;
 *   - the register sheet says a failed send in its footer and ties a part's «máximo» to its field; money inputs
 *     group thousands; «Columnas» opens to the side that keeps it inside the panel; facts never split.
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
import { OVERLAY_CSS, isTypingField, revealFieldDelta, revealFocusedField, visibleFieldArea } from '../../../../../marketplace/plugins/conference-manager/client/lib/overlay';
import { ROSTER_COLUMNS_REM, ROSTER_FIELD_CHAR_PX, ROSTER_FIELD_MIN_CHARS, ROSTER_FIELD_MIN_REM, rosterLayoutFor, softBreaks } from '../../../../../marketplace/plugins/conference-manager/client/lib/roster';
import { centsToInput, parseMoneyInput, tidyMoneyInput } from '../../../../../marketplace/plugins/conference-manager/client/lib/feeSplit';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';
import { SEGMENTED_CSS, SegmentedControl, kpiValueFit } from '../../../../../marketplace/plugins/conference-manager/client/admin/FeeBits';
import { TransferPanel, appendReason, backdropCloser, canStillValidate, focusQuietly } from '../../../../../marketplace/plugins/conference-manager/client/admin/TransferSheet';
import { RegisterPaymentSheet, buildPersonOptions } from '../../../../../marketplace/plugins/conference-manager/client/admin/RegisterPaymentSheet';
import { LEDGER_CSS } from '../../../../../marketplace/plugins/conference-manager/client/admin/AccountingPage';
import { POPOVER_MIN_PX, popoverSide } from '../../../../../marketplace/plugins/conference-manager/client/admin/RosterFilters';
import FeePaymentsPage, { FEES_CSS, FEES_LOC_TABLE_MIN_REM, locFacts, owedAmountCls } from '../../../../../marketplace/plugins/conference-manager/client/admin/FeePaymentsPage';

const ROOT = path.resolve(__dirname, '../../../../..');
const CM = path.join(ROOT, 'marketplace/plugins/conference-manager/client');
const read = (f: string) => fs.readFileSync(path.join(CM, f), 'utf8');
const flat = (html: string) => html.replace(/<!-- -->/g, '');
const render = (node: React.ReactElement) => flat(renderToStaticMarkup(
    <I18nProvider><ToastProvider><ModalProvider><ConferenceProvider>{node}</ConferenceProvider></ModalProvider></ToastProvider></I18nProvider>));

const TR = (id: number, extra: any = {}) => ({
    id, conference_id: 1, location_id: 1, location: 'Norte', locations: [1], mixed: false, amount: 250, allocated: 250, method: 'Efectivo', reference: null,
    paid_on: '2026-10-07', note: null, status: 'pending', review_note: null, alloc_gen: 1, recorded_via: 'admin', recorded_by: 'boss',
    created_at: '2026-10-07 09:00:00', submitted_at: '2026-10-07 09:00:00', updated_at: null, updated_by: null, reviewed_at: null, reviewed_by: null,
    has_proof: true, legacy: false, people: 1, duplicate_of: null, reused_by: [],
    allocations: [{ id: 1, inscription_id: 1, amount: 250, location_id: 1, cancelled: false, name: 'Rosa Díaz', due: 500, total_due: 500, validated_other: 0, pending_other: 0, after: { paid: 250, owed: 250, credit: 0 } }],
    flags: { cancelled_people: [], duplicate_reference: false }, events: [], ...extra,
});
const W = (id: number, extra: any) => ({ id, location_id: 1, total_due: 250, due: 250, validated: 0, pending: 0, returned: 0, to_cover: 250, credit: 0, cancelled: false, payable: true, location: 'Norte', family_group: null, status: 'active', reg_code: null, ...extra });
const VIEW = (extra: any = {}) => ({
    conference_id: 1, features: { fee_payments: 1 }, methods: ['Efectivo', 'Transferencia'], max_people: 200, proof: { required_for: ['Transferencia'], max_chars: 1400000 },
    summary: { people: 2, cancelled: 0, due: 500, validated: 0, pending: 0, returned: 0, to_cover: 500, credit: 0 },
    by_location: [
        { location_id: 1, location: 'Bogotá', people: 24, cancelled: 0, due: 6000, validated: 1050, pending: 500, returned: 0, to_cover: 4450, credit: 0 },
        { location_id: 2, location: 'Cali', people: 3, cancelled: 0, due: 750, validated: 0, pending: 580, returned: 0, to_cover: 170, credit: 0 },
    ],
    counts: { pending: 1, validated: 0, returned: 0, rejected: 0, total: 1 },
    transfers: [TR(9)],
    people: [W(1, { name: 'Ana Pérez', total_due: 250000, due: 250000, to_cover: 250000 }), W(2, { name: 'Luis Pérez', total_due: 125000000, due: 125000000, to_cover: 125000000 })],
    ...extra,
});
const fees = (section: string, view: any = VIEW()) => render(<FeePaymentsPage conferenceId={1} initial={{ view, fields: [], locations: [{ id: 1, name: 'Bogotá' }, { id: 2, name: 'Cali' }], section }} />);
const panel = (t: any, props: any = {}) => render(<TransferPanel id={t.id} initial={t} canManage onEdit={() => {}} onDuplicate={() => {}} {...props} />);

// ── a focused field, whole in sight (live L1) ──────────────────────────────────────────────────────────
describe('a focused field of a sheet comes whole into sight (live: the admin «Registrar pago» on phones)', () => {
    it('revealFieldDelta: the field\'s border and a 2-row «Nota» clear the pinned footer by 8 px; a field above it stays', () => {
        const area = { top: 80, bottom: 520 };   // under the header, above the footer
        expect(revealFieldDelta({ top: 480, bottom: 524 }, area)).toBe(12);    // 4 px under the footer → 4 + 8
        expect(revealFieldDelta({ top: 470, bottom: 548 }, area)).toBe(36);    // «Nota»: 28 px under → 28 + 8
        expect(revealFieldDelta({ top: 200, bottom: 244 }, area)).toBe(0);
        expect(revealFieldDelta({ top: 70, bottom: 114 }, area)).toBe(-18);    // under the pinned header
        expect(revealFieldDelta({ top: 100, bottom: 700 }, area)).toBe(12);    // taller than the room: its top
    });
    it('visibleFieldArea: the pinned rows and the keyboard (visual viewport) take their room', () => {
        expect(visibleFieldArea({ top: 0, bottom: 667 }, { top: 0, bottom: 72 }, { top: 540, bottom: 667 }, null)).toEqual({ top: 72, bottom: 540 });
        expect(visibleFieldArea({ top: 0, bottom: 667 }, null, null, { top: 0, bottom: 380 })).toEqual({ top: 0, bottom: 380 });
        // A phone held sideways: no pinned footer — the screen's edge.
        expect(visibleFieldArea({ top: 0, bottom: 390 }, null, null, null)).toEqual({ top: 0, bottom: 390 });
    });
    it('revealFocusedField scrolls the overlay by what is hidden; leaves the footer\'s own fields and unpinned rows alone', () => {
        const box = (top: number, bottom: number, extra: any = {}) => ({ getBoundingClientRect: () => ({ top, bottom }), contains: () => false, ...extra });
        const field = box(500, 544);
        const foot = box(540, 667, { pinned: true });
        const head = box(0, 70, { pinned: true });
        const card = { firstElementChild: head };
        const inner = { firstElementChild: card };
        const outer: any = { scrollTop: 100, getBoundingClientRect: () => ({ top: 0, bottom: 667 }), querySelector: (sel: string) => (sel === '[data-cm-sheet-foot]' ? foot : sel === '[data-cm-overlay-inner]' ? inner : null) };
        const win = { getComputedStyle: (el: any) => ({ position: el.pinned ? 'sticky' : 'static' }), visualViewport: null };
        expect(revealFocusedField(outer, field, win)).toBe(12);
        expect(outer.scrollTop).toBe(112);
        // Landscape (the footer is not pinned there): the field 14 px below the screen's edge comes up.
        const outer2: any = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 390 }), querySelector: (sel: string) => (sel === '[data-cm-sheet-foot]' ? box(600, 680) : null) };
        expect(revealFocusedField(outer2, box(360, 404), { getComputedStyle: () => ({ position: 'static' }) })).toBe(22);
        // A field of the footer itself is not moved.
        const inFoot = box(560, 600);
        const outer3: any = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 667 }), querySelector: (sel: string) => (sel === '[data-cm-sheet-foot]' ? { ...foot, contains: (n: any) => n === inFoot } : null) };
        expect(revealFocusedField(outer3, inFoot, win)).toBe(0);
        expect([isTypingField({ tagName: 'TEXTAREA' }), isTypingField({ tagName: 'INPUT', type: 'text' }), isTypingField({ tagName: 'INPUT', type: 'checkbox' }), isTypingField({ tagName: 'BUTTON' })]).toEqual([true, true, false, false]);
    });
    it('every overlay runs it on focus and when the keyboard resizes the visible viewport', () => {
        const src = read('admin/Overlay.tsx');
        expect(src).toMatch(/onFocus=\{onFocus\}/);
        expect(src).toMatch(/revealFocusedField\(outerRef\.current as any, el, /);
        expect(src).toMatch(/vv\.addEventListener\('resize', onResize\)/);
    });
    it('a short screen (an iPhone held sideways) compacts a dialog\'s paddings and lets a capped card take the height', () => {
        expect(OVERLAY_CSS).toMatch(/@media \(max-height: 500px\) \{[\s\S]*?\.max-h-\\\[92vh\\\] \{ max-height: calc\(100dvh - 1rem\); \}[\s\S]*?:is\(\.p-10, \.p-8\) \{ padding: 1rem 1\.25rem; \}[\s\S]*?:is\(\.py-8, \.py-6\) \{ padding-top: 0\.75rem; padding-bottom: 0\.75rem; \}/);
    });
});

// ── the room a block has, not the window ────────────────────────────────────────────────────────────────
describe('what fits is decided by the room a block has, not the window', () => {
    it('«Inscripciones» at 1366 px: the e-mail column holds «iglesiaevangelica» whole — the second column folds under the name', () => {
        const email = 'coordinacion.juvenil.bogota@iglesiaevangelica.org.co';
        const longest = Math.max(...softBreaks(email).map((p) => p.length));
        expect(longest).toBeLessThanOrEqual(ROSTER_FIELD_MIN_CHARS);
        // The column's text room (px-3 each side) holds that many characters.
        expect(ROSTER_FIELD_MIN_REM * 16 - 24).toBeGreaterThanOrEqual(ROSTER_FIELD_MIN_CHARS * ROSTER_FIELD_CHAR_PX);
        expect(rosterLayoutFor(948, true, 2)).toEqual({ table: true, fields: 1, folded: 1, lodgingRem: ROSTER_COLUMNS_REM.lodging });
        // 1280 keeps its one form column; 1920 all of them.
        expect(rosterLayoutFor(862, true, 3)).toMatchObject({ table: true, fields: 1 });
        expect(rosterLayoutFor(1504, true, 3)).toMatchObject({ table: true, fields: 3 });
    });
    it('the «Pagos de cuotas» tabs wrap inside their panel at every width (no nowrap strip), two rows of two in a narrow box', () => {
        expect(SEGMENTED_CSS).not.toMatch(/flex-wrap: nowrap/);
        expect(SEGMENTED_CSS).toContain('[data-cm-seg-box] { container: cm-seg / inline-size; }');
        expect(SEGMENTED_CSS).toMatch(/@container cm-seg \(max-width: 35\.99rem\) \{[\s\S]*?\[data-cm-segmented\]\[data-seg-count="4"\] > \[data-seg\] \{ flex-basis: calc\(50% - 0\.25rem\);/);
        expect(fees('summary')).toMatch(/<div data-fees-tabs="" data-cm-seg-box="" class="bg-white py-1"><div role="tablist"/);
        expect(render(<SegmentedControl label="x" value="a" onChange={() => {}} options={[{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]} />)).toContain('data-cm-segmented=""');
    });
    it('«Por localidad»: a table only in a card of 46rem; the location button is a 44 px target; the phone line keeps each fact whole', () => {
        expect(FEES_LOC_TABLE_MIN_REM).toBe(46);
        expect(FEES_CSS).toContain('[data-fees-bycard] { container: cm-fees-loc / inline-size; }');
        expect(FEES_CSS).toMatch(/@container cm-fees-loc \(min-width: 46rem\) \{\s*\[data-fees-phone\] \{ display: none; \}\s*\[data-fees-desk\] \{ display: block; \}/);
        expect(FEES_CSS).not.toMatch(/@media \(min-width: 768px\) \{\s*\[data-fees-phone\]/);
        const html = fees('summary');
        expect(html).toContain('data-fees-bycard=""');
        expect(html).toMatch(/<button type="button" class="text-left min-h-\[44px\] min-w-\[44px\] w-full" data-loc-open="">Cali<\/button>/);
        // «24 inscritos · cuotas $6.000,00 · validado $1.050,00 · $500,00 por validar»: each fact one nowrap span, its «·» inside.
        const line = html.match(/data-loc-row="1"[\s\S]*?data-loc-facts="">([\s\S]*?)<\/span><\/button>/)![1];
        const facts = [...line.matchAll(/<span class="whitespace-nowrap">([^<]*)<\/span>/g)].map((m) => m[1]);
        expect(facts).toEqual(['24 inscritos', '· cuotas $6.000,00', '· validado $1.050,00', '· $500,00 por validar']);
        expect(locFacts({ people: 3, due: 750, validated: 0, pending: 0, credit: 20 }).map((f) => f.key)).toEqual(['fees.loc.people', 'fees.loc.due', 'fees.loc.validated', 'fees.chip.credit']);
    });
    it('«Pagos» filters: as many columns as the box holds (17rem each); the dates shrink and never run under the next label', () => {
        expect(FEES_CSS).toContain('[data-fees-tfilters] { display: grid; gap: 0.5rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr)); }');
        expect(FEES_CSS).toContain('[data-fees-tfilters] input[type="date"] { min-width: 0; max-width: 100%; }');
        const html = fees('transfers');
        expect(html).toContain('data-fees-tfilters=""');
        expect(html).not.toMatch(/sm:grid-cols-2 lg:grid-cols-3/);
        expect((html.match(/<label class="flex items-center gap-2 min-w-0"[^>]*><span class="[^"]* w-14 shrink-0">[^<]+<\/span><input type="date" class="[^"]* min-w-0 flex-1"/g) || []).length).toBe(2);
    });
    it('«Contabilidad» totals: three side by side only while each holds 12rem; each figure on one line, sized by its tile', () => {
        expect(LEDGER_CSS).toContain('[data-ledger-totals] { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); }');
        expect(LEDGER_CSS).toContain('[data-ledger-total] { container-type: inline-size; min-width: 0; }');
        const src = read('admin/AccountingPage.tsx');
        expect(src).not.toMatch(/grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6/);
        expect(src).toMatch(/const fit = kpiValueFit\(money\(value\), 1\.5\);[\s\S]*?data-ledger-total=""[\s\S]*?className=\{`font-black italic tracking-tighter mt-1 \$\{fit\.className\} \$\{cls\}`\} style=\{fit\.style\} data-ledger-total-value=""/);
        expect(kpiValueFit('$375.000.000,00', 1.5)).toEqual({ className: 'whitespace-nowrap text-xs', style: { fontSize: 'min(1.5rem, calc(100cqi / 9.30))' } });
    });
    it('«Saldos»: a 15-character amount steps down a size so it stays inside its 45 % box', () => {
        expect(owedAmountCls('$125.000.000,00')).toBe('text-xs');
        expect(owedAmountCls('$250.000,00')).toBe('text-sm');
        const html = fees('balances');
        expect(html).toMatch(/<span class="block text-xs font-black text-rose-700 tabular-nums whitespace-nowrap" data-owed-amount="">\$125\.000\.000,00<\/span>/);
        expect(html).toMatch(/<span class="block text-sm font-black text-rose-700 tabular-nums whitespace-nowrap" data-owed-amount="">\$250\.000,00<\/span>/);
    });
    it('«Saldos» at the 200-person cap: an unticked box is disabled and the bar says why (no silent no-op)', () => {
        const src = read('admin/FeePaymentsPage.tsx');
        expect(src).toMatch(/const atCap = selected\.length >= MAX_PARTS;/);
        expect(src).toMatch(/const capped = selectable && !sel && atCap;/);
        expect(src).toMatch(/disabled=\{!selectable \|\| capped\}[\s\S]*?aria-describedby=\{capped \? 'cm-fees-selcap' : undefined\}/);
        expect(src).toMatch(/\{atCap && <span id="cm-fees-selcap" role="status"[^>]*>\{tx\('fees\.select\.cap\.reached'/);
        for (const lang of ['es', 'en', 'pt'] as const) expect(translations[lang]['fees.select.cap.reached'], lang).toMatch(/\{n\}/);
    });
});

// ── the review queue and the payment sheet ──────────────────────────────────────────────────────────────
describe('the payment sheet: keyboard focus, words for a blocked «Validar», reasons and the backdrop (review PUX-3, 5, 10, 11)', () => {
    it('the heading of the payment shown takes the focus after a decision (never <body>); the empty queue can take it too', () => {
        const html = panel(TR(9));
        expect(html).toMatch(/<h3 tabindex="-1" data-transfer-heading="" class="[^"]*outline-none"[^>]*>Pago #9<\/h3>/);
        const src = read('admin/TransferSheet.tsx');
        expect(src).toMatch(/addToast\(ok, 'success'\);\s*focusAfter\.current = Number\(t\.id\);/);
        expect(src).toMatch(/if \(!t \|\| focusAfter\.current == null\) return;\s*focusQuietly\(headRef\.current\);/);
        expect(src).toMatch(/forgetProof\(t\.id\);\s*focusAfter\.current = Number\(t\.id\);/);
        // The reason form takes the focus (a phone: the form, so no keyboard pops up); «Cancelar» gives it back.
        expect(src).toMatch(/if \(canAutoFocus\(\)\) focusQuietly\(noteBoxRef\.current\);\s*else focusQuietly\(noteRef\.current\);/);
        expect(src).toMatch(/focusQuietly\(barRef\.current \? barRef\.current\.querySelector\(`\[data-act="\$\{act\}"\]`\) : null\);/);
        expect(src).toMatch(/onClick=\{\(\) => \{ focusBack\.current = openedBy\.current; setNoteFor\(null\); setNote\(''\); \}\} data-note-cancel=""/);
        const page = read('admin/FeePaymentsPage.tsx');
        expect(page).toMatch(/if \(!next\) requestAnimationFrame\(\(\) => \{ const el = rootEl && rootEl\.querySelector\('\[data-queue-empty\]'\);/);
        expect(page).toMatch(/returnFocus=\{transferOpen\.queue \? '\[data-queue-item\], \[data-queue-empty\]' : undefined\}/);
        expect(fees('queue', VIEW({ transfers: [], counts: { pending: 0, validated: 0, returned: 0, rejected: 0, total: 0 } }))).toMatch(/tabindex="-1" data-queue-empty=""/);
        const calls: any[] = [];
        expect(focusQuietly({ focus: (o: any) => calls.push(o) })).toBe(true);
        expect(calls).toEqual([{ preventScroll: true }]);
        expect(focusQuietly(null)).toBe(false);
    });
    it('a blocked «Validar» says why in the bar, in words, and is described by it (no hover-only title)', () => {
        const over = TR(15, { amount: 300, allocated: 300, allocations: [{ ...TR(15).allocations[0], amount: 300, total_due: 250, due: 250, validated_other: 0, after: { paid: 300, owed: 0, credit: 50 } }] });
        const html = panel(over);
        expect(html).toMatch(/data-transfer-actions="">[\s\S]*?<p id="fee-blocked-15" class="basis-full text-xs font-bold text-rose-700" role="status" data-foot-issue="" data-validate-blocked="">[\s\S]*?Supera lo que debe: corrige el reparto antes de validar<\/p>/);
        expect(html).toMatch(/disabled="" data-act="validate" aria-describedby="fee-blocked-15"/);
        expect(html).not.toMatch(/title="Supera/);
        expect(panel(TR(9))).not.toContain('data-validate-blocked');
    });
    it('a quick reason is ADDED to what was typed', () => {
        expect(appendReason('', 'Comprobante ilegible')).toBe('Comprobante ilegible');
        expect(appendReason('  ', 'Comprobante ilegible')).toBe('Comprobante ilegible');
        expect(appendReason('La foto no deja leer la referencia; además falta Luis', 'Comprobante ilegible')).toBe('La foto no deja leer la referencia; además falta Luis · Comprobante ilegible');
        expect(appendReason('Comprobante ilegible', 'Comprobante ilegible')).toBe('Comprobante ilegible');
        expect(read('admin/TransferSheet.tsx')).toMatch(/onClick=\{\(\) => setNote\(\(n\) => appendReason\(n, tx\(r\.key, r\.fallback\)\)\)\}/);
    });
    it('a tap beside the sheet never throws away a typed reason (as Escape)', () => {
        let closed = 0;
        const dirty = { current: true };
        const onBackdrop = backdropCloser(() => { closed++; }, dirty);
        onBackdrop();
        expect(closed).toBe(0);
        dirty.current = false;
        onBackdrop();
        expect(closed).toBe(1);
        const src = read('admin/TransferSheet.tsx');
        expect(src).toMatch(/<Overlay layer=\{layer\} onBackdrop=\{backdropCloser\(onClose, dirty\)\}/);
        expect(src).toMatch(/if \(dirtyRef\) dirtyRef\.current = !!noteFor && !!note\.trim\(\);/);
    });
    it('a voided payment that another one records again says nothing of validating it (no «Supera lo que debe», no after-state)', () => {
        const credit = { ...TR(26).allocations[0], amount: 150000, total_due: 250000, validated_other: 150000, after: { paid: 300000, owed: 0, credit: 50000 } };
        const reused = panel(TR(26, { status: 'rejected', review_note: 'Anulado', amount: 150000, allocations: [credit], reused_by: [{ id: 27, status: 'validated' }] }));
        expect(reused).toContain('data-reused-by="27"');
        expect(reused).not.toContain('data-flag="over"');
        expect(reused).not.toMatch(/Supera lo que debe/);
        expect(reused).not.toContain('data-after=');
        // A voided one that is free again CAN be validated: its warning stays.
        const free = panel(TR(26, { status: 'rejected', review_note: 'Anulado', amount: 150000, allocations: [credit], reused_by: [] }));
        expect(free).toContain('data-flag="over"');
        expect(free).toContain('data-after="over"');
        expect([canStillValidate({ status: 'pending' }), canStillValidate({ status: 'rejected', reused_by: [{ id: 1 }] }), canStillValidate({ status: 'rejected', reused_by: [] }), canStillValidate({ status: 'validated' })]).toEqual([true, false, true, false]);
    });
});

// ── the register sheet ─────────────────────────────────────────────────────────────────────────────────
describe('«Registrar pago»: a failed send in its footer, a part\'s «máximo» tied to its field, grouped amounts (PUX-6, 8, 9)', () => {
    const rows = [{ id: 1, first_name: 'Ana', last_name: 'Pérez', location_id: 1, total_due: 250, amount_paid: 0, status: 'active', pending_amount: 0 }];
    const options = buildPersonOptions(rows, (r: any) => `${r.first_name} ${r.last_name}`, [{ id: 1, name: 'Norte' }]);
    const editOver = TR(30, { amount: 300, allocated: 300, allocations: [{ ...TR(30).allocations[0], inscription_id: 1, name: 'Ana Pérez', amount: 300, total_due: 250, due: 250, validated_other: 0, pending_other: 0 }] });
    it('a part over what the person may receive: its input is described by the «Supera lo que falta: máximo» line', () => {
        const html = render(<RegisterPaymentSheet mode="edit" conferenceId={1} options={options} transfer={editOver} methods={['Efectivo']} onClose={() => {}} />);
        expect(html).toMatch(/<input id="fee-part-1"[^>]*aria-invalid="true" aria-describedby="fee-part-after-1"/);
        expect(html).toMatch(/<span id="fee-part-after-1" class="basis-full text-\[11px\] font-bold text-rose-700" data-part-after="">Supera lo que falta: máximo \$250,00<\/span>/);
    });
    it('the part field has room for «1.250.000,00» (w-40: 120 px of text at 16 px black)', () => {
        const html = render(<RegisterPaymentSheet mode="edit" conferenceId={1} options={options} transfer={editOver} methods={['Efectivo']} onClose={() => {}} />);
        expect(html).toContain('<div class="relative w-40 shrink-0" data-part-box="">');
        expect(10 * 16 - 28 - 8 - 4).toBeGreaterThanOrEqual('1.250.000,00'.length * 8.7);
    });
    it('a failed send is said in the footer (role=alert) until the draft changes — not in a toast over it', () => {
        const src = read('admin/RegisterPaymentSheet.tsx');
        expect(src).toMatch(/setSendError\(feeErrorText\(e, tx\)\);/);
        expect(src).not.toMatch(/addToast\(feeErrorText\(e, tx\), 'error'\)/);
        expect(src).toMatch(/useEffect\(\(\) => \{ if \(firstDraft\.current\) \{ firstDraft\.current = false; return; \} setSendError\(''\); \}, \[draft\]\);/);
        expect(src).toMatch(/\{sendError && \(\s*<p className="basis-full text-xs font-bold text-rose-700" role="alert" data-register-send-error="" data-foot-issue="">/);
        // The result of a send from the desktop queue is said above its list, not in a toast over its bar.
        expect(read('admin/FeePaymentsPage.tsx')).toMatch(/notify=\{wide && section === 'queue' \? sayInQueue : null\}/);
    });
    it('money inputs group thousands as every other amount on the sheet, and read back to the same cents', () => {
        expect(centsToInput(125000000)).toBe('1.250.000,00');
        expect(centsToInput(25000000)).toBe('250.000,00');
        expect(centsToInput(99999)).toBe('999,99');
        expect(tidyMoneyInput('1250000')).toBe('1.250.000,00');
        for (const c of [0, 5, 99999, 100000, 125050, 25000000, 125000000, 99999999999]) expect(parseMoneyInput(centsToInput(c))).toBe(c);
    });
});

// ── «Columnas», labels, facts ─────────────────────────────────────────────────────────────────────────
describe('«Columnas» opens inside the panel; names contain their visible words; facts and separators stay together', () => {
    it('popoverSide: a chip at the start of a wrapped line opens to the right; one at the end to the left', () => {
        const box = { left: 340, right: 690 };   // an iPad in portrait: the 350 px panel beside the sidebar
        expect(popoverSide({ left: 340, right: 496 }, box, POPOVER_MIN_PX, 'right')).toBe('left');
        expect(popoverSide({ left: 530, right: 686 }, box, POPOVER_MIN_PX, 'right')).toBe('right');
        expect(popoverSide({ left: 530, right: 686 }, box, POPOVER_MIN_PX, 'left')).toBe('right');
        expect(popoverSide({ left: 340, right: 496 }, box, POPOVER_MIN_PX, 'left')).toBe('left');
        const src = read('admin/RosterFilters.tsx');
        expect(src).toMatch(/onClick=\{\(\) => \{ if \(!open\) setSide\(measureSide\(\)\); setOpen\(!open\); \}\}/);
        expect(src).toMatch(/\$\{side === 'right' \? 'right-0' : 'left-0'\} min-w-\[16rem\] max-w-\[min\(22rem,calc\(100vw-2rem\)\)\]/);
    });
    it('the picker\'s search is named starting with its visible words in es / en / pt (label in name)', () => {
        for (const lang of ['es', 'en', 'pt'] as const) {
            const shown = translations[lang]['fees.picker.search'];
            expect(translations[lang]['fees.picker.search.hint'].startsWith(shown), lang).toBe(true);
        }
    });
    it('«Contabilidad»: a shared payment\'s part keeps «· Bogotá» whole; the fee line opens with words, not a padlock', () => {
        const src = read('admin/AccountingPage.tsx');
        expect(src).toMatch(/<span className="text-gray-500 font-medium whitespace-nowrap" data-part-location="">· \{locationNameOf\.get/);
        const open = src.match(/data-ledger-open=\{e\.transfer_id\}>([\s\S]*?)<\/button>/)![1];
        expect(open).toContain("tx('fees.transfer.see', 'Ver pago #{id}', { id: e.transfer_id })");
        expect(open).not.toContain('fa-lock');
        for (const lang of ['es', 'en', 'pt'] as const) expect(translations[lang]['fees.transfer.see'], lang).toContain('#{id}');
    });
});

// ── the CHANGELOG ──────────────────────────────────────────────────────────────────────────────────────
describe('the CHANGELOG describes the decision bar as it is (live: «flush with the bottom of the panel» was not so)', () => {
    it('no «flush with the bottom of the panel»; the bar is the payment card\'s last row', () => {
        const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
        expect(log).not.toMatch(/flush with the bottom of the panel/);
        expect(log).toMatch(/the payment card's last row/);
    });
});
