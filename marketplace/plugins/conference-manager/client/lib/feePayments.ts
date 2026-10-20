/**
 * «Pagos de cuotas» (2.18.0) — the admin's pure model of fee payments: wire types, the status vocabulary,
 * one person's money state, summaries, the actions the state machine allows, the review queue, the list
 * filters, selection helpers and the «Registrar pago» draft rules.
 *
 * A PAYMENT is one receipt (a bank transfer or a cash handover) split into PARTS, one per person. Its status
 * lives on the payment: pending («Por validar») → validated / returned («Devuelto», the recorder corrects it
 * and resends) / rejected («Rechazado», the money did not arrive). Owner decisions this file encodes:
 *   - D-P2 the parts add up to the payment's amount to the cent;
 *   - D-P9 NEVER more than what a person still owes, counting money awaiting validation (to_cover);
 *   - D-P12 the receipt is required for a transfer and optional for cash;
 *   - D-P5 / D-P10 a payment is validated all-or-nothing and never edited once validated (it is voided —
 *     rejected with a reason — and «Duplicar» re-uses its receipt).
 * The server enforces every rule again; this only keeps the UI from offering what would be refused.
 *
 * All arithmetic is in integer cents (feeSplit.ts). No I/O, no DOM.
 */
import { MAX_PARTS, centsToInput, fromCents, parseMoneyInput, splitEqual, splitState, toCents, validateAllocations } from './feeSplit';
import type { SplitState } from './feeSplit';

export type FeeStatus = 'pending' | 'validated' | 'returned' | 'rejected';
export const FEE_STATUSES: readonly FeeStatus[] = ['pending', 'validated', 'returned', 'rejected'];

