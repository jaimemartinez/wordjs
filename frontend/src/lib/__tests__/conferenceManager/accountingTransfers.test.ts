/**
 * conference-manager 2.18.0 — «Contabilidad» with split fee payments (D-P14 / D-P15) and the fee exports:
 *   - a fee line is ONE payment; a location filter matches each person of a shared payment; the search
 *     finds a shared payment by any of its people;
 *   - the summary counts movements and the people the fee payments cover;
 *   - the Excel keeps «Movimientos» one row per payment («3 personas») and adds «Detalle de cuotas», one
 *     row per person, whose total equals the «Inscripciones» category;
 *   - the roster Excel says «Sin pagar» (not «Pendiente») and has «Por validar» / «Devuelto»;
 *   - the «Pagos de cuotas» workbook: «Pagos», «Reparto», «Saldos».
 */
import { describe, it, expect } from 'vitest';
import { buildLedgerWorkbook, filterLedger, lineParticipant, locationShare, summarizeLedger } from '../../../../../marketplace/plugins/conference-manager/client/lib/accounting';
import { availableColumns, buildBusManifest, buildFeePaymentsWorkbook, columnValue, transportByPerson } from '../../../../../marketplace/plugins/conference-manager/client/lib/exports';

const L = (e: any) => ({ kind: 'income', source: 'inscription', readonly: true, category: 'Inscripciones', method: 'Transferencia', reference: null, ...e });
const ENTRIES: any[] = [
    L({ id: 'transfer-1', date: '2026-10-01', description: 'Pago de cuotas · 3 personas', amount: 300, transfer_id: 1, people: 3, inscription_id: null, location_id: null,
        allocations: [{ inscription_id: 1, amount: 100 }, { inscription_id: 2, amount: 100.01 }, { inscription_id: 3, amount: 99.99 }] }),
    L({ id: 'transfer-2', date: '2026-10-02', description: 'Pago de inscripción', amount: 50, transfer_id: 2, people: 1, inscription_id: 4, location_id: 2, allocations: [{ inscription_id: 4, amount: 50 }] }),
    { id: 7, kind: 'expense', source: 'manual', readonly: false, date: '2026-10-03', description: 'Sillas', amount: 80, category: 'Logística' },
    { id: 't-1', kind: 'income', source: 'transport', readonly: true, date: '2026-10-03', description: 'Pasaje', amount: 20, category: 'Transporte', inscription_id: 4, location_id: 2 },
];
const names = new Map([[1, 'Ana Pérez'], [2, 'Luis Gómez'], [3, 'Ángela Núñez'], [4, 'Juan Díaz']]);
const locationOf = new Map<number, number | null>([[1, 1], [2, 2], [3, null], [4, 2]]);

describe('filterLedger', () => {
    const ids = (f: any) => filterLedger(ENTRIES, f, names, locationOf).map((e) => e.id);
    it('a shared payment matches each of its people\'s locations', () => {
        expect(ids({ location: '1' })).toEqual(['transfer-1']);
        expect(ids({ location: '2' })).toEqual(['transfer-1', 'transfer-2', 't-1']);
        expect(ids({ location: 'none' })).toEqual(['transfer-1', 7]);
    });
    it('the search finds a shared payment by any person (accents ignored) and by «#id»', () => {
        expect(ids({ search: 'angela' })).toEqual(['transfer-1']);
        expect(ids({ search: '#2' })).toEqual(['transfer-2']);
        expect(ids({ search: 'juan' })).toEqual(['transfer-2', 't-1']);
    });
});

