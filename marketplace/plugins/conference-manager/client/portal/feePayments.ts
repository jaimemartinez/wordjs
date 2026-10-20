/**
 * «Pagos de cuotas» in the coordinator portal (conference-manager ≥ 2.18.0) — everything that is not
 * React: the wire types and their defensive parsing, the money state of a person and of the location (in
 * INTEGER CENTS), the «Registrar pago» draft and its rules, the server's error codes, and the API client.
 *
 * THE MODEL (server/fee-payments.js in the plugin). A PAYMENT is one receipt — a bank transfer or a cash
 * handover — split into PARTS, one per person; the parts add up to the receipt to the cent. A payment the
 * coordinator records is «Por validar» until the administration validates it, returns it («Devuelto»,
 * with a note: correct it and resend it) or rejects it («Rechazado»: the money did not arrive). The
 * coordinator also sees, read-only, the payments the administration recorded for their people (D-P22).
 *
 * THE RULES the sheet enforces before the server does (owner decisions):
 * - D-P2 the split adds up exactly to the amount;
 * - D-P9 «Nunca»: nobody may be paid more than they still owe, counting the money already awaiting
 *   validation — each part ≤ the person's `to_cover` (plus, when correcting a pending payment, that
 *   payment's own part, which the server leaves out of its own cap);
 * - D-P12 the receipt is required for a transfer and optional for cash;
 * - D-P19 a cancelled inscription owes nothing and cannot be paid;
 * - only the location's enabled forms of payment.
 *
 * THE THROTTLE. The plugin caps the authenticated requests in flight per location (LOGIN_MAX_INFLIGHT = 3):
 * the tab makes ONE `GET /portal/fee-payments` when it mounts (createViewLoader de-duplicates a second
 * mount, e.g. React's StrictMode), receipts are fetched only when asked for, and every write answers with
 * the whole view — no reload request after a write, no polling.
 */
import { fmtMoney } from "./form";
import { MAX_PARTS, centsToInput, fromCents, parseMoneyInput, splitEqual, splitState, toCents, validateAllocations, type SplitState } from "./feeSplit";
import { isCancelled, type PortalPerson } from "./participants";

export const API = "/api/v1/plugin/conference-manager";

// ── wire types ───────────────────────────────────────────────────────────────────────────────────
export type FeeStatus = "pending" | "validated" | "returned" | "rejected";
export const FEE_STATUSES: readonly FeeStatus[] = ["pending", "validated", "returned", "rejected"];

/** One person's money (`people[]` of the view). Amounts are 2-decimal numbers on the wire. */
export type FeeBalance = {
    id: number;
    due: number;
    validated: number;
    pending: number;
    returned: number;
    to_cover: number;
    credit: number;
    cancelled: boolean;
    payable: boolean;
};

export type FeeAllocation = { id: number; inscription_id: number; amount: number; moved: boolean; cancelled: boolean };

/** A payment as the portal sees it: its own (full) or another recorder's (only this location's parts). */
export type PortalTransfer = {
    id: number;
    foreign: boolean;
    recorded_via: "portal" | "admin" | "legacy";
    amount: number;
    allocated: number;
    method: string;
    reference: string | null;
    paid_on: string | null;
    note: string | null;
    status: FeeStatus;
    review_note: string | null;
    alloc_gen: number;
    created_at: string | null;
    submitted_at: string | null;
    updated_at: string | null;
    reviewed_at: string | null;
    has_proof: boolean;
    people: number;
    allocations: FeeAllocation[];
    can_edit: boolean;
    can_delete: boolean;
    /** «Duplicar»: the location's own voided payment this one records again (null when none, or not its own). */
    duplicate_of: number | null;
    /**
     * A voided payment that another payment already records again and that counts: one receipt counts in ONE
     * payment, so it is not offered «Duplicar» again (the server answers 409 source_used). `reused_by` = that
     * payment when it is the location's own (an administration's one is not named).
     */
    reused: boolean;
    reused_by: number | null;
};

export type FeeCounts = { pending: number; validated: number; returned: number; rejected: number; total: number };

/** `GET /portal/fee-payments` (and the `view` of every write). */
export type PortalFeeView = {
    location: { id: number; name: string } | null;
    methods: string[];
    can_record: boolean;
    proof: { required_for: string[]; max_chars: number };
    max_people: number;
    people: FeeBalance[];
    counts: FeeCounts;
    transfers: PortalTransfer[];
};

// ── parsing (never trust the shape: a malformed item is dropped, never a crash) ──────────────────────
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const int = (v: unknown): number | null => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const bool = (v: unknown): boolean => v === true || v === 1 || v === "1";
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const isStatus = (v: unknown): v is FeeStatus => typeof v === "string" && (FEE_STATUSES as readonly string[]).includes(v);

export function parseBalance(raw: unknown): FeeBalance | null {
    const o = obj(raw);
    const id = int(o.id);
    if (!id) return null;
    return {
        id, due: num(o.due), validated: num(o.validated), pending: num(o.pending), returned: num(o.returned),
        to_cover: num(o.to_cover), credit: num(o.credit), cancelled: bool(o.cancelled), payable: bool(o.payable),
    };
}

export function parseTransfer(raw: unknown): PortalTransfer | null {
    const o = obj(raw);
    const id = int(o.id);
    if (!id || !isStatus(o.status)) return null;
    const allocations = (Array.isArray(o.allocations) ? o.allocations : []).flatMap((a): FeeAllocation[] => {
        const x = obj(a);
        const aid = int(x.id), iid = int(x.inscription_id);
        return aid && iid ? [{ id: aid, inscription_id: iid, amount: num(x.amount), moved: bool(x.moved), cancelled: bool(x.cancelled) }] : [];
    });
    const via = o.recorded_via === "admin" || o.recorded_via === "legacy" ? o.recorded_via : "portal";
    const foreign = bool(o.foreign);
    return {
        id, foreign, recorded_via: via,
        amount: num(o.amount), allocated: num(o.allocated ?? o.amount), method: typeof o.method === "string" ? o.method : "",
        reference: str(o.reference), paid_on: str(o.paid_on), note: str(o.note), status: o.status, review_note: str(o.review_note),
        alloc_gen: int(o.alloc_gen) ?? 1, created_at: str(o.created_at), submitted_at: str(o.submitted_at), updated_at: str(o.updated_at),
        reviewed_at: str(o.reviewed_at), has_proof: !foreign && bool(o.has_proof), people: int(o.people) ?? allocations.length, allocations,
        // A foreign payment is never the coordinator's to change, whatever the payload says.
        can_edit: !foreign && bool(o.can_edit), can_delete: !foreign && bool(o.can_delete),
        duplicate_of: foreign ? null : int(o.duplicate_of), reused: !foreign && bool(o.reused), reused_by: foreign ? null : int(o.reused_by),
    };
}