/** Text plus icon for every status — never colour alone. `cls` = AA text on its tint. */
export const STATUS_META: Record<FeeStatus, { key: string; fallback: string; icon: string; cls: string; bar: string }> = {
    pending: { key: 'fees.status.pending', fallback: 'Por validar', icon: 'fa-clock', cls: 'bg-amber-50 text-amber-800 border-amber-200', bar: 'bg-amber-400' },
    validated: { key: 'fees.status.validated', fallback: 'Validado', icon: 'fa-circle-check', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200', bar: 'bg-emerald-500' },
    returned: { key: 'fees.status.returned', fallback: 'Devuelto', icon: 'fa-rotate-left', cls: 'bg-orange-50 text-orange-800 border-orange-200', bar: 'bg-orange-400' },
    rejected: { key: 'fees.status.rejected', fallback: 'Rechazado', icon: 'fa-circle-xmark', cls: 'bg-rose-50 text-rose-800 border-rose-200', bar: 'bg-rose-400' },
};
export const statusMeta = (s: unknown) => STATUS_META[(FEE_STATUSES as readonly string[]).includes(String(s)) ? (s as FeeStatus) : 'pending'];

// ── wire shapes (server/fee-payments.js) ─────────────────────────────────────────────────────────────
export type Allocation = {
    id: number; inscription_id: number; amount: number; location_id: number | null; cancelled: boolean;
    // GET /fee-payments/:id only:
    name?: string | null; location?: string | null; total_due?: number; due?: number;
    validated_other?: number; pending_other?: number; returned_other?: number;
    after?: { paid: number; owed: number; credit: number };
};
export type TransferEvent = { id: number; at: string | null; actor: string | null; action: 'created' | 'validated' | 'returned' | 'rejected' | 'edited' | 'resent'; note: string | null };
export type Transfer = {
    id: number; conference_id: number; location_id: number | null; location: string | null; locations: number[]; mixed: boolean;
    amount: number; allocated: number; method: string; reference: string | null; paid_on: string | null; note: string | null;
    status: FeeStatus; review_note: string | null; alloc_gen: number; recorded_via: 'admin' | 'portal' | 'legacy' | null; recorded_by: string | null;
    created_at: string | null; submitted_at: string | null; updated_at: string | null; updated_by: string | null;
    reviewed_at: string | null; reviewed_by: string | null; has_proof: boolean; legacy: boolean; people: number;
    allocations: Allocation[]; flags: { cancelled_people: number[]; duplicate_reference: boolean };
    events?: TransferEvent[];
    /** «Duplicar»: the voided payment this one records again (the first of the chain), or null. */
    duplicate_of?: number | null;
    /** The OTHER payments that record the same handover and count now (on a voided one: its live copy). */
    reused_by?: { id: number; status: FeeStatus }[];
};
export type PersonBalanceWire = {
    id: number; location_id: number | null; total_due: number; due: number; validated: number; pending: number; returned: number;
    to_cover: number; credit: number; cancelled: boolean; payable: boolean;
    // GET /fee-payments (admin) only — who the person is, all «Pagos de cuotas» knows (D-P20: Pagos › ver does
    // not read the roster): the server's display name, the live location, the family group, the inscription
    // status; reg_code only for inscriptions:view (else null).
    name?: string; location?: string | null; family_group?: string | null; status?: string | null; reg_code?: string | null;
};

/**
 * A person of GET /fee-payments as a row the shared pieces read (the person sheet, the picker options,
 * personBalance): who they are and their money under the roster's names — and NOTHING else of the roster
 * (no contact, form answer, room or note: «Pagos de cuotas» never has them).
 */
export function personRowOfWire(w: PersonBalanceWire) {
    return {
        id: Number(w.id), name: w.name || `#${w.id}`,
        location_id: w.location_id == null ? null : Number(w.location_id), location: w.location ?? null,
        family_group: w.family_group ?? null, status: w.status || (w.cancelled ? 'cancelled' : 'active'), reg_code: w.reg_code ?? null,
        total_due: w.total_due, amount_paid: w.validated, pending_amount: w.pending, returned_amount: w.returned,
    };
}
export type FeeSummaryWire = { people: number; cancelled: number; due: number; validated: number; pending: number; returned: number; to_cover: number; credit: number };
export type FeeView = {
    conference_id: number; features: { fee_payments: number }; methods: string[]; max_people: number;
    proof: { required_for: string[]; max_chars: number };
    summary: FeeSummaryWire; by_location: (FeeSummaryWire & { location_id: number | null; location: string | null })[];
    counts: { pending: number; validated: number; returned: number; rejected: number; total: number };
    transfers: Transfer[]; people: PersonBalanceWire[];
};
/** A part as GET /inscriptions/:id/payments lists it (the person sheet's «Pago» section). */
export type PersonPart = {
    id: number; inscription_id: number; amount: number; date: string | null; method: string | null; reference: string | null;
    status: FeeStatus | null; transfer_id: number | null; alloc_gen: number | null; has_proof: boolean;
    reviewed_at: string | null; reviewed_by: string | null; review_note: string | null;
    transfer: { id: number; amount: number; status: FeeStatus; people: number; paid_on: string | null; recorded_via: string | null; location_id: number | null; alloc_gen: number } | null;
};

// ── one person's money (cents) ─────────────────────────────────────────────────────────────────────────
export type Balance = {
    /** Cents. `due` is 0 for a cancelled inscription (nothing is owed). */
    due: number; validated: number; pending: number; returned: number;
    /** What still has no registered payment: max(0, due − validated − pending) — the most a new part may carry. */
    toCover: number;
    /** Validated beyond what is owed (after a re-price): shown apart, never offered. */
    credit: number;
    cancelled: boolean;
    payable: boolean;
    /** The pill: Pagado / Abono / Sin pagar from VALIDATED money only (the server's payment_status). */
    state: 'paid' | 'partial' | 'unpaid';
};

const nonNeg = (c: number) => Math.max(0, c);

/** From a roster row (GET /inscriptions: total_due, amount_paid, pending_amount, returned_amount, status). */
export function personBalance(row: Record<string, any> | null | undefined): Balance {
    const r = row || {};
    const cancelled = r.status === 'cancelled' || r.cancelled === true;
    const due = cancelled ? 0 : nonNeg(toCents(r.total_due));
    const validated = toCents(r.amount_paid);
    const pending = nonNeg(toCents(r.pending_amount));
    const returned = nonNeg(toCents(r.returned_amount));
    const toCover = nonNeg(due - validated - pending);
    const state = r.payment_status === 'paid' || r.payment_status === 'partial' || r.payment_status === 'unpaid'
        ? r.payment_status
        : (due <= 0 || validated >= due ? 'paid' : validated > 0 ? 'partial' : 'unpaid');
    return { due, validated, pending, returned, toCover, credit: nonNeg(validated - due), cancelled, payable: !cancelled && toCover > 0, state };
}

/** From GET /fee-payments `people[]` (already computed by the server; converted to cents). */
export function balanceFromWire(w: PersonBalanceWire | null | undefined): Balance {
    const r = w || ({} as PersonBalanceWire);
    const due = nonNeg(toCents(r.due)), validated = toCents(r.validated);
    return {
        due, validated, pending: nonNeg(toCents(r.pending)), returned: nonNeg(toCents(r.returned)),
        toCover: nonNeg(toCents(r.to_cover)), credit: nonNeg(toCents(r.credit)), cancelled: !!r.cancelled, payable: !!r.payable,
        state: due <= 0 || validated >= due ? 'paid' : validated > 0 ? 'partial' : 'unpaid',
    };
}

export type BalanceChip = { kind: 'pending' | 'returned' | 'credit' | 'cancelled'; cents: number };
/** The chips a compact row shows, only when they apply: «⏱ $X por validar», «↩ Devuelto», «+$X a favor», «Cancelada». */
export function balanceChips(b: Balance): BalanceChip[] {
    const out: BalanceChip[] = [];
    if (b.cancelled) out.push({ kind: 'cancelled', cents: 0 });
    if (b.pending > 0) out.push({ kind: 'pending', cents: b.pending });
    if (b.returned > 0) out.push({ kind: 'returned', cents: b.returned });
    if (b.credit > 0) out.push({ kind: 'credit', cents: b.credit });
    return out;
}

export type MoneySummary = { people: number; cancelled: number; due: number; validated: number; pending: number; returned: number; toCover: number; credit: number };
/**
 * Cents totals of a list of balances (the «Resumen» and each location's line) — the server's summaryOf
 * (server/fee-split.js) and the portal's summarize exactly: Validado and Por validar count each person's money
 * up to what they owe (validated first), Por cobrar is the rest, so the three add up to Cuotas; validated
 * money past the fee is «A favor» only; pending money past it counts in no figure.
 */
export function summarizeBalances(list: Balance[] | null | undefined): MoneySummary {
    const s: MoneySummary = { people: 0, cancelled: 0, due: 0, validated: 0, pending: 0, returned: 0, toCover: 0, credit: 0 };
    for (const b of list || []) {
        if (b.cancelled) s.cancelled++; else s.people++;
        const v = Math.min(b.validated, b.due);
        const p = Math.min(b.pending, b.due - v);
        s.due += b.due; s.validated += v; s.pending += p; s.toCover += b.due - v - p; s.returned += b.returned; s.credit += nonNeg(b.validated - b.due);
    }
    return s;
}

/**
 * The «Resumen» stacked bar: Validado + Por validar + Por cobrar = Cuotas, exactly, in cents (credit apart).
 * Per person the validated money counts up to what is owed, the pending money up to what is left, the rest
 * is «por cobrar» — so the three segments always add up to the fees even after a re-price.
 */
export function barSegments(list: Balance[] | null | undefined): { due: number; validated: number; pending: number; toCover: number } {
    const out = { due: 0, validated: 0, pending: 0, toCover: 0 };
    for (const b of list || []) {
        const v = Math.min(b.validated, b.due);
        const p = Math.min(b.pending, b.due - v);
        out.due += b.due; out.validated += v; out.pending += p; out.toCover += b.due - v - p;
    }
    return out;
}
/** Segment widths in % (rounded to 0.1, never negative; an empty bar is all zeros). */
export const barPercents = (seg: { due: number; validated: number; pending: number; toCover: number }) => {
    const pct = (c: number) => (seg.due > 0 ? Math.max(0, Math.round((c / seg.due) * 1000) / 10) : 0);
    return { validated: pct(seg.validated), pending: pct(seg.pending), toCover: pct(seg.toCover) };
};

// ── the state machine (mirrors server TRANSITIONS / EDITABLE / DELETABLE.admin) ───────────────────────
export type TransferActions = { validate: boolean; return: boolean; reject: boolean; edit: boolean; remove: boolean; duplicate: boolean; voids: boolean };
const NONE: TransferActions = { validate: false, return: false, reject: false, edit: false, remove: false, duplicate: false, voids: false };
/**
 * «Devolver» hands a payment back to whoever recorded it to correct and resend: a location's portal (its own
 * payments) or the administration. A pre-2.18 payment (`legacy`) or a portal one whose location was deleted
 * has nobody to do it (the server answers 409 no_recorder), so it is not offered — edit, validate or reject.
 */
export const canBeReturned = (t: Pick<Transfer, 'recorded_via' | 'location_id'>): boolean =>
    t.recorded_via === 'admin' || (t.recorded_via === 'portal' && t.location_id != null);
/**
 * What the admin may do with a payment in `status` (D-P5..D-P10). Without payments:manage nothing.
 *   pending   → Validar, Devolver… (when someone can correct it: canBeReturned), Rechazar…, Editar reparto, Eliminar
 *   returned  → Editar, Validar, Rechazar…, Eliminar
 *   validated → Rechazar… as «Anular validación» (voids) — never «Duplicar» while it counts (D-P10: void it,
 *               then duplicate the voided one; the server refuses a live source, 409 proof_source_live)
 *   rejected  → Validar, Eliminar, Duplicar — Validar and Duplicar only while no other payment records the same
 *               handover and counts (`reused_by`: one receipt counts once; the server answers 409 source_used)
 * `t` = the payment (its recorder); without it «Devolver…» is offered as before.
 */
export const isReused = (t?: Pick<Transfer, 'reused_by'> | null): boolean => !!(t && Array.isArray(t.reused_by) && t.reused_by.length > 0);
export function transferActions(status: unknown, canManage: boolean, t?: Pick<Transfer, 'recorded_via' | 'location_id' | 'reused_by'> | null): TransferActions {
    if (!canManage) return NONE;
    switch (status) {
        case 'pending': return { ...NONE, validate: true, return: !t || canBeReturned(t), reject: true, edit: true, remove: true };
        case 'returned': return { ...NONE, validate: true, reject: true, edit: true, remove: true };
        case 'validated': return { ...NONE, reject: true, voids: true };
        case 'rejected': return { ...NONE, validate: !isReused(t), remove: true, duplicate: !isReused(t) };
        default: return NONE;
    }
}
/** The `expected` every action sends, so the admin acts on exactly the split they saw. */
export const expectedOf = (t: Pick<Transfer, 'status' | 'alloc_gen'>) => ({ status: t.status, alloc_gen: Number(t.alloc_gen) });

/** Quick reasons for «Devolver» / «Rechazar» (inline note form). */
export const REVIEW_REASONS: { key: string; fallback: string }[] = [
    { key: 'fees.reason.illegible', fallback: 'Comprobante ilegible' },
    { key: 'fees.reason.amount', fallback: 'El monto no coincide' },
    { key: 'fees.reason.people', fallback: 'Falta o sobra una persona' },
    { key: 'fees.reason.not.received', fallback: 'No se recibió el dinero' },
];

/**
 * Would validating take anyone past what they owe (the server answers 409 over_cap / cancelled_people)? The
 * server's validate rule exactly, from the detail (GET /fee-payments/:id): part > due − validated money in
 * OTHER payments, where a CANCELLED inscription owes nothing (D-P9 «Nunca», D-P19) — a person cancelled after
 * the payment was recorded blocks it until the split is corrected, the person reactivated or the payment
 * rejected. Without those facts (an older detail) the after-state's credit decides.
 */
export const validationBlocked = (t: Pick<Transfer, 'allocations'>): number[] =>
    (t.allocations || []).filter((a) => {
        if (a.cancelled) return true;
        if (a.total_due === undefined || a.validated_other === undefined) return !!(a.after && toCents(a.after.credit) > 0);
        return toCents(a.amount) > Math.max(0, toCents(a.total_due) - toCents(a.validated_other));
    }).map((a) => a.inscription_id);

// ── the review queue («Por validar», D-P21: one at a time, «Validar y siguiente») ─────────────────────
const stamp = (t: Transfer) => String(t.submitted_at || t.created_at || '');
/** Pending payments, OLDEST first (the order they arrived in). */
export const queueOf = (list: Transfer[] | null | undefined): Transfer[] =>
    (list || []).filter((t) => t.status === 'pending').sort((a, b) => (stamp(a) < stamp(b) ? -1 : stamp(a) > stamp(b) ? 1 : a.id - b.id));
/**
 * The payment to show after `id` left the queue: the one that followed it, else the one before it, else
 * none. `before` is the queue as it was when the action started (the current one may no longer hold `id`).
 */
export function nextInQueue(before: Transfer[], after: Transfer[], id: number): number | null {
    const ids = new Set(after.map((t) => t.id));
    const i = before.findIndex((t) => t.id === id);
    for (let j = i + 1; j < before.length; j++) if (before[j].id !== id && ids.has(before[j].id)) return before[j].id;
    for (let j = Math.min(i, before.length) - 1; j >= 0; j--) if (before[j].id !== id && ids.has(before[j].id)) return before[j].id;
    const first = after.find((t) => t.id !== id);
    return first ? first.id : null;
}

/**
 * The warning chips of a queue card, from the list data alone: «Persona cancelada», «Referencia repetida»
 * and «Supera lo que debe» — a part larger than the person's fee minus their validated money (validating
 * would take them past what they owe; the server refuses it, D-P9). `balanceOf(id)` = the person's Balance.
 * A cancelled person is «Persona cancelada», not «Supera»: the server validates their part (and flags it),
 * like validationBlocked.
 */
export function queueWarnings(t: Pick<Transfer, 'allocations' | 'flags' | 'status'>, balanceOf: (id: number) => Balance | undefined): ('cancelled' | 'reference' | 'over')[] {
    const out: ('cancelled' | 'reference' | 'over')[] = [];
    if ((t.flags?.cancelled_people || []).length || (t.allocations || []).some((a) => a.cancelled)) out.push('cancelled');
    if (t.flags?.duplicate_reference) out.push('reference');
    const over = (t.allocations || []).some((a) => {
        const b = balanceOf(Number(a.inscription_id));
        if (!b || a.cancelled || b.cancelled) return false;
        const own = t.status === 'validated' ? toCents(a.amount) : 0;
        return toCents(a.amount) > Math.max(0, b.due - (b.validated - own));
    });
    if (over) out.push('over');
    return out;
}

// ── list filters («Pagos») ─────────────────────────────────────────────────────────────────────────────
export type TransferFilter = {
    statuses: FeeStatus[]; location: string; method: string; via: '' | 'admin' | 'portal' | 'legacy';
    from: string; to: string; q: string; inscriptionId: number | null;
};
export const EMPTY_TRANSFER_FILTER: TransferFilter = { statuses: [], location: '', method: '', via: '', from: '', to: '', q: '', inscriptionId: null };
const fold = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
/**
 * Does a payment belong to location `key` ('' = any, 'none' = «Sin localidad», else an id)? A payment matches
 * the recorder's location and each of its people's locations — «Sin localidad» included, when one of its
 * people has none. The same rule as the server's `?location_id=` and «Contabilidad»'s filter (filterLedger).
 */
export function transferInLocation(t: Pick<Transfer, 'location_id' | 'locations' | 'allocations'>, key: string): boolean {
    if (!key) return true;
    if (key === 'none') return t.location_id == null && (!(t.locations || []).length || (t.allocations || []).some((a) => a.location_id == null));
    const lid = Number(key);
    return Number(t.location_id) === lid || (t.locations || []).includes(lid);
}
/**
 * `location`: '' = all, 'none' = «Sin localidad», else an id (transferInLocation). `q` (folded, every word):
 * the reference, «#id» and the people's names (`nameOf`).
 */
export function filterTransfers(list: Transfer[] | null | undefined, f: TransferFilter, nameOf: (id: number) => string = () => ''): Transfer[] {
    const words = fold(f.q).split(/\s+/).filter(Boolean);
    return (list || []).filter((t) => {
        if (f.statuses.length && !f.statuses.includes(t.status)) return false;
        if (!transferInLocation(t, f.location)) return false;
        if (f.method && t.method !== f.method) return false;
        if (f.via && t.recorded_via !== f.via) return false;
        if (f.from && (!t.paid_on || t.paid_on < f.from)) return false;
        if (f.to && (!t.paid_on || t.paid_on > f.to)) return false;
        if (f.inscriptionId != null && !(t.allocations || []).some((a) => Number(a.inscription_id) === Number(f.inscriptionId))) return false;
        if (words.length) {
            const hay = fold([`#${t.id}`, t.reference, ...(t.allocations || []).map((a) => nameOf(a.inscription_id))].join(' \u0001 '));
            if (!words.every((w) => hay.includes(w))) return false;
        }
        return true;
    });
}

/** «Ana P.» — first word plus the next word's initial (a one-word name stays whole). */
/**
 * «Ana P.»: the first name and the initial joined by a NO-BREAK space — a line breaks between two people, never
 * between a name and its initial (the ledger's uppercase line read «CARLOS» / «G., ELENA G. +1» on a phone,
 * 2.18.0 review UX6-4).
 */
export const shortName = (full: string): string => {
    const w = String(full || '').trim().split(/\s+/).filter(Boolean);
    if (w.length < 2) return w[0] || '';
    return `${w[0]}\u00a0${w[1].charAt(0).toUpperCase()}.`;
};
/** «Ana P., Luis P. +1» (at most `max` names; «+1» stays with the last name shown). */
export function peopleLabel(allocations: Pick<Allocation, 'inscription_id'>[] | null | undefined, nameOf: (id: number) => string, max = 2): string {
    const list = allocations || [];
    const names = list.slice(0, max).map((a) => shortName(nameOf(a.inscription_id)) || `#${a.inscription_id}`);
    return list.length > max ? `${names.join(', ')}\u00a0+${list.length - max}` : names.join(', ');
}

// ── «Saldos» ─────────────────────────────────────────────────────────────────────────────────────────
export type BalanceFilter = 'owing' | 'pending' | 'returned' | 'paid' | 'credit' | 'all';
export const BALANCE_FILTERS: { key: BalanceFilter; label: string; fallback: string }[] = [
    { key: 'owing', label: 'fees.balances.owing', fallback: 'Con saldo' },
    { key: 'pending', label: 'fees.balances.pending', fallback: 'Por validar' },
    { key: 'returned', label: 'fees.balances.returned', fallback: 'Devuelto' },
    { key: 'paid', label: 'fees.balances.paid', fallback: 'Pagados' },
    { key: 'credit', label: 'fees.balances.credit', fallback: 'A favor' },
    { key: 'all', label: 'fees.balances.all', fallback: 'Todos' },
];
export const matchesBalanceFilter = (b: Balance, f: BalanceFilter): boolean => {
    switch (f) {
        case 'owing': return b.payable;
        case 'pending': return b.pending > 0;
        case 'returned': return b.returned > 0;
        case 'paid': return !b.cancelled && b.due > 0 && b.validated >= b.due;
        case 'credit': return b.credit > 0;
        default: return true;
    }
};

/** How many people each «Saldos» chip would show — the count on the chip, like the portal's «Con saldo (29)». */
export function balanceFilterCounts(list: (Balance | null | undefined)[] | null | undefined): Record<BalanceFilter, number> {
    const out = Object.fromEntries(BALANCE_FILTERS.map((f) => [f.key, 0])) as Record<BalanceFilter, number>;
    for (const b of list || []) {
        if (!b) continue;
        for (const f of BALANCE_FILTERS) if (matchesBalanceFilter(b, f.key)) out[f.key]++;
    }
    return out;
}

// ── selection (Saldos multi-select, D-P17; capped at MAX_PARTS like the server) ───────────────────────
export const toggleId = (sel: number[], id: number, cap = MAX_PARTS): number[] =>
    sel.includes(id) ? sel.filter((x) => x !== id) : sel.length >= cap ? sel : [...sel, id];
/** The header box of a page: 'all' when every row of the page is selected, 'some', or 'none'. */
export const pageSelectionState = (pageIds: number[], sel: number[]): 'none' | 'some' | 'all' => {
    if (!pageIds.length) return 'none';
    const n = pageIds.filter((id) => sel.includes(id)).length;
    return n === 0 ? 'none' : n === pageIds.length ? 'all' : 'some';
};
/** Select (or, when all are already selected, deselect) the page; never past the cap. */
export function selectPage(sel: number[], pageIds: number[], cap = MAX_PARTS): number[] {
    if (pageSelectionState(pageIds, sel) === 'all') return sel.filter((id) => !pageIds.includes(id));
    const out = [...sel];
    for (const id of pageIds) { if (out.length >= cap) break; if (!out.includes(id)) out.push(id); }
    return out;
}
/** «Seleccionar los N»: the first `cap` ids of the filtered list (in list order). */
export const selectAllCapped = (ids: number[], cap = MAX_PARTS): number[] => [...new Set(ids)].slice(0, cap);
/** Drop ids that are gone (or no longer selectable) after a reload. */
export const pruneSelection = (sel: number[], valid: Set<number> | number[]): number[] => {
    const v = valid instanceof Set ? valid : new Set(valid);
    return sel.filter((id) => v.has(id));
};

// ── «Registrar pago» draft ─────────────────────────────────────────────────────────────────────────────
export type SplitMode = 'equal' | 'manual';
export type FeeDraft = {
    people: number[];
    amount: string;
    method: string;
    paidOn: string;
    reference: string;
    note: string;
    mode: SplitMode;
    /** «Manual»: the typed text per person. */
    manual: Record<number, string>;
    /** undefined = keep (edit) / none; null = remove (edit, cash only); a data URL = the new receipt. */
    proof?: string | null;
    /** The edited / duplicated payment already has a receipt (kept unless replaced or removed). */
    keepsProof?: boolean;
    copyProofFrom?: number | null;
    /** «Duplicar»: the voided payment this draft records again (sent as `duplicate_of`, with or without its receipt). */
    duplicateOf?: number | null;
    leavePending: boolean;
    clientKey: string;
    /** A photo is being shrunk on the device: sending now would send the old receipt (or none). */
    proofWorking?: boolean;
    /** The «Manual» amounts were TYPED (or are the payment's own split): «Iguales» → «Manual» gives them back. */
    manualTyped?: boolean;
};
/** Methods that REQUIRE a receipt (D-P12: optional for cash, for everyone). */
export const PROOF_REQUIRED_FOR = ['Transferencia'];
export const proofRequired = (method: string, requiredFor: string[] = PROOF_REQUIRED_FOR): boolean => requiredFor.includes(method);

const pad2 = (n: number) => String(n).padStart(2, '0');
export const localDay = (d: Date = new Date()): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** The server refuses a date after tomorrow (any clock offset); the sheet refuses it after today+1 too. */
export const maxPaidOn = (now: Date = new Date()): string => localDay(new Date(now.getTime() + 24 * 60 * 60 * 1000));

/**
 * Has the admin changed anything since the sheet opened (`start` = its first draft)? People, amounts, the
 * split, the method, date, reference, note, a receipt picked or removed, «Dejar por validar». A sheet with
 * changes asks before Escape throws them away (2.18.0 review: the people, the split and a compressed receipt
 * were lost to one key). Amounts compare as money («250» = «250,00»); people in any order.
 */
export function draftIsDirty(start: FeeDraft, now: FeeDraft): boolean {
    if (!start || !now) return false;
    const ids = (d: FeeDraft) => [...(d.people || [])].map(Number).sort((a, b) => a - b).join(',');
    const cents = (v: unknown) => { const c = parseMoneyInput(String(v ?? '')); return c === null ? String(v ?? '').trim() : c; };
    const text = (v: unknown) => String(v ?? '').trim();
    if (ids(start) !== ids(now)) return true;
    if (cents(start.amount) !== cents(now.amount)) return true;
    if (start.method !== now.method || text(start.paidOn) !== text(now.paidOn)) return true;
    if (text(start.reference) !== text(now.reference) || text(start.note) !== text(now.note)) return true;
    if (start.mode !== now.mode || !!start.leavePending !== !!now.leavePending) return true;
    if (start.proof !== now.proof) return true;
    if (now.mode === 'manual') for (const id of now.people || []) if (cents((start.manual || {})[id]) !== cents((now.manual || {})[id])) return true;
    return false;
}

/** An idempotency key per draft (8–64 of [A-Za-z0-9_-]): a retry of the same draft never records twice. */
export function newClientKey(rand: () => number = Math.random): string {
    try {
        const c = (globalThis as any).crypto;
        if (c && typeof c.randomUUID === 'function') return String(c.randomUUID()).replace(/[^A-Za-z0-9_-]/g, '');
    } catch { /* fall back below */ }
    let s = 'k';
    for (let i = 0; i < 31; i++) s += Math.floor(rand() * 36).toString(36);
    return s;
}

/** The parts of a draft in cents, in people order (null for an unreadable manual amount). */
export function draftParts(d: Pick<FeeDraft, 'people' | 'amount' | 'mode' | 'manual'>): { inscription_id: number; cents: number | null }[] {
    if (d.mode === 'equal') {
        const total = parseMoneyInput(d.amount) ?? 0;
        const parts = splitEqual(total, d.people.length);
        return d.people.map((id, i) => ({ inscription_id: id, cents: parts[i] ?? 0 }));
    }
    return d.people.map((id) => ({ inscription_id: id, cents: parseMoneyInput(d.manual[id] ?? '') }));
}

export type DraftIssue =
    | 'empty' | 'too_many' | 'invalid_amount' | 'no_method' | 'invalid_date' | 'future_date'
    | 'non_positive' | 'sum_mismatch' | 'over_cap' | 'cancelled_people' | 'proof_required' | 'proof_working';
export type DraftCheck = {
    totalC: number | null;
    parts: { inscription_id: number; cents: number | null }[];
    split: SplitState;
    /** People whose part is larger than they may receive (D-P9), with that maximum in cents. */
    overCap: { inscription_id: number; cents: number; max: number }[];
    issues: DraftIssue[];
    ok: boolean;
};

/**
 * Everything that would make the server refuse the draft, before sending it. `capOf(id)` = the most that
 * person may receive in THIS payment (cents; null = unknown person), `cancelled(id)` = the person is
 * cancelled (never payable). The submit button stays disabled until `ok`.
 */
export function checkDraft(
    d: FeeDraft,
    ctx: { capOf: (id: number) => number | null; cancelled?: (id: number) => boolean; methods?: string[]; requiredFor?: string[]; today?: Date },
): DraftCheck {
    const issues: DraftIssue[] = [];
    const totalC = parseMoneyInput(d.amount);
    const parts = draftParts(d);
    const split = splitState(totalC ?? 0, parts.map((p) => p.cents));
    if (!d.people.length) issues.push('empty');
    if (d.people.length > MAX_PARTS) issues.push('too_many');
    if (totalC === null || totalC <= 0) issues.push('invalid_amount');
    if (!d.method || (ctx.methods && !ctx.methods.includes(d.method))) issues.push('no_method');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.paidOn || '')) issues.push('invalid_date');
    else if (d.paidOn > maxPaidOn(ctx.today)) issues.push('future_date');
    if (d.people.length && totalC && totalC > 0) {
        const v = validateAllocations(parts, totalC);
        if (!v.ok && (v.code === 'non_positive' || v.code === 'sum_mismatch')) issues.push(v.code);
    }
    const overCap: DraftCheck['overCap'] = [];
    for (const p of parts) {
        const max = ctx.capOf(p.inscription_id);
        if (p.cents != null && max != null && p.cents > max) overCap.push({ inscription_id: p.inscription_id, cents: p.cents, max });
    }
    if (overCap.length) issues.push('over_cap');
    if (ctx.cancelled && d.people.some((id) => ctx.cancelled!(id))) issues.push('cancelled_people');
    const hasProof = typeof d.proof === 'string' ? !!d.proof : d.proof === null ? false : !!(d.keepsProof || d.copyProofFrom);
    if (proofRequired(d.method, ctx.requiredFor) && !hasProof) issues.push('proof_required');
    if (d.proofWorking) issues.push('proof_working');
    return { totalC, parts, split, overCap, issues, ok: issues.length === 0 };
}

