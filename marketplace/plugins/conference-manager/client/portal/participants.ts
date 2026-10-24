/**
 * The coordinator portal's participant lists, as PURE helpers (no React, no fetch, no DOM): browser-side
 * paging, accent-free search, the payment-state filter chips and the multi-select rules of «Saldos».
 *
 * Owner decisions (tables-design.md D2/D10/D13, payments-design.md D-P17/D-P19):
 * - 20 rows per page, with «Mostrar 10 / 20 / 50 / 100» remembered per device (localStorage
 *   `wjs-portal:pageSize`; every access guarded — a private window or blocked storage falls back to 20);
 * - the search is instant and ignores accents and case («angela» finds «Ángela»), every word must match;
 * - the header checkbox selects THIS page only (tri-state), «Seleccionar los N» is capped at 200 people
 *   (the server's limit for one payment);
 * - a cancelled inscription is shown «Cancelada», owes nothing and can never be selected for a payment.
 *
 * The paging API is the same as the plugin's `client/lib/paging.ts` (core cannot import plugin code), so
 * both tables page the same way.
 */
import { isNameFallbackField, portalPersonName, type PortalField } from "./form";
import { fieldDisplayValue, normalizeSearch } from "./lodgingView";

// ── paging ───────────────────────────────────────────────────────────────────────────────────────
export const PAGE_SIZES = [10, 20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;
/** Where the portal remembers its «Mostrar N» choice (per device, shared by every portal list). */
export const PAGE_SIZE_KEY = "wjs-portal:pageSize";

/** Any value → one of PAGE_SIZES (20 when it is not one of them). */
export const normalizePageSize = (v: unknown): number => {
    const n = Number(v);
    return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
};

/** Pages needed for `total` rows (at least 1, so «1 / 1» is shown for an empty list). */
export const pageCount = (total: number, size: number): number =>
    Math.max(1, Math.ceil(Math.max(0, Number(total) || 0) / normalizePageSize(size)));

/** A page number inside 1 … pageCount (after a reload the last page may have gone). */
export const clampPage = (page: number, total: number, size: number): number => {
    const p = Math.floor(Number(page) || 1);
    return Math.min(Math.max(1, p), pageCount(total, size));
};

/** The rows of `page` (clamped). */
export function pageSlice<T>(rows: readonly T[], page: number, size: number): T[] {
    const list = Array.isArray(rows) ? rows : [];
    const s = normalizePageSize(size);
    const p = clampPage(page, list.length, s);
    return list.slice((p - 1) * s, p * s);
}

/** «21–40 de 183»: the 1-based first and last row shown, and the total ({ from: 0, to: 0 } when empty). */
export const rangeOf = (page: number, size: number, total: number): { from: number; to: number; total: number } => {
    const t = Math.max(0, Math.floor(Number(total) || 0));
    if (!t) return { from: 0, to: 0, total: 0 };
    const s = normalizePageSize(size);
    const p = clampPage(page, t, s);
    return { from: (p - 1) * s + 1, to: Math.min(t, p * s), total: t };
};

/**
 * The numbered window of a desktop pager: the first and last page, the current one and its neighbours,
 * '…' for each gap. pageWindow(6, 20) → [1, '…', 5, 6, 7, '…', 20]. A gap of one page shows the page.
 */
export function pageWindow(current: number, count: number, radius = 1): (number | "…")[] {
    const n = Math.max(1, Math.floor(Number(count) || 1));
    const c = Math.min(Math.max(1, Math.floor(Number(current) || 1)), n);
    const keep = new Set<number>([1, n]);
    for (let i = c - radius; i <= c + radius; i++) if (i >= 1 && i <= n) keep.add(i);
    const pages = [...keep].sort((a, b) => a - b);
    const out: (number | "…")[] = [];
    for (let i = 0; i < pages.length; i++) {
        if (i > 0) {
            const gap = pages[i] - pages[i - 1];
            if (gap === 2) out.push(pages[i] - 1);
            else if (gap > 2) out.push("…");
        }
        out.push(pages[i]);
    }
    return out;
}

/** Changing the page size keeps the first visible row on screen: floor((page-1)·old/new) + 1. */
export const pageAfterResize = (page: number, oldSize: number, newSize: number): number => {
    const o = normalizePageSize(oldSize), n = normalizePageSize(newSize);
    const p = Math.max(1, Math.floor(Number(page) || 1));
    return Math.floor(((p - 1) * o) / n) + 1;
};

type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const local = (): StorageLike | null => {
    try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
};

/** The device's «Mostrar N» (20 when nothing usable is stored or storage is blocked). */
export function readPageSize(key = PAGE_SIZE_KEY, store: StorageLike | null = local()): number {
    try { return normalizePageSize(store ? store.getItem(key) : null); } catch { return DEFAULT_PAGE_SIZE; }
}
/** Remember the device's «Mostrar N»; a storage failure is ignored (the choice still applies now). */
export function writePageSize(size: number, key = PAGE_SIZE_KEY, store: StorageLike | null = local()): void {
    try { if (store) store.setItem(key, String(normalizePageSize(size))); } catch { /* private mode / blocked */ }
}

/**
 * After a page change, bring the list's top (`el`) into view: without it a phone stays at the pager and
 * lands at the BOTTOM of the new page. Smooth, or instant under prefers-reduced-motion. A no-op outside a
 * browser. (The plugin admin's lib/paging.ts twin.)
 */
export function scrollToListTop(el: { scrollIntoView?: (o?: ScrollIntoViewOptions) => void } | null | undefined,
    win: { matchMedia?: (q: string) => { matches: boolean } } | null = typeof window !== "undefined" ? window : null): boolean {
    if (!el || typeof el.scrollIntoView !== "function") return false;
    let reduce = false;
    try { reduce = !!(win && typeof win.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch { /* old browser */ }
    try { el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" }); } catch { el.scrollIntoView(); }
    return true;
}

// ── the rows ─────────────────────────────────────────────────────────────────────────────────────
/**
 * A row of `GET /portal/inscriptions`: the payment columns, `registration_date`, the conference's field
 * columns flat on the row and (plugin ≥ 2.18.0) `pending_amount`, `returned_amount` and `cancelled`.
 * An older plugin sends none of the three: they read as 0 / not cancelled.
 */
export type PortalPerson = {
    id: number;
    payment_status?: string | null;
    total_due?: number | string | null;
    amount_paid?: number | string | null;
    registration_date?: string | null;
    pending_amount?: number | string | null;
    returned_amount?: number | string | null;
    cancelled?: boolean | number | null;
    [field: string]: unknown;
};

export const isCancelled = (p: Pick<PortalPerson, "cancelled"> | null | undefined): boolean =>
    !!p && (p.cancelled === true || Number(p.cancelled) === 1);

/** The person's display name, as the admin names people (form.ts portalPersonName). */
export const personName = (p: PortalPerson | null | undefined, fields: readonly PortalField[] | null | undefined): string =>
    portalPersonName(p as Record<string, unknown> | null | undefined, fields as PortalField[] | null | undefined);

/** A field's raw value on a row: its own column, else the legacy custom_data copy. */
export const fieldRaw = (p: PortalPerson | null | undefined, name: string): unknown => {
    const v = p?.[name];
    if (v !== undefined && v !== null && v !== "") return v;
    const cd = (p?.custom_data as Record<string, unknown> | undefined)?.[name];
    return cd !== undefined && cd !== null && cd !== "" ? cd : "";
};

/** Every word folded (accents, case): «Ángela  Núñez» → ['angela', 'nunez']. */
export const queryWords = (q: unknown): string[] => normalizeSearch(q).split(/\s+/).filter(Boolean);

/** What a row is found by: its display name, every form field value and the family group, folded. */
export const rowHaystack = (p: PortalPerson, fields: readonly PortalField[]): string => {
    const parts = [personName(p, fields)];
    for (const f of fields) parts.push(fieldDisplayValue(fieldRaw(p, f.name), f.type));
    return normalizeSearch(parts.filter(Boolean).join(" "));
};

/** True when EVERY word of the query is somewhere in the haystack (an empty query matches everything). */
export const matchesQuery = (haystack: string, q: unknown): boolean => {
    const words = queryWords(q);
    return words.every((w) => haystack.includes(w));
};

/** The payment state shown on a row: from VALIDATED money only (as the admin), and «Cancelada» first. */
export type PayState = "cancelled" | "paid" | "partial" | "unpaid";
const cents = (v: unknown): number => Math.round((Number(v) || 0) * 100);
export const payStateOf = (p: PortalPerson): PayState => {
    if (isCancelled(p)) return "cancelled";
    const due = Math.max(0, cents(p.total_due));
    const paid = Math.max(0, cents(p.amount_paid));
    if (due <= 0 || paid >= due) return "paid";
    return paid > 0 ? "partial" : "unpaid";
};
export const PAY_STATE_LABEL: Record<PayState, string> = { cancelled: "Cancelada", paid: "Pagado", partial: "Abono", unpaid: "Sin pagar" };

/** The Participantes filter chips. `pending` = has money awaiting the administration's validation. */
export const PAY_FILTERS = ["all", "unpaid", "partial", "paid", "pending"] as const;
export type PayFilter = typeof PAY_FILTERS[number];
export const PAY_FILTER_LABEL: Record<PayFilter, string> = { all: "Todos", unpaid: "Sin pagar", partial: "Abono", paid: "Pagado", pending: "Por validar" };

export const matchesPayFilter = (p: PortalPerson, f: PayFilter): boolean => {
    if (f === "all") return true;
    if (f === "pending") return cents(p.pending_amount) > 0;
    return payStateOf(p) === f;
};

export type RosterFilter = { q: string; pay: PayFilter; hideCancelled: boolean };
export const DEFAULT_ROSTER_FILTER: RosterFilter = { q: "", pay: "all", hideCancelled: false };

/** The rows a filter keeps, in their order. `haystacks` (by id) lets a caller memoise the folding. */
export function filterPeople(rows: readonly PortalPerson[], fields: readonly PortalField[], f: RosterFilter, haystacks?: Map<number, string>): PortalPerson[] {
    const list = Array.isArray(rows) ? rows : [];
    return list.filter((p) => {
        if (f.hideCancelled && isCancelled(p)) return false;
        if (!matchesPayFilter(p, f.pay)) return false;
        if (!queryWords(f.q).length) return true;
        return matchesQuery(haystacks?.get(Number(p.id)) ?? rowHaystack(p, fields), f.q);
    });
}

/** How many rows each chip would keep (with the search and «Ocultar canceladas» applied). */
export function payFilterCounts(rows: readonly PortalPerson[], fields: readonly PortalField[], f: RosterFilter, haystacks?: Map<number, string>): Record<PayFilter, number> {
    const out = Object.fromEntries(PAY_FILTERS.map((k) => [k, 0])) as Record<PayFilter, number>;
    for (const k of PAY_FILTERS) out[k] = filterPeople(rows, fields, { ...f, pay: k }, haystacks).length;
    return out;
}

/**
 * Up to `max` form fields for the desktop table's extra columns (tables-design D4): the first ones that
 * are not part of the name and not the grouping field.
 */
export const extraColumns = (fields: readonly PortalField[], max = 2): PortalField[] => {
    const named = fields.filter((f) => f.role === "first_name" || f.role === "last_name");
    // The fields the display name is made of (form.ts portalPersonName): the tagged ones, else the first
    // two fit to stand in for a name. They are already in the «Participante» column.
    const nameFields = new Set((named.length ? named : fields.filter(isNameFallbackField).slice(0, 2)).map((f) => f.name));
    return fields.filter((f) => !nameFields.has(f.name) && !f.is_group && f.name !== "first_name" && f.name !== "last_name").slice(0, max);
};

// ── selection («Saldos» multi-select; the legacy bulk payment) ──────────────────────────────────────
/** The most people one payment may carry (the server's MAX_PARTS / the old bulk cap). */
export const SELECTION_MAX = 200;

export const toggleId = (selected: readonly number[], id: number): number[] =>
    selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];

/** The header checkbox of a page: none / some (indeterminate) / all of the page's selectable ids. */
export const pageSelectionState = (pageIds: readonly number[], selected: readonly number[]): "none" | "some" | "all" => {
    if (!pageIds.length) return "none";
    const n = pageIds.filter((id) => selected.includes(id)).length;
    return n === 0 ? "none" : n === pageIds.length ? "all" : "some";
};

/**
 * Tick (`on`) or untick a page's ids, keeping the rest of the selection. Ticking never goes past the cap:
 * the page's ids are added in order until SELECTION_MAX.
 */
export function selectPage(selected: readonly number[], pageIds: readonly number[], on: boolean, cap = SELECTION_MAX): number[] {
    if (!on) return selected.filter((id) => !pageIds.includes(id));
    const out = [...selected];
    for (const id of pageIds) {
        if (out.length >= cap) break;
        if (!out.includes(id)) out.push(id);
    }
    return out;
}

/** «Seleccionar los N»: every id, capped at SELECTION_MAX; `capped` says some were left out. */
export const selectAllCapped = (ids: readonly number[], cap = SELECTION_MAX): { ids: number[]; capped: boolean } => {
    const uniq = [...new Set(ids)];
    return { ids: uniq.slice(0, cap), capped: uniq.length > cap };
};

/** After a reload: drop ids that are gone or can no longer be selected. */
export const pruneSelection = (selected: readonly number[], validIds: readonly number[]): number[] => {
    const ok = new Set(validIds);
    // The same array when nothing goes (2.36.6): a caller that sets it as state does not re-render for nothing.
    const kept = selected.filter((id) => ok.has(id));
    return kept.length === selected.length ? (selected as number[]) : kept;
};

/** The sorted, de-duplicated key of a set of ids (to compare two selections). */
export const idsKey = (ids: readonly number[]): string => [...new Set(ids)].sort((a, b) => a - b).join(",");

// ── family groups (the «Pérez (3)» chips of Saldos) ──────────────────────────────────────────────
export type FamilyGroup = { name: string; ids: number[] };

/**
 * The family-group chips worth showing (Saldos and the «+ Añadir» picker): only groups with at least TWO
 * people who can be paid (`payable`; a «(1)» chip does what one checkbox does), matching every search word
 * in the group's name or a member's name, and at most `cap` of them unless `all` — the rest is counted for a
 * «Ver más grupos (n)» button. On a location of hundreds of one-person «groups» this is the difference
 * between a wall of buttons and a list.
 */
export function familyChips(groups: readonly FamilyGroup[], payable: (id: number) => boolean, nameOf: (id: number) => string, words: readonly string[], opts: { cap?: number; all?: boolean } = {}):
    { shown: FamilyGroup[]; hidden: number } {
    const cap = opts.cap ?? 8;
    const fits = groups
        .map((g) => ({ name: g.name, ids: g.ids.filter(payable) }))
        .filter((g) => g.ids.length >= 2)
        .filter((g) => !words.length || words.every((w) => normalizeSearch(g.name).includes(w) || g.ids.some((id) => normalizeSearch(nameOf(id)).includes(w))));
    if (opts.all || fits.length <= cap) return { shown: fits, hidden: 0 };
    return { shown: fits.slice(0, cap), hidden: fits.length - cap };
}

/** The grouping field's values among `rows` (the field flagged `is_group`), each with its people's ids. */
export function familyGroupsOf(rows: readonly PortalPerson[], fields: readonly PortalField[]): FamilyGroup[] {
    const gf = fields.find((f) => !!f.is_group);
    if (!gf) return [];
    const map = new Map<string, number[]>();
    for (const r of rows) {
        const v = String(fieldRaw(r, gf.name) ?? "").trim();
        if (!v) continue;
        if (!map.has(v)) map.set(v, []);
        map.get(v)!.push(Number(r.id));
    }
    return [...map.entries()].map(([name, ids]) => ({ name, ids })).sort((a, b) => a.name.localeCompare(b.name, "es"));
}
