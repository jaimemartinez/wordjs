// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Pagos de cuotas» (2.18.0) — the admin's section for the participation FEES (transport is paid in
 * «Transporte»; «Contabilidad» stays its own tab, linked from here — D-P4, D-P16).
 *
 * One request loads it (GET /fee-payments: summary, per location, counts, every payment without receipts,
 * each person's balance and who they are — name, location, family group; never the roster's contacts or
 * form answers: Pagos › ver alone does not read the roster, D-P20). Four parts, remembered per conference
 * (sessionStorage `cm:fees:<id>`):
 *
 * - Resumen — Cuotas, Validado, Por validar (opens the queue), Devuelto (opens «Pagos» filtered), Por
 *   cobrar and, when there is any, A favor; Validado + Por validar + Por cobrar = Cuotas as one bar; one line
 *   per location (a tap opens «Saldos» of that location).
 * - Por validar (N) — the review queue, oldest first, with location / method chips. From 1024 px a
 *   master-detail (the list and the payment side by side, the receipt large); on a phone the list and a
 *   full-height sheet. «Validar y siguiente» moves on by itself (D-P21: no bulk validation).
 * - Pagos — every payment, filtered by status, location, method, who recorded it, dates and a search over
 *   the reference, «#id» and the people; 20 per page.
 * - Saldos — one row per person with their money; chips Con saldo (default) / Por validar / Devuelto /
 *   Pagados / A favor / Todos, locations, search; select people (44 px boxes, the page or «los N», at most
 *   200) and «Registrar pago (n)» from the sticky bar (D-P17). A row opens the person sheet.
 *
 * Payments:view opens it; payments:manage registers, validates, returns, rejects, edits and deletes.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { conferenceApi, feePaymentsApi, PAYMENT_METHODS } from "../lib/conference";
import { COARSE_FIELDS_CSS, LAYER } from "../lib/overlay";
import { toCents } from "../lib/feeSplit";
import {
    BALANCE_FILTERS, EMPTY_TRANSFER_FILTER, FEE_STATUSES, balanceFilterCounts, balanceFromWire, barSegments, filterTransfers, fmtDay, fmtStamp,
    matchesBalanceFilter, nextInQueue, owedWords, pageSelectionState, peopleLabel, pruneSelection, queueOf, queueWarnings, recorderKind,
    personRowOfWire, selectAllCapped, selectPage, statusMeta, toggleId, transferInLocation,
} from "../lib/feePayments";
import { MAX_PARTS } from "../lib/feeSplit";
import { clampPage, pageSlice, queueRoomPx, readPageSize, revealWhole, scrollBoxOf, scrollParentOf, scrollToListTop } from "../lib/paging";
import { foldText, matchesQuery, rawFieldValue } from "../lib/roster";
import { buildFeePaymentsWorkbook, exportFilename } from "../lib/exports";
import { buildXlsx, downloadXlsx } from "../lib/xlsx";
import { usePerms, ReadOnlyNotice } from "./perms";
import { Overlay } from "./Overlay";
import { Pager } from "./RosterBits";
import { BalanceChips, KpiTile, MoneyBar, PayPill, RefText, SegmentedControl, Spinner, StatusPill, factsOf, money } from "./FeeBits";
import { TransferPanel, TransferSheet } from "./TransferSheet";
import { RegisterPaymentSheet, buildPersonOptions } from "./RegisterPaymentSheet";
import { PersonSheet } from "./PersonSheet";
import { useTx } from "./MealScanner";

/**
 * The review queue's list column on a desktop: 32 % of the section, between 17rem and 380 px. At its
 * narrowest (the 860 px section of a 1280 px window beside the admin sidebar) the payment beside it keeps
 * ~560 px — room for «Devolver… · Rechazar… · Validar y siguiente» on ONE row of its pinned bar. A fixed
 * 380 px list left it 456 px: the bar wrapped to two rows and covered the payment under its header.
 */
export const QUEUE_LIST_COLUMN = 'clamp(17rem, 32%, 380px)';

/**
 * «Pagos» on a desktop. 2.18.0 live round: at 1280 px beside the sidebar the old table reserved 58.5rem of
 * fixed columns in an 844 px card — «Personas» got 0 px, «PERSONAS» was drawn over «MÉTODO» and the ⋮ was cut
 * at the card's edge. Now the CARD is a size container and the columns come in TIERS: # · Personas · Total ·
 * Estado · ⋮ always; Fecha and Método from tier 1; Localidad and Referencia from tier 2 (each tier only when
 * «Personas» keeps TRANSFER_PEOPLE_MIN_REM). A column that does not fit folds into the line under the names
 * («07/10/2026 · Efectivo · Bogotá · Ref. TRF-1001») — never cut, never drawn under another one. A card too
 * narrow for tier 0 shows the phone list.
 */
export const TRANSFER_COLS: { key: string; rem: number; tier: number }[] = [
    { key: 'id', rem: 4, tier: 0 },
    { key: 'date', rem: 6.75, tier: 1 },
    { key: 'location', rem: 9, tier: 2 },
    { key: 'people', rem: 0, tier: 0 },
    { key: 'method', rem: 7.5, tier: 1 },
    { key: 'reference', rem: 8, tier: 2 },
    { key: 'total', rem: 9, tier: 0 },
    { key: 'status', rem: 9, tier: 0 },
    { key: 'more', rem: 3.5, tier: 0 },
];
/** «Personas» never gets less than this (rem): «Ana P., Luis P. +1» on one line. */
export const TRANSFER_PEOPLE_MIN_REM = 10;
const TRANSFER_TIERS = [0, 1, 2];
/** The narrowest card content (rem) that shows the columns of `tier` with «Personas» at its minimum. */
export const transferTierMinRem = (tier: number): number => TRANSFER_COLS.filter((c) => c.tier <= tier).reduce((s, c) => s + c.rem, 0) + TRANSFER_PEOPLE_MIN_REM;
/** What a card whose content is `px` wide shows: the list, or the table's columns, what «Personas» gets and what folds. */
export function transferTableLayout(px: number): { table: boolean; cols: string[]; folded: string[]; peoplePx: number } {
    const rem = Number(px) / 16;
    let tier = -1;
    for (const t of TRANSFER_TIERS) if (rem >= transferTierMinRem(t)) tier = t;
    if (tier < 0) return { table: false, cols: [], folded: [], peoplePx: 0 };
    const shown = TRANSFER_COLS.filter((c) => c.tier <= tier);
    return {
        table: true, cols: shown.map((c) => c.key), folded: TRANSFER_COLS.filter((c) => c.tier > tier).map((c) => c.key),
        peoplePx: Number(px) - shown.reduce((s, c) => s + c.rem, 0) * 16,
    };
}
/** The container rules of the «Pagos» card (the same thresholds as transferTableLayout). */
export function transferTableCss(): string {
    const below = (rem: number) => `${(rem - 0.01).toFixed(2)}rem`;
    const card = '[data-fees-tcard]';
    const out = [
        `${card} { container: cm-fees-t / inline-size; }`,
        `[data-fees-ttable] { display: none; }`,
        `@media (min-width: 768px) { [data-fees-tlist] { display: none; } [data-fees-ttable] { display: block; } }`,
        `${card} [data-tfold] { display: none; }`,
        `@container cm-fees-t (max-width: ${below(transferTierMinRem(0))}) { ${card} [data-fees-ttable] { display: none; } ${card} [data-fees-tlist] { display: block; } }`,
        `@container cm-fees-t (min-width: ${transferTierMinRem(0)}rem) { ${card} [data-fees-ttable] { display: block; } ${card} [data-fees-tlist] { display: none; } }`,
    ];
    for (const t of TRANSFER_TIERS.slice(1)) {
        const keys = TRANSFER_COLS.filter((c) => c.tier === t).map((c) => c.key);
        out.push(`@container cm-fees-t (max-width: ${below(transferTierMinRem(t))}) { ${keys.map((k) => `${card} [data-tcol="${k}"]`).join(', ')} { display: none; } ${keys.map((k) => `${card} [data-tfold="${k}"]`).join(', ')} { display: inline; } }`);
    }
    return out.join('\n');
}
const transferColWidth = (key: string) => { const c = TRANSFER_COLS.find((x) => x.key === key); return c && c.rem ? `${c.rem}rem` : undefined; };

/**
 * «Pagos» on a phone (narrow, or short and touch: held sideways): the status chips and the search stay in the page,
 * and Localidad · Forma de pago · Registrado por · Desde · Hasta fold into «Filtros (n)», a sheet with «Quitar
 * filtros» / «Ver resultados» (the roster's RosterFilters pattern). Inline they took ~250 px between the section
 * strip and the first payment: an iPhone SE showed no payment on its first screen (2.18.0 review UX6-9).
 */
export const TRANSFER_FILTERS_PHONE_CSS = `@media (max-width: 639.98px), (max-height: 500px) and (pointer: coarse) {
  [data-fees-tfilters] > [data-tfilter-fold] { display: none; }
  [data-fees-tfilters] > [data-fees-tfilters-btn] { display: inline-flex; }
}`;
/** How many of the folded «Pagos» filters are on («Filtros (n)»). */
export const foldedTransferFilterCount = (tf: { location?: string; method?: string; via?: string; from?: string; to?: string }): number =>
    [tf.location, tf.method, tf.via, tf.from, tf.to].filter((v) => !!v).length;