/**
 * The words under one part of «Registrar pago» (cents), once the part is within what the person may receive:
 *   - 'left'               «Faltará $X» — something is still owed after it;
 *   - 'paid'               «Queda pagado» — a payment born validated that covers the rest, and nothing else
 *                          of theirs is waiting for validation;
 *   - 'paid_after_pending' «Queda pagado al validarse lo pendiente» — part of what they owe is covered by
 *                          OTHER money still awaiting validation (until then: «Abono»), whether this payment
 *                          is born validated or waits too;
 *   - 'paid_when'          «Queda pagado al validarse» — this payment itself waits for validation (left
 *                          pending, or an edit, which always goes back to pending) and nothing else does;
 *   - 'none'               nothing to say (an unknown person or an unreadable amount; a part past the cap
 *                          says «Supera…» instead).
 * The coordinator portal words its parts with the same rule (portal RegisterPaymentSheet afterText; its
 * payments always wait for validation).
 */
export function partAfterKind(capC: number | null | undefined, partC: number | null | undefined, opts: { bornValidated: boolean; otherPendingC: number }):
    'left' | 'paid' | 'paid_after_pending' | 'paid_when' | 'none' {
    if (capC == null || partC == null) return 'none';
    const left = capC - partC;
    if (left > 0) return 'left';
    if (left < 0) return 'none';
    if (opts.otherPendingC > 0) return 'paid_after_pending';
    return opts.bornValidated ? 'paid' : 'paid_when';
}