export function parseFeeView(raw: unknown): PortalFeeView | null {
    const o = obj(raw);
    if (!Array.isArray(o.people) || !Array.isArray(o.transfers)) return null;
    const loc = obj(o.location);
    const proof = obj(o.proof);
    const counts = obj(o.counts);
    return {
        location: int(loc.id) ? { id: int(loc.id) as number, name: typeof loc.name === "string" ? loc.name : "" } : null,
        methods: (Array.isArray(o.methods) ? o.methods : []).filter((m): m is string => typeof m === "string" && m !== ""),
        can_record: bool(o.can_record),
        proof: {
            required_for: (Array.isArray(proof.required_for) ? proof.required_for : ["Transferencia"]).filter((m): m is string => typeof m === "string"),
            max_chars: num(proof.max_chars) || 1400000,
        },
        max_people: int(o.max_people) ?? MAX_PARTS,
        people: o.people.map(parseBalance).filter((b): b is FeeBalance => !!b),
        counts: {
            pending: num(counts.pending), validated: num(counts.validated), returned: num(counts.returned),
            rejected: num(counts.rejected), total: num(counts.total),
        },
        transfers: o.transfers.map(parseTransfer).filter((t): t is PortalTransfer => !!t),
    };
}

/** `features.fee_payments` of /portal/me or /portal/login: the plugin has «Pagos de cuotas» (≥ 2.18.0). */
export const hasFeePayments = (loc: { features?: unknown } | null | undefined): boolean => {
    const f = obj(loc?.features);
    return !!Number(f.fee_payments);
};

/** The fee tab's badge from /portal/me `fees`: returned payments need the coordinator, pending ones wait. */
export const feeBadge = (fees: unknown): { text: string; tone: "orange" | "amber" } | null => {
    const f = obj(fees);
    const returned = Math.max(0, Math.floor(num(f.returned)));
    const pending = Math.max(0, Math.floor(num(f.pending)));
    if (returned > 0) return { text: returned === 1 ? "1 devuelto" : `${returned} devueltos`, tone: "orange" };
    if (pending > 0) return { text: `${pending} por validar`, tone: "amber" };
    return null;
};

// ── money of a person and of the location (cents) ──────────────────────────────────────────────────
export type BalanceC = { due: number; validated: number; pending: number; returned: number; toCover: number; credit: number; cancelled: boolean; payable: boolean };

/**
 * One person's money in cents from its components: a cancelled inscription owes nothing (D-P19);
 * `toCover` = what still has no payment registered, never negative; `credit` = validated over the fee.
 */
export function balanceC(input: { due: unknown; validated: unknown; pending: unknown; returned?: unknown; cancelled?: unknown }): BalanceC {
    const cancelled = bool(input.cancelled);
    const due = cancelled ? 0 : Math.max(0, toCents(input.due));
    const validated = Math.max(0, toCents(input.validated));
    const pending = Math.max(0, toCents(input.pending));
    const returned = Math.max(0, toCents(input.returned));
    const toCover = Math.max(0, due - validated - pending);
    return { due, validated, pending, returned, toCover, credit: Math.max(0, validated - due), cancelled, payable: !cancelled && toCover > 0 };
}

/** The money of a row of `/portal/inscriptions` (total_due, amount_paid, pending_amount, returned_amount, cancelled). */
export const rowBalanceC = (p: PortalPerson): BalanceC =>
    balanceC({ due: p.total_due, validated: p.amount_paid, pending: p.pending_amount, returned: p.returned_amount, cancelled: isCancelled(p) });

/** The view's balance of a person, recomputed from its components (never trusting a derived field). */
export const viewBalanceC = (b: FeeBalance): BalanceC =>
    balanceC({ due: b.due, validated: b.validated, pending: b.pending, returned: b.returned, cancelled: b.cancelled });

export type FeeSummaryC = {
    people: number;       // active (not cancelled) inscriptions
    cancelled: number;
    due: number;          // «Cuotas»: what the active inscriptions owe in total
    validated: number;    // «Validado»: validated money that covers fees (each person up to their fee)
    pending: number;      // «Por validar»: money awaiting the administration (each person up to what is left of their fee)
    returned: number;     // «Devuelto»: money in payments returned for correction
    toCover: number;      // «Por cobrar»: what still has no payment registered
    credit: number;       // «A favor»: validated money beyond a fee (a cancelled person's, a lowered fee)
    bar: { validated: number; pending: number; toCover: number };   // one stacked bar = due, exactly
};

/**
 * The location's «Resumen». It replaces the old StatCards, which counted cancelled people in «Saldo
 * Pendiente» and let an overpayment subtract from what others owe. Per person: validated money counts
 * toward the fee up to the fee, then pending money up to what is left; what is still to cover is never
 * negative; a cancelled person owes nothing. Validado + Por validar + Por cobrar = Cuotas, to the cent —
 * the same figures as the administration's «Resumen» (the plugin's server/fee-split.js summaryOf, and its
 * admin summarizeBalances: the same vectors run through all three). Validated money past a fee is «A favor»
 * only; pending money past it (a cancelled person's) counts in no figure.
 */
export function summarize(balances: readonly BalanceC[]): FeeSummaryC {
    const s: FeeSummaryC = { people: 0, cancelled: 0, due: 0, validated: 0, pending: 0, returned: 0, toCover: 0, credit: 0, bar: { validated: 0, pending: 0, toCover: 0 } };
    for (const b of balances) {
        if (b.cancelled) s.cancelled++; else s.people++;
        const v = Math.min(b.validated, b.due);
        const p = Math.min(b.pending, b.due - v);
        s.due += b.due;
        s.validated += v;
        s.pending += p;
        s.returned += b.returned;
        s.toCover += b.toCover;
        s.credit += b.credit;
        s.bar.validated += v;
        s.bar.pending += p;
        s.bar.toCover += b.due - v - p;
    }
    return s;
}

/** Bar segment widths in percent (2 decimals), summing to 100 when there is anything owed. */
export const barPercents = (bar: FeeSummaryC["bar"]): { validated: number; pending: number; toCover: number } => {
    const total = bar.validated + bar.pending + bar.toCover;
    if (total <= 0) return { validated: 0, pending: 0, toCover: 0 };
    const pct = (c: number) => Math.round((c / total) * 10000) / 100;
    const validated = pct(bar.validated), pending = pct(bar.pending);
    return { validated, pending, toCover: Math.max(0, Math.round((100 - validated - pending) * 100) / 100) };
};

/**
 * The «Saldos» chips. «Con saldo» (the default) = still has something to cover. The labels and rules are
 * the admin's «Saldos» ones (plugin client/lib/feePayments.ts BALANCE_FILTERS): «Pagados» = a fee that the
 * validated money covers (someone without a fee is neither owing nor paid).
 */
