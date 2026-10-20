/**
 * conference-manager 2.18.0 «Pagos de cuotas» — the admin's pure model (client/lib/feePayments.ts):
 *   - one person's money in cents (due is 0 when cancelled; «por cobrar» counts money awaiting validation);
 *   - the «Resumen» bar adds up to the fees exactly;
 *   - the state machine offers exactly what the server allows (D-P5..D-P10);
 *   - the review queue is oldest first and «Validar y siguiente» picks the right next one (D-P21);
 *   - the «Pagos» filters, the «Saldos» chips and the selection capped at 200 (D-P17);
 *   - the «Registrar pago» draft: exact split (D-P2), NEVER above what is owed (D-P9 «Nunca»), receipt
 *     required for a transfer and optional for cash (D-P12), never a future date.
 */
import { describe, it, expect } from 'vitest';
import {
    BALANCE_FILTERS, EMPTY_TRANSFER_FILTER, FEE_ERROR_TEXT, STATUS_META, balanceChips, balanceFromWire, barPercents, barSegments, buildFeeBody,
    checkDraft, draftParts, expectedOf, feeErrorText, filterTransfers, fmtDay, fmtStamp, localDay, matchesBalanceFilter, maxPaidOn, newClientKey,
    manualSeed, nextInQueue, pageSelectionState, peopleLabel, personBalance, pruneSelection, queueOf, queueWarnings, reseedManual, selectAllCapped, selectPage,
    shortName, statusMeta, summarizeBalances, toggleId, transferActions, transferInLocation, validationBlocked,
} from '../../../../../marketplace/plugins/conference-manager/client/lib/feePayments';
import type { FeeDraft, Transfer } from '../../../../../marketplace/plugins/conference-manager/client/lib/feePayments';

describe('personBalance', () => {
    it('cents; «por cobrar» = due − validated − pending; credit apart', () => {
        expect(personBalance({ total_due: 500, amount_paid: 100, pending_amount: 150, returned_amount: 50, payment_status: 'partial' }))
            .toEqual({ due: 50000, validated: 10000, pending: 15000, returned: 5000, toCover: 25000, credit: 0, cancelled: false, payable: true, state: 'partial' });
        expect(personBalance({ total_due: 500, amount_paid: 300, pending_amount: 250 }).toCover).toBe(0);
        expect(personBalance({ total_due: 400, amount_paid: 500 })).toMatchObject({ credit: 10000, toCover: 0, payable: false, state: 'paid' });
    });
    it('a cancelled inscription owes nothing and is never payable (D-P19)', () => {
        expect(personBalance({ status: 'cancelled', total_due: 500, amount_paid: 0 })).toMatchObject({ due: 0, toCover: 0, cancelled: true, payable: false });
        expect(personBalance({ cancelled: true, total_due: 500 })).toMatchObject({ cancelled: true, payable: false });
    });
    it('the pill comes from validated money only (the server\'s payment_status when present)', () => {
        expect(personBalance({ total_due: 500, amount_paid: 0, pending_amount: 500 }).state).toBe('unpaid');
        expect(personBalance({ total_due: 500, amount_paid: 0, pending_amount: 500, payment_status: 'unpaid' }).state).toBe('unpaid');
        expect(personBalance({ total_due: 0 }).state).toBe('paid');
    });
    it('from the server\'s wire balance', () => {
        expect(balanceFromWire({ id: 1, location_id: 1, total_due: 500, due: 500, validated: 100, pending: 50, returned: 0, to_cover: 350, credit: 0, cancelled: false, payable: true }))
            .toMatchObject({ due: 50000, validated: 10000, pending: 5000, toCover: 35000, state: 'partial', payable: true });
    });
    it('chips only when they apply', () => {
        expect(balanceChips(personBalance({ total_due: 100 }))).toEqual([]);
        expect(balanceChips(personBalance({ status: 'cancelled', total_due: 100, amount_paid: 40, pending_amount: 10, returned_amount: 5 })).map((c) => c.kind))
            .toEqual(['cancelled', 'pending', 'returned', 'credit']);
    });
});