/**
 * A chosen person's line in «Registrar pago» (the portal's words): «$Y por validar · falta $Z» while some of
 * their money awaits validation, else «debe $Z» — never «debe $X · falta $X» with the same figure twice.
 */
export function chosenPersonLine(leftC: number, pendingC: number): { key: string; fallback: string; vars: { pending?: number; left: number } } {
    return pendingC > 0
        ? { key: 'fees.register.owes.pending', fallback: '{pending} por validar · falta {left}', vars: { pending: pendingC, left: leftC } }
        : { key: 'fees.register.owes.left', fallback: 'debe {left}', vars: { left: leftC } };
}

/**
 * What a person still has to cover, in the same words everywhere — the picker, the chosen people of «Registrar
 * pago» (chosenPersonLine) and «Saldos»: «debe $X» while none of their money awaits validation; with money
 * awaiting validation «falta $X», beside «$Y por validar» (in «Saldos» that is the row's own chip). The picker
 * and «Saldos» said «falta» where the register sheet and the portal said «debe» for the same state.
 * `leftC` = what no payment covers yet (cents). Nothing to cover → null. `word` = the label alone (a narrow
 * column: the word over the amount).
 */
export const OWED_TEXT = {
    due: { key: 'fees.owes.due', fallback: 'debe {amount}', word: { key: 'fees.owes.due.word', fallback: 'debe' } },
    left: { key: 'fees.owes.left', fallback: 'falta {amount}', word: { key: 'fees.owes.left.word', fallback: 'falta' } },
} as const;
export const OWED_PENDING = { key: 'fees.owes.pending', fallback: '{amount} por validar' } as const;
export function owedWords(leftC: number, pendingC: number): { kind: 'due' | 'left'; key: string; fallback: string; word: { key: string; fallback: string }; cents: number; pendingC: number } | null {
    if (!(leftC > 0)) return null;
    const kind = pendingC > 0 ? 'left' : 'due';
    return { kind, ...OWED_TEXT[kind], cents: leftC, pendingC: Math.max(0, pendingC) };
}