export const BALANCE_FILTERS = ["owing", "pending", "returned", "settled", "all"] as const;
export type BalanceFilter = typeof BALANCE_FILTERS[number];
export const BALANCE_FILTER_LABEL: Record<BalanceFilter, string> = { owing: "Con saldo", pending: "Por validar", returned: "Devuelto", settled: "Pagados", all: "Todos" };
export const matchesBalanceFilter = (b: BalanceC, f: BalanceFilter): boolean => {
    switch (f) {
        case "owing": return !b.cancelled && b.toCover > 0;
        case "pending": return b.pending > 0;
        case "returned": return b.returned > 0;
        case "settled": return !b.cancelled && b.due > 0 && b.validated >= b.due;
        default: return true;
    }
};

/** `$1.250,00` from cents. */
export const money = (c: number): string => `$${fmtMoney(fromCents(c))}`;

/**
 * Patch the Participantes rows from a fresh view (the write answered with it): validated, pending and
 * returned money and the payment state, without another `/portal/inscriptions` request. Rows the view
 * does not name are kept as they are.
 */
export function mergeBalances<T extends PortalPerson>(rows: readonly T[], people: readonly FeeBalance[]): T[] {
    const byId = new Map(people.map((b) => [b.id, b]));
    return rows.map((r) => {
        const b = byId.get(Number(r.id));
        if (!b) return r;
        const due = Math.max(0, toCents(r.total_due));
        const paid = Math.max(0, toCents(b.validated));
        const payment_status = due <= 0 || paid >= due ? "paid" : paid > 0 ? "partial" : "unpaid";
        return { ...r, amount_paid: fromCents(paid), pending_amount: fromCents(Math.max(0, toCents(b.pending))), returned_amount: fromCents(Math.max(0, toCents(b.returned))), payment_status };
    });
}

// ── status and labels ────────────────────────────────────────────────────────────────────────────
export type StatusTone = "amber" | "emerald" | "orange" | "rose";
export const STATUS_META: Record<FeeStatus, { label: string; tone: StatusTone; icon: string }> = {
    pending: { label: "Por validar", tone: "amber", icon: "fa-clock" },
    validated: { label: "Validado", tone: "emerald", icon: "fa-circle-check" },
    returned: { label: "Devuelto", tone: "orange", icon: "fa-rotate-left" },
    rejected: { label: "Rechazado", tone: "rose", icon: "fa-circle-xmark" },
};

/** «Ana P.» from «Ana Pérez Gómez»; a one-word name stays as it is. */
export const shortName = (full: string): string => {
    const words = String(full || "").trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) return words[0] || "";
    return `${words[0]} ${words[1].charAt(0).toUpperCase()}.`;
};

/** «Ana P., Luis P. +1»: the first two people of a payment, then how many more. */
export const peopleLabel = (ids: readonly number[], nameOf: (id: number) => string, shown = 2): string => {
    const names = ids.slice(0, shown).map((id) => shortName(nameOf(id)) || `#${id}`);
    const more = ids.length - names.length;
    return names.join(", ") + (more > 0 ? ` +${more}` : "");
};

/** DD/MM/YYYY from 'YYYY-MM-DD' — a DATE (the payment date the coordinator typed); '' when there is none. */
export const dayLabel = (v: string | null | undefined): string => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ""));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
};

/**
 * DD/MM/YYYY of a server TIMESTAMP (reviewed_at, registration_date) in the browser's time zone — the day the
 * coordinator lived it, as the administration's screens show it. SQLite / MySQL stamps ('YYYY-MM-DD HH:MM:SS',
 * CURRENT_TIMESTAMP) are UTC: dayLabel read their date part, so a payment returned at 19:05 in Bogotá (00:05 UTC
 * the next day) said «Revisado 09/10/2026» beside «Fecha del pago 08/10/2026» (2.18.0 live round 4). An ISO
 * string with a zone is read as such; a plain 'YYYY-MM-DD' stays that day.
 */
