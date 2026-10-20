/**
 * conference-manager 2.18.0 — the fixes of the sixth round (the third review round: money / concurrency, the
 * phone UX review, the skeptic and the live lab), admin plugin side. Server-rendered or pure (node, no DOM);
 * each pinned so that undoing it fails here:
 *   - «Duplicar» is single-use and visible: a voided payment another one records again offers neither
 *     «Validar» nor «Duplicar» and says which payment counts; the copy names the voided one; «Duplicar» names
 *     its source even without a receipt (`duplicate_of`); 409 source_used has words in es / en / pt;
 *   - «Revisado por» never on a payment back in «Por validar»;
 *   - a sheet's pinned footer: ONE row on a phone, and the overlay's scroll padding from its measured height;
 *   - amounts are never broken: KPI tiles shrink the figure, «Saldos» puts the word over a whole amount;
 *   - 16 px fields on every touch screen (landscape iPhones), not only below 640 px;
 *   - e-mails in the person sheet wrap at «@» and «.», never mid-word;
 *   - «Contabilidad»: a read-only line says where it is managed, in words (no hover-only faint lock);
 *   - one wording for what a person owes: «debe $X», or «falta $X» beside «$Y por validar»;
 *   - the «Pagos» status chips always show their count; the queue card never splits «1 persona»;
 *   - the desktop queue: a short payment opens whole (the pinned bar is never over its «Historial») and its
 *     results are said above the list (no toast over the bar); a sheet says them in its header;
 *   - the CHANGELOG says what Escape really does in the «Devolver… / Rechazar…» reason box.
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
import { FEE_ERROR_TEXT, OWED_TEXT, RELOAD_CODES, buildFeeBody, checkDraft, isReused, owedWords, transferActions } from '../../../../../marketplace/plugins/conference-manager/client/lib/feePayments';
import { COARSE_FIELDS_CSS, OVERLAY_CSS, sheetScrollPadding } from '../../../../../marketplace/plugins/conference-manager/client/lib/overlay';
import { ROSTER_CSS } from '../../../../../marketplace/plugins/conference-manager/client/lib/roster';
import { SHELL_CSS } from '../../../../../marketplace/plugins/conference-manager/client/lib/phoneLayout';
import { queueRoomPx, revealWholeDelta } from '../../../../../marketplace/plugins/conference-manager/client/lib/paging';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';
import { TransferPanel, showsReview } from '../../../../../marketplace/plugins/conference-manager/client/admin/TransferSheet';
import { RegisterPaymentSheet, buildPersonOptions, initialDraft } from '../../../../../marketplace/plugins/conference-manager/client/admin/RegisterPaymentSheet';
import { PersonPicker } from '../../../../../marketplace/plugins/conference-manager/client/admin/PersonPicker';
import { PersonSheet } from '../../../../../marketplace/plugins/conference-manager/client/admin/PersonSheet';
import { KpiTile, kpiValueFit } from '../../../../../marketplace/plugins/conference-manager/client/admin/FeeBits';
import { LEDGER_CSS, readonlyNote } from '../../../../../marketplace/plugins/conference-manager/client/admin/AccountingPage';
import FeePaymentsPage, { FEES_CSS } from '../../../../../marketplace/plugins/conference-manager/client/admin/FeePaymentsPage';

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
    allocations: [{ id: 1, inscription_id: 1, amount: 250, location_id: 1, cancelled: false, name: 'Ana Pérez', due: 500, total_due: 500, validated_other: 0, pending_other: 0, after: { paid: 250, owed: 250, credit: 0 } }],
    flags: { cancelled_people: [], duplicate_reference: false }, events: [], ...extra,
});
const acts = (html: string) => [...html.matchAll(/data-act="([a-z]+)"/g)].map((m) => m[1]).sort();
const W = (id: number, extra: any) => ({ id, location_id: 1, total_due: 250, due: 250, validated: 0, pending: 0, returned: 0, to_cover: 250, credit: 0, cancelled: false, payable: true, location: 'Norte', family_group: null, status: 'active', reg_code: null, ...extra });
const VIEW = (extra: any = {}) => ({
    conference_id: 1, features: { fee_payments: 1 }, methods: ['Efectivo', 'Transferencia'], max_people: 200, proof: { required_for: ['Transferencia'], max_chars: 1400000 },
    summary: { people: 2, cancelled: 0, due: 25000000, validated: 0, pending: 0, returned: 0, to_cover: 25000000, credit: 0 },
    by_location: [{ location_id: 1, location: 'Norte', people: 2, cancelled: 0, due: 25000000, validated: 0, pending: 0, returned: 0, to_cover: 25000000, credit: 0 }],
    counts: { pending: 1, validated: 0, returned: 0, rejected: 0, total: 1 },
    transfers: [TR(9, { status: 'pending', method: 'Transferencia', amount: 50, reference: 'R-9' })],
    people: [W(1, { name: 'Ana Pérez', total_due: 250000, due: 250000, to_cover: 250000 }), W(2, { name: 'Luis Pérez', pending: 100, to_cover: 150 })],
    ...extra,
});
const fees = (section: string, view: any = VIEW()) => render(<FeePaymentsPage conferenceId={1} initial={{ view, fields: [], locations: [{ id: 1, name: 'Norte' }], section }} />);

// ── «Duplicar»: one receipt counts in ONE payment ───────────────────────────────────────────────────────
describe('«Duplicar» is single-use and visible (review F1)', () => {
    it('a voided payment that another payment records again: neither «Validar» nor «Duplicar», and it says which one counts', () => {
        const reused = { reused_by: [{ id: 15, status: 'validated' }] } as any;
        expect(isReused(reused)).toBe(true);
        expect(transferActions('rejected', true, reused)).toMatchObject({ validate: false, duplicate: false, remove: true });
        expect(transferActions('rejected', true, { reused_by: [] } as any)).toMatchObject({ validate: true, duplicate: true });
        const html = render(<TransferPanel id={4} initial={TR(4, { status: 'rejected', review_note: 'Se registra de nuevo', reused_by: [{ id: 15, status: 'validated' }] })} canManage onEdit={() => {}} onDuplicate={() => {}} />);
        expect(acts(html)).toEqual(['remove']);
        expect(html).toMatch(/data-reused-by="15"[^>]*>[\s\S]*?Registrado de nuevo en el pago #15, que cuenta/);
        // Free again (the copy was voided or deleted): both come back.
        expect(acts(render(<TransferPanel id={4} initial={TR(4, { status: 'rejected', review_note: 'x' })} canManage onEdit={() => {}} onDuplicate={() => {}} />))).toEqual(['duplicate', 'remove', 'validate']);
    });
    it('the copy names the voided payment it records again', () => {
        const html = render(<TransferPanel id={15} initial={TR(15, { status: 'validated', duplicate_of: 4 })} canManage />);
        expect(html).toMatch(/data-duplicate-of="4"[^>]*>[\s\S]*?Registra de nuevo el pago anulado #4/);
    });
    it('«Duplicar» names its source even without a receipt to copy (cash without a photo): duplicate_of', () => {
        const opts = buildPersonOptions([{ id: 1, first_name: 'Ana', last_name: 'Pérez', location_id: 1, status: 'active', total_due: 500, amount_paid: 0, pending_amount: 0 }] as any, (p) => `${p.first_name} ${p.last_name}`, [{ id: 1, name: 'Norte' }]);
        const d = initialDraft({ mode: 'duplicate', transfer: TR(4, { status: 'rejected', has_proof: false }), options: opts, methods: ['Efectivo'] });
        expect([d.duplicateOf, d.copyProofFrom]).toEqual([4, null]);
        const body = buildFeeBody(d, checkDraft(d, { capOf: () => 50000 }), { conferenceId: 1 });
        expect(body.duplicate_of).toBe(4);
        expect(body.copy_proof_from).toBeUndefined();
        const withProof = initialDraft({ mode: 'duplicate', transfer: TR(5, { status: 'rejected', has_proof: true }), options: opts, methods: ['Efectivo'] });
        expect(buildFeeBody(withProof, checkDraft(withProof, { capOf: () => 50000 }), {})).toMatchObject({ copy_proof_from: 5, duplicate_of: 5 });
        expect(initialDraft({ mode: 'create', options: opts, methods: ['Efectivo'] }).duplicateOf).toBeNull();
    });
    it('409 source_used has words in es / en / pt and reloads what is shown', () => {
        expect(FEE_ERROR_TEXT.source_used).toMatch(/ya se registró de nuevo/);
        expect(RELOAD_CODES.has('source_used')).toBe(true);
        for (const l of ['es', 'en', 'pt'] as const) {
            for (const k of ['fees.error.source_used', 'fees.reused.by', 'fees.duplicate.of']) expect((translations[l] as any)[k], `${l} ${k}`).toBeTruthy();
        }
    });
});

// ── «Revisado por» ──────────────────────────────────────────────────────────────────────────────────────
describe('«Revisado por» describes a decision on the payment as it is (skeptic: a resent payment)', () => {
    it('never on a payment back in «Por validar»; on a validated, returned or rejected one', () => {
        expect(showsReview({ reviewed_at: '2026-10-06 09:00:00', status: 'pending' })).toBe(false);
        for (const status of ['validated', 'returned', 'rejected']) expect(showsReview({ reviewed_at: '2026-10-06 09:00:00', status }), status).toBe(true);
        expect(showsReview({ reviewed_at: null, status: 'validated' })).toBe(false);
        const resent = render(<TransferPanel id={7} initial={TR(7, { status: 'pending', reviewed_at: '2026-10-06 09:00:00', reviewed_by: 'boss' })} canManage />);
        expect(resent).not.toContain('data-reviewed=""');
    });
});

// ── a sheet's pinned footer on a phone ─────────────────────────────────────────────────────────────────
describe('a sheet\'s pinned footer never covers the focused field (UX-1)', () => {
    it('sheetScrollPadding: the rows\' measured heights plus 8 px; the old fixed values until measured', () => {
        expect(sheetScrollPadding(120, 133)).toEqual({ top: '128px', bottom: '141px' });
        expect(sheetScrollPadding(120.2, 164.6)).toEqual({ top: '129px', bottom: '173px' });
        expect(sheetScrollPadding(null, undefined)).toEqual({ top: '6.5rem', bottom: '6rem' });
        expect(sheetScrollPadding(0, NaN)).toEqual({ top: '6.5rem', bottom: '6rem' });
    });
    it('OVERLAY_CSS reads the measured heights, and a footer grid keeps «Cancelar» and the main button on one row', () => {
        const phone = OVERLAY_CSS.slice(OVERLAY_CSS.indexOf('@media (max-width: 639.98px)'));
        expect(phone).toMatch(/\[data-cm-sheet\] \{ scroll-padding-top: calc\(var\(--cm-head-h, 6\.5rem\)[^}]*scroll-padding-bottom: var\(--cm-foot-h, 6rem\); \}/);
        expect(phone).toContain('[data-cm-sheet] [data-cm-foot-grid] { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; }');
        expect(phone).toContain('[data-cm-sheet] [data-cm-foot-grid] > [data-foot-issue] { grid-column: 1 / -1; }');
        expect(phone).toMatch(/\[data-foot-main\] \{ min-width: 0; white-space: normal;/);
        const src = read('admin/Overlay.tsx');
        expect(src).toMatch(/new ResizeObserver\(measure\)/);
        expect(src).toMatch(/setProperty\('--cm-foot-h', pad\.bottom\)/);
    });
    it('«Registrar pago»: the footer is a foot grid, its issue line spans it, the submit is the main button', () => {
        const opts = buildPersonOptions([{ id: 2, first_name: 'Tomás', last_name: 'Acosta', location_id: 1, status: 'active', total_due: 250000, amount_paid: 0, pending_amount: 0 }] as any, (p) => `${p.first_name} ${p.last_name}`, [{ id: 1, name: 'Norte' }]);
        const html = render(<RegisterPaymentSheet mode="create" conferenceId={1} options={opts} ids={[]} methods={['Transferencia']} onClose={() => {}} />);
        expect(html).toMatch(/data-cm-sheet-foot="" data-cm-foot-grid="">/);
        expect(html).toMatch(/data-register-issue="[a-z_]+" data-foot-issue=""/);
        expect(html).toMatch(/data-register-submit="" data-foot-main=""/);
    });
});

// ── amounts are never broken ───────────────────────────────────────────────────────────────────────────
describe('an amount is never broken mid-number (UX-2, UX-5)', () => {
    it('kpiValueFit: one line, sized by the tile (container units) and by its length without them', () => {
        const big = kpiValueFit('$15.000.000,00');
        expect(big.className).toContain('whitespace-nowrap');
        expect(big.className).not.toContain('break-words');
        expect(big.className).toContain('text-sm');
        expect(big.style.fontSize).toBe('min(1.25rem, calc(100cqi / 8.68))');
        expect(kpiValueFit('$250,00').className).toContain('text-lg sm:text-xl');
        expect(kpiValueFit('$7.500.000,00').className).toContain('text-sm');
    });
    it('KpiTile: a size container whose figure never wraps (admin «Resumen» with peso totals)', () => {
        const html = render(<KpiTile kpi="due" label="Cuotas" value="$15.000.000,00" icon="fa-file" />);
        expect(html).toContain('style="container-type:inline-size;display:flex;flex-direction:column;justify-content:flex-start;align-items:stretch" data-kpi="due"');
        expect(html).toMatch(/<span class="block font-black tabular-nums mt-0\.5 whitespace-nowrap text-sm text-gray-900" style="font-size:min\(1\.25rem, calc\(100cqi \/ 8\.68\)\)" data-kpi-value="">\$15\.000\.000,00<\/span>/);
        expect(html).not.toContain('break-words');
        const page = fees('summary');
        expect(page).toMatch(/data-kpi="due"[^>]*>[\s\S]*?<span class="block font-black tabular-nums mt-0\.5 whitespace-nowrap text-sm[^"]*" style="font-size:min\(1\.25rem, calc\(100cqi \/ 8\.68\)\)" data-kpi-value="">\$25\.000\.000,00</);
    });
    it('«Saldos» on a phone: the word over a whole amount, and the column may narrow (no shrink-0 + nowrap «falta $250.000,00»)', () => {
        const html = fees('balances');
        const ana = html.slice(html.indexOf('data-balance-row="1"'), html.indexOf('data-balance-row="2"'));
        expect(ana).toMatch(/<span class="max-w-\[45%\] text-right" data-balance-owed=""><span class="block text-\[10px\][^"]*">debe<\/span><span class="block text-sm font-black text-rose-700 tabular-nums whitespace-nowrap" data-owed-amount="">\$250\.000,00<\/span><\/span>/);
        expect(ana).not.toMatch(/shrink-0 text-right/);
        // Luis has money awaiting validation: «falta», beside his «por validar» chip.
        const luis = html.slice(html.indexOf('data-balance-row="2"'));
        expect(luis).toMatch(/data-balance-owed=""><span[^>]*>falta<\/span><span[^>]*>\$150,00<\/span>/);
        expect(luis).toMatch(/data-chip="pending"[^>]*>[\s\S]*?\$100,00 por validar/);
    });
});

// ── 16 px fields on every touch screen ─────────────────────────────────────────────────────────────────
describe('16 px fields on every touch screen — an iPhone held sideways is past 640 px (UX-7)', () => {
    it('one coarse-pointer rule, in the overlays, the shell, the roster and «Pagos de cuotas»', () => {
        const rule = COARSE_FIELDS_CSS('[x]');
        expect(rule).toMatch(/^@media \(pointer: coarse\) \{\n  \[x\] :is\(input, select, textarea\)[^{]*\{ font-size: 16px; \}\n\}$/);
        for (const [name, css, scope] of [['OVERLAY_CSS', OVERLAY_CSS, '[data-cm-overlay]'], ['SHELL_CSS', SHELL_CSS, '[data-cm-shell]'], ['ROSTER_CSS', ROSTER_CSS, '[data-cm-shell]'], ['FEES_CSS', FEES_CSS, '[data-fees-page]']] as const) {
            expect(css, name).toContain(COARSE_FIELDS_CSS(scope));
        }
        // Never only the width-based rule: the coarse one is outside every max-width query.
        const coarseAt = OVERLAY_CSS.indexOf('@media (pointer: coarse)');
        expect(coarseAt).toBeGreaterThan(OVERLAY_CSS.lastIndexOf('}\n', coarseAt) - 1);
        expect(OVERLAY_CSS.slice(coarseAt)).not.toContain('max-width');
    });
});

// ── e-mails in the person sheet ────────────────────────────────────────────────────────────────────────
describe('the person sheet\'s e-mail wraps at «@» and «.», never mid-word (UX-8)', () => {
    it('a long address: a link with <wbr> after «@», no break-all', () => {
        const FIELDS = [
            { id: 1, name: 'first_name', label: 'Nombre', role: 'first_name', type: 'text' },
            { id: 2, name: 'last_name', label: 'Apellido', role: 'last_name', type: 'text' },
            { id: 3, name: 'email', label: 'Email', role: 'email', type: 'email' },
        ];
        const p = { id: 1, first_name: 'Ana', last_name: 'Pérez', email: 'coordinacion.juvenil.bogota@iglesiaevangelica.org.co', location_id: 1, status: 'active', total_due: 250, amount_paid: 0, pending_amount: 0, returned_amount: 0, payment_status: 'unpaid', reg_code: 'X1' };
        const html = render(<PersonSheet person={p} fields={FIELDS} locations={[{ id: 1, name: 'Norte' }]} nameOf={(r: any) => `${r.first_name} ${r.last_name}`} canManage canSeeCodes canPayView={false} canPayManage={false} canAssign={false} onClose={() => {}} />);
        const a = html.match(/<a href="mailto:[^"]*"[^>]*>[\s\S]*?<\/a>/)![0];
        expect(a).not.toContain('break-all');
        expect(a).toContain('break-words');
        expect(a).toContain('@<wbr/>iglesiaevangelica');
        expect(a).toContain('coordinacion<wbr/>.juvenil');
    });
});

// ── «Contabilidad»: read-only lines ────────────────────────────────────────────────────────────────────
describe('«Contabilidad»: a read-only line says where it is managed, in words (UX-10, lock alignment)', () => {
    it('readonlyNote: transport → «Transporte»; a fee line nobody here may open → «Pagos de cuotas»; the openable fee line and manual entries → none', () => {
        expect(readonlyNote({ readonly: true, source: 'transport' }, true)).toEqual({ key: 'accounting.readonly.transport', fallback: 'Se gestiona en Transporte' });
        expect(readonlyNote({ readonly: true, source: 'inscription', transfer_id: 5 }, false)).toEqual({ key: 'accounting.readonly.fees', fallback: 'Se gestiona en Pagos de cuotas' });
        expect(readonlyNote({ readonly: true, source: 'inscription', transfer_id: null }, true)?.key).toBe('accounting.readonly.fees');
        expect(readonlyNote({ readonly: true, source: 'inscription', transfer_id: 5 }, true)).toBeNull();
        expect(readonlyNote({ readonly: false, source: 'manual' }, true)).toBeNull();
        for (const l of ['es', 'en', 'pt'] as const) for (const k of ['accounting.readonly.transport', 'accounting.readonly.fees']) expect((translations[l] as any)[k], `${l} ${k}`).toBeTruthy();
    });
    it('no hover-only faint lock is left; the note is drawn in the description, gray-600 with a gray-500 lock', () => {
        const src = read('admin/AccountingPage.tsx');
        expect(src).not.toMatch(/title=\{t\('accounting\.readonly'\)/);
        expect(src).not.toContain('className="text-gray-300"><i className="fa-solid fa-lock');
        expect(src).toMatch(/data-ledger-readonly=\{e\.source\}><i className="fa-solid fa-lock text-gray-500"/);
    });
    it('a phone movement: its actions beside the description — no row of their own with a lone lock under a gap', () => {
        const phone = LEDGER_CSS.slice(LEDGER_CSS.indexOf('(max-width: 39.99rem)'));
        expect(phone).toContain('[data-ledger-table] [data-cell="actions"] { grid-column: 2; grid-row: 2; align-self: start; }');
        expect(phone).toContain('tr[data-ledger-line]:has(> [data-cell="actions"]:not(:empty)) > [data-cell="desc"] { grid-column: 1; }');
        expect(phone).not.toContain('grid-row: 3');
    });
});

// ── one wording for what a person owes ─────────────────────────────────────────────────────────────────
describe('what a person owes reads the same everywhere (UX-11)', () => {
    it('owedWords: «debe» with nothing awaiting validation, else «falta» beside «por validar»', () => {
        expect(owedWords(25000, 0)).toMatchObject({ kind: 'due', key: 'fees.owes.due', fallback: 'debe {amount}', word: { fallback: 'debe' }, cents: 25000, pendingC: 0 });
        expect(owedWords(15000, 10000)).toMatchObject({ kind: 'left', key: 'fees.owes.left', fallback: 'falta {amount}', word: { fallback: 'falta' }, pendingC: 10000 });
        expect(owedWords(0, 10000)).toBeNull();
        for (const l of ['es', 'en', 'pt'] as const) for (const k of [OWED_TEXT.due.key, OWED_TEXT.left.key, OWED_TEXT.due.word.key, OWED_TEXT.left.word.key, 'fees.owes.pending']) expect((translations[l] as any)[k], `${l} ${k}`).toBeTruthy();
    });
    it('the picker says what the register sheet says once the person is added', () => {
        const opt = (id: number, name: string, pendingC: number) => ({ id, name, locationId: 1, locationName: 'Norte', family: '', cancelled: false, dueC: 25000, validatedC: 0, pendingC, toCoverC: 25000 - pendingC });
        const html = render(<PersonPicker options={[opt(1, 'Ángela Núñez', 0), opt(2, 'Luis Pérez', 10000)]} chosen={[]} onAdd={() => {}} onDone={() => {}} locations={[]} />);
        const angela = html.slice(html.indexOf('data-pick="1"'), html.indexOf('data-pick="2"'));
        expect(angela).toMatch(/data-picker-owed="due"[^>]*><span[^>]*>debe \$250,00<\/span><\/span>/);
        const luis = html.slice(html.indexOf('data-pick="2"'));
        expect(luis).toMatch(/data-picker-owed="left"[^>]*><span[^>]*>falta \$150,00<\/span><span[^>]*>\$100,00 por validar<\/span>/);
        expect(html).not.toMatch(/>falta \$250,00</);
    });
});

// ── «Pagos» chips and the queue card ───────────────────────────────────────────────────────────────────
describe('the status chips always count; the queue card keeps «1 persona» whole (UX-13, skeptic)', () => {
    it('«Por validar (1)», «Validado (0)», «Devuelto (0)», «Rechazado (0)»', () => {
        const html = fees('transfers');
        const chips = html.slice(html.indexOf('data-transfer-statuses=""'), html.indexOf('data-transfer-statuses=""') + 4000);
        for (const label of ['Por validar (1)', 'Validado (0)', 'Devuelto (0)', 'Rechazado (0)']) expect(chips, label).toContain(label);
    });
    it('each fact of the card is whole: a line breaks between facts only', () => {
        const html = fees('queue');
        // UX6-3: each «·» starts the fact after it — a wrap never leaves «$50,00 ·» at the end of a line.
        expect(html).toMatch(/data-queue-facts=""><span>#9<\/span><span>· Transferencia<\/span><span class="tabular-nums">· \$50,00<\/span><span>· 1 persona<\/span><\/span>/);
        expect(FEES_CSS).toContain('[data-queue-facts] > span { white-space: nowrap; }');
        // The stamp «07/10 09:00» never splits between its day and its time either.
        expect(html).toMatch(/registrado \d{2}\/\d{2} \d{2}:\d{2} por boss/);
    });
});

// ── the desktop review queue: a short payment whole, results said above the list ───────────────────────
describe('the desktop queue: the pinned bar is never over a short payment, nor a toast over the bar (live / skeptic)', () => {
    it('revealWholeDelta: a card that fits is scrolled until its end is in view, never past the sticky tabs', () => {
        // 1280 × 800: the card starts at 300, ends at 840 — 40 px under the panel's bottom; the tabs take 72 px.
        expect(revealWholeDelta({ top: 300, bottom: 840 }, { top: 0, bottom: 800 }, 72)).toBe(40);
        // Already whole, or taller than the room under the tabs: nothing.
        expect(revealWholeDelta({ top: 300, bottom: 780 }, { top: 0, bottom: 800 }, 72)).toBe(0);
        expect(revealWholeDelta({ top: 100, bottom: 900 }, { top: 0, bottom: 800 }, 72)).toBe(0);
        // A card just as tall as the room under the tabs still ends in view.
        expect(revealWholeDelta({ top: 76, bottom: 802 }, { top: 0, bottom: 800 }, 72)).toBe(2);
    });
    it('queueRoomPx: the scroll box content height under the sticky tabs, never below 240 px', () => {
        // The lab's 1280 × 800 panel: 570 px tall with 24 px paddings → 450 px for each column.
        expect(queueRoomPx({ clientHeight: 570, padTop: 24, padBottom: 24 })).toBe(450);
        expect(queueRoomPx({ clientHeight: 800, padTop: 0, padBottom: 16 })).toBe(712);
        expect(queueRoomPx({ clientHeight: 200, padTop: 24, padBottom: 24 })).toBe(240);
    });
    it('the payment card is as tall as the room: header, a scrolling body, the bar as its last row (never over the body)', () => {
        expect(FEES_CSS).toContain('[data-fees-master] > [data-fees-detail] { position: sticky; top: 4.5rem; max-height: var(--cm-queue-h, calc(100dvh - 6rem)); display: flex; flex-direction: column;');
        expect(FEES_CSS).toContain('[data-fees-detail] > [data-transfer-body] { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }');
        expect(FEES_CSS).toContain('[data-fees-master] > [data-fees-queue] { position: sticky; top: 4.5rem; max-height: var(--cm-queue-h, calc(100dvh - 6rem));');
        expect(FEES_CSS).not.toMatch(/\[data-transfer-actions\] \{ position: sticky/);
        const html = render(<TransferPanel id={8} initial={TR(8)} inline queue canManage onEdit={() => {}} />);
        // header · body · bar, in that order, the bar outside the body
        expect(html).toMatch(/data-transfer-panel="8"[\s\S]*?<div class="px-5 sm:px-8 py-5 space-y-6" data-transfer-body="">[\s\S]*?<\/div><div class="[^"]*" data-cm-sheet-foot="" data-transfer-actions="">/);
    });
    it('the queue panel opens a payment whole and says its results above the list; a sheet says them in its header', () => {
        const page = read('admin/FeePaymentsPage.tsx');
        expect(page).toContain('notify={sayInQueue} onShown={onQueueShown}');
        expect(page).toMatch(/const onQueueShown = \(t\) => \{[\s\S]*?if \(body\) body\.scrollTop = 0;[\s\S]*?requestAnimationFrame\(\(\) => revealWhole\(el\)\);/);
        expect(page).toMatch(/m\.style\.setProperty\('--cm-queue-h', `\$\{room\}px`\)/);
        expect(page).toMatch(/\{wide && queueNotice && \(\s*<p role=\{queueNotice\.type === 'error' \? 'alert' : 'status'\} data-queue-notice=/);
        const sheet = read('admin/TransferSheet.tsx');
        expect(sheet).toContain("const addToast = notify || (inline ? toast : (text: string, type = 'info') => setNotice(");
        expect(sheet).toMatch(/useEffect\(\(\) => \{ if \(t && onShown\) onShown\(t\); \}, \[t\]\);/);
        expect(sheet).toMatch(/\{notice && \(\s*<p role=\{notice\.type === 'error' \? 'alert' : 'status'\} data-panel-notice=/);
    });
});

// ── the CHANGELOG and Escape in the reason box ─────────────────────────────────────────────────────────
describe('the CHANGELOG says what Escape does in the «Devolver… / Rechazar…» reason box (skeptic)', () => {
    it('an empty reason box closes; a typed reason is kept (Cancelar discards it) — the code and the CHANGELOG agree', () => {
        const src = read('admin/TransferSheet.tsx');
        expect(src).toMatch(/pushEscape\(\(\) => \{ if \(!noteText\.current\.trim\(\)\) \{ focusBack\.current = openedBy\.current; setNoteFor\(null\); setNote\(''\); \} return true; \}\)/);
        const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').replace(/\s+/g, ' ');
        expect(log).toContain('Escape closes an empty «Devolver… / Rechazar…» reason box and keeps a typed reason («Cancelar» discards it)');
        expect(log).not.toContain('in a payment Escape closes the «Devolver… / Rechazar…» reason box, never the payment with the reason in it');
    });
});