/** The footer's words for a split that does not add up: «Faltan $X por repartir.» / «Sobran $X en el reparto.» (cents). */
export function sumMismatchText(diffC: number): { key: string; fallback: string; cents: number } {
    return diffC > 0
        ? { key: 'fees.issue.sum.missing', fallback: 'Faltan {amount} por repartir.', cents: diffC }
        : { key: 'fees.issue.sum.extra', fallback: 'Sobran {amount} en el reparto.', cents: -diffC };
}

/** POST / PUT /fee-payments body of a checked draft (amounts back to 2-decimal numbers). */
export function buildFeeBody(d: FeeDraft, check: DraftCheck, extra: { conferenceId?: number; allowDuplicateReference?: boolean; expected?: { status: FeeStatus; alloc_gen: number } } = {}) {
    const body: Record<string, unknown> = {
        amount: fromCents(check.totalC ?? 0),
        method: d.method,
        paid_on: d.paidOn,
        reference: d.reference.trim() || null,
        note: d.note.trim() || null,
        client_key: d.clientKey,
        leave_pending: !!d.leavePending,
        allocations: check.parts.map((p) => ({ inscription_id: p.inscription_id, amount: fromCents(p.cents ?? 0) })),
    };
    if (typeof d.proof === 'string' && d.proof) body.proof = d.proof;
    else if (d.proof === null) body.proof = null;
    if (d.copyProofFrom && body.proof === undefined) body.copy_proof_from = d.copyProofFrom;
    if (d.duplicateOf) body.duplicate_of = d.duplicateOf;
    if (extra.conferenceId) body.conference_id = extra.conferenceId;
    if (extra.allowDuplicateReference) body.allow_duplicate_reference = true;
    if (extra.expected) body.expected = extra.expected;
    return body;
}

