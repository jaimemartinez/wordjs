/**
 * Accounting helpers (pure): filtering the ledger, summarising it by category and building its workbook.
 * The ledger mixes manual entries with the plugin's own receipts (validated fee payments, transport
 * payments), which arrive read-only with `source` 'inscription' / 'transport'.
 */
import type { XlsxCell, XlsxSheet } from './xlsx';

export type LedgerKind = 'income' | 'expense';
export type LedgerSource = 'manual' | 'inscription' | 'transport';
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
    inscription_id?: number | null;
};

export type LedgerFilter = { from?: string; to?: string; kind?: LedgerKind | ''; category?: string; source?: LedgerSource | ''; search?: string };

const cents = (n: unknown) => Math.round((Number(n) || 0) * 100);
const day = (v: unknown) => String(v || '').slice(0, 10);

export function filterLedger(entries: LedgerEntry[], f: LedgerFilter, names?: Map<number, string>): LedgerEntry[] {
    const q = String(f.search || '').trim().toLowerCase();
    return entries.filter((e) =>
        (!f.from || day(e.date) >= f.from)
        && (!f.to || day(e.date) <= f.to)
        && (!f.kind || e.kind === f.kind)
        && (!f.category || (e.category || '') === f.category)
        && (!f.source || e.source === f.source)
        && (!q || [e.description, e.category, e.reference, e.method, e.inscription_id != null ? names?.get(Number(e.inscription_id)) : '']
            .some((v) => String(v || '').toLowerCase().includes(q))));
}

export type LedgerSummary = {
    income: number;
    expense: number;
    balance: number;
    byCategory: { kind: LedgerKind; category: string; total: number; count: number }[];
};

/** Totals in cents (no float drift), and one line per (kind, category), largest first. */
export function summarizeLedger(entries: LedgerEntry[]): LedgerSummary {
    const t = { income: 0, expense: 0 };
    const cats = new Map<string, { kind: LedgerKind; category: string; total: number; count: number }>();
    for (const e of entries) {
        const c = cents(e.amount);
        t[e.kind] += c;
        const name = e.category || 'Sin categoría';
        const k = `${e.kind}\u0001${name}`;
        if (!cats.has(k)) cats.set(k, { kind: e.kind, category: name, total: 0, count: 0 });
        const row = cats.get(k)!;
        row.total += c; row.count++;
    }
    return {
        income: t.income / 100,
        expense: t.expense / 100,
        balance: (t.income - t.expense) / 100,
        byCategory: [...cats.values()].map((r) => ({ ...r, total: r.total / 100 })).sort((a, b) => (a.kind === b.kind ? b.total - a.total : a.kind === 'income' ? -1 : 1)),
    };
}

const SOURCE_LABEL: Record<string, string> = { manual: 'Manual', inscription: 'Pago de inscripción', transport: 'Pago de transporte' };
const KIND_LABEL: Record<string, string> = { income: 'Ingreso', expense: 'Egreso' };

/** "Movimientos" (signed amounts) + "Resumen" (totals and per-category lines). */
export function buildLedgerWorkbook(entries: LedgerEntry[], names?: Map<number, string>): XlsxSheet[] {
    const s = summarizeLedger(entries);
    const rows: XlsxCell[][] = entries.map((e) => [
        day(e.date), KIND_LABEL[e.kind] || e.kind, e.category || '', e.description,
        e.inscription_id != null ? (names?.get(Number(e.inscription_id)) || `#${e.inscription_id}`) : '',
        e.method || '', e.reference || '', SOURCE_LABEL[e.source] || e.source,
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
    return [summary, movements];
}
