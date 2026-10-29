/**
 * «Localidades › Excel» (2.36.23, pure — no React, no fetch; the page feeds the data).
 *
 * One row per locality and the columns the admin picks and orders: the locality's data (coordinator, cupos,
 * inscritos, disponibles, % de ocupación), counts read from the roster (cancelados, grupos familiares, estado de
 * pago), «Inscritos por edad» in age ranges the admin edits, and «Por <campo>» — one column per answer of a
 * selection field of the form. An optional bold «Total» row closes the sheet.
 *
 * Seats come from the locality itself (`inscribed`, the same number as the card); the breakdowns count its
 * NON-cancelled roster rows, so they add up to it.
 */
import type { XlsxCell, XlsxSheet } from './xlsx';
import { fieldValue } from './exports';

export type ReportLocation = {
    id: number; name: string; capacity: number | string | null; inscribed: number;
    responsible_name?: string | null; responsible_phone?: string | null; responsible_email?: string | null;
};
export type ReportPerson = Record<string, any>;
export type ReportField = { name: string; label?: string | null; type?: string | null; options?: string | null; role?: string | null; is_group?: number | boolean | null };
export type AgeRange = { from: number; to: number };

/** The oldest age a range can reach; a range that ends here reads «60+». */
export const AGE_MAX = 120;
export const DEFAULT_AGE_RANGES: readonly AgeRange[] = Object.freeze([
    { from: 0, to: 5 }, { from: 6, to: 11 }, { from: 12, to: 17 }, { from: 18, to: 59 }, { from: 60, to: AGE_MAX },
]);

/** The locality's own columns. */
export const LOCATION_KEYS = ['name', 'responsible_name', 'responsible_phone', 'responsible_email', 'capacity', 'inscribed', 'available', 'occupancy'] as const;
/** Counts that need the roster (Inscripciones › ver). */
export const ROSTER_KEYS = ['cancelled', 'families'] as const;
/** Counts by payment status (also Pagos › ver). */
export const PAYMENT_KEYS = ['paid', 'partial', 'unpaid'] as const;
/** The expanding items: the age ranges and one per selection field (`by:<field name>`). */
export const AGES_KEY = 'ages';
export const BY_PREFIX = 'by:';

export const DEFAULT_REPORT_KEYS: readonly string[] = Object.freeze(['name', 'responsible_name', 'capacity', 'inscribed', 'available', 'occupancy', AGES_KEY]);

export type ReportLabels = Record<string, string>;
export const REPORT_LABELS: ReportLabels = {
    name: 'Localidad', responsible_name: 'Encargado', responsible_phone: 'Teléfono del encargado', responsible_email: 'Correo del encargado',
    capacity: 'Cupos asignados', inscribed: 'Inscritos', available: 'Cupos disponibles', occupancy: '% de ocupación',
    cancelled: 'Cancelados', families: 'Grupos familiares', paid: 'Pagado', partial: 'Abono', unpaid: 'Sin pagar',
    ages: 'Inscritos por edad', age: 'Edad', age_unknown: 'Sin edad', no_answer: 'Sin respuesta', unlimited: 'Sin límite', total: 'Total',
    sheet: 'Localidades',
};

/** An age in whole years (0–AGE_MAX), or null when the answer is empty or not a number. */
export function parseAge(v: unknown): number | null {
    const s = String(v ?? '').trim().replace(',', '.');
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0 || n > AGE_MAX) return null;
    return Math.floor(n);
}

/** «0–5», «60+» (a range that reaches AGE_MAX), «7» (a single age). */
export function ageRangeLabel(r: AgeRange): string {
    if (r.to >= AGE_MAX) return `${r.from}+`;
    return r.from === r.to ? String(r.from) : `${r.from}–${r.to}`;
}

export type AgeRangeError = { code: 'empty' | 'invalid' | 'order' | 'overlap'; index: number };

/**
 * Whole years between 0 and AGE_MAX, «desde» ≤ «hasta», no two ranges sharing an age (a gap is allowed: those
 * ages simply fall in no column). `index` is the row to point at, in the order given.
 */
export function ageRangesError(ranges: readonly { from: unknown; to: unknown }[]): AgeRangeError | null {
    if (!ranges.length) return { code: 'empty', index: -1 };
    const ok = (v: unknown) => String(v ?? '').trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= AGE_MAX;
    for (let i = 0; i < ranges.length; i++) {
        if (!ok(ranges[i].from) || !ok(ranges[i].to)) return { code: 'invalid', index: i };
        if (Number(ranges[i].from) > Number(ranges[i].to)) return { code: 'order', index: i };
    }
    for (let i = 0; i < ranges.length; i++)
        for (let j = 0; j < i; j++)
            if (Number(ranges[i].from) <= Number(ranges[j].to) && Number(ranges[j].from) <= Number(ranges[i].to)) return { code: 'overlap', index: i };
    return null;
}

