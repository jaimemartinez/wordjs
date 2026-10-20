/**
 * conference-manager 2.18.0 — the two screens server-rendered with data in hand (`initial`), so every part is
 * drawn without a browser:
 *   - «Inscripciones»: one card per location (Sin localidad last), the compact list and the slim table,
 *     the toolbar (search, «Por validar (N)», «Ocultar canceladas», Mostrar, Columnas), cancelled rows marked,
 *     the count line; nothing from the old payments modal;
 *   - «Pagos de cuotas»: Resumen (KPIs, the bar, per location), Por validar (oldest first, warnings),
 *     Pagos (filters, phone rows + table), Saldos («Con saldo» by default, 44 px boxes, page selection);
 *     (the permission matrices are pinned in feeSheets.test.tsx).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('react-dom', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-dom')>();
    return { ...actual, createPortal: (node: React.ReactNode) => node };
});

import { I18nProvider } from '@/contexts/I18nContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { ModalProvider } from '@/contexts/ModalContext';
import { ConferenceProvider } from '../../../../../marketplace/plugins/conference-manager/client/contexts/ConferenceContext';
import { InscriptionsPage } from '../../../../../marketplace/plugins/conference-manager/client/admin/page';
import FeePaymentsPage from '../../../../../marketplace/plugins/conference-manager/client/admin/FeePaymentsPage';

const flat = (html: string) => html.replace(/<!-- -->/g, '');
const render = (node: React.ReactElement) => flat(renderToStaticMarkup(
    <I18nProvider><ToastProvider><ModalProvider><ConferenceProvider>{node}</ConferenceProvider></ModalProvider></ToastProvider></I18nProvider>));

const FIELDS = [
    { id: 1, conference_id: 1, name: 'first_name', label: 'Nombre', role: 'first_name', type: 'text', is_required: 1, sort_order: 1 },
    { id: 2, conference_id: 1, name: 'last_name', label: 'Apellido', role: 'last_name', type: 'text', is_required: 1, sort_order: 2 },
    { id: 3, conference_id: 1, name: 'church', label: 'Iglesia', type: 'text', is_required: 0, sort_order: 3 },
];
const LOCS = [{ id: 1, name: 'Norte', lodging_status: 'draft' }, { id: 2, name: 'Centro', lodging_status: 'draft' }];
const ROW = (id: number, extra: any) => ({ id, conference_id: 1, status: 'active', payment_status: 'unpaid', total_due: 500, amount_paid: 0, pending_amount: 0, returned_amount: 0, reg_code: `C${id}`, ...extra });
const ROWS = [
    ROW(1, { first_name: 'Ana', last_name: 'Pérez', location_id: 1, payment_status: 'partial', amount_paid: 100, pending_amount: 150, church: 'Betel' }),
    ROW(2, { first_name: 'Luis', last_name: 'Gómez', location_id: 2 }),
    ROW(3, { first_name: 'Eva', last_name: 'Ruiz', location_id: null, status: 'cancelled' }),
];

describe('«Inscripciones» (admin)', () => {
    const html = render(<InscriptionsPage conferenceId={1} initial={{ rows: ROWS as any, fields: FIELDS as any, locations: LOCS as any }} />);
    it('one card per location, «Sin localidad» last, each with its list and its table', () => {
        const groups = [...html.matchAll(/data-roster-group="([^"]+)"/g)].map((m) => m[1]);
        expect(groups).toEqual(['2', '1', 'none']);
        expect(html.match(/data-cm-roster-list=""/g)).toHaveLength(3);
        expect(html.match(/data-cm-roster-table=""/g)).toHaveLength(3);
        expect(html).toContain('3 de 3 inscripciones');
    });
    it('the toolbar: instant search, «Por validar (1)», «Ocultar canceladas», Mostrar, Columnas, the phone row', () => {
        expect(html).toContain('data-roster-search=""');
        expect(html).toMatch(/data-filter-pending=""[^>]*>[\s\S]*?Por validar \(1\)/);
        expect(html).toMatch(/aria-pressed="false"[^>]*data-filter-cancelled=""/);
        expect(html).toContain('data-page-size=""');
        expect(html).toContain('data-popover="columns"');
        expect(html).toContain('data-cm-roster-phonebar=""');
        expect(html).toContain('<style>');
        expect(html).toContain('[data-cm-roster-table] { display: none; }');
    });
    it('rows: the money state, the chips, the cancelled person struck through; the Pago pill and the code are buttons', () => {
        expect(html).toMatch(/data-cm-roster-row="1"[\s\S]*?data-chip="pending"/);
        expect(html).toMatch(/data-cm-roster-row="3"[\s\S]*?line-through[\s\S]*?Cancelada/);
        expect(html).toMatch(/<button[^>]*aria-label="Abono: pagos de Ana Pérez" data-pay-pill="partial"/);
        expect(html).toMatch(/<button[^>]*title="Código de inscripción"[\s\S]*?C1/);
        expect(html).toMatch(/data-cm-more="2"/);
        expect(html).not.toContain('Pagos de Ana Pérez</h3>');
    });
});

const T = (id: number, extra: any) => ({
    id, conference_id: 1, location_id: 1, location: 'Norte', locations: [1], mixed: false, amount: 150, allocated: 150, method: 'Transferencia', reference: `R${id}`, paid_on: '2026-10-01',
    note: null, status: 'pending', review_note: null, alloc_gen: 1, recorded_via: 'portal', recorded_by: 'portal:1', created_at: `2026-10-0${id} 10:00:00`, submitted_at: `2026-10-0${id} 10:00:00`,
    updated_at: null, updated_by: null, reviewed_at: null, reviewed_by: null, has_proof: true, legacy: false, people: 1,
    allocations: [{ id: id * 10, inscription_id: 1, amount: 150, location_id: 1, cancelled: false }], flags: { cancelled_people: [], duplicate_reference: false }, ...extra,
});
const W = (id: number, extra: any) => ({ id, location_id: 1, total_due: 500, due: 500, validated: 0, pending: 0, returned: 0, to_cover: 500, credit: 0, cancelled: false, payable: true, ...extra });
const VIEW = {
    conference_id: 1, features: { fee_payments: 1 }, methods: ['Efectivo', 'Transferencia'], max_people: 200, proof: { required_for: ['Transferencia'], max_chars: 1400000 },
    summary: { people: 2, cancelled: 1, due: 1000, validated: 100, pending: 150, returned: 0, to_cover: 750, credit: 0 },
    by_location: [
        { location_id: 2, location: 'Centro', people: 1, cancelled: 0, due: 500, validated: 0, pending: 0, returned: 0, to_cover: 500, credit: 0 },
        { location_id: 1, location: 'Norte', people: 1, cancelled: 0, due: 500, validated: 100, pending: 150, returned: 0, to_cover: 250, credit: 0 },
        { location_id: null, location: null, people: 0, cancelled: 1, due: 0, validated: 0, pending: 0, returned: 0, to_cover: 0, credit: 0 },
    ],
    counts: { pending: 2, validated: 1, returned: 0, rejected: 0, total: 3 },
    transfers: [T(3, { status: 'validated', method: 'Efectivo', recorded_via: 'admin', recorded_by: 'admin', amount: 100, allocations: [{ id: 30, inscription_id: 1, amount: 100, location_id: 1, cancelled: false }] }), T(2, {}), T(1, { flags: { cancelled_people: [], duplicate_reference: true } })],
    // Who each person is comes with the view (D-P20: the section never reads the roster).
    people: [W(1, { name: 'Ana Pérez', location: 'Norte', validated: 100, pending: 150, to_cover: 250 }), W(2, { name: 'Luis Gómez', location: 'Centro', location_id: 2 }), W(3, { name: 'Eva Ruiz', location: null, location_id: null, due: 0, to_cover: 0, cancelled: true, payable: false, status: 'cancelled' })],
};
const fees = (section: string) => render(<FeePaymentsPage conferenceId={1} initial={{ view: VIEW, fields: FIELDS, locations: LOCS, section }} onOpenAccounting={() => {}} />);

afterEach(() => { vi.unstubAllGlobals(); });

describe('«Pagos de cuotas» (admin)', () => {
    it('Resumen: the KPIs, the bar adding up, one line per location (phone cards + desktop table)', () => {
        const html = fees('summary');
        for (const k of ['due', 'validated', 'pending', 'returned', 'to_cover']) expect(html).toContain(`data-kpi="${k}"`);
        expect(html).not.toContain('data-kpi="credit"');
        expect(html).toContain('data-money-bar=""');
        expect(html).toMatch(/data-loc-row="2"[\s\S]*Centro/);
        expect(html).toContain('data-fees-desk=""');
        expect(html).toMatch(/data-seg="queue"[^>]*>Por validar<span[^>]*>2<\/span>/);
        expect(html).toContain('data-act="accounting"');
        expect(html).toContain('data-act="register-empty"');
    });
    it('Por validar: pending only, oldest first, with the warnings', () => {
        const html = fees('queue');
        const items = [...html.matchAll(/data-queue-item="(\d+)"/g)].map((m) => m[1]);
        expect(items).toEqual(['1', '2']);
        expect(html).toMatch(/data-queue-item="1"[\s\S]*?Referencia repetida/);
        // Round 6: each fact whole («1 persona» never split at the end of a line); UX6-3: each «·» starts the next one.
        expect(html).toMatch(/data-queue-facts=""><span>#2<\/span><span>· Transferencia<\/span><span class="tabular-nums">· \$150,00<\/span><span>· 1 persona<\/span>/);
    });
    it('Pagos: status chips with counts, filters, phone rows and the desktop table', () => {
        const html = fees('transfers');
        expect(html).toMatch(/data-transfer-statuses=""[\s\S]*Por validar \(2\)/);
        expect(html.match(/data-transfer-row="\d+"/g)).toHaveLength(3);
        expect(html.match(/data-transfer-tr="\d+"/g)).toHaveLength(3);
        expect(html).toContain('3 pagos');
        expect(html).toMatch(/aria-label="Abrir el pago #3" aria-haspopup="dialog"/);
    });
    it('Saldos: «Con saldo» by default (the cancelled person is not there), 44 px boxes, page selection', () => {
        const html = fees('balances');
        expect(html).toMatch(/aria-pressed="true"[^>]*>Con saldo/);
        const rows = [...html.matchAll(/data-balance-row="(\d+)"/g)].map((m) => m[1]);
        expect(rows.sort()).toEqual(['1', '2']);
        expect(html).toContain('data-select-page=""');
        expect(html).toMatch(/<label class="shrink-0 w-11 h-11/);
        // Round 6: the register sheet's words — Ana has $150 awaiting validation, so «falta» (her chip says the
        // «$150,00 por validar») — over a whole amount.
        expect(html).toMatch(/data-balance-row="1"[\s\S]*?data-balance-owed=""><span[^>]*>falta<\/span><span[^>]*whitespace-nowrap[^>]*>\$250,00</);
        expect(html).toMatch(/data-balance-row="1"[\s\S]*?>Ana Pérez</);
    });
});