describe('the «Resumen» bar: Validado + Por validar + Por cobrar = Cuotas, exactly', () => {
    it('adds up even with a credit or a re-price', () => {
        const list = [
            personBalance({ total_due: 500, amount_paid: 100, pending_amount: 150 }),
            personBalance({ total_due: 300, amount_paid: 400 }),                     // credit after a re-price
            personBalance({ total_due: 200, amount_paid: 150, pending_amount: 100 }), // pending beyond due after a re-price
            personBalance({ status: 'cancelled', total_due: 999 }),
        ];
        const seg = barSegments(list);
        expect(seg).toEqual({ due: 100000, validated: 55000, pending: 20000, toCover: 25000 });
        expect(seg.validated + seg.pending + seg.toCover).toBe(seg.due);
        expect(barPercents(seg)).toEqual({ validated: 55, pending: 20, toCover: 25 });
        expect(barPercents({ due: 0, validated: 0, pending: 0, toCover: 0 })).toEqual({ validated: 0, pending: 0, toCover: 0 });
        const sum = summarizeBalances(list);
        expect(sum).toMatchObject({ people: 3, cancelled: 1, due: 100000, credit: 10000 });
    });
});

describe('transferActions (mirrors the server state machine)', () => {
    const on = (s: string) => Object.entries(transferActions(s, true)).filter(([, v]) => v).map(([k]) => k).sort();
    it('per status', () => {
        expect(on('pending')).toEqual(['edit', 'reject', 'remove', 'return', 'validate']);
        expect(on('returned')).toEqual(['edit', 'reject', 'remove', 'validate']);
        // D-P10: void first, then «Duplicar» the voided one — never while it still counts (409 proof_source_live).
        expect(on('validated')).toEqual(['reject', 'voids']);
        expect(on('rejected')).toEqual(['duplicate', 'remove', 'validate']);
        expect(on('draft')).toEqual([]);
    });
    it('nothing without payments:manage', () => {
        for (const s of ['pending', 'returned', 'validated', 'rejected']) expect(Object.values(transferActions(s, false)).some(Boolean)).toBe(false);
    });
    it('every action sends the status and split generation shown', () => {
        expect(expectedOf({ status: 'pending', alloc_gen: '3' as any })).toEqual({ status: 'pending', alloc_gen: 3 });
    });
    it('status is text plus an icon for every status', () => {
        for (const s of ['pending', 'validated', 'returned', 'rejected'] as const) {
            expect(STATUS_META[s].icon).toMatch(/^fa-/);
            expect(STATUS_META[s].fallback.length).toBeGreaterThan(3);
        }
        expect(statusMeta('weird')).toBe(STATUS_META.pending);
    });
    it('validation is blocked when a part would go past what the person owes (D-P9)', () => {
        expect(validationBlocked({ allocations: [{ inscription_id: 1, after: { paid: 5, owed: 0, credit: 0 } }, { inscription_id: 2, after: { paid: 6, owed: 0, credit: 0.01 } }] as any })).toEqual([2]);
        expect(validationBlocked({ allocations: [{ inscription_id: 1 }] as any })).toEqual([]);
    });
    it('validation is blocked by the server\'s own rule: part > fee − validated elsewhere, and a cancelled person owes nothing', () => {
        const part = (id: number, amount: number, total_due: number, validated_other: number, extra: object = {}) =>
            ({ inscription_id: id, amount, total_due, due: total_due, validated_other, after: { paid: validated_other + amount, owed: 0, credit: 0 }, ...extra });
        expect(validationBlocked({ allocations: [part(1, 300, 500, 200), part(2, 300.01, 500, 200)] as any })).toEqual([2]);
        // Cancelled after the payment was recorded: due is 0 — the server answers 409 cancelled_people (D-P9
        // «Nunca», D-P19), so the button is disabled until the split is corrected or the person reactivated.
        expect(validationBlocked({ allocations: [part(3, 300, 500, 0, { cancelled: true, due: 0, after: { paid: 300, owed: 0, credit: 300 } })] as any })).toEqual([3]);
        expect(validationBlocked({ allocations: [part(4, 600, 500, 0, { cancelled: true, due: 0 })] as any })).toEqual([4]);
        expect(validationBlocked({ allocations: [part(5, 1, 500, 0, { cancelled: true })] as any })).toEqual([5]);
    });
});

