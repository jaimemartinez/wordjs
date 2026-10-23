// @ts-nocheck
"use client";

/**
 * Accounting (2.12.0) — income and expenses of a conference.
 *
 * Manual entries are created, edited and deleted here. The money the plugin already receives — validated
 * fee payments and transport payments — appears automatically as read-only income (it is managed where it
 * belongs: the inscription's payments, the ticket's payments), so the balance is complete without
 * entering anything twice.
 *
 * Staff roles (2.15.0): Contabilidad › ver reads the ledger; › gestionar creates / edits / deletes the
 * manual entries. The Excel file is a «Reportes» permission. Administrators see everything.
 *
 * 2.18.0 («Pagos de cuotas», D-P14..D-P16): a fee line is ONE payment as the bank shows it («Pago de cuotas ·
 * 3 personas»), dated by its payment date; a shared one expands to list each person's part, and its lock
 * opens the payment itself (with Pagos › ver). A location filter keeps each payment's share of that
 * location's people (lib/accounting.ts locationShare): the figures, the lines and the Excel of a location are
 * its own money, and the locations add up to the whole. The Excel file adds «Detalle de cuotas», one row per
 * person. A line that is a fee payment says «Pago de cuotas» as its origin (its section's name). The tab stays apart from «Pagos de cuotas»
 * (other permission; it also holds expenses and transport) and links to it.
 *
 * Layout (LEDGER_CSS): the page and the «Movimientos» card are size containers, so the screen follows the
 * room the panel really has — not the window (at 1280 px beside the sidebar an `xl:` 2/3 card squeezed the
 * table, clipped «Monto» to «M» and the amount to «+$50…»). «Por categoría» sits beside the movements only
 * when the page is 75rem wide; the table drops Categoría and Forma de pago into each line's description below
 * 60rem, and below 40rem each movement is a block (date and amount, then the description with its actions
 * beside it — no row of its own with a lone lock under a tall gap) — never a sideways scroll. The filters wrap
 * at 9rem each.
 *
 * A read-only line that cannot be opened here says WHERE it is managed, in words, in its description
 * («🔒 Se gestiona en Transporte» / «… en Pagos de cuotas», readonlyNote) — it used to be a faint lock with a
 * hover-only title, unreadable on a phone and out of line with the fee lines' 44 px lock buttons. A fee line that
 * CAN be opened says so in words too («🧾 Ver pago #27»): the padlock means «read-only» two lines above.
 *
 * The Ingresos / Egresos / Balance totals follow the room of the header card (LEDGER_CSS `data-ledger-totals`),
 * not the window: three side by side only while each tile holds 12rem, and each figure on ONE line, shrinking to
 * fit its tile (kpiValueFit). The window's `sm:grid-cols-3` put three 67 px tiles in the panel of an iPhone held
 * sideways (the admin sidebar takes the rest): «$1.880,00» ran from Ingresos into Egresos.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { conferenceApi, PAYMENT_METHODS, fmtMoney } from "../lib/conference";
import { DateField } from "../lib/DateField";
import { paymentMethodLabel, switchLabel } from "../lib/labels";
import { buildXlsx, downloadXlsx } from "../lib/xlsx";
import { displayName, exportFilename } from "../lib/exports";
import { feeLineTitle, filterLedger, summarizeLedger, buildLedgerWorkbook, ledgerDay, linePeople } from "../lib/accounting";
import { usePerms, ReadOnlyNotice } from "./perms";
import { Overlay } from "./Overlay";
import { canAutoFocus, LAYER } from "../lib/overlay";
import { peopleLabel } from "../lib/feePayments";
import { TransferSheet } from "./TransferSheet";
import { useTx } from "./MealScanner";
import { factsOf, kpiValueFit } from "./FeeBits";

const money = (n: unknown) => { const v = Number(n) || 0; return (v < 0 ? '-$' : '$') + fmtMoney(Math.abs(v)); };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// The line's local calendar day (lib/accounting.ts ledgerDay: a server stamp is UTC) — the day the Excel writes too.
const fmtDay = (v?: string | null) => {
    const s = String(v || '');
    const m = ledgerDay(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
};
const inputCls = 'w-full min-h-[44px] border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-base sm:text-sm';

export const LEDGER_CSS = `
[data-ledger-page] { container: cm-ledger / inline-size; }
[data-ledger-totals] { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); }
[data-ledger-total] { container-type: inline-size; min-width: 0; }
[data-ledger-filters] { display: grid; gap: 0.75rem; align-items: end; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); }
[data-ledger-filters] [data-ledger-search] { grid-column: 1 / -1; }
[data-ledger-filters] [data-ledger-clear] { grid-column: 1 / -1; justify-self: end; }
@container cm-ledger (min-width: 36rem) {
  [data-ledger-filters] [data-ledger-search] { grid-column: span 2; }
}
[data-ledger-grid] { display: grid; gap: 1.5rem; grid-template-columns: minmax(0, 1fr); align-items: start; }
@container cm-ledger (min-width: 75rem) {
  [data-ledger-grid] { grid-template-columns: minmax(0, 1fr) 22rem; }
}
[data-ledger-movements] { container: cm-ledger-moves / inline-size; }
[data-ledger-inline-meta] { display: none; }
@container cm-ledger-moves (max-width: 59.99rem) {
  [data-ledger-table] [data-cell="category"], [data-ledger-table] [data-cell="method"] { display: none; }
  [data-ledger-inline-meta] { display: flex; flex-wrap: wrap; column-gap: 0.25rem; }
}
@container cm-ledger-moves (max-width: 39.99rem) {
  [data-ledger-table], [data-ledger-table] tbody { display: block; width: 100%; }
  [data-ledger-table] thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  [data-ledger-table] tr[data-ledger-line] { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 0.75rem; row-gap: 0.25rem; padding: 0.75rem 1rem; }
  [data-ledger-table] tr[data-ledger-line] > td { padding: 0; }
  [data-ledger-table] [data-cell="date"] { grid-column: 1; grid-row: 1; align-self: center; }
  [data-ledger-table] [data-cell="amount"] { grid-column: 2; grid-row: 1; }
  [data-ledger-table] [data-cell="desc"] { grid-column: 1 / -1; grid-row: 2; }
  [data-ledger-table] tr[data-ledger-line]:has(> [data-cell="actions"]:not(:empty)) > [data-cell="desc"] { grid-column: 1; }
  [data-ledger-table] [data-cell="actions"] { grid-column: 2; grid-row: 2; align-self: start; }
  [data-ledger-table] [data-cell="actions"]:empty { display: none; }
}
`;
const labelCls = 'block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1';

/**
 * Where a read-only line is managed, when it cannot be opened from here: a transport payment in «Transporte»,
 * a fee payment (for a role without Pagos › ver, or a line not linked to a payment) in «Pagos de cuotas».
 * Null for a manual entry and for a fee line whose lock opens the payment.
 */