/**
 * «Resumen › Por localidad» is a table only when its CARD is this wide (rem); else the list of locations. The
 * window said nothing of the room: an iPhone held sideways (844 px) has the admin sidebar open, and the 686 px
 * table sat in a 424 px sideways scroller with «POR VALIDAR» and its amounts cut at the card's edge.
 */
export const FEES_LOC_TABLE_MIN_REM = 46;

/** The facts of a location's phone line («24 inscritos · cuotas $X · validado $Y · $Z por validar · $W a favor»), each whole. */
export function locFacts(r: any): { key: string; fallback: string; vars: Record<string, unknown> }[] {
    const c = (v: unknown) => money(toCents(v));
    const out = [
        { key: 'fees.loc.people', fallback: '{n} inscritos', vars: { n: r.people } },
        { key: 'fees.loc.due', fallback: 'cuotas {amount}', vars: { amount: c(r.due) } },
        { key: 'fees.loc.validated', fallback: 'validado {amount}', vars: { amount: c(r.validated) } },
    ];
    if (toCents(r.pending) > 0) out.push({ key: 'fees.chip.pending', fallback: '{amount} por validar', vars: { amount: c(r.pending) } });
    if (toCents(r.credit) > 0) out.push({ key: 'fees.chip.credit', fallback: '{amount} a favor', vars: { amount: c(r.credit) } });
    return out;
}

/**
 * «Saldos»: the size of the amount under «debe» / «falta» on a phone row. Its box is at most 45 % of the row;
 * a 15-character es-CO amount («$125.000.000,00») ran 7–14 px out of it toward the pill at text-sm.
 */
export const owedAmountCls = (text: string): string => (String(text || '').length > 13 ? 'text-xs' : 'text-sm');

export const FEES_CSS = `
[data-fees-bycard] { container: cm-fees-loc / inline-size; }
[data-fees-desk] { display: none; }
@container cm-fees-loc (min-width: ${FEES_LOC_TABLE_MIN_REM}rem) {
  [data-fees-phone] { display: none; }
  [data-fees-desk] { display: block; }
}
[data-fees-tfilters] { display: grid; gap: 0.5rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr)); }
[data-fees-tfilters] input[type="date"] { min-width: 0; max-width: 100%; }
[data-fees-tfilters-btn] { display: none; }
${TRANSFER_FILTERS_PHONE_CSS}
[data-fees-kpis] { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr)); }
[data-fees-tabs] { position: sticky; top: 0; z-index: 6; }
@media (min-width: 768px) and (min-height: 600px) {
  [data-fees-tabs] { top: -1.5rem; }
}
[data-fees-selbar] { position: sticky; bottom: 0; z-index: 6; padding-bottom: max(0.75rem, env(safe-area-inset-bottom, 0px)); }
[data-fees-master] { display: grid; grid-template-columns: ${QUEUE_LIST_COLUMN} minmax(0, 1fr); gap: 1.5rem; align-items: start; }
[data-fees-master] > [data-fees-queue] { position: sticky; top: 4.5rem; max-height: var(--cm-queue-h, calc(100dvh - 6rem)); overflow-y: auto; overscroll-behavior: contain; padding-right: 0.25rem; }
[data-fees-master] > [data-fees-detail] { position: sticky; top: 4.5rem; max-height: var(--cm-queue-h, calc(100dvh - 6rem)); display: flex; flex-direction: column; overflow: clip; scroll-margin-top: 4.5rem; }
[data-fees-detail] > * { flex: none; }
[data-fees-detail] > [data-transfer-body] { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
[data-fees-detail] [data-transfer-actions] { box-shadow: 0 -8px 16px -12px rgba(15, 23, 42, 0.25); padding-left: 1.25rem; padding-right: 1.25rem; }
[data-fees-detail] [data-transfer-actions] button { padding-left: 0.875rem; padding-right: 0.875rem; }
[data-transfer-tr] td { vertical-align: top; }
[data-queue-facts] > span { white-space: nowrap; }
${transferTableCss()}
${COARSE_FIELDS_CSS('[data-fees-page]')}
`;
/*
 * The review queue on a desktop (D-P21, one receipt at a time): the list on the left and the payment on the
 * right are two columns as tall as the panel's room under the section tabs (--cm-queue-h, measured: queueRoomPx),
 * each scrolling on its own. The payment is its header, its BODY (receipt, split, notes, history — the only
 * part that scrolls) and its action bar («Devolver… / Rechazar… / Validar y siguiente») as the card's last
 * row: always in view, and never over anything — the bar used to be pinned (sticky) over the payment, so at
 * 1280 × 800 a short payment's «Historial» (or its split) sat under it until the panel was scrolled. A payment
 * shown is brought whole into view (revealWhole) and starts at the top of its body. The inline receipt is
 * capped (ProofThumb large: 45vh; «Ver grande» opens it whole).
 */

type Section = 'summary' | 'queue' | 'transfers' | 'balances';
const SECTIONS: Section[] = ['summary', 'queue', 'transfers', 'balances'];
/** sessionStorage text → the remembered state of the section (validated field by field). */
export function parseFeesNav(raw: string | null | undefined) {
    let v: any = null;
    try { v = raw ? JSON.parse(raw) : null; } catch { v = null; }
    const o = v && typeof v === 'object' ? v : {};
    const tf = o.tf && typeof o.tf === 'object' ? o.tf : {};
    return {
        section: SECTIONS.includes(o.section) ? o.section : 'summary',
        tf: {
            ...EMPTY_TRANSFER_FILTER,
            statuses: Array.isArray(tf.statuses) ? tf.statuses.filter((s) => FEE_STATUSES.includes(s)) : [],
            location: typeof tf.location === 'string' && /^(|none|\d+)$/.test(tf.location) ? tf.location : '',
            method: typeof tf.method === 'string' ? tf.method.slice(0, 40) : '',
            via: ['admin', 'portal', 'legacy'].includes(tf.via) ? tf.via : '',
            from: typeof tf.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tf.from) ? tf.from : '',
            to: typeof tf.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tf.to) ? tf.to : '',
            q: typeof tf.q === 'string' ? tf.q.slice(0, 200) : '',
            inscriptionId: Number.isInteger(tf.inscriptionId) && tf.inscriptionId > 0 ? tf.inscriptionId : null,
        },
        bf: BALANCE_FILTERS.some((b) => b.key === o.bf) ? o.bf : 'owing',
        bLocs: Array.isArray(o.bLocs) ? o.bLocs.filter((x) => typeof x === 'string' && /^(none|\d+)$/.test(x)) : [],
        bq: typeof o.bq === 'string' ? o.bq.slice(0, 200) : '',
    };
}

/** The review queue is master-detail when the SECTION (not the window) is this wide: 380 px list + a payment. */
export const MASTER_DETAIL_MIN_PX = 860;
/**
 * true while the element is at least `px` wide (false outside a browser). The panel beside the admin sidebar
 * is ~650 px on a 1024 px window: the window's width says nothing about the room the queue really has.
 */
function useWideBox(el: HTMLElement | null, px = MASTER_DETAIL_MIN_PX) {
    const [wide, setWide] = useState(false);
    useEffect(() => {
        if (!el) return undefined;
        const measure = () => setWide(el.getBoundingClientRect().width >= px);
        measure();
        let ro: any = null;
        try { ro = new ResizeObserver(measure); ro.observe(el); } catch { window.addEventListener('resize', measure); }
        return () => { if (ro) ro.disconnect(); else window.removeEventListener('resize', measure); };
    }, [px, el]);
    return wide;
}

const chipCls = (on: boolean) => `min-h-[44px] px-3.5 rounded-xl border-2 text-[11px] font-black uppercase tracking-widest inline-flex items-center gap-1.5 whitespace-nowrap ${on ? 'border-blue-600 bg-blue-50 text-blue-800' : 'border-gray-100 bg-white text-gray-700 hover:border-gray-300'}`;
const selectCls = 'min-h-[44px] w-full border-2 border-gray-100 rounded-xl px-3 bg-white focus:border-blue-500 outline-none text-base sm:text-sm font-bold text-gray-800';
const card = 'bg-white rounded-3xl border border-gray-100 shadow-sm';

/**
 * `initial` ({ view, fields, locations, section, bq? }): data already in hand — the page draws it at once
 * (no spinner) and still reloads it; it also lets a server render draw every section (`bq`: the «Saldos»
 * search to start with).
 */
