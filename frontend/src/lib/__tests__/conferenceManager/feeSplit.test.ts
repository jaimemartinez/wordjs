/**
 * conference-manager 2.18.0 «Pagos de cuotas» — the money rules of the admin's «Registrar pago» sheet
 * (client/lib/feeSplit.ts). Everything in integer cents; the split adds up to the receipt to the cent (D-P2);
 * «Iguales» gives the leftover cents to the FIRST people (D-P1); amounts typed the Spanish way are read right.
 */
import { describe, it, expect } from 'vitest';
import {
    MAX_PARTS, centsToInput, fromCents, parseMoneyInput, splitEqual, splitState, toCents, validateAllocations,
} from '../../../../../marketplace/plugins/conference-manager/client/lib/feeSplit';

describe('parseMoneyInput', () => {
    it('reads the ways people type an amount', () => {
        expect(parseMoneyInput('1.250,50')).toBe(125050);
        expect(parseMoneyInput('1250.50')).toBe(125050);
        expect(parseMoneyInput('1250,5')).toBe(125050);
        expect(parseMoneyInput('1.250')).toBe(125000);
        expect(parseMoneyInput('1,250')).toBe(125000);
        expect(parseMoneyInput('$ 750')).toBe(75000);
        expect(parseMoneyInput('1.234.567,89')).toBe(123456789);
        expect(parseMoneyInput('0,01')).toBe(1);
        expect(parseMoneyInput(12.345)).toBe(1235);
    });
    it('refuses what is not an amount', () => {
        for (const bad of ['', '  ', 'abc', '-5', '1,2,3,4', '1.25.0', '12,345,6', '1,234.5.6', null, undefined, NaN, -1, {}]) {
            expect(parseMoneyInput(bad as any), String(bad)).toBeNull();
        }
    });
    it('centsToInput writes what parseMoneyInput reads back', () => {
        for (const c of [0, 1, 99, 100, 125050, 33334, 999999999]) expect(parseMoneyInput(centsToInput(c))).toBe(c);
        expect(centsToInput(125050)).toBe('1.250,50');
        expect(centsToInput(5)).toBe('0,05');
    });
    it('toCents / fromCents', () => {
        expect(toCents(0.1 + 0.2)).toBe(30);
        expect(toCents('12.345')).toBe(1235);
        expect(fromCents(125050)).toBe(1250.5);
    });
});

describe('splitEqual («Iguales»)', () => {
    it('parts differ by at most one cent and the leftover goes to the FIRST people', () => {
        expect(splitEqual(10000, 3)).toEqual([3334, 3333, 3333]);
        expect(splitEqual(10001, 3)).toEqual([3334, 3334, 3333]);
        expect(splitEqual(75000, 2)).toEqual([37500, 37500]);
        expect(splitEqual(2, 3)).toEqual([1, 1, 0]);
        expect(splitEqual(100, 0)).toEqual([]);
    });
    it('always adds up exactly', () => {
        for (const [t, n] of [[1, 7], [99999, 13], [12345678, 200], [5, 5]]) {
            expect(splitEqual(t, n).reduce((a, b) => a + b, 0)).toBe(t);
        }
    });
});

describe('splitState / validateAllocations', () => {
    it('«Asignado $X de $Y»: diff and ok', () => {
        expect(splitState(10000, [5000, 5000])).toEqual({ assigned: 10000, diff: 0, ok: true });
        expect(splitState(10000, [5000, 4000])).toEqual({ assigned: 9000, diff: 1000, ok: false });
        expect(splitState(10000, [6000, 5000])).toEqual({ assigned: 11000, diff: -1000, ok: false });
        expect(splitState(10000, [10000, 0])).toEqual({ assigned: 10000, diff: 0, ok: false });
        expect(splitState(0, [])).toEqual({ assigned: 0, diff: 0, ok: false });
    });
    it('the server\'s codes, in the server\'s order', () => {
        expect(validateAllocations([], 100)).toEqual({ ok: false, code: 'empty' });
        expect(validateAllocations(Array.from({ length: MAX_PARTS + 1 }, (_, i) => ({ inscription_id: i + 1, cents: 1 })), MAX_PARTS + 1)).toMatchObject({ code: 'too_many', max: 200 });
        expect(validateAllocations([{ inscription_id: null, cents: 100 }], 100)).toMatchObject({ code: 'invalid_id' });
        expect(validateAllocations([{ inscription_id: 1, cents: 50 }, { inscription_id: 1, cents: 50 }], 100)).toMatchObject({ code: 'duplicate', ids: [1] });
        expect(validateAllocations([{ inscription_id: 1, cents: 100 }, { inscription_id: 2, cents: 0 }], 100)).toMatchObject({ code: 'non_positive', ids: [2] });
        expect(validateAllocations([{ inscription_id: 1, cents: 60 }, { inscription_id: 2, cents: 30 }], 100)).toMatchObject({ code: 'sum_mismatch', assigned: 90, diff: 10 });
        expect(validateAllocations([{ inscription_id: 1, cents: 60 }, { inscription_id: 2, cents: 40 }], 100)).toEqual({ ok: true });
    });
});