/**
 * The «Manual» amounts a switch to «Manual» starts from — the portal's rule (feePayments.ts manualSeed):
 * what each person may still receive when the total is exactly that sum (so «Iguales» refused for people
 * who owe different amounts becomes a valid split in one tap), else the «Iguales» split of the total.
 */
export function manualSeed(people: number[], totalC: number, capOf: (id: number) => number | null): Record<number, string> {
    const caps = people.map((id) => capOf(id) ?? 0);
    const byCap = caps.length > 0 && caps.reduce((s, c) => s + c, 0) === totalC && caps.every((c) => c > 0);
    const parts = byCap ? caps : splitEqual(totalC, people.length);
    const out: Record<number, string> = {};
    people.forEach((id, i) => { out[id] = centsToInput(parts[i] || 0); });
    return out;
}

/**
 * The «Manual» amounts a switch BACK to «Manual» shows: the ones the admin typed, when they did (2.18.0 review
 * UX6-6 — with the arrow keys the «Reparto» strip goes Manual → Iguales → Manual in two keystrokes, and the
 * typed split was silently replaced by a new seed); a person added meanwhile starts from what they may still
 * receive. Without typed amounts, manualSeed.
 */
export function manualOnSwitch(d: Pick<FeeDraft, 'people' | 'manual' | 'manualTyped'>, totalC: number, capOf: (id: number) => number | null): Record<number, string> {
    if (!d.manualTyped) return manualSeed(d.people, totalC, capOf);
    return reseedManual(d.manual || {}, d.people, (id) => centsToInput(capOf(id) ?? 0));
}

