/**
 * conference-manager 2.18.0 — the fixes of the fifth round (the r3-1 live lab round, its skeptic and the
 * money / phone UX reviews), admin plugin side. Server-rendered or pure (node, no DOM); each pinned so that
 * undoing it fails here:
 *   - «Pagos de cuotas › Pagos» on a 1280 px window: the columns come in tiers on a size-container card —
 *     «Personas» is never 0 px, no header drawn over another, the ⋮ inside the card; what does not fit folds
 *     under the names;
 *   - «Inscripciones» on a desktop: the room and the form values WRAP (no «Hab 101 · Hotel …» behind a
 *     hover-only title), Alojamiento widens when the card has room, a chosen column that does not fit folds
 *     under the name, the column headers stay in view, the code button is 44 px;
 *   - the receipt cache knows the split generation: after «Corregir y reenviar» the admin sees the NEW receipt;
 *   - «Duplicar» is never offered on a payment that still counts (D-P10);
 *   - Escape typed in a filled field is the field's; a sheet with changes asks before discarding them; the
 *     reason form's Escape closes only the form; the «Columnas» popover closes on Escape and outside presses;
 *   - in the desktop review queue «Editar reparto · Eliminar» come first (never under the pinned bar);
 *   - screen readers hear a row's state; the «Por validar» badge passes AA; the ledger title is translated;
 *     the «Saldos» counts follow the search; references never break at their hyphen; one exact-sum wording.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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
import {
    ROSTER_CSS, ROSTER_COLUMNS_REM, ROSTER_LODGING_WIDE_REM, formIsDirty, groupByLocation, rosterLayoutFor, rosterLodgingWideRem, rosterTableMinRem, softBreaks,
} from '../../../../../marketplace/plugins/conference-manager/client/lib/roster';
import { FEE_ERROR_TEXT, RELOAD_CODES, draftIsDirty, transferActions } from '../../../../../marketplace/plugins/conference-manager/client/lib/feePayments';
import { dismissOnOutside, fieldKeepsEscape, handleEscape, isFilledField, pushEscape, SECOND_ESCAPE_MS } from '../../../../../marketplace/plugins/conference-manager/client/lib/overlay';
import { feeLineTitle, locationShare } from '../../../../../marketplace/plugins/conference-manager/client/lib/accounting';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';
import { makeTx } from '../../../../../marketplace/plugins/conference-manager/client/admin/MealScanner';
import { RosterGroup, rosterRowLabel } from '../../../../../marketplace/plugins/conference-manager/client/admin/RosterGroup';
import { PersonSheet, PersonPayments } from '../../../../../marketplace/plugins/conference-manager/client/admin/PersonSheet';
import { PersonPicker } from '../../../../../marketplace/plugins/conference-manager/client/admin/PersonPicker';
import { RegisterPaymentSheet, buildPersonOptions, initialDraft } from '../../../../../marketplace/plugins/conference-manager/client/admin/RegisterPaymentSheet';
import { TransferPanel } from '../../../../../marketplace/plugins/conference-manager/client/admin/TransferSheet';
import { ProofThumb, cachedProof, forgetProof, loadProof, rememberProof } from '../../../../../marketplace/plugins/conference-manager/client/admin/ProofViewer';
import { SegmentedControl } from '../../../../../marketplace/plugins/conference-manager/client/admin/FeeBits';
import FeePaymentsPage, {
    FEES_CSS, TRANSFER_COLS, TRANSFER_PEOPLE_MIN_REM, transferTableCss, transferTableLayout, transferTierMinRem,
} from '../../../../../marketplace/plugins/conference-manager/client/admin/FeePaymentsPage';

const CM = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client');
const read = (f: string) => fs.readFileSync(path.join(CM, f), 'utf8');
const flat = (html: string) => html.replace(/<!-- -->/g, '');
const render = (node: React.ReactElement) => flat(renderToStaticMarkup(
    <I18nProvider><ToastProvider><ModalProvider><ConferenceProvider>{node}</ConferenceProvider></ModalProvider></ToastProvider></I18nProvider>));
const REM = 16;
const PNG_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPG_B = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const txEn = makeTx((k) => (translations.en as any)[k] || k);

// ── «Pagos de cuotas › Pagos»: the desktop table at 1280 px ───────────────────────────────────────────
const TR = (id: number, extra: any = {}) => ({
    id, conference_id: 1, location_id: 1, location: 'Norte', mixed: false, amount: 600, allocated: 600, method: 'Transferencia', reference: 'TRF-1001',
    paid_on: '2026-10-07', note: null, status: 'pending', review_note: null, alloc_gen: 1, recorded_via: 'portal', recorded_by: 'portal:1',
    created_at: '2026-10-07 09:00:00', submitted_at: '2026-10-07 09:00:00', updated_at: null, updated_by: null, reviewed_at: null, reviewed_by: null,
    has_proof: true, legacy: false, people: 3,
    allocations: [{ id: 1, inscription_id: 1, amount: 250 }, { id: 2, inscription_id: 2, amount: 250 }, { id: 3, inscription_id: 3, amount: 100 }],
    flags: { cancelled_people: [], duplicate_reference: false }, ...extra,
});
const W = (id: number, extra: any) => ({ id, location_id: 1, total_due: 250, due: 250, validated: 0, pending: 0, returned: 0, to_cover: 250, credit: 0, cancelled: false, payable: true, location: 'Norte', family_group: null, status: 'active', reg_code: null, ...extra });
const PEOPLE = [W(1, { name: 'Ana Pérez', family_group: 'Pérez' }), W(2, { name: 'Luis Pérez', family_group: 'Pérez' }), W(3, { name: 'Sofía Pérez', family_group: 'Pérez', due: 100, total_due: 100, to_cover: 100 }), W(4, { name: 'Tomás Acosta' }), W(5, { name: 'Diego Torres', due: 100, total_due: 100, validated: 100, to_cover: 0 })];
const VIEW = (extra: any = {}) => ({
    conference_id: 1, features: { fee_payments: 1 }, methods: ['Efectivo', 'Transferencia'], max_people: 200, proof: { required_for: ['Transferencia'], max_chars: 1400000 },
    summary: { people: PEOPLE.length, cancelled: 0, due: 950, validated: 100, pending: 600, returned: 0, to_cover: 250, credit: 0 },
    by_location: [{ location_id: 1, location: 'Norte', people: PEOPLE.length, cancelled: 0, due: 950, validated: 100, pending: 600, returned: 0, to_cover: 250, credit: 0 }],
    counts: { pending: 1, validated: 0, returned: 1, rejected: 0, total: 2 },
    transfers: [TR(2, { status: 'returned', review_note: 'El monto no coincide: la transferencia dice 550 y el reparto 600, revisa a Sofía' }), TR(1)],
    people: PEOPLE, ...extra,
});
const fees = (section: string, extra: any = {}) => render(<FeePaymentsPage conferenceId={1} initial={{ view: VIEW(), fields: [], locations: [{ id: 1, name: 'Norte' }], section, ...extra }} />);

describe('«Pagos de cuotas › Pagos» on a desktop: «Personas» is never starved, nothing is cut at the card edge', () => {
    it('the lab\'s 1280 px window (an 844 px card): # · Fecha · Personas · Método · Total · Estado · ⋮, Localidad and Referencia folded', () => {
        // Was: 58.5rem (936 px) of fixed columns whatever the card — «Personas» 0 px, the table 92 px past its card.
        expect(transferTierMinRem(2) * REM).toBeGreaterThan(844);
        const l = transferTableLayout(844);
        expect(l.table).toBe(true);
        expect(l.cols).toEqual(['id', 'date', 'people', 'method', 'total', 'status', 'more']);
        expect(l.folded).toEqual(['location', 'reference']);
        expect(l.peoplePx).toBeGreaterThanOrEqual(200);
        // 1366 and 1440 windows: the same tier; 1536 and 1920: every column.
        for (const px of [930, 1004]) expect(transferTableLayout(px).folded).toEqual(['location', 'reference']);
        for (const px of [1100, 1484]) expect(transferTableLayout(px).folded).toEqual([]);
        // A narrow card (a tablet beside the sidebar) gets the phone list, never a squeezed table.
        expect(transferTableLayout(540).table).toBe(false);
    });
    it('at every card width the shown columns fit and «Personas» keeps its minimum', () => {
        for (let px = 400; px <= 2200; px += 4) {
            const l = transferTableLayout(px);
            if (!l.table) { expect(px).toBeLessThan(transferTierMinRem(0) * REM); continue; }
            const fixed = TRANSFER_COLS.filter((c) => l.cols.includes(c.key)).reduce((s, c) => s + c.rem, 0) * REM;
            expect(fixed + TRANSFER_PEOPLE_MIN_REM * REM, `${px}`).toBeLessThanOrEqual(px);
            expect(l.peoplePx, `${px}`).toBeGreaterThanOrEqual(TRANSFER_PEOPLE_MIN_REM * REM);
        }
    });
    it('FEES_CSS: the card is a size container; each tier hides its columns and shows their fold below its width', () => {
        const css = transferTableCss();
        expect(FEES_CSS).toContain(css);
        expect(css).toContain('[data-fees-tcard] { container: cm-fees-t / inline-size; }');
        expect(css).toContain(`@container cm-fees-t (max-width: ${(transferTierMinRem(0) - 0.01).toFixed(2)}rem) { [data-fees-tcard] [data-fees-ttable] { display: none; } [data-fees-tcard] [data-fees-tlist] { display: block; } }`);
        expect(css).toContain(`@container cm-fees-t (max-width: ${(transferTierMinRem(1) - 0.01).toFixed(2)}rem) { [data-fees-tcard] [data-tcol="date"], [data-fees-tcard] [data-tcol="method"] { display: none; } [data-fees-tcard] [data-tfold="date"], [data-fees-tcard] [data-tfold="method"] { display: inline; } }`);
        expect(css).toContain(`@container cm-fees-t (max-width: ${(transferTierMinRem(2) - 0.01).toFixed(2)}rem) { [data-fees-tcard] [data-tcol="location"], [data-fees-tcard] [data-tcol="reference"] { display: none; } [data-fees-tcard] [data-tfold="location"], [data-fees-tcard] [data-tfold="reference"] { display: inline; } }`);
        expect(css).toContain('[data-fees-tcard] [data-tfold] { display: none; }');
    });
    it('the table: widths on the header cells (no fixed colgroup), every cell named, the folds under the names, nothing truncated', () => {
        const html = fees('transfers');
        const table = html.slice(html.indexOf('data-fees-ttable=""'));
        expect(html).toContain('data-fees-tcard=""');
        expect(html).not.toContain('<colgroup>');
        for (const c of TRANSFER_COLS) {
            if (c.rem) expect(table).toMatch(new RegExp(`<th scope="col" data-tcol="${c.key}" style="width:${c.rem}rem"`));
            else expect(table).toMatch(new RegExp(`<th scope="col" data-tcol="${c.key}" class=`));
        }
        expect(table).toMatch(/data-tcol="people" class="px-3 py-2\.5"><span class="block text-xs font-bold text-gray-900 break-words">Ana\u00a0P\., Luis\u00a0P\.\u00a0\+1<\/span>/);
        expect(table).toMatch(/data-tfold="location"><i class="fa-solid fa-location-dot mr-1" aria-hidden="true"><\/i>Norte<\/span>/);
        expect(table).toMatch(/data-tfold="reference"><span data-ref="" style="display:inline-block;max-width:100%;overflow-wrap:anywhere">Ref\. TRF-1001<\/span>/);
        expect(table).toMatch(/data-tfold="date">[\s\S]*?07\/10\/2026<\/span><span data-tfold="method">Transferencia<\/span>/);
        expect(table).not.toMatch(/truncate/);
        expect(table).toMatch(/data-tcol="more" class="px-1 py-1\.5 text-right"><button[^>]*aria-label="Abrir el pago #2"/);
    });
    it('a phone row: the returned payment\'s note on two lines broken between words, never one line cut mid-word', () => {
        const html = fees('transfers');
        const list = html.slice(html.indexOf('data-fees-tlist=""'), html.indexOf('data-fees-ttable=""'));
        expect(list).toMatch(/<span class="block text-\[11px\] font-bold text-orange-800 line-clamp-2 break-words" data-transfer-note="">«El monto no coincide/);
        expect(list).not.toContain('truncate');
    });
    it('«Solo Pagos» (payments:view) gets the same table: the names come with the view', () => {
        const src = read('admin/FeePaymentsPage.tsx');
        expect(src).not.toMatch(/tableLayout: 'fixed' \}\}>\s*<colgroup>/);
        expect(src).toContain('{peopleLabel(t.allocations, nameOf)}</span>');
    });
});

// ── «Inscripciones»: nothing cut behind a hover-only title ───────────────────────────────────────────
const FIELDS = [
    { id: 1, name: 'first_name', label: 'Nombre', role: 'first_name', type: 'text' },
    { id: 2, name: 'last_name', label: 'Apellido', role: 'last_name', type: 'text' },
    { id: 3, name: 'email', label: 'Email', role: 'email', type: 'text' },
    { id: 4, name: 'phone', label: 'Teléfono', role: 'phone', type: 'text' },
    { id: 5, name: 'church', label: 'Iglesia', type: 'text' },
];
const LOCS = [{ id: 1, name: 'Bogotá', lodging_status: 'draft' }];
const ROWS = [
    { id: 1, first_name: 'Diego', last_name: 'Torres', email: 'diego.torres.romero@example.test', phone: '+57 300 1', church: 'Betel', location_id: 1, status: 'active', total_due: 250, amount_paid: 200, pending_amount: 50, returned_amount: 0, payment_status: 'partial', reg_code: '46UJF5DX73', room_id: 7, room_number: '101', hotel_name: 'Hotel Central' },
    { id: 2, first_name: 'Tomás', last_name: 'Acosta', location_id: 1, status: 'active', total_due: 250, amount_paid: 0, pending_amount: 0, returned_amount: 0, payment_status: 'unpaid', reg_code: 'ZYVEAC8Z6Q', room_id: null },
    { id: 3, first_name: 'Mateo', last_name: 'Pérez', location_id: 1, status: 'cancelled', total_due: 0, amount_paid: 0, pending_amount: 0, returned_amount: 0, payment_status: 'paid', reg_code: 'MMMMMMMMMM', room_id: null },
];
const nameOf = (p: any) => `${p.first_name} ${p.last_name}`;
const group = groupByLocation(ROWS as any, LOCS as any, 'Sin localidad').find((g) => g.key === '1')!;
const roster = (cols = [FIELDS[2], FIELDS[3], FIELDS[4]]) => render(<RosterGroup group={group} page={1} size={20} onPage={() => {}} collapsed={false} onToggle={() => {}}
    columns={cols} nameOf={nameOf} canSeeCodes onOpen={() => {}} onBarcode={() => {}} />);

describe('«Inscripciones» desktop table: the room and the form values wrap; a column that does not fit folds under the name', () => {
    const html = roster();
    const table = html.slice(html.indexOf('data-cm-roster-table'));
    it('Alojamiento: the whole «Hab 101 · Hotel Central», wrapping — no truncate, no hover title', () => {
        expect(table).toMatch(/<td class="px-3 py-2\.5 text-xs font-bold text-gray-700 break-words" data-cell="lodging">Hab 101 · Hotel Central<\/td>/);
        expect(table).not.toMatch(/title="Hotel Central/);
        expect(table).toMatch(/<th scope="col" style="width:8rem" data-cm-col="lodging"/);
    });
    it('Alojamiento widens to 13rem once every chosen column fits with room to spare (1920 px), stays 8rem at 1280', () => {
        expect(rosterLayoutFor(1504, true, 3)).toEqual({ table: true, fields: 3, folded: 0, lodgingRem: ROSTER_LODGING_WIDE_REM });
        expect(rosterLayoutFor(862, true, 3)).toEqual({ table: true, fields: 1, folded: 2, lodgingRem: ROSTER_COLUMNS_REM.lodging });
        // At the widened size every form column still keeps its minimum.
        for (const codes of [true, false]) for (const k of [1, 2, 3]) {
            expect(ROSTER_CSS).toContain(`@container cm-roster (min-width: ${rosterLodgingWideRem(codes, k)}rem) { [data-cm-roster-card][data-codes="${codes ? 1 : 0}"][data-fcols="${k}"] [data-cm-col="lodging"] { width: ${ROSTER_LODGING_WIDE_REM}rem !important; } }`);
            expect(rosterLodgingWideRem(codes, k)).toBe(rosterTableMinRem(codes, k) + ROSTER_LODGING_WIDE_REM - ROSTER_COLUMNS_REM.lodging);
        }
        expect(html).toContain('data-fcols="3"');
    });
    it('a form value wraps at the e-mail\'s own points (after «@», before «.») — never «diego.torres.ro…» with a hover title', () => {
        expect(softBreaks('diego.torres.romero@example.test')).toEqual(['diego', '.torres', '.romero@', 'example', '.test']);
        expect(softBreaks('diego.torres.romero@example.test').join('')).toBe('diego.torres.romero@example.test');
        expect(softBreaks('Betel')).toEqual(['Betel']);
        expect(softBreaks('Iglesia Bautista Central del Norte')).toEqual(['Iglesia Bautista Central del Norte']);
        expect(table).toMatch(/<td data-cm-fcol="1" class="px-3 py-2\.5 text-xs font-medium text-gray-700 break-words">diego<wbr\/>\.torres<wbr\/>\.romero@<wbr\/>example<wbr\/>\.test<\/td>/);
        expect(table).not.toMatch(/data-cm-fcol="\d"[^>]*truncate/);
        expect(table).not.toMatch(/title="diego/);
        // Long headers wrap too.
        expect(table).toMatch(/<th scope="col" data-cm-fcol="3" class="[^"]*break-words">Iglesia<\/th>/);
    });
    it('a chosen column the card has no room for folds under the name («Teléfono: +57 300 1»), shown only below its width', () => {
        expect(table).toMatch(/data-cm-ffold="2" class="mt-0\.5 text-\[11px\] font-medium text-gray-600 break-words"><span class="font-black text-gray-500">Teléfono:<\/span> \+57 300 1<\/span>/);
        expect(table).toMatch(/data-cm-ffold="3"[^>]*><span class="font-black text-gray-500">Iglesia:<\/span> Betel<\/span>/);
        expect(ROSTER_CSS).toContain('[data-cm-ffold] { display: none; }');
        for (const codes of [1, 0]) for (const k of [1, 2, 3]) {
            expect(ROSTER_CSS).toContain(`@container cm-roster (max-width: ${(rosterTableMinRem(!!codes, k) - 0.01).toFixed(2)}rem) { [data-cm-roster-card][data-codes="${codes}"] [data-cm-fcol="${k}"] { display: none; } [data-cm-roster-card][data-codes="${codes}"] [data-cm-ffold="${k}"] { display: block; } }`);
        }
        // Tomás has no answers: no empty «Email:» lines under his name.
        const tomas = table.slice(table.indexOf('data-roster-tr="2"'), table.indexOf('data-roster-tr="3"'));
        expect(tomas).not.toContain('data-cm-ffold');
    });
    it('the «Columnas» hint says a column that does not fit shows under the name', () => {
        expect(translations.es['roster.columns.hint']).toContain('bajo el nombre');
        expect(translations.en['roster.columns.hint']).toContain('under the name');
        expect(translations.pt['roster.columns.hint']).toContain('sob o nome');
    });
    it('the column headers stay in view under the card\'s sticky header (opaque), and the code button is 44 px', () => {
        expect(ROSTER_CSS).toContain('[data-cm-roster-table] thead th { position: sticky; top: var(--cm-roster-head-h, 4.75rem); z-index: 4; background-color: #f9fafb;');
        expect(ROSTER_CSS).toMatch(/@media \(min-width: 768px\) and \(min-height: 600px\) \{\s*\[data-cm-roster-table\] thead th \{ top: calc\(var\(--cm-roster-head-h, 4\.75rem\) - 1\.5rem\); \}/);
        const src = read('admin/RosterGroup.tsx');
        expect(src).toContain("style={headH ? ({ '--cm-roster-head-h': `${headH}px` } as any) : undefined}");
        expect(src).toMatch(/ro = new ResizeObserver\(measure\); ro\.observe\(el\);/);
        expect(table).toMatch(/<button type="button" title="Código de inscripción" class="inline-flex items-center gap-1\.5 min-h-\[44px\]/);
        expect(table).not.toContain('min-h-[36px]');
    });
});

describe('screen readers hear a row\'s state', () => {
    const tx = makeTx((k) => (translations.es as any)[k] || k);
    it('a phone row is named by the person AND what it shows — never just «Ver ficha de …»', () => {
        expect(rosterRowLabel(tx, 'Diego Torres', ROWS[0])).toBe('Diego Torres: Abono, $200,00 de $250,00, Hab 101 · Hotel Central, $50,00 por validar');
        expect(rosterRowLabel(tx, 'Tomás Acosta', ROWS[1])).toBe('Tomás Acosta: Sin pagar, $0,00 de $250,00, Sin habitación');
        expect(rosterRowLabel(tx, 'Mateo Pérez', ROWS[2])).toBe('Mateo Pérez: Cancelada, Sin habitación');
        const html = roster();
        expect(html).toContain('data-cm-roster-row="2" aria-haspopup="dialog" aria-label="Tomás Acosta: Sin pagar, $0,00 de $250,00, Sin habitación"');
        expect(html).not.toContain('Ver ficha de');
    });
    it('the desktop Pago pill says its state: «Abono: pagos de Diego Torres»', () => {
        expect(roster()).toMatch(/<button type="button" class="[^"]*" aria-label="Abono: pagos de Diego Torres" data-pay-pill="partial"/);
        for (const l of ['es', 'en', 'pt'] as const) expect((translations[l] as any)['roster.pay.open.state']).toContain('{state}');
    });
});

// ── the receipt cache knows the split generation (MP-1) ─────────────────────────────────────────────────
describe('a receipt replaced by «Corregir y reenviar» is never shown from the cache', () => {
    it('loadProof: the same payment at a new generation is fetched again', async () => {
        forgetProof(9);
        const fetcher = vi.fn(async () => ({ proof: PNG_A }));
        expect(await loadProof(9, 1, fetcher)).toBe(PNG_A);
        expect(await loadProof(9, 1, fetcher)).toBe(PNG_A);
        expect(fetcher).toHaveBeenCalledTimes(1);
        const fetcherB = vi.fn(async () => ({ proof: JPG_B }));
        expect(await loadProof(9, 2, fetcherB)).toBe(JPG_B);
        expect(fetcherB).toHaveBeenCalledTimes(1);
        forgetProof(9);
        expect(cachedProof(9, 1)).toBeUndefined();
        expect(cachedProof(9, 2)).toBeUndefined();
    });
    it('the review queue shows #7 at its new generation without the old receipt A', () => {
        rememberProof(7, 1, PNG_A);
        const at1 = render(<ProofThumb transferId={7} hasProof allocGen={1} />);
        expect(at1).toContain(`src="${PNG_A}"`);
        const at2 = render(<ProofThumb transferId={7} hasProof allocGen={2} />);
        expect(at2).not.toContain(PNG_A);
        expect(at2).toContain('data-proof="loading"');
        // The payment panel passes the generation it shows.
        const panel = render(<TransferPanel id={7} initial={TR(7, { alloc_gen: 2 })} inline queue canManage onEdit={() => {}} />);
        expect(panel).not.toContain(PNG_A);
        expect(render(<TransferPanel id={7} initial={TR(7, { alloc_gen: 1 })} inline queue canManage onEdit={() => {}} />)).toContain(PNG_A);
        forgetProof(7);
    });
});

// ── «Duplicar» (MP-2) ──────────────────────────────────────────────────────────────────────────────────
describe('«Duplicar» only once the payment no longer counts (D-P10)', () => {
    it('a validated payment offers «Anular validación…», never «Duplicar»; a voided one offers «Duplicar»', () => {
        expect(transferActions('validated', true).duplicate).toBe(false);
        expect(transferActions('rejected', true).duplicate).toBe(true);
        const html = render(<TransferPanel id={4} initial={TR(4, { status: 'validated' })} canManage onEdit={() => {}} onDuplicate={() => {}} />);
        expect(html).not.toContain('data-act="duplicate"');
        expect(html).toContain('data-act="void"');
    });
    it('the server\'s 409 proof_source_live has words in es / en / pt and reloads what is shown', () => {
        expect(FEE_ERROR_TEXT.proof_source_live).toMatch(/Anula \(rechaza\) el pago de origen/);
        expect(RELOAD_CODES.has('proof_source_live')).toBe(true);
        for (const l of ['es', 'en', 'pt'] as const) expect((translations[l] as any)['fees.error.proof_source_live']).toBeTruthy();
        expect(read('admin/RegisterPaymentSheet.tsx')).not.toContain('data-duplicate-validated');
    });
});

// ── Escape (UX-R5-1) ───────────────────────────────────────────────────────────────────────────────────
describe('Escape typed in a filled field is the field\'s; a sheet with changes asks before discarding them', () => {
    const input = (type: string, value: string) => ({ tagName: 'INPUT', type, value });
    it('isFilledField: text-like inputs, textareas and editable regions holding text', () => {
        expect(isFilledField(input('search', 'ana'))).toBe(true);
        expect(isFilledField(input('text', '250'))).toBe(true);
        expect(isFilledField(input('', 'x'))).toBe(true);
        expect(isFilledField(input('search', ''))).toBe(false);
        expect(isFilledField(input('checkbox', 'on'))).toBe(false);
        expect(isFilledField(input('date', '2026-10-08'))).toBe(false);
        expect(isFilledField({ tagName: 'TEXTAREA', value: 'Comprobante ilegible' })).toBe(true);
        expect(isFilledField({ tagName: 'DIV', isContentEditable: true, textContent: ' x ' })).toBe(true);
        expect(isFilledField({ tagName: 'BUTTON' })).toBe(false);
        expect(isFilledField(null)).toBe(false);
    });
    it('fieldKeepsEscape: the first Escape in a filled field is kept; a second one in the same field soon after goes to the sheet', () => {
        const a = input('text', 'Juan');
        expect(fieldKeepsEscape(a, 1000)).toBe(true);
        expect(fieldKeepsEscape(a, 1000 + SECOND_ESCAPE_MS - 1)).toBe(false);
        expect(fieldKeepsEscape(a, 5000)).toBe(true);
        expect(fieldKeepsEscape(a, 5000 + SECOND_ESCAPE_MS + 1)).toBe(true);
        expect(fieldKeepsEscape(input('search', ''), 9000)).toBe(false);
        expect(fieldKeepsEscape({ tagName: 'BUTTON' }, 9001)).toBe(false);
    });
    describe('the document listener', () => {
        const listeners: ((e: any) => void)[] = [];
        let saved: any;
        beforeAll(() => {
            saved = (globalThis as any).document;
            (globalThis as any).document = { addEventListener: (t: string, h: (e: any) => void) => { if (t === 'keydown') listeners.push(h); }, removeEventListener: () => {} };
        });
        afterAll(() => { (globalThis as any).document = saved; });
        it('Escape in the picker\'s search box does not close «Registrar pago»; Escape on a button does', () => {
            const onClose = vi.fn();
            const release = pushEscape(() => { onClose(); return true; });
            expect(listeners.length).toBe(1);
            const key = (target: any) => { const e = { key: 'Escape', target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; listeners[0](e); return e; };
            const e1 = key(input('search', 'ana'));
            expect(onClose).not.toHaveBeenCalled();
            expect(e1.defaultPrevented).toBe(false);        // the browser still clears the search box
            key({ tagName: 'BUTTON' });
            expect(onClose).toHaveBeenCalledTimes(1);
            release();
        });
    });
    it('draftIsDirty: people, money (as money), the split, a receipt, the words — not a re-typed «250» as «250,00»', () => {
        const opts = buildPersonOptions(ROWS as any, nameOf, LOCS as any);
        const start = initialDraft({ mode: 'create', ids: [2], options: opts, methods: ['Efectivo'] });
        expect(draftIsDirty(start, start)).toBe(false);
        expect(draftIsDirty(start, { ...start, amount: start.amount.replace(',00', '') })).toBe(false);
        expect(draftIsDirty(start, { ...start, people: [2, 1] })).toBe(true);
        expect(draftIsDirty(start, { ...start, amount: '100' })).toBe(true);
        expect(draftIsDirty(start, { ...start, proof: PNG_A })).toBe(true);
        expect(draftIsDirty(start, { ...start, note: 'pagó en dos partes' })).toBe(true);
        expect(draftIsDirty(start, { ...start, reference: 'TRF-1' })).toBe(true);
        expect(draftIsDirty(start, { ...start, mode: 'manual', manual: { 2: '250' } })).toBe(true);
        expect(draftIsDirty(start, { ...start, leavePending: true })).toBe(true);
        expect(draftIsDirty(start, { ...start, clientKey: 'kOther', proofWorking: true })).toBe(false);
        const edit = initialDraft({ mode: 'edit', transfer: { ...TR(5), has_proof: 1 }, options: opts, methods: ['Transferencia'] });
        expect(draftIsDirty(edit, { ...edit, proof: null })).toBe(true);   // the kept receipt removed
    });
    it('formIsDirty: an untouched form (new or edited) is clean; any typed change is not', () => {
        expect(formIsDirty({}, null)).toBe(false);
        expect(formIsDirty({ first_name: '', notes: '' }, null)).toBe(false);
        expect(formIsDirty({ first_name: 'Ana' }, null)).toBe(true);
        const seed = { id: 1, first_name: 'Ana', location_id: 3, custom_data: { a: 1 }, notes: '', paid: false };
        expect(formIsDirty({ ...seed }, seed)).toBe(false);
        expect(formIsDirty({ ...seed, location_id: '3' }, seed)).toBe(false);
        expect(formIsDirty({ ...seed, location_id: '4' }, seed)).toBe(true);
        expect(formIsDirty({ ...seed, notes: 'llega tarde' }, seed)).toBe(true);
        expect(formIsDirty({ ...seed, first_name: '' }, seed)).toBe(true);
    });
    it('the sheets ask before throwing changes away; the reason form keeps its Escape; the «Columnas» popover closes on Escape', () => {
        const reg = read('admin/RegisterPaymentSheet.tsx');
        expect(reg).toContain('const startDraft = useRef<FeeDraft>(draft).current;');
        expect(reg).toMatch(/if \(!draftIsDirty\(startDraft, draft\) \|\| !confirm\) \{ onClose\(\); return; \}\s*if \(await confirm\(tx\('fees\.register\.discard\.confirm'/);
        expect(reg).toContain('<Overlay layer={layer} onEscape={escapeClose}>');
        const page = read('admin/page.tsx');
        expect(page).toMatch(/if \(!formIsDirty\(formData, formOriginal\)\) \{ closeForm\(\); return; \}\s*if \(await confirm\(tx\('form\.discard\.confirm'/);
        expect(page).toContain('<Overlay layer={LAYER.modal} onEscape={escapeForm}>');
        const panel = read('admin/TransferSheet.tsx');
        expect(panel).toContain("useEffect(() => (noteFor ? pushEscape(() => { if (!noteText.current.trim()) { focusBack.current = openedBy.current; setNoteFor(null); setNote(''); } return true; }) : undefined), [noteFor]);");
        const filters = read('admin/RosterFilters.tsx');
        expect(filters).toMatch(/const offEscape = pushEscape\(\(\) => \{ setOpen\(false\);[^\n]*return true; \}\);/);
        expect(filters).toMatch(/const offOutside = dismissOnOutside\(typeof document !== 'undefined' \? document : null, rootRef\.current, \(\) => setOpen\(false\)\);/);
        expect(filters).toMatch(/\}, \[open\]\);/);
        for (const l of ['es', 'en', 'pt'] as const) for (const k of ['fees.register.discard', 'fees.register.discard.confirm', 'form.discard', 'form.discard.confirm', 'form.keep.editing']) expect((translations[l] as any)[k], `${l} ${k}`).toBeTruthy();
    });
    it('dismissOnOutside: a press outside the popover (the admin sidebar too) closes it; inside it does not', () => {
        const handlers: Record<string, (e: any) => void> = {};
        const doc = { addEventListener: (t: string, h: (e: any) => void, c?: boolean) => { if (c) handlers[t] = h; }, removeEventListener: (t: string) => { delete handlers[t]; } };
        const inside = { id: 'checkbox' };
        const root = { contains: (n: any) => n === inside };
        const onClose = vi.fn();
        const release = dismissOnOutside(doc, root, onClose);
        handlers.pointerdown({ target: inside });
        expect(onClose).not.toHaveBeenCalled();
        handlers.pointerdown({ target: { id: 'sidebar-link' } });
        expect(onClose).toHaveBeenCalledTimes(1);
        release();
        expect(handlers.pointerdown).toBeUndefined();
    });
});

// ── the review queue: corrections never under the pinned bar (L6) ─────────────────────────────────────
describe('«Editar reparto · Eliminar» in the desktop review queue sit at the top of the payment', () => {
    it('inline (the queue beside the list): before the receipt; in the sheet: at the end', () => {
        const inline = render(<TransferPanel id={8} initial={TR(8, { method: 'Efectivo', reference: null, has_proof: false })} inline queue canManage onEdit={() => {}} />);
        expect(inline.indexOf('data-transfer-secondary="top"')).toBeGreaterThan(-1);
        expect(inline.indexOf('data-transfer-secondary="top"')).toBeLessThan(inline.indexOf('data-proof='));
        expect(inline).not.toContain('data-transfer-secondary="end"');
        const sheet = render(<TransferPanel id={8} initial={TR(8, { method: 'Efectivo', reference: null, has_proof: false })} canManage onEdit={() => {}} />);
        expect(sheet.indexOf('data-transfer-secondary="end"')).toBeGreaterThan(sheet.indexOf('data-transfer-parts'));
    });
});

// ── small ones ─────────────────────────────────────────────────────────────────────────────────────────
describe('the «+ Añadir» search, the badge, «Saldo», references, the sum line, the empty submit', () => {
    it('the picker\'s placeholder fits a 16 px field on a 320 px phone in es / en / pt; the whole hint is its name', () => {
        for (const l of ['es', 'en', 'pt'] as const) expect((translations[l] as any)['fees.picker.search'].length, l).toBeLessThanOrEqual(18);
        const html = render(<PersonPicker options={[]} chosen={[]} onAdd={() => {}} onDone={() => {}} locations={[]} />);
        // Round 7 (label in name): the name starts with the visible words.
        expect(html).toContain('placeholder="Buscar persona" aria-label="Buscar persona por nombre, grupo o localidad"');
    });
    it('the «Por validar (N)» badge: white on amber-700 (AA), not amber-500 (~2.2:1)', () => {
        const html = render(<SegmentedControl label="x" value="summary" onChange={() => {}} options={[{ key: 'summary', label: 'Resumen' }, { key: 'queue', label: 'Por validar', badge: 3 }]} />);
        expect(html).toContain('class="px-1.5 py-0.5 rounded-full text-[10px] bg-amber-700 text-white" data-seg-badge="">3</span>');
        expect(html).not.toContain('bg-amber-500');
    });
    it('the person sheet: «Saldo $50,00» is its own item — no line starting with «·»', () => {
        const html = render(<PersonSheet person={ROWS[0]} fields={FIELDS} locations={LOCS} nameOf={nameOf} canManage canSeeCodes canPayView={false} canPayManage={false} canAssign={false} onClose={() => {}} />);
        expect(html).toContain('<span class="text-sm font-bold text-gray-600 whitespace-nowrap" data-person-saldo="">Saldo $50,00</span>');
        expect(html).not.toMatch(/>· Saldo/);
    });
    it('a reference never breaks after «Ref.» or at its hyphen: person sheet, payment header, queue card', () => {
        const parts = render(<PersonPayments tx={makeTx((k) => k)} onOpen={null} parts={[{ id: 1, amount: 100, date: '2026-10-01', method: 'Transferencia', reference: 'TRF-1001', status: 'validated', transfer_id: 5, transfer: { people: 1, amount: 100 } }]} />);
        // (a fact of its own since UX6-3, its «·» leading)
        expect(parts).toContain('<span style="white-space:nowrap" data-fact="">· Transferencia</span><span data-ref="" style="display:inline-block;max-width:100%;overflow-wrap:anywhere">· TRF-1001</span>');
        const head = render(<TransferPanel id={3} initial={TR(3, { reference: 'KEEP-77' })} canManage />);
        expect(head).toContain('<span data-ref="" style="display:inline-block;max-width:100%;overflow-wrap:anywhere">· Ref. KEEP-77</span>');
        const queue = fees('queue');
        // (its «·» leading and glued to it since UX6-3)
        expect(queue).toMatch(/data-queue-item="1"[\s\S]*?<span data-ref="" style="display:inline-block;max-width:100%;overflow-wrap:anywhere">·\u00a0Ref\. TRF-1001<\/span>/);
    });
    it('one exact-sum wording, the portal\'s: «Asignado $X de $Y» · «✓ Cuadra» / «Faltan» / «Sobran» — in the payment and the register sheet', () => {
        const panel = render(<TransferPanel id={3} initial={TR(3)} canManage />);
        expect(panel).toMatch(/data-sum-line=""><p data-split-state="ok"[^>]*><span class="tabular-nums">Asignado \$600,00 de \$600,00<\/span><span><i class="fa-solid fa-check mr-1" aria-hidden="true"><\/i>Cuadra<\/span><\/p>/);
        expect(panel).not.toContain('= reparto');
        const opts = buildPersonOptions(ROWS as any, nameOf, LOCS as any);
        const reg = render(<RegisterPaymentSheet mode="create" conferenceId={1} options={opts} ids={[2]} methods={['Efectivo']} onClose={() => {}} />);
        expect(reg).toMatch(/<p data-split-state="ok"[^>]*><span class="tabular-nums">Asignado \$250,00 de \$250,00<\/span><span><i class="fa-solid fa-check mr-1" aria-hidden="true"><\/i>Cuadra<\/span>/);
        for (const l of ['es', 'en', 'pt'] as const) expect((translations[l] as any)['fees.split.ok']).toBeTruthy();
    });
    it('an empty «Registrar pago» reads «Registrar pago», never «Registrar pago $0,00»', () => {
        const opts = buildPersonOptions(ROWS as any, nameOf, LOCS as any);
        const empty = render(<RegisterPaymentSheet mode="create" conferenceId={1} options={opts} ids={[]} methods={['Efectivo']} onClose={() => {}} />);
        expect(empty).toMatch(/data-register-submit=""[^>]*><i class="fa-solid fa-check" aria-hidden="true"><\/i>Registrar pago<\/button>/);
        expect(empty).not.toContain('$0,00</button>');
    });
    it('the reference field says what the portal says: «Referencia de la transferencia» / «Referencia (opcional)»', () => {
        const opts = buildPersonOptions(ROWS as any, nameOf, LOCS as any);
        const transfer = render(<RegisterPaymentSheet mode="create" conferenceId={1} options={opts} ids={[2]} methods={['Transferencia']} onClose={() => {}} />);
        expect(transfer).toContain('<label for="fee-ref" class="block text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1 mb-1">Referencia de la transferencia</label>');
        const cash = render(<RegisterPaymentSheet mode="edit" conferenceId={1} options={opts} transfer={TR(6, { method: 'Efectivo', reference: 'RECIBO-9', allocations: [{ id: 1, inscription_id: 2, amount: 250, due: 250, validated_other: 0, pending_other: 0 }], amount: 250 })} methods={['Efectivo']} onClose={() => {}} />);
        expect(cash).toContain('>Referencia (opcional)</label>');
    });
});

describe('«Saldos»: the chip counts follow the search, as «Participantes» does', () => {
    it('searching «perez» shows the three Pérez rows and every chip counts among them', () => {
        const html = fees('balances', { bq: 'perez' });
        expect((html.match(/data-balance-row="/g) || []).length).toBe(3);
        expect(html).toMatch(/data-balance-filter="owing">Con saldo \(3\)</);
        expect(html).toMatch(/data-balance-filter="all">Todos \(3\)</);
        const all = fees('balances');
        expect(all).toMatch(/data-balance-filter="all">Todos \(5\)</);
    });
});

describe('the ledger title is translated, and one kind of payment has one name', () => {
    it('feeLineTitle: «Fee payment · 3 people» in English; «Pago de cuotas · 1 persona», never «Pago de inscripción», for a 2.18 payment', () => {
        const line = (extra: any) => ({ source: 'inscription' as const, transfer_id: 5, people: 3, description: 'Pago de cuotas · 3 personas', allocations: [], ...extra });
        // (a no-break space keeps each count with its noun — round 8, PUX-5 — and the «·» with the count, UX6-4)
        expect(feeLineTitle(line({}), txEn)).toBe('Fee payment ·\u00a03\u00a0people');
        expect(feeLineTitle(line({ people: 1, description: 'Pago de inscripción' }))).toBe('Pago de cuotas ·\u00a01\u00a0persona');
        expect(feeLineTitle(line({ people: 1 }), txEn)).toBe('Fee payment ·\u00a01\u00a0person');
        expect(feeLineTitle({ source: 'inscription', transfer_id: null, description: 'Pago de inscripción' } as any, txEn)).toBe('Pago de inscripción');
        expect(feeLineTitle({ source: 'manual', transfer_id: null, description: 'Arriendo del salón' } as any, txEn)).toBe('Arriendo del salón');
        const share = locationShare({ id: 't', kind: 'income', date: '2026-10-01', description: 'Pago de cuotas · 3 personas', amount: 600, source: 'inscription', readonly: true, transfer_id: 5, people: 3,
            allocations: [{ inscription_id: 1, amount: 250 }, { inscription_id: 2, amount: 250 }, { inscription_id: 3, amount: 100 }] } as any, '2', new Map([[1, 1], [2, 1], [3, 2]]))!;
        expect(feeLineTitle(share, txEn)).toBe('Fee payment ·\u00a01\u00a0of 3\u00a0people');
        expect(feeLineTitle(share)).toBe('Pago de cuotas ·\u00a01\u00a0de 3\u00a0personas');
    });
    it('Contabilidad draws the title (both forms of the line) through feeLineTitle in the admin\'s language', () => {
        const src = read('admin/AccountingPage.tsx');
        expect(src.match(/feeLineTitle\(e, tx\)/g) || []).toHaveLength(2);
        expect(src).not.toMatch(/\}\{e\.description\}|\) : e\.description\}/);
    });
});

describe('Spanish words: one name per thing', () => {
    it('«Alojamiento» (never «Hospedaje» beside it), «Todas las localidades» in lower case', () => {
        expect(translations.es['roster.filter.room']).toBe('Alojamiento');
        expect(translations.es['roster.filter.room.all']).toBe('Alojamiento: todos');
        expect(translations.es['all.locations']).toBe('Todas las localidades');
        expect(translations.pt['all.locations']).toBe('Todas as localidades');
        expect(read('admin/RosterFilters.tsx')).not.toContain('Hospedaje');
    });
});
