/**
 * «Pagos de cuotas» (2.18.0) — the PURE money and split rules of the admin's «Registrar pago» sheet.
 *
 * The client's copy of server/fee-split.js (the core portal keeps a third one). The three run the same
 * vectors (frontend/src/lib/__tests__/conferenceManager/feeSplitParity.test.ts), so a split the sheet shows
 * as exact is exactly what the server accepts:
 *
 * - everything is INTEGER CENTS; a receipt (one payment) is split into parts, one per person, that add up to
 *   its amount to the cent (owner decision D-P2);
 * - «Iguales» (D-P1, the default): equal parts that differ by at most one cent, the leftover cents going to
 *   the FIRST people in list order (100,00 / 3 = 33,34 + 33,33 + 33,33);
 * - «Manual»: the admin's own amounts, checked by validateAllocations.
 *
 * No I/O, no DOM.
 */

/** Hard cap of people in one payment (the server's one multi-row INSERT). */
export const MAX_PARTS = 200;

/** A finite number → integer cents (half away from zero, like the server's toCents). */
export const toCents = (v: unknown): number => Math.round((Number(v) || 0) * 100);
export const fromCents = (c: number): number => c / 100;

/**
 * A money string as people type it → integer cents, or null when it is not a number.
 *   «1.250,50» → 125050 · «1250.50» → 125050 · «1250,5» → 125050 · «1.250» → 125000 · «$ 750» → 75000
 * Rules (identical to the server): spaces and a leading «$» are ignored. With both «.» and «,» the LAST one
 * is the decimal mark and the other groups thousands. With only one kind: several of them group thousands;
 * a single one followed by exactly three digits groups thousands («1.250», «1,250»); otherwise it is the
 * decimal mark. At most two decimals. Negative values and anything else → null.
 */
export function parseMoneyInput(raw: unknown): number | null {
    if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? toCents(raw) : null;
    if (typeof raw !== 'string') return null;
    const s = raw.trim().replace(/^\$/, '').replace(/\s+/g, '');
    if (!s || !/^[0-9.,]+$/.test(s)) return null;
    const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    let intPart = s, frac = '';
    if (lastDot !== -1 && lastComma !== -1) {
        const dec = Math.max(lastDot, lastComma);
        const group = dec === lastDot ? ',' : '.';
        intPart = s.slice(0, dec); frac = s.slice(dec + 1);
        if (intPart.includes(dec === lastDot ? '.' : ',')) return null;      // two decimal marks
        intPart = intPart.split(group).join('');
    } else {
        const mark = lastDot !== -1 ? '.' : lastComma !== -1 ? ',' : '';
        if (mark) {
            const pieces = s.split(mark);
            if (pieces.length > 2 || (pieces.length === 2 && pieces[1].length === 3 && pieces[0].length > 0)) {
                // Thousands groups: every group after the first has exactly three digits.
                if (pieces.slice(1).some(g => g.length !== 3) || !pieces[0]) return null;
                intPart = pieces.join('');
            } else {
                intPart = pieces[0]; frac = pieces[1] || '';
            }
        }
    }
    if (!/^[0-9]*$/.test(intPart) || !/^[0-9]*$/.test(frac) || frac.length > 2) return null;
    if (!intPart && !frac) return null;
    const cents = Number(intPart || '0') * 100 + Number((frac + '00').slice(0, 2));
    return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Cents → the text a money input is prefilled with: «1.250,50» — the thousands grouped with «.» and a comma for
 * the decimals, as every other amount of the sheet reads («máximo $250.000,00») and as a bank receipt shows it:
 * «1250000,00» beside «$250.000,00» hid a missing or extra zero (2.18.0 review round 4). parseMoneyInput reads
 * it back to the same cents (with both «.» and «,», the last «,» is the decimal mark).
 */
export const centsToInput = (c: number): string => {
    const v = Math.max(0, Math.round(Number(c) || 0));
    const whole = String(Math.floor(v / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${whole},${String(v % 100).padStart(2, '0')}`;
};

/**
 * On leaving a money input: what was typed, written the way the sheet writes amounts — «250» → «250,00»,
 * «1.250,5» → «1.250,50» — so the parts of a «Manual» split never mix «250», «250,00» and «100». Text that is
 * not an amount stays as typed (the sheet says what is wrong with it).
 */
export const tidyMoneyInput = (raw: unknown): string => {
    const c = parseMoneyInput(raw);
    return c === null ? String(raw ?? '') : centsToInput(c);
};

/**
 * «Iguales»: `totalC` cents into `n` parts that differ by at most one cent; the leftover cents go to the
 * first parts. 10000 / 3 → [3334, 3333, 3333]. Returns [] for n < 1. A part may be 0 when totalC < n —
 * validateAllocations refuses that (every part must be positive).
 */
export function splitEqual(totalC: number, n: number): number[] {
    const count = Math.floor(Number(n) || 0);
    if (count < 1) return [];
    const total = Math.max(0, Math.round(Number(totalC) || 0));
    const base = Math.floor(total / count);
    const extra = total - base * count;
    return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

export type SplitState = { assigned: number; diff: number; ok: boolean };

/** Live «Asignado $X de $Y»: { assigned, diff (total − assigned), ok (exact and every part positive) }. */
export function splitState(totalC: number, partsC: unknown[]): SplitState {
    const parts = Array.isArray(partsC) ? partsC : [];
    const assigned = parts.reduce<number>((s, c) => s + (Number.isInteger(c) ? (c as number) : 0), 0);
    const diff = Math.round(Number(totalC) || 0) - assigned;
    return { assigned, diff, ok: parts.length > 0 && diff === 0 && parts.every(c => Number.isInteger(c) && (c as number) > 0) };
}

export type AllocationPart = { inscription_id: number | null; cents: number | null };
export type AllocationCheck =
    | { ok: true }
    | { ok: false; code: 'empty' | 'too_many' | 'invalid_id' | 'duplicate' | 'non_positive' | 'sum_mismatch'; ids?: number[]; max?: number; assigned?: number; diff?: number };

/**
 * The shape rules of a split, before any database read. `parts` = [{ inscription_id, cents }]. Returns
 * { ok: true } or { ok: false, code, … } with code ∈ empty | too_many | invalid_id | duplicate |
 * non_positive | sum_mismatch — the server's codes, in the server's order.
 */
export function validateAllocations(parts: AllocationPart[], totalC: number, max = MAX_PARTS): AllocationCheck {
    if (!Array.isArray(parts) || parts.length === 0) return { ok: false, code: 'empty' };
    if (parts.length > max) return { ok: false, code: 'too_many', max };
    const bad = parts.filter(p => !p || !Number.isInteger(p.inscription_id) || (p.inscription_id as number) <= 0);
    if (bad.length) return { ok: false, code: 'invalid_id' };
    const seen = new Set<number>(), dup = new Set<number>();
    for (const p of parts) { const id = p.inscription_id as number; if (seen.has(id)) dup.add(id); seen.add(id); }
    if (dup.size) return { ok: false, code: 'duplicate', ids: [...dup] };
    const nonPos = parts.filter(p => !Number.isInteger(p.cents) || (p.cents as number) <= 0).map(p => p.inscription_id as number);
    if (nonPos.length) return { ok: false, code: 'non_positive', ids: nonPos };
    const st = splitState(totalC, parts.map(p => p.cents));
    if (st.diff !== 0) return { ok: false, code: 'sum_mismatch', assigned: st.assigned, diff: st.diff };
    return { ok: true };
}
