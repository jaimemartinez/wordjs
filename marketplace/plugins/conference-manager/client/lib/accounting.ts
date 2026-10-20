/**
 * Accounting helpers (pure): filtering the ledger, summarising it by category and building its workbook.
 * The ledger mixes manual entries with the plugin's own receipts (validated fee payments, transport
 * payments), which arrive read-only with `source` 'inscription' / 'transport'.
 *
 * 2.18.0 («Pagos de cuotas», owner decisions D-P14 / D-P15): a fee line is ONE PAYMENT — the receipt as the
 * bank shows it — dated by the payment date its recorder typed, with `people` and its `allocations` (one
 * per person). «Movimientos» keeps one row per payment (it reconciles with the bank line by line); the new
 * «Detalle de cuotas» sheet has one row per person, and its total equals the «Inscripciones» category.
 */
import type { XlsxCell, XlsxSheet } from './xlsx';

export type LedgerKind = 'income' | 'expense';
export type LedgerSource = 'manual' | 'inscription' | 'transport';
export type LedgerAllocation = { inscription_id: number; amount: number };
export type LedgerEntry = {
    id: number | string;
    kind: LedgerKind;
    date: string;
    category?: string | null;
    description: string;
    amount: number;
    method?: string | null;
    reference?: string | null;
    source: LedgerSource;
    readonly: boolean;
    /** A one-person fee payment (or a pre-2.18 line); null for a shared one — see `allocations`. */
    inscription_id?: number | null;
    /** 2.18.0 fee lines: the payment, how many people it covers and each one's part. */
    transfer_id?: number | null;
    people?: number;
    allocations?: LedgerAllocation[];
    /** The recorder's location (null = several / none). Transport lines carry the passenger's. */
    location_id?: number | null;
    /** A location's share of a shared payment (locationShare): how many people the whole payment covers. */
    share_total?: number;
};

/** `location`: '' = all, 'none' = lines without a location, else an id (a shared payment matches each of its people's locations). */
export type LedgerFilter = { from?: string; to?: string; kind?: LedgerKind | ''; category?: string; source?: LedgerSource | ''; search?: string; location?: string };

const cents = (n: unknown) => Math.round((Number(n) || 0) * 100);
/**
 * A ledger line's day ('YYYY-MM-DD') in the browser's time zone — what «Contabilidad» shows. A fee payment's date
 * is a plain day (the payment date typed); a transport payment recorded without one, and other server stamps, are
 * 'YYYY-MM-DD HH:MM:SS' in UTC (CURRENT_TIMESTAMP): sliced, a payment of 21:52 in Bogotá read as the NEXT day in the
 * Excel «Movimientos» and the date filter, while the screen said the day it was (2.18.0 live round 5-1; the twin
 * of the fee workbook's «Revisado el»). An ISO string with a zone is read as such. A typed day that a DATETIME
 * column hands back at midnight ('2026-10-11 00:00:00': MySQL) stays that day — it is a date, not an instant.
 */
