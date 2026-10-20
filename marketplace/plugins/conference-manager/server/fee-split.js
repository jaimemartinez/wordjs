/**
 * Fee payments (2.18.0) — the PURE money and split rules shared by every write path of «Pagos de cuotas».
 *
 * Everything here works in INTEGER CENTS. A receipt (one payment) is split into parts, one per person; the
 * parts must add up to the receipt's amount exactly, to the cent (owner decision D-P2). Two split modes
 * exist (D-P1): «Iguales» (equal parts; the leftover cents go to the FIRST parts in list order, so the same
 * input always gives the same split) and «Manual» (the caller's own amounts, checked by validateAllocations).
 *
 * The same vectors run through the plugin client (client/lib/feeSplit.ts) and the core portal
 * (frontend/src/app/portal/conference/feeSplit.ts); this file is the server's copy. No I/O, no require.
 */
'use strict';

/** Hard cap of people in one payment (one multi-row INSERT; the portal's old bulk cap). */
const MAX_PARTS = 200;

/** A finite number → integer cents (half away from zero, like the plugin's toCents). */
const toCents = (v) => Math.round((Number(v) || 0) * 100);
const fromCents = (c) => c / 100;

/**
 * A money string as people type it → integer cents, or null when it is not a number.
 *   «1.250,50» → 125050 · «1250.50» → 125050 · «1250,5» → 125050 · «1.250» → 125000 · «$ 750» → 75000
 * Rules: spaces and a leading «$» are ignored. With both «.» and «,» the LAST one is the decimal mark and
 * the other groups thousands. With only one kind: several of them group thousands; a single one followed
 * by exactly three digits groups thousands («1.250», «1,250»); otherwise it is the decimal mark. At most
 * two decimals. Negative values and anything else → null.
 */
function parseMoneyInput(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? toCents(raw) : null;
    if (typeof raw !== 'string') return null;
    let s = raw.trim().replace(/^\$/, '').replace(/\s+/g, '');
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
 * «Iguales»: `totalC` cents into `n` parts that differ by at most one cent; the leftover cents go to the
 * first parts. 10000 / 3 → [3334, 3333, 3333]. Returns [] for n < 1. A part may be 0 when totalC < n —
 * validateAllocations refuses that (every part must be positive).
 */
function splitEqual(totalC, n) {
    const count = Math.floor(Number(n) || 0);
    if (count < 1) return [];
    const total = Math.max(0, Math.round(Number(totalC) || 0));
    const base = Math.floor(total / count);
    const extra = total - base * count;
    return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Live «Asignado $X de $Y»: { assigned, diff (total − assigned), ok (exact and every part positive) }. */
function splitState(totalC, partsC) {
    const parts = Array.isArray(partsC) ? partsC : [];
    const assigned = parts.reduce((s, c) => s + (Number.isInteger(c) ? c : 0), 0);
    const diff = Math.round(Number(totalC) || 0) - assigned;
    return { assigned, diff, ok: parts.length > 0 && diff === 0 && parts.every(c => Number.isInteger(c) && c > 0) };
}

/**
 * The shape rules of a split, before any database read. `parts` = [{ inscription_id, cents }] (ids already
 * positive integers or null for an invalid one). Returns { ok: true } or { ok: false, code, ids? } with
 * code ∈ empty | too_many | invalid_id | duplicate | non_positive | sum_mismatch.
 */
function validateAllocations(parts, totalC, max = MAX_PARTS) {
    if (!Array.isArray(parts) || parts.length === 0) return { ok: false, code: 'empty' };
    if (parts.length > max) return { ok: false, code: 'too_many', max };
    const bad = parts.filter(p => !p || !Number.isInteger(p.inscription_id) || p.inscription_id <= 0);
    if (bad.length) return { ok: false, code: 'invalid_id' };
    const seen = new Set(), dup = new Set();
    for (const p of parts) { if (seen.has(p.inscription_id)) dup.add(p.inscription_id); seen.add(p.inscription_id); }
    if (dup.size) return { ok: false, code: 'duplicate', ids: [...dup] };
    const nonPos = parts.filter(p => !Number.isInteger(p.cents) || p.cents <= 0).map(p => p.inscription_id);
    if (nonPos.length) return { ok: false, code: 'non_positive', ids: nonPos };
    const st = splitState(totalC, parts.map(p => p.cents));
    if (st.diff !== 0) return { ok: false, code: 'sum_mismatch', assigned: st.assigned, diff: st.diff };
    return { ok: true };
}

/**
 * THE «Resumen» of a list of people (the admin's tiles and «Por localidad», the coordinator's summary — the
 * same vectors run through the admin client's summarizeBalances / barSegments and the portal's summarize).
 * Input per person, in cents: { due (0 for a cancelled inscription), validated, pending, returned, cancelled }.
 * Validado and Por validar count each person's money only up to what they owe (validated first, then
 * pending); Por cobrar is what is left; so Validado + Por validar + Por cobrar = Cuotas exactly, whatever the
 * re-prices and cancellations. Validated money past the fee is «A favor» (`credit`) and nowhere else; pending
 * money past the fee (a cancelled person's, an over-cap one) counts in no tile. `returned` is the money in
 * returned payments (outside the equation).
 */
function summaryOf(list) {
    const s = { people: 0, cancelled: 0, due: 0, validated: 0, pending: 0, returned: 0, to_cover: 0, credit: 0 };
    for (const b of Array.isArray(list) ? list : []) {
        if (b.cancelled) s.cancelled++; else s.people++;
        const due = Math.max(0, Math.round(Number(b.due) || 0));
        const val = Math.max(0, Math.round(Number(b.validated) || 0));
        const pend = Math.max(0, Math.round(Number(b.pending) || 0));
        const v = Math.min(val, due);
        const p = Math.min(pend, due - v);
        s.due += due; s.validated += v; s.pending += p; s.to_cover += due - v - p;
        s.returned += Math.max(0, Math.round(Number(b.returned) || 0));
        s.credit += Math.max(0, val - due);
    }
    return s;
}

module.exports = { MAX_PARTS, toCents, fromCents, parseMoneyInput, splitEqual, splitState, validateAllocations, summaryOf };