const T = (id: number, extra: Partial<Transfer> = {}): Transfer => ({
    id, conference_id: 1, location_id: 1, location: 'Norte', locations: [1], mixed: false, amount: 100, allocated: 100, method: 'Transferencia', reference: null,
    paid_on: '2026-10-01', note: null, status: 'pending', review_note: null, alloc_gen: 1, recorded_via: 'portal', recorded_by: 'portal:1',
    created_at: `2026-10-0${id} 10:00:00`, submitted_at: null, updated_at: null, updated_by: null, reviewed_at: null, reviewed_by: null,
    has_proof: true, legacy: false, people: 1, allocations: [{ id: id * 10, inscription_id: id, amount: 100, location_id: 1, cancelled: false }],
    flags: { cancelled_people: [], duplicate_reference: false }, ...extra,
});

describe('the review queue (D-P21)', () => {
    it('pending only, oldest first', () => {
        const list = [T(3), T(1), T(2, { status: 'validated' }), T(4, { submitted_at: '2026-09-30 08:00:00' })];
        expect(queueOf(list).map((t) => t.id)).toEqual([4, 1, 3]);
    });
    it('«Validar y siguiente»: the one that followed, else the one before, else none', () => {
        const before = [T(1), T(2), T(3)];
        expect(nextInQueue(before, [T(1), T(3)], 2)).toBe(3);
        expect(nextInQueue(before, [T(1), T(2)], 3)).toBe(2);
        expect(nextInQueue([T(1)], [], 1)).toBeNull();
        expect(nextInQueue(before, [T(1), T(3), T(9)], 2)).toBe(3);
    });
    it('queue card warnings from the list data alone', () => {
        const bal = (id: number) => (id === 1 ? personBalance({ total_due: 80, amount_paid: 0 }) : personBalance({ total_due: 500 }));
        expect(queueWarnings(T(1), bal)).toEqual(['over']);
        expect(queueWarnings(T(2, { flags: { cancelled_people: [2], duplicate_reference: true } }), bal)).toEqual(['cancelled', 'reference']);
        // a validated payment's own part is inside `validated`: not counted twice
        expect(queueWarnings(T(3, { status: 'validated' }), () => personBalance({ total_due: 100, amount_paid: 100 }))).toEqual([]);
        // A person cancelled after the payment: «Persona cancelada», not «Supera» (the server validates it).
        const cancelledPart = T(5, { allocations: [{ id: 50, inscription_id: 5, amount: 100, location_id: 1, cancelled: true }], flags: { cancelled_people: [5], duplicate_reference: false } });
        expect(queueWarnings(cancelledPart, () => personBalance({ status: 'cancelled', total_due: 100 }))).toEqual(['cancelled']);
    });
});

