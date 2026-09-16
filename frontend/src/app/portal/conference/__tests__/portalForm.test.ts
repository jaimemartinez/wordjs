/**
 * The coordinator portal's form helpers. What is pinned here is the CONTRACT with conference-manager:
 * every dynamic-field value travels as a STRING and the server canonicalises it. The two bugs these
 * guard against: a required number field seeded with `0` (which passed the server's required check
 * for a blank input) and `Number()` coercion on the client (which stored `"30.0"` from the portal next
 * to `"30"` from the admin form, breaking `is_unique` and `eq` fee rules across surfaces).
 */
import { describe, it, expect } from "vitest";
import {
    fieldOptions,
    fmtMoney,
    formBody,
    initialFormValues,
    inputToFormValue,
    type PortalField,
} from "../form";

const f = (partial: Partial<PortalField> & { name: string }): PortalField => ({ label: partial.name, type: 'text', ...partial });

describe("initialFormValues — seeding", () => {
    it("seeds a number field with '' (never 0 — the server treats '' as missing)", () => {
        const seed = initialFormValues([f({ name: 'edad', type: 'number' })]);
        expect(seed.edad).toBe('');
        expect(seed.edad).not.toBe(0);
        expect(typeof seed.edad).toBe('string');
    });

    it("seeds a select with its first option", () => {
        expect(initialFormValues([f({ name: 'tipo', type: 'select', options: 'adulto, niño' })]).tipo).toBe('adulto');
    });

    it("seeds a select with no options, and text/textarea/date/email/tel, with ''", () => {
        const seed = initialFormValues([
            f({ name: 'vacio', type: 'select', options: null }),
            f({ name: 'nombre', type: 'text' }),
            f({ name: 'nota', type: 'textarea' }),
            f({ name: 'fecha', type: 'date' }),
            f({ name: 'correo', type: 'email' }),
            f({ name: 'tel', type: 'tel' }),
        ]);
        expect(seed).toEqual({ vacio: '', nombre: '', nota: '', fecha: '', correo: '', tel: '' });
    });

    it("produces exactly one key per field and nothing for an empty schema", () => {
        expect(initialFormValues([])).toEqual({});
        expect(Object.keys(initialFormValues([f({ name: 'a' }), f({ name: 'b' })]))).toEqual(['a', 'b']);
    });
});

describe("fieldOptions", () => {
    it("splits on commas, trims and drops blanks", () => {
        expect(fieldOptions(f({ name: 'x', type: 'select', options: ' adulto ,niño,, ,tercera edad ' })))
            .toEqual(['adulto', 'niño', 'tercera edad']);
    });
    it("is empty for null/undefined/empty options", () => {
        expect(fieldOptions(f({ name: 'x', type: 'select', options: null }))).toEqual([]);
        expect(fieldOptions(f({ name: 'x', type: 'select' }))).toEqual([]);
        expect(fieldOptions(f({ name: 'x', type: 'select', options: '' }))).toEqual([]);
    });
});

describe("inputToFormValue — no client-side coercion", () => {
    it("keeps the raw string of a number input ('0030' stays '0030'; the server canonicalises)", () => {
        expect(inputToFormValue(f({ name: 'edad', type: 'number' }), '0030')).toBe('0030');
        expect(inputToFormValue(f({ name: 'edad', type: 'number' }), '30.0')).toBe('30.0');
        expect(inputToFormValue(f({ name: 'edad', type: 'number' }), '')).toBe('');
    });
    it("keeps text as typed (trimming happens in formBody, not on every keystroke)", () => {
        expect(inputToFormValue(f({ name: 'nombre' }), ' Ana ')).toBe(' Ana ');
    });
});

describe("formBody — the request body", () => {
    it("trims, turns null/undefined into '' and stringifies without dropping keys", () => {
        expect(formBody({ a: ' x ', b: undefined as any, c: 0 as any, d: null as any }))
            .toEqual({ a: 'x', b: '', c: '0', d: '' });
    });
    it("keeps '' so the SERVER's required check fires (a blank required field must not be dropped)", () => {
        const body = formBody({ edad: '', nombre: 'Ana' });
        expect(Object.prototype.hasOwnProperty.call(body, 'edad')).toBe(true);
        expect(body.edad).toBe('');
    });
    it("never produces a JS number", () => {
        const body = formBody({ edad: '30', otro: 5 as any });
        for (const v of Object.values(body)) expect(typeof v).toBe('string');
    });
});

describe("fmtMoney — two decimals, cents-rounded, es-CO separators", () => {
    it("rounds float noise to cents", () => {
        expect(fmtMoney(100.19999999999999)).toBe('100,20');
        expect(fmtMoney(1151.1499999999999)).toBe('1.151,15'); // es-CO thousands separator
    });
    it("prints 0,00 for undefined/null/NaN/'' and handles numeric strings", () => {
        expect(fmtMoney(undefined)).toBe('0,00');
        expect(fmtMoney(null)).toBe('0,00');
        expect(fmtMoney('abc')).toBe('0,00');
        expect(fmtMoney('')).toBe('0,00');
        expect(fmtMoney('100.1')).toBe('100,10');
    });
    it("keeps integers and negatives readable", () => {
        expect(fmtMoney(50)).toBe('50,00');
        expect(fmtMoney(-0.5)).toBe('-0,50');
    });
});