export function ledgerDay(v: unknown): string {
    const s = String(v ?? '').trim();
    const p = (n: number) => String(n).padStart(2, '0');
    const local = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const stamp = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/.exec(s);
    if (stamp && /^00:00(?::00(?:\.0+)?)?$/.test(stamp[2])) return stamp[1];
    if (stamp) { const d = new Date(`${stamp[1]}T${stamp[2]}Z`); if (!Number.isNaN(d.getTime())) return local(d); }
    if (/^\d{4}-\d{2}-\d{2}T\S*(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) { const d = new Date(s); if (!Number.isNaN(d.getTime())) return local(d); }
    return s.slice(0, 10);
}
const day = (v: unknown) => ledgerDay(v);
// Any space (the no-break one of «1 persona» included) folds to a plain one: a search typed with spaces finds it.
const fold = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').toLowerCase();

/** The people a line names: its allocations, else its single inscription. */
export const linePeople = (e: LedgerEntry): number[] =>
    Array.isArray(e.allocations) && e.allocations.length ? e.allocations.map((a) => Number(a.inscription_id))
        : e.inscription_id != null ? [Number(e.inscription_id)] : [];

/** Does location `loc` ('none' = no location, else an id) name `l`? */
const inLocation = (l: number | null | undefined, loc: string) => (loc === 'none' ? l == null : l != null && Number(l) === Number(loc));

/**
 * A fee payment seen from ONE location: only the parts of that location's people, its amount their sum, and
 * the description saying it is a share («Pago de cuotas · 1 de 3 personas»). A part whose person the page
 * cannot place (`locationOf` lacks them: no right to read the roster) is placed at the line's own location.
 * null when none of its people are there. Lines without parts (manual, transport) come back unchanged.
 * Each part of a shared payment thus counts under exactly one location: the per-location totals add up to
 * the whole, and a location's «Detalle de cuotas» lists only its own people.
 */
export function locationShare(e: LedgerEntry, loc: string, locationOf?: Map<number, number | null>): LedgerEntry | null {
    if (!loc || e.source !== 'inscription' || !Array.isArray(e.allocations) || !e.allocations.length) return e;
    const placeOf = (id: number) => (locationOf && locationOf.has(id) ? locationOf.get(id) : e.location_id);
    const kept = e.allocations.filter((a) => inLocation(placeOf(Number(a.inscription_id)), loc));
    if (!kept.length) return null;
    if (kept.length === e.allocations.length) return e;
    const total = e.allocations.length;
    return {
        ...e,
        amount: kept.reduce((s, a) => s + cents(a.amount), 0) / 100,
        allocations: kept,
        people: kept.length,
        inscription_id: kept.length === 1 ? Number(kept[0].inscription_id) : null,
        description: `Pago de cuotas · ${kept.length} de ${total} personas`,
        share_total: total,
    };
}

type Tx = (key: string, fallback: string, vars?: Record<string, string | number>) => string;
const fill: Tx = (_k, f, v) => String(f).replace(/\{(\w+)\}/g, (m, k) => (v && v[k] !== undefined ? String(v[k]) : m));
/**
 * The title of a line in the admin's language (2.18.0 review: the server writes it in Spanish only, and a
 * one-person payment read «Pago de inscripción» right above «Pago de cuotas · 3 personas»). Every 2.18 fee
 * payment is «Pago de cuotas · N personas» («· 1 persona»), a location's share of one «Pago de cuotas · 1 de
 * 3 personas»; any other line keeps its own description (manual entries, transport, a pre-2.18 row).
 * Without `tx` it is the Spanish text — the workbook's, so the Excel says what the screen says. The count and its
 * noun are joined by a NO-BREAK space (U+00A0: «1 persona», «2 de 3 personas», in every language): on a phone the
 * title broke as «Pago de cuotas · 1» / «persona» (2.18.0 review PUX-5, the twin of the review queue's card). So is
 * the «·» to the count after it: the line breaks BEFORE the «·» — «Pago de cuotas» / «· 3 personas» — never
 * leaving it alone at the end of a line (2.18.0 review UX6-4).
 */
export function feeLineTitle(e: Pick<LedgerEntry, 'source' | 'transfer_id' | 'people' | 'allocations' | 'inscription_id' | 'description' | 'share_total'>, tx: Tx = fill): string {
    if (e.source !== 'inscription' || e.transfer_id == null) return e.description;
    const n = Number(e.people) || linePeople(e as LedgerEntry).length || 1;
    if (e.share_total && e.share_total > n) return tx('accounting.fee.share', 'Pago de cuotas ·\u00a0{n}\u00a0de {total}\u00a0personas', { n, total: e.share_total });
    return n === 1 ? tx('accounting.fee.line.one', 'Pago de cuotas ·\u00a01\u00a0persona') : tx('accounting.fee.line', 'Pago de cuotas ·\u00a0{n}\u00a0personas', { n });
}

/**
 * `names`: inscription id → display name (search). `locationOf`: inscription id → location id, so a shared
 * payment of several locations matches each of them. With a location, a fee payment keeps only that
 * location's share (locationShare): summaries and the workbook built from the result count each person's
 * part under their own location once.
 */
export function filterLedger(entries: LedgerEntry[], f: LedgerFilter, names?: Map<number, string>, locationOf?: Map<number, number | null>): LedgerEntry[] {
    const q = fold(String(f.search || '').trim());
    const loc = String(f.location || '');
    const shared = (e: LedgerEntry) => e.source === 'inscription' && Array.isArray(e.allocations) && e.allocations.length > 0;
    return entries.map((e) => (loc && shared(e) ? locationShare(e, loc, locationOf) : e)).filter((e): e is LedgerEntry => {
        if (!e) return false;
        if (f.from && day(e.date) < f.from) return false;
        if (f.to && day(e.date) > f.to) return false;
        if (f.kind && e.kind !== f.kind) return false;
        if (f.category && (e.category || '') !== f.category) return false;
        if (f.source && e.source !== f.source) return false;
        if (loc && !shared(e)) {
            const own = e.location_id == null ? null : Number(e.location_id);
            const peopleLocs = linePeople(e).map((id) => (locationOf && locationOf.has(id) ? locationOf.get(id) : undefined));
            if (loc === 'none') {
                // A line of no location: its own is none and (when it names people) one of them has none.
                if (own != null || (peopleLocs.length > 0 && !peopleLocs.some((l) => l == null))) return false;
            } else {
                const lid = Number(loc);
                if (own !== lid && !peopleLocs.some((l) => l != null && Number(l) === lid)) return false;
            }
        }
        if (q) {
            const who = linePeople(e).map((id) => names?.get(id) || '');
            const hay = [e.description, feeLineTitle(e), e.category, e.reference, e.method, e.transfer_id != null ? `#${e.transfer_id}` : '', ...who].map(fold);
            if (!hay.some((v) => v.includes(q))) return false;
        }
        return true;
    });
}

export type LedgerSummary = {
    income: number;
    expense: number;
    balance: number;
    /** How many movements (lines) are summed. */
    movements: number;
    /** `count` = movements; `people` = the people the category's fee payments cover (0 for other lines). */
    byCategory: { kind: LedgerKind; category: string; total: number; count: number; people: number }[];
};

/** Totals in cents (no float drift), and one line per (kind, category), largest first. */
export function summarizeLedger(entries: LedgerEntry[]): LedgerSummary {
    const t = { income: 0, expense: 0 };
    const cats = new Map<string, { kind: LedgerKind; category: string; total: number; count: number; people: number }>();
    for (const e of entries) {
        const c = cents(e.amount);
        t[e.kind] += c;
        const name = e.category || 'Sin categoría';
        const k = `${e.kind}\u0001${name}`;
        if (!cats.has(k)) cats.set(k, { kind: e.kind, category: name, total: 0, count: 0, people: 0 });
        const row = cats.get(k)!;
        row.total += c; row.count++;
        if (e.source === 'inscription') row.people += linePeople(e).length || 1;
    }
    return {
        income: t.income / 100,
        expense: t.expense / 100,
        balance: (t.income - t.expense) / 100,
        movements: entries.length,
        byCategory: [...cats.values()].map((r) => ({ ...r, total: r.total / 100 })).sort((a, b) => (a.kind === b.kind ? b.total - a.total : a.kind === 'income' ? -1 : 1)),
    };
}

const SOURCE_LABEL: Record<string, string> = { manual: 'Manual', inscription: 'Pago de inscripción', transport: 'Pago de transporte' };
/**
 * The «Origen» of a line. A fee line that is a 2.18 payment (`transfer_id`) is «Pago de cuotas» — the name of
 * its section and of its own description («Pago de cuotas · 3 personas»); an unwrapped pre-2.18 row keeps
 * «Pago de inscripción».
 */
export const sourceLabelOf = (e: Pick<LedgerEntry, 'source' | 'transfer_id'>): string =>
    e.source === 'inscription' && e.transfer_id != null ? 'Pago de cuotas' : (SOURCE_LABEL[e.source] || e.source);
const KIND_LABEL: Record<string, string> = { income: 'Ingreso', expense: 'Egreso' };

/** «Participante» of a movement: the person's name, «3 personas» for a shared payment, '' otherwise. */
export function lineParticipant(e: LedgerEntry, names?: Map<number, string>): string {
    const ids = linePeople(e);
    if (ids.length > 1) return `${ids.length} personas`;
    if (ids.length === 1) return names?.get(ids[0]) || `#${ids[0]}`;
    return '';
}

/**
 * "Resumen" (totals and per-category lines), "Movimientos" (one row per movement — a fee payment is ONE row,
 * as on the bank statement) and, when there are fee payments, "Detalle de cuotas" (one row per person:
 * Fecha, Pago #, Localidad, Participante, Monto, Método, Referencia; its total equals the fee lines').
 * `locationName`: inscription id → its location's name (the detail's «Localidad»).
 */
export function buildLedgerWorkbook(entries: LedgerEntry[], names?: Map<number, string>, locationName?: Map<number, string>): XlsxSheet[] {
    const s = summarizeLedger(entries);
    const rows: XlsxCell[][] = entries.map((e) => [
        day(e.date), KIND_LABEL[e.kind] || e.kind, e.category || '', feeLineTitle(e),
        lineParticipant(e, names),
        e.method || '', e.reference || '', sourceLabelOf(e),
        { money: e.kind === 'income' ? Number(e.amount) || 0 : 0 }, { money: e.kind === 'expense' ? Number(e.amount) || 0 : 0 },
    ]);
    const movements: XlsxSheet = {
        name: 'Movimientos',
        columns: [{ header: 'Fecha', width: 12 }, { header: 'Tipo', width: 10 }, { header: 'Categoría', width: 18 }, { header: 'Descripción', width: 34 }, { header: 'Participante', width: 24 }, { header: 'Forma de pago', width: 14 }, { header: 'Referencia', width: 16 }, { header: 'Origen', width: 20 }, { header: 'Ingreso', width: 14 }, { header: 'Egreso', width: 14 }],
        rows: [...rows, ['', '', '', 'TOTAL', '', '', '', '', { money: s.income }, { money: s.expense }]],
        boldRows: [rows.length],
    };
    const summary: XlsxSheet = {
        name: 'Resumen',
        columns: [{ header: 'Concepto', width: 30 }, { header: 'Tipo', width: 10 }, { header: 'Movimientos', width: 13 }, { header: 'Total', width: 16 }],
        rows: [
            ['Ingresos', '', '', { money: s.income }],
            ['Egresos', '', '', { money: s.expense }],
            ['Balance', '', '', { money: s.balance }],
            ['', '', '', ''],
            ...s.byCategory.map((c) => [c.category, KIND_LABEL[c.kind], c.count, { money: c.total }] as XlsxCell[]),
        ],
        boldRows: [0, 1, 2],
    };
    const fees = entries.filter((e) => e.source === 'inscription');
    if (!fees.length) return [summary, movements];
    const detail: XlsxCell[][] = [];
    let totalC = 0;
    for (const e of fees) {
        const parts: LedgerAllocation[] = Array.isArray(e.allocations) && e.allocations.length ? e.allocations
            : e.inscription_id != null ? [{ inscription_id: Number(e.inscription_id), amount: Number(e.amount) || 0 }] : [];
        for (const p of parts) {
            totalC += cents(p.amount);
            detail.push([
                day(e.date), e.transfer_id != null ? `#${e.transfer_id}` : '', locationName?.get(Number(p.inscription_id)) || '',
                names?.get(Number(p.inscription_id)) || `#${p.inscription_id}`, { money: cents(p.amount) / 100 }, e.method || '', e.reference || '',
            ]);
        }
    }
    const detailSheet: XlsxSheet = {
        name: 'Detalle de cuotas',
        columns: [{ header: 'Fecha', width: 12 }, { header: 'Pago #', width: 10 }, { header: 'Localidad', width: 20 }, { header: 'Participante', width: 28 }, { header: 'Monto', width: 14 }, { header: 'Forma de pago', width: 14 }, { header: 'Referencia', width: 16 }],
        rows: [...detail, ['', '', '', 'TOTAL', { money: totalC / 100 }, '', '']],
        boldRows: [detail.length],
    };
    return [summary, movements, detailSheet];
}