export const stampDayLabel = (v: string | null | undefined): string => {
    const s = String(v || "").trim();
    if (!s || /^\d{4}-\d{2}-\d{2}$/.test(s)) return dayLabel(s);
    const sql = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/.exec(s);
    const d = new Date(sql ? `${sql[1]}T${sql[2]}Z` : s);
    if (Number.isNaN(d.getTime())) return dayLabel(s);
    const two = (n: number) => String(n).padStart(2, "0");
    return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`;
};

/** «Requiere tu atención» (own returned payments) first, then everything else newest first. */
export function orderTransfers(list: readonly PortalTransfer[]): { attention: PortalTransfer[]; rest: PortalTransfer[] } {
    const attention = list.filter((t) => !t.foreign && t.status === "returned").sort((a, b) => b.id - a.id);
    const rest = list.filter((t) => !(!t.foreign && t.status === "returned")).sort((a, b) => b.id - a.id);
    return { attention, rest };
}

/** The payments that include a person (the «Ver sus pagos» filter). */
export const transfersOf = (list: readonly PortalTransfer[], inscriptionId: number): PortalTransfer[] =>
    list.filter((t) => t.allocations.some((a) => a.inscription_id === inscriptionId));

/** What a payment row says about who recorded it (the portal never shows an admin's login). */
export const recorderLabel = (t: PortalTransfer): string =>
    t.foreign ? (t.recorded_via === "legacy" ? "Registrado antes de «Pagos de cuotas»" : t.recorded_via === "portal" ? "Registrado desde otra localidad" : "Registrado por la administración") : "Registrado por ti";

// ── the «Registrar pago» draft ───────────────────────────────────────────────────────────────────
export type SplitMode = "equal" | "manual";
export type DraftKind = "new" | "edit" | "duplicate";

export type FeeDraft = {
    kind: DraftKind;
    /** The idempotency key of this draft: a retry after a network failure sends the same one. */
    clientKey: string;
    /** edit: the payment being corrected and the state the coordinator saw (compare-and-set on the server). */
    editId: number | null;
    expected: { status: FeeStatus; alloc_gen: number } | null;
    /** edit: the part each person has in THIS payment, and whether that money is pending (counts in to_cover). */
    ownParts: Record<number, number>;
    ownPending: boolean;
    /** duplicate: the rejected payment whose receipt the server copies («Duplicar»). */
    copyFrom: number | null;
    /**
     * duplicate: the rejected payment this one records again — with or without its receipt (a cash payment
     * without a photo too): the server keeps one receipt counting in ONE payment (`duplicate_of`).
     */
    duplicateOf?: number | null;
    ids: number[];
    total: string;
    /** False while the total follows the people (the sum of what they still owe). */
    totalTouched: boolean;
    mode: SplitMode;
    manual: Record<number, string>;
    method: string;
    paidOn: string;
    reference: string;
    note: string;
    /** The new receipt (an image data URL), or null. */
    proof: string | null;
    /** edit / duplicate: the payment already has a receipt that is kept unless replaced or removed. */
    hasStoredProof: boolean;
    removeStoredProof: boolean;
    allowDuplicateReference: boolean;
    /** edit of a RETURNED payment: what the administration asked to correct (shown while correcting it). */
    returnNote: string | null;
    /** A photo is being shrunk on the phone: «Enviar» waits (sending now would send the old receipt, or none). */
    proofWorking: boolean;
    /** The «Manual» amounts were typed (or are the payment's own split): «Iguales» → «Manual» gives them back (manualOnSwitch). */
    manualTyped?: boolean;
    /**
     * A kept draft reopened for OTHER people (reopenDraft): its receipt, reference, date and note came along
     * from a payment that was never sent — the sheet says so and offers «Empezar de cero» (carriedNotice).
     */
    carried?: boolean;
    /** A correction («Editar», «Corregir y reenviar», «Registrar de nuevo») closed unsent and reopened as it was left. */
    recovered?: boolean;
};

const pad = (n: number) => String(n).padStart(2, "0");
/** Today on this device, 'YYYY-MM-DD' (the server accepts up to tomorrow, for time zones). */
export const todayLocal = (d = new Date()): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A fresh idempotency key ([A-Za-z0-9_-], 8–64 chars): randomUUID where it exists (not on iOS < 15.4). */
export function newClientKey(): string {
    try {
        const c = (globalThis as { crypto?: Crypto }).crypto;
        if (c && typeof c.randomUUID === "function") return c.randomUUID();
        if (c && typeof c.getRandomValues === "function") {
            const b = new Uint8Array(16);
            c.getRandomValues(b);
            return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
        }
    } catch { /* fall through */ }
    return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** The method a new draft starts with: the last one used here if still enabled, else the first enabled. */
export const LAST_METHOD_KEY = "wjs-portal:lastMethod";
export function initialMethod(methods: readonly string[], last: string | null): string {
    if (last && methods.includes(last)) return last;
    return methods[0] || "";
}

export function newDraft(ids: readonly number[], methods: readonly string[], lastMethod: string | null): FeeDraft {
    return {
        kind: "new", clientKey: newClientKey(), editId: null, expected: null, ownParts: {}, ownPending: false, copyFrom: null, duplicateOf: null,
        ids: [...new Set(ids)], total: "", totalTouched: false, mode: "equal", manual: {},
        method: initialMethod(methods, lastMethod), paidOn: todayLocal(), reference: "", note: "",
        proof: null, hasStoredProof: false, removeStoredProof: false, allowDuplicateReference: false, returnNote: null, proofWorking: false,
    };
}

/**
 * Reopening «Registrar pago» with a kept new draft (closed without sending: it may hold the receipt photo,
 * the reference, the method, the date). The same people (or none asked) → the draft as it was. Other people
 * → the same receipt and details for the NEW people: their manual amounts start again for the ones added,
 * the ones gone are dropped, the total follows what they owe unless one was typed, and the idempotency key
 * is new (it is another payment now) — marked `carried`, so the sheet SAYS that the receipt and details of
 * the unsent payment came along and offers «Empezar de cero». A confirmed repeated reference
 * (`allowDuplicateReference`) never survives a reopen: it was a decision about one send. Nothing kept → a
 * fresh draft.
 */
export function reopenDraft(kept: FeeDraft | null, want: readonly number[], methods: readonly string[], lastMethod: string | null, balances: ReadonlyMap<number, BalanceC>): FeeDraft {
    const ids = [...new Set(want)];
    if (!kept || kept.kind !== "new") return followTotal(newDraft(ids, methods, lastMethod), balances);
    const same = kept.ids.length === ids.length && kept.ids.every((id) => ids.includes(id));
    if (!ids.length || same) return kept.allowDuplicateReference ? { ...kept, allowDuplicateReference: false } : kept;
    const manual: Record<number, string> = {};
    for (const id of ids) if (kept.manual[id] !== undefined) manual[id] = kept.manual[id];
    const next: FeeDraft = {
        ...kept, ids, manual, clientKey: newClientKey(), allowDuplicateReference: false,
        method: methods.includes(kept.method) ? kept.method : initialMethod(methods, lastMethod),
    };
    return followTotal({ ...next, carried: carriedItems(next).length > 0 }, balances);
}

/** What a carried draft still holds from the unsent payment: «el comprobante», «la referencia», «la fecha», «la nota». */
export function carriedItems(d: Pick<FeeDraft, "proof" | "reference" | "paidOn" | "note">, today: string = todayLocal()): string[] {
    const out: string[] = [];
    if (d.proof) out.push("el comprobante");
    if (d.reference.trim()) out.push("la referencia");
    if (d.paidOn && d.paidOn !== today) out.push("la fecha");
    if (d.note.trim()) out.push("la nota");
    return out;
}
/** The notice of a carried draft (null: nothing came along, or the coordinator already cleared it). */
export function carriedNotice(d: FeeDraft, today?: string): string | null {
    if (!d.carried) return null;
    const items = carriedItems(d, today);
    if (!items.length) return null;
    const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
    return `Se conservaron ${list} del pago que no enviaste. Revísalos: este pago es para otras personas.`;
}
/** «Empezar de cero»: a fresh draft for the same people (method kept — it is not about the other payment). */
export const startOver = (d: FeeDraft, ctx: Pick<DraftContext, "methods" | "balances">): FeeDraft =>
    followTotal(newDraft(d.ids, ctx.methods, d.method), ctx.balances);

/**
 * «Registrar pago» asked for `ids`: does the view in hand know them all? A participant registered after the
 * view was loaded is not in it (no polling: the page never re-reads it by itself) — load once more first.
 */
export const registerNeedsLoad = (v: Pick<PortalFeeView, "people"> | null, ids: readonly number[]): boolean =>
    !v || ids.some((id) => !v.people.some((p) => p.id === id));
/**
 * Who of `ids` can be paid now, and — when some asked for cannot — why, in words (instead of a sheet that
 * opens empty or with somebody else's unsent draft).
 */
export function registerTargets(balances: ReadonlyMap<number, BalanceC>, ids: readonly number[]): { want: number[]; notice: string | null } {
    const asked = [...new Set(ids)];
    const want = asked.filter((id) => balances.get(id)?.payable);
    const skipped = asked.filter((id) => !want.includes(id));
    if (!skipped.length) return { want, notice: null };
    if (asked.length === 1) {
        const b = balances.get(asked[0]);
        const notice = !b ? "Esa persona aún no aparece en los pagos de tu localidad. Vuelve a abrir «Pagos de cuotas» e inténtalo de nuevo."
            : b.cancelled ? "Esa inscripción está cancelada: no debe nada."
            : "Esa persona no tiene nada por registrar: lo que debe ya está pagado o por validar.";
        return { want, notice };
    }
    return { want, notice: skipped.length === 1 ? "Una de las personas elegidas no tiene nada por registrar." : `${skipped.length} de las personas elegidas no tienen nada por registrar.` };
}

/** A message of the payment hub shown INSIDE the open sheet: its text, its tone, and a counter (a new one re-announces). */
export type HubNotice = { text: string; tone: "emerald" | "amber" | "rose" | "blue"; n: number };
/**
 * Where a message of the payment hub goes (2.18.0 review round 4): into the sheet that is open — a payment sheet,
 * or the participant's sheet under it — else a toast. A toast sits at the bottom of the screen, over an open
 * sheet's footer («Enviar pago», «Eliminar») for its seconds on screen, and the sheet itself never said it.
 */
export function noticeTarget(o: { sheetOpen: boolean }): "sheet" | "toast" {
    return o.sheetOpen ? "sheet" : "toast";
}

/** True when the parts are exactly the «Iguales» split of the total (so an edit opens in that mode). */
const isEqualSplit = (totalC: number, partsC: readonly number[]): boolean => {
    const eq = splitEqual(totalC, partsC.length);
    return eq.every((c, i) => c === partsC[i]);
};

/**
 * Correct (`edit`) an own pending / returned payment, or start a new one from a rejected payment
 * (`duplicate`, «Duplicar»: same people, amounts, method, date and reference — it is the same receipt, which
 * the server copies — exactly like the admin's «Duplicar»).
 */
export function draftFromTransfer(t: PortalTransfer, kind: "edit" | "duplicate", methods: readonly string[]): FeeDraft {
    const ids = t.allocations.map((a) => a.inscription_id);
    const partsC = t.allocations.map((a) => toCents(a.amount));
    const totalC = toCents(t.amount);
    const manual = Object.fromEntries(t.allocations.map((a) => [a.inscription_id, centsToInput(toCents(a.amount))]));
    return {
        kind, clientKey: newClientKey(),
        editId: kind === "edit" ? t.id : null,
        expected: kind === "edit" ? { status: t.status, alloc_gen: t.alloc_gen } : null,
        ownParts: kind === "edit" ? Object.fromEntries(t.allocations.map((a) => [a.inscription_id, toCents(a.amount)])) : {},
        ownPending: kind === "edit" && t.status === "pending",
        copyFrom: kind === "duplicate" && t.has_proof ? t.id : null,
        duplicateOf: kind === "duplicate" ? t.id : null,
        ids, total: centsToInput(totalC), totalTouched: true,
        mode: isEqualSplit(totalC, partsC) ? "equal" : "manual", manual, manualTyped: !isEqualSplit(totalC, partsC),
        method: methods.includes(t.method) ? t.method : (methods[0] || ""),
        paidOn: t.paid_on ? t.paid_on.slice(0, 10) : todayLocal(),
        reference: t.reference || "",
        note: t.note || "",
        proof: null, hasStoredProof: t.has_proof, removeStoredProof: false, allowDuplicateReference: false,
        returnNote: kind === "edit" && t.status === "returned" ? t.review_note : null,
        proofWorking: false,
    };
}

/**
 * Corrections closed without sending are KEPT, like a new payment's draft (UX: Escape, ✕ or «Cancelar» on
 * «Corregir y reenviar» threw away a new photo and a changed split). One per payment and kind
 * (`edit:<id>` / `duplicate:<id>`), only when something was changed, in memory only (it may hold a photo).
 */
export const correctionKey = (d: Pick<FeeDraft, "kind" | "editId" | "duplicateOf" | "copyFrom">): string | null =>
    d.kind === "edit" && d.editId != null ? `edit:${d.editId}` : d.kind === "duplicate" && (d.duplicateOf ?? d.copyFrom) != null ? `duplicate:${d.duplicateOf ?? d.copyFrom}` : null;
/** Has the coordinator changed anything since `start` (people, amounts, split, method, date, reference, note, receipt)? */
export function draftChanged(start: FeeDraft | null, now: FeeDraft): boolean {
    if (!start) return true;
    const ids = (d: FeeDraft) => [...d.ids].sort((a, b) => a - b).join(",");
    const cents = (v: string) => { const c = parseMoneyInput(v); return c === null ? v.trim() : String(c); };
    if (ids(start) !== ids(now) || cents(start.total) !== cents(now.total) || start.mode !== now.mode) return true;
    if (start.method !== now.method || start.paidOn !== now.paidOn || start.reference.trim() !== now.reference.trim() || start.note.trim() !== now.note.trim()) return true;
    if (start.proof !== now.proof || start.removeStoredProof !== now.removeStoredProof) return true;
    if (now.mode === "manual") for (const id of now.ids) if (cents(start.manual[id] ?? "") !== cents(now.manual[id] ?? "")) return true;
    return false;
}
/** Closing a correction: keep it under its key when it was changed (and drop an older one otherwise). */
export function keepCorrection(kept: Map<string, FeeDraft>, start: FeeDraft | null, d: FeeDraft | null): void {
    if (!d || d.kind === "new") return;
    const key = correctionKey(d);
    if (!key) return;
    if (draftChanged(start, d)) kept.set(key, { ...d, allowDuplicateReference: false, proofWorking: false });
    else kept.delete(key);
}
/**
 * Reopening a correction: the kept one when it still corrects the payment AS IT IS (same status and split
 * generation for an edit — the server would refuse a stale one anyway), marked `recovered`; else `fresh`.
 */
export function recoverCorrection(kept: Map<string, FeeDraft>, fresh: FeeDraft): FeeDraft {
    const key = correctionKey(fresh);
    const k = key ? kept.get(key) : undefined;
    if (!key || !k) return fresh;
    kept.delete(key);
    if (fresh.kind === "edit" && (k.expected?.status !== fresh.expected?.status || k.expected?.alloc_gen !== fresh.expected?.alloc_gen)) return fresh;
    return { ...k, recovered: true };
}

export type DraftContext = {
    /** The people of the location, by id (from the view). */
    balances: ReadonlyMap<number, BalanceC>;
    methods: readonly string[];
    /** The methods whose receipt is required (the view's `proof.required_for`). */
    proofRequiredFor: readonly string[];
    maxPeople?: number;
    /** «Now» for the date rule (tests); the device's clock otherwise. */
    today?: Date;
};

/**
 * The latest payment date the server accepts: tomorrow on this device (one day of slack for time zones,
 * the server's own rule — and the admin's). A later one is refused as `future_date`.
 */
export const maxPaidOn = (now: Date = new Date()): string => todayLocal(new Date(now.getTime() + 24 * 60 * 60 * 1000));

/**
 * The most a part may carry for one person — the server's own rule (assertCaps 'record', and the admin's
 * editCap): due − validated − pending of their OTHER payments. Correcting a pending payment leaves its own part
 * out of «pending». Not `toCover + own part`: toCover is clamped at 0, so when someone's validated + pending
 * already passes the fee (a returned payment validated meanwhile) that sum offered an amount the server refuses.
 */
export const capOf = (draft: Pick<FeeDraft, "ownParts" | "ownPending">, b: BalanceC | undefined, id: number): number =>
    b ? Math.max(0, b.due - b.validated - (b.pending - (draft.ownPending ? (draft.ownParts[id] || 0) : 0))) : 0;

/** The total the sheet suggests: what the chosen people still owe, together. */
export const suggestedTotal = (draft: Pick<FeeDraft, "ids" | "ownParts" | "ownPending">, balances: ReadonlyMap<number, BalanceC>): number =>
    draft.ids.reduce((s, id) => s + capOf(draft, balances.get(id), id), 0);

/** While the coordinator has not typed a total (`totalTouched`), it follows the people: what they owe together. */
export const followTotal = (d: FeeDraft, balances: ReadonlyMap<number, BalanceC>): FeeDraft =>
    (d.totalTouched ? d : { ...d, total: d.ids.length ? centsToInput(suggestedTotal(d, balances)) : "" });

/** The «Manual» amounts a switch to Manual starts from: each one's cap when the total is exactly what they owe, else the equal split. */
export function manualSeed(draft: FeeDraft, ctx: DraftContext): Record<number, string> {
    const totalC = parseMoneyInput(draft.total) ?? 0;
    const caps = draft.ids.map((id) => capOf(draft, ctx.balances.get(id), id));
    const byCap = caps.reduce((s, c) => s + c, 0) === totalC && caps.every((c) => c > 0);
    const parts = byCap ? caps : splitEqual(totalC, draft.ids.length);
    return Object.fromEntries(draft.ids.map((id, i) => [id, centsToInput(parts[i] || 0)]));
}

/**
 * The «Manual» amounts a switch BACK to «Manual» shows (the «Cómo repartir» strip): the ones typed, when the
 * coordinator typed them — the strip's arrow keys go Manual → Iguales → Manual in two keystrokes, and the typed split
 * was silently replaced by a new seed (2.18.0 review UX6-6); a person added meanwhile starts from the seed.
 * Without typed amounts, manualSeed. «Repartir según lo que debe cada uno» always seeds (manualSeed).
 */
export function manualOnSwitch(draft: FeeDraft, ctx: DraftContext): Record<number, string> {
    const seed = manualSeed(draft, ctx);
    if (!draft.manualTyped) return seed;
    return Object.fromEntries(draft.ids.map((id) => [id, draft.manual[id] !== undefined ? draft.manual[id] : seed[id]]));
}

/** `otherPending`: the person's money awaiting validation in OTHER payments (cents; an edited payment's own part left out). */
export type PersonCheck = { id: number; cents: number | null; cap: number; over: boolean; cancelled: boolean; unknown: boolean; afterOwed: number; otherPending: number };

export type DraftCheck = {
    totalC: number | null;
    parts: PersonCheck[];
    split: SplitState;
    proofRequired: boolean;
    /** Every reason the sheet cannot be sent yet, in the order the coordinator would fix them (Spanish). */
    problems: string[];
    canSubmit: boolean;
};

/** Everything the sheet shows live and whether «Enviar pago» is enabled. Pure; amounts in cents. */
export function checkDraft(draft: FeeDraft, ctx: DraftContext): DraftCheck {
    const totalC = parseMoneyInput(draft.total);
    const n = draft.ids.length;
    const partsC: (number | null)[] = draft.mode === "equal"
        ? splitEqual(totalC ?? 0, n)
        : draft.ids.map((id) => parseMoneyInput(draft.manual[id] ?? ""));
    const parts: PersonCheck[] = draft.ids.map((id, i) => {
        const b = ctx.balances.get(id);
        const cap = capOf(draft, b, id);
        const c = partsC[i];
        const ownPend = draft.ownPending ? (draft.ownParts[id] || 0) : 0;
        const owedBefore = b ? Math.max(0, b.due - b.validated - (b.pending - ownPend)) : 0;
        const otherPending = b ? Math.max(0, b.pending - ownPend) : 0;
        return { id, cents: c, cap, over: c !== null && c > cap, cancelled: !!b?.cancelled, unknown: !b, afterOwed: Math.max(0, owedBefore - (c ?? 0)), otherPending };
    });
    const split = splitState(totalC ?? 0, partsC);
    const proofRequired = ctx.proofRequiredFor.includes(draft.method);
    // The receipt already on the server: an edited payment's own, or a rejected payment's that «Duplicar» copies.
    const hasProof = !!draft.proof || (draft.hasStoredProof && !draft.removeStoredProof);
    const problems: string[] = [];
    if (!n) problems.push("Elige al menos una persona.");
    if (n > (ctx.maxPeople ?? MAX_PARTS)) problems.push(`Máximo ${ctx.maxPeople ?? MAX_PARTS} personas por pago.`);
    if (parts.some((p) => p.unknown)) problems.push("Alguna persona ya no está en tu localidad.");
    if (parts.some((p) => p.cancelled)) problems.push("Una inscripción cancelada no puede recibir pagos.");
    if (totalC === null || totalC <= 0) problems.push("Escribe el monto del pago.");
    if (!ctx.methods.length) problems.push("La administración no ha habilitado formas de pago para esta localidad.");
    else if (!ctx.methods.includes(draft.method)) problems.push("Elige la forma de pago.");
    if (n && totalC && totalC > 0) {
        const v = validateAllocations(draft.ids.map((id, i) => ({ inscription_id: id, cents: partsC[i] })), totalC, ctx.maxPeople ?? MAX_PARTS);
        if (!v.ok && v.code === "non_positive") problems.push(draft.mode === "equal" ? "El monto no alcanza para repartirlo entre todos." : "Cada parte del reparto debe ser mayor que cero.");
        else if (!v.ok && v.code === "sum_mismatch") problems.push(split.diff > 0 ? `Faltan ${money(split.diff)} por repartir.` : `Sobran ${money(-split.diff)} en el reparto.`);
    }
    const over = parts.filter((p) => p.over);
    if (over.length) {
        const what = over.length === 1 ? "Una parte supera lo que falta por pagar" : `${over.length} partes superan lo que falta por pagar`;
        // «Iguales» with people who owe different amounts: «Manual» starts from what each one owes.
        problems.push(draft.mode === "equal" && draft.ids.length > 1 ? `${what}: cambia a «Manual» para repartir según lo que debe cada uno.` : `${what}.`);
    }
    if (draft.proofWorking) problems.push("Espera: la foto del comprobante se está preparando.");
    else if (proofRequired && !hasProof) problems.push("Adjunta el comprobante de la transferencia.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.paidOn)) problems.push("Indica la fecha del pago.");
    else if (draft.paidOn > maxPaidOn(ctx.today)) problems.push("La fecha del pago no puede ser futura.");
    return { totalC, parts, split, proofRequired, problems, canSubmit: problems.length === 0 };
}

/** The first problem is a part over what someone owes in «Iguales»: one tap on «Manual» seeds what each one owes. */
export const overCapInEqual = (draft: Pick<FeeDraft, "mode" | "ids">, check: Pick<DraftCheck, "parts">): boolean =>
    draft.mode === "equal" && draft.ids.length > 1 && check.parts.some((p) => p.over);

export type FeeBody = {
    amount: number;
    method: string;
    paid_on: string;
    reference: string | null;
    note: string | null;
    allocations: { inscription_id: number; amount: number }[];
    client_key?: string;
    proof?: string | null;
    copy_proof_from?: number;
    duplicate_of?: number;
    allow_duplicate_reference?: boolean;
    expected?: { status: FeeStatus; alloc_gen: number };
};

/** The POST / PUT body of a draft that passed checkDraft. Amounts go back to 2-decimal numbers. */
export function draftBody(draft: FeeDraft, check: DraftCheck): FeeBody {
    const body: FeeBody = {
        amount: fromCents(check.totalC ?? 0),
        method: draft.method,
        paid_on: draft.paidOn,
        reference: draft.reference.trim() || null,
        note: draft.note.trim() || null,
        allocations: check.parts.map((p) => ({ inscription_id: p.id, amount: fromCents(p.cents ?? 0) })),
    };
    if (draft.kind === "edit") body.expected = draft.expected ?? undefined;
    else body.client_key = draft.clientKey;
    if (draft.proof) body.proof = draft.proof;
    else if (draft.kind === "edit" && draft.hasStoredProof && draft.removeStoredProof) body.proof = null;
    else if (draft.kind === "duplicate" && draft.copyFrom != null && !draft.removeStoredProof) body.copy_proof_from = draft.copyFrom;
    if (draft.kind === "duplicate" && draft.duplicateOf != null) body.duplicate_of = draft.duplicateOf;
    if (draft.allowDuplicateReference) body.allow_duplicate_reference = true;
    return body;
}

// ── the server's answers ─────────────────────────────────────────────────────────────────────────
export class FeeApiError extends Error {
    status: number;
    code: string | null;
    body: Record<string, unknown>;
    constructor(status: number, body: Record<string, unknown>, fallback: string) {
        super(typeof body.error === "string" && body.error ? body.error : fallback);
        this.status = status;
        this.code = typeof body.code === "string" ? body.code : null;
        this.body = body;
    }
}

/** What the sheet does with a refused write. */
export type FeeErrorAction =
    | { kind: "unauthorized" }
    | { kind: "network"; message: string }
    | { kind: "over_cap"; message: string; people: { id: number; max: number }[] }
    | { kind: "duplicate_reference"; message: string; otherId: number | null }
    | { kind: "stale"; message: string }
    | { kind: "people"; message: string; ids: number[] }
    /** The draft's key already recorded a payment with OTHER data (a send whose answer was lost, then corrected): it exists — reload. */
    | { kind: "recorded"; message: string; id: number | null }
    | { kind: "message"; message: string };

export function feeErrorAction(e: unknown): FeeErrorAction {
    if (!(e instanceof FeeApiError)) return { kind: "network", message: "No hay conexión. Revisa tu internet y vuelve a intentarlo." };
    if (e.status === 0) return { kind: "network", message: e.message };
    if (e.status === 401) return { kind: "unauthorized" };
    const b = e.body;
    if (e.code === "over_cap") {
        const people = (Array.isArray(b.people) ? b.people : []).flatMap((x) => {
            const o = obj(x);
            const id = int(o.inscription_id);
            return id ? [{ id, max: toCents(o.max) }] : [];
        });
        return { kind: "over_cap", message: e.message, people };
    }
    if (e.code === "duplicate_reference") return { kind: "duplicate_reference", message: e.message, otherId: int(obj(b.other).id) };
    // 2.18.0 review R6-M2: the first send DID record a payment (with the data of then): never «sent», never a blind resend.
    if (e.code === "client_key_changed") return { kind: "recorded", message: e.message, id: int(b.id) };
    // The voided payment was already recorded again (or counts again): what is on screen is out of date.
    if (e.code === "stale" || e.code === "invalid_transition" || e.code === "source_used" || e.code === "proof_source_live" || e.status === 404) return { kind: "stale", message: e.status === 404 ? "Ese pago ya no existe." : e.message };
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(int).filter((x): x is number => !!x);
    if (ids.length) return { kind: "people", message: e.message, ids };
    return { kind: "message", message: e.message };
}

/** What sending a draft came to, for the sheet to show (the hub applies it; tests drive it directly). */
export type SendOutcome =
    | { kind: "sent"; id: number; view: PortalFeeView; toast: string }
    | { kind: "invalid"; problems: string[] }
    | { kind: "unauthorized" }
    /** Network failure: the draft (and its idempotency key) stays; sending again cannot record it twice. */
    | { kind: "retry"; message: string }
    /** Refused: fix the sheet. `people` = messages per person; `reload` = the caps on screen were stale. */
    | { kind: "fix"; message: string | null; people: Record<number, string>; reload: boolean }
    | { kind: "confirm_reference"; message: string; otherId: number | null }
    /** Someone changed or removed the payment meanwhile: close and reload. */
    | { kind: "stale"; message: string };

/** Send a draft (create, or PUT for an edit) and classify the answer. Never throws. */
export async function sendDraft(api: Pick<PortalFeeApi, "create" | "update">, draft: FeeDraft, ctx: DraftContext): Promise<SendOutcome> {
    const check = checkDraft(draft, ctx);
    if (!check.canSubmit) return { kind: "invalid", problems: check.problems };
    const body = draftBody(draft, check);
    try {
        if (draft.kind === "edit" && draft.editId != null) {
            const r = await api.update(draft.editId, body);
            const resent = draft.expected?.status === "returned";
            return { kind: "sent", id: r.id, view: r.view, toast: resent ? "Pago corregido y reenviado: queda por validar." : "Cambios guardados: el pago sigue por validar." };
        }
        const r = await api.create(body);
        return { kind: "sent", id: r.id, view: r.view, toast: r.replayed ? "Ese pago ya estaba registrado." : `Pago enviado (${money(check.totalC ?? 0)}): queda por validar.` };
    } catch (e) {
        const a = feeErrorAction(e);
        switch (a.kind) {
            case "unauthorized": return { kind: "unauthorized" };
            case "network": return { kind: "retry", message: `${a.message} Tus datos siguen aquí: vuelve a tocar «Enviar».` };
            case "over_cap": {
                const people: Record<number, string> = {};
                for (const p of a.people) people[p.id] = `Supera lo que falta: máximo ${money(p.max)}.`;
                return { kind: "fix", message: "Alguien ya tiene pagos registrados que no veías: revisa los montos.", people, reload: true };
            }
            case "duplicate_reference": return { kind: "confirm_reference", message: a.message, otherId: a.otherId };
            case "stale": return { kind: "stale", message: `${a.message} Se recargaron los pagos.` };
            case "people": return { kind: "fix", message: a.message, people: Object.fromEntries(a.ids.map((id) => [id, a.message])), reload: true };
            // The payment the first send recorded shows in «Pagos» once the view is loaded again.
            case "recorded": return { kind: "fix", message: a.message, people: {}, reload: true };
            default: return { kind: "fix", message: a.message, people: {}, reload: false };
        }
    }
}

// ── the API client ───────────────────────────────────────────────────────────────────────────────
type HeaderMap = Record<string, string>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type PortalFeeApi = {
    load(): Promise<PortalFeeView>;
    proof(id: number): Promise<string>;
    create(body: FeeBody): Promise<{ id: number; replayed: boolean; view: PortalFeeView }>;
    update(id: number, body: FeeBody): Promise<{ id: number; view: PortalFeeView }>;
    remove(id: number, expected: { status: FeeStatus; alloc_gen: number }): Promise<{ view: PortalFeeView }>;
};

/** `authHeaders` = the page's portalAuthHeaders (CSRF + x-portal-token; the cookie is the primary path). */
export function createPortalFeeApi(authHeaders: (extra?: HeaderMap) => HeaderMap, fetchImpl?: FetchLike): PortalFeeApi {
    const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init));
    const call = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
        let res;
        try {
            res = await doFetch(`${API}${path}`, {
                method, credentials: "include",
                headers: authHeaders(body === undefined ? {} : { "Content-Type": "application/json" }),
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        } catch {
            throw new FeeApiError(0, {}, "No hay conexión. Revisa tu internet y vuelve a intentarlo.");
        }
        const data = obj(await res.json().catch(() => ({})));
        if (!res.ok) throw new FeeApiError(res.status, data, "No se pudo completar la operación.");
        return data;
    };
    const view = (raw: unknown): PortalFeeView => {
        const v = parseFeeView(raw);
        if (!v) throw new FeeApiError(500, {}, "Respuesta inesperada del servidor.");
        return v;
    };
    return {
        async load() { return view(await call("GET", "/portal/fee-payments")); },
        async proof(id) {
            const d = await call("GET", `/portal/fee-payments/${id}/proof`);
            if (typeof d.proof !== "string" || !d.proof) throw new FeeApiError(404, { error: "Este pago no tiene comprobante." }, "Este pago no tiene comprobante.");
            return d.proof;
        },
        async create(body) {
            const d = await call("POST", "/portal/fee-payments", body);
            return { id: int(d.id) ?? 0, replayed: bool(d.replayed), view: view(d.view) };
        },
        async update(id, body) {
            const d = await call("PUT", `/portal/fee-payments/${id}`, body);
            return { id: int(d.id) ?? id, view: view(d.view) };
        },
        async remove(id, expected) {
            const d = await call("DELETE", `/portal/fee-payments/${id}`, { expected });
            return { view: view(d.view) };
        },
    };
}

/**
 * The tab's ONE load: a second call while the first is in flight (React mounting twice in StrictMode, a
 * double tap on «Reintentar») gets the same promise instead of a second request. `reset()` forgets the one in
 * flight (a sign-out): the next load is a new request, never the previous coordinator's answer.
 */
export function createViewLoader(api: Pick<PortalFeeApi, "load">) {
    let inflight: Promise<PortalFeeView> | null = null;
    return {
        load(): Promise<PortalFeeView> {
            if (!inflight) {
                const p: Promise<PortalFeeView> = api.load().finally(() => { if (inflight === p) inflight = null; });
                inflight = p;
            }
            return inflight;
        },
        reset() { inflight = null; },
    };
}

/** What a load came to (the hub applies it; tests drive it directly). */
export type LoadOutcome =
    | { kind: "ok"; view: PortalFeeView }
    /** The session ended (sign-out, another coordinator signed in) while it ran: drop it. */
    | { kind: "ended" }
    | { kind: "unauthorized" }
    | { kind: "error"; message: string };

/**
 * A SESSION of the fee section: everything it loads or sends belongs to the coordinator signed in when it
 * started. `reset()` (sign-out, sign-in) ends it: an answer that arrives afterwards — a big view still
 * downloading on a slow phone when «Cerrar sesión» was tapped — comes back `ended` (or null from `guard`)
 * and is never shown to whoever signs in next on that device; the in-flight load is forgotten too, so the
 * next coordinator's load is a request of their own. `onReset` lets the caller clear what it caches.
 */
export function createFeeSession(api: Pick<PortalFeeApi, "load">, onReset?: () => void) {
    let epoch = 0;
    const loader = createViewLoader(api);
    return {
        epoch: (): number => epoch,
        isCurrent: (e: number): boolean => e === epoch,
        async load(): Promise<LoadOutcome> {
            const e = epoch;
            try {
                const view = await loader.load();
                return e === epoch ? { kind: "ok", view } : { kind: "ended" };
            } catch (err) {
                if (e !== epoch) return { kind: "ended" };
                const a = feeErrorAction(err);
                return a.kind === "unauthorized" ? { kind: "unauthorized" } : { kind: "error", message: a.message };
            }
        },
        /** Any other answer of this session (a write's view): null when the session ended meanwhile. */
        async guard<T>(p: Promise<T>): Promise<T | null> {
            const e = epoch;
            const v = await p;
            return e === epoch ? v : null;
        },
        reset() { epoch += 1; loader.reset(); if (onReset) onReset(); },
    };
}

/** The toast when «Registrar pago de esta persona» could not load the payments (null: nothing to say). */
export const registerLoadNotice = (o: LoadOutcome): string | null =>
    o.kind === "error" ? `${o.message || "No se pudieron cargar los pagos."} Inténtalo de nuevo.` : null;

/**
 * Receipts fetched on demand, the last `max` kept (a receipt is up to ~1 MB of text), keyed by the payment AND
 * its split generation (`alloc_gen`): a receipt only changes through an edit, and every edit mints a new
 * generation — after «Corregir y reenviar» with a new photo, «Ver comprobante» shows the new one, not the
 * photo cached before (the coordinator thought the upload had failed and sent it again).
 */
export function createProofCache(api: Pick<PortalFeeApi, "proof">, max = 10) {
    const cache = new Map<string, string>();
    const inflight = new Map<string, Promise<string>>();
    const key = (id: number, allocGen?: number | null) => `${id}:${Number(allocGen) || 0}`;
    // `clear()` (a sign-out) starts a new session: a receipt still downloading is neither cached nor shared.
    let session = 0;
    return {
        peek: (id: number, allocGen?: number | null): string | null => cache.get(key(id, allocGen)) ?? null,
        get(id: number, allocGen?: number | null): Promise<string> {
            const k = key(id, allocGen);
            const hit = cache.get(k);
            if (hit) { cache.delete(k); cache.set(k, hit); return Promise.resolve(hit); }
            const running = inflight.get(k);
            if (running) return running;
            const s = session;
            const p = api.proof(id).then((proof) => {
                if (s === session) {
                    cache.set(k, proof);
                    while (cache.size > max) cache.delete(cache.keys().next().value as string);
                }
                return proof;
            }).finally(() => { if (inflight.get(k) === p) inflight.delete(k); });
            inflight.set(k, p);
            return p;
        },
        /** Forget every cached receipt of a payment (it was edited or deleted). */
        forget: (id: number) => { for (const k of [...cache.keys()]) if (k.startsWith(`${id}:`)) cache.delete(k); },
        clear: () => { session += 1; cache.clear(); inflight.clear(); },
    };
}