/**
 * The manual amounts after the people change: a person who stays keeps their text, a new one starts from
 * what they still owe (capped by what is left of the total), a removed one goes.
 */
export function reseedManual(manual: Record<number, string>, people: number[], seed: (id: number) => string): Record<number, string> {
    const out: Record<number, string> = {};
    for (const id of people) out[id] = manual[id] !== undefined ? manual[id] : seed(id);
    return out;
}

/** The i18n key + Spanish fallback of a server error `code` (errors carry `{ error, code }`). */
export const FEE_ERROR_TEXT: Record<string, string> = {
    empty: 'Selecciona al menos una persona.',
    too_many: 'Máximo 200 personas por pago.',
    invalid_amount: 'El monto debe ser mayor que cero.',
    invalid_date: 'Fecha del pago inválida.',
    future_date: 'La fecha del pago no puede ser futura.',
    non_positive: 'Cada parte del reparto debe ser mayor que cero.',
    sum_mismatch: 'El reparto no suma el monto del pago.',
    proof_required: 'El comprobante es obligatorio para una transferencia.',
    proof_source: 'El pago de origen no tiene comprobante.',
    proof_source_live: 'Anula (rechaza) el pago de origen antes de duplicarlo: mientras cuente, su comprobante no puede registrar otro pago.',
    source_used: 'Este pago anulado ya se registró de nuevo en otro pago que cuenta: un mismo comprobante no puede contar dos veces. Anula o elimina ese otro pago antes.',
    unknown_people: 'Alguna de las personas no pertenece a esta conferencia.',
    cancelled_people: 'Una inscripción cancelada no puede recibir pagos.',
    over_cap: 'El pago supera lo que falta por pagar de alguna persona.',
    no_recorder: 'Nadie puede corregir este pago desde el portal: edítalo tú o recházalo.',
    invalid_proof: 'El comprobante guardado no se puede mostrar: no es una imagen válida o es demasiado grande.',
    duplicate_reference: 'Esa referencia ya se usó en otro pago.',
    client_key_conflict: 'Ese identificador de envío ya se usó para otro pago.',
    client_key_changed: 'Este pago ya se había registrado antes con otros datos (pago #{id}): revísalo en «Pagos» en lugar de enviarlo de nuevo.',
    stale: 'Otra persona cambió este pago; se volvió a cargar.',
    invalid_transition: 'Este pago no admite esa acción en su estado actual.',
    validated_delete: 'Un pago validado no se puede eliminar; recházalo primero.',
    note_required: 'Escribe el motivo.',
    note_too_long: 'El motivo es demasiado largo (máximo 2000 caracteres).',
    shared: 'Este pago es compartido: revísalo en «Pagos de cuotas».',
    no_proof: 'Este pago no tiene comprobante.',
    not_found: 'Pago no encontrado.',
    unavailable: '«Pagos de cuotas» no está disponible: su migración no se completó (revisa el registro del servidor).',
};
/**
 * A thrown api() error → the text to show (by `code` when known, else the server's message). `client_key_changed`
 * names the payment the first send recorded (details.id: «… (pago #12) …»).
 */