describe('«Pagos» filters', () => {
    const names: Record<number, string> = { 1: 'Ana Pérez', 2: 'Luis Gómez', 3: 'Ángela Núñez' };
    const nameOf = (id: number) => names[id] || `#${id}`;
    const list = [
        T(1, { reference: 'ABC-99', status: 'validated', method: 'Efectivo', recorded_via: 'admin', paid_on: '2026-09-15' }),
        T(2, { location_id: null, locations: [1, 2], mixed: true }),
        T(3, { location_id: null, locations: [], status: 'returned', recorded_via: 'legacy' }),
    ];
    const ids = (f: any) => filterTransfers(list, { ...EMPTY_TRANSFER_FILTER, ...f }, nameOf).map((t) => t.id);
    it('status, location (a mixed payment matches each of its locations), method, recorder, dates, person', () => {
        expect(ids({})).toEqual([1, 2, 3]);
        expect(ids({ statuses: ['returned', 'validated'] })).toEqual([1, 3]);
        expect(ids({ location: '2' })).toEqual([2]);
        expect(ids({ location: '1' })).toEqual([1, 2]);
        expect(ids({ location: 'none' })).toEqual([3]);
        expect(ids({ method: 'Efectivo' })).toEqual([1]);
        expect(ids({ via: 'legacy' })).toEqual([3]);
        expect(ids({ from: '2026-09-20' })).toEqual([2, 3]);
        expect(ids({ to: '2026-09-20' })).toEqual([1]);
        expect(ids({ inscriptionId: 3 })).toEqual([3]);
    });
    it('«Sin localidad» is one of a payment\'s locations when one of its people has none (the server\'s and «Contabilidad»\'s rule)', () => {
        const mixed = T(4, { location_id: null, locations: [1], mixed: false, allocations: [
            { id: 41, inscription_id: 1, amount: 50, location_id: 1, cancelled: false }, { id: 42, inscription_id: 9, amount: 50, location_id: null, cancelled: false }] });
        const portalOwn = T(5, { location_id: 1, locations: [1], allocations: [{ id: 51, inscription_id: 9, amount: 100, location_id: null, cancelled: false }] });
        expect(filterTransfers([...list, mixed, portalOwn], { ...EMPTY_TRANSFER_FILTER, location: 'none' }).map((t) => t.id)).toEqual([3, 4]);
        expect(filterTransfers([...list, mixed, portalOwn], { ...EMPTY_TRANSFER_FILTER, location: '1' }).map((t) => t.id)).toEqual([1, 2, 4, 5]);
        expect(transferInLocation(mixed, '')).toBe(true);
    });
    it('search: reference, «#id» and people, accents ignored', () => {
        expect(ids({ q: 'abc-99' })).toEqual([1]);
        expect(ids({ q: '#2' })).toEqual([2]);
        expect(ids({ q: 'angela nunez' })).toEqual([3]);
    });
    it('«Ana P., Luis G. +1» (a name never splits from its initial, nor «+1» from the last name: UX6-4)', () => {
        expect(shortName('Ana María Pérez')).toBe('Ana\u00a0M.');
        expect(peopleLabel([{ inscription_id: 1 }, { inscription_id: 2 }, { inscription_id: 3 }], nameOf)).toBe('Ana\u00a0P., Luis\u00a0G.\u00a0+1');
        expect(peopleLabel([{ inscription_id: 9 }], nameOf)).toBe('#9');
    });
});

describe('«Saldos» chips and selection (D-P17)', () => {
    it('«Con saldo» is the default; each chip keeps what it says', () => {
        expect(BALANCE_FILTERS[0].key).toBe('owing');
        const owes = personBalance({ total_due: 100 }), pend = personBalance({ total_due: 100, pending_amount: 100 }), paid = personBalance({ total_due: 100, amount_paid: 100 });
        expect(matchesBalanceFilter(owes, 'owing')).toBe(true);
        expect(matchesBalanceFilter(pend, 'owing')).toBe(false);
        expect(matchesBalanceFilter(pend, 'pending')).toBe(true);
        expect(matchesBalanceFilter(paid, 'paid')).toBe(true);
        expect(matchesBalanceFilter(personBalance({ status: 'cancelled', total_due: 100 }), 'paid')).toBe(false);
        expect(matchesBalanceFilter(personBalance({ total_due: 100, amount_paid: 150 }), 'credit')).toBe(true);
    });
    it('the page box is tri-state; «seleccionar los N» and toggles never pass 200; pruning after a reload', () => {
        expect(pageSelectionState([1, 2], [])).toBe('none');
        expect(pageSelectionState([1, 2], [2])).toBe('some');
        expect(pageSelectionState([1, 2], [1, 2, 3])).toBe('all');
        expect(selectPage([3], [1, 2])).toEqual([3, 1, 2]);
        expect(selectPage([1, 2, 3], [1, 2])).toEqual([3]);
        const many = Array.from({ length: 250 }, (_, i) => i + 1);
        expect(selectAllCapped(many)).toHaveLength(200);
        expect(toggleId(selectAllCapped(many), 999)).toHaveLength(200);
        expect(selectPage(selectAllCapped(many), [300, 301])).toHaveLength(200);
        expect(pruneSelection([1, 2, 3], new Set([2]))).toEqual([2]);
    });
});