/** The ranges as numbers, youngest first (call after ageRangesError said null). */
export function normalizeAgeRanges(ranges: readonly { from: unknown; to: unknown }[]): AgeRange[] {
    return ranges.map((r) => ({ from: Number(r.from), to: Number(r.to) })).sort((a, b) => a.from - b.from);
}

/** The form's age field (role «age»), if any. */
export const ageFieldOf = (fields: readonly ReportField[]): ReportField | undefined =>
    fields.find((f) => f.role === 'age') || fields.find((f) => f.name === 'age');

/** Selection fields a locality can be broken down by — never the health answer. */
export const breakdownFields = (fields: readonly ReportField[]): ReportField[] =>
    fields.filter((f) => f.type === 'select' && f.role !== 'health' && f.name !== 'health_conditions');

const optionsOf = (f: ReportField) => String(f.options || '').split(',').map((s) => s.trim()).filter(Boolean);
const fold = (s: string) => s.trim().toLowerCase();

/** One field's answers, in the form's order, plus answers no option matches (an old option), in first-seen order. */
export function answersOf(field: ReportField, people: readonly ReportPerson[]): string[] {
    const out = optionsOf(field);
    const seen = new Set(out.map(fold));
    for (const p of people) {
        const v = String(fieldValue(p, field.name) ?? '').trim();
        if (v && !seen.has(fold(v))) { seen.add(fold(v)); out.push(v); }
    }
    return out;
}

const capOf = (l: ReportLocation): number | null => {
    const c = l.capacity == null || l.capacity === '' ? null : Number(l.capacity);
    return c == null || !Number.isFinite(c) || c <= 0 ? null : c;
};
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

type Col = { header: string; width: number; value: (l: ReportLocation, rows: ReportPerson[]) => XlsxCell; total: (locs: ReportLocation[], rows: ReportPerson[]) => XlsxCell };

/** Count rows (the default total of a breakdown column is the count over every exported locality). */
const counting = (header: string, test: (p: ReportPerson) => boolean, width = 12): Col => ({
    header, width,
    value: (_l, rows) => rows.filter(test).length,
    total: (_locs, rows) => rows.filter(test).length,
});