export default function FeePaymentsPage({ conferenceId, slug, focus, onFocusConsumed, onOpenAccounting, initial = null }: any) {
    const tx = useTx();
    const { addToast } = useToast();
    const perms = usePerms();
    const canManage = perms.can('payments', 'manage');
    const canExcel = perms.can('reports');
    const canSeeCodes = perms.can('inscriptions');
    const navKey = `cm:fees:${conferenceId}`;
    const [nav, setNav] = useState(() => {
        let base;
        try { base = parseFeesNav(sessionStorage.getItem(navKey)); } catch { base = parseFeesNav(null); }
        if (!initial || !initial.section) return base;
        return { ...base, section: initial.section, ...(typeof initial.bq === 'string' ? { bq: initial.bq.slice(0, 200) } : {}) };
    });
    useEffect(() => { try { sessionStorage.setItem(navKey, JSON.stringify(nav)); } catch { /* blocked */ } }, [nav, navKey]);
    const section: Section = nav.section;
    const setSection = (s: Section) => setNav((n) => ({ ...n, section: s }));

    const [view, setView] = useState<any>(initial ? initial.view : null);
    const [fields, setFields] = useState<any[]>(initial?.fields || []);
    const [locations, setLocations] = useState<any[]>(initial?.locations || []);
    const [loading, setLoading] = useState(!initial);
    const [loadErr, setLoadErr] = useState('');
    const size = useMemo(() => readPageSize(), []);
    const [tPage, setTPage] = useState(1);
    const [bPage, setBPage] = useState(1);
    // A page change brings its list's top into view (lib/paging.ts scrollToListTop).
    const tTopRef = useRef<HTMLParagraphElement | null>(null);
    const bTopRef = useRef<HTMLDivElement | null>(null);
    const detailRef = useRef<HTMLDivElement | null>(null);
    const masterRef = useRef<HTMLDivElement | null>(null);
    const lastShown = useRef<number | null>(null);
    const goTPage = (p: number) => { setTPage(p); scrollToListTop(tTopRef.current); };
    const goBPage = (p: number) => { setBPage(p); scrollToListTop(bTopRef.current); };
    const [selected, setSelected] = useState<number[]>([]);
    const [qLoc, setQLoc] = useState('');
    const [qMethod, setQMethod] = useState('');
    const [queueId, setQueueId] = useState<number | null>(null);
    const [transferOpen, setTransferOpen] = useState<{ id: number; queue: boolean } | null>(null);
    const [register, setRegister] = useState<{ ids: number[] } | null>(null);
    const [feeEdit, setFeeEdit] = useState<{ mode: 'edit' | 'duplicate'; transfer: any } | null>(null);
    const [personId, setPersonId] = useState<number | null>(null);
    // «Pagos» on a phone: its folded filters' sheet (TRANSFER_FILTERS_PHONE_CSS).
    const [tfSheet, setTfSheet] = useState(false);
    const [paymentsKey, setPaymentsKey] = useState(0);
    const [detailKey, setDetailKey] = useState(0);
    const [confirmState, setConfirmState] = useState<any>(null);
    // The desktop review queue says what an action did ABOVE the list (aria-live), not in a toast: the toast at
    // the bottom right covered «Rechazar…» and «Validar y siguiente» of the pinned bar for its seconds on screen.
    const [queueNotice, setQueueNotice] = useState<{ text: string; type: string; n: number } | null>(null);
    useEffect(() => {
        if (!queueNotice) return undefined;
        const h = setTimeout(() => setQueueNotice((cur) => (cur && cur.n === queueNotice.n ? null : cur)), queueNotice.type === 'error' ? 10000 : 6000);
        return () => clearTimeout(h);
    }, [queueNotice]);
    const sayInQueue = (text: string, type = 'info') => setQueueNotice((cur) => ({ text, type, n: (cur ? cur.n : 0) + 1 }));
    const confirm = (message: string, label = 'Confirmar', danger = false) => new Promise<boolean>((resolve) => setConfirmState({ message, label, danger, resolve }));
    const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
    const wide = useWideBox(rootEl);
    // The person sheet: with Inscripciones › ver the person's whole row (form answers, room, notes) is read
    // for that ONE person; without it the sheet shows only what this section knows (`brief`).
    const canRoster = perms.can('inscriptions');
    const [fullPerson, setFullPerson] = useState<any>(null);
    useEffect(() => {
        if (personId == null || !canRoster) { setFullPerson(null); return undefined; }
        let alive = true;
        conferenceApi.getInscription(personId).then((r) => { if (alive) setFullPerson(r || null); }, () => { if (alive) setFullPerson(null); });
        return () => { alive = false; };
    }, [personId, paymentsKey, canRoster]);

    const loadAll = async () => {
        setLoadErr('');
        try {
            // Who each person is comes WITH the view (people[]: name, location, family group, status; reg_code
            // for inscriptions:view) — the section never reads the roster (D-P20: Pagos › ver alone may not).
            const [v, f, l] = await Promise.all([
                feePaymentsApi.getView(conferenceId),
                conferenceApi.getFields(conferenceId).catch(() => []),
                conferenceApi.getLocations(conferenceId).catch(() => null),
            ]);
            setView(v); setFields(f || []); setLocations(l?.locations || []);
        } catch (e: any) { setLoadErr(e?.message || 'Error'); }
        finally { setLoading(false); }
    };
    useEffect(() => { if (!initial) setLoading(true); loadAll(); }, [conferenceId]);
    /** After an action: the section's data — its people (names and money) included. `ids` are kept for the callers. */
    const refresh = async (_ids: number[] = []) => {
        setPaymentsKey((k) => k + 1);
        try {
            const v = await feePaymentsApi.getView(conferenceId);
            setView(v);
            return v;
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); return null; }
    };

    // A door from elsewhere (the dashboard card, «Ver sus pagos» of a person) — consumed once.
    useEffect(() => {
        if (!focus) return;
        setNav((n) => ({ ...n, section: focus.section || n.section, tf: focus.inscriptionId ? { ...EMPTY_TRANSFER_FILTER, inscriptionId: Number(focus.inscriptionId) } : n.tf }));
        setTPage(1);
        if (onFocusConsumed) onFocusConsumed();
    }, [focus]);

    // The section's people as rows (lib/feePayments.ts personRowOfWire): who they are and their money — nothing
    // else of the roster. The names are the server's (the same rule as the payment sheet's «Reparto»).
    const rowById = useMemo(() => new Map((view?.people || []).map((w) => [Number(w.id), personRowOfWire(w)])), [view]);
    const roster = useMemo(() => [...rowById.values()], [rowById]);
    const nameOf = (id: number) => rowById.get(Number(id))?.name || `#${id}`;
    const locName = (lid: number | null) => (lid == null ? tx('no.location', 'Sin localidad') : (locations.find((l) => Number(l.id) === Number(lid))?.name || `#${lid}`));
    const balances = useMemo(() => new Map((view?.people || []).map((p) => [Number(p.id), balanceFromWire(p)])), [view]);
    const people = view?.people || [];
    const transfers = view?.transfers || [];
    const queueAll = useMemo(() => queueOf(transfers), [transfers]);
    const queue = useMemo(() => queueAll.filter((t) => transferInLocation(t, qLoc) && (!qMethod || t.method === qMethod)), [queueAll, qLoc, qMethod]);
    useEffect(() => { if (wide && section === 'queue' && (queueId == null || !queue.some((t) => t.id === queueId))) setQueueId(queue[0]?.id ?? null); }, [wide, section, queue]);
    // The next payment of the queue opens at its top (its header and receipt), not where the last one was
    // scrolled to — moving the panel only (lib/paging.ts scrollToListTop; its scroll margin clears the tabs).
    useEffect(() => {
        const el = detailRef.current;
        if (!wide || queueId == null || !el || typeof el.getBoundingClientRect !== 'function') return;
        const sc = scrollParentOf(el);
        if (el.getBoundingClientRect().top < (sc ? sc.getBoundingClientRect().top : 0)) scrollToListTop(el, undefined, { instant: true });
    }, [queueId]);

    // The queue's two columns are as tall as the panel's room under the sticky section tabs (FEES_CSS).
    const hasQueue = queue.length > 0;
    useEffect(() => {
        const m = masterRef.current;
        if (!wide || section !== 'queue' || !m || typeof window === 'undefined') return undefined;
        const sc = scrollBoxOf(m);
        const measure = () => {
            let room;
            if (sc) {
                const cs = window.getComputedStyle(sc);
                room = queueRoomPx({ clientHeight: sc.clientHeight, padTop: parseFloat(cs.paddingTop) || 0, padBottom: parseFloat(cs.paddingBottom) || 0 });
            } else room = queueRoomPx({ clientHeight: window.innerHeight, padTop: 0, padBottom: 16 });
            m.style.setProperty('--cm-queue-h', `${room}px`);
        };
        measure();
        let ro: any = null;
        try { ro = new ResizeObserver(measure); if (sc) ro.observe(sc); } catch { /* old browser */ }
        window.addEventListener('resize', measure);
        return () => { if (ro) ro.disconnect(); window.removeEventListener('resize', measure); };
    }, [wide, section, hasQueue]);
    /** A payment drawn in the queue: a new one starts at the top of its body; the card comes whole into view. */
    const onQueueShown = (t) => {
        const el = detailRef.current;
        if (!el) return;
        if (lastShown.current !== t.id) {
            lastShown.current = t.id;
            const body = el.querySelector('[data-transfer-body]');
            if (body) body.scrollTop = 0;
        }
        requestAnimationFrame(() => revealWhole(el));
    };

    // ── people options for the register sheet (the server's balances win) ──
    const options = useMemo(() => (register || feeEdit) ? buildPersonOptions(roster, (r) => r.name, locations, balances) : [], [register, feeEdit, roster, locations, balances]);

    // ── Saldos ──
    const balanceRows = useMemo(() => {
        const locSet = new Set(nav.bLocs);
        const out = [];
        for (const w of people) {
            const b = balances.get(Number(w.id));
            const row = rowById.get(Number(w.id));
            const key = w.location_id == null ? 'none' : String(w.location_id);
            if (!matchesBalanceFilter(b, nav.bf)) continue;
            if (locSet.size && !locSet.has(key)) continue;
            const name = row ? row.name : `#${w.id}`;
            if (nav.bq && !matchesQuery(foldText(`${name} ${locName(w.location_id)} ${row?.reg_code || ''}`), nav.bq)) continue;
            out.push({ id: Number(w.id), name, b, w, row });
        }
        return out.sort((a, b) => foldText(a.name).localeCompare(foldText(b.name)) || a.id - b.id);
    }, [people, balances, rowById, nav.bf, nav.bLocs, nav.bq, locations]);
    // The count on each «Saldos» chip: the people that chip would show with the chosen locations AND the search
    // (as «Participantes» counts) — «Con saldo (26)» beside three rows found was a promise the list broke.
    const bfCounts = useMemo(() => {
        const locSet = new Set(nav.bLocs);
        return balanceFilterCounts(people.filter((w) => {
            if (locSet.size && !locSet.has(w.location_id == null ? 'none' : String(w.location_id))) return false;
            if (!nav.bq) return true;
            const row = rowById.get(Number(w.id));
            return matchesQuery(foldText(`${row ? row.name : `#${w.id}`} ${locName(w.location_id)} ${row?.reg_code || ''}`), nav.bq);
        }).map((w) => balances.get(Number(w.id))));
    }, [people, balances, nav.bLocs, nav.bq, rowById, locations]);
    const payableIds = useMemo(() => new Set(people.filter((p) => p.payable).map((p) => Number(p.id))), [people]);
    useEffect(() => { setSelected((s) => pruneSelection(s, payableIds)); }, [payableIds]);
    const selectedOwedC = selected.reduce((s, id) => s + (balances.get(id)?.toCover || 0), 0);

    // ── Pagos ──
    const tFiltered = useMemo(() => filterTransfers(transfers, nav.tf, nameOf), [transfers, nav.tf, rowById]);
    const setTf = (patch) => { setNav((n) => ({ ...n, tf: { ...n.tf, ...patch } })); setTPage(1); };

    const segOptions = [
        { key: 'summary', label: tx('fees.section.summary', 'Resumen') },
        { key: 'queue', label: tx('fees.section.queue', 'Por validar'), badge: view?.counts?.pending || null },
        { key: 'transfers', label: tx('fees.section.transfers', 'Pagos'), badge: null },
        { key: 'balances', label: tx('fees.section.balances', 'Saldos') },
    ];
    const excel = () => {
        try {
            const sheets = buildFeePaymentsWorkbook({ transfers, people, nameOf, locationName: (lid) => (lid == null ? '' : locName(lid)) });
            downloadXlsx(buildXlsx(sheets), exportFilename('pagos-de-cuotas', slug));
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
    };

    /** A payment changed (validated, returned, …): reload and, in the queue, move on to the next one. */
    const onTransferChanged = async ({ action, id, ids }, fromQueue: boolean) => {
        const before = queue;
        const v = await refresh(ids || []);
        setDetailKey((k) => k + 1);
        if (!v) return;
        const after = queueOf(v.transfers || []);
        const moved = action === 'validate' || action === 'return' || action === 'reject' || action === 'remove';
        if (fromQueue && moved) {
            const next = nextInQueue(before, after, id);
            if (wide) {
                setQueueId(next);
                // The last one decided: the focus goes to «No hay pagos por validar», never to <body> (the
                // next payment, when there is one, takes it itself: TransferPanel).
                if (!next) requestAnimationFrame(() => { const el = rootEl && rootEl.querySelector('[data-queue-empty]'); if (el && typeof (el as any).focus === 'function') (el as any).focus({ preventScroll: true }); });
            }
            else {
                setTransferOpen(next ? { id: next, queue: true } : null);
                // The sheet said what was done in its header; it closes now, so the end of the queue is a toast.
                if (!next) addToast(tx('fees.queue.empty', 'No hay pagos por validar.'), 'success');
            }
        } else if (action === 'remove') setTransferOpen(null);
    };
    const openEdit = (mode: 'edit' | 'duplicate', tr) => { setTransferOpen(null); setFeeEdit({ mode, transfer: tr }); };

    if (loading) return <Spinner label={tx('loading', 'Cargando...')} />;
    if (loadErr || !view) {
        return (
            <div role="alert" className="rounded-2xl border-2 border-rose-200 bg-rose-50 px-4 py-4 text-sm font-bold text-rose-700 flex flex-wrap items-center gap-3">
                <span className="flex-1">{loadErr || 'Error'}</span>
                <button type="button" onClick={() => { setLoading(true); loadAll(); }} className="min-h-[44px] px-4 rounded-xl bg-white border-2 border-rose-200 text-xs font-black uppercase tracking-widest">{tx('staff.retry', 'Reintentar')}</button>
            </div>
        );
    }

    const s = view.summary || {};
    // «A favor» (validated money beyond what is owed: a person cancelled after paying, a fee lowered later)
    // gets its column in «Por localidad» whenever the conference has any, so the total is attributed.
    const anyCredit = toCents(s.credit) > 0 || (view.by_location || []).some((r) => toCents(r.credit) > 0);
    const balanceList = [...balances.values()];
    const seg = barSegments(balanceList);
    const methods = view.methods && view.methods.length ? view.methods : [...PAYMENT_METHODS];
    const fullRow = fullPerson && Number(fullPerson.id) === personId ? fullPerson : null;
    const personRow = personId != null ? (fullRow || rowById.get(personId) || null) : null;
    // The payable members of a person's family group (the person sheet's «Pago de su grupo familiar (n)»).
    const familyOf = (row) => {
        const fam = String(row && rawFieldValue(row, 'family_group') || '').trim();
        if (!fam) return [];
        return roster.filter((r) => String(rawFieldValue(r, 'family_group') || '').trim() === fam && payableIds.has(Number(r.id))).map((r) => Number(r.id));
    };

    // ── render pieces ──
    const transferRowPhone = (t) => (
        <li key={t.id}>
            <button type="button" onClick={() => setTransferOpen({ id: t.id, queue: false })} className="w-full text-left px-3 py-3 flex items-center gap-3 hover:bg-blue-50/40 rounded-xl min-h-[64px]" data-transfer-row={t.id}>
                <span className="min-w-0 flex-1 space-y-1">
                    {/* Facts with their own leading «·» (factsOf): a line breaks between them, never after a «·» (UX6-3). */}
                    <span className="flex flex-wrap items-center gap-2"><span className="flex flex-wrap gap-x-1 text-sm font-black text-gray-900" data-transfer-head="">{factsOf([<span className="tabular-nums">{money(toCents(t.amount))}</span>, t.method])}</span><StatusPill status={t.status} /></span>
                    <span className="flex flex-wrap gap-x-1 text-[11px] font-bold text-gray-600" data-transfer-facts="">{factsOf([peopleLabel(t.allocations, nameOf), t.mixed ? tx('fees.location.mixed', 'Varias localidades') : (t.location || locName(t.location_id)), fmtDay(t.paid_on)], null, { long: true })}</span>
                    {/* Two lines, broken between words (the sheet has the whole note) — never one line cut mid-word. */}
                    {(t.status === 'returned' || t.status === 'rejected') && t.review_note && <span className="block text-[11px] font-bold text-orange-800 line-clamp-2 break-words" data-transfer-note="">«{t.review_note}»</span>}
                </span>
                <i className="fa-solid fa-ellipsis-vertical text-gray-500 w-11 text-center shrink-0" aria-hidden="true"></i>
            </button>
        </li>
    );
    const queueCard = (t, active: boolean, onPick) => {
        const warn = queueWarnings(t, (id) => balances.get(id));
        const by = recorderKind(t) === 'portal' ? tx('fees.by.portal.short', 'Portal') : recorderKind(t) === 'legacy' ? tx('fees.by.legacy', 'el sistema anterior') : (t.recorded_by || tx('fees.by.admin', 'Administración'));
        return (
            <li key={t.id}>
                <button type="button" onClick={onPick} aria-current={active ? 'true' : undefined} data-queue-item={t.id}
                    className={`w-full text-left rounded-2xl border-2 px-4 py-3 space-y-1 ${active ? 'border-blue-500 bg-blue-50/40' : 'border-gray-100 bg-white hover:border-gray-300'}`}>
                    {/* Each fact whole: a line breaks BETWEEN them, never inside «1 persona» or an amount (at 1280 px
                        the card read «#9 · Transferencia · $50,00 · 1» / «persona»). */}
                    {/* Each «·» starts the fact after it: a wrap never leaves «$250.000,00 ·» / «1 persona» (UX6-3). */}
                    <span className="flex flex-wrap gap-x-1 text-sm font-black text-gray-900" data-queue-facts="">
                        <span>#{t.id}</span><span>· {t.method}</span><span className="tabular-nums">· {money(toCents(t.amount))}</span>
                        <span>· {t.people === 1 ? tx('fees.people.count.one', '{n} persona', { n: 1 }) : tx('fees.people.count', '{n} personas', { n: t.people })}</span>
                    </span>
                    <span className="flex flex-wrap gap-x-1 text-[11px] font-bold text-gray-600" data-queue-meta="">{factsOf([t.mixed ? tx('fees.location.mixed', 'Varias localidades') : (t.location || locName(t.location_id)), tx('fees.queue.recorded', 'registrado {at} por {who}', { at: fmtStamp(t.submitted_at || t.created_at).replace(' ', '\u00a0'), who: by })], t.reference ? tx('fees.ref', 'Ref. {ref}', { ref: t.reference }) : null, { long: true })}</span>
                    <span className="block text-[11px] font-bold text-gray-500 truncate">{peopleLabel(t.allocations, nameOf, 3)}</span>
                    {warn.length > 0 && (
                        <span className="flex flex-wrap gap-1 pt-0.5">
                            {warn.includes('cancelled') && <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-800 text-[10px] font-black">{tx('fees.flag.cancelled', 'Persona cancelada')}</span>}
                            {warn.includes('over') && <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-800 text-[10px] font-black">{tx('fees.flag.over.short', 'Supera lo que debe')}</span>}
                            {warn.includes('reference') && <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 text-[10px] font-black">{tx('fees.flag.reference', 'Referencia repetida')}</span>}
                        </span>
                    )}
                </button>
            </li>
        );
    };

    const locOptions = [...locations.map((l) => ({ key: String(l.id), name: l.name })), { key: 'none', name: tx('no.location', 'Sin localidad') }];
    // «Pagos»: the filters a phone folds into «Filtros (n)» (inline from 640 px, in its sheet below).
    const tfFolded = foldedTransferFilterCount(nav.tf);
    const tfFields = [
        { key: 'location', el: (
            <select aria-label={tx('location', 'Localidad')} value={nav.tf.location} onChange={(e) => setTf({ location: e.target.value })} className={selectCls}>
                <option value="">{tx('all.locations', 'Todas las localidades')}</option>
                {locOptions.map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
            </select>) },
        { key: 'method', el: (
            <select aria-label={tx('payment.method', 'Forma de pago')} value={nav.tf.method} onChange={(e) => setTf({ method: e.target.value })} className={selectCls}>
                <option value="">{tx('fees.filter.method.all', 'Todas las formas de pago')}</option>
                {methods.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>) },
        { key: 'via', el: (
            <select aria-label={tx('fees.filter.via', 'Registrado por')} value={nav.tf.via} onChange={(e) => setTf({ via: e.target.value })} className={selectCls}>
                <option value="">{tx('fees.filter.via.all', 'Registrado por: todos')}</option>
                <option value="portal">{tx('fees.by.portal.short', 'Portal')}</option>
                <option value="admin">{tx('fees.by.admin', 'Administración')}</option>
                <option value="legacy">{tx('fees.filter.via.legacy', 'Sistema anterior')}</option>
            </select>) },
        { key: 'from', el: <label className="flex items-center gap-2 min-w-0"><span className="text-[10px] font-black uppercase tracking-widest text-gray-500 w-14 shrink-0">{tx('accounting.from', 'Desde')}</span><input type="date" value={nav.tf.from} onChange={(e) => setTf({ from: e.target.value })} className={`${selectCls} min-w-0 flex-1`} /></label> },
        { key: 'to', el: <label className="flex items-center gap-2 min-w-0"><span className="text-[10px] font-black uppercase tracking-widest text-gray-500 w-14 shrink-0">{tx('accounting.to', 'Hasta')}</span><input type="date" value={nav.tf.to} onChange={(e) => setTf({ to: e.target.value })} className={`${selectCls} min-w-0 flex-1`} /></label> },
    ];
    const tSlice = pageSlice(tFiltered, clampPage(tPage, tFiltered.length, size), size);
    const bPageNow = clampPage(bPage, balanceRows.length, size);
    const bSlice = pageSlice(balanceRows, bPageNow, size);
    const pageSelectable = bSlice.filter((r) => payableIds.has(r.id)).map((r) => r.id);
    const pageState = pageSelectionState(pageSelectable, selected);
    const allSelectable = balanceRows.filter((r) => payableIds.has(r.id)).map((r) => r.id);
    const atCap = selected.length >= MAX_PARTS;

    return (
        <div ref={setRootEl} className="space-y-6 pb-4" data-fees-page="">
            <style>{FEES_CSS}</style>
            <ReadOnlyNotice section="payments" />
            {/* Header */}
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                    <h2 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">{tx('fees.title', 'Pagos de cuotas')}</h2>
                    <p className="text-xs sm:text-sm text-gray-500 font-medium max-w-xl">{tx('fees.subtitle', 'Cada pago es un comprobante repartido entre las personas que cubre. El transporte se paga en «Transporte».')}</p>
                </div>
                <div className="flex flex-wrap gap-2 w-full sm:w-auto">
                    {canManage && <button type="button" onClick={() => setRegister({ ids: [] })} className="flex-1 sm:flex-none min-h-[48px] px-6 rounded-2xl bg-emerald-600 text-white hover:bg-emerald-700 font-black text-[11px] uppercase tracking-widest shadow-lg shadow-emerald-500/30" data-act="register-empty"><i className="fa-solid fa-plus mr-1.5" aria-hidden="true"></i>{tx('fees.register', 'Registrar pago')}</button>}
                    {canExcel && <button type="button" onClick={excel} className="min-h-[48px] px-5 rounded-2xl bg-white border-2 border-gray-100 text-emerald-700 hover:border-emerald-500 font-black text-[11px] uppercase tracking-widest"><i className="fa-solid fa-file-excel mr-1.5" aria-hidden="true"></i>Excel</button>}
                    {onOpenAccounting && <button type="button" onClick={onOpenAccounting} className="min-h-[48px] px-5 rounded-2xl bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400 font-black text-[11px] uppercase tracking-widest" data-act="accounting"><i className="fa-solid fa-scale-balanced mr-1.5" aria-hidden="true"></i>{tx('accounting', 'Contabilidad')}</button>}
                </div>
            </div>

            <div data-fees-tabs="" data-cm-seg-box="" className="bg-white py-1">
                <SegmentedControl label={tx('fees.title', 'Pagos de cuotas')} value={section} onChange={setSection} options={segOptions} />
            </div>

            {/* ── Resumen ── */}
            {section === 'summary' && (
                <div className="space-y-6" data-fees-section="summary">
                    <div data-fees-kpis="">
                        <KpiTile kpi="due" label={tx('fees.kpi.due', 'Cuotas')} value={money(toCents(s.due))} icon="fa-file-invoice-dollar" />
                        <KpiTile kpi="validated" label={tx('fees.kpi.validated', 'Validado')} value={money(toCents(s.validated))} icon="fa-circle-check" tone="emerald" />
                        <KpiTile kpi="pending" label={tx('fees.kpi.pending', 'Por validar')} value={money(toCents(s.pending))} icon="fa-clock" tone="amber" onClick={() => setSection('queue')} />
                        <KpiTile kpi="returned" label={tx('fees.kpi.returned', 'Devuelto')} value={money(toCents(s.returned))} icon="fa-rotate-left" tone="orange" onClick={() => { setNav((n) => ({ ...n, section: 'transfers', tf: { ...EMPTY_TRANSFER_FILTER, statuses: ['returned'] } })); setTPage(1); }} />
                        <KpiTile kpi="to_cover" label={tx('fees.kpi.to.cover', 'Por cobrar')} value={money(toCents(s.to_cover))} icon="fa-hand-holding-dollar" tone="rose" />
                        {toCents(s.credit) > 0 && <KpiTile kpi="credit" label={tx('fees.kpi.credit', 'A favor')} value={money(toCents(s.credit))} icon="fa-plus" tone="sky" />}
                    </div>
                    <div className={`${card} p-5`}><MoneyBar seg={seg} /></div>
                    <div className={card} data-fees-bycard="">
                        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-2">
                            <h3 className="text-lg font-black text-gray-900 italic tracking-tighter">{tx('fees.by.location', 'Por localidad')}</h3>
                            {/* «3 personas · 1 cancelada»: each count with its noun, the «·» with the count after it (UX6-4 twin). */}
                            <span className="flex flex-wrap justify-end gap-x-1 text-[11px] font-bold text-gray-500" data-loc-people="">{factsOf([(s.people || 0) === 1 ? tx('fees.people.count.one', '{n} persona', { n: 1 }) : tx('fees.people.count', '{n} personas', { n: s.people || 0 }),
                                s.cancelled ? (s.cancelled === 1 ? tx('roster.count.cancelled.one', '1 cancelada') : tx('roster.count.cancelled', '{n} canceladas', { n: s.cancelled })) : null])}</span>
                        </div>
                        <ul data-fees-phone="" className="divide-y divide-gray-100">
                            {(view.by_location || []).map((r) => (
                                <li key={String(r.location_id)}>
                                    <button type="button" onClick={() => { setNav((n) => ({ ...n, section: 'balances', bLocs: [r.location_id == null ? 'none' : String(r.location_id)] })); setBPage(1); }}
                                        className="w-full text-left px-5 py-3 space-y-1 hover:bg-blue-50/40 min-h-[64px]" data-loc-row={String(r.location_id)}>
                                        <span className="flex items-center justify-between gap-2"><span className="text-sm font-black text-gray-900">{r.location || locName(r.location_id)}</span><span className="text-xs font-black text-rose-700">{tx('fees.kpi.to.cover', 'Por cobrar')} {money(toCents(r.to_cover))}</span></span>
                                        {/* Each fact whole, its «·» with it: a line breaks BETWEEN facts, never inside «validado
                                            $1.050,00» nor before a lone «· $580,00 por validar». */}
                                        <span className="flex flex-wrap gap-x-1 text-[11px] font-bold text-gray-600" data-loc-facts="">
                                            {locFacts(r).map((f, i) => <span key={f.key} className="whitespace-nowrap">{i > 0 ? '· ' : ''}{tx(f.key, f.fallback, f.vars)}</span>)}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                        <div data-fees-desk="" className="overflow-x-auto">
                            <table className="w-full text-sm text-left">
                                <thead><tr className="bg-gray-50/60 text-[10px] font-black uppercase tracking-widest text-gray-500">
                                    <th scope="col" className="px-5 py-3">{tx('location', 'Localidad')}</th>
                                    <th scope="col" className="px-3 py-3 text-right">{tx('fees.col.people', 'Inscritos')}</th>
                                    <th scope="col" className="px-3 py-3 text-right">{tx('fees.kpi.due', 'Cuotas')}</th>
                                    <th scope="col" className="px-3 py-3 text-right">{tx('fees.kpi.validated', 'Validado')}</th>
                                    <th scope="col" className="px-3 py-3 text-right">{tx('fees.kpi.pending', 'Por validar')}</th>
                                    <th scope="col" className="px-3 py-3 text-right">{tx('fees.kpi.returned', 'Devuelto')}</th>
                                    <th scope="col" className="px-3 py-3 text-right">{tx('fees.kpi.to.cover', 'Por cobrar')}</th>
                                    {anyCredit && <th scope="col" className="px-3 py-3 text-right" data-col="credit">{tx('fees.kpi.credit', 'A favor')}</th>}
                                    <th scope="col" className="px-5 py-3 w-40"><span className="sr-only">{tx('fees.bar', 'Progreso')}</span></th>
                                </tr></thead>
                                <tbody className="divide-y divide-gray-100">
                                    {(view.by_location || []).map((r) => {
                                        const pct = toCents(r.due) > 0 ? Math.min(100, Math.round((toCents(r.validated) / toCents(r.due)) * 100)) : 0;
                                        return (
                                            <tr key={String(r.location_id)} className="hover:bg-blue-50/30 cursor-pointer" onClick={() => { setNav((n) => ({ ...n, section: 'balances', bLocs: [r.location_id == null ? 'none' : String(r.location_id)] })); setBPage(1); }}>
                                                <td className="px-5 py-3 font-black text-gray-900"><button type="button" className="text-left min-h-[44px] min-w-[44px] w-full" data-loc-open="">{r.location || locName(r.location_id)}</button></td>
                                                <td className="px-3 py-3 text-right font-bold text-gray-700">{r.people}</td>
                                                <td className="px-3 py-3 text-right font-bold text-gray-900 tabular-nums">{money(toCents(r.due))}</td>
                                                <td className="px-3 py-3 text-right font-bold text-emerald-700 tabular-nums">{money(toCents(r.validated))}</td>
                                                <td className="px-3 py-3 text-right font-bold text-amber-800 tabular-nums">{money(toCents(r.pending))}</td>
                                                <td className="px-3 py-3 text-right font-bold text-orange-800 tabular-nums">{money(toCents(r.returned))}</td>
                                                <td className="px-3 py-3 text-right font-black text-rose-700 tabular-nums">{money(toCents(r.to_cover))}</td>
                                                {anyCredit && <td className="px-3 py-3 text-right font-bold text-sky-800 tabular-nums" data-credit={String(r.location_id)}>{money(toCents(r.credit))}</td>}
                                                <td className="px-5 py-3"><div className="h-2 rounded-full bg-gray-100 overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }}></div></div></td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Por validar ── */}
            {section === 'queue' && (
                <div className="space-y-4" data-fees-section="queue">
                    <div className="flex flex-wrap gap-2" data-queue-filters="">
                        <select aria-label={tx('location', 'Localidad')} value={qLoc} onChange={(e) => setQLoc(e.target.value)} className={`${selectCls} sm:w-auto`}>
                            <option value="">{tx('all.locations', 'Todas las localidades')}</option>
                            {locOptions.map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
                        </select>
                        {methods.map((m) => <button key={m} type="button" onClick={() => setQMethod(qMethod === m ? '' : m)} aria-pressed={qMethod === m ? 'true' : 'false'} className={chipCls(qMethod === m)}>{m}</button>)}
                    </div>
                    {wide && queueNotice && (
                        <p role={queueNotice.type === 'error' ? 'alert' : 'status'} data-queue-notice={queueNotice.type}
                            className={`rounded-2xl px-4 py-3 text-sm font-bold flex items-start gap-2 ${queueNotice.type === 'error' ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'}`}>
                            <i className={`fa-solid ${queueNotice.type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-check'} mt-0.5`} aria-hidden="true"></i>
                            <span className="flex-1 min-w-0 break-words">{queueNotice.text}</span>
                        </p>
                    )}
                    {queue.length === 0 ? (
                        <div className={`${card} py-16 text-center space-y-2 outline-none`} tabIndex={-1} data-queue-empty="">
                            <i className="fa-solid fa-circle-check text-3xl text-emerald-500" aria-hidden="true"></i>
                            <p className="text-sm font-black text-gray-800">{tx('fees.queue.empty', 'No hay pagos por validar.')}</p>
                        </div>
                    ) : wide ? (
                        <div ref={masterRef} data-fees-master="">
                            <ul className="space-y-2" aria-label={tx('fees.section.queue', 'Por validar')} data-fees-queue="">
                                {queue.map((t) => queueCard(t, t.id === queueId, () => setQueueId(t.id)))}
                            </ul>
                            <div ref={detailRef} data-fees-detail="" className={card}>
                                {/* The payment opens whole and at the top of its body (onQueueShown); its bar is its last row. */}
                                {queueId != null && <TransferPanel id={queueId} inline queue canManage={canManage} confirm={confirm} reloadKey={detailKey} locationName={locName}
                                    notify={sayInQueue} onShown={onQueueShown}
                                    onChanged={(c) => onTransferChanged(c, true)} onEdit={(tr) => openEdit('edit', tr)} onDuplicate={(tr) => openEdit('duplicate', tr)} />}
                            </div>
                        </div>
                    ) : (
                        <ul className="space-y-2">{queue.map((t) => queueCard(t, false, () => setTransferOpen({ id: t.id, queue: true })))}</ul>
                    )}
                </div>
            )}

            {/* ── Pagos ── */}
            {section === 'transfers' && (
                <div className="space-y-4" data-fees-section="transfers">
                    <div className="flex flex-wrap gap-2" data-transfer-statuses="">
                        {FEE_STATUSES.map((st) => {
                            const on = nav.tf.statuses.includes(st);
                            const m = statusMeta(st);
                            return <button key={st} type="button" aria-pressed={on ? 'true' : 'false'} className={chipCls(on)} onClick={() => setTf({ statuses: on ? nav.tf.statuses.filter((x) => x !== st) : [...nav.tf.statuses, st] })}>
                                <i className={`fa-solid ${m.icon}`} aria-hidden="true"></i>{tx(m.key, m.fallback)} ({view.counts?.[st] ?? 0})</button>;
                        })}
                    </div>
                    <div data-fees-tfilters="">
                        <input type="search" value={nav.tf.q} onChange={(e) => setTf({ q: e.target.value })} placeholder={tx('fees.transfers.search', 'Referencia, #número o persona')} aria-label={tx('fees.transfers.search', 'Referencia, #número o persona')} className={selectCls} />
                        {/* A phone: the other filters in a sheet (TRANSFER_FILTERS_PHONE_CSS); from 640 px they are inline. */}
                        <button type="button" onClick={() => setTfSheet(true)} aria-haspopup="dialog" className={`${chipCls(tfFolded > 0)} justify-center`} data-fees-tfilters-btn="">
                            <i className="fa-solid fa-sliders" aria-hidden="true"></i>{tfFolded ? tx('roster.filters.n', 'Filtros ({n})', { n: tfFolded }) : tx('roster.filters', 'Filtros')}
                        </button>
                        {tfFields.map((f) => <React.Fragment key={f.key}>{React.cloneElement(f.el, { 'data-tfilter-fold': '' })}</React.Fragment>)}
                    </div>
                    {tfSheet && (
                        <Overlay layer={LAYER.sheet} onBackdrop={() => setTfSheet(false)} onEscape={() => setTfSheet(false)}>
                            <div role="dialog" aria-modal="true" aria-labelledby="cm-fees-tfilters-title" className="bg-white rounded-[32px] shadow-2xl w-full max-w-lg border border-gray-100 overflow-hidden" data-fees-tfilters-sheet="">
                                <div className="bg-gray-50/50 px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-3">
                                    <h3 id="cm-fees-tfilters-title" className="font-black text-xl text-gray-900 italic tracking-tighter">{tx('roster.filters', 'Filtros')}</h3>
                                    <button type="button" onClick={() => setTfSheet(false)} aria-label={tx('close', 'Cerrar')} className="w-11 h-11 shrink-0 flex items-center justify-center rounded-2xl text-gray-500 hover:bg-gray-100"><i className="fa-solid fa-xmark text-xl" aria-hidden="true"></i></button>
                                </div>
                                <div className="px-5 py-5 space-y-3">{tfFields.map((f) => <React.Fragment key={f.key}>{f.el}</React.Fragment>)}</div>
                                <div className="px-5 py-4 border-t border-gray-100 flex justify-between gap-2" data-cm-sheet-foot="">
                                    <button type="button" onClick={() => setTf({ location: '', method: '', via: '', from: '', to: '' })} className="min-h-[44px] px-4 text-xs font-black uppercase tracking-widest text-gray-600">{tx('accounting.clear.filters', 'Quitar filtros')}</button>
                                    <button type="button" onClick={() => setTfSheet(false)} className="min-h-[44px] px-6 rounded-2xl bg-blue-600 text-white font-black text-xs uppercase tracking-widest">{tx('roster.filters.apply', 'Ver resultados')}</button>
                                </div>
                            </div>
                        </Overlay>
                    )}
                    {nav.tf.inscriptionId != null && (
                        <button type="button" onClick={() => setTf({ inscriptionId: null })} className={chipCls(true)} data-person-filter={nav.tf.inscriptionId}>
                            {tx('fees.filter.person', 'Pagos de {name}', { name: nameOf(nav.tf.inscriptionId) })}<i className="fa-solid fa-xmark" aria-hidden="true"></i>
                        </button>
                    )}
                    <p ref={tTopRef} className="text-[11px] font-black uppercase tracking-widest text-gray-500 scroll-mt-24" aria-live="polite">{tx('fees.transfers.count', '{n} pagos', { n: tFiltered.length })}</p>
                    {tFiltered.length === 0 ? (
                        <div className={`${card} py-16 text-center`} data-transfers-empty=""><p className="text-sm font-bold text-gray-600">{transfers.length ? tx('fees.transfers.none.match', 'Ningún pago coincide con los filtros.') : tx('fees.transfers.none', 'Aún no hay pagos registrados.')}</p></div>
                    ) : (
                        <div className={`${card} px-2 py-2`} data-fees-tcard="">
                            <ul data-fees-tlist="" className="divide-y divide-gray-100">{tSlice.map(transferRowPhone)}</ul>
                            <div data-fees-ttable="">
                                {/* Widths on the header cells (a fixed table takes them from its first row): a hidden
                                    column (transferTableCss) then really goes, and «Personas» gets the rest. */}
                                <table className="w-full text-sm text-left" style={{ tableLayout: 'fixed' }}>
                                    <thead><tr className="text-[10px] font-black uppercase tracking-widest text-gray-500">
                                        <th scope="col" data-tcol="id" style={{ width: transferColWidth('id') }} className="px-3 py-3">#</th>
                                        <th scope="col" data-tcol="date" style={{ width: transferColWidth('date') }} className="px-3 py-3">{tx('accounting.date', 'Fecha')}</th>
                                        <th scope="col" data-tcol="location" style={{ width: transferColWidth('location') }} className="px-3 py-3">{tx('location', 'Localidad')}</th>
                                        <th scope="col" data-tcol="people" className="px-3 py-3">{tx('fees.col.people.names', 'Personas')}</th>
                                        <th scope="col" data-tcol="method" style={{ width: transferColWidth('method') }} className="px-3 py-3">{tx('fees.col.method', 'Método')}</th>
                                        <th scope="col" data-tcol="reference" style={{ width: transferColWidth('reference') }} className="px-3 py-3">{tx('fees.register.reference', 'Referencia')}</th>
                                        <th scope="col" data-tcol="total" style={{ width: transferColWidth('total') }} className="px-3 py-3 text-right">{tx('fees.col.total', 'Total')}</th>
                                        <th scope="col" data-tcol="status" style={{ width: transferColWidth('status') }} className="px-2 py-3">{tx('fees.col.status', 'Estado')}</th>
                                        <th scope="col" data-tcol="more" style={{ width: transferColWidth('more') }}><span className="sr-only">{tx('actions', 'Acciones')}</span></th>
                                    </tr></thead>
                                    <tbody className="divide-y divide-gray-100">
                                        {tSlice.map((t) => (
                                            <tr key={t.id} className="hover:bg-blue-50/30" data-transfer-tr={t.id}>
                                                <td data-tcol="id" className="px-3 py-2.5 font-black text-gray-700">{t.id}</td>
                                                <td data-tcol="date" className="px-3 py-2.5 text-xs font-bold text-gray-700 whitespace-nowrap">{fmtDay(t.paid_on)}</td>
                                                <td data-tcol="location" className="px-3 py-2.5 text-xs font-bold text-gray-700 break-words">{t.mixed ? tx('fees.location.mixed', 'Varias localidades') : (t.location || locName(t.location_id))}</td>
                                                <td data-tcol="people" className="px-3 py-2.5">
                                                    <span className="block text-xs font-bold text-gray-900 break-words">{peopleLabel(t.allocations, nameOf)}</span>
                                                    {/* What the hidden columns would say (transferTableCss shows each one when its column goes). */}
                                                    <span className="mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] font-bold text-gray-600" data-tfolds="">
                                                        <span data-tfold="date"><i className="fa-regular fa-calendar mr-1" aria-hidden="true"></i>{fmtDay(t.paid_on)}</span>
                                                        <span data-tfold="method">{t.method}</span>
                                                        <span data-tfold="location"><i className="fa-solid fa-location-dot mr-1" aria-hidden="true"></i>{t.mixed ? tx('fees.location.mixed', 'Varias localidades') : (t.location || locName(t.location_id))}</span>
                                                        {t.reference && <span data-tfold="reference"><RefText>{tx('fees.ref', 'Ref. {ref}', { ref: t.reference })}</RefText></span>}
                                                    </span>
                                                </td>
                                                <td data-tcol="method" className="px-3 py-2.5 text-xs font-bold text-gray-700 break-words">{t.method}</td>
                                                <td data-tcol="reference" className="px-3 py-2.5 text-xs font-mono text-gray-700">{t.reference ? <RefText>{t.reference}</RefText> : '—'}</td>
                                                <td data-tcol="total" className="px-3 py-2.5 text-right font-black text-gray-900 tabular-nums whitespace-nowrap">{money(toCents(t.amount))}</td>
                                                <td data-tcol="status" className="px-2 py-2.5"><StatusPill status={t.status} /></td>
                                                <td data-tcol="more" className="px-1 py-1.5 text-right">
                                                    <button type="button" onClick={() => setTransferOpen({ id: t.id, queue: false })} aria-label={tx('fees.transfer.open', 'Abrir el pago #{id}', { id: t.id })} aria-haspopup="dialog"
                                                        className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-xl text-gray-500 hover:bg-gray-100"><i className="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i></button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <div className="px-2"><Pager page={clampPage(tPage, tFiltered.length, size)} size={size} total={tFiltered.length} onPage={goTPage} /></div>
                        </div>
                    )}
                </div>
            )}

            {/* ── Saldos ── */}
            {section === 'balances' && (
                <div className="space-y-4" data-fees-section="balances">
                    {/* Wrapped, never a sideways strip: on a phone every filter stays in sight, each with its count. */}
                    <div className="flex flex-wrap gap-2" data-balance-filters="">
                        {BALANCE_FILTERS.map((f) => <button key={f.key} type="button" aria-pressed={nav.bf === f.key ? 'true' : 'false'} className={chipCls(nav.bf === f.key)} onClick={() => { setNav((n) => ({ ...n, bf: f.key })); setBPage(1); }} data-balance-filter={f.key}>{tx(f.label, f.fallback)} ({bfCounts[f.key]})</button>)}
                    </div>
                    <div className="flex flex-wrap gap-2" data-balance-locations="">
                        {locOptions.map((o) => {
                            const on = nav.bLocs.includes(o.key);
                            return <button key={o.key} type="button" aria-pressed={on ? 'true' : 'false'} className={chipCls(on)} onClick={() => { setNav((n) => ({ ...n, bLocs: on ? n.bLocs.filter((k) => k !== o.key) : [...n.bLocs, o.key] })); setBPage(1); }}>{o.name}</button>;
                        })}
                    </div>
                    <input type="search" value={nav.bq} onChange={(e) => { setNav((n) => ({ ...n, bq: e.target.value })); setBPage(1); }} placeholder={tx('fees.balances.search', 'Buscar persona')} aria-label={tx('fees.balances.search', 'Buscar persona')} className={selectCls} />
                    {balanceRows.length === 0 ? (
                        <div className={`${card} py-16 text-center space-y-2`} data-balances-empty="">
                            {nav.bf === 'owing' && !nav.bq && !nav.bLocs.length
                                ? <><i className="fa-solid fa-circle-check text-3xl text-emerald-500" aria-hidden="true"></i><p className="text-sm font-black text-gray-800">{tx('fees.balances.all.paid', 'Todos al día.')}</p></>
                                : <p className="text-sm font-bold text-gray-600">{tx('fees.balances.none', 'Nadie coincide con los filtros.')}</p>}
                        </div>
                    ) : (
                        <div ref={bTopRef} className={`${card} px-2 py-2 scroll-mt-24`}>
                            {canManage && (
                                <div className="flex flex-wrap items-center gap-3 px-2 py-2 border-b border-gray-100">
                                    <label className="inline-flex items-center gap-3 min-h-[44px] min-w-[44px] cursor-pointer">
                                        <input type="checkbox" className="w-5 h-5 accent-blue-600" checked={pageState === 'all'} disabled={!pageSelectable.length}
                                            ref={(el) => { if (el) el.indeterminate = pageState === 'some'; }}
                                            onChange={() => setSelected((sel) => selectPage(sel, pageSelectable))} aria-label={tx('fees.select.page', 'Seleccionar esta página')} data-select-page="" />
                                        <span className="text-xs font-black uppercase tracking-widest text-gray-600">{tx('fees.select.page', 'Seleccionar esta página')}</span>
                                    </label>
                                    {allSelectable.length > pageSelectable.length && selected.length < Math.min(MAX_PARTS, allSelectable.length) && (
                                        <button type="button" onClick={() => setSelected(selectAllCapped(allSelectable))} className="min-h-[44px] px-3 text-xs font-black text-blue-700 underline" data-select-all="">
                                            {tx('fees.select.all', 'Seleccionar los {n}', { n: Math.min(MAX_PARTS, allSelectable.length) })}
                                        </button>
                                    )}
                                    {allSelectable.length > MAX_PARTS && <span className="text-[11px] font-bold text-gray-500">{tx('fees.select.cap', 'Máximo {n} personas por pago.', { n: MAX_PARTS })}</span>}
                                </div>
                            )}
                            <ul className="divide-y divide-gray-100" data-balance-list="">
                                {pageSlice(balanceRows, bPageNow, size).map((r) => {
                                    const sel = selected.includes(r.id);
                                    const selectable = payableIds.has(r.id);
                                    // At the 200-person cap an unticked box cannot take one more: it says so (the bar's line).
                                    const capped = selectable && !sel && atCap;
                                    return (
                                        <li key={r.id} className="flex items-center gap-1" data-balance-row={r.id}>
                                            {canManage && (
                                                <label className={`shrink-0 w-11 h-11 flex items-center justify-center rounded-xl ${selectable && !capped ? 'cursor-pointer hover:bg-blue-50' : 'opacity-30'}`}>
                                                    <input type="checkbox" className="w-5 h-5 accent-blue-600" checked={sel} disabled={!selectable || capped}
                                                        onChange={() => setSelected((s2) => toggleId(s2, r.id))} aria-label={tx('fees.select.person', 'Seleccionar a {name}', { name: r.name })}
                                                        aria-describedby={capped ? 'cm-fees-selcap' : undefined} data-capped={capped ? '' : undefined} />
                                                </label>
                                            )}
                                            <button type="button" onClick={() => setPersonId(r.id)} className="min-w-0 flex-1 text-left px-2 py-3 flex items-center gap-3 hover:bg-blue-50/40 rounded-xl min-h-[64px]" aria-haspopup="dialog">
                                                <span className="min-w-0 flex-1 space-y-1">
                                                    <span className={`block text-sm font-black text-gray-900 break-words ${r.b.cancelled ? 'line-through text-gray-500' : ''}`}>{r.name}</span>
                                                    <span className="flex flex-wrap items-center gap-2 text-[11px] font-bold text-gray-600">
                                                        {!r.b.cancelled && <PayPill state={r.b.state} />}
                                                        <span>{locName(r.w.location_id)}</span>
                                                        {!r.b.cancelled && <span className="tabular-nums">{money(r.b.validated)} / {money(r.b.due)}</span>}
                                                    </span>
                                                    <BalanceChips balance={r.b} />
                                                </span>
                                                {/* The word over the amount (owedWords: «debe», or «falta» beside the «por validar»
                                                    chip), the amount whole: a narrow phone row gives the name column the
                                                    rest, so its «Sin pagar» pill never runs into «falta $250.000,00». */}
                                                <span className="max-w-[45%] text-right" data-balance-owed="">
                                                    {(() => {
                                                        const ow = owedWords(r.b.toCover, r.b.pending);
                                                        if (ow) return <><span className="block text-[10px] font-black uppercase tracking-widest text-rose-700">{tx(ow.word.key, ow.word.fallback)}</span><span className={`block ${owedAmountCls(money(ow.cents))} font-black text-rose-700 tabular-nums whitespace-nowrap`} data-owed-amount="">{money(ow.cents)}</span></>;
                                                        return !r.b.cancelled && r.b.due > 0 ? <span className="block text-xs font-black text-emerald-700">{r.b.pending > 0 ? tx('fees.balances.covered', 'cubierto') : tx('fees.pill.paid', 'Pagado')}</span> : null;
                                                    })()}
                                                </span>
                                                <i className="fa-solid fa-ellipsis-vertical text-gray-500 w-6 text-center shrink-0" aria-hidden="true"></i>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                            <div className="px-2"><Pager page={bPageNow} size={size} total={balanceRows.length} onPage={goBPage} /></div>
                        </div>
                    )}
                    {canManage && selected.length > 0 && (
                        <div data-fees-selbar="" className="bg-white border-2 border-blue-100 rounded-2xl shadow-2xl px-4 pt-3 flex flex-wrap items-center gap-3">
                            <span className="text-sm font-black text-gray-900 flex-1 min-w-[10rem]">{tx('fees.selbar', '{n} seleccionadas · {amount} por cobrar', { n: selected.length, amount: money(selectedOwedC) })}</span>
                            {atCap && <span id="cm-fees-selcap" role="status" className="basis-full text-xs font-bold text-amber-800" data-selbar-cap="">{tx('fees.select.cap.reached', 'Máximo {n} personas por pago: quita a alguien para añadir a otra.', { n: MAX_PARTS })}</span>}
                            <button type="button" onClick={() => setSelected([])} className="min-h-[44px] px-3 text-xs font-black uppercase tracking-widest text-gray-600">{tx('fees.selbar.clear', 'Limpiar')}</button>
                            <button type="button" onClick={() => setRegister({ ids: selected })} className="min-h-[44px] px-5 rounded-2xl bg-emerald-600 text-white font-black text-[11px] uppercase tracking-widest" data-act="register-selected">
                                {tx('fees.register.n', 'Registrar pago ({n})', { n: selected.length })}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* ── layers ── */}
            {transferOpen && (
                <TransferSheet id={transferOpen.id} queue={transferOpen.queue} canManage={canManage} confirm={confirm} reloadKey={detailKey} locationName={locName}
                    returnFocus={transferOpen.queue ? '[data-queue-item], [data-queue-empty]' : undefined}
                    onClose={() => setTransferOpen(null)} onChanged={(c) => onTransferChanged(c, transferOpen.queue)}
                    onEdit={(tr) => openEdit('edit', tr)} onDuplicate={(tr) => openEdit('duplicate', tr)} />
            )}
            {register && (
                <RegisterPaymentSheet mode="create" conferenceId={conferenceId} options={options} locations={locations} ids={register.ids} methods={methods}
                    confirm={confirm} onClose={() => setRegister(null)} onStale={() => refresh([])}
                    onSaved={({ ids }) => { setRegister(null); setSelected([]); refresh(ids); }} />
            )}
            {feeEdit && (
                <RegisterPaymentSheet mode={feeEdit.mode} conferenceId={conferenceId} options={options} locations={locations} transfer={feeEdit.transfer} methods={methods}
                    confirm={confirm} onClose={() => setFeeEdit(null)} onStale={() => refresh([])} notify={wide && section === 'queue' ? sayInQueue : null}
                    onSaved={({ id, ids }) => { setFeeEdit(null); refresh(ids).then(() => { setDetailKey((k) => k + 1); if (id && !(wide && section === 'queue')) setTransferOpen({ id, queue: false }); else if (id) setQueueId(id); }); }} />
            )}
            {personRow && (
                <PersonSheet person={personRow} brief={!fullRow} fields={fields} locations={locations} nameOf={(r) => nameOf(r.id)}
                    canManage={false} canSeeCodes={canSeeCodes} canPayView canPayManage={canManage} canAssign={false} paymentsKey={paymentsKey} focusPay={false}
                    familyIds={familyOf(personRow)} onClose={() => setPersonId(null)}
                    onSeePayments={(p) => { setPersonId(null); setNav((n) => ({ ...n, section: 'transfers', tf: { ...EMPTY_TRANSFER_FILTER, inscriptionId: Number(p.id) } })); setTPage(1); }}
                    onRegister={canManage ? (ids) => { setPersonId(null); setRegister({ ids }); } : undefined}
                    onOpenTransfer={(id) => setTransferOpen({ id, queue: false })} />
            )}
            {confirmState && (
                <Overlay layer={LAYER.confirm} onEscape={() => { confirmState.resolve(false); setConfirmState(null); }}>
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden" role="alertdialog" aria-modal="true"
                        aria-label={tx('confirm.title', 'Confirmar')} aria-describedby="cm-fees-confirm-msg">
                        <div className="p-6"><p id="cm-fees-confirm-msg" className="text-gray-800 font-medium leading-relaxed">{confirmState.message}</p></div>
                        <div className="px-6 py-4 bg-gray-50/50 border-t border-gray-100 flex justify-end gap-3">
                            <button type="button" onClick={() => { confirmState.resolve(false); setConfirmState(null); }} className="min-h-[44px] px-5 text-gray-600 font-bold hover:bg-gray-100 rounded-xl">{tx('cancel', 'Cancelar')}</button>
                            <button type="button" onClick={() => { confirmState.resolve(true); setConfirmState(null); }} className={`min-h-[44px] px-5 text-white font-bold rounded-xl ${confirmState.danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-blue-600 hover:bg-blue-700'}`}>{confirmState.label}</button>
                        </div>
                    </div>
                </Overlay>
            )}
        </div>
    );
}