const draft = (d: Partial<FeeDraft> = {}): FeeDraft => ({
    people: [1, 2, 3], amount: '100', method: 'Efectivo', paidOn: localDay(), reference: '', note: '', mode: 'equal', manual: {},
    proof: null, keepsProof: false, copyProofFrom: null, leavePending: false, clientKey: 'abcdefgh12', ...d,
});
const caps: Record<number, number> = { 1: 5000, 2: 5000, 3: 5000 };
const ctx = { capOf: (id: number) => caps[id] ?? null };

describe('the «Registrar pago» draft', () => {
    it('«Iguales» is exact to the cent, leftover to the first people', () => {
        expect(draftParts(draft()).map((p) => p.cents)).toEqual([3334, 3333, 3333]);
        const c = checkDraft(draft(), ctx);
        expect(c.ok).toBe(true);
        expect(c.split).toEqual({ assigned: 10000, diff: 0, ok: true });
    });
    it('«Manual» must add up exactly and every part be positive (D-P2)', () => {
        expect(checkDraft(draft({ mode: 'manual', manual: { 1: '50', 2: '30', 3: '10' } }), ctx).issues).toContain('sum_mismatch');
        expect(checkDraft(draft({ mode: 'manual', manual: { 1: '50', 2: '50', 3: '0' } }), ctx).issues).toContain('non_positive');
        expect(checkDraft(draft({ mode: 'manual', manual: { 1: '50', 2: '25,50', 3: '24.50' } }), ctx).ok).toBe(true);
    });
    it('NEVER above what a person still owes, counting money awaiting validation (D-P9 «Nunca»)', () => {
        const c = checkDraft(draft({ amount: '160' }), ctx);
        expect(c.issues).toContain('over_cap');
        expect(c.overCap).toEqual([{ inscription_id: 1, cents: 5334, max: 5000 }, { inscription_id: 2, cents: 5333, max: 5000 }, { inscription_id: 3, cents: 5333, max: 5000 }]);
        expect(checkDraft(draft({ amount: '150' }), ctx).ok).toBe(true);
        expect(checkDraft(draft({ people: [1], amount: '50' }), { capOf: () => 0 }).issues).toContain('over_cap');
    });
    it('the receipt: required for a transfer, optional for cash (D-P12); a kept or copied receipt counts', () => {
        expect(checkDraft(draft({ method: 'Transferencia' }), ctx).issues).toContain('proof_required');
        expect(checkDraft(draft({ method: 'Efectivo' }), ctx).issues).not.toContain('proof_required');
        expect(checkDraft(draft({ method: 'Transferencia', proof: 'data:image/jpeg;base64,AAAA' }), ctx).ok).toBe(true);
        expect(checkDraft(draft({ method: 'Transferencia', proof: undefined, keepsProof: true }), ctx).ok).toBe(true);
        expect(checkDraft(draft({ method: 'Transferencia', proof: null, keepsProof: true }), ctx).issues).toContain('proof_required');
        expect(checkDraft(draft({ method: 'Transferencia', proof: undefined, copyProofFrom: 7 }), ctx).ok).toBe(true);
    });
    it('people, amount, method and date', () => {
        expect(checkDraft(draft({ people: [] }), ctx).issues).toContain('empty');
        expect(checkDraft(draft({ amount: '0' }), ctx).issues).toContain('invalid_amount');
        expect(checkDraft(draft({ amount: 'abc' }), ctx).issues).toContain('invalid_amount');
        expect(checkDraft(draft({ method: 'Cheque' }), { ...ctx, methods: ['Efectivo', 'Transferencia'] }).issues).toContain('no_method');
        const today = new Date(2026, 9, 7, 12);
        expect(maxPaidOn(today)).toBe('2026-10-08');
        expect(checkDraft(draft({ paidOn: '2026-10-09' }), { ...ctx, today }).issues).toContain('future_date');
        expect(checkDraft(draft({ paidOn: '2026-10-08' }), { ...ctx, today }).issues).not.toContain('future_date');
        expect(checkDraft(draft({ paidOn: '07/10/2026' }), ctx).issues).toContain('invalid_date');
        expect(checkDraft(draft(), { ...ctx, cancelled: (id) => id === 2 }).issues).toContain('cancelled_people');
        expect(checkDraft(draft({ people: Array.from({ length: 201 }, (_, i) => i + 1) }), { capOf: () => 999999 }).issues).toContain('too_many');
    });
    it('the request body: 2-decimal amounts, the client key, leave_pending, the receipt rules', () => {
        const d = draft({ method: 'Transferencia', reference: ' 98765 ', note: '', proof: 'data:image/jpeg;base64,AAAA', leavePending: true });
        const body = buildFeeBody(d, checkDraft(d, ctx), { conferenceId: 4 });
        expect(body).toEqual({
            amount: 100, method: 'Transferencia', paid_on: d.paidOn, reference: '98765', note: null, client_key: 'abcdefgh12', leave_pending: true,
            allocations: [{ inscription_id: 1, amount: 33.34 }, { inscription_id: 2, amount: 33.33 }, { inscription_id: 3, amount: 33.33 }],
            proof: 'data:image/jpeg;base64,AAAA', conference_id: 4,
        });
        // Cash without a receipt: neither a receipt nor a source payment travels.
        const cash = draft({ proof: undefined, copyProofFrom: null });
        expect(buildFeeBody(cash, checkDraft(cash, ctx))).not.toHaveProperty('copy_proof_from');
        expect(buildFeeBody(cash, checkDraft(cash, ctx))).not.toHaveProperty('proof');
        const dup = draft({ copyProofFrom: 7, proof: undefined });
        expect(buildFeeBody(dup, checkDraft(dup, ctx))).toMatchObject({ copy_proof_from: 7 });
        expect(buildFeeBody(dup, checkDraft(dup, ctx))).not.toHaveProperty('proof');
        const removed = draft({ proof: null, keepsProof: true });
        expect(buildFeeBody(removed, checkDraft(removed, ctx), { expected: { status: 'returned', alloc_gen: 2 }, allowDuplicateReference: true }))
            .toMatchObject({ proof: null, expected: { status: 'returned', alloc_gen: 2 }, allow_duplicate_reference: true });
    });
    it('a client key per draft (idempotent retries), always in the server\'s alphabet', () => {
        const k = newClientKey();
        expect(k).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
        expect(newClientKey()).not.toBe(k);
    });
    it('manual amounts survive a change of people', () => {
        expect(reseedManual({ 1: '10', 2: '20' }, [2, 3], (id) => `seed${id}`)).toEqual({ 2: '20', 3: 'seed3' });
    });
    it('a switch to «Manual» starts from what each one owes when the total is that sum (the portal\'s rule), else «Iguales»', () => {
        const caps: Record<number, number> = { 1: 50000, 2: 25000, 3: 0 };
        const capOf = (id: number) => (id in caps ? caps[id] : null);
        expect(manualSeed([1, 2], 75000, capOf)).toEqual({ 1: '500,00', 2: '250,00' });
        // Another total, or someone who owes nothing: the equal split, leftover cents first.
        expect(manualSeed([1, 2], 10001, capOf)).toEqual({ 1: '50,01', 2: '50,00' });
        expect(manualSeed([1, 3], 50000, capOf)).toEqual({ 1: '250,00', 3: '250,00' });
        expect(manualSeed([], 0, capOf)).toEqual({});
    });
});

describe('errors and display', () => {
    const tx = (k: string, f: string) => `${k}|${f}`;
    it('a known code → its own text; anything else → the server message', () => {
        expect(feeErrorText({ code: 'over_cap', message: 'x' }, tx)).toBe(`fees.error.over_cap|${FEE_ERROR_TEXT.over_cap}`);
        expect(feeErrorText({ code: 'weird', message: 'Algo pasó' }, tx)).toBe('Algo pasó');
        expect(feeErrorText(null, tx)).toBe('Error');
    });
    it('dates', () => {
        expect(fmtDay('2026-10-07')).toBe('07/10/2026');
        expect(fmtDay('2026-10-07 10:00:00')).toBe('07/10/2026');
        expect(fmtStamp('')).toBe('');
        expect(fmtStamp('2026-10-07 14:20:00')).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
        expect(fmtStamp('2026-10-07 14:20:00', true)).toMatch(/\/2026 /);
    });
});