function columnsFor(key: string, o: { fields: readonly ReportField[]; people: readonly ReportPerson[]; ageRanges: readonly AgeRange[]; ageUnknown: boolean; labels: ReportLabels; groupField?: ReportField; ageField?: ReportField }): Col[] {
    const L = o.labels;
    const text = (k: 'name' | 'responsible_name' | 'responsible_phone' | 'responsible_email', width: number, total = ''): Col => ({
        header: L[k], width, value: (l) => String(l[k] ?? ''), total: () => total,
    });
    switch (key) {
        case 'name': return [text('name', 28, L.total)];
        case 'responsible_name': return [text('responsible_name', 24)];
        case 'responsible_phone': return [text('responsible_phone', 18)];
        case 'responsible_email': return [text('responsible_email', 28)];
        case 'capacity': return [{
            header: L.capacity, width: 14,
            value: (l) => capOf(l) ?? L.unlimited,
            total: (locs) => locs.reduce((s, l) => s + (capOf(l) ?? 0), 0),
        }];
        case 'inscribed': return [{
            header: L.inscribed, width: 12,
            value: (l) => Math.max(0, Number(l.inscribed) || 0),
            total: (locs) => locs.reduce((s, l) => s + Math.max(0, Number(l.inscribed) || 0), 0),
        }];
        case 'available': return [{
            header: L.available, width: 15,
            value: (l) => { const c = capOf(l); return c == null ? '' : Math.max(0, c - (Number(l.inscribed) || 0)); },
            total: (locs) => locs.reduce((s, l) => { const c = capOf(l); return c == null ? s : s + Math.max(0, c - (Number(l.inscribed) || 0)); }, 0),
        }];
        // Seats taken over the cupo, in %; a locality without a limit has none, and the total counts only the limited ones.
        case 'occupancy': return [{
            header: L.occupancy, width: 14,
            value: (l) => { const c = capOf(l); return c == null ? '' : pct(Number(l.inscribed) || 0, c); },
            total: (locs) => {
                const lim = locs.filter((l) => capOf(l) != null);
                return pct(lim.reduce((s, l) => s + (Number(l.inscribed) || 0), 0), lim.reduce((s, l) => s + (capOf(l) as number), 0));
            },
        }];
        case 'cancelled': return [{
            header: L.cancelled, width: 12,
            value: (l) => o.people.filter((p) => p.status === 'cancelled' && Number(p.location_id) === Number(l.id)).length,
            total: (locs) => { const ids = new Set(locs.map((l) => Number(l.id))); return o.people.filter((p) => p.status === 'cancelled' && ids.has(Number(p.location_id))).length; },
        }];
        // Distinct family groups (trimmed, case-insensitive — like the group picker) among the active people.
        case 'families': {
            const g = o.groupField;
            const distinct = (rows: ReportPerson[]) => (g ? new Set(rows.map((p) => fold(String(fieldValue(p, g.name) ?? ''))).filter(Boolean)).size : 0);
            return g ? [{ header: L.families, width: 16, value: (_l, rows) => distinct(rows), total: (_locs, rows) => distinct(rows) }] : [];
        }
        case 'paid': case 'partial': case 'unpaid':
            return [counting(L[key], (p) => String(p.payment_status || 'unpaid') === key)];
        case AGES_KEY: {
            const af = o.ageField;
            if (!af) return [];
            const ageOf = (p: ReportPerson) => parseAge(fieldValue(p, af.name));
            const cols = o.ageRanges.map((r) => counting(`${L.age} ${ageRangeLabel(r)}`, (p) => { const a = ageOf(p); return a != null && a >= r.from && a <= r.to; }));
            if (o.ageUnknown) cols.push(counting(L.age_unknown, (p) => ageOf(p) == null));
            return cols;
        }
        default: {
            if (!key.startsWith(BY_PREFIX)) return [];
            const f = o.fields.find((x) => x.name === key.slice(BY_PREFIX.length));
            if (!f) return [];
            const head = String(f.label || f.name);
            const answer = (p: ReportPerson) => fold(String(fieldValue(p, f.name) ?? ''));
            const active = o.people.filter((p) => p.status !== 'cancelled');
            return [
                ...answersOf(f, active).map((a) => counting(`${head}: ${a}`, (p) => answer(p) === fold(a), 14)),
                counting(`${head}: ${L.no_answer}`, (p) => answer(p) === '', 14),
            ];
        }
    }
}

/**
 * The «Localidades» sheet. `keys` is the admin's ordered choice; a key whose data is missing (no age field, no
 * grouping field, an unknown field) adds no column. `locationIds` limits and keeps the given localities' order
 * (null = all, in the list's order).
 */
export function buildLocationsSheet(opts: {
    locations: readonly ReportLocation[];
    people: readonly ReportPerson[];
    fields: readonly ReportField[];
    keys: readonly string[];
    ageRanges?: readonly AgeRange[];
    ageUnknown?: boolean;
    totals?: boolean;
    locationIds?: readonly number[] | null;
    labels?: Partial<ReportLabels>;
}): XlsxSheet {
    const labels = { ...REPORT_LABELS, ...(opts.labels || {}) } as ReportLabels;
    const wanted = opts.locationIds ? new Set(opts.locationIds.map(Number)) : null;
    const locs = opts.locations.filter((l) => !wanted || wanted.has(Number(l.id)));
    const ctx = {
        fields: opts.fields, people: opts.people, labels,
        ageRanges: normalizeAgeRanges(opts.ageRanges || DEFAULT_AGE_RANGES), ageUnknown: opts.ageUnknown !== false,
        groupField: opts.fields.find((f) => Number(f.is_group) === 1 || f.is_group === true), ageField: ageFieldOf(opts.fields),
    };
    const cols = opts.keys.flatMap((k) => columnsFor(k, ctx));
    const activeOf = (id: number) => opts.people.filter((p) => p.status !== 'cancelled' && Number(p.location_id) === Number(id));
    const rows: XlsxCell[][] = locs.map((l) => { const r = activeOf(l.id); return cols.map((c) => c.value(l, r)); });
    const boldRows: number[] = [];
    if (opts.totals !== false && locs.length) {
        const ids = new Set(locs.map((l) => Number(l.id)));
        const all = opts.people.filter((p) => p.status !== 'cancelled' && ids.has(Number(p.location_id)));
        boldRows.push(rows.length);
        rows.push(cols.map((c) => c.total(locs, all)));
    }
    return { name: labels.sheet, columns: cols.map((c) => ({ header: c.header, width: c.width })), rows, boldRows };
}