export function readonlyNote(e: { readonly?: boolean; source?: string; transfer_id?: number | null }, canSeePayment: boolean): { key: string; fallback: string } | null {
    if (!e || !e.readonly) return null;
    if (e.source === 'transport') return { key: 'accounting.readonly.transport', fallback: 'Se gestiona en Transporte' };
    if (e.source === 'inscription' && !(e.transfer_id != null && canSeePayment)) return { key: 'accounting.readonly.fees', fallback: 'Se gestiona en Pagos de cuotas' };
    return null;
}

export default function AccountingPage({ conferenceId, slug, onOpenFees }: { conferenceId: number; slug?: string; onOpenFees?: () => void }) {
    const { t } = useI18n();
    const tx = useTx();
    const { addToast } = useToast();
    const perms = usePerms();
    const canManage = perms.can('accounting', 'manage');
    const canExcel = perms.can('reports');
    // The payment behind a fee line opens with Pagos › ver (validate / void it with Pagos › gestionar).
    const canSeePayment = perms.can('payments');
    const canManagePayment = perms.can('payments', 'manage');
    const [openTransfer, setOpenTransfer] = useState<number | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [locations, setLocations] = useState<any[]>([]);
    const [data, setData] = useState<any>({ entries: [], totals: { income: 0, expense: 0, balance: 0 }, categories: { income: [], expense: [] } });
    const [people, setPeople] = useState<any[]>([]);
    const [fields, setFields] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [filter, setFilter] = useState({ from: '', to: '', kind: '', category: '', source: '', search: '', location: '' });
    const [form, setForm] = useState<any>(null); // { id?, kind, date, category, description, amount, method, reference }
    const [confirmState, setConfirmState] = useState<{ text: string; onOk: () => void } | null>(null);

    const load = async () => {
        try {
            // The ledger is this page; attendees / fields only name the payers, so a role that may not read
            // them still gets the ledger (those rows then show «#id»).
            const [d, p, f, l] = await Promise.all([conferenceApi.getLedger(conferenceId), conferenceApi.getInscriptions(conferenceId).catch(() => []), conferenceApi.getFields(conferenceId).catch(() => []), conferenceApi.getLocations(conferenceId).catch(() => null)]);
            setData(d); setPeople(p || []); setFields(f || []); setLocations(l?.locations || []);
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setLoading(false); }
    };
    useEffect(() => { setLoading(true); load(); }, [conferenceId]);

    const names = useMemo(() => new Map(people.map((p: any) => [Number(p.id), displayName(p, fields)])), [people, fields]);
    const locationOf = useMemo(() => new Map(people.map((p: any) => [Number(p.id), p.location_id == null ? null : Number(p.location_id)])), [people]);
    const locationNameOf = useMemo(() => {
        const ln = new Map(locations.map((l: any) => [Number(l.id), l.name]));
        return new Map(people.map((p: any) => [Number(p.id), p.location_id != null ? (ln.get(Number(p.location_id)) || p.location || '') : (p.location || '')]));
    }, [people, locations]);
    const rows = useMemo(() => filterLedger(data.entries || [], filter as any, names, locationOf), [data, filter, names, locationOf]);
    const summary = useMemo(() => summarizeLedger(rows), [rows]);
    const allCategories = useMemo(() => [...new Set([...(data.categories?.income || []), ...(data.categories?.expense || []), ...(data.entries || []).map((e: any) => e.category).filter(Boolean)])].sort(), [data]);
    const filtered = Object.values(filter).some(Boolean);

    const openNew = (kind: 'income' | 'expense') => setForm({ kind, date: today(), category: '', description: '', amount: '', method: '', reference: '' });
    const openEdit = (e: any) => setForm({ id: e.id, kind: e.kind, date: String(e.date || '').slice(0, 10), category: e.category || '', description: e.description || '', amount: String(e.amount), method: e.method || '', reference: e.reference || '' });
    const save = async () => {
        setBusy(true);
        try {
            const body = { kind: form.kind, date: form.date, category: form.category, description: form.description, amount: Number(form.amount), method: form.method || null, reference: form.reference };
            if (form.id) await conferenceApi.updateLedgerEntry(form.id, body);
            else await conferenceApi.createLedgerEntry(conferenceId, body);
            addToast(form.id ? (t('accounting.saved') || 'Movimiento actualizado') : (t('accounting.created') || 'Movimiento registrado'), 'success');
            setForm(null);
            await load();
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setBusy(false); }
    };
    const remove = (e: any) => setConfirmState({
        text: (t('accounting.confirm.delete') || '¿Eliminar «{description}» ({amount})?').replace('{description}', e.description).replace('{amount}', money(e.amount)),
        onOk: async () => {
            setBusy(true);
            try { await conferenceApi.deleteLedgerEntry(e.id); addToast(t('accounting.deleted') || 'Movimiento eliminado', 'success'); await load(); }
            catch (err: any) { addToast(err?.message || 'Error', 'error'); }
            finally { setBusy(false); }
        },
    });
    const excel = () => {
        try { downloadXlsx(buildXlsx(buildLedgerWorkbook(rows as any, names, locationNameOf)), exportFilename('contabilidad', slug)); }
        catch (e: any) { addToast(e?.message || 'Error', 'error'); }
    };

    if (loading) {
        return (
            <div className="text-center py-20">
                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t('loading') || 'Cargando…'}</p>
            </div>
        );
    }

    const sourceLabel = (s: string) => s === 'inscription' ? (t('accounting.source.inscription') || 'Pago de inscripción') : s === 'transport' ? (t('accounting.source.transport') || 'Pago de transporte') : (t('accounting.source.manual') || 'Manual');
    // A fee line that is a payment of «Pagos de cuotas» says «Pago de cuotas» — ONE payment, the same words
    // as its description and as the Excel «Origen» column (lib/accounting.ts sourceLabelOf).
    const lineSource = (e: any) => (e.source === 'inscription' && e.transfer_id != null ? tx('accounting.source.fee', 'Pago de cuotas') : sourceLabel(e.source));
    const locNameById = (id: number) => (locations.find((l: any) => Number(l.id) === Number(id))?.name || null);
    const formCategories = form ? (data.categories?.[form.kind] || []) : [];
    return (
        <div className="space-y-8 animate-in fade-in duration-500" data-ledger-page="">
            <style>{LEDGER_CSS}</style>
            <ReadOnlyNotice section="accounting" />
            {/* Header */}
            <div className="relative overflow-hidden bg-white rounded-3xl p-8 border border-gray-100 shadow-xl shadow-gray-100/50">
                <div className="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 bg-emerald-50/60 rounded-full blur-3xl pointer-events-none"></div>
                <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                    <div>
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 shrink-0 rounded-xl bg-emerald-600 flex items-center justify-center text-white shadow-lg shadow-emerald-200"><i className="fa-solid fa-scale-balanced"></i></div>
                            <span className="text-[10px] font-bold text-emerald-600 uppercase tracking-[0.2em]">{t('accounting') || 'Contabilidad'}</span>
                        </div>
                        <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter">{t('accounting.title') || 'Ingresos y egresos'}</h2>
                        <p className="text-xs text-gray-500 mt-1 max-w-xl">{t('accounting.subtitle') || 'Los pagos de inscripción validados y los pagos de transporte entran solos como ingresos; aquí registras todo lo demás.'}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {onOpenFees && <button type="button" onClick={onOpenFees} className="px-6 py-4 rounded-2xl bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400 font-black text-[10px] uppercase tracking-widest transition-all" data-act="open-fees"><i className="fa-solid fa-file-invoice-dollar mr-1.5"></i>{tx('fees.title', 'Pagos de cuotas')}</button>}
                        {canExcel && <button onClick={excel} disabled={!rows.length} className="px-6 py-4 rounded-2xl bg-white border-2 border-gray-100 text-emerald-700 hover:border-emerald-500 font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50"><i className="fa-solid fa-file-excel mr-1.5"></i>{t('accounting.excel') || 'Excel'}</button>}
                        {canManage && <button onClick={() => openNew('expense')} className="px-6 py-4 rounded-2xl bg-rose-600 text-white hover:bg-rose-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-rose-500/30 transition-all active:scale-95"><i className="fa-solid fa-minus mr-1.5"></i>{t('accounting.new.expense') || 'Nuevo egreso'}</button>}
                        {canManage && <button onClick={() => openNew('income')} className="px-6 py-4 rounded-2xl bg-emerald-600 text-white hover:bg-emerald-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-emerald-500/30 transition-all active:scale-95"><i className="fa-solid fa-plus mr-1.5"></i>{t('accounting.new.income') || 'Nuevo ingreso'}</button>}
                    </div>
                </div>
                <div className="relative mt-6" data-ledger-totals="">
                    {[[t('accounting.income') || 'Ingresos', summary.income, 'text-emerald-600', 'fa-arrow-trend-up'], [t('accounting.expense') || 'Egresos', summary.expense, 'text-rose-600', 'fa-arrow-trend-down'], [t('accounting.balance') || 'Balance', summary.balance, summary.balance < 0 ? 'text-rose-600' : 'text-gray-900', 'fa-scale-balanced']].map(([label, value, cls, icon]: any) => {
                        const fit = kpiValueFit(money(value), 1.5);
                        return (
                            <div key={label} className="bg-gray-50/80 px-5 py-4 rounded-2xl border border-gray-100" data-ledger-total="">
                                <div className="text-[9px] font-black text-gray-400 uppercase tracking-widest"><i className={`fa-solid ${icon} mr-1`}></i>{label}{filtered ? ` · ${t('accounting.filtered') || 'filtrado'}` : ''}</div>
                                <div className={`font-black italic tracking-tighter mt-1 ${fit.className} ${cls}`} style={fit.style} data-ledger-total-value="">{money(value)}</div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Filters */}
            <div className="bg-white rounded-3xl border border-gray-100 shadow-sm p-5" data-ledger-filters="">
                <div className="space-y-1"><label htmlFor="acc-from" className={labelCls}>{t('accounting.from') || 'Desde'}</label><DateField id="acc-from" value={filter.from} max={filter.to || undefined} onChange={v => setFilter({ ...filter, from: v })} /></div>
                <div className="space-y-1"><label htmlFor="acc-to" className={labelCls}>{t('accounting.to') || 'Hasta'}</label><DateField id="acc-to" value={filter.to} min={filter.from || undefined} onChange={v => setFilter({ ...filter, to: v })} /></div>
                <div className="space-y-1"><label htmlFor="acc-kind" className={labelCls}>{t('accounting.kind') || 'Tipo'}</label>
                    <select id="acc-kind" className={inputCls} value={filter.kind} onChange={e => setFilter({ ...filter, kind: e.target.value })}>
                        <option value="">{t('excel.filter.all') || 'Todas'}</option><option value="income">{t('accounting.income') || 'Ingresos'}</option><option value="expense">{t('accounting.expense') || 'Egresos'}</option>
                    </select></div>
                <div className="space-y-1"><label htmlFor="acc-cat" className={labelCls}>{t('accounting.category') || 'Categoría'}</label>
                    <select id="acc-cat" className={inputCls} value={filter.category} onChange={e => setFilter({ ...filter, category: e.target.value })}>
                        <option value="">{t('excel.filter.all') || 'Todas'}</option>{allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                    </select></div>
                <div className="space-y-1"><label htmlFor="acc-src" className={labelCls}>{t('accounting.source') || 'Origen'}</label>
                    <select id="acc-src" className={inputCls} value={filter.source} onChange={e => setFilter({ ...filter, source: e.target.value })}>
                        <option value="">{t('excel.filter.all') || 'Todas'}</option><option value="manual">{sourceLabel('manual')}</option><option value="inscription">{sourceLabel('inscription')}</option><option value="transport">{sourceLabel('transport')}</option>
                    </select></div>
                <div className="space-y-1"><label htmlFor="acc-loc" className={labelCls}>{tx('location', 'Localidad')}</label>
                    <select id="acc-loc" className={inputCls} value={filter.location} onChange={e => setFilter({ ...filter, location: e.target.value })}>
                        <option value="">{t('excel.filter.all') || 'Todas'}</option>{locations.map((l: any) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}<option value="none">{tx('no.location', 'Sin localidad')}</option>
                    </select></div>
                <div className="space-y-1" data-ledger-search=""><label htmlFor="acc-q" className={labelCls}>{t('accounting.search') || 'Buscar'}</label><input id="acc-q" className={inputCls} value={filter.search} onChange={e => setFilter({ ...filter, search: e.target.value })} placeholder={t('accounting.search.placeholder') || 'Descripción, referencia, participante…'} /></div>
                {filtered && <button onClick={() => setFilter({ from: '', to: '', kind: '', category: '', source: '', search: '', location: '' })} className="min-h-[44px] text-[10px] font-black uppercase tracking-widest text-gray-500 hover:text-gray-700 px-3" data-ledger-clear=""><i className="fa-solid fa-xmark mr-1"></i>{t('accounting.clear.filters') || 'Quitar filtros'}</button>}
            </div>

            <div data-ledger-grid="">
                {/* Movements */}
                <div className="min-w-0 bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-100/30 overflow-hidden" data-ledger-movements="">
                    <div className="px-6 py-5 border-b border-gray-50 flex items-center justify-between">
                        <h3 className="text-xl font-black text-gray-900 italic tracking-tighter">{t('accounting.movements') || 'Movimientos'}</h3>
                        <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{rows.length}</span>
                    </div>
                    {rows.length === 0 ? (
                        <div className="py-16 text-center text-sm text-gray-400 italic">{t('accounting.empty') || 'No hay movimientos.'}</div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left" data-ledger-table="">
                                <thead><tr className="bg-gray-50/50">
                                    {[['date', t('accounting.date') || 'Fecha'], ['desc', t('accounting.description') || 'Descripción'], ['category', t('accounting.category') || 'Categoría'], ['method', tx('payment.method', 'Forma de pago')], ['amount', t('accounting.amount') || 'Monto'], ['actions', '']].map(([cell, h]) => <th key={cell} scope="col" data-cell={cell} className={`px-4 py-4 text-[10px] font-black text-gray-500 uppercase tracking-widest ${cell === 'amount' ? 'text-right whitespace-nowrap' : ''}`}>{h || <span className="sr-only">{tx('actions', 'Acciones')}</span>}</th>)}
                                </tr></thead>
                                <tbody className="divide-y divide-gray-50">
                                    {rows.map((e: any) => {
                                        const who = linePeople(e);
                                        const shared = who.length > 1;
                                        const open = expanded.has(String(e.id));
                                        const toggle = () => setExpanded((s) => { const n = new Set(s); if (n.has(String(e.id))) n.delete(String(e.id)); else n.add(String(e.id)); return n; });
                                        return (
                                        <React.Fragment key={e.id}>
                                        <tr className="hover:bg-blue-50/30 transition-colors group/row" data-ledger-line={e.id}>
                                            <td className="px-4 py-3 whitespace-nowrap text-xs font-bold text-gray-500" data-cell="date">{fmtDay(e.date)}</td>
                                            <td className="px-4 py-3" data-cell="desc">
                                                <div className="font-bold text-gray-900">
                                                    {shared ? (
                                                        <button type="button" onClick={toggle} aria-expanded={open ? 'true' : 'false'} className="text-left inline-flex items-center gap-2 min-h-[44px]" data-ledger-expand="">
                                                            <i className={`fa-solid fa-chevron-${open ? 'up' : 'down'} text-[10px] text-gray-400`} aria-hidden="true"></i>{feeLineTitle(e, tx)}
                                                        </button>
                                                    ) : feeLineTitle(e, tx)}
                                                </div>
                                                {/* The parts of a shared payment, stacked under its description: name · location and the
                                                    amount on the same line, inside this cell — never across the wide row, where on a
                                                    phone the amounts sat off-screen past the table's sideways scroll. */}
                                                {shared && open && (
                                                    <ul className="mt-1.5 mb-1 divide-y divide-gray-100 rounded-xl bg-gray-50/80 px-3" data-ledger-parts={e.id}>
                                                        {(e.allocations || []).map((a: any) => (
                                                            <li key={a.inscription_id} className="py-1.5 flex items-start justify-between gap-3 text-xs" data-ledger-part={a.inscription_id}>
                                                                <span className="min-w-0 font-bold text-gray-800 break-words">{names.get(Number(a.inscription_id)) || `#${a.inscription_id}`}{locationNameOf.get(Number(a.inscription_id)) ? <> <span className="text-gray-500 font-medium whitespace-nowrap" data-part-location="">· {locationNameOf.get(Number(a.inscription_id))}</span></> : null}</span>
                                                                <span className="shrink-0 font-black text-gray-900 tabular-nums">{money(a.amount)}</span>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                                {/* Facts with their own leading «·» (factsOf): on a phone «INSCRIPCIONES ·» / «TRANSFERENCIA» and
                                                    «PAGO DE CUOTAS ·» / «CARLOS G.» broke after the «·» (2.18.0 review UX6-4). */}
                                                <div className="flex flex-wrap gap-x-1 text-[10px] font-bold text-gray-500 uppercase tracking-widest" data-ledger-sub="">
                                                    {factsOf([lineSource(e), shared ? peopleLabel(who.map((id) => ({ inscription_id: id })), (id) => names.get(id) || `#${id}`) : who.length === 1 ? (names.get(who[0]) || '#' + who[0]) : null], e.reference || null, { long: true })}
                                                </div>
                                                {/* Categoría · Forma de pago here when their columns do not fit (LEDGER_CSS). */}
                                                {(e.category || e.method) && <span className="text-xs font-medium text-gray-600" data-ledger-inline-meta="">{factsOf([e.category || null, e.method ? paymentMethodLabel(tx, e.method) : null], null, { long: true })}</span>}
                                                {(() => { const note = readonlyNote(e, canSeePayment); return note ? <span className="mt-0.5 flex items-center gap-1.5 text-[11px] font-bold text-gray-600" data-ledger-readonly={e.source}><i className="fa-solid fa-lock text-gray-500" aria-hidden="true"></i>{tx(note.key, note.fallback)}</span> : null; })()}
                                            </td>
                                            <td className="px-4 py-3 text-xs font-medium text-gray-600 break-words" data-cell="category">{e.category || '—'}</td>
                                            <td className="px-4 py-3 text-xs font-medium text-gray-600 break-words" data-cell="method">{e.method ? paymentMethodLabel(tx, e.method) : '—'}</td>
                                            <td className={`px-4 py-3 text-right font-black whitespace-nowrap ${e.kind === 'income' ? 'text-emerald-600' : 'text-rose-600'}`} data-cell="amount">{e.kind === 'income' ? '+' : '−'}{money(e.amount)}</td>
                                            <td className="px-4 py-3 text-right whitespace-nowrap" data-cell="actions">
                                                {e.readonly && e.transfer_id != null && canSeePayment ? (
                                                    // Says what it does, in words: a padlock means «read-only» (the transport line), not «open».
                                                    <button type="button" onClick={() => setOpenTransfer(Number(e.transfer_id))}
                                                        className="min-h-[44px] min-w-[44px] px-3 shrink-0 inline-flex items-center justify-center gap-1.5 rounded-xl border border-gray-100 bg-white text-[11px] font-black text-blue-700 hover:bg-blue-50 whitespace-nowrap" data-ledger-open={e.transfer_id}>
                                                        <i className="fa-solid fa-receipt text-xs" aria-hidden="true"></i>{tx('fees.transfer.see', 'Ver pago #{id}', { id: e.transfer_id })}
                                                    </button>
                                                ) : !canManage || e.readonly ? null : (
                                                    // Always visible and 44 px: no hover-only control (a phone, a tablet with a mouse,
                                                    // a keyboard user all see them), each named for a screen reader.
                                                    <div className="flex justify-end gap-1.5" data-ledger-actions="">
                                                        <button type="button" onClick={() => openEdit(e)} title={t('edit') || 'Editar'} aria-label={`${t('edit') || 'Editar'}: ${e.description || ''}`} className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl bg-gray-50 text-gray-600 hover:bg-blue-600 hover:text-white transition-all"><i className="fa-solid fa-pen text-xs" aria-hidden="true"></i></button>
                                                        <button type="button" onClick={() => remove(e)} title={t('delete') || 'Eliminar'} aria-label={`${t('delete') || 'Eliminar'}: ${e.description || ''}`} className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl bg-gray-50 text-gray-600 hover:bg-rose-600 hover:text-white transition-all"><i className="fa-solid fa-trash-can text-xs" aria-hidden="true"></i></button>
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                        </React.Fragment>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* By category */}
                <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-100/30 overflow-hidden h-fit">
                    <div className="px-6 py-5 border-b border-gray-50"><h3 className="text-xl font-black text-gray-900 italic tracking-tighter">{t('accounting.by.category') || 'Por categoría'}</h3></div>
                    <div className="divide-y divide-gray-50">
                        {summary.byCategory.length === 0 && <div className="py-10 text-center text-xs text-gray-400 italic">{t('accounting.empty') || 'No hay movimientos.'}</div>}
                        {summary.byCategory.map(c => {
                            const base = c.kind === 'income' ? summary.income : summary.expense;
                            const pct = base ? Math.round((c.total / base) * 100) : 0;
                            return (
                                <div key={c.kind + c.category} className="px-6 py-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-sm font-bold text-gray-800 truncate">{c.category}</span>
                                        <span className={`text-sm font-black whitespace-nowrap ${c.kind === 'income' ? 'text-emerald-600' : 'text-rose-600'}`}>{money(c.total)}</span>
                                    </div>
                                    <div className="flex items-center gap-2 mt-1">
                                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className={`h-full rounded-full ${c.kind === 'income' ? 'bg-emerald-500' : 'bg-rose-500'}`} style={{ width: `${pct}%` }}></div></div>
                                        <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest w-20 text-right">{c.count} · {pct}%</span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* Entry form */}
            {form && canManage && (
                <Overlay layer={2}>
                    <div className="bg-white rounded-[40px] shadow-2xl w-full max-w-lg border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200 max-h-[92vh] flex flex-col" role="dialog" aria-modal="true">
                        <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-start justify-between gap-4 shrink-0">
                            <div>
                                <h3 className={`font-black text-2xl italic tracking-tighter ${form.kind === 'income' ? 'text-emerald-700' : 'text-rose-700'}`}>
                                    {form.id ? (t('accounting.edit') || 'Editar movimiento') : form.kind === 'income' ? (t('accounting.new.income') || 'Nuevo ingreso') : (t('accounting.new.expense') || 'Nuevo egreso')}
                                </h3>
                            </div>
                            <button onClick={() => setForm(null)} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-2xl" aria-label="Cerrar"><i className="fa-solid fa-xmark text-xl"></i></button>
                        </div>
                        <div className="p-8 space-y-4 overflow-y-auto">
                            {form.id && (
                                <div className="grid grid-cols-2 gap-2">
                                    {(['income', 'expense'] as const).map(k => (
                                        <button key={k} type="button" onClick={() => setForm({ ...form, kind: k })} className={`px-4 py-2.5 rounded-xl border-2 font-black text-[10px] uppercase tracking-widest ${form.kind === k ? (k === 'income' ? 'border-emerald-400 bg-emerald-50 text-emerald-700' : 'border-rose-400 bg-rose-50 text-rose-700') : 'border-gray-100 text-gray-400'}`}>{k === 'income' ? (t('accounting.income.one') || 'Ingreso') : (t('accounting.expense.one') || 'Egreso')}</button>
                                    ))}
                                </div>
                            )}
                            <div className="space-y-1.5"><label htmlFor="acc-desc" className={labelCls}>{t('accounting.description') || 'Descripción'} *</label>
                                <input id="acc-desc" className={inputCls} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} autoFocus={canAutoFocus()} /></div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1.5"><label htmlFor="acc-amount" className={labelCls}>{t('accounting.amount') || 'Monto'} *</label>
                                    <input id="acc-amount" type="number" min={0} step="0.01" className={inputCls} value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></div>
                                <div className="space-y-1.5"><label htmlFor="acc-date" className={labelCls}>{t('accounting.date') || 'Fecha'} *</label>
                                    <DateField id="acc-date" value={form.date} clearable={false} onChange={v => setForm({ ...form, date: v })} /></div>
                            </div>
                            <div className="space-y-1.5"><label htmlFor="acc-category" className={labelCls}>{t('accounting.category') || 'Categoría'}</label>
                                <input id="acc-category" list="acc-categories" className={inputCls} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} placeholder={t('accounting.category.placeholder') || 'Elige o escribe una categoría'} />
                                <datalist id="acc-categories">{formCategories.map((c: string) => <option key={c} value={c} />)}</datalist></div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1.5"><label htmlFor="acc-method" className={labelCls}>{tx('payment.method', 'Forma de pago')}</label>
                                    <select id="acc-method" className={inputCls} value={form.method} onChange={e => setForm({ ...form, method: e.target.value })}>
                                        <option value="">—</option>{PAYMENT_METHODS.map(m => <option key={m} value={m}>{paymentMethodLabel(tx, m)}</option>)}
                                    </select></div>
                                <div className="space-y-1.5"><label htmlFor="acc-ref" className={labelCls}>{t('reference') || 'Referencia (opcional)'}</label>
                                    <input id="acc-ref" className={inputCls} value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} /></div>
                            </div>
                        </div>
                        <div className="px-8 py-5 border-t border-gray-50 bg-gray-50/30 flex justify-end gap-3 shrink-0">
                            <button onClick={() => setForm(null)} className="px-6 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">{t('cancel') || 'Cancelar'}</button>
                            <button onClick={save} disabled={busy || !String(form.description).trim() || !(Number(form.amount) > 0) || !form.date} className={`px-8 py-3 text-white rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-lg disabled:opacity-50 ${form.kind === 'income' ? 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-500/30' : 'bg-rose-600 hover:bg-rose-700 shadow-rose-500/30'}`}>{t('save') || 'Guardar'}</button>
                        </div>
                    </div>
                </Overlay>
            )}

            {openTransfer != null && (
                <TransferSheet id={openTransfer} layer={LAYER.modal} canManage={canManagePayment} onClose={() => setOpenTransfer(null)} locationName={locNameById}
                    confirm={(message) => new Promise<boolean>((resolve) => setConfirmState({ text: message, onOk: () => resolve(true), onCancel: () => resolve(false) }))}
                    onChanged={({ action }) => { load(); if (action === 'remove') setOpenTransfer(null); }} />
            )}
            {confirmState && (
                <Overlay layer={4} backdrop="rgba(0,0,0,0.5)" className="backdrop-blur-sm" onEscape={() => { const c = confirmState.onCancel; setConfirmState(null); if (c) c(); }}>
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-5" role="alertdialog" aria-modal="true"
                        aria-label={tx('confirm.title', 'Confirmar')} aria-describedby="cm-acct-confirm-msg">
                        <p id="cm-acct-confirm-msg" className="text-sm font-bold text-gray-800">{confirmState.text}</p>
                        <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => { const c = confirmState.onCancel; setConfirmState(null); if (c) c(); }} className="min-h-[44px] px-5 py-2.5 text-gray-600 font-bold hover:bg-gray-100 rounded-xl">{t('cancel') || 'Cancelar'}</button>
                            <button type="button" onClick={() => { const f = confirmState.onOk; setConfirmState(null); f(); }} className="min-h-[44px] px-6 py-2.5 bg-rose-600 text-white rounded-xl hover:bg-rose-700 font-black text-[10px] uppercase tracking-widest">{t('confirm') || 'Confirmar'}</button>
                        </div>
                    </div>
                </Overlay>
            )}
        </div>
    );
}