describe('a location filter keeps each payment’s share of that location (never the whole receipt twice)', () => {
    const loc = (l: string) => filterLedger(ENTRIES, { location: l }, names, locationOf);
    const feeTotal = (rows: any[]) => summarizeLedger(rows).byCategory.find((c) => c.category === 'Inscripciones')?.total ?? 0;
    it('the shared payment counts only its own people’s parts under each location', () => {
        const one = loc('1').find((e) => e.id === 'transfer-1')!;
        expect([one.amount, one.people, one.inscription_id, one.description]).toEqual([100, 1, 1, 'Pago de cuotas · 1 de 3 personas']);
        expect(one.allocations).toEqual([{ inscription_id: 1, amount: 100 }]);
        expect(loc('2').find((e) => e.id === 'transfer-1')!.amount).toBe(100.01);
        expect(loc('none').find((e) => e.id === 'transfer-1')!.amount).toBe(99.99);
    });
    it('summarizeLedger(filterLedger(…, {location})) = Σ that location’s parts; the locations add up to the whole', () => {
        expect(feeTotal(loc('1'))).toBe(100);
        expect(feeTotal(loc('2'))).toBe(150.01);   // 100.01 of the shared one + Juan's 50
        expect(feeTotal(loc('none'))).toBe(99.99);
        expect(Math.round((feeTotal(loc('1')) + feeTotal(loc('2')) + feeTotal(loc('none'))) * 100)).toBe(Math.round(feeTotal(ENTRIES) * 100));
        expect(summarizeLedger(loc('2')).income).toBe(170.01);   // + the 20 of transport
    });
    it('a location’s Excel lists only its people in «Detalle de cuotas», adding up to its fee lines', () => {
        const det = buildLedgerWorkbook(loc('1'), names, new Map([[1, 'Norte'], [2, 'Centro'], [3, ''], [4, 'Centro']]))[2];
        expect(det.rows.map((r) => r[3])).toEqual(['Ana Pérez', 'TOTAL']);
        expect(det.rows[det.rows.length - 1][4]).toEqual({ money: 100 });
        const mov = buildLedgerWorkbook(loc('1'), names)[1];
        expect(mov.rows[0][3]).toBe('Pago de cuotas ·\u00a01\u00a0de 3\u00a0personas');   // the count never splits from its noun (PUX-5), nor the «·» from it (UX6-4)
    });
    it('a payment whose people are all elsewhere is not a line of this location; without the roster a part sits at the line’s location', () => {
        const moved = [{ ...ENTRIES[1], id: 'transfer-9', location_id: 1 }];   // recorded by location 1, Juan is in 2
        expect(filterLedger(moved, { location: '1' }, names, locationOf)).toEqual([]);
        expect(filterLedger(moved, { location: '2' }, names, locationOf).map((e) => e.id)).toEqual(['transfer-9']);
        expect(filterLedger(moved, { location: '1' }, names, new Map()).map((e) => e.id)).toEqual(['transfer-9']);
        expect(locationShare(ENTRIES[2], '1', locationOf)).toBe(ENTRIES[2]);
    });
    it('the «Origen» of a fee payment is «Pago de cuotas»', () => {
        const mov = buildLedgerWorkbook(ENTRIES, names)[1];
        expect(mov.rows[0][7]).toBe('Pago de cuotas');
        expect(mov.rows[3][7]).toBe('Pago de transporte');
    });
});

describe('summary and workbook', () => {
    it('movements and people', () => {
        const s = summarizeLedger(ENTRIES);
        expect(s.movements).toBe(4);
        expect(s.income).toBe(370);
        expect(s.byCategory.find((c) => c.category === 'Inscripciones')).toEqual({ kind: 'income', category: 'Inscripciones', total: 350, count: 2, people: 4 });
        expect(lineParticipant(ENTRIES[0], names)).toBe('3 personas');
        expect(lineParticipant(ENTRIES[1], names)).toBe('Juan Díaz');
    });
    it('«Movimientos» one row per payment; «Detalle de cuotas» one per person, adding up to the category', () => {
        const sheets = buildLedgerWorkbook(ENTRIES, names, new Map([[1, 'Norte'], [2, 'Centro'], [3, ''], [4, 'Centro']]));
        expect(sheets.map((s) => s.name)).toEqual(['Resumen', 'Movimientos', 'Detalle de cuotas']);
        const mov = sheets[1];
        expect(mov.rows.length).toBe(ENTRIES.length + 1);
        expect(mov.rows[0][4]).toBe('3 personas');
        const det = sheets[2];
        expect(det.rows.length).toBe(5);   // 4 people + TOTAL
        expect(det.rows[0]).toEqual(['2026-10-01', '#1', 'Norte', 'Ana Pérez', { money: 100 }, 'Transferencia', '']);
        expect(det.rows[det.rows.length - 1][4]).toEqual({ money: 350 });
        const cat = summarizeLedger(ENTRIES).byCategory.find((c) => c.category === 'Inscripciones')!;
        expect((det.rows[det.rows.length - 1][4] as any).money).toBe(cat.total);
        expect(buildLedgerWorkbook([ENTRIES[2]]).map((s) => s.name)).toEqual(['Resumen', 'Movimientos']);
    });
});