export function feeErrorText(e: unknown, tx: (key: string, fallback: string, vars?: Record<string, string | number>) => string): string {
    const err = (e || {}) as { code?: string; message?: string; details?: { id?: unknown } };
    if (err.code === 'client_key_changed') {
        const id = Number(err.details && err.details.id) || 0;
        return tx('fees.error.client_key_changed', FEE_ERROR_TEXT.client_key_changed, { id: id || '?' });
    }
    if (err.code && FEE_ERROR_TEXT[err.code]) return tx(`fees.error.${err.code}`, FEE_ERROR_TEXT[err.code]);
    return err.message || 'Error';
}
/**
 * Codes after which the shown data is stale and must be reloaded (`client_key_changed`: the first send DID record
 * a payment, which the lists must now show).
 */
export const RELOAD_CODES = new Set(['stale', 'invalid_transition', 'over_cap', 'unknown_people', 'cancelled_people', 'not_found', 'no_recorder', 'proof_source_live', 'source_used', 'client_key_changed']);

// ── display ─────────────────────────────────────────────────────────────────────────────────────────────
/** «$1.250,00» from cents, in the browser's locale grouping (like fmtMoney), «-$» for a negative amount. */
export const moneyText = (c: number, fmt: (v: number) => string): string => `${c < 0 ? '-$' : '$'}${fmt(Math.abs(c) / 100)}`;
/** 'YYYY-MM-DD' (or a datetime) → DD/MM/YYYY; anything else as it is. */
export const fmtDay = (v: unknown): string => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v || '');
};
/**
 * A server stamp → «05/10 14:20» in local time. SQLite / MySQL stamps ('YYYY-MM-DD HH:MM:SS') are UTC
 * (CURRENT_TIMESTAMP); an ISO string with a zone is read as such.
 */
export const fmtStamp = (v: unknown, withYear = false): string => {
    const s = String(v || '');
    if (!s) return '';
    const plain = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
    const d = plain ? new Date(`${plain[1]}T${plain[2]}Z`) : new Date(s);
    if (Number.isNaN(d.getTime())) return fmtDay(s);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}${withYear ? `/${d.getFullYear()}` : ''} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
/**
 * A history line's actor («Historial»): the server stores 'portal:<location id>' for a coordinator. That
 * becomes the location's name — the payment's own location when it is that one, else `locationName(id)` —
 * and «Portal» when unknown; an administrator's login stays as it is.
 */
export function actorText(actor: string | null | undefined, t: Pick<Transfer, 'location_id' | 'location'>, locationName?: (id: number) => string | null | undefined):
    { kind: 'portal'; location: string | null } | { kind: 'user'; text: string } | null {
    if (!actor) return null;
    const m = /^portal:(\d+)$/.exec(String(actor));
    if (!m) return { kind: 'user', text: String(actor) };
    const id = Number(m[1]);
    const name = t.location_id != null && Number(t.location_id) === id && t.location ? t.location : (locationName ? locationName(id) : null);
    return { kind: 'portal', location: name || null };
}

/** Who recorded a payment, for «Registrado por …»: the portal's location, the administration's login, or the old system. */
export const recorderKind = (t: Pick<Transfer, 'recorded_via'>): 'portal' | 'admin' | 'legacy' =>
    t.recorded_via === 'portal' ? 'portal' : t.recorded_via === 'legacy' ? 'legacy' : 'admin';