describe('exports', () => {
    it('the roster Excel: «Sin pagar», «Por validar», «Devuelto»', () => {
        expect(columnValue({ payment_status: 'unpaid' }, 'payment_status')).toBe('Sin pagar');
        expect(columnValue({ payment_status: 'partial' }, 'payment_status')).toBe('Abono');   // the pill's word, admin and portal
        expect(columnValue({ payment_status: 'paid' }, 'payment_status')).toBe('Pagado');
        expect(availableColumns([]).map((c) => c.key)).toEqual(expect.arrayContaining(['pending_amount', 'returned_amount']));
        expect(columnValue({ pending_amount: 12.345 }, 'pending_amount')).toEqual({ money: 12.35 });
        expect(columnValue({ returned_amount: 5 }, 'returned_amount')).toEqual({ money: 5 });
    });
    it('the «Pagos de cuotas» workbook', () => {
        const sheets = buildFeePaymentsWorkbook({
            transfers: [{ id: 9, paid_on: '2026-10-01', location_id: null, locations: [1, 2], recorded_via: 'portal', recorded_by: 'portal:1', method: 'Transferencia', reference: 'R1', amount: 200, people: 2,
                status: 'pending', reviewed_by: null, reviewed_at: null, note: 'familia', review_note: null, allocations: [{ inscription_id: 1, amount: 120, location_id: 1 }, { inscription_id: 2, amount: 80, location_id: 2 }] }],
            people: [{ id: 1, location_id: 1, due: 500, validated: 0, pending: 120, returned: 0, to_cover: 380, credit: 0, cancelled: false }],
            nameOf: (id) => names.get(id) || `#${id}`, locationName: (id) => (id === 1 ? 'Norte' : id === 2 ? 'Centro' : ''),
        });
        expect(sheets.map((s) => s.name)).toEqual(['Pagos', 'Reparto', 'Saldos']);
        expect(sheets[0].rows[0].slice(0, 4)).toEqual([9, '2026-10-01', 'Varias', 'Portal']);
        expect(sheets[1].rows.map((r) => r[3])).toEqual(['Ana Pérez', 'Luis Gómez']);
        expect(sheets[2].rows[0][7]).toEqual({ money: 380 });
    });
});

describe('transport packages (2.26.0): a package is counted once, never once per bus', () => {
    const seat = (id: number, inscription_id: number, sale_id: number, package_name: string, price: number, amount_paid: number) =>
        ({ id, inscription_id, sale_id, package_name, price, amount_paid, payment_status: amount_paid >= price ? 'paid' : amount_paid > 0 ? 'partial' : 'unpaid' });
    // Ana bought «Ida y regreso» (Bus 1 + Bus 2) for 120; Beto «Solo ida» (Bus 1) for 60.
    const buses = [
        { id: 1, name: 'Bus 1', capacity: 40, price: 0, passengers: [seat(1, 10, 100, 'Ida y regreso', 120, 50), seat(2, 11, 101, 'Solo ida', 60, 0)] },
        { id: 2, name: 'Bus 2', capacity: 40, price: 0, passengers: [seat(3, 10, 100, 'Ida y regreso', 120, 50)] },
    ];
    it('per person: the package once, by its name', () => {
        const map = transportByPerson(buses as any);
        expect(map.get(10)).toEqual({ labels: ['Ida y regreso'], due: 120, paid: 50 });
        expect(map.get(11)).toEqual({ labels: ['Solo ida'], due: 60, paid: 0 });
    });
    it('the workbook: seats per bus, money per package, the package on each passenger row', () => {
        const packages = [
            { id: 100, name: 'Ida y regreso', price: 120, buses: [{ id: 1, name: 'Bus 1' }, { id: 2, name: 'Bus 2' }], sold: 1, revenue: 120, collected: 50 },
            { id: 101, name: 'Solo ida', price: 60, buses: [{ id: 1, name: 'Bus 1' }], sold: 1, revenue: 60, collected: 0 },
        ];
        const people = [{ id: 10, first_name: 'Ana', last_name: 'Pérez' }, { id: 11, first_name: 'Beto', last_name: 'Núñez' }];
        const sheets = buildBusManifest({ buses: buses as any, people: people as any, fields: [], packages });
        expect(sheets.map((x) => x.name)).toEqual(['Resumen', 'Paquetes', 'Bus 1', 'Bus 2']);
        expect(sheets[0].columns.map((c) => c.header)).toEqual(['Bus', 'Trayecto', 'Salida', 'Capacidad', 'Vendidos', 'Libres']);
        expect(sheets[0].rows.at(-1)).toEqual(['TOTAL', '', '', 80, 3, 77]);
        expect(sheets[1].rows.at(-1)).toEqual(['TOTAL', '', '', 2, { money: 180 }, { money: 50 }, { money: 130 }]);
        expect(sheets[1].rows[0][1]).toBe('Bus 1, Bus 2');
        expect(sheets[3].rows[0][5]).toBe('Ida y regreso');
        // One bus only: just its passenger list.
        expect(buildBusManifest({ buses: buses as any, people: people as any, fields: [], onlyBusId: 2, packages }).map((x) => x.name)).toEqual(['Bus 2']);
    });
});

